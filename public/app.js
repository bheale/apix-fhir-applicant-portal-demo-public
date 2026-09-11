/* =============================================================
   FHIR APPS — Shared Client JS  (Submitter + Regulatory)
   v2 — Live-fetch JSON viewer with retry polling
   ============================================================= */

/* ── Status Badge ───────────────────────────────────────────── */
function getStatusBadgeClass(status) {
  if (!status) return 'badge-neutral';
  const s = status.toLowerCase();
  if (['completed'].includes(s))                        return 'badge-success';
  if (['in-progress', 'accepted'].includes(s))          return 'badge-warning';
  if (['failed', 'rejected'].includes(s))               return 'badge-danger';
  if (['requested', 'received', 'draft'].includes(s))   return 'badge-info';
  return 'badge-neutral';
}

function renderStatusBadge(status) {
  return `<span class="badge ${getStatusBadgeClass(status)}">${status || '—'}</span>`;
}

/* ── JSON Syntax Highlighter ────────────────────────────────── */
function highlightJson(str) {
  if (window.hljs) return hljs.highlight(str, { language: 'json' }).value;
  return str
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"([^"]+)":/g,        '<span class="hljs-attr">"$1"</span>:')
    .replace(/: "([^"]*?)"/g,      ': <span class="hljs-string">"$1"</span>')
    .replace(/: (-?\d+(\.\d+)?)/g, ': <span class="hljs-number">$1</span>')
    .replace(/: (true|false)/g,    ': <span class="hljs-literal">$1</span>')
    .replace(/: null/g,            ': <span class="hljs-literal">null</span>');
}

/* ── JSON Viewer HTML builder ───────────────────────────────── */
function buildJsonViewer(data, label) {
  label = label || 'JSON';
  const str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const highlighted = highlightJson(str);
  return `
    <div class="json-viewer-container">
      <div class="json-viewer-toolbar">
        <span class="json-viewer-lang">json · ${label}</span>
        <button class="json-viewer-copy" onclick="copyJsonBlock(this)">
          <i class="ph ph-copy"></i> Copy
        </button>
      </div>
      <div class="json-viewer-body">
        <pre><code class="hljs language-json">${highlighted}</code></pre>
      </div>
    </div>`;
}

/* ── Copy to Clipboard ──────────────────────────────────────── */
function copyJsonBlock(btn) {
  const pre = btn.closest('.json-viewer-container').querySelector('pre');
  navigator.clipboard.writeText(pre.innerText || pre.textContent).then(function () {
    btn.textContent = '✓ Copied';
    setTimeout(function () { btn.innerHTML = '<i class="ph ph-copy"></i> Copy'; }, 1800);
  });
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(function () { showToast('Copied to clipboard'); });
}

/* ── Toast ──────────────────────────────────────────────────── */
function showToast(message, type) {
  var toast = document.createElement('div');
  var bg = (type === 'success') ? 'var(--color-success, #1a9e5a)' : 'var(--color-primary, #0e6ecc)';
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'right:24px', 'z-index:9999',
    'background:' + bg, 'color:white', 'padding:10px 18px',
    'border-radius:var(--radius-md,8px)', 'font-size:0.85rem', 'font-weight:600',
    'box-shadow:0 4px 16px rgba(0,0,0,0.2)', 'transform:translateY(20px)', 'opacity:0',
    'transition:all 0.22s ease', 'font-family:var(--font-sans,sans-serif)',
    'pointer-events:none', 'max-width:320px', 'line-height:1.4'
  ].join(';');
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(function () {
    toast.style.transform = 'translateY(0)';
    toast.style.opacity = '1';
  });
  setTimeout(function () {
    toast.style.transform = 'translateY(20px)';
    toast.style.opacity = '0';
    setTimeout(function () { toast.remove(); }, 300);
  }, 3000);
}

