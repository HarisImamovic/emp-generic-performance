# Generic Performance

Small Windows desktop tool. It turns a Google Search Ads 360 campaign export into current-period vs. compared-period tables for the Generic Search segments, ready to paste into Excel.

## Segments

Campaigns are sorted by name, using the same rules as the SA360 CASE formula (case-insensitive):

| Segment | Rule |
|---|---|
| **Post-L** (BAU \| Post-L \| Generic Search) | contains `searchnb` and `post` |
| **Pre-L Vertical** (BAU \| Pre-L \| Generic Search \| Vertical) | contains `searchnb`, no `dma`, no `post` |
| **Pre-L Campus** (BAU \| Pre-L \| Generic Search \| Campus) | contains `searchnb` and `dma`, no `post` |
| **Generic overall** | all three above combined |

Each rule excludes campaigns that contain `aurora`, `ssm`, `cindma`, `slcdma` or `nsh`. Campaigns that match no rule are left out. They are still counted in the header and listed in the Excel export.

## Metrics

Every numeric column in the export becomes a metric, in file order. Each one is paired with its `(Compared to)` column.

- Additive columns (cost, clicks, impressions, conversions, custom columns, ...) are **summed**.
- Ratios are **recalculated from the sums**, never averaged. These are marked `ƒ` in the app: Avg. CPC, CTR, Avg. CPM, Conv. rate, Cost / conv., Conv. value / cost, Value / conv., and any `A / B` column whose `A` and `B` are both in the file.
- Rates that can't be rebuilt from the file, such as impression share, are skipped and named in the status bar.
- In a comparison export, columns without a `(Compared to)` column are settings, not performance (Budget, target CPA). They are skipped and named in the status bar.
- ID columns, text columns, `Total:` rows and `% change` columns are ignored.

## Use

1. Run `dist\Generic-Performance.exe`, or drag the export file onto the exe.
2. **Open export...** and pick the `.xlsx` or `.csv` downloaded from SA360. The comparison must be turned on so the `(Compared to)` columns are in the file.
3. Switch segments with the tabs at the top (Ctrl+1 ... Ctrl+4). Click campaigns in the list to leave them out or add them back. A campaign you leave out of its segment is also left out of Generic overall.
4. Copy to Excel:
   - **Copy segment** (Ctrl+Shift+C): the segment you're viewing.
   - **Copy all segments** (Ctrl+Shift+A): all four, either **side by side** (Current / Compared columns per segment) or **stacked** (one block per segment, with a blank row between blocks).
   - **Export to Excel...**: a Summary sheet with all segments, plus a Campaigns sheet showing each campaign's segment and whether it was included.

Copy options: decimal separator (`,` for most European Excel setups; the default comes from Windows' regional settings), metric names, a change % column, and a header row. Settings are remembered.

## Run from source / rebuild the exe

```
pip install -r requirements.txt
python generic_performance.py
```

To build `dist\Generic-Performance.exe`, double-click `build_exe.bat`. It creates a local `.venv` and runs PyInstaller.
