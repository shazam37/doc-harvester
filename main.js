const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');

// Remove the automation flag that Google (and others) check for
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

let mainWindow;
let scraperWin = null;   // hidden browser used for Google searches
let isDownloading = false;
let shouldStop = false;

// ─── App bootstrap ───────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 780,
    minWidth: 760,
    minHeight: 620,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: 'Doc Harvester',
    backgroundColor: '#f1f5f9',
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function sendProgress(update) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress-update', update);
  }
}

// ─── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Download Folder',
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('open-folder', (_, folderPath) => shell.openPath(folderPath));

ipcMain.handle('stop-download', () => {
  shouldStop = true;
  closeScraperWin();
  return { success: true };
});

ipcMain.handle('start-download', async (_, { keyword, maxDownloads, outputDir, fileTypes }) => {
  if (isDownloading) return { success: false, message: 'A download is already in progress.' };
  if (!keyword || !keyword.trim()) return { success: false, message: 'Please enter a search keyword.' };
  if (!outputDir) return { success: false, message: 'Please select an output folder.' };

  if (!fs.existsSync(outputDir)) {
    try { fs.mkdirSync(outputDir, { recursive: true }); }
    catch (err) { return { success: false, message: `Cannot create output folder: ${err.message}` }; }
  }

  isDownloading = true;
  shouldStop = false;

  try {
    await runScraper({ keyword, maxDownloads, outputDir, fileTypes });
    return { success: true };
  } catch (err) {
    sendProgress({ type: 'error', message: err.message });
    return { success: false, message: err.message };
  } finally {
    isDownloading = false;
    closeScraperWin();
  }
});

function closeScraperWin() {
  if (scraperWin && !scraperWin.isDestroyed()) {
    scraperWin.destroy();
  }
  scraperWin = null;
}

// ─── Scraper (uses Electron's built-in Chromium) ─────────────────────────────

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function createScraperWindow() {
  // Isolated persistent session so cookies/UA don't bleed into the main window
  const scraperSession = session.fromPartition('persist:scraper');
  scraperSession.setUserAgent(UA);

  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      session: scraperSession,
    },
  });

  // Inject anti-detection overrides via CDP *before* any page JS runs
  try {
    win.webContents.debugger.attach('1.3');
    win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        if (!window.chrome) window.chrome = {};
        if (!window.chrome.runtime) window.chrome.runtime = {};
      `,
    });
  } catch (_) {}

  win.webContents.on('did-fail-load', () => {});
  win.webContents.setAudioMuted(true);

  return win;
}

// Load a URL and wait until the page is stable (DOM quiet for 800ms or 12s max).
// Never rejects — ERR_ABORTED (-3) is common on Windows when Bing redirects internally.
function loadAndWait(win, url) {
  return new Promise((resolve) => {
    if (shouldStop) return resolve();

    let settled = false;
    let quietTimer = null;

    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimeout);
      // Remove persistent listeners to prevent accumulation across page loads
      win.webContents.off('did-stop-loading', markQuiet);
      win.webContents.off('dom-ready', markQuiet);
      resolve();
    }

    const hardTimeout = setTimeout(settle, 12000);

    const markQuiet = () => {
      clearTimeout(quietTimer);
      quietTimer = setTimeout(settle, 800);
    };

    win.webContents.on('did-stop-loading', markQuiet);
    win.webContents.on('dom-ready', markQuiet);

    // ERR_ABORTED (-3) fires on Windows when the browser aborts a navigation mid-redirect;
    // the page usually still loads — wait 1.5 s then settle instead of failing.
    win.webContents.once('did-fail-load', (ev, code, desc) => {
      console.log(`[loadAndWait] did-fail-load ${code} ${desc}`);
      if (code === -3) setTimeout(settle, 1500);
      // Other codes: let the hard timeout handle it
    });

    win.loadURL(url).catch(err => {
      console.log('[loadAndWait] loadURL error (ignored):', err.message);
    });
  });
}

// Execute JS in the scraper window; returns the result
function exec(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

// Decode the actual URL from a Bing /ck/a? tracking redirect (no HTTP request needed).
function decodeBingUrl(bingCkUrl) {
  try {
    const uParam = new URL(bingCkUrl).searchParams.get('u');
    if (!uParam || !uParam.startsWith('a1')) return null;
    const b64 = uParam.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - b64.length % 4) % 4);
    return Buffer.from(padded, 'base64').toString('utf-8');
  } catch (_) { return null; }
}

// Search Bing via a plain HTTP request — no session cookies, no personalization.
async function searchBingHttp(query, start, count) {
  const axios = require('axios');
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}&first=${start}&count=${count}&setlang=en&form=QBLH`;

  const resp = await axios.get(searchUrl, {
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate',
      'Referer': 'https://www.bing.com/',
      'Upgrade-Insecure-Requests': '1',
    },
    timeout: 15000,
    maxRedirects: 5,
    validateStatus: s => s < 500,
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });

  const html = typeof resp.data === 'string' ? resp.data : '';
  const links = [];
  const seen = new Set();

  // Try /ck/a? relative and absolute forms, both quote styles
  const ckRe = /href=['"](?:https?:\/\/www\.bing\.com)?(\/ck\/a\?[^'"]+)['"]/g;
  let m;
  while ((m = ckRe.exec(html)) !== null) {
    const ckUrl = 'https://www.bing.com' + m[1].replace(/&amp;/g, '&');
    const decoded = decodeBingUrl(ckUrl);
    if (decoded && decoded.startsWith('http') && !seen.has(decoded)) {
      seen.add(decoded);
      links.push(decoded);
    }
  }

  const extPat = /\.(pdf|docx|doc|xlsx|xls|pptx|ppt)(\?|#|$)/i;
  const directRe = /href=['"]((https?:\/\/[^'"#]+))['"]/g;
  while ((m = directRe.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, '&');
    if (extPat.test(url) && !url.includes('bing.com') && !seen.has(url)) {
      seen.add(url);
      links.push(url);
    }
  }

  const hasNext = html.includes('"sb_pagN"') || html.includes('"Next page"');
  return { links, hasNext };
}