/* ══════════════════════════════════════════════════════════════
   LIVE-FETCH JSON MODAL
   ══════════════════════════════════════════════════════════════

   openJsonModal(data, title, options)
   ─────────────────────────────────────────────────────────────
   data    : object|string  — baked-in (server-rendered) snapshot.
             Shown immediately as a stale preview while a fresh
             fetch is in progress.  Pass null to skip preview.
   title   : string         — modal title / resource label.
   options : object (all optional)
     {
       fetchUrl  : string   — absolute URL to GET fresh JSON from.
                             If provided, a live fetch is triggered
                             immediately on open.  If the fetch
                             succeeds the viewer is updated in-place.
       resourceType : string — e.g. 'Task'. Used in UI labels.
       retries   : number   — max retry attempts (default 4).
       retryMs   : number   — base interval ms (default 1500).
                             Uses linear back-off: attempt × retryMs.
       onFresh   : function — called with the fresh resource when
                             fetch succeeds.  Optional hook.
     }

   Calling patterns:
   ─────────────────
   // 1. Fully static — no fetch, just show baked JSON (legacy compat)
   openJsonModal(myObj, 'Task JSON');

   // 2. Live-fetch — show stale immediately, fetch fresh in background
   openJsonModal(staledData, 'Task JSON', {
     fetchUrl: 'https://fhir.example.org/fhir/Task/123'
   });

   // 3. Fetch-only — nothing baked in, show spinner then result
   openJsonModal(null, 'Task JSON', {
     fetchUrl: 'https://fhir.example.org/fhir/Task/123'
   });
   ══════════════════════════════════════════════════════════════ */

/* internal state */
var _modalFetchController = null;   // AbortController for in-flight fetch
var _modalRetryTimer      = null;   // retry setTimeout handle

function openJsonModal(data, title, options) {
  options = options || {};

  var overlay  = document.getElementById('jsonModalOverlay');
  var titleEl  = document.getElementById('jsonModalTitle');
  var body     = document.getElementById('jsonModalContent');
  var freshBtn = document.getElementById('jsonModalRefreshBtn');
  if (!overlay) return;

  /* ── Abort any previous in-flight fetch / retry ── */
  _cancelModalFetch();

  /* ── Set title ── */
  titleEl.textContent = title || 'FHIR Resource JSON';

  /* ── Open overlay immediately ── */
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';

  var fetchUrl     = options.fetchUrl     || null;
  var maxRetries   = (options.retries     !== undefined) ? options.retries   : 4;
  var baseRetryMs  = (options.retryMs     !== undefined) ? options.retryMs   : 1500;
  var resourceType = options.resourceType || _guessResourceType(fetchUrl, title);

  /* ── Show refresh button if a URL is available ── */
  if (freshBtn) {
    if (fetchUrl) {
      freshBtn.style.display = 'inline-flex';
      freshBtn.onclick = function () {
        _fetchAndShow(body, fetchUrl, title, resourceType, 0, maxRetries, baseRetryMs, options.onFresh, /*manual*/true);
      };
    } else {
      freshBtn.style.display = 'none';
    }
  }

  /* ── Case A: no fetch URL — show baked data immediately ── */
  if (!fetchUrl) {
    if (data !== null && data !== undefined) {
      body.innerHTML = buildJsonViewer(data, title || 'FHIR Resource');
      _hljs(body);
    } else {
      body.innerHTML = _noDataHtml(title);
    }
    return;
  }

  /* ── Case B: fetch URL available ── */

  // Show baked preview instantly so the user is never staring at blank
  if (data !== null && data !== undefined) {
    body.innerHTML = _stalePreviewHtml(data, title, resourceType);
    _hljs(body);
  } else {
    // Nothing baked — show a full loading state
    body.innerHTML = _loadingHtml(resourceType, fetchUrl, 0, maxRetries);
  }

  // Start live fetch in background
  _fetchAndShow(body, fetchUrl, title, resourceType, 0, maxRetries, baseRetryMs, options.onFresh, false);
}

/* ── Cancel any running fetch/retry ────────────────────────── */
function _cancelModalFetch() {
  if (_modalFetchController) {
    try { _modalFetchController.abort(); } catch(e) {}
    _modalFetchController = null;
  }
  if (_modalRetryTimer) {
    clearTimeout(_modalRetryTimer);
    _modalRetryTimer = null;
  }
}

