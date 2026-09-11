/* =============================================================
   FHIR REFERENCE RESOLVER
   Detects "reference": "ResourceType/id" values inside any
   rendered JSON viewer and makes them clickable.
   Clicking opens a smart popover that fetches + displays the
   target resource, with recursive reference navigation.
   No backend changes required — fetches directly from the
   FHIR server URL stored in the rendered JSON context.
   ============================================================= */

(function () {
  'use strict';

  /* ── Config ─────────────────────────────────────────────────
     Relative reference pattern:  ResourceType/id
     Absolute reference pattern:  https://.../.../ResourceType/id
     Contained reference pattern: #localId  (no fetch needed)
  ─────────────────────────────────────────────────────────── */
  const FHIR_RESOURCE_TYPES = [
    'Task','Subscription','SubscriptionTopic','SubscriptionStatus',
    'Organization','Endpoint','Patient','Practitioner','PractitionerRole',
    'DocumentReference','QuestionnaireResponse','Questionnaire',
    'Bundle','Observation','MedicationRequest','Condition','Encounter',
    'DiagnosticReport','ServiceRequest','Communication','Device',
    'Location','HealthcareService','RelatedPerson','Group',
    'Coverage','Claim','ExplanationOfBenefit','List','Composition',
    'AllergyIntolerance','Immunization','Procedure','CarePlan',
  ];

  // Matches: "Task/123", "Organization/abc-def"
  const REL_REF_RE = new RegExp(
    `^(${FHIR_RESOURCE_TYPES.join('|')})\\/([\\w\\-\\.]+)$`
  );

  // Matches: https://server/fhir/Task/123  or  http://...
  const ABS_REF_RE = new RegExp(
    `^(https?://.+?)\\/(${FHIR_RESOURCE_TYPES.join('|')})\\/([\\w\\-\\.]+)$`
  );

  // Contained:  #someLocalId
  const CONTAINED_RE = /^#(.+)$/;

  /* ── Popover singleton ──────────────────────────────────── */
  let _popover = null;
  let _currentAnchor = null;

  function getPopover() {
    if (_popover) return _popover;
    _popover = document.createElement('div');
    _popover.id = 'fhir-ref-popover';
    _popover.style.cssText = `
      position: fixed;
      z-index: 2000;
      width: 560px;
      max-width: calc(100vw - 32px);
      max-height: 70vh;
      background: var(--color-surface, #fff);
      border: 1px solid var(--color-border-strong, #a0adbf);
      border-radius: var(--radius-lg, 8px);
      box-shadow: 0 12px 40px rgba(0,0,0,0.18), 0 4px 12px rgba(0,0,0,0.1);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      opacity: 0;
      pointer-events: none;
      transform: translateY(6px) scale(0.98);
      transition: opacity 0.18s ease, transform 0.18s ease;
      font-family: var(--font-sans, system-ui, sans-serif);
    `;
    document.body.appendChild(_popover);

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (_popover && !_popover.contains(e.target) && e.target !== _currentAnchor) {
        closePopover();
      }
    }, true);

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePopover();
    });

    return _popover;
  }

  function showPopover(anchor) {
    const pop = getPopover();
    _currentAnchor = anchor;

    // Position relative to anchor
    const rect = anchor.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const popH = Math.min(window.innerHeight * 0.70, 520);

    let top, left;

    if (spaceBelow >= popH + 12 || spaceBelow >= spaceAbove) {
      top = rect.bottom + 8;
    } else {
      top = rect.top - popH - 8;
    }

    left = Math.max(8, Math.min(rect.left, window.innerWidth - 568));
    top  = Math.max(8, top);

    pop.style.top  = top  + 'px';
    pop.style.left = left + 'px';
    pop.style.maxHeight = popH + 'px';

    requestAnimationFrame(function () {
      pop.style.opacity = '1';
      pop.style.pointerEvents = 'all';
      pop.style.transform = 'translateY(0) scale(1)';
    });
  }

  function closePopover() {
    if (!_popover) return;
    _popover.style.opacity = '0';
    _popover.style.pointerEvents = 'none';
    _popover.style.transform = 'translateY(6px) scale(0.98)';
    _currentAnchor = null;
  }

  function setPopoverContent(html) {
    const pop = getPopover();
    pop.innerHTML = html;
  }

  /* ── Popover chrome ─────────────────────────────────────── */
  function popoverChrome(title, resourceType, body) {
    const typeColor = resourceTypeColor(resourceType);
    return `
      <div style="
        display:flex; align-items:center; justify-content:space-between;
        padding:10px 14px; border-bottom:1px solid var(--color-border,#d0d7e3);
        background:var(--color-surface-alt,#f6f8fa); flex-shrink:0;
      ">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="
            background:${typeColor.bg}; color:${typeColor.text};
            font-size:0.65rem; font-weight:800; letter-spacing:0.1em;
            text-transform:uppercase; padding:2px 8px;
            border-radius:999px; border:1px solid ${typeColor.border};
            font-family:var(--font-sans,system-ui,sans-serif);
          ">${resourceType || 'Resource'}</span>
          <span style="font-size:0.82rem; font-weight:600; color:var(--color-text,#111);">${title}</span>
        </div>
        <div style="display:flex; gap:6px; align-items:center;">
          <button onclick="window._fhirRefExpand && window._fhirRefExpand()" title="Expand to full modal"
            style="background:transparent; border:1px solid var(--color-border,#d0d7e3);
            border-radius:4px; padding:3px 8px; cursor:pointer; font-size:0.75rem;
            color:var(--color-text-muted,#4b5870); line-height:1;">
            &#x2922; Expand
          </button>
          <button onclick="document.getElementById('fhir-ref-popover') && (document.getElementById('fhir-ref-popover').style.opacity='0', document.getElementById('fhir-ref-popover').style.pointerEvents='none', document.getElementById('fhir-ref-popover').style.transform='translateY(6px) scale(0.98)')"
            style="background:transparent; border:1px solid var(--color-border,#d0d7e3);
            border-radius:4px; padding:3px 8px; cursor:pointer; font-size:0.9rem;
            color:var(--color-text-muted,#4b5870); line-height:1;">
            &times;
          </button>
        </div>
      </div>
      <div style="overflow:auto; flex:1; padding:12px 14px; font-size:0.82rem; line-height:1.6; color:var(--color-text,#111);">
        ${body}
      </div>
    `;
  }

  function loadingHtml(ref) {
    return popoverChrome(ref, '…', `
      <div style="display:flex; align-items:center; gap:10px; padding:16px 0; color:var(--color-text-muted,#4b5870);">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="animation:fhir-spin 0.9s linear infinite; flex-shrink:0;">
          <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
        </svg>
        Fetching <code style="font-family:var(--font-mono,monospace); font-size:0.8rem;">${escHtml(ref)}</code>…
      </div>
    `);
  }

  function errorHtml(ref, msg) {
    return popoverChrome(ref, 'Error', `
      <div style="color:var(--color-danger,#991b1b); padding:8px 0;">
        <strong>Could not fetch resource</strong><br>
        <code style="font-family:var(--font-mono,monospace); font-size:0.78rem;">${escHtml(ref)}</code><br><br>
        <span style="color:var(--color-text-muted,#4b5870); font-size:0.8rem;">${escHtml(msg)}</span>
      </div>
    `);
  }

  /* ── Resource type colour map ───────────────────────────── */
  function resourceTypeColor(rt) {
    const map = {
      Task:                 { bg:'#dbeafe', text:'#1e40af', border:'rgba(30,64,175,0.2)' },
      Subscription:         { bg:'#e0f2fe', text:'#0369a1', border:'rgba(3,105,161,0.2)' },
      SubscriptionTopic:    { bg:'#e0f2fe', text:'#0369a1', border:'rgba(3,105,161,0.2)' },
      SubscriptionStatus:   { bg:'#dbeafe', text:'#1e40af', border:'rgba(30,64,175,0.2)' },
      Organization:         { bg:'#dcfce7', text:'#166534', border:'rgba(22,101,52,0.2)'  },
      Endpoint:             { bg:'#dcfce7', text:'#166534', border:'rgba(22,101,52,0.2)'  },
      DocumentReference:    { bg:'#fef9c3', text:'#854d0e', border:'rgba(133,77,14,0.2)'  },
      QuestionnaireResponse:{ bg:'#fef9c3', text:'#854d0e', border:'rgba(133,77,14,0.2)'  },
      Questionnaire:        { bg:'#fef9c3', text:'#854d0e', border:'rgba(133,77,14,0.2)'  },
      Bundle:               { bg:'#f3e8ff', text:'#6b21a8', border:'rgba(107,33,168,0.2)' },
      Patient:              { bg:'#ffe4e6', text:'#9f1239', border:'rgba(159,18,57,0.2)'  },
    };
    return map[rt] || { bg:'#f3f4f6', text:'#374151', border:'rgba(55,65,81,0.2)' };
  }

  /* ── Smart resource summary card ───────────────────────── */
  function resourceSummaryHtml(resource, fhirBase, refStack) {
    if (!resource || typeof resource !== 'object') return '<em>Invalid resource</em>';

    const rt  = resource.resourceType || 'Resource';
    const id  = resource.id || '—';
    const col = resourceTypeColor(rt);

    // Key fields by resource type
    const fields = extractKeyFields(resource);

    let html = `
      <div style="margin-bottom:10px; padding-bottom:10px; border-bottom:1px solid var(--color-border,#d0d7e3);">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px;">
          <span style="font-family:var(--font-mono,monospace); font-size:0.78rem; color:var(--color-text-muted,#4b5870);">ID: ${escHtml(String(id))}</span>
          ${resource.meta?.lastUpdated ? `<span style="font-size:0.72rem; color:var(--color-text-light,#7a8799);">Updated: ${escHtml(resource.meta.lastUpdated)}</span>` : ''}
        </div>
        <div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); gap:8px;">
          ${fields.map(f => `
            <div>
              <div style="font-size:0.65rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--color-text-light,#7a8799);">${escHtml(f.label)}</div>
              <div style="font-size:0.82rem; font-weight:500; color:var(--color-text,#111); word-break:break-word;">${f.value}</div>
            </div>
          `).join('')}
        </div>
      </div>`;

    // Full JSON viewer
    const jsonStr = JSON.stringify(resource, null, 2);
    const safeId  = 'fhir-pop-json-' + Math.random().toString(36).slice(2);
    html += `
      <div style="margin-bottom:8px; display:flex; align-items:center; justify-content:space-between;">
        <span style="font-size:0.72rem; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--color-text-light,#7a8799);">Raw JSON</span>
        <button onclick="var el=document.getElementById('${safeId}'); el.style.display=el.style.display==='none'?'block':'none';"
          style="font-size:0.72rem; background:transparent; border:1px solid var(--color-border,#d0d7e3); border-radius:4px; padding:2px 8px; cursor:pointer; color:var(--color-text-muted,#4b5870);">
          Toggle JSON
        </button>
      </div>
      <div id="${safeId}" style="display:none; border-radius:6px; overflow:hidden; border:1px solid #2a3f52;">
        <div style="background:#12202e; padding:5px 12px; display:flex; align-items:center; justify-content:space-between;">
          <span style="font-family:var(--font-mono,monospace); font-size:0.65rem; color:rgba(255,255,255,0.4); text-transform:uppercase; letter-spacing:0.08em;">json · ${escHtml(rt)}</span>
          <button onclick="navigator.clipboard.writeText(${JSON.stringify(jsonStr)})" style="background:transparent; border:1px solid rgba(255,255,255,0.15); border-radius:3px; padding:1px 6px; font-size:0.7rem; color:rgba(255,255,255,0.5); cursor:pointer;">Copy</button>
        </div>
        <div style="background:#152132; overflow:auto; max-height:220px;">
          <pre id="${safeId}-pre" style="margin:0; padding:12px; font-family:var(--font-mono,monospace); font-size:0.75rem; line-height:1.65; color:#b8cfe0; white-space:pre; border:none; border-radius:0; max-height:none; background:transparent;">${escHtml(jsonStr)}</pre>
        </div>
      </div>
    `;

    // Highlight when toggled
    html += `<script>
      (function(){
        var btn = document.querySelector('#${safeId}')?.previousElementSibling?.querySelector('button');
        var pre = document.getElementById('${safeId}-pre');
        if (btn && pre && window.hljs) {
          btn.addEventListener('click', function(){
            if (!pre.dataset.highlighted) {
              hljs.highlightElement(pre);
              pre.dataset.highlighted = '1';
            }
          });
        }
      })();
    <\/script>`;

    return html;
  }

  /* ── Key field extractor ────────────────────────────────── */
  function extractKeyFields(r) {
    const rt = r.resourceType;
    const fields = [];

    const add = (label, value) => {
      if (value !== undefined && value !== null && value !== '' && value !== '—') {
        fields.push({ label, value: escHtml(String(value)) });
      }
    };

    const coding0 = (obj) => obj?.coding?.[0];
    const display = (obj) => coding0(obj)?.display || coding0(obj)?.code || '—';

    if (rt === 'Task') {
      add('Status',          r.status);
      add('Code',            display(r.code));
      add('Business Status', display(r.businessStatus));
      add('Owner',           r.owner?.reference);
      add('Requester',       r.requester?.reference);
      add('Description',     r.description);
    } else if (rt === 'Organization') {
      add('Name',       r.name);
      add('Identifier', r.identifier?.[0]?.value);
      add('Active',     r.active);
    } else if (rt === 'Endpoint') {
      add('Address',    r.address);
      add('Status',     r.status);
      add('Connection', coding0(r.connectionType)?.code);
    } else if (rt === 'Subscription') {
      add('Status',    r.status);
      add('Topic',     r.topic);
      add('Reason',    r.reason);
      add('Endpoint',  r.endpoint);
    } else if (rt === 'SubscriptionTopic') {
      add('Title',       r.title);
      add('URL',         r.url);
      add('Status',      r.status);
      add('Description', r.description);
    } else if (rt === 'SubscriptionStatus') {
      add('Status',              r.status);
      add('Events Since Start',  r.eventsSinceSubscriptionStart);
      add('Type',                r.type);
    } else if (rt === 'DocumentReference') {
      add('Status',   r.status);
      add('Type',     display(r.type));
      add('Category', display(r.category?.[0]));
      add('Date',     r.date);
      const att = r.content?.[0]?.attachment;
      if (att) {
        add('File',         att.title);
        add('Content Type', att.contentType);
      }
    } else if (rt === 'QuestionnaireResponse') {
      add('Status',        r.status);
      add('Questionnaire', r.questionnaire);
      add('Authored',      r.authored);
    } else if (rt === 'Questionnaire') {
      add('Title',  r.title);
      add('Status', r.status);
      add('URL',    r.url);
    } else if (rt === 'Bundle') {
      add('Type',  r.type);
      add('Total', r.total ?? (r.entry?.length));
    } else if (rt === 'Patient') {
      const name = r.name?.[0];
      if (name) add('Name', [name.prefix, name.given?.join(' '), name.family].filter(Boolean).join(' '));
      add('Birth Date', r.birthDate);
      add('Gender',     r.gender);
    } else {
      // Generic fallback
      add('Status',    r.status);
      add('Name',      r.name || r.title);
      add('Code',      display(r.code));
    }

    return fields.filter(f => f.value && f.value !== 'undefined');
  }

  /* ── Resolve a FHIR reference ───────────────────────────── */
  async function resolveReference(refStr, contextFhirBase, containedResources) {
    // 1. Contained reference (#localId)
    const containedMatch = CONTAINED_RE.exec(refStr);
    if (containedMatch) {
      const localId = containedMatch[1];
      const contained = (containedResources || []).find(r => r.id === localId);
      if (contained) {
        return { resource: contained, source: 'contained', url: null };
      }
      return { error: `Contained resource #${localId} not found in parent resource` };
    }

    // 2. Absolute reference
    const absMatch = ABS_REF_RE.exec(refStr);
    if (absMatch) {
      const url = refStr;
      return fetchFhirResource(url);
    }

    // 3. Relative reference — need a base URL
    const relMatch = REL_REF_RE.exec(refStr);
    if (relMatch) {
      const base = contextFhirBase ? contextFhirBase.replace(/\/+$/, '') : null;
      if (!base) {
        return {
          error: `Cannot resolve relative reference "${refStr}" — no FHIR base URL is available on this page.\n\nIf you are viewing this resource in a modal (opened from another page), the base URL context is lost. Try navigating directly to the resource's detail page, or use an absolute reference URL like https://your-server/fhir/${refStr}.`
        };
      }
      const url = `${base}/${refStr}`;
      return fetchFhirResource(url);
    }

    return { error: `Unrecognised reference format: ${refStr}` };
  }

  async function fetchFhirResource(url) {
    try {
      const proxyUrl = '/fhir-proxy?url=' + encodeURIComponent(url);
      const res = await fetch(proxyUrl, {
        headers: { 'Accept': 'application/fhir+json, application/json' }
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        return { error: `HTTP ${res.status} ${res.statusText}${txt ? ': ' + txt.slice(0, 200) : ''}`, url };
      }
      const resource = await res.json();
      return { resource, url, source: 'fetched' };
    } catch (e) {
      return { error: e.message || 'Network error', url };
    }
  }

  /* ── HTML escape ────────────────────────────────────────── */
  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Post-process a JSON viewer: make references clickable ─ */
  function instrumentJsonViewer(container) {
    const pres = container.querySelectorAll('.json-viewer-body pre, .json-viewer-body code');
    pres.forEach(pre => {
      if (pre.dataset.fhirInstrumented) return;
      pre.dataset.fhirInstrumented = '1';
      instrumentPreElement(pre, container);
    });
  }

  function instrumentPreElement(pre, viewerContainer) {
    // Walk text nodes, find reference values, wrap them
    // We operate on the rendered HTML (post highlight.js)
    const html = pre.innerHTML;
    // Pattern: matches the string content of a "reference" key value
    // After hljs: <span class="hljs-string">"Task/123"</span>
    // We look for hljs-string spans whose text matches a FHIR ref
    const newHtml = html.replace(
      /(<span class="hljs-string">")((?:[A-Za-z]+\/[\w\-\.]+|#[\w\-\.]+|https?:\/\/[^"]+\/(?:Task|Organization|Subscription[A-Za-z]*|Endpoint|DocumentReference|QuestionnaireResponse|Questionnaire|Bundle|Patient|Practitioner)[^"]*))("(?:<\/span>)?)/g,
      function (match, pre2, refVal, post) {
        // Only linkify if it looks like a FHIR reference
        const isContained = CONTAINED_RE.test(refVal);
        const isRelative  = REL_REF_RE.test(refVal);
        const isAbsolute  = ABS_REF_RE.test(refVal);
        if (!isContained && !isRelative && !isAbsolute) return match;

        return `${pre2}<a href="#" class="fhir-ref-link" data-ref="${escHtml(refVal)}" title="View FHIR resource: ${escHtml(refVal)}" style="color:#7dd3fc; text-decoration:underline dotted; cursor:pointer; border-radius:2px; transition:background 0.12s; padding:0 1px;" onmouseover="this.style.background='rgba(125,211,252,0.15)'" onmouseout="this.style.background=''">${refVal}</a>${post}`;
      }
    );

    if (newHtml !== html) {
      pre.innerHTML = newHtml;
    }
  }

  /* ── Also handle plain (non-hljs) pre blocks ────────────── */
  function instrumentPlainPre(pre) {
    if (pre.dataset.fhirInstrumented) return;
    pre.dataset.fhirInstrumented = '1';

    const text = pre.textContent;
    // Find "reference": "..." patterns
    const refPattern = /"reference"\s*:\s*"([^"]+)"/g;
    let match;
    const refs = [];
    while ((match = refPattern.exec(text)) !== null) {
      refs.push(match[1]);
    }
    if (!refs.length) return;

    // Replace in innerHTML (safe since we're searching for literal text)
    refs.forEach(refVal => {
      const isContained = CONTAINED_RE.test(refVal);
      const isRelative  = REL_REF_RE.test(refVal);
      const isAbsolute  = ABS_REF_RE.test(refVal);
      if (!isContained && !isRelative && !isAbsolute) return;

      // Escape for regex
      const escaped = refVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(`("reference"\\s*:\\s*")(${escaped})(")`, 'g');
      pre.innerHTML = pre.innerHTML.replace(re, (m, p1, ref, p3) =>
        `${p1}<a href="#" class="fhir-ref-link" data-ref="${escHtml(ref)}" title="View: ${escHtml(ref)}" style="color:#7dd3fc; text-decoration:underline dotted; cursor:pointer;">${ref}</a>${p3}`
      );
    });
  }

  /* ── Scan entire document for JSON viewers ──────────────── */
  function instrumentAllViewers() {
    // Styled json-viewer-containers
    document.querySelectorAll('.json-viewer-container').forEach(instrumentJsonViewer);
    // Raw pre blocks with JSON content (legacy)
    document.querySelectorAll('pre').forEach(pre => {
      if (!pre.closest('.json-viewer-container') && !pre.dataset.fhirInstrumented) {
        if (pre.textContent.includes('"reference"')) {
          instrumentPlainPre(pre);
        }
      }
    });
  }

  /* ── Extract FHIR base URL from context ─────────────────── */
  function extractFhirBaseFromContext(anchor) {
    // 0. Page-level base set by the _fhir_base.ejs partial (highest priority)
    if (window.__FHIR_BASE__) return window.__FHIR_BASE__;

    // 1. <meta name="fhir-base"> tag
    const metaTag = document.querySelector('meta[name="fhir-base"]');
    if (metaTag && metaTag.content) return metaTag.content;

    // 2. Closest ancestor stamped with data-fhir-base
    const stamped = anchor.closest('[data-fhir-base]');
    if (stamped) return stamped.dataset.fhirBase;

    // 3. Scan visible text in the same card/section for a FHIR server URL
    const section = anchor.closest('.card, .fhir-card, .form-section, main, body');
    if (section) {
      const serverRe = /https?:\/\/[\w.\-:]+(?:\/[\w.\-]+)*\/fhir\b/;
      const m = serverRe.exec(section.textContent);
      if (m) return m[0];
    }

    // 4. Extract base from an absolute reference in the same <pre>
    const pre = anchor.closest('pre, code');
    if (pre) {
      const absRe = new RegExp(
        `(https?://.+?)\\/(${FHIR_RESOURCE_TYPES.join('|')})\\/`
      );
      const am = absRe.exec(pre.textContent);
      if (am) return am[1];
    }

    return null;
  }

  /* ── Extract contained resources from parent JSON ──────── */
  function extractContainedResources(anchor) {
    const pre = anchor.closest('pre, code');
    if (!pre) return [];
    try {
      const obj = JSON.parse(pre.textContent);
      return obj.contained || [];
    } catch (e) {
      return [];
    }
  }

  /* ── Click handler ──────────────────────────────────────── */
  document.addEventListener('click', async function (e) {
    const link = e.target.closest('.fhir-ref-link');
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();

    const refStr   = link.dataset.ref;
    const fhirBase = extractFhirBaseFromContext(link);
    const contained = extractContainedResources(link);

    // Show loading state
    setPopoverContent(loadingHtml(refStr));
    showPopover(link);

    // Resolve
    const result = await resolveReference(refStr, fhirBase, contained);

    if (result.error) {
      setPopoverContent(errorHtml(refStr, result.error));
      showPopover(link);
      return;
    }

    const resource = result.resource;
    const rt       = resource.resourceType || 'Resource';
    const id       = resource.id || refStr;
    const sourceLabel = result.source === 'contained'
      ? ' <span style="font-size:0.68rem; color:var(--color-text-light,#7a8799);">(contained)</span>'
      : result.url
        ? ` <span style="font-size:0.68rem; color:var(--color-text-light,#7a8799);" title="${escHtml(result.url)}">fetched from server</span>`
        : '';

    const bodyHtml = resourceSummaryHtml(resource, fhirBase, []);

    // Expand button wires up to the global modal
    window._fhirRefExpand = function () {
      if (window.openJsonModal) {
        openJsonModal(resource, `${rt}/${id}`);
        closePopover();
      }
    };

    setPopoverContent(popoverChrome(
      `${rt}/${id}${sourceLabel}`,
      rt,
      bodyHtml
    ));
    showPopover(link);
  });

  /* ── Spin keyframe ──────────────────────────────────────── */
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fhir-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(360deg); }
    }
    .fhir-ref-link:focus-visible {
      outline: 2px solid var(--color-primary, #0e6ecc);
      outline-offset: 1px;
      border-radius: 2px;
    }
  `;
  document.head.appendChild(style);

  /* ── MutationObserver: re-instrument when JSON viewers appear ─ */
  const observer = new MutationObserver(function (mutations) {
    let needsScan = false;
    mutations.forEach(function (m) {
      m.addedNodes.forEach(function (node) {
        if (node.nodeType === 1) {
          if (node.classList?.contains('json-viewer-container') ||
              node.classList?.contains('json-viewer-body') ||
              node.querySelector?.('.json-viewer-container') ||
              node.tagName === 'PRE') {
            needsScan = true;
          }
        }
      });
    });
    if (needsScan) {
      setTimeout(instrumentAllViewers, 80);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  /* ── Initial instrument on DOMContentLoaded ─────────────── */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () {
      setTimeout(instrumentAllViewers, 150);
    });
  } else {
    setTimeout(instrumentAllViewers, 150);
  }

  /* ── Re-instrument after hljs runs (highlight fires async) ─ */
  document.addEventListener('DOMContentLoaded', function () {
    setTimeout(instrumentAllViewers, 600);
  });

  /* ── Public API ─────────────────────────────────────────── */
  window.FhirRefResolver = {
    instrument:   instrumentAllViewers,
    closePopover: closePopover,
    resolve:      resolveReference,
  };

})();
