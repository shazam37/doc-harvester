document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);

  const keywordInput   = $('keyword');
  const maxInput       = $('maxDownloads');
  const outputDirInput = $('outputDir');
  const browseBtn      = $('browseBtn');
  const startBtn       = $('startBtn');
  const stopBtn        = $('stopBtn');
  const openFolderBtn  = $('openFolderBtn');
  const clearBtn       = $('clearBtn');
  const progressBar    = $('progressBar');
  const progressCount  = $('progressCount');
  const statusText     = $('statusText');
  const resultsList    = $('resultsList');

  let outputDir = null;
  let maxDownloads = 10;
  let cleanupProgress = null;

  // ── Directory picker ──────────────────────────────
  browseBtn.addEventListener('click', async () => {
    const dir = await window.electronAPI.selectDirectory();
    if (dir) {
      outputDir = dir;
      outputDirInput.value = dir;
      openFolderBtn.disabled = false;
    }
  });

  openFolderBtn.addEventListener('click', () => {
    if (outputDir) window.electronAPI.openFolder(outputDir);
  });

  clearBtn.addEventListener('click', resetResults);

  // ── File type helpers ─────────────────────────────
  function getSelectedTypes() {
    return Array.from(document.querySelectorAll('#fileTypeGroup input[type="checkbox"]:checked'))
      .map(cb => cb.value);
  }

  // ── Start ─────────────────────────────────────────
  startBtn.addEventListener('click', async () => {
    const keyword = keywordInput.value.trim();
    if (!keyword) { return setStatus('Please enter a search keyword.', 'error'); }
    if (!outputDir) { return setStatus('Please select an output folder.', 'error'); }

    const fileTypes = getSelectedTypes();
    if (fileTypes.length === 0) { return setStatus('Please select at least one file type.', 'error'); }

    maxDownloads = Math.min(Math.max(parseInt(maxInput.value) || 10, 1), 100);
    maxInput.value = maxDownloads;

    resetResults();
    updateProgress(0, maxDownloads);
    setStatus('Starting...');
    setRunning(true);

    if (cleanupProgress) cleanupProgress();
    cleanupProgress = window.electronAPI.onProgress(handleProgress);

    const result = await window.electronAPI.startDownload({ keyword, maxDownloads, outputDir, fileTypes });

    setRunning(false);
    if (!result.success) setStatus(result.message, 'error');
  });

  // ── Stop ──────────────────────────────────────────
  stopBtn.addEventListener('click', async () => {
    stopBtn.disabled = true;
    setStatus('Stopping...', 'warning');
    await window.electronAPI.stopDownload();
  });

  // ── Progress handler ──────────────────────────────
  function handleProgress(data) {
    switch (data.type) {
      case 'status':
        setStatus(data.message);
        break;

      case 'found-count':
        setStatus(`Found ${data.count} .${data.ext} file(s) on search page ${data.page}`);
        break;

      case 'found':
        appendItem({ id: data.url, icon: 'info', name: filenameFromUrl(data.url), meta: 'Located' });
        break;

      case 'downloading':
        updateItem(data.url, { icon: 'loading', meta: 'Downloading...' });
        setStatus(`Downloading: ${filenameFromUrl(data.url)}`);
        break;

      case 'downloaded':
        updateProgress(data.current, data.total);
        updateItem(data.url, { icon: 'success', name: data.filename, meta: 'Saved' });
        break;

      case 'failed':
        updateItem(data.url, { icon: 'error', meta: `Failed: ${truncate(data.message, 50)}` });
        break;

      case 'error':
        setStatus(data.message, 'error');
        appendItem({ id: null, icon: 'error', name: data.message, meta: 'Error' });
        break;

      case 'stopped':
        setStatus(`Stopped. Downloaded ${data.downloaded} file(s).`, 'warning');
        break;

      case 'complete': {
        const pct = data.found > 0 ? Math.round((data.downloaded / data.found) * 100) : 100;
        updateProgress(data.downloaded, maxDownloads);
        setStatus(
          data.downloaded > 0
            ? `Done! Downloaded ${data.downloaded} file(s) from ${data.found} URL(s) found.`
            : 'Search complete — no matching files found. Try different keywords or file types.',
          data.downloaded > 0 ? 'success' : 'warning'
        );
        break;
      }
    }
  }

  // ── UI helpers ────────────────────────────────────
  function setRunning(running) {
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    browseBtn.disabled = running;
    Array.from(document.querySelectorAll('#fileTypeGroup input')).forEach(cb => cb.disabled = running);
    keywordInput.disabled = running;
    maxInput.disabled = running;
  }

  function resetResults() {
    resultsList.innerHTML = '<div class="results-empty">No results yet. Configure settings above and click Start Download.</div>';
    progressBar.style.width = '0%';
    progressCount.textContent = '0 / 0';
    setStatus('Ready to start');
  }

  function updateProgress(current, total) {
    const pct = total > 0 ? Math.min((current / total) * 100, 100) : 0;
    progressBar.style.width = `${pct}%`;
    progressCount.textContent = `${current} / ${total}`;
  }

  function setStatus(msg, type = '') {
    statusText.textContent = msg;
    statusText.className = 'status-text' + (type ? ` ${type}` : '');
  }

  function appendItem({ id, icon, name, meta }) {
    const empty = resultsList.querySelector('.results-empty');
    if (empty) empty.remove();

    const el = document.createElement('div');
    el.className = 'result-item';
    if (id) el.dataset.id = id;
    el.innerHTML = `
      <div class="result-icon ${icon}">${iconSVG(icon)}</div>
      <span class="result-name" title="${esc(name)}">${esc(name)}</span>
      <span class="result-meta" title="${esc(meta)}">${esc(meta)}</span>
    `;
    resultsList.appendChild(el);
    resultsList.scrollTop = resultsList.scrollHeight;
  }

  function updateItem(id, { icon, name, meta }) {
    const el = findItem(id);
    if (!el) return;

    if (icon !== undefined) {
      const iconEl = el.querySelector('.result-icon');
      iconEl.className = `result-icon ${icon}`;
      iconEl.innerHTML = iconSVG(icon);
    }
    if (name !== undefined) {
      const nameEl = el.querySelector('.result-name');
      nameEl.textContent = name;
      nameEl.title = name;
    }
    if (meta !== undefined) {
      const metaEl = el.querySelector('.result-meta');
      metaEl.textContent = meta;
      metaEl.title = meta;
    }
  }

  function findItem(id) {
    for (const el of resultsList.querySelectorAll('.result-item[data-id]')) {
      if (el.dataset.id === id) return el;
    }
    return null;
  }

  // ── Icon SVG fragments ────────────────────────────
  function iconSVG(type) {
    switch (type) {
      case 'success': return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
      case 'error':   return `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      case 'loading': return `<svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
      default:        return `<svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor"><circle cx="4" cy="4" r="3"/></svg>`;
    }
  }

  // ── Utilities ─────────────────────────────────────
  function filenameFromUrl(url) {
    try {
      const p = new URL(url).pathname;
      const name = decodeURIComponent(p.split('/').pop());
      return name || url.substring(0, 60);
    } catch (_) {
      return url.substring(0, 60);
    }
  }

  function truncate(str, len) {
    return str && str.length > len ? str.substring(0, len) + '…' : str;
  }

  function esc(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
});
