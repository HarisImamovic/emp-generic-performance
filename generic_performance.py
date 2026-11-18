from __future__ import annotations

import csv
import io
import json
import locale
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

APP_NAME = "Generic Performance"

# Keyboard shortcuts use Command on macOS and Control elsewhere.
MAC = sys.platform == "darwin"
MOD = "Command" if MAC else "Control"
KEY = "⌘" if MAC else "Ctrl+"
SHIFT = "⇧" if MAC else "Shift+"


# ---- segments ----------------------------------------------------------------
# Mirrors the SA360 CASE rules:
#   searchnb + post                         -> BAU | Post-L | Generic Search
#   searchnb + dma, no post                 -> BAU | Pre-L | Generic Search | Campus
#   searchnb, no dma, no post               -> BAU | Pre-L | Generic Search | Vertical
# and every rule excludes aurora / ssm / cindma / slcdma / nsh.
# "Generic overall" is the union of the three.

@dataclass(frozen=True)
class Segment:
    key: str
    label: str
    short: str


POST_L = Segment("post", "BAU | Post-L | Generic Search", "Post-L")
PRE_VERTICAL = Segment("vertical", "BAU | Pre-L | Generic Search | Vertical", "Pre-L Vertical")
PRE_CAMPUS = Segment("campus", "BAU | Pre-L | Generic Search | Campus", "Pre-L Campus")
GENERIC = Segment("generic", "Generic Search (searchnb) overall", "Generic overall")
SEGMENTS: tuple[Segment, ...] = (POST_L, PRE_VERTICAL, PRE_CAMPUS, GENERIC)

GENERIC_EXCLUDE = ("aurora", "ssm", "cindma", "slcdma", "nsh")


def segment_of(name: str) -> Segment | None:
    """The single base segment a campaign belongs to (never GENERIC), or None."""
    n = name.lower()
    if "searchnb" not in n or any(x in n for x in GENERIC_EXCLUDE):
        return None
    if "post" in n:
        return POST_L
    if "dma" in n:
        return PRE_CAMPUS
    return PRE_VERTICAL


# ---- parsing helpers -----------------------------------------------------------

def norm(value) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower()) if value is not None else ""


_NON_NUMERIC = re.compile(r"[^\d,.\-]")
_EMPTY_TOKENS = {"", "--", "-", "—", "n/a", "na", "none", "null"}


def _is_empty(value) -> bool:
    return value is None or str(value).strip().lower() in _EMPTY_TOKENS


def to_number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(" ", "").replace(" ", "")
    if s.lower() in _EMPTY_TOKENS:
        return None
    is_pct = s.endswith("%")
    is_neg_paren = s.startswith("(") and s.endswith(")")
    s = _NON_NUMERIC.sub("", s)
    if not s or s == "-":
        return None
    if "," in s and "." in s:
        if s.rfind(",") > s.rfind("."):
            s = s.replace(".", "").replace(",", ".")
        else:
            s = s.replace(",", "")
    elif "," in s:
        parts = s.split(",")
        s = s.replace(",", ".") if len(parts) == 2 and len(parts[1]) != 3 else s.replace(",", "")
    elif s.count(".") > 1:
        s = s.replace(".", "")
    try:
        x = float(s)
    except ValueError:
        return None
    if is_neg_paren:
        x = -abs(x)
    return x / 100 if is_pct else x


def fmt_value(value: float | None, kind: str, dec_sep: str = ".", thousands: bool = False) -> str:
    if value is None:
        return ""
    t = "," if thousands else ""
    if kind == "int":
        s = f"{round(value):{t}d}"
    elif kind == "pct":
        s = f"{value * 100:.2f}%"
    elif kind == "num":
        s = f"{round(value):{t}d}" if abs(value - round(value)) < 1e-9 else f"{value:{t}.2f}"
    else:
        s = f"{value:{t}.2f}"
    if dec_sep != ".":
        s = s.replace(",", "\0").replace(".", dec_sep).replace("\0", "." if thousands else "")
    if kind == "money":
        s = "-$" + s[1:] if s.startswith("-") else "$" + s
    return s


def pct_change(cur: float | None, prev: float | None) -> float | None:
    if cur is None or prev is None or prev == 0:
        return None
    return (cur - prev) / abs(prev)


# ---- metric columns -------------------------------------------------------------

@dataclass
class MetricCol:
    label: str
    kind: str                 # money | int | num | pct
    cur: int | None           # column index of the current period
    prev: int | None          # column index of the compared period
    derived: tuple[int, int, float] | None = None   # (numerator idx, denominator idx, factor) into metrics


# After a metric's own name, these mark its compared-period column / its delta column.
_COMPARE_RE = re.compile(r"^(comparedto|compareto|comparison|compared|previousperiod|previous|priorperiod|prior)")
_DELTA_RE = re.compile(r"(change|diff|delta|pct|percent)")
_ORPHAN_COMPARE_RE = re.compile(r"(comparedto|compareto|comparison|previousperiod|priorperiod)")

# Ratios that must be recomputed from sums, never summed or averaged:
# (header norms, numerator norms, denominator norms, factor, kind)
_DERIVED_RULES = (
    (("avgcpc", "averagecpc", "cpc"), ("cost",), ("clicks",), 1.0, "money"),
    (("ctr", "clickthroughrate"), ("clicks",), ("impr", "impressions"), 1.0, "pct"),
    (("avgcpm", "averagecpm", "cpm"), ("cost",), ("impr", "impressions"), 1000.0, "money"),
    (("convrate", "conversionrate"), ("conversions", "conv"), ("clicks",), 1.0, "pct"),
    (("costconv", "costperconv", "costperconversion", "cpa"), ("cost",), ("conversions", "conv"), 1.0, "money"),
    (("convvaluecost", "conversionvaluecost", "roas"), ("convvalue", "conversionvalue"), ("cost",), 1.0, "num"),
    (("valueconv", "convvalueconv", "valueperconversion"), ("convvalue", "conversionvalue"),
     ("conversions", "conv"), 1.0, "money"),
)
_RATIO_WORDS = re.compile(r"\b(rate|avg|average|share|ctr|cpc|cpm|cpa|roas|per|position|ratio|percent)\b", re.I)
_MONEY_WORDS = ("cost", "value", "revenue", "sales", "budget", "spend")
_COUNT_NORMS = {"clicks", "impr", "impressions", "interactions"}
_ID_RE = re.compile(r"\bid\b", re.I)


