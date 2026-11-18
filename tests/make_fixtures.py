"""Writes the made-up SA360-style exports in tests/fixtures/ (no real client data).

Run once after changing it: python tests/make_fixtures.py
"""
from __future__ import annotations

import csv
from pathlib import Path

from openpyxl import Workbook

HERE = Path(__file__).parent / "fixtures"

HEADER = [
    "Campaign", "Campaign ID", "Budget",
    "Cost", "Cost (Compared to)", "Cost (% change)",
    "Clicks", "Clicks (Compared to)",
    "Impr.", "Impr. (Compared to)",
    "CTR", "CTR (Compared to)",
    "Avg. CPC", "Avg. CPC (Compared to)",
    "Conversions", "Conversions (Compared to)",
    "Conv. value", "Conv. value (Compared to)",
    "Cost / conv.", "Cost / conv. (Compared to)",
    "Conv. value / cost", "Conv. value / cost (Compared to)",
    "Search impr. share", "Search impr. share (Compared to)",
    "Leads", "Leads (Compared to)",
    "Leads / Clicks", "Leads / Clicks (Compared to)",
]

# name, budget, cost, cost_prev, clicks, clicks_prev, impr, impr_prev, conv, conv_prev, value, value_prev, leads, leads_prev, is
CAMPAIGNS = [
    ("US_SearchNB_Post_Brand-Terms", 500, 1234.567, 1100.125, 812, 790, 15230, 14980, 41.5, 38, 9100.25, 8700, 12, 9, 0.62),
    ("US_SearchNB_PostL_Generic", 250, 0.125, 0.375, 1, 3, 40, 52, 0, 0, 0, 0, 0, 1, 0.1),
    ("US_SearchNB_Vertical_Nursing", 300, 2500.5, 2600.75, 1500, 1420, 30001, 29000, 80.25, 75.5, 15000.5, 14200.75, 30, 25, 0.48),
    ("US_SearchNB_Vertical_Business", 300, 999.995, 1000.005, 650, 702, 12000, 12500, 20, 22, 4000, 4100.5, 8, 11, 0.55),
    ("US_SearchNB_DMA_Chicago", 150, 410.4, 380.2, 220, 230, 5100, 4900, 9, 7.5, 1800, 1500, 4, 3, 0.33),
    ("US_SearchNB_DMA_Houston", 150, 0, 12.5, 0, 6, 0, 120, 0, 0.5, 0, 50, 0, 0, None),
    ("US_SearchNB_Aurora_Test", 100, 77.7, 66.6, 40, 35, 900, 850, 2, 1, 300, 200, 1, 1, 0.2),
    ("US_SearchNB_CinDMA_Local", 100, 55.5, 44.4, 30, 25, 700, 650, 1, 1, 150, 120, 0, 1, 0.25),
    ("US_Brand_Exact", 800, 3000, 2800, 2100, 2000, 9000, 8800, 150, 140, 45000, 41000, 60, 55, 0.91),
    ("US_PMax_Generic", 400, 1500.333, 1400.667, 900, 870, 40000, 39000, 30, 28, 6000, 5800, 10, 12, 0.4),
]


def pct(x):
    return None if x is None else x


def rows_numeric():
    out = []
    for (name, budget, cost, cost_p, cl, cl_p, im, im_p, cv, cv_p, val, val_p, ld, ld_p, isr) in CAMPAIGNS:
        change = (cost - cost_p) / cost_p if cost_p else None
        out.append([
            name, 1000 + len(out), budget,
            cost, cost_p, change,
            cl, cl_p, im, im_p,
            cl / im if im else None, cl_p / im_p if im_p else None,
            cost / cl if cl else None, cost_p / cl_p if cl_p else None,
            cv, cv_p, val, val_p,
            cost / cv if cv else None, cost_p / cv_p if cv_p else None,
            val / cost if cost else None, val_p / cost_p if cost_p else None,
            isr, isr if isr is None else round(isr * 0.95, 4),
            ld, ld_p,
            ld / cl if cl else None, ld_p / cl_p if cl_p else None,
        ])
    return out


def fmt_us(v, money=False, percent=False):
    if v is None:
        return "--"
    if percent:
        return f"{v * 100:.2f}%"
    s = f"{v:,.2f}" if isinstance(v, float) else f"{v:,}"
    return "$" + s if money else s


def fmt_eu(v, percent=False):
    if v is None:
        return " --"
    if percent:
        return f"{v * 100:.2f}".replace(".", ",") + " %"
    s = f"{v:,.2f}" if isinstance(v, float) else f"{v:,}"
    return s.replace(",", "\0").replace(".", ",").replace("\0", ".")


MONEY = {2, 3, 4, 12, 13, 16, 17, 18, 19}
PERCENT = {5, 10, 11, 22, 23}


def text_rows(fmt):
    out = []
    for r in rows_numeric():
        cells = [r[0], str(r[1])]
        for j, v in enumerate(r[2:], start=2):
            if fmt == "us":
                cells.append(fmt_us(v, money=j in MONEY, percent=j in PERCENT))
            else:
                cells.append(fmt_eu(v, percent=j in PERCENT))
        out.append(cells)
    return out


def total_row(n):
    return ["Total: Campaigns"] + [""] * (n - 1)


def write_csv_us():
    with open(HERE / "sa360_us.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Campaign report"])
        w.writerow(["Nov 1, 2026 - Nov 15, 2026 compared to Oct 17, 2026 - Oct 31, 2026"])
        w.writerow([])
        w.writerow(HEADER)
        for r in text_rows("us"):
            w.writerow(r)
        w.writerow(total_row(len(HEADER)))


def write_csv_eu():
    with open(HERE / "sa360_eu.csv", "w", newline="", encoding="cp1252") as f:
        w = csv.writer(f, delimiter=";")
        w.writerow(["Kampagnenbericht – Zeitraum"])
        w.writerow(HEADER)
        for r in text_rows("eu"):
            w.writerow(r)
        w.writerow(total_row(len(HEADER)))


def write_xlsx():
    wb = Workbook()
    notes = wb.active
    notes.title = "Notes"
    notes.append(["This sheet has no header row and is skipped."])
    ws = wb.create_sheet("Report")
    ws.append(["Campaign report"])
    ws.append([])
    ws.append(HEADER)
    for r in rows_numeric():
        ws.append(r)
    ws.append(total_row(len(HEADER)))
    wb.save(HERE / "sa360.xlsx")


if __name__ == "__main__":
    HERE.mkdir(exist_ok=True)
    write_csv_us()
    write_csv_eu()
    write_xlsx()
    print("wrote", sorted(p.name for p in HERE.iterdir()))