// Fetch an HTML page and return every URL that contains .<ext> anywhere
// (href, src, data-*, onclick, JS strings — catches them all).
async function scanPageForFiles(pageUrl, ext) {
  const axios = require('axios');
  try {
    const resp = await axios.get(pageUrl, {
      responseType: 'text',
      timeout: 12000,
      maxRedirects: 5,
      headers: { 'User-Agent': UA },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      validateStatus: s => s < 400,
    });
    const html = resp.data;
    const seen = new Set();
    const links = [];

    // Broad regex: any absolute URL that ends with .<ext>.
    // \b prevents .xls matching inside .xlsx, .doc inside .docx, .ppt inside .pptx, etc.
    // () included because some URLs contain parentheses (e.g. Wikipedia-style paths).
    const re = new RegExp(
      `https?://[\\w.\\-/%~+:@!$&,;=()]+\\.${ext}\\b(?:[?#][\\w.\\-/%~+:@!$&,;=?#()]*)?`,
      'gi'
    );
    let m;
    while ((m = re.exec(html)) !== null) {
      // Trim any trailing HTML artifacts that leaked into the match
      const url = m[0].replace(/&amp;/g, '&').replace(/[)"'>\]\\]+$/, '');
      if (!seen.has(url)) { seen.add(url); links.push(url); }
    }

    // Also match relative paths like /files/report.pdf
    const relRe = new RegExp(`["'](/[^"'<>\\s]+\\.${ext}\\b(?:[?#][^"'<>\\s]*)?)["']`, 'gi');
    while ((m = relRe.exec(html)) !== null) {
      try {
        const abs = new URL(m[1], pageUrl).href.replace(/&amp;/g, '&');
        if (!seen.has(abs)) { seen.add(abs); links.push(abs); }
      } catch (_) {}
    }

    console.log(`[scan] ${pageUrl} → ${links.length} .${ext} links`);
    return links;
  } catch (err) {
    console.log(`[scan] Failed for ${pageUrl}: ${err.message}`);
    return [];
  }
}

async function runScraper({ keyword, maxDownloads, outputDir, fileTypes }) {
  const extensions = fileTypes && fileTypes.length > 0
    ? fileTypes
    : ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'];

  sendProgress({ type: 'status', message: 'Opening search browser...' });
  scraperWin = createScraperWindow();

  const allUrls = new Set();
  let downloadedCount = 0;
  // Per-type download counters and quotas for fair distribution
  const downloadedByExt = Object.fromEntries(extensions.map(e => [e, 0]));
  // quotaByExt is updated before each phase; tryDownload enforces it
  const quotaByExt = Object.fromEntries(extensions.map(e => [e, maxDownloads]));

  async function tryDownload(fileUrl, ext) {
    if (allUrls.has(fileUrl) || downloadedCount >= maxDownloads || downloadedByExt[ext] >= quotaByExt[ext] || shouldStop) return;
    allUrls.add(fileUrl);
    sendProgress({ type: 'found', url: fileUrl });
    sendProgress({ type: 'downloading', url: fileUrl });
    try {
      const filename = await downloadFile(fileUrl, outputDir, ext);
      downloadedCount++;
      downloadedByExt[ext]++;
      sendProgress({ type: 'downloaded', url: fileUrl, filename, current: downloadedCount, total: maxDownloads });
    } catch (err) {
      sendProgress({ type: 'failed', url: fileUrl, message: err.message });
    }
  }

  // ── Search and download for a single file type ────────────────────────────────
  // Respects quotaByExt[ext] — caller sets this before invoking.
  async function scrapeForExt(ext) {
    const searchStrategies = [
      {
        label: `bing:filetype:${ext}`,
        engine: 'bing-http',
        pauseMs: 0,
        query: () => `${keyword} filetype:${ext}`,
      },
      {
        label: `bing:broad`,
        engine: 'bing-http',
        pauseMs: 2000,
        query: () => `${keyword} ${ext} download`,
      },
      {
        label: `google`,
        engine: 'google',
        pauseMs: 8000,
        url: (start) =>
          `https://www.google.com/search?q=${encodeURIComponent(`${keyword} filetype:${ext}`)}&num=10&start=${start - 1}&hl=en&gl=us`,
      },
    ];

    let captchaHit = false;

    for (const strategy of searchStrategies) {
      if (downloadedCount >= maxDownloads || downloadedByExt[ext] >= quotaByExt[ext] || shouldStop || captchaHit) break;

      if (strategy.pauseMs > 0) {
        await new Promise(r => setTimeout(r, strategy.pauseMs + Math.random() * 1000));
        if (shouldStop) break;
      }

      let searchStart = 1;
      let pageNum = 1;
      const MAX_PAGES = 5;
      const seenResultLinks = new Set();
      let fileLinksFoundThisStrategy = 0;

      sendProgress({ type: 'status', message: `Searching .${ext} (${strategy.label})...` });

      let strategyHandled = false;
      if (strategy.engine === 'bing-http') {
        strategyHandled = true;
        for (
          let bingPage = 1;
          bingPage <= MAX_PAGES && downloadedCount < maxDownloads && downloadedByExt[ext] < quotaByExt[ext] && !shouldStop;
          bingPage++
        ) {
          const bingStart = (bingPage - 1) * 10 + 1;
          let result;
          try {
            result = await searchBingHttp(strategy.query(), bingStart, 10);
          } catch (err) {
            console.error('[bing-http] Search error:', err.message);
            break;
          }
          const freshLinks = result.links.filter(l => !seenResultLinks.has(l));
          freshLinks.forEach(l => seenResultLinks.add(l));
          console.log(`[bing-http] Page ${bingPage}: ${result.links.length} total, ${freshLinks.length} fresh`);
          if (!freshLinks.length) break;
          sendProgress({ type: 'found-count', ext, count: freshLinks.length, page: bingPage });
          for (const resultLink of freshLinks) {
            if (downloadedCount >= maxDownloads || downloadedByExt[ext] >= quotaByExt[ext] || shouldStop) break;
            const lowerPath = (() => { try { return new URL(resultLink).pathname.toLowerCase(); } catch (_) { return ''; } })();
            if (lowerPath.endsWith('.' + ext)) {
              fileLinksFoundThisStrategy++;
              await tryDownload(resultLink, ext);
            } else {
              sendProgress({ type: 'status', message: `Scanning page for .${ext} links...` });
              const fileLinks = await scanPageForFiles(resultLink, ext);
              fileLinksFoundThisStrategy += fileLinks.length;
              console.log(`[scan] found ${fileLinks.length} .${ext} links on ${resultLink.substring(0, 60)}`);
              for (const fileUrl of fileLinks) {
                if (downloadedCount >= maxDownloads || downloadedByExt[ext] >= quotaByExt[ext] || shouldStop) break;
                await tryDownload(fileUrl, ext);
                await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
              }
            }
            await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
          }
          if (!result.hasNext) break;
          await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
        }
      }

      if (!strategyHandled) {
        // Google: visit the homepage first if we have no session cookies yet.
        // Without prior cookies Google immediately challenges an automated browser.
        if (strategy.engine === 'google') {
          const gCookies = await scraperWin.webContents.session.cookies.get({ domain: '.google.com' });
          if (!gCookies.some(c => c.name === 'NID' || c.name === 'AEC' || c.name === '1P_JAR')) {
            sendProgress({ type: 'status', message: 'Establishing Google session...' });
            await loadAndWait(scraperWin, 'https://www.google.com/');
            await exec(scraperWin, `
              (() => { const b = document.querySelector('#L2AGLb, #W0wltc, [aria-label="Accept all"]'); if (b) b.click(); })()
            `).catch(() => {});
            await new Promise(r => setTimeout(r, 3000 + Math.random() * 1000));
            if (shouldStop) break;
          }
        }

        while (
          downloadedCount < maxDownloads &&
          downloadedByExt[ext] < quotaByExt[ext] &&
          !shouldStop &&
          pageNum <= MAX_PAGES
        ) {
          const searchUrl = strategy.url(searchStart);
          console.log(`[${strategy.engine}] Loading:`, searchUrl);

          try {
            await loadAndWait(scraperWin, searchUrl);
            if (shouldStop) break;

            await exec(scraperWin, `
              (() => {
                const btn = document.querySelector('#bnp_btn_accept, .bnp_btn_accept, #L2AGLb, #W0wltc, [aria-label="Accept all"], [aria-label*="Accept"]');
                if (btn) btn.click();
              })()
            `).catch(() => {});

            const isCaptcha = await exec(scraperWin, `
              document.body.textContent.toLowerCase().includes('captcha') ||
              location.href.includes('/challenge') || location.href.includes('/sorry/') ||
              !!document.querySelector('#captcha, .captcha')
            `).catch(() => false);

            if (isCaptcha) {
              if (strategy.engine === 'google') {
                // Google challenged the request — skip silently; cookies accumulate for future runs
                console.log('[google] CAPTCHA — skipping this strategy silently');
              } else {
                sendProgress({ type: 'error', message: 'Bing blocked the request (CAPTCHA). Wait a minute and try again.' });
                captchaHit = true;
              }
              break;
            }

            const resultSel = strategy.engine === 'google' ? '#search h3, #rso h3' : '#b_results li.b_algo';
            const dbg = await exec(scraperWin, `({
              url: location.href,
              title: document.title,
              resultCount: document.querySelectorAll('${resultSel}').length
            })`).catch(() => ({}));
            console.log(`[${strategy.engine}] Page:`, dbg);

            let pageData;
            if (strategy.engine === 'google') {
              pageData = await exec(scraperWin, `
                (() => {
                  const links = [];
                  const seen = new Set();
                  document.querySelectorAll('#search h3, #rso h3').forEach(h3 => {
                    let a = h3.parentElement;
                    while (a && a.tagName !== 'A') a = a.parentElement;
                    const href = a && a.href;
                    if (href && href.startsWith('http') && !href.includes('google.com') && !seen.has(href)) {
                      seen.add(href);
                      links.push(href);
                    }
                  });
                  return { links, hasNext: !!document.querySelector('#pnnext') };
                })()
              `).catch(() => ({ links: [], hasNext: false }));
            } else {
              pageData = await exec(scraperWin, `
                (() => {
                  const sel = [
                    '#b_results li.b_algo h2 a',
                    '#b_results .b_algo h2 a',
                    '#b_results li.b_algo a[href]',
                  ];
                  let links = [];
                  for (const s of sel) {
                    links = Array.from(document.querySelectorAll(s))
                      .map(a => a.href)
                      .filter(h => h && h.startsWith('http'));
                    if (links.length) break;
                  }
                  const nextEl = document.querySelector('.sb_pagN, a[aria-label="Next page"], a[title="Next page"]');
                  return { links, hasNext: !!nextEl };
                })()
              `).catch(() => ({ links: [], hasNext: false }));
            }

            console.log(`[${strategy.engine}] Links extracted:`, pageData.links.length, pageData.links.slice(0, 3));

            if (!pageData.links.length) {
              sendProgress({ type: 'status', message: `No results on page ${pageNum} (${strategy.label}).` });
              break;
            }

            const freshLinks = pageData.links.filter(l => !seenResultLinks.has(l));
            if (freshLinks.length === 0) {
              console.log(`[${strategy.engine}] All links are duplicates — stopping this strategy`);
              break;
            }
            pageData.links.forEach(l => seenResultLinks.add(l));

            sendProgress({ type: 'found-count', ext, count: freshLinks.length, page: pageNum });

            for (const resultLink of freshLinks) {
              if (downloadedCount >= maxDownloads || downloadedByExt[ext] >= quotaByExt[ext] || shouldStop) break;

              try {
                const actualUrl = strategy.engine === 'bing' ? (decodeBingUrl(resultLink) ?? resultLink) : resultLink;
                console.log(`[${strategy.engine}] Resolved:`, actualUrl.substring(0, 100));

                const lowerPath = (() => {
                  try { return new URL(actualUrl).pathname.toLowerCase(); } catch (_) { return ''; }
                })();

                if (lowerPath.endsWith('.' + ext)) {
                  fileLinksFoundThisStrategy++;
                  await tryDownload(actualUrl, ext);
                } else {
                  sendProgress({ type: 'status', message: `Scanning page for .${ext} links...` });
                  const fileLinks = await scanPageForFiles(actualUrl, ext);
                  fileLinksFoundThisStrategy += fileLinks.length;
                  console.log(`[scan] found ${fileLinks.length} .${ext} links on ${actualUrl.substring(0, 60)}`);
                  for (const fileUrl of fileLinks) {
                    if (downloadedCount >= maxDownloads || downloadedByExt[ext] >= quotaByExt[ext] || shouldStop) break;
                    await tryDownload(fileUrl, ext);
                    await new Promise(r => setTimeout(r, 300 + Math.random() * 300));
                  }
                }
              } catch (err) {
                console.error(`[${strategy.engine}] Result error:`, err.message);
                if (shouldStop) break;
              }

              await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
            }

            if (!pageData.hasNext) break;
            searchStart += 10;
            pageNum++;
            await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));

          } catch (err) {
            console.error('[runScraper] Error:', err.message);
            if (shouldStop) break;
            sendProgress({ type: 'error', message: `Search error: ${err.message}` });
            break;
          }
        }
      } // end if (!strategyHandled)

      if (fileLinksFoundThisStrategy > 0) {
        console.log(`[strategy] Found ${fileLinksFoundThisStrategy} file links via ${strategy.label} — skipping remaining strategies`);
        break;
      } else {
        console.log(`[strategy] ${strategy.label} found 0 file links — trying next strategy`);
      }
    }
  }
  // ── Two-phase download loop ───────────────────────────────────────────────────
  //
  // Phase 1 — fair base quota: each selected type gets floor(maxDownloads/numTypes)
  //   slots so no single type can monopolise the result (e.g. PDF filling all 10
  //   before DOCX ever runs).
  //
  // Phase 2 — spill: any slots not consumed in phase 1 are redistributed evenly
  //   across all types.  The most prevalent type naturally fills more of the spill
  //   (prevalence-based distribution) while rare types get a fair second attempt.
  //
  // allUrls deduplication means re-running a type in phase 2 never re-downloads
  // a file that was already saved in phase 1.
  // ─────────────────────────────────────────────────────────────────────────────
  try {
    const numTypes = extensions.length;
    // floor so the sum of base quotas never exceeds maxDownloads
    const baseQuota = Math.max(1, Math.floor(maxDownloads / numTypes));

    // ── Phase 1: equal share ──────────────────────────────────────────────────
    extensions.forEach(e => { quotaByExt[e] = baseQuota; });
    console.log(`[quota] Phase 1 — ${numTypes} type(s), ${baseQuota} slot(s) each (total budget: ${maxDownloads})`);

    for (const ext of extensions) {
      if (downloadedCount >= maxDownloads || shouldStop) break;
      sendProgress({ type: 'status', message: `[${ext.toUpperCase()}] Searching (quota: ${baseQuota})...` });
      await scrapeForExt(ext);
      console.log(`[quota] ${ext}: downloaded ${downloadedByExt[ext]} / ${baseQuota} in phase 1`);
    }

    // ── Phase 2: fill remaining slots ─────────────────────────────────────────
    const remaining = maxDownloads - downloadedCount;
    if (remaining > 0 && !shouldStop) {
      console.log(`[quota] Phase 2 — ${remaining} slot(s) remaining, distributing across ${numTypes} type(s)`);
      sendProgress({ type: 'status', message: `Filling ${remaining} remaining slot(s)...` });

      for (const ext of extensions) {
        if (downloadedCount >= maxDownloads || shouldStop) break;
        // Give this type however many slots are still open (first type that has
        // results will claim them; subsequent types get what's left).
        quotaByExt[ext] = downloadedByExt[ext] + (maxDownloads - downloadedCount);
        console.log(`[quota] Phase 2 ${ext}: new quota ${quotaByExt[ext]} (already has ${downloadedByExt[ext]})`);
        await scrapeForExt(ext);
      }
    }
  } finally {
    closeScraperWin();
  }

  if (shouldStop) {
    sendProgress({ type: 'stopped', downloaded: downloadedCount });
  } else {
    sendProgress({ type: 'complete', downloaded: downloadedCount, found: allUrls.size });
  }
}

