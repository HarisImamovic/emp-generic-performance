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


@dataclass(frozen=True)
class Metric:
    label: str
    aliases: tuple[str, ...]
    kind: str
    derived: tuple[str, str] | None = None


METRICS: tuple[Metric, ...] = (
    Metric("Cost", ("cost",), "money"),
    Metric("Clicks", ("clicks",), "int"),
    Metric("Impr.", ("impr", "impressions"), "int"),
    Metric("Avg. CPC", ("avgcpc", "averagecpc"), "money", ("Cost", "Clicks")),
    Metric("CTR", ("ctr", "clickthroughrate"), "pct", ("Clicks", "Impr.")),
    Metric("CU App Submits", ("cuappsubmits",), "num"),
    Metric("CU App Submit Sale Value", ("cuappsubmitsalevalue",), "money"),
)

_COMPARE_RE = re.compile(
    r"^(comparedto|compareto|comparison|compared|previousperiod|previous|priorperiod|prior)"
)
_DELTA_WORDS = ("change", "diff", "pct", "percent", "delta")


def norm(value) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower()) if value is not None else ""


def classify_header(header) -> tuple[str, str] | None:
    n = norm(header)
    if not n:
        return None
    for m in METRICS:
        for alias in m.aliases:
            if n == alias:
                return m.label, "cur"
            if n.startswith(alias):
                rest = n[len(alias):]
                if _COMPARE_RE.match(rest) and not any(w in rest for w in _DELTA_WORDS):
                    return m.label, "prev"
    return None


_NON_NUMERIC = re.compile(r"[^\d,.\-]")
_EMPTY_TOKENS = {"", "--", "-", "—", "n/a", "na", "none", "null"}


def to_number(value) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(" ", "").replace(" ", "")
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
    return s


def pct_change(cur: float | None, prev: float | None) -> float | None:
    if cur is None or prev is None or prev == 0:
        return None
    return (cur - prev) / abs(prev)


@dataclass
class Row:
    name: str
    values: tuple


@dataclass
class Report:
    path: Path
    sheet: str | None
    header: list
    columns: dict[tuple[str, str], int]
    campaign_col: int | None
    rows: list[Row]

    def missing_columns(self) -> list[str]:
        out = []
        for m in METRICS:
            for period, suffix in (("cur", ""), ("prev", " (compared)")):
                if (m.label, period) not in self.columns:
                    if m.derived and all((d, period) in self.columns for d in m.derived):
                        continue
                    out.append(m.label + suffix)
        return out


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
    return list(csv.reader(io.StringIO(text), delimiter=delimiter))


def _read_xlsx_sheets(path: Path) -> list[tuple[str, list[list]]]:
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        return [(ws.title, [list(r) for r in ws.iter_rows(values_only=True)]) for ws in wb.worksheets]
    finally:
        wb.close()


