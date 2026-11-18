# Generic Performance

Turns a Google Search Ads 360 campaign export into current-period vs. compared-period tables for the Generic Search segments, ready to paste into Excel.

It comes in two forms that work the same way:

- **Website** (`web/`, React + TypeScript): runs in any browser, including on phones. Only signed-in team members can open it. Files are read on the user's device and never uploaded.
- **Desktop app** (`desktop/`, Python): Windows `.exe` and Mac app.

```
desktop/                  Python desktop app (Windows exe, Mac app)
web/                      React + TypeScript website
tests/fixtures/           made-up SA360 exports used by the tests
tests/expected/           what the desktop app calculates for them
.github/workflows/
  build-desktop.yml       builds the exe and Mac app for releases
  web.yml                 checks the website matches the desktop app (Cloudflare publishes it)
```

## Metrics

Every numeric column in the export becomes a metric, in file order. Each one is paired with its `(Compared to)` column.

- Additive columns (cost, clicks, impressions, conversions, custom columns, ...) are **summed**.
- Ratios are **recalculated from the sums**, never averaged. These are marked `ƒ` in the app: Avg. CPC, CTR, Avg. CPM, Conv. rate, Cost / conv., Conv. value / cost, Value / conv., and any `A / B` column whose `A` and `B` are both in the file.
- Rates that can't be rebuilt from the file, such as impression share, are skipped and listed under the results table.
- In a comparison export, columns without a `(Compared to)` column are settings, not performance (Budget, target CPA). They are skipped and listed under the results table.
- ID columns, text columns, `Total:` rows and `% change` columns are ignored.

## Use

1. Open the website, or run the desktop app.
2. **Open export...** and pick the `.xlsx` or `.csv` downloaded from SA360. You can also drop the file on the website, or onto the Windows exe. The comparison must be turned on so the `(Compared to)` columns are in the file.
3. Switch segments with the tabs at the top. Untick campaigns to leave them out. A campaign you leave out of its segment is also left out of Generic overall.
   On the website, **Metrics** (above the results) chooses which metrics are shown, copied and exported. Ratios still use hidden columns, so hiding Cost doesn't change Avg. CPC. The choice is remembered by metric name.
4. Copy to Excel:
   - **Copy segment**: the segment you're viewing.
   - **Copy all segments**: all four, either **side by side** (Current / Compared columns per segment) or **stacked** (one block per segment, with a blank row between blocks).
   - **Export to Excel**: a Summary sheet with all segments, plus a Campaigns sheet showing each campaign's segment and whether it was included.

Copy options: decimal separator (`,` for most European Excel setups; the default comes from the computer's regional settings), metric names, a change % column, and a header row. Settings are remembered on that device.

Shortcuts:

| | Website | Desktop (Windows) | Desktop (Mac) |
|---|---|---|---|
| Open export | Ctrl+O / ⌘O | Ctrl+O | ⌘O |
| Switch segment | 1 … 4 | Ctrl+1 … 4 | ⌘1 … 4 |
| Copy segment / all | buttons | Ctrl+Shift+C / A | ⌘⇧C / A |

## Website

### Privacy and sign-in

- **Sign-in:** the site is hosted on Cloudflare Pages behind **Cloudflare Access**. Only email addresses on the allow-list can open it. People enter their email and get a one-time code, so there are no passwords. Cloudflare checks this before sending any of the site's files. **Sign out** in the header ends the session.
- **Client data:** the site has no server side. A file is read in the browser's memory and never sent anywhere. Closing the tab clears the data. The Content-Security-Policy (`web/public/_headers`) blocks all network requests from the page (`connect-src 'none'`) and loads nothing from other sites. To check it yourself, open the browser's developer tools, go to the **Network** tab and open a file: no requests appear. The only thing stored is the copy settings, in that browser's local storage.

### Develop

Requires Node.js 20 or newer.

```
cd web
npm install
npm run dev      # local server with live reload
npm test         # compares results with the desktop app
npm run build    # production build in web/dist
npm run format   # format the code with Prettier (CI checks this)
```

### Deploy (Cloudflare Pages + Access)

Cloudflare builds and publishes `web/` on every push to `main`. GitHub only runs the tests (`.github/workflows/web.yml`).

**Hosting (one time).** Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**. Pick this repo and set:

| Setting | Value |
|---|---|
| Production branch | `main` |
| Framework preset | None |
| Build command | `npm ci && npm run build` |
| Build output directory | `dist` |
| Root directory | `web` |

The site's address is `https://<project-name>.pages.dev`.

**Sign-in (one time).** Cloudflare dashboard → **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted**:

- **Application domains:** add two:
  - `<project-name>.pages.dev` (the live site)
  - `*.<project-name>.pages.dev` (preview builds of other branches)
- **Policy:** action **Allow**, include **Emails**, then list each team member's address.
- **Login method:** **One-time PIN**.

**Add or remove someone:** Zero Trust → Access → Applications → this app → Policies → edit the email list. Up to 50 users is free.

**Check it:** open the site in a private window. You should get Cloudflare's sign-in page, not the app.

## Desktop app

### Download (no Python needed)

Both downloads bundle Python and every dependency. Get them from the repo's **Releases** page: https://github.com/HarisImamovic/emp-generic-performance/releases/latest

- **Windows:** `Generic-Performance.exe`. It is unsigned, so on first run Windows may show "Windows protected your PC": click **More info → Run anyway**.
- **Mac (Apple Silicon, M1 or newer):** `Generic-Performance-mac.zip`. Unzip it and move `Generic-Performance.app` to Applications. It is unsigned, so the first time right-click the app → **Open** → **Open** (or System Settings → Privacy & Security → **Open Anyway**).

GitHub builds both automatically (`.github/workflows/build-desktop.yml`):

- **New release:** on the Releases page, **Draft a new release**, create a new tag such as `v1.2.0` and publish. Both files are attached to that release about a minute later.
- **Test build without a release:** Actions tab → **Build desktop app** → **Run workflow**. The files appear under the run's **Artifacts** (sign-in required).

### Run from source / build the exe yourself

```
cd desktop
pip install -r requirements.txt
python generic_performance.py
```

To build `desktop\dist\Generic-Performance.exe` on Windows, double-click `desktop\build_exe.bat`. It creates a local `.venv` and runs PyInstaller.

## Keeping the two apps in sync

The calculations exist twice: in `desktop/generic_performance.py` and in `web/src/core/`. When you change a rule (segments, metrics, formatting), change it in both places, then:

```
python tests/dump_python.py   # record the desktop app's results
cd web && npm test            # check the website gives the same results
```

Commit the updated `tests/expected/` files. CI fails if they're out of date, or if the website's results differ from the desktop app's. To add a test case, edit `tests/make_fixtures.py` and run it. Use made-up data only, never real client exports.