/* ── Core fetch-and-show with retry ────────────────────────── */
function _fetchAndShow(body, url, title, resourceType, attempt, maxRetries, baseRetryMs, onFresh, isManual) {

  // Abort signal so we can cancel if modal is closed mid-flight
  _modalFetchController = new AbortController();
  var signal = _modalFetchController.signal;

  // Update the status banner if one exists
  _updateStatusBanner(body, 'fetching', attempt, maxRetries, url);

  var proxyUrl = '/fhir-proxy?url=' + encodeURIComponent(url);
  fetch(proxyUrl, {
    signal: signal,
    headers: { 'Accept': 'application/fhir+json, application/json' },
    cache: 'no-store'   // always bypass browser cache for freshness
  })
  .then(function (res) {
    if (!res.ok) {
      throw { status: res.status, statusText: res.statusText };
    }
    return res.json();
  })
  .then(function (freshResource) {
    _modalFetchController = null;

    // Validate — must look like a FHIR resource (has resourceType)
    if (!freshResource || typeof freshResource !== 'object') {
      throw { status: 0, statusText: 'Response was not valid JSON' };
    }
    if (!freshResource.resourceType && !freshResource.entry) {
      // Might be an OperationOutcome or other non-resource — still show it
    }

    // Check for OperationOutcome (FHIR error response)
    if (freshResource.resourceType === 'OperationOutcome') {
      var severity = freshResource.issue?.[0]?.severity;
      if (severity === 'error' || severity === 'fatal') {
        throw { status: 0, statusText: 'FHIR OperationOutcome error', outcome: freshResource };
      }
    }

    // SUCCESS — replace content with fresh viewer
    body.innerHTML = _freshViewerHtml(freshResource, title, url, isManual);
    _hljs(body);

    // Instrument reference links
    if (window.FhirRefResolver) window.FhirRefResolver.instrument();

    // Fire optional hook
    if (typeof onFresh === 'function') onFresh(freshResource);
  })
  .catch(function (err) {
    if (err && err.name === 'AbortError') return; // intentional cancel

    var status = err.status || 0;
    var canRetry = attempt < maxRetries;
    var isNotFound = (status === 404 || status === 410);
    var isServerError = (status >= 500 || status === 0);
    var isProcessing = isNotFound || isServerError;

    // Show retry UI while the modal is still open
    if (!document.getElementById('jsonModalOverlay')?.classList.contains('open')) return;

    // 403 = SSRF guard or session mismatch — keep stale preview rather than showing error
    if (status === 403 && !isManual) {
      var sb = body.querySelector('#fhir-status-banner');
      if (sb) {
        sb.className = 'fhir-fetch-banner fhir-fetch-banner--error';
        sb.innerHTML = '<span class="fhir-fetch-status-text">⚠ Showing cached data — live refresh unavailable</span>';
      }
      return;
    }

    if (canRetry && isProcessing) {
      // Exponential-ish backoff: 1.5s, 3s, 4.5s, 6s
      var delay = baseRetryMs * (attempt + 1);
      body.innerHTML = _retryingHtml(attempt + 1, maxRetries, delay, url, resourceType, err);

      // Start countdown display
      _startCountdown(body, delay);

      _modalRetryTimer = setTimeout(function () {
        if (!document.getElementById('jsonModalOverlay')?.classList.contains('open')) return;
        _fetchAndShow(body, url, title, resourceType, attempt + 1, maxRetries, baseRetryMs, onFresh, isManual);
      }, delay);

    } else {
      // Exhausted retries or permanent error
      body.innerHTML = _errorHtml(err, url, title, attempt, maxRetries, attempt >= maxRetries);
    }
  });
}

/* ── HTML builders for each modal state ────────────────────── */

function _stalePreviewHtml(data, title, resourceType) {
  var str = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  var highlighted = highlightJson(str);
  return `
    <div id="fhir-status-banner" class="fhir-fetch-banner fhir-fetch-banner--fetching">
      <span class="fhir-fetch-spinner" aria-hidden="true"></span>
      <span class="fhir-fetch-status-text">Fetching latest version from FHIR server…</span>
    </div>
    <div class="json-viewer-container" style="border-radius:0; border-top:none; opacity:0.72;">
      <div class="json-viewer-toolbar">
        <span class="json-viewer-lang">json · ${_esc(title)} <span class="fhir-stale-tag">cached</span></span>
        <button class="json-viewer-copy" onclick="copyJsonBlock(this)"><i class="ph ph-copy"></i> Copy</button>
      </div>
      <div class="json-viewer-body">
        <pre><code class="hljs language-json">${highlighted}</code></pre>
      </div>
    </div>`;
}

function _loadingHtml(resourceType, url, attempt, maxRetries) {
  return `
    <div id="fhir-status-banner" class="fhir-fetch-banner fhir-fetch-banner--fetching" style="border-radius:0;">
      <span class="fhir-fetch-spinner" aria-hidden="true"></span>
      <div class="fhir-fetch-banner-text">
        <span class="fhir-fetch-status-text">Fetching ${_esc(resourceType)} from FHIR server…</span>
        <span class="fhir-fetch-url">${_esc(url)}</span>
      </div>
    </div>
    <div style="padding:var(--space-8,32px); text-align:center; color:var(--color-text-muted);">
      <div style="font-size:0.85rem; margin-top:var(--space-4,16px); font-family:var(--font-mono,monospace); color:var(--color-text-light);">
        Attempt ${attempt + 1} of ${maxRetries + 1}
      </div>
    </div>`;
}