// ─── File downloader ──────────────────────────────────────────────────────────

async function downloadFile(url, outputDir, extHint) {
  const axios = require('axios');

  let filename;
  try {
    filename = decodeURIComponent(path.basename(new URL(url).pathname));
    if (!filename) throw new Error('empty');
  } catch (_) {
    const extMatch = url.toLowerCase().match(/\.(pdf|docx|doc|xlsx|xls|pptx|ppt)/i);
    filename = `document_${Date.now()}${extMatch ? extMatch[0] : (extHint ? '.' + extHint : '')}`;
  }
  filename = sanitizeFilename(filename);
  // If URL path gave us no extension, append the hint (e.g. URL ends in a hash/ID)
  if (extHint && !path.extname(filename)) filename += '.' + extHint;

  const origin = (() => { try { return new URL(url).origin; } catch (_) { return ''; } })();

  const doRequest = (withReferer, timeout) => axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout,
    maxRedirects: 10,
    headers: {
      'User-Agent': UA,
      'Accept': 'application/octet-stream,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.*,application/vnd.ms-*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
      'Cache-Control': 'no-cache',
      ...(withReferer && origin ? { 'Referer': origin + '/' } : {}),
    },
    httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  });

  let response;
  try {
    response = await doRequest(true, 90000);
  } catch (err) {
    const status = err.response?.status;
    // Retry once: on 403/401 try without Referer; on timeout/reset try with more time
    if (status === 403 || status === 401 || err.code === 'ECONNABORTED' || err.code === 'ECONNRESET') {
      response = await doRequest(false, 120000);
    } else {
      throw err;
    }
  }

  const contentType = (response.headers['content-type'] || '').toLowerCase();
  if (contentType.startsWith('text/html')) {
    response.data.destroy();
    throw new Error('Server returned an HTML page (likely a 404 or blocked)');
  }

  // Use Content-Disposition filename if provided
  const cd = response.headers['content-disposition'];
  if (cd) {
    const m = cd.match(/filename\*?=(?:UTF-8'')?([^;\n\r"]+|"[^"]*")/i);
    if (m) {
      let cdName = m[1].replace(/^"|"$/g, '').trim();
      try { cdName = decodeURIComponent(cdName); } catch (_) {}
      cdName = sanitizeFilename(cdName);
      if (cdName) filename = cdName;
    }
  }

  // Avoid clobbering existing files
  let outputPath = path.join(outputDir, filename);
  if (fs.existsSync(outputPath)) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    let i = 1;
    while (fs.existsSync(outputPath)) {
      outputPath = path.join(outputDir, `${base}_(${i++})${ext}`);
    }
    filename = path.basename(outputPath);
  }

  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
    response.data.on('error', reject);
  });

  return path.basename(outputPath);
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/_{2,}/g, '_')
    .substring(0, 200)
    .trim() || `document_${Date.now()}`;
}