def _find_header(rows: list[list], max_scan: int = 60) -> tuple[int, dict, int | None] | None:
    for i, row in enumerate(rows[:max_scan]):
        cols: dict[tuple[str, str], int] = {}
        campaign_col = None
        for j, cell in enumerate(row):
            if campaign_col is None and norm(cell) in ("campaign", "campaignname"):
                campaign_col = j
            key = classify_header(cell)
            if key and key not in cols:
                cols[key] = j
        labels = {k[0] for k in cols}
        if "Cost" in labels and ({"Clicks", "Impr."} & labels):
            return i, cols, campaign_col
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
        hdr_idx, columns, campaign_col = found
        metric_cols = set(columns.values())
        data: list[Row] = []
        for n, values in enumerate(rows[hdr_idx + 1:], start=hdr_idx + 2):
            values = tuple(values)
            if not any(v not in (None, "") for v in values):
                continue
            first_text = next((str(v).strip() for v in values if v not in (None, "")), "")
            name = _cell(values, campaign_col)
            name = str(name).strip() if name not in (None, "") else ""
            if norm(first_text).startswith("total") or norm(name).startswith("total"):
                continue
            if all(to_number(_cell(values, c)) is None for c in metric_cols):
                continue
            data.append(Row(name or f"(row {n})", values))
        return Report(path, sheet_name, list(rows[hdr_idx]), columns, campaign_col, data)

    raise ValueError(
        "Could not find a header row with Cost and Clicks/Impr. columns.\n"
        "Make sure the export contains those columns."
    )


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
    totals: dict[str, dict[str, float | None]] = {"cur": {}, "prev": {}}

    for period, vals in totals.items():
        for m in METRICS:
            if m.derived:
                continue
            col = report.columns.get((m.label, period))
            if col is None or not rows:
                vals[m.label] = None
                continue
            nums = [to_number(_cell(r.values, col)) for r in rows]
            vals[m.label] = sum(x for x in nums if x is not None)

        for m in METRICS:
            if not m.derived:
                continue
            num, den = (vals.get(d) for d in m.derived)
            if num is not None and den is not None:
                vals[m.label] = num / den if den else None
            elif len(rows) == 1 and (m.label, period) in report.columns:
                vals[m.label] = to_number(_cell(rows[0].values, report.columns[(m.label, period)]))
            else:
                vals[m.label] = None

    return [ResultRow(m.label, m.kind, totals["cur"][m.label], totals["prev"][m.label]) for m in METRICS]


def match_filter(name: str, text: str) -> bool:
    terms = [t.strip().lower() for t in text.split(",") if t.strip()]
    include = [t for t in terms if not t.startswith("-")]
    exclude = [t[1:].strip() for t in terms if t.startswith("-") and t[1:].strip()]
    n = name.lower()
    if include and not any(t in n for t in include):
        return False
    return not any(t in n for t in exclude)


def build_clipboard_text(results: list[ResultRow], dec_sep: str, with_labels: bool,
                         with_change: bool, with_header: bool) -> str:
    lines = []
    if with_header:
        cols = (["Metric"] if with_labels else []) + ["Current", "Compared"] + (["Change %"] if with_change else [])
        lines.append("\t".join(cols))
    for r in results:
        cells = ([r.label] if with_labels else []) + [
            fmt_value(r.cur, r.kind, dec_sep),
            fmt_value(r.prev, r.kind, dec_sep),
        ]
        if with_change:
            cells.append(fmt_value(r.change, "pct", dec_sep))
        lines.append("\t".join(cells))
    return "\r\n".join(lines)


_XL_FORMATS = {"money": "#,##0.00", "int": "#,##0", "num": "#,##0.##", "pct": "0.00%"}


def export_xlsx(path: str | Path, results: list[ResultRow], report: Report,
                included: list[str], filter_text: str) -> None:
    from openpyxl import Workbook
    from openpyxl.styles import Font

    wb = Workbook()
    ws = wb.active
    ws.title = "Summary"
    ws.append(["Metric", "Current", "Compared", "Change %"])
    for c in ws[1]:
        c.font = Font(bold=True)
    for r in results:
        ws.append([r.label, r.cur, r.prev, r.change])
        row = ws.max_row
        for col in (2, 3):
            ws.cell(row, col).number_format = _XL_FORMATS[r.kind]
        ws.cell(row, 4).number_format = "0.00%"
    ws.column_dimensions["A"].width = 28
    for col in "BCD":
        ws.column_dimensions[col].width = 16

    info = wb.create_sheet("Campaigns")
    info.append(["Source file", str(report.path)])
    info.append(["Filter", filter_text])
    info.append(["Campaigns included", len(included)])
    info.append([])
    for name in included:
        info.append([name])
    info.column_dimensions["A"].width = 60
    wb.save(path)


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