function _retryingHtml(nextAttempt, maxRetries, delayMs, url, resourceType, err) {
  var statusMsg = err && err.status === 404
    ? 'Resource not yet available on FHIR server (404)'
    : err && err.status >= 500
    ? `FHIR server error (${err.status})`
    : err && err.outcome
    ? 'FHIR server returned an OperationOutcome'
    : 'Could not reach FHIR server';

  return `
    <div id="fhir-status-banner" class="fhir-fetch-banner fhir-fetch-banner--retrying">
      <i class="ph ph-clock-countdown" style="font-size:1rem; flex-shrink:0;"></i>
      <div class="fhir-fetch-banner-text">
        <span class="fhir-fetch-status-text">${_esc(statusMsg)} — retrying in <span id="fhir-countdown">${Math.round(delayMs/1000)}</span>s (attempt ${nextAttempt} of ${maxRetries + 1})</span>
        <span class="fhir-fetch-url">${_esc(url)}</span>
      </div>
      <button class="fhir-fetch-cancel-btn" onclick="_cancelModalFetch(); document.getElementById('fhir-status-banner').innerHTML='<em style=\\'font-size:0.82rem; padding:4px;\\'>Cancelled.</em>'">
        Cancel
      </button>
    </div>
    <div style="padding:var(--space-6,24px) var(--space-5,20px);">
      <div class="alert alert-warning" style="margin:0; font-size:0.82rem;">
        <i class="ph ph-warning"></i>
        <div>
          <strong>FHIR server is still preparing this resource.</strong><br>
          This is normal — the server may need a moment to index the newly created resource.
          The view will update automatically.
        </div>
      </div>
    </div>`;
}

function _freshViewerHtml(resource, title, url, isManual) {
  var str = JSON.stringify(resource, null, 2);
  var highlighted = highlightJson(str);
  var ts = new Date().toLocaleTimeString();
  var freshLabel = isManual ? 'manually refreshed' : 'live';
  return `
    <div id="fhir-status-banner" class="fhir-fetch-banner fhir-fetch-banner--fresh">
      <i class="ph ph-check-circle" style="font-size:1rem; flex-shrink:0;"></i>
      <div class="fhir-fetch-banner-text">
        <span class="fhir-fetch-status-text">Live data from FHIR server · fetched at ${_esc(ts)}</span>
        <span class="fhir-fetch-url">${_esc(url)}</span>
      </div>
    </div>
    <div class="json-viewer-container" style="border-radius:0; border-top:none;">
      <div class="json-viewer-toolbar">
        <span class="json-viewer-lang">json · ${_esc(title)} <span class="fhir-fresh-tag">${freshLabel}</span></span>
        <button class="json-viewer-copy" onclick="copyJsonBlock(this)"><i class="ph ph-copy"></i> Copy</button>
      </div>
      <div class="json-viewer-body">
        <pre><code class="hljs language-json">${highlighted}</code></pre>
      </div>
    </div>`;
}

function _errorHtml(err, url, title, attempts, maxRetries, exhausted) {
  var status = err && err.status ? err.status : '—';
  var msg = err && err.statusText ? err.statusText : (err && err.message) ? err.message : 'Unknown error';
  var heading = exhausted
    ? `Could not load fresh JSON after ${attempts + 1} attempts`
    : `Failed to fetch from FHIR server`;
  return `
    <div id="fhir-status-banner" class="fhir-fetch-banner fhir-fetch-banner--error">
      <i class="ph ph-warning-circle" style="font-size:1rem; flex-shrink:0;"></i>
      <div class="fhir-fetch-banner-text">
        <span class="fhir-fetch-status-text">${_esc(heading)}</span>
        <span class="fhir-fetch-url">${_esc(url)}</span>
      </div>
    </div>
    <div style="padding:var(--space-5,20px);">
      <div class="alert alert-danger" style="margin:0 0 var(--space-4,16px); font-size:0.82rem;">
        <i class="ph ph-warning-circle"></i>
        <div>
          <strong>HTTP ${_esc(String(status))} — ${_esc(msg)}</strong><br>
          ${exhausted
            ? 'The FHIR server did not respond in time. It may still be processing — please close and try again in a moment.'
            : 'The FHIR server returned an error. Check the URL and server status.'}
        </div>
      </div>
      ${err && err.outcome ? `
      <details style="margin-top:var(--space-3,12px);">
        <summary>OperationOutcome details</summary>
        <div class="json-viewer-container" style="margin-top:var(--space-2,8px);">
          <div class="json-viewer-toolbar"><span class="json-viewer-lang">json · OperationOutcome</span></div>
          <div class="json-viewer-body"><pre><code class="hljs language-json">${highlightJson(JSON.stringify(err.outcome, null, 2))}</code></pre></div>
        </div>
      </details>` : ''}
      <div style="display:flex; gap:var(--space-3,12px); margin-top:var(--space-4,16px);">
        <button class="btn btn-primary btn-sm" onclick="
          var overlay = document.getElementById('jsonModalOverlay');
          var body    = document.getElementById('jsonModalContent');
          _fetchAndShow(body, '${_esc(url)}', '${_esc(title)}', '', 0, ${maxRetries}, 1500, null, true);
        ">
          <i class="ph ph-arrow-clockwise"></i> Retry now
        </button>
        <button class="btn btn-ghost btn-sm" onclick="closeJsonModal()">
          Close
        </button>
      </div>
    </div>`;
}

