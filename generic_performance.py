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
    Metric("CU - Community - App Submit", ("cucommunityappsubmit", "cuappsubmits"), "num"),
    Metric("CU - Community App Submit Value (Sales)", ("cucommunityappsubmitvaluesales", "cuappsubmitsalevalue"), "money"),
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
    if kind == "money":
        s = "-$" + s[1:] if s.startswith("-") else "$" + s
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
            fmt_value(r.cur, r.kind, dec_sep, thousands=r.kind == "money"),
            fmt_value(r.prev, r.kind, dec_sep, thousands=r.kind == "money"),
        ]
        if with_change:
            cells.append(fmt_value(r.change, "pct", dec_sep))
        lines.append("\t".join(cells))
    # Plain "\n": Tk on Windows expands each "\n" to "\r\n" itself, so "\r\n" here
    # would become "\r\r\n" and Excel pastes an empty row after every line.
    return "\n".join(lines)


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
    ws.column_dimensions["A"].width = 42
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
    root.geometry("1200x760")
    root.minsize(900, 600)

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

    style.configure("TEntry", fieldbackground=CARD, bordercolor=BORDER, lightcolor=CARD,
                    darkcolor=CARD, padding=(px(8), px(6)))
    style.map("TEntry", bordercolor=[("focus", ACCENT)], lightcolor=[("focus", ACCENT)])
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

    def card(parent, title: str, subtitle_var=None):
        outer = bordered(parent)
        inner = ttk.Frame(outer, style="Card.TFrame", padding=px(14))
        inner.pack(fill="both", expand=True)
        head = ttk.Frame(inner, style="Card.TFrame")
        head.pack(fill="x", pady=(0, px(10)))
        ttk.Label(head, text=title, style="CardTitle.TLabel").pack(side="left")
        if subtitle_var is not None:
            ttk.Label(head, textvariable=subtitle_var, style="CardMuted.TLabel").pack(
                side="left", padx=(px(10), 0), pady=(px(2), 0))
        return outer, inner, head

    # ---- state -------------------------------------------------------------
    state: dict = {"report": None, "visible": [], "results": []}

    filter_var = tk.StringVar(value=settings.get("filter", ""))
    dec_var = tk.StringVar(value=settings.get("dec_sep", system_decimal_separator()))
    labels_var = tk.BooleanVar(value=settings.get("with_labels", False))
    change_var = tk.BooleanVar(value=settings.get("with_change", False))
    header_var = tk.BooleanVar(value=settings.get("with_header", False))
    file_var = tk.StringVar(value="No file loaded")
    status_var = tk.StringVar(value="Ready.")
    count_var = tk.StringVar(value="")

    def persist():
        settings.update(
            filter=filter_var.get(), dec_sep=dec_var.get(), with_labels=labels_var.get(),
            with_change=change_var.get(), with_header=header_var.get(),
        )
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
    ttk.Button(hinner, text="Open export…   Ctrl+O", style="Accent.TButton",
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

    # ---- body --------------------------------------------------------------
    paned = ttk.PanedWindow(root, orient="horizontal")
    paned.pack(fill="both", expand=True, padx=px(16), pady=px(16))

    # Campaigns card
    left_wrap = ttk.Frame(paned)
    paned.add(left_wrap, weight=2)
    lcard, left, _ = card(left_wrap, "Campaigns", count_var)
    lcard.pack(fill="both", expand=True, padx=(0, px(8)))

    entry = ttk.Entry(left, textvariable=filter_var)
    entry.pack(fill="x")
    ttk.Label(left, text="Filter  ·  comma = OR  ·  -word = exclude",
              style="CardMuted.TLabel").pack(anchor="w", pady=(px(4), px(8)))

    lbar = ttk.Frame(left, style="Card.TFrame")
    lbar.pack(fill="x", pady=(0, px(4)))
    ttk.Label(lbar, text="Click to include / exclude",
              style="CardMuted.TLabel").pack(side="left")
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

    # Summary card
    right_wrap = ttk.Frame(paned)
    paned.add(right_wrap, weight=3)
    rcard, right, _ = card(right_wrap, "Summary")
    rcard.pack(fill="both", expand=True, padx=(px(8), 0))

    # bottom part first so it never gets squeezed out
    btns = ttk.Frame(right, style="Card.TFrame")
    btns.pack(side="bottom", fill="x")
    ttk.Button(btns, text="Copy to clipboard", style="Accent.TButton",
               command=lambda: copy_clipboard()).pack(side="right")
    ttk.Button(btns, text="Export to Excel…", command=lambda: export_file()).pack(
        side="right", padx=px(8))
    ttk.Label(btns, text="Ctrl+Shift+C to copy", style="CardMuted.TLabel").pack(side="left")
    tk.Frame(right, bg=BORDER, height=1).pack(side="bottom", fill="x", pady=px(12))

    opts = ttk.Frame(right, style="Card.TFrame")
    opts.pack(side="bottom", fill="x", pady=(px(12), 0))
    ttk.Label(opts, text="Copy options", style="CardMuted.TLabel").grid(
        row=0, column=0, columnspan=6, sticky="w", pady=(0, px(4)))
    ttk.Label(opts, text="Decimal", style="Card.TLabel").grid(row=1, column=0, sticky="w")
    ttk.Combobox(opts, textvariable=dec_var, values=(".", ","), width=3, state="readonly").grid(
        row=1, column=1, sticky="w", padx=(px(6), px(18)))
    ttk.Checkbutton(opts, text="Metric names", variable=labels_var, style="Card.TCheckbutton").grid(
        row=1, column=2, sticky="w")
    ttk.Checkbutton(opts, text="Change %", variable=change_var, style="Card.TCheckbutton").grid(
        row=1, column=3, sticky="w", padx=px(12))
    ttk.Checkbutton(opts, text="Header", variable=header_var, style="Card.TCheckbutton").grid(
        row=1, column=4, sticky="w")

    # results table: a plain label grid, so each cell can have its own color
    table_frame = bordered(right)
    table_frame.pack(fill="both", expand=True)
    table = tk.Frame(table_frame, bg=CARD)
    table.pack(fill="x", anchor="n")
    from tkinter import font as tkfont
    longest = max(tkfont.Font(root, font=F_BASE).measure(m.label) for m in METRICS)
    table.columnconfigure(0, weight=1, minsize=longest + px(24))
    for c in (1, 2, 3):
        table.columnconfigure(c, minsize=px(110 if c < 3 else 100))
    CELL_PAD = dict(padx=px(12), pady=px(5))
    for c, (text, anchor) in enumerate((("Metric", "w"), ("Current", "e"),
                                        ("Compared", "e"), ("Change", "e"))):
        tk.Label(table, text=text, bg=HEAD_BG, fg=MUTED, font=F_BOLD, anchor=anchor,
                 padx=px(12), pady=px(6)).grid(row=0, column=c, sticky="nsew")
    table_cells: list[tuple] = []
    for n, m in enumerate(METRICS, start=1):
        rbg = STRIPE if n % 2 == 0 else CARD
        tk.Frame(table, bg=rbg).grid(row=n, column=0, columnspan=4, sticky="nsew")
        name = tk.Label(table, text=m.label, bg=rbg, fg=TEXT, font=F_BASE, anchor="w", **CELL_PAD)
        cur = tk.Label(table, bg=rbg, fg=TEXT, font=F_BOLD, anchor="e", **CELL_PAD)
        prev = tk.Label(table, bg=rbg, fg=MUTED, font=F_BASE, anchor="e", **CELL_PAD)
        chg = tk.Label(table, bg=rbg, fg=MUTED, font=F_SMALL, padx=px(8), pady=px(2))
        name.grid(row=n, column=0, sticky="nsew")
        cur.grid(row=n, column=1, sticky="nsew")
        prev.grid(row=n, column=2, sticky="nsew")
        chg.grid(row=n, column=3, sticky="e", padx=(0, px(10)))
        table_cells.append((cur, prev, chg, rbg))

    empty = tk.Label(table_frame, bg=CARD, fg=MUTED, font=(FAMILY, 11), justify="center",
                     text="No data yet\n\nOpen an SA360 export (Ctrl+O)\n"
                          "or drag the file onto Generic-Performance.exe")

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
        sheet = f"  ·  sheet {report.sheet}" if report.sheet else ""
        file_var.set(f"{Path(path).name}{sheet}  ·  {len(report.rows)} campaign rows")
        missing = report.missing_columns()
        msg = []
        if report.campaign_col is None:
            msg.append("No 'Campaign' column found - rows are listed by row number.")
        if missing:
            msg.append("Columns not found: " + ", ".join(missing))
        if msg:
            set_status("  ".join(msg), "warn")
        else:
            set_status(f"Loaded {Path(path).name} - all columns found.", "ok")
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
                    lbox.insert("end", "  " + r.name)
            lbox.select_set(0, "end")
        recompute()

    def select_all(on: bool):
        (lbox.select_set if on else lbox.select_clear)(0, "end")
        recompute()

    def selected_rows() -> list[int]:
        return [state["visible"][i] for i in lbox.curselection()]

    def recompute(*_):
        report = state["report"]
        if not report:
            count_var.set("")
            state["results"] = []
            table.pack_forget()
            empty.place(relx=0.5, rely=0.5, anchor="center")
            return
        empty.place_forget()
        table.pack(fill="x", anchor="n")
        sel = selected_rows()
        shown = len(state["visible"])
        count_var.set(f"{len(sel)} of {shown} selected" + (
            f"  ·  {len(report.rows) - shown} filtered out" if shown < len(report.rows) else ""))
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
        set_status("Copied to clipboard - paste into Excel with Ctrl+V.", "ok")

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
            set_status("Could not save - is the file open in Excel?", "error")
            return
        persist()
        set_status(f"Saved {out}", "ok")

    filter_var.trace_add("write", refresh_list)
    dec_var.trace_add("write", recompute)
    lbox.bind("<<ListboxSelect>>", recompute)
    root.bind("<Control-o>", lambda e: open_file())
    root.bind("<Control-Shift-C>", lambda e: copy_clipboard())
    root.protocol("WM_DELETE_WINDOW", lambda: (persist(), root.destroy()))

    recompute()
    entry.focus_set()
    root.after(80, lambda: paned.sashpos(0, int(paned.winfo_width() * 0.37)))
    if initial_file:
        root.after(50, lambda: open_file(initial_file))
    root.mainloop()


if __name__ == "__main__":
    run_gui(sys.argv[1] if len(sys.argv) > 1 else None)