def _is_numeric_column(values: list) -> bool:
    filled = [v for v in values if not _is_empty(v)]
    if not filled:
        return False
    nums = sum(1 for v in filled if to_number(v) is not None)
    return nums >= 0.8 * len(filled)


def _base_kind(n: str, raw: list) -> str:
    if n in _COUNT_NORMS:
        return "int"
    if any(isinstance(v, str) and re.search(r"[$€£]", v) for v in raw):
        return "money"
    if any(w in n for w in _MONEY_WORDS):
        return "money"
    return "num"


def parse_columns(header: list, rows: list[tuple], campaign_col: int | None
                  ) -> tuple[list[MetricCol], list[str]]:
    """Every numeric column in the export becomes a metric (file order).

    Returns (metrics, skipped) where skipped lists columns that are rates/averages
    which cannot be summed and whose formula is unknown, or that have no compared
    column in a comparison export (settings such as Budget).
    """
    labels = ["" if h is None else str(h).strip() for h in header]
    norms = [norm(h) for h in labels]
    first: dict[str, int] = {}
    for j, n in enumerate(norms):
        if n and n not in first:
            first[n] = j

    # pair "<metric> (Compared to)" with "<metric>"; drop "<metric> (% change)"
    prev_of: dict[str, int] = {}
    secondary: set[int] = set()
    for j, n in enumerate(norms):
        if not n:
            continue
        best = None
        for b in first:
            if b != n and n.startswith(b) and (best is None or len(b) > len(best)):
                rest = n[len(b):]
                if _COMPARE_RE.match(rest) or _DELTA_RE.match(rest):
                    best = b
        if best is None:
            continue
        secondary.add(j)
        rest = n[len(best):]
        if _COMPARE_RE.match(rest) and not _DELTA_RE.search(rest) and best not in prev_of:
            prev_of[best] = j

    def col_values(j):
        return [r[j] if j < len(r) else None for r in rows]

    # numeric base columns, file order
    bases: list[int] = []
    for n, j in first.items():
        if j in secondary or j == campaign_col or _ID_RE.search(labels[j]) or _ORPHAN_COMPARE_RE.search(n):
            continue
        if _is_numeric_column(col_values(j)):
            bases.append(j)
    bases.sort()

    metrics: list[MetricCol] = []
    skipped: list[str] = []
    pending: list[tuple[int, int, tuple, tuple, float, str]] = []   # (metric idx, col, num, den, factor, kind)

    def additive_by_norm(cands) -> int | None:
        for c in cands:
            for k, m in enumerate(metrics):
                if m.derived is None and m.kind != "pct" and norm(m.label) == c:
                    return k
        return None

    for j in bases:
        n, raw = norms[j], col_values(j)
        rule = next((r for r in _DERIVED_RULES if n in r[0]), None)
        parts = labels[j].split("/")
        if rule:
            metrics.append(MetricCol(labels[j], rule[4], j, prev_of.get(n)))
            pending.append((len(metrics) - 1, j, rule[1], rule[2], rule[3], rule[4]))
        elif len(parts) == 2 and all(norm(p) for p in parts):
            metrics.append(MetricCol(labels[j], "num", j, prev_of.get(n)))
            pending.append((len(metrics) - 1, j, (norm(parts[0]),), (norm(parts[1]),), 1.0, ""))
        elif _RATIO_WORDS.search(labels[j]) or "%" in labels[j] or \
                any(isinstance(v, str) and v.strip().endswith("%") for v in raw):
            metrics.append(MetricCol(labels[j], "pct", j, prev_of.get(n)))
            pending.append((len(metrics) - 1, j, (), (), 1.0, "pct"))
        elif prev_of and n not in prev_of:
            # comparison export, but this column has none: a setting (Budget, target CPA), not performance
            skipped.append(f"{labels[j]} (no compared column)")
        else:
            metrics.append(MetricCol(labels[j], _base_kind(n, raw), j, prev_of.get(n)))

    drop: set[int] = set()
    for k, j, num, den, factor, kind in pending:
        a, b = additive_by_norm(num), additive_by_norm(den)
        if a is None or b is None:
            drop.add(k)
            skipped.append(f"{labels[j]} (not summable)")
            continue
        if not kind:   # generic "A / B" column
            ka, kb = metrics[a].kind, metrics[b].kind
            kind = "money" if ka == "money" and kb != "money" else "num"
        metrics[k].kind = kind
        metrics[k].derived = (a, b, factor)

    # drop non-aggregatable columns and re-point derived indices
    remap, kept = {}, []
    for k, m in enumerate(metrics):
        if k not in drop:
            remap[k] = len(kept)
            kept.append(m)
    for m in kept:
        if m.derived:
            a, b, f = m.derived
            m.derived = (remap[a], remap[b], f)
    return kept, skipped


# ---- report loading -------------------------------------------------------------

@dataclass
class Row:
    name: str
    values: tuple
    segment: Segment | None


