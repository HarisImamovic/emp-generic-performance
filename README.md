# Generic Performance

Small Windows desktop tool. It turns a Google Search Ads 360 campaign export into a two-column table (current period | compared period) that you can paste into Excel.

Metrics, in this order: **Cost, Clicks, Impr., Avg. CPC, CTR, CU App Submits, CU App Submit Sale Value**.

## Use

1. Run `dist\Generic-Performance.exe`, or drag the export file onto the exe.
2. **Open export...** and pick the `.xlsx` or `.csv` downloaded from SA360. The comparison must be enabled so the `(Compared to)` columns are in the file.
3. Type a **campaign filter**, for example `generic`, `generic, nonbrand`, or `generic, -brand`. Terms separated by commas are OR'ed, and a leading `-` excludes. Click individual campaigns in the list to leave them out or add them back.
4. **Copy to clipboard** and paste into Excel, or **Export to Excel...**.

Notes:
- Cost, clicks, impressions, submits and sale value are **summed** over the selected campaigns. **Avg. CPC = Cost / Clicks** and **CTR = Clicks / Impr.** are recalculated from those sums, never averaged.
- SA360 `Total: ...` rows and `% change` columns are ignored.
- Set **Decimal separator** to match your Excel (`,` for most European locales). The default comes from Windows' regional settings.
- Optional extras for the copied table: metric names, a change % column, a header row. Your settings and last filter are remembered.

## Run from source / rebuild the exe

```
pip install -r requirements.txt
python generic_performance.py
```

To build `dist\Generic-Performance.exe`, double-click `build_exe.bat`. It creates a local `.venv` and runs PyInstaller.