def run_gui(initial_file: str | None = None) -> None:
    import tkinter as tk
    from tkinter import filedialog, messagebox, ttk

    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            pass

    settings = load_settings()

    root = tk.Tk()
    root.title(APP_NAME)
    root.geometry("1000x560")
    root.minsize(800, 440)

    state: dict = {"report": None, "visible": [], "results": []}

    filter_var = tk.StringVar(value=settings.get("filter", ""))
    dec_var = tk.StringVar(value=settings.get("dec_sep", system_decimal_separator()))
    labels_var = tk.BooleanVar(value=settings.get("with_labels", False))
    change_var = tk.BooleanVar(value=settings.get("with_change", False))
    header_var = tk.BooleanVar(value=settings.get("with_header", False))
    file_var = tk.StringVar(value="No file loaded - click 'Open export...'")
    status_var = tk.StringVar(value="")
    count_var = tk.StringVar(value="")

    def persist():
        settings.update(
            filter=filter_var.get(), dec_sep=dec_var.get(), with_labels=labels_var.get(),
            with_change=change_var.get(), with_header=header_var.get(),
        )
        save_settings(settings)

    top = ttk.Frame(root, padding=(10, 10, 10, 4))
    top.pack(fill="x")
    ttk.Button(top, text="Open export...", command=lambda: open_file()).pack(side="left")
    ttk.Label(top, textvariable=file_var, foreground="#555").pack(side="left", padx=10)

    frow = ttk.Frame(root, padding=(10, 4))
    frow.pack(fill="x")
    ttk.Label(frow, text="Campaign filter:").pack(side="left")
    entry = ttk.Entry(frow, textvariable=filter_var, width=50)
    entry.pack(side="left", padx=6)
    ttk.Label(frow, text="comma = OR,  -word = exclude", foreground="#777").pack(side="left")

    paned = ttk.PanedWindow(root, orient="horizontal")
    paned.pack(fill="both", expand=True, padx=10, pady=6)

    left = ttk.Frame(paned)
    paned.add(left, weight=1)
    lhead = ttk.Frame(left)
    lhead.pack(fill="x")
    ttk.Label(lhead, textvariable=count_var).pack(side="left")
    ttk.Button(lhead, text="None", width=6, command=lambda: select_all(False)).pack(side="right")
    ttk.Button(lhead, text="All", width=6, command=lambda: select_all(True)).pack(side="right", padx=4)
    lbox_frame = ttk.Frame(left)
    lbox_frame.pack(fill="both", expand=True, pady=(4, 0))
    lbox = tk.Listbox(lbox_frame, selectmode="multiple", exportselection=False, activestyle="none")
    lsb = ttk.Scrollbar(lbox_frame, orient="vertical", command=lbox.yview)
    lbox.configure(yscrollcommand=lsb.set)
    lbox.pack(side="left", fill="both", expand=True)
    lsb.pack(side="right", fill="y")

    right = ttk.Frame(paned)
    paned.add(right, weight=1)
    tree = ttk.Treeview(right, columns=("metric", "cur", "prev", "chg"), show="headings", height=8)
    for col, text, width, anchor in (
        ("metric", "Metric", 200, "w"), ("cur", "Current", 110, "e"),
        ("prev", "Compared", 110, "e"), ("chg", "Change", 80, "e"),
    ):
        tree.heading(col, text=text)
        tree.column(col, width=width, anchor=anchor)
    tree.tag_configure("up", foreground="#1a7f37")
    tree.tag_configure("down", foreground="#c62828")
    tree.pack(fill="both", expand=True)

    opts = ttk.Frame(right, padding=(0, 8, 0, 0))
    opts.pack(fill="x")
    ttk.Label(opts, text="Decimal separator:").grid(row=0, column=0, sticky="w")
    ttk.Combobox(opts, textvariable=dec_var, values=(".", ","), width=3, state="readonly").grid(
        row=0, column=1, sticky="w", padx=(4, 16))
    ttk.Checkbutton(opts, text="Metric names", variable=labels_var).grid(row=0, column=2, sticky="w")
    ttk.Checkbutton(opts, text="Change % column", variable=change_var).grid(row=0, column=3, sticky="w", padx=8)
    ttk.Checkbutton(opts, text="Header row", variable=header_var).grid(row=0, column=4, sticky="w")

    btns = ttk.Frame(right, padding=(0, 8, 0, 0))
    btns.pack(fill="x")
    ttk.Button(btns, text="Copy to clipboard", command=lambda: copy_clipboard()).pack(side="left")
    ttk.Button(btns, text="Export to Excel...", command=lambda: export_file()).pack(side="left", padx=6)

    ttk.Label(root, textvariable=status_var, padding=(10, 2, 10, 8), foreground="#555",
              wraplength=960, justify="left").pack(fill="x")

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
            return
        settings["last_dir"] = str(Path(path).parent)
        persist()
        state["report"] = report
        sheet = f"  [sheet: {report.sheet}]" if report.sheet else ""
        file_var.set(f"{Path(path).name}{sheet}  -  {len(report.rows)} campaign rows")
        missing = report.missing_columns()
        msg = []
        if report.campaign_col is None:
            msg.append("No 'Campaign' column found - rows are listed by row number.")
        if missing:
            msg.append("Columns not found: " + ", ".join(missing))
        status_var.set("  ".join(msg) or "All columns found.")
        refresh_list()

    def refresh_list(*_):
        report = state["report"]
        lbox.delete(0, "end")
        state["visible"] = []
        if report:
            text = filter_var.get()
            for i, r in enumerate(report.rows):
                if match_filter(r.name, text):
                    state["visible"].append(i)
                    lbox.insert("end", r.name)
            lbox.select_set(0, "end")
        recompute()

    def select_all(on: bool):
        (lbox.select_set if on else lbox.select_clear)(0, "end")
        recompute()

    def selected_rows() -> list[int]:
        return [state["visible"][i] for i in lbox.curselection()]

    def recompute(*_):
        tree.delete(*tree.get_children())
        report = state["report"]
        if not report:
            count_var.set("Campaigns")
            state["results"] = []
            return
        sel = selected_rows()
        count_var.set(f"Campaigns: {len(sel)} selected / {len(state['visible'])} shown / {len(report.rows)} total")
        results = aggregate(report, sel)
        state["results"] = results
        dec = dec_var.get()
        for r in results:
            chg = r.change
            tag = () if chg is None or chg == 0 else (("up",) if chg > 0 else ("down",))
            tree.insert("", "end", values=(
                r.label,
                fmt_value(r.cur, r.kind, dec, thousands=True),
                fmt_value(r.prev, r.kind, dec, thousands=True),
                "" if chg is None else ("+" if chg > 0 else "") + fmt_value(chg, "pct", dec),
            ), tags=tag)

    def copy_clipboard():
        if not state["results"] or not selected_rows():
            messagebox.showinfo(APP_NAME, "Nothing to copy - load a file and select campaigns.")
            return
        text = build_clipboard_text(state["results"], dec_var.get(), labels_var.get(),
                                    change_var.get(), header_var.get())
        root.clipboard_clear()
        root.clipboard_append(text)
        root.update()
        persist()
        status_var.set("Copied to clipboard - paste into Excel (Ctrl+V).")

    def export_file():
        report = state["report"]
        if not report or not selected_rows():
            messagebox.showinfo(APP_NAME, "Nothing to export - load a file and select campaigns.")
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
            export_xlsx(out, state["results"], report,
                        [report.rows[i].name for i in selected_rows()], filter_var.get())
        except PermissionError:
            messagebox.showerror(APP_NAME, "Could not save - is the file open in Excel?")
            return
        persist()
        status_var.set(f"Saved {out}")

    filter_var.trace_add("write", refresh_list)
    dec_var.trace_add("write", recompute)
    lbox.bind("<<ListboxSelect>>", recompute)
    root.bind("<Control-o>", lambda e: open_file())
    root.bind("<Control-Shift-C>", lambda e: copy_clipboard())
    root.protocol("WM_DELETE_WINDOW", lambda: (persist(), root.destroy()))

    recompute()
    entry.focus_set()
    if initial_file:
        root.after(50, lambda: open_file(initial_file))
    root.mainloop()


if __name__ == "__main__":
    run_gui(sys.argv[1] if len(sys.argv) > 1 else None)