@dataclass
class Report:
    path: Path
    sheet: str | None
    header: list
    campaign_col: int | None
    metrics: list[MetricCol]
    skipped: list[str]
    rows: list[Row]

    def missing_compared(self) -> list[str]:
        out = []
        for m in self.metrics:
            if m.prev is not None:
                continue
            if m.derived and all(self.metrics[d].prev is not None for d in m.derived[:2]):
                continue
            out.append(m.label)
        return out

    def segment_rows(self, seg: Segment) -> list[int]:
        return [i for i, r in enumerate(self.rows)
                if r.segment is not None and (seg is GENERIC or r.segment is seg)]


def _read_csv_rows(path: Path) -> list[list]:
    raw = path.read_bytes()
    if raw[:2] in (b"\xff\xfe", b"\xfe\xff"):
        text = raw.decode("utf-16")
    else:
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
    sample = text[:50000]
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t").delimiter
    except csv.Error:
        delimiter = max(("\t", ";", ","), key=sample.count)
    # SA360 location/targeting cells can exceed csv's default 128 KB field limit.
    csv.field_size_limit(2**31 - 1)
    return list(csv.reader(io.StringIO(text), delimiter=delimiter))


def _read_xlsx_sheets(path: Path) -> list[tuple[str, list[list]]]:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        return [(ws.title, [list(r) for r in ws.iter_rows(values_only=True)]) for ws in wb.worksheets]
    finally:
        wb.close()


def _find_header(rows: list[list], max_scan: int = 60) -> tuple[int, int | None] | None:
    for i, row in enumerate(rows[:max_scan]):
        norms = [norm(c) for c in row]
        if "cost" in norms and ({"clicks", "impr", "impressions"} & set(norms)):
            campaign_col = next((j for j, n in enumerate(norms) if n in ("campaign", "campaignname")), None)
            return i, campaign_col
    return None


def _cell(values, idx):
    return values[idx] if idx is not None and idx < len(values) else None


def load_report(path: str | Path) -> Report:
    path = Path(path)
    ext = path.suffix.lower()
    if ext in (".csv", ".tsv", ".txt"):
        sheets = [(None, _read_csv_rows(path))]
    elif ext in (".xlsx", ".xlsm"):
        sheets = _read_xlsx_sheets(path)
    elif ext == ".xls":
        raise ValueError("Old .xls format is not supported. Export from SA360 as .xlsx or .csv.")
    else:
        raise ValueError(f"Unsupported file type: {ext}")

    for sheet_name, rows in sheets:
        found = _find_header(rows)
        if not found:
            continue
        hdr_idx, campaign_col = found
        candidates: list[tuple[int, tuple]] = []
        for n, values in enumerate(rows[hdr_idx + 1:], start=hdr_idx + 2):
            values = tuple(values)
            if not any(v not in (None, "") for v in values):
                continue
            first_text = next((str(v).strip() for v in values if v not in (None, "")), "")
            name = _cell(values, campaign_col)
            if norm(first_text).startswith("total") or norm(name).startswith("total"):
                continue
            candidates.append((n, values))

        header = list(rows[hdr_idx])
        metrics, skipped = parse_columns(header, [v for _, v in candidates], campaign_col)
        cols = {c for m in metrics for c in (m.cur, m.prev) if c is not None}
        data: list[Row] = []
        for n, values in candidates:
            if all(to_number(_cell(values, c)) is None for c in cols):
                continue
            name = _cell(values, campaign_col)
            name = str(name).strip() if name not in (None, "") else ""
            data.append(Row(name or f"(row {n})", values, segment_of(name) if name else None))
        return Report(path, sheet_name, header, campaign_col, metrics, skipped, data)

    raise ValueError(
        "Could not find a header row with Cost and Clicks/Impr. columns.\n"
        "Make sure the export contains those columns."
    )


# ---- aggregation ----------------------------------------------------------------

@dataclass
class ResultRow:
    label: str
    kind: str
    cur: float | None
    prev: float | None

    @property
    def change(self) -> float | None:
        return pct_change(self.cur, self.prev)


def aggregate(report: Report, row_indices: list[int]) -> list[ResultRow]:
    rows = [report.rows[i] for i in row_indices]
    totals: dict[str, list] = {}
    for period in ("cur", "prev"):
        vals: list[float | None] = [None] * len(report.metrics)
        for k, m in enumerate(report.metrics):
            col = getattr(m, period)
            if m.derived or col is None or not rows:
                continue
            vals[k] = sum(x for x in (to_number(_cell(r.values, col)) for r in rows) if x is not None)
        for k, m in enumerate(report.metrics):
            if not m.derived or not rows:
                continue
            a, b, factor = m.derived
            col = getattr(m, period)
            if vals[a] is not None and vals[b] is not None:
                vals[k] = vals[a] / vals[b] * factor if vals[b] else None
            elif len(rows) == 1 and col is not None:
                vals[k] = to_number(_cell(rows[0].values, col))
        totals[period] = vals
    return [ResultRow(m.label, m.kind, totals["cur"][k], totals["prev"][k])
            for k, m in enumerate(report.metrics)]


# ---- output ---------------------------------------------------------------------

def _value_cells(r: ResultRow, dec_sep: str, with_change: bool) -> list[str]:
    cells = [fmt_value(r.cur, r.kind, dec_sep, thousands=r.kind == "money"),
             fmt_value(r.prev, r.kind, dec_sep, thousands=r.kind == "money")]
    if with_change:
        cells.append(fmt_value(r.change, "pct", dec_sep))
    return cells


def build_clipboard_text(results: list[ResultRow], dec_sep: str, with_labels: bool,
                         with_change: bool, with_header: bool) -> str:
    lines = []
    if with_header:
        cols = (["Metric"] if with_labels else []) + ["Current", "Compared"] + (["Change %"] if with_change else [])
        lines.append("\t".join(cols))
    for r in results:
        lines.append("\t".join(([r.label] if with_labels else []) + _value_cells(r, dec_sep, with_change)))
    # Plain "\n": Tk on Windows expands each "\n" to "\r\n" itself, so "\r\n" here
    # would become "\r\r\n" and Excel pastes an empty row after every line.
    return "\n".join(lines)


