from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "desktop"))

import generic_performance as gp  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
EXPECTED = ROOT / "tests" / "expected"

COPY_OPTIONS = [
    {"decimalSeparator": ".", "withLabels": False, "withChange": False, "withHeader": False},
    {"decimalSeparator": ",", "withLabels": True, "withChange": True, "withHeader": True},
]

FMT_VALUES = [None, 0.0, -0.0, 0.125, 0.375, 2.5, 3.5, -2.5, 0.005, 1.005, 1234567.895, 999.995,
              -0.004, 1e-10, 12.0, 12.000000000001, 0.5, -1.5, 1e15 + 0.5, 0.0625, 41.5]
KINDS = ["money", "int", "num", "pct"]
NUMBER_TEXTS = ["1,234.56", "1.234,56", "12,5", "1,234", "(45.10)", "62.00%", "62,00 %", "--", "n/a", "",
                "$1,100.12", "-3", "1.2.3", "€ 7", "abc", ".5", "5.", "-", " 1 000,50 ", "10.000.000",
                "1-2", "—"]


def results_json(results):
    return [{"label": r.label, "kind": r.kind, "cur": r.cur, "prev": r.prev, "change": r.change}
            for r in results]


def dump(path: Path) -> dict:
    rep = gp.load_report(path)
    out = {
        "file": path.name,
        "sheet": rep.sheet,
        "campaignCol": rep.campaign_col,
        "metrics": [{"label": m.label, "kind": m.kind, "cur": m.cur, "prev": m.prev,
                     "derived": list(m.derived) if m.derived else None} for m in rep.metrics],
        "skipped": rep.skipped,
        "missingCompared": rep.missing_compared(),
        "rows": [{"name": r.name, "segment": r.segment.key if r.segment else None} for r in rep.rows],
        "segments": {},
        "copy": [],
    }
    excluded = {i for i in range(len(rep.rows)) if i % 2 == 1}
    blocks_all, blocks_some = [], []
    for seg in gp.SEGMENTS:
        idx = rep.segment_rows(seg)
        some = [i for i in idx if i not in excluded]
        res_all, res_some = gp.aggregate(rep, idx), gp.aggregate(rep, some)
        out["segments"][seg.key] = {"rows": idx, "all": results_json(res_all), "some": results_json(res_some)}
        blocks_all.append((seg.short, res_all))
        blocks_some.append((seg.short, res_some))
    for o in COPY_OPTIONS:
        args = (o["decimalSeparator"], o["withLabels"], o["withChange"], o["withHeader"])
        out["copy"].append({
            "options": o,
            "segment": gp.build_clipboard_text(blocks_all[0][1], *args),
            "side": gp.build_all_segments_text(blocks_some, *args, "side"),
            "stacked": gp.build_all_segments_text(blocks_all, *args, "stacked"),
        })
    return out


def basics() -> dict:
    fmt = []
    for v in FMT_VALUES:
        for kind in KINDS:
            for dec in (".", ","):
                for th in (False, True):
                    fmt.append({"value": v, "kind": kind, "decimalSeparator": dec, "thousands": th,
                                "out": gp.fmt_value(v, kind, dec, th)})
    return {
        "fmt": fmt,
        "toNumber": [{"text": t, "out": gp.to_number(t)} for t in NUMBER_TEXTS],
        "excelSafeText": [{"text": t, "out": gp.excel_safe_text(t)} for t in [
            "Cost", '=HYPERLINK("http://x","y")', "+1", "-Cost", "@SUM(A1)", "Leads / Clicks",
            "a\tb", "line\r\nbreak", " =x", "", "Cost - net"]],
        "segmentOf": [{"name": n, "out": (s.key if (s := gp.segment_of(n)) else None)} for n in [
            "US_SearchNB_Post", "searchnb_dma_x", "SEARCHNB", "searchnb_nsh", "brand", "SearchNB-Postal-DMA"]],
    }


def write(name: str, data: dict) -> None:
    text = json.dumps(data, indent=1, ensure_ascii=False, allow_nan=False) + "\n"
    (EXPECTED / name).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    EXPECTED.mkdir(exist_ok=True)
    for p in sorted(FIXTURES.iterdir()):
        write(p.stem + ".json", dump(p))
    write("basics.json", basics())
    print("wrote", sorted(p.name for p in EXPECTED.iterdir()))