function _noDataHtml(title) {
  return `
    <div style="padding:var(--space-8,32px); text-align:center; color:var(--color-text-muted);">
      <i class="ph ph-file-x" style="font-size:2rem; display:block; margin-bottom:var(--space-3,12px);"></i>
      <div style="font-size:0.9rem;">No data available for <strong>${_esc(title)}</strong></div>
    </div>`;
}

/* ── Status banner updater (for in-progress state changes) ── */
function _updateStatusBanner(body, state, attempt, maxRetries, url) {
  var banner = body.querySelector('#fhir-status-banner');
  if (!banner) return;
  banner.className = 'fhir-fetch-banner fhir-fetch-banner--' + state;
}

/* ── Countdown ticker ──────────────────────────────────────── */
function _startCountdown(body, totalMs) {
  var remaining = Math.round(totalMs / 1000);
  var el = body.querySelector('#fhir-countdown');
  if (!el) return;
  var tick = setInterval(function () {
    remaining--;
    var cd = body.querySelector('#fhir-countdown');
    if (!cd) { clearInterval(tick); return; }
    if (remaining <= 0) { clearInterval(tick); return; }
    cd.textContent = remaining;
  }, 1000);
}

/* ── Guess resource type from URL or title ─────────────────── */
function _guessResourceType(url, title) {
  if (url) {
    var m = url.match(/\/(Task|Organization|Subscription[A-Za-z]*|Endpoint|DocumentReference|QuestionnaireResponse|Questionnaire|Bundle|Patient|Practitioner)\//);
    if (m) return m[1];
  }
  if (title) {
    var types = ['Task','Organization','Subscription','Endpoint','DocumentReference',
                 'QuestionnaireResponse','Questionnaire','Bundle','Patient'];
    for (var i = 0; i < types.length; i++) {
      if (title.indexOf(types[i]) !== -1) return types[i];
    }
  }
  return 'Resource';
}

/* ── HTML escape ───────────────────────────────────────────── */
function _esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

/* ── Run hljs on new content ───────────────────────────────── */
function _hljs(container) {
  if (!window.hljs) return;
  container.querySelectorAll('code').forEach(function (el) {
    if (!el.dataset.highlighted) hljs.highlightElement(el);
  });
}

/* ── Close modal ───────────────────────────────────────────── */
function closeJsonModal() {
  _cancelModalFetch();
  var overlay = document.getElementById('jsonModalOverlay');
  if (overlay) {
    overlay.classList.remove('open');
    document.body.style.overflow = '';
  }
}

/* ── Close on backdrop click / Escape ──────────────────────── */
document.addEventListener('click', function (e) {
  if (e.target && e.target.id === 'jsonModalOverlay') closeJsonModal();
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeJsonModal();
});

/* ── Popover / toggle helpers (legacy compat) ───────────────── */
function toggleJson(id) {
  var el = document.getElementById(id);
  if (!el) return;
  el.style.display = el.style.display === 'block' ? 'none' : 'block';
}

function toggleNotification(id) {
  var el = document.getElementById('notif-' + id);
  if (el) el.style.display = el.style.display === 'block' ? 'none' : 'block';
}

/* ── Auto-apply status badges in tables ─────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
  var statuses = ['completed','in-progress','failed','requested','accepted',
                  'received','rejected','draft','cancelled','active','inactive'];
  document.querySelectorAll('table td').forEach(function (td) {
    var raw = td.textContent.trim().toLowerCase();
    if (statuses.indexOf(raw) !== -1 && td.children.length === 0) {
      td.innerHTML = renderStatusBadge(td.textContent.trim());
    }
  });
  if (window.hljs) {
    document.querySelectorAll('pre code').forEach(function (el) { hljs.highlightElement(el); });
  }
});