def build_all_segments_text(blocks: list[tuple[str, list[ResultRow]]], dec_sep: str, with_labels: bool,
                            with_change: bool, with_header: bool, layout: str) -> str:
    if layout == "stacked":
        parts = []
        for name, results in blocks:
            text = build_clipboard_text(results, dec_sep, with_labels, with_change, with_header)
            parts.append(f"{name}\n{text}" if with_header else text)
        return "\n\n".join(parts)

    cols = ["Current", "Compared"] + (["Change %"] if with_change else [])
    lines = []
    if with_header:
        lines.append("\t".join((["Metric"] if with_labels else []) +
                               [f"{name} - {c}" for name, _ in blocks for c in cols]))
    for k, first in enumerate(blocks[0][1]):
        cells = [first.label] if with_labels else []
        for _, results in blocks:
            cells += _value_cells(results[k], dec_sep, with_change)
        lines.append("\t".join(cells))
    return "\n".join(lines)


_XL_FORMATS = {"money": "#,##0.00", "int": "#,##0", "num": "#,##0.##", "pct": "0.00%"}


def export_xlsx(path: str | Path, report: Report, blocks: list[tuple[Segment, list[ResultRow]]],
                excluded: set[int]) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    bold = Font(bold=True)
    ws.cell(2, 1, "Metric").font = bold
    for s, (seg, _) in enumerate(blocks):
        c0 = 2 + s * 3
        ws.cell(1, c0, seg.label).font = bold
        ws.merge_cells(start_row=1, start_column=c0, end_row=1, end_column=c0 + 2)
        ws.cell(1, c0).alignment = Alignment(horizontal="center")
        for o, text in enumerate(("Current", "Compared", "Change %")):
            ws.cell(2, c0 + o, text).font = bold
            ws.column_dimensions[get_column_letter(c0 + o)].width = 15
    for k, m in enumerate(report.metrics):
        row = 3 + k
        ws.cell(row, 1, m.label)
        for s, (_, results) in enumerate(blocks):
            r, c0 = results[k], 2 + s * 3
            for o, (v, f) in enumerate(((r.cur, _XL_FORMATS[r.kind]), (r.prev, _XL_FORMATS[r.kind]),
                                        (r.change, "0.00%"))):
                ws.cell(row, c0 + o, v).number_format = f
    ws.column_dimensions["A"].width = max(20, min(60, max((len(m.label) for m in report.metrics), default=20) + 2))
    ws.freeze_panes = "B3"

    info = wb.create_sheet("Campaigns")
    info.append(["Source file", str(report.path)])
    if report.skipped:
        info.append(["Columns skipped", ", ".join(report.skipped)])
    info.append([])
    info.append(["Campaign", "Segment", "Included"])
    for c in info[info.max_row]:
        c.font = bold
    for i, r in enumerate(report.rows):
        if r.segment is not None:
            info.append([r.name, r.segment.label, "Yes" if i not in excluded else "No"])
    for i, r in enumerate(report.rows):
        if r.segment is None:
            info.append([r.name, "(not in Generic)", ""])
    info.column_dimensions["A"].width = 60
    info.column_dimensions["B"].width = 42
    wb.save(path)


# ---- settings -------------------------------------------------------------------

def _settings_path() -> Path:
    base = os.environ.get("APPDATA") or str(Path.home())
    return Path(base) / "Generic-Performance" / "settings.json"


