# Doc Harvester

A cross-platform desktop app that searches the web and batch-downloads documents by file type. Enter a keyword, pick one or more file types, set a download limit — Doc Harvester does the rest.

Built with [Electron](https://www.electronjs.org/) v28.

---

## Features

- **Multi-type search** — search for PDF, DOCX, DOC, XLSX, XLS, PPTX, and PPT files simultaneously
- **Fair distribution** — when multiple file types are selected, each type receives an equal quota; leftover slots go to whichever types have the most available results
- **Dual search engine** — Bing HTTP (primary, no session tracking) + Google browser (fallback)
- **Deep page scanning** — when a search result links to a webpage rather than a direct file, the app scans that page for embedded document links
- **Download resilience** — automatic retry on 403 / connection reset / timeout with adjusted headers
- **Clean UI** — live progress bar, per-file status (locating → downloading → saved / failed), one-click folder open
- **Cross-platform** — runs on Windows, macOS, and Linux

---

## Screenshots

> _Run `npm start` and the app opens immediately — no login, no setup._

| Search Configuration | Live Download Progress |
|---|---|
| _(keyword + file type chips + output folder)_ | _(progress bar + per-file status log)_ |

---

## Prerequisites

| Tool | Minimum version |
|---|---|
| [Node.js](https://nodejs.org/) | 18 |
| npm | 9 (ships with Node 18) |

No other dependencies are needed — Electron and its Chromium engine are installed automatically via `npm install`.

---

## Quick Start (run from source)

```bash
# 1. Clone the repo
git clone https://github.com/shazam37/doc-harvester.git
cd doc-harvester

# 2. Install dependencies (takes ~1 min on first run — downloads Electron)
npm install

# 3. Launch the app
npm start
```

The app window opens immediately. No build step is required to run from source.

---

## Using the App

### Step-by-step

1. **Search Keyword** — type anything you would search on Google.  
   _Examples: `Pfizer annual report 2024`, `Cipla financial results`, `machine learning tutorial`_

2. **File Types** — tick one or more checkboxes. PDF and DOCX are selected by default.

3. **Max Downloads** — how many files to download in total (1 – 100). The quota is split fairly across all selected file types.

4. **Output Folder** — click **Browse…** and choose where files are saved.

5. Click **Start Download**. Watch the progress log update in real time.

6. Click **Open Folder** at any time to open the download directory in your file manager.

7. Click **Stop** to cancel mid-run cleanly.

### Tips

- If you select 3 file types and set Max Downloads to 12, the app tries to get 4 of each. Any unspent slots from a rare type are redistributed to more prevalent types automatically.
- Re-running the same search with the same output folder is safe — the app deduplicates by URL so files already downloaded are not downloaded again.
- For niche or corporate documents (annual reports, regulatory filings), try specific multi-word keywords like `"Cipla limited annual report filetype:pdf"`.

---

## How Search Works

Doc Harvester runs up to three strategies per file type, in order:

| Priority | Strategy | How |
|---|---|---|
| 1 | **Bing HTTP — `filetype:` query** | Direct HTTP request to Bing with `filetype:ext` operator. No browser, no cookies, no session personalization. Fast and unbiased. |
| 2 | **Bing HTTP — broad query** | Same Bing HTTP approach but with `keyword ext download` phrasing to surface pages that host files rather than direct file links. |
| 3 | **Google browser fallback** | Hidden Chromium window (anti-bot headers, no `webdriver` flag) browses Google Search. Used when Bing returns too few results for rare file types. |

If strategy 1 finds enough files to meet the quota for that type, strategies 2 and 3 are skipped entirely.

### Page scanning

When a search result URL does not itself end in the target extension (e.g. it's a `downloads.html` index page), the app fetches that page and scans its HTML for direct document links — catching files embedded in `href`, `src`, JavaScript strings, and `data-*` attributes.

### Download behaviour

- First attempt: standard headers + `Referer` set to the file's own domain, 90-second timeout.
- On `403`, `401`, connection reset (`ECONNRESET`), or timeout (`ECONNABORTED`): one automatic retry without the `Referer` header and with a 120-second timeout.
- Files that still fail after the retry (e.g. login-gated content) are marked **Failed** in the log. The app continues to the next file.

---

## Supported File Types

| Type | Extension | Notes |
|---|---|---|
| PDF | `.pdf` | Most widely indexed; highest success rate |
| Word (modern) | `.docx` | Office 2007+ format |
| Word (legacy) | `.doc` | Office 97–2003 format |
| Excel (modern) | `.xlsx` | Office 2007+ spreadsheets |
| Excel (legacy) | `.xls` | Office 97–2003 spreadsheets |
| PowerPoint (modern) | `.pptx` | Office 2007+ presentations |
| PowerPoint (legacy) | `.ppt` | Office 97–2003 presentations |

---

## Building a Standalone App

The packaging script uses [`@electron/packager`](https://github.com/electron/packager) and `adm-zip` — no Wine, no code-signing configuration required.

```bash
# Windows executable + zip (cross-compile from any OS)
npm run package:win

# macOS (x64 Intel + arm64 Apple Silicon)
npm run package:mac

# Linux AppImage + zip
npm run package:linux

# All platforms at once
npm run package
```

Output zips are written to `dist/releases/`:

```
dist/releases/
  DocHarvester-Windows-x64-v1.0.0.zip    (~150 MB)
  DocHarvester-macOS-x64-v1.0.0.zip
  DocHarvester-macOS-arm64-v1.0.0.zip
  DocHarvester-Linux-x64-v1.0.0.zip
```

Each zip is self-contained — just extract and run. No installation or Node.js required on the target machine.

### Windows

Extract the zip and double-click `Doc Harvester.exe`.  
Windows SmartScreen may show a warning for unsigned executables — click **More info → Run anyway**.

### macOS

Extract the zip and move `Doc Harvester.app` to `/Applications`.  
Gatekeeper may block an unsigned app on first launch — right-click the app → **Open** → **Open** to approve it once.

### Linux

Extract the zip and run `./Doc\ Harvester` from a terminal, or double-click it in your file manager.

---

## CI / Automated Builds

The repo includes a GitHub Actions workflow (`.github/workflows/build.yml`) that automatically builds for all three platforms whenever a version tag is pushed:

```bash
git tag v1.0.1
git push origin v1.0.1
```

Artifacts (zip, exe, dmg, AppImage) are attached to the GitHub Release automatically.

---

## Project Structure

```
doc-harvester/
├── main.js                  # Main process: search, scrape, download logic
├── preload.js               # Secure IPC bridge (contextBridge)
├── renderer/
│   ├── index.html           # App UI
│   ├── renderer.js          # UI event handling and progress display
│   └── styles.css           # Styles
├── scripts/
│   └── package-all.js       # Cross-platform packaging script
├── build/
│   └── icon.png             # App icon
└── .github/
    └── workflows/
        └── build.yml        # CI pipeline
```

---

## Known Limitations

- **Google CAPTCHA** — Google may challenge automated requests after several searches in quick succession. The app detects this, skips Google silently for that run, and the accumulated session cookies make subsequent runs more likely to succeed.
- **Login-gated files** — documents behind an institutional login (university portals, paid databases) will return 403 even after retry. These are marked Failed and skipped.
- **Search result count** — Bing typically returns 10 results per page across up to 5 pages (50 total URLs to scan per strategy). Niche queries with fewer than your requested download count may not fill the quota.
- **Rate limiting** — running many consecutive searches for the same keyword may trigger temporary Bing throttling. Waiting a minute and retrying resolves this.

---

## License

MIT — see [LICENSE](LICENSE) for details.