def load_settings() -> dict:
    try:
        return json.loads(_settings_path().read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_settings(data: dict) -> None:
    try:
        p = _settings_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception:
        pass


def system_decimal_separator() -> str:
    try:
        locale.setlocale(locale.LC_NUMERIC, "")
        sep = locale.localeconv().get("decimal_point") or "."
        return sep if sep in (".", ",") else "."
    except Exception:
        return "."


# ---- GUI ------------------------------------------------------------------------

LAYOUTS = {"Side by side": "side", "Stacked": "stacked"}


def run_gui(initial_file: str | None = None) -> None:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk
    from tkinter import font as tkfont

    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    settings = load_settings()

    root = tk.Tk()
    root.title(APP_NAME)
    root.geometry("1280x800")
    root.minsize(960, 620)

    # ---- theme -------------------------------------------------------------
    BG, CARD, BORDER = "#f3f4f6", "#ffffff", "#e5e7eb"
    TEXT, MUTED, SUBTLE = "#111827", "#6b7280", "#9ca3af"
    HEADER_BG, HEADER_SUB = "#111827", "#9ca3af"
    ACCENT, ACCENT_HOVER, ACCENT_SOFT = "#2563eb", "#1d4ed8", "#dbeafe"
    STRIPE, HEAD_BG = "#f9fafb", "#f3f4f6"
    GREEN, RED, AMBER = "#15803d", "#b91c1c", "#b45309"
    FAMILY = "Segoe UI" if sys.platform == "win32" else "TkDefaultFont"
    F_BASE, F_BOLD = (FAMILY, 10), (FAMILY, 10, "bold")
    F_SMALL, F_TITLE, F_CARD = (FAMILY, 9), (FAMILY, 16, "bold"), (FAMILY, 11, "bold")

    scale = root.winfo_fpixels("1i") / 96.0
    px = lambda n: int(round(n * scale))

    root.configure(bg=BG)
    style = ttk.Style(root)
    style.theme_use("clam")
    style.configure(".", background=BG, foreground=TEXT, font=F_BASE, bordercolor=BORDER,
                    lightcolor=BORDER, darkcolor=BORDER, troughcolor=BG, focuscolor=ACCENT)
    style.configure("TFrame", background=BG)
    style.configure("Card.TFrame", background=CARD)
    style.configure("Card.TLabel", background=CARD, foreground=TEXT)
    style.configure("CardTitle.TLabel", background=CARD, foreground=TEXT, font=F_CARD)
    style.configure("CardMuted.TLabel", background=CARD, foreground=MUTED, font=F_SMALL)
    style.configure("Status.TLabel", background=BG, foreground=MUTED, font=F_SMALL)

    style.configure("TButton", background=CARD, foreground=TEXT, bordercolor=BORDER,
                    lightcolor=CARD, darkcolor=CARD, padding=(px(12), px(5)), relief="flat")
    style.map("TButton", background=[("pressed", "#e5e7eb"), ("active", STRIPE)],
              bordercolor=[("focus", ACCENT)])
    style.configure("Accent.TButton", background=ACCENT, foreground="#ffffff", bordercolor=ACCENT,
                    lightcolor=ACCENT, darkcolor=ACCENT, font=F_BOLD, padding=(px(16), px(7)))
    style.map("Accent.TButton", background=[("pressed", ACCENT_HOVER), ("active", ACCENT_HOVER)],
              bordercolor=[("active", ACCENT_HOVER)], lightcolor=[("active", ACCENT_HOVER)],
              darkcolor=[("active", ACCENT_HOVER)])

    style.configure("TCombobox", fieldbackground=CARD, background=CARD, bordercolor=BORDER,
                    lightcolor=CARD, darkcolor=CARD, arrowcolor=MUTED, padding=(px(6), px(3)))
    style.map("TCombobox", fieldbackground=[("readonly", CARD)], selectbackground=[("readonly", CARD)],
              selectforeground=[("readonly", TEXT)], bordercolor=[("focus", ACCENT)])
    style.configure("Card.TCheckbutton", background=CARD, foreground=TEXT, indicatorcolor=CARD,
                    indicatorbackground=CARD)
    style.map("Card.TCheckbutton", background=[("active", CARD)],
              indicatorcolor=[("selected", ACCENT), ("pressed", ACCENT_SOFT)])

    style.configure("Vertical.TScrollbar", background=BORDER, troughcolor=CARD, bordercolor=CARD,
                    lightcolor=BORDER, darkcolor=BORDER, arrowcolor=SUBTLE, gripcount=0)
    style.map("Vertical.TScrollbar", background=[("active", SUBTLE)])

    style.configure("Link.TButton", background=CARD, foreground=ACCENT, bordercolor=CARD,
                    lightcolor=CARD, darkcolor=CARD, padding=(px(6), px(1)), font=F_SMALL)
    style.map("Link.TButton", background=[("active", ACCENT_SOFT)], bordercolor=[("active", ACCENT_SOFT)],
              lightcolor=[("active", ACCENT_SOFT)], darkcolor=[("active", ACCENT_SOFT)])
    style.configure("TPanedwindow", background=BG)

    def bordered(parent, **kw):
        return tk.Frame(parent, bg=CARD, highlightbackground=BORDER, highlightcolor=BORDER,
                        highlightthickness=1, **kw)

    def card(parent, title_var, subtitle_var=None):
        outer = bordered(parent)
        inner = ttk.Frame(outer, style="Card.TFrame", padding=px(14))
        inner.pack(fill="both", expand=True)
        head = ttk.Frame(inner, style="Card.TFrame")
        head.pack(fill="x", pady=(0, px(10)))
        kw = {"textvariable": title_var} if isinstance(title_var, tk.Variable) else {"text": title_var}
        ttk.Label(head, style="CardTitle.TLabel", **kw).pack(side="left")
        if subtitle_var is not None:
            ttk.Label(head, textvariable=subtitle_var, style="CardMuted.TLabel").pack(
                side="left", padx=(px(10), 0), pady=(px(2), 0))
        return outer, inner, head

    # ---- state -------------------------------------------------------------
    seg_by_key = {s.key: s for s in SEGMENTS}
    state: dict = {"report": None, "seg": seg_by_key.get(settings.get("segment"), POST_L),
                   "excluded": set(), "visible": [], "results": []}

    dec_var = tk.StringVar(value=settings.get("dec_sep", system_decimal_separator()))
    labels_var = tk.BooleanVar(value=settings.get("with_labels", False))
    change_var = tk.BooleanVar(value=settings.get("with_change", False))
    header_var = tk.BooleanVar(value=settings.get("with_header", False))
    layout_var = tk.StringVar(value=next((k for k, v in LAYOUTS.items() if v == settings.get("layout")),
                                         "Side by side"))
    file_var = tk.StringVar(value="No file loaded")
    status_var = tk.StringVar(value="Ready.")
    count_var = tk.StringVar(value="")
    summary_title = tk.StringVar(value="Summary")

    def persist():
        settings.update(
            dec_sep=dec_var.get(), with_labels=labels_var.get(), with_change=change_var.get(),
            with_header=header_var.get(), layout=LAYOUTS[layout_var.get()], segment=state["seg"].key,
        )
        settings.pop("filter", None)
        save_settings(settings)

    # ---- header ------------------------------------------------------------
    header = tk.Frame(root, bg=HEADER_BG)
    header.pack(fill="x")
    hinner = tk.Frame(header, bg=HEADER_BG)
    hinner.pack(fill="x", padx=px(20), pady=px(14))
    htext = tk.Frame(hinner, bg=HEADER_BG)
    htext.pack(side="left")
    tk.Label(htext, text=APP_NAME, bg=HEADER_BG, fg="#ffffff", font=F_TITLE).pack(anchor="w")
    tk.Label(htext, textvariable=file_var, bg=HEADER_BG, fg=HEADER_SUB, font=F_SMALL).pack(anchor="w")
    ttk.Button(hinner, text=f"Open export…   {KEY}O", style="Accent.TButton",
               command=lambda: open_file()).pack(side="right")

    # ---- status bar (packed before body so it stays visible) ----------------
    status_bar = tk.Frame(root, bg=BG)
    status_bar.pack(side="bottom", fill="x")
    tk.Frame(status_bar, bg=BORDER, height=1).pack(fill="x")
    status_dot = tk.Label(status_bar, text="●", bg=BG, fg=SUBTLE, font=F_SMALL)
    status_dot.pack(side="left", padx=(px(20), px(6)), pady=px(6))
    status_lbl = ttk.Label(status_bar, textvariable=status_var, style="Status.TLabel")
    status_lbl.pack(side="left", fill="x", expand=True, pady=px(6))

    def set_status(msg: str, level: str = "info"):
        color = {"ok": GREEN, "warn": AMBER, "error": RED}.get(level, SUBTLE)
        status_var.set(msg)
        status_dot.configure(fg=color)
        status_lbl.configure(foreground=color if level in ("warn", "error") else MUTED)

    # ---- segment tabs ------------------------------------------------------
    tabs_bar = tk.Frame(root, bg=BG)
    tabs_bar.pack(fill="x", padx=px(16), pady=(px(14), 0))
    tabs: dict[str, tk.Label] = {}
    for n, seg in enumerate(SEGMENTS, start=1):
        lbl = tk.Label(tabs_bar, text=seg.short, font=F_BOLD, cursor="hand2", padx=px(16), pady=px(7),
                       highlightthickness=1)
        lbl.pack(side="left", padx=(0, px(8)))
        lbl.bind("<Button-1>", lambda e, s=seg: select_segment(s))
        tabs[seg.key] = lbl
    tk.Label(tabs_bar, text=f"{KEY}1…4 to switch", bg=BG, fg=SUBTLE, font=F_SMALL).pack(side="right")

    def paint_tabs():
        report = state["report"]
        for seg in SEGMENTS:
            text = seg.short
            if report:
                rows = report.segment_rows(seg)
                inc = sum(1 for i in rows if i not in state["excluded"])
                text += f"   {inc}" if inc == len(rows) else f"   {inc}/{len(rows)}"
            active = seg is state["seg"]
            tabs[seg.key].configure(
                text=text, bg=ACCENT if active else CARD, fg="#ffffff" if active else TEXT,
                highlightbackground=ACCENT if active else BORDER)

    # ---- body --------------------------------------------------------------
    paned = ttk.PanedWindow(root, orient="horizontal")
    paned.pack(fill="both", expand=True, padx=px(16), pady=px(12))

    # Campaigns card
    left_wrap = ttk.Frame(paned)
    paned.add(left_wrap, weight=2)
    lcard, left, _ = card(left_wrap, "Campaigns", count_var)
    lcard.pack(fill="both", expand=True, padx=(0, px(8)))

    lbar = ttk.Frame(left, style="Card.TFrame")
    lbar.pack(fill="x", pady=(0, px(4)))
    ttk.Label(lbar, text="Click to include / exclude", style="CardMuted.TLabel").pack(side="left")
    ttk.Button(lbar, text="None", style="Link.TButton",
               command=lambda: select_all(False)).pack(side="right")
    ttk.Button(lbar, text="All", style="Link.TButton",
               command=lambda: select_all(True)).pack(side="right")

    lbox_frame = bordered(left)
    lbox_frame.pack(fill="both", expand=True)
    lbox = tk.Listbox(lbox_frame, selectmode="multiple", exportselection=False, activestyle="none",
                      bg=CARD, fg=SUBTLE, selectbackground=ACCENT_SOFT, selectforeground=TEXT,
                      font=F_BASE, borderwidth=0, highlightthickness=0, relief="flat")
    lsb = ttk.Scrollbar(lbox_frame, orient="vertical", command=lbox.yview)
    lbox.configure(yscrollcommand=lsb.set)
    lbox.pack(side="left", fill="both", expand=True, padx=(px(4), 0), pady=px(4))
    lsb.pack(side="right", fill="y")
    ttk.Label(left, text="Excluding a campaign here also removes it from Generic overall.",
              style="CardMuted.TLabel").pack(anchor="w", pady=(px(6), 0))

    # Summary card
    right_wrap = ttk.Frame(paned)
    paned.add(right_wrap, weight=3)
    rcard, right, _ = card(right_wrap, summary_title)
    rcard.pack(fill="both", expand=True, padx=(px(8), 0))

    # bottom part first so it never gets squeezed out
    btns = ttk.Frame(right, style="Card.TFrame")
    btns.pack(side="bottom", fill="x")
    ttk.Button(btns, text="Copy segment", style="Accent.TButton",
               command=lambda: copy_segment()).pack(side="right")
    ttk.Button(btns, text="Copy all segments", command=lambda: copy_all()).pack(side="right", padx=(px(8), 0))
    ttk.Button(btns, text="Export to Excel…", command=lambda: export_file()).pack(side="right", padx=px(8))
    ttk.Label(btns, text=f"{KEY}{SHIFT}C segment  ·  {KEY}{SHIFT}A all",
              style="CardMuted.TLabel").pack(side="left")
    tk.Frame(right, bg=BORDER, height=1).pack(side="bottom", fill="x", pady=px(12))

    opts = ttk.Frame(right, style="Card.TFrame")
    opts.pack(side="bottom", fill="x", pady=(px(12), 0))
    ttk.Label(opts, text="Copy options", style="CardMuted.TLabel").grid(
        row=0, column=0, columnspan=8, sticky="w", pady=(0, px(4)))
    ttk.Label(opts, text="Decimal", style="Card.TLabel").grid(row=1, column=0, sticky="w")
    ttk.Combobox(opts, textvariable=dec_var, values=(".", ","), width=3, state="readonly").grid(
        row=1, column=1, sticky="w", padx=(px(6), px(18)))
    ttk.Checkbutton(opts, text="Metric names", variable=labels_var, style="Card.TCheckbutton").grid(
        row=1, column=2, sticky="w")
    ttk.Checkbutton(opts, text="Change %", variable=change_var, style="Card.TCheckbutton").grid(
        row=1, column=3, sticky="w", padx=px(12))
    ttk.Checkbutton(opts, text="Header", variable=header_var, style="Card.TCheckbutton").grid(
        row=1, column=4, sticky="w")
    ttk.Label(opts, text="All segments", style="Card.TLabel").grid(row=1, column=5, sticky="w",
                                                                    padx=(px(18), 0))
    ttk.Combobox(opts, textvariable=layout_var, values=tuple(LAYOUTS), width=12, state="readonly").grid(
        row=1, column=6, sticky="w", padx=(px(6), 0))

    # results table: a label grid inside a scrollable canvas (metric count depends on the file)
    table_frame = bordered(right)
    table_frame.pack(fill="both", expand=True)
    canvas = tk.Canvas(table_frame, bg=CARD, highlightthickness=0, borderwidth=0)
    tsb = ttk.Scrollbar(table_frame, orient="vertical", command=canvas.yview)
    canvas.configure(yscrollcommand=tsb.set)
    tsb.pack(side="right", fill="y")
    canvas.pack(side="left", fill="both", expand=True)
    table = tk.Frame(canvas, bg=CARD)
    table_win = canvas.create_window(0, 0, window=table, anchor="nw")
    table.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
    canvas.bind("<Configure>", lambda e: canvas.itemconfigure(table_win, width=e.width))

    def on_wheel(e):
        w = root.winfo_containing(e.x_root, e.y_root)
        if w is not None and str(w).startswith(str(table_frame)) and table.winfo_height() > canvas.winfo_height():
            canvas.yview_scroll(int(-e.delta / 120) or (-1 if e.delta > 0 else 1), "units")

    root.bind_all("<MouseWheel>", on_wheel, add="+")

    table_cells: list[tuple] = []
    base_font = tkfont.Font(root, font=F_BASE)
    CELL_PAD = dict(padx=px(12), pady=px(5))

    def build_table(report: Report):
        for w in table.winfo_children():
            w.destroy()
        table_cells.clear()
        longest = max((base_font.measure(m.label) for m in report.metrics), default=px(120))
        table.columnconfigure(0, weight=1, minsize=min(longest, px(380)) + px(24))
        for c in (1, 2, 3):
            table.columnconfigure(c, minsize=px(110 if c < 3 else 100))
        for c, (text, anchor) in enumerate((("Metric", "w"), ("Current", "e"),
                                            ("Compared", "e"), ("Change", "e"))):
            tk.Label(table, text=text, bg=HEAD_BG, fg=MUTED, font=F_BOLD, anchor=anchor,
                     padx=px(12), pady=px(6)).grid(row=0, column=c, sticky="nsew")
        for n, m in enumerate(report.metrics, start=1):
            rbg = STRIPE if n % 2 == 0 else CARD
            tk.Frame(table, bg=rbg).grid(row=n, column=0, columnspan=4, sticky="nsew")
            label = m.label + ("  ƒ" if m.derived else "")
            name = tk.Label(table, text=label, bg=rbg, fg=TEXT, font=F_BASE, anchor="w",
                            wraplength=px(380), justify="left", **CELL_PAD)
            cur = tk.Label(table, bg=rbg, fg=TEXT, font=F_BOLD, anchor="e", **CELL_PAD)
            prev = tk.Label(table, bg=rbg, fg=MUTED, font=F_BASE, anchor="e", **CELL_PAD)
            chg = tk.Label(table, bg=rbg, fg=MUTED, font=F_SMALL, padx=px(8), pady=px(2))
            name.grid(row=n, column=0, sticky="nsew")
            cur.grid(row=n, column=1, sticky="nsew")
            prev.grid(row=n, column=2, sticky="nsew")
            chg.grid(row=n, column=3, sticky="e", padx=(0, px(10)))
            table_cells.append((cur, prev, chg, rbg))
        canvas.yview_moveto(0)

    empty = tk.Label(table_frame, bg=CARD, fg=MUTED, font=(FAMILY, 11), justify="center",
                     text=f"No data yet\n\nOpen an SA360 export ({KEY}O)"
                          + ("" if MAC else "\nor drag the file onto Generic-Performance.exe"))

    # ---- behaviour ---------------------------------------------------------
    def open_file(path: str | None = None):
        if not path:
            path = filedialog.askopenfilename(
                title="Open SA360 export",
                initialdir=settings.get("last_dir") or str(Path.home() / "Downloads"),
                filetypes=[("SA360 export", "*.xlsx *.xlsm *.csv *.tsv"), ("All files", "*.*")],
            )
            if not path:
                return
        try:
            report = load_report(path)
        except Exception as exc:
            messagebox.showerror(APP_NAME, f"Could not read file:\n\n{exc}")
            set_status("Could not read file.", "error")
            return
        settings["last_dir"] = str(Path(path).parent)
        persist()
        state["report"] = report
        state["excluded"] = set()
        build_table(report)
        sheet = f"  ·  sheet {report.sheet}" if report.sheet else ""
        outside = sum(1 for r in report.rows if r.segment is None)
        file_var.set(f"{Path(path).name}{sheet}  ·  {len(report.rows)} rows  ·  "
                     f"{len(report.metrics)} metrics  ·  {outside} rows outside Generic")
        msg = []
        if report.campaign_col is None:
            msg.append("No 'Campaign' column found - campaigns cannot be segmented.")
        missing = report.missing_compared()
        if missing:
            msg.append("No compared column for: " + ", ".join(missing) + ".")
        if report.skipped:
            msg.append("Skipped: " + ", ".join(report.skipped) + ".")
        if msg:
            set_status("  ".join(msg), "warn")
        else:
            set_status(f"Loaded {Path(path).name} - {len(report.metrics)} metric columns.", "ok")
        refresh_list()

    def select_segment(seg: Segment):
        state["seg"] = seg
        refresh_list()

    def refresh_list():
        report = state["report"]
        lbox.delete(0, "end")
        state["visible"] = report.segment_rows(state["seg"]) if report else []
        for pos, i in enumerate(state["visible"]):
            r = report.rows[i]
            tag = f"   [{r.segment.short}]" if state["seg"] is GENERIC else ""
            lbox.insert("end", "  " + r.name + tag)
            if i not in state["excluded"]:
                lbox.select_set(pos)
        recompute()

    def on_select(*_):
        sel = set(lbox.curselection())
        for pos, i in enumerate(state["visible"]):
            (state["excluded"].discard if pos in sel else state["excluded"].add)(i)
        recompute()

    def select_all(on: bool):
        for i in state["visible"]:
            (state["excluded"].discard if on else state["excluded"].add)(i)
        refresh_list()

    def included(seg: Segment) -> list[int]:
        return [i for i in state["report"].segment_rows(seg) if i not in state["excluded"]]

    def recompute(*_):
        report, seg = state["report"], state["seg"]
        paint_tabs()
        summary_title.set(seg.label)
        if not report:
            count_var.set("")
            state["results"] = []
            canvas.pack_forget()
            tsb.pack_forget()
            empty.place(relx=0.5, rely=0.5, anchor="center")
            return
        empty.place_forget()
        if not canvas.winfo_ismapped():
            tsb.pack(side="right", fill="y")
            canvas.pack(side="left", fill="both", expand=True)
        sel = included(seg)
        count_var.set(f"{len(sel)} of {len(state['visible'])} included")
        results = aggregate(report, sel)
        state["results"] = results
        dec = dec_var.get()
        for r, (cur, prev, chg_lbl, rbg) in zip(results, table_cells):
            cur.configure(text=fmt_value(r.cur, r.kind, dec, thousands=True) or "–")
            prev.configure(text=fmt_value(r.prev, r.kind, dec, thousands=True) or "–")
            chg = r.change
            if chg is None or chg == 0:
                chg_lbl.configure(text="–" if chg is None else fmt_value(chg, "pct", dec),
                                  bg=rbg, fg=MUTED, font=F_SMALL)
            elif chg > 0:
                chg_lbl.configure(text="▲ +" + fmt_value(chg, "pct", dec),
                                  bg="#dcfce7", fg=GREEN, font=(FAMILY, 9, "bold"))
            else:
                chg_lbl.configure(text="▼ " + fmt_value(chg, "pct", dec),
                                  bg="#fee2e2", fg=RED, font=(FAMILY, 9, "bold"))

    def to_clipboard(text: str, what: str):
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        persist()
        set_status(f"Copied {what} to clipboard - paste into Excel with {KEY}V.", "ok")

    def copy_segment():
        if not state["report"] or not included(state["seg"]):
            messagebox.showinfo(APP_NAME, "Nothing to copy - load a file and include some campaigns.")
            return
        to_clipboard(build_clipboard_text(state["results"], dec_var.get(), labels_var.get(),
                                          change_var.get(), header_var.get()), state["seg"].short)

    def all_blocks() -> list[tuple[Segment, list[ResultRow]]]:
        return [(seg, aggregate(state["report"], included(seg))) for seg in SEGMENTS]

    def copy_all():
        if not state["report"]:
            messagebox.showinfo(APP_NAME, "Nothing to copy - load a file first.")
            return
        blocks = [(seg.short, res) for seg, res in all_blocks()]
        to_clipboard(build_all_segments_text(blocks, dec_var.get(), labels_var.get(), change_var.get(),
                                             header_var.get(), LAYOUTS[layout_var.get()]),
                     "all segments")

    def export_file():
        report = state["report"]
        if not report:
            messagebox.showinfo(APP_NAME, "Nothing to export - load a file first.")
            return
        out = filedialog.asksaveasfilename(
            title="Save summary", defaultextension=".xlsx",
            initialdir=settings.get("last_dir"),
            initialfile=f"{report.path.stem}_summary.xlsx",
            filetypes=[("Excel workbook", "*.xlsx")],
        )
        if not out:
            return
        try:
            export_xlsx(out, report, all_blocks(), state["excluded"])
        except PermissionError:
            messagebox.showerror(APP_NAME, "Could not save - is the file open in Excel?")
            set_status("Could not save - is the file open in Excel?", "error")
            return
        persist()
        set_status(f"Saved {out}", "ok")

    dec_var.trace_add("write", recompute)
    lbox.bind("<<ListboxSelect>>", on_select)
    root.bind(f"<{MOD}-o>", lambda e: open_file())
    root.bind(f"<{MOD}-Shift-C>", lambda e: copy_segment())
    root.bind(f"<{MOD}-Shift-A>", lambda e: copy_all())
    for n, seg in enumerate(SEGMENTS, start=1):
        root.bind(f"<{MOD}-Key-{n}>", lambda e, s=seg: select_segment(s))
    root.protocol("WM_DELETE_WINDOW", lambda: (persist(), root.destroy()))

    recompute()
    root.after(80, lambda: paned.sashpos(0, int(paned.winfo_width() * 0.37)))
    if initial_file:
        root.after(50, lambda: open_file(initial_file))
    root.mainloop()


if __name__ == "__main__":
    run_gui(sys.argv[1] if len(sys.argv) > 1 else None)
