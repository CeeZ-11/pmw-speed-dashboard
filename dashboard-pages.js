/* Workspace pages for the dashboard shell — New Audit (with live progress
 * and technical log), Site Lists, Remediation, History and Settings. These
 * replace the classic GUI's screens and talk to exactly the same /api/*
 * routes; they register on window.PSI.pages and borrow the shared helpers
 * dashboard.js puts on window.PSI (esc, api, toast, navigate, …) at call
 * time, so this file can load before it. */
window.PSI = window.PSI || { pages: {} };
(() => {
  'use strict';
  const P = window.PSI;
  const $ = (sel, root = document) => root.querySelector(sel);
  const e = (v) => P.esc(v);

  // ---------------------------------------------------------------- shared
  const I = {
    play: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z" fill="currentColor"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg>',
    history: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
    trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    download: '<svg viewBox="0 0 24 24"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
    compare: '<svg viewBox="0 0 24 24"><path d="M8 4v16M16 4v16M3 8h5M16 16h5M3 16h5M16 8h5"/></svg>',
    key: '<svg viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/></svg>',
    spark: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
    check: '<svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>',
    dots: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/></svg>',
    chevron: '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>',
    note: '<svg viewBox="0 0 24 24"><path d="M5 4h10l4 4v12H5z"/><path d="M15 4v4h4M8 12h8M8 16h5"/></svg>',
  };

  function pageHead(title, desc, actions = '') {
    return `<header class="ws-head"><div><h1 class="ws-title">${e(title)}</h1>${desc ? `<p class="ws-desc">${desc}</p>` : ''}</div>${actions ? `<div class="ws-actions">${actions}</div>` : ''}</header>`;
  }
  const STATUS_TONE = { completed: 'good', running: 'info', failed: 'poor', cancelled: 'warn', interrupted: 'warn' };
  function statusPill(status) {
    return `<span class="pill ${STATUS_TONE[status] || 'muted'}">${status === 'running' ? '<i class="dot-pulse"></i>' : ''}${e(status.charAt(0).toUpperCase() + status.slice(1))}</span>`;
  }
  function fmtElapsed(ms) {
    const t = Math.floor(ms / 1000);
    return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  }
  function scoreHtml(v) {
    if (v == null) return '<span class="c-muted">—</span>';
    return `<span class="score-chip ${P.scoreRating(v)}">${Math.round(v * 100)}</span>`;
  }
  async function readError(res, fallback) {
    try { return (await res.json()).error || fallback; } catch { return fallback; }
  }
  function post(path, body, method = 'POST') {
    return fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  let configCache = null;
  async function getConfig(force) {
    if (!configCache || force) configCache = await P.api('/api/config').catch(() => null);
    return configCache;
  }

  // Modal confirm, styled like the rest of the dashboard.
  function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = false }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-back';
      wrap.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-t">
        <h2 id="modal-t">${e(title)}</h2><p>${e(body)}</p>
        <div class="modal-actions"><button class="btn btn-ghost" data-v="0">Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-v="1">${e(confirmLabel)}</button></div></div>`;
      const prev = document.activeElement;
      const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey, true); prev?.focus?.(); resolve(v); };
      const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(false); } };
      wrap.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-v]');
        if (b) close(b.dataset.v === '1');
        else if (ev.target === wrap) close(false);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      wrap.querySelector('[data-v="1"]').focus();
    });
  }

  // Modal with a short text box (the audit change note). Resolves to the
  // entered text (possibly empty, which clears the note) or null on cancel.
  function noteDialog({ title, body, value = '', maxLength = 500, confirmLabel = 'Save note' }) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-back';
      wrap.innerHTML = `<form class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-t">
        <h2 id="modal-t">${e(title)}</h2><p>${e(body)}</p>
        <label class="field" style="margin-bottom:14px"><span>Note <small>up to ${maxLength} characters · leave empty to remove it</small></span>
          <textarea class="input" data-note-input maxlength="${maxLength}" rows="3" style="min-height:72px">${e(value)}</textarea></label>
        <div class="modal-actions"><button type="button" class="btn btn-ghost" data-v="0">Cancel</button><button type="submit" class="btn btn-primary">${e(confirmLabel)}</button></div></form>`;
      const prev = document.activeElement;
      const input = wrap.querySelector('[data-note-input]');
      const close = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey, true); prev?.focus?.(); resolve(v); };
      const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(null); } };
      wrap.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-v="0"]') || ev.target === wrap) close(null);
      });
      wrap.querySelector('form').addEventListener('submit', (ev) => { ev.preventDefault(); close(input.value.trim()); });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(wrap);
      input.focus();
    });
  }

  // Right-edge drawer used by Compare and the site-list run history/results.
  const drawer = {
    el: null,
    // Bumped by every open/load, so a slow response for an earlier click
    // can't overwrite the drawer the user has since opened.
    seq: 0,
    open(html, label) {
      clearTimeout(this.closeTimer); // a close() just before this must not remove the reopened drawer
      if (!this.el) {
        this.el = document.createElement('div');
        this.el.className = 'drawer-back';
        this.el.innerHTML = '<aside class="drawer" role="dialog" aria-modal="true" tabindex="-1"><button class="drawer-x icon-btn" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button><div class="drawer-body"></div></aside>';
        this.el.addEventListener('click', (ev) => {
          if (ev.target === this.el || ev.target.closest('.drawer-x')) this.close();
        });
        document.addEventListener('keydown', (ev) => {
          if (ev.key === 'Escape' && this.el?.isConnected && !document.querySelector('.modal-back')) this.close();
        });
      }
      this.prev = document.activeElement;
      this.el.querySelector('.drawer').setAttribute('aria-label', label || 'Details');
      this.set(html);
      if (!this.el.isConnected) document.body.appendChild(this.el);
      requestAnimationFrame(() => this.el.classList.add('is-open'));
      this.el.querySelector('.drawer').focus();
    },
    set(html) {
      const body = this.el.querySelector('.drawer-body');
      body.innerHTML = html;
      body.scrollTop = 0;
    },
    body() { return this.el?.querySelector('.drawer-body'); },
    close() {
      if (!this.el?.isConnected) return;
      this.el.classList.remove('is-open');
      this.closeTimer = setTimeout(() => this.el.remove(), 180);
      this.prev?.focus?.();
    },
  };
  P.drawer = drawer;

  // Dropdown menus (<details class="menu">) close on outside click / Escape.
  document.addEventListener('click', (ev) => {
    document.querySelectorAll('details.menu[open]').forEach((d) => { if (!d.contains(ev.target)) d.open = false; });
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') document.querySelectorAll('details.menu[open]').forEach((d) => (d.open = false));
  });

  // --- Keyboard access -------------------------------------------------
  // Many clickable things are rows, tiles or bars rather than <button>s.
  // Make each one focusable and announce it as a button, and let Enter /
  // Space activate it exactly like a click (the existing delegated click
  // handlers then do the rest).
  const CLICKABLE = [
    'tr[data-select]', 'tr[data-open-audit]', 'th[data-sort]', '.ov-tile[data-metric]', '.cwv-tile[data-metric]', '.ov-score[data-nav]',
    '.g-bar[data-select]', 'a.lnk[data-select]', 'a.lnk[data-open-page]', '.delta-row[data-select]', 'tr[data-source-line]', 'tr[data-source-file]', 'span.gl', 'a.lnk[data-source-line]', '.vl-frame[data-vl-frame]',
  ].join(',');
  function enhanceClickables() {
    document.querySelectorAll(CLICKABLE).forEach((el) => {
      if (el.tagName === 'BUTTON' || el.hasAttribute('tabindex')) return;
      el.setAttribute('tabindex', '0');
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
    });
    document.querySelectorAll('th[data-sort]').forEach((th) => {
      th.setAttribute('aria-sort', th.classList.contains('sorted') ? 'descending' : 'none');
    });
    document.querySelectorAll('.tabs button[data-tab], #toptabs button').forEach((b) => {
      b.setAttribute('aria-selected', b.classList.contains('is-active') ? 'true' : 'false');
    });
    document.querySelectorAll('#device-toggle button, .seg button').forEach((b) => {
      b.setAttribute('aria-pressed', b.classList.contains('is-active') ? 'true' : 'false');
    });
  }
  let enhancePending = false;
  new MutationObserver(() => {
    if (enhancePending) return;
    enhancePending = true;
    requestAnimationFrame(() => { enhancePending = false; enhanceClickables(); });
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const el = ev.target;
    if (!(el instanceof HTMLElement) || !el.matches(CLICKABLE) || el.tagName === 'BUTTON') return;
    ev.preventDefault();
    el.click();
  });
  // Keep Tab inside an open dialog/drawer (aria-modal) instead of letting focus
  // wander behind it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const container = document.querySelector('.modal-back .modal') || document.querySelector('.drawer-back.is-open .drawer');
    if (!container) return;
    const focusable = [...container.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter((el) => el.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (ev.shiftKey && (document.activeElement === first || !container.contains(document.activeElement))) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && (document.activeElement === last || !container.contains(document.activeElement))) {
      ev.preventDefault();
      first.focus();
    }
  });

  const WORKSPACE_VIEWS = ['new-audit', 'site-lists', 'remediation', 'history', 'compare', 'settings'];
  function onView(view) {
    return P.state?.view === view;
  }

  // ============================================================ audit runner
  // One audit at a time, kept outside any page so it survives navigation:
  // the New Audit page renders from it, and the top bar / rail reflect it
  // everywhere else.
  const run = {
    status: 'idle', // idle | running | completed | failed | cancelled
    runId: null, auditId: null, url: '', maxPages: null, ai: false, startedAt: 0, endedAt: 0,
    logHtml: '', logText: '', logOpen: false, error: null,
    steps: { crawl: 'pending', audit: 'pending', score: 'pending', report: 'pending' },
    subs: {},
  };
  let es = null;
  let tick = null;
  const STEPS = [
    ['crawl', 'Crawl', 'Finding pages'],
    ['audit', 'Audit', 'Mobile + desktop, each page'],
    ['score', 'Score', 'Deduping findings'],
    ['report', 'Report', 'Writing report files'],
  ];

  // Same phase markers the engine prints (src/orchestrator/run-audit.ts)
  // that the classic GUI keyed its tracker off — nothing is estimated.
  function detectMarkers() {
    const t = run.logText;
    if (run.steps.crawl === 'pending' && /Crawling site/.test(t)) run.steps.crawl = 'current';
    const crawled = t.match(/([\d,]+) pages? discovered/);
    if (crawled && run.steps.crawl !== 'done') {
      run.steps.crawl = 'done';
      run.steps.audit = 'current';
      run.subs.crawl = `${crawled[1]} URLs found`;
    }
    const audited = t.match(/([\d,]+) page audits? completed/);
    if (audited && run.steps.audit !== 'done') {
      run.steps.audit = 'done';
      run.steps.score = 'current';
      run.steps.report = 'current';
      run.subs.audit = `${audited[1]} page audits completed`;
    }
  }

  function b64ToUtf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  function updateChrome() {
    const btn = $('#rerun-btn');
    const running = run.status === 'running';
    if (btn) {
      btn.disabled = running;
      btn.textContent = running ? `Auditing… ${fmtElapsed(Date.now() - run.startedAt)}` : 'Re-Run Audit';
    }
    document.querySelector('.rail-btn[data-nav="new-audit"]')?.classList.toggle('is-busy', running);
    document.querySelector('.shell')?.classList.toggle('is-running', running);
  }

  function finish(status) {
    if (run.status !== 'running') return;
    run.status = status || 'completed';
    run.endedAt = Date.now();
    if (run.status === 'completed') Object.keys(run.steps).forEach((k) => (run.steps[k] = 'done'));
    else run.logOpen = true;
    es?.close();
    es = null;
    clearInterval(tick);
    updateChrome();
    if (run.status === 'completed') {
      // Switch to the fresh audit only when that can't yank the user away
      // from something else: nothing loaded, a workspace page open, or the
      // same site on screen. Otherwise offer it.
      const viewing = P.state.summary?.audit;
      const sameSite = viewing && P.host(viewing.targetUrl) === P.host(run.url);
      if (!viewing || sameSite || WORKSPACE_VIEWS.includes(P.state.view)) {
        P.toast(`Audit of ${P.host(run.url)} finished`, 5000);
        P.loadAudit(run.auditId);
      } else {
        P.toast(`Audit of ${P.host(run.url)} finished`, 12000, { label: 'Open it', run: () => { P.state.view = 'overview'; P.loadAudit(run.auditId); } });
        P.refreshAuditList?.();
      }
    } else {
      P.toast(`Audit ${run.status}. The technical log on the New Audit page shows what happened.`, 7000);
    }
    if (onView('new-audit')) P.render();
    else if (onView('history') || onView('remediation')) P.render();
  }

  async function startAudit({ url, maxPages, ai, workers, runs }) {
    if (run.status === 'running') {
      P.toast('An audit is already running — wait for it to finish first.');
      P.navigate('new-audit');
      return;
    }
    let res, body;
    try {
      res = await post('/api/audits/run', { url, maxPages: maxPages || undefined, ai: Boolean(ai), workers, runs });
      body = await res.json();
    } catch {
      P.toast('Could not reach the engine. Restart the app and try again.', 6000);
      return;
    }
    if (!res.ok) {
      P.toast(body.error || 'Could not start the audit.', 6000);
      return;
    }
    Object.assign(run, {
      status: 'running', runId: body.runId, auditId: body.auditId, url: body.targetUrl, maxPages, ai: Boolean(ai), workers, runs,
      startedAt: Date.now(), endedAt: 0, logHtml: '', logText: '', error: null, logOpen: false,
      steps: { crawl: 'pending', audit: 'pending', score: 'pending', report: 'pending' }, subs: {},
    });
    P.navigate('new-audit');
    clearInterval(tick);
    tick = setInterval(() => {
      updateChrome();
      const el = $('#run-elapsed');
      if (el) el.textContent = fmtElapsed(Date.now() - run.startedAt);
    }, 1000);
    updateChrome();

    es = new EventSource(`/api/runs/${encodeURIComponent(run.runId)}/stream`);
    let opened = false;
    es.onopen = () => {
      // The server replays the run's whole buffered log to every new
      // connection, so after an automatic reconnect start the log afresh
      // instead of appending everything a second time.
      if (opened) {
        run.logHtml = '';
        run.logText = '';
        const log = $('#run-log');
        if (log) log.textContent = '';
      }
      opened = true;
    };
    es.onmessage = (ev) => {
      let html;
      try { html = b64ToUtf8(ev.data); } catch { return; }
      run.logHtml += html;
      run.logText += html.replace(/<[^>]+>/g, '');
      detectMarkers();
      if (onView('new-audit')) patchRunCard(html);
    };
    es.addEventListener('done', (ev) => {
      let payload = {};
      try { payload = JSON.parse(ev.data); } catch { /* ignore */ }
      finish(payload.status || 'completed');
    });
    es.onerror = () => {
      // EventSource retries on its own; only give up once the server says the run ended.
      fetch(`/api/runs/${encodeURIComponent(run.runId)}`)
        .then(async (res) => {
          // 404 = the server no longer knows this run (e.g. it restarted
          // mid-audit) — nothing will ever finish it, so stop waiting.
          if (res.status === 404) return finish('failed');
          const r = await res.json();
          if (r.status && r.status !== 'running') finish(r.status);
        })
        .catch(() => {});
    };
  }
  P.startAudit = startAudit;

  window.addEventListener('beforeunload', (ev) => {
    if (run.status === 'running') { ev.preventDefault(); ev.returnValue = ''; }
  });

  // ============================================================ New Audit
  function runCard() {
    if (run.status === 'idle') return '';
    const running = run.status === 'running';
    const done = Object.values(run.steps).filter((s) => s === 'done').length;
    const kicker = { running: 'In progress', completed: 'Audit complete', failed: 'Audit failed', cancelled: 'Audit cancelled' }[run.status] || run.status;
    const elapsed = (run.endedAt || Date.now()) - run.startedAt;
    return `<section class="card run-card ${e(run.status)}" id="run-card">
      <div class="run-top">
        <div>
          <div class="run-kicker">${running ? '<i class="dot-pulse"></i>' : ''}${e(kicker)}</div>
          <div class="run-url">${e(run.url)}</div>
          <div class="run-meta">mobile + desktop · ${run.maxPages ? `up to ${e(run.maxPages)} pages · ` : ''}<span id="run-elapsed">${fmtElapsed(elapsed)}</span> elapsed</div>
        </div>
        <div class="run-actions">
          ${run.status === 'completed' ? `<button class="btn btn-primary" data-open-audit="${e(run.auditId)}">Open results ${I.chevron}</button>` : ''}
          ${!running ? `<button class="btn btn-ghost" data-run-again>Run again</button>` : ''}
        </div>
      </div>
      <div class="steps" id="run-steps">${stepsHtml()}</div>
      <div class="progress"><i id="run-progress" style="width:${(done / 4) * 100}%"></i></div>
      ${running ? '<p class="note" style="padding:8px 0 0">Closing this window stops the audit early — pages already measured are kept.</p>' : ''}
      <details class="log" ${run.logOpen ? 'open' : ''} id="run-log-wrap">
        <summary>Technical log</summary>
        <pre class="console" id="run-log">${run.logHtml || 'Waiting for output…'}</pre>
      </details>
    </section>`;
  }
  function stepsHtml() {
    return STEPS.map(([k, name, sub], i) => `<div class="step is-${run.steps[k]}">
      <div class="step-n">${run.steps[k] === 'done' ? I.check : i + 1}</div>
      <div><div class="step-name">${name}</div><div class="step-sub">${e(run.subs[k] || sub)}</div></div></div>`).join('');
  }
  function patchRunCard(appendedHtml) {
    const log = $('#run-log');
    if (!log) return;
    if (log.textContent === 'Waiting for output…') log.textContent = '';
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 24;
    log.insertAdjacentHTML('beforeend', appendedHtml);
    if (atBottom) log.scrollTop = log.scrollHeight;
    $('#run-steps').innerHTML = stepsHtml();
    const done = Object.values(run.steps).filter((s) => s === 'done').length;
    $('#run-progress').style.width = `${(done / 4) * 100}%`;
  }

  // One-click scopes for people who don't know what "max pages" should be.
  const PRESETS = [
    { pages: 1, label: 'Quick check', hint: 'Just this page · about 2 minutes' },
    { pages: 5, label: 'Key pages', hint: 'Home + 4 linked pages · a few minutes' },
    { pages: 20, label: 'Full site', hint: 'Up to 20 pages · takes longer' },
  ];
  const presetFor = (n) => (PRESETS.some((p) => p.pages === n) ? n : null);
  // Speed vs. steadiness. Several pages at once share this computer's CPU, so
  // timings wobble a little more; repeating each test and keeping the middle
  // result steadies them at the cost of time.
  const MODES = [
    { id: 'fast', label: 'Fastest', hint: '3 pages at once · numbers wobble a bit more', workers: 3, runs: 1 },
    { id: 'balanced', label: 'Balanced', hint: '2 pages at once · good for most audits', workers: 2, runs: 1 },
    { id: 'steady', label: 'Most consistent', hint: 'Each page tested 3× (middle result kept) · about 3× slower', workers: 1, runs: 3 },
  ];
  let auditMode = (() => { try { return window.localStorage.getItem('pmw-audit-mode') || 'balanced'; } catch { return 'balanced'; } })();

  P.pages['new-audit'] = {
    render() {
      const running = run.status === 'running';
      return `${pageHead('New audit', 'Check any website’s speed and get plain-English explanations of what’s wrong and how to fix it. Every audit runs mobile and desktop.')}
        ${runCard()}
        <div class="ws-grid">
          <section class="card ws-card">
            <h2 class="ws-card-t">${I.play} Audit a website</h2>
            <ol class="how-steps"><li><b>Enter a website</b> — any page address works.</li><li><b>Pick how much to check</b> — a quick check is fine to start.</li><li><b>Get a plain-English fix list</b> — what to fix first, who does it, and how much it helps.</li></ol>
            <form id="audit-form" class="form">
              <label class="field"><span>Website URL</span>
                <input id="na-url" class="input input--mono" type="text" placeholder="https://example.com" autocomplete="off" required value="${e(run.status !== 'idle' ? run.url : '')}" /></label>
              <div class="field"><span>How much to check</span>
                <div class="presets" role="radiogroup" aria-label="How much to check">
                  ${PRESETS.map((p) => `<button type="button" class="preset${presetFor(run.maxPages || 20) === p.pages ? ' is-active' : ''}" data-preset="${p.pages}" role="radio" aria-checked="${presetFor(run.maxPages || 20) === p.pages}"><b>${e(p.label)}</b><span>${e(p.hint)}</span></button>`).join('')}
                </div></div>
              <div class="field"><span>Speed or consistency</span>
                <div class="presets" role="radiogroup" aria-label="Speed or consistency">
                  ${MODES.map((m) => `<button type="button" class="preset${auditMode === m.id ? ' is-active' : ''}" data-mode="${m.id}" role="radio" aria-checked="${auditMode === m.id}"><b>${e(m.label)}</b><span>${e(m.hint)}</span></button>`).join('')}
                </div></div>
              <div class="form-row">
                <label class="field" style="max-width:150px"><span>Pages to check</span>
                  <input id="na-pages" class="input" type="number" min="1" value="${e(run.maxPages || 20)}" /></label>
                <label class="check" id="na-ai-row"><input id="na-ai" type="checkbox" /><span><b>Use AI to prioritize fixes</b><small id="na-ai-note">Optional — works fine without it.</small></span></label>
              </div>
              <div class="form-row form-row--end">
                <span class="pill muted">Mobile + Desktop</span>
                <span class="c-muted small">You can keep using the app while it runs.</span>
                <button class="btn btn-primary" type="submit" ${running ? 'disabled' : ''}>${running ? 'Audit running…' : 'Start audit'}</button>
              </div>
            </form>
          </section>
          <section class="card ws-card">
            <h2 class="ws-card-t">${I.key} Integrations</h2>
            <div id="na-integrations"><div class="c-muted small">Checking…</div></div>
          </section>
        </div>
        <section class="card ws-card">
          <div class="ws-card-h"><h2 class="ws-card-t">${I.history} Recent audits</h2><button class="rcard-link" data-nav="history">All history →</button></div>
          <div id="na-recent" class="tbl-wrap" style="padding:0"><div class="c-muted small">Loading…</div></div>
        </section>`;
    },
    async mount(root) {
      const log = $('#run-log', root);
      if (log) log.scrollTop = log.scrollHeight;
      $('#run-log-wrap', root)?.addEventListener('toggle', (ev) => (run.logOpen = ev.target.open));
      root.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
        $('#na-pages').value = b.dataset.preset;
        root.querySelectorAll('[data-preset]').forEach((x) => {
          x.classList.toggle('is-active', x === b);
          x.setAttribute('aria-checked', String(x === b));
        });
      }));
      $('#na-pages', root).addEventListener('input', (ev) => {
        const n = Number(ev.target.value);
        root.querySelectorAll('[data-preset]').forEach((x) => {
          x.classList.toggle('is-active', Number(x.dataset.preset) === n);
          x.setAttribute('aria-checked', String(Number(x.dataset.preset) === n));
        });
      });
      root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
        auditMode = b.dataset.mode;
        try { window.localStorage.setItem('pmw-audit-mode', auditMode); } catch { /* not remembered */ }
        root.querySelectorAll('[data-mode]').forEach((x) => {
          x.classList.toggle('is-active', x === b);
          x.setAttribute('aria-checked', String(x === b));
        });
      }));
      $('#audit-form', root).addEventListener('submit', (ev) => {
        ev.preventDefault();
        const mode = MODES.find((m) => m.id === auditMode) || MODES[1];
        const maxPages = Number($('#na-pages').value) || undefined;
        // One page never benefits from parallel workers.
        startAudit({ url: $('#na-url').value.trim(), maxPages, ai: $('#na-ai').checked, workers: maxPages === 1 ? 1 : mode.workers, runs: mode.runs });
      });
      const cfg = await getConfig(true);
      if (!onView('new-audit')) return;
      if (cfg) {
        const aiRow = $('#na-ai-row');
        aiRow?.classList.toggle('is-off', !cfg.aiEnabled);
        if (!cfg.aiEnabled && $('#na-ai')) { $('#na-ai').disabled = true; $('#na-ai-note').textContent = 'No AI provider connected — set one up in Settings.'; }
        $('#na-integrations').innerHTML = [
          ['AI prioritization', cfg.aiEnabled, `Findings are grouped and explained in plain language (${cfg.aiProvider}).`, 'Findings are still ranked P0–P2 without it.'],
          ['PageSpeed Insights', cfg.psiEnabled, 'Adds Google’s own Lighthouse run plus real-user field data.', 'The local Lighthouse audit still runs completely without it.'],
        ].map(([name, on, yes, no]) => `<div class="integ"><div><div class="integ-name">${e(name)}</div><div class="c-muted small">${e(on ? yes : no)}</div></div>
          <span class="pill ${on ? 'good' : 'muted'}">${on ? 'Connected' : 'Not connected'}</span></div>`).join('') +
          '<button class="btn btn-ghost btn-sm" data-nav="settings" style="margin-top:10px">Configure in Settings</button>';
      } else {
        $('#na-integrations').innerHTML = '<div class="c-muted small">Couldn’t read the engine configuration.</div>';
      }
      try {
        const audits = (await P.api('/api/audits')).slice(0, 5);
        if (!onView('new-audit')) return;
        $('#na-recent').innerHTML = audits.length
          ? `<table class="tbl"><tbody>${audits.map((a) => `<tr data-open-audit="${e(a.id)}" class="${a.status === 'completed' ? '' : 'is-dim'}">
              <td class="url">${e(a.targetUrl)}</td><td class="dim">${e(P.ago(a.startedAt))}</td><td>${statusPill(a.status)}</td>
              <td class="dim">${a.pagesDiscovered} page${a.pagesDiscovered === 1 ? "" : "s"}</td><td style="text-align:right">${a.status === 'completed' ? `<span class="c-info small">Open ${I.chevron}</span>` : ''}</td></tr>`).join('')}</tbody></table>`
          : '<div class="empty" style="padding:18px">No audits yet — run your first one above.</div>';
      } catch {
        $('#na-recent').innerHTML = '<div class="c-muted small">Couldn’t load recent audits.</div>';
      }
    },
  };

  // ============================================================ Site lists
  const activeListRuns = {}; // scheduleId -> { status, completedSites, totalSites, failedSites }
  let schedules = [];
  let resultsState = null; // { runId, data, failingOnly }

  function listRunBadge(id) {
    const a = activeListRuns[id];
    if (!a) return '';
    if (a.status === 'running') return `<span class="pill info"><i class="dot-pulse"></i>Running ${a.completedSites + a.failedSites}/${a.totalSites}</span>`;
    return `<span class="pill ${a.failedSites ? 'warn' : 'good'}">Done — ${a.completedSites} ok${a.failedSites ? `, ${a.failedSites} failed` : ''}</span>`;
  }
  function renderListsTable() {
    const el = $('#sl-table');
    if (!el) return;
    if (!schedules.length) {
      el.innerHTML = '<div class="empty" style="padding:24px">No site lists yet — create one on the left.</div>';
      return;
    }
    el.innerHTML = `<table class="tbl"><thead><tr><th>Name</th><th>Sites</th><th>Last checked</th><th></th></tr></thead><tbody>${schedules.map((s) => {
      const busy = activeListRuns[s.id]?.status === 'running';
      return `<tr class="no-hover"><td><b>${e(s.name)}</b>${s.aiEnabled ? ' <span class="pill muted">AI</span>' : ''}</td><td>${s.urls.length}</td>
        <td class="dim">${s.lastRunAt ? e(P.fmtDate(s.lastRunAt)) : 'Never'}</td>
        <td class="row-actions">${listRunBadge(s.id)}
          <button class="btn btn-primary btn-sm" data-list-run="${e(s.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Running…' : 'Run now'}</button>
          <button class="btn btn-ghost btn-sm" data-list-history="${e(s.id)}">History</button>
          <button class="icon-btn danger" data-list-delete="${e(s.id)}" title="Delete list" aria-label="Delete ${e(s.name)}">${I.trash}</button></td></tr>`;
    }).join('')}</tbody></table>`;
  }
  async function loadLists() {
    try {
      schedules = await P.api('/api/schedules');
      renderListsTable();
    } catch {
      const el = $('#sl-table');
      if (el) el.innerHTML = '<div class="empty">Couldn’t load saved site lists.</div>';
    }
  }
  function pollListRun(scheduleId, runId) {
    let failures = 0;
    const id = setInterval(async () => {
      try {
        const data = await P.api(`/api/schedule-runs/${encodeURIComponent(runId)}/results`);
        failures = 0;
        activeListRuns[scheduleId] = { status: data.run.status, completedSites: data.run.completedSites, totalSites: data.run.totalSites, failedSites: data.run.failedSites };
        renderListsTable();
        if (data.run.status !== 'running') {
          clearInterval(id);
          P.toast('Site list check finished', 4000);
          await loadLists();
          setTimeout(() => { delete activeListRuns[scheduleId]; renderListsTable(); }, 5000);
        }
      } catch {
        // Transient hiccups retry; a run the server can't report on for ~30s
        // (e.g. it restarted) stops polling instead of retrying forever.
        if (++failures >= 15) {
          clearInterval(id);
          delete activeListRuns[scheduleId];
          renderListsTable();
          P.toast('Lost track of that site-list run — check its History for results.', 6000);
        }
      }
    }, 2000);
  }
  const RUN_LABEL = { running: 'Running…', completed: 'Completed', failed: 'Failed', interrupted: 'Interrupted' };
  async function openListHistory(scheduleId) {
    const s = schedules.find((x) => x.id === scheduleId);
    drawer.open('<div class="empty">Loading…</div>', 'Site list run history');
    const tok = ++drawer.seq;
    try {
      const runs = await P.api(`/api/schedules/${encodeURIComponent(scheduleId)}/runs`);
      if (tok !== drawer.seq) return;
      drawer.set(`<h2 class="drawer-t">Run history</h2><p class="c-muted small">${e(s?.name || '')}</p>
        ${runs.length ? `<div class="run-list">${runs.map((r) => `<div class="run-row"><div><div>${e(P.fmtDate(r.startedAt))}</div>
          <div class="c-muted small">${r.completedSites}/${r.totalSites} sites · ${r.failedSites} failed</div></div>
          <span class="pill ${STATUS_TONE[r.status] || 'muted'}">${e(RUN_LABEL[r.status] || r.status)}</span>
          ${r.status === 'completed' ? `<button class="btn btn-ghost btn-sm" data-list-results="${e(r.id)}">View results</button>` : '<span></span>'}</div>`).join('')}</div>`
          : '<div class="empty">This site list hasn’t been run yet.</div>'}`);
    } catch {
      if (tok === drawer.seq) drawer.set('<div class="empty">Couldn’t load run history.</div>');
    }
  }
  function failingUrls(results) {
    const f = {};
    for (const r of results) if (r.auditStatus !== 'completed' || (r.performanceScore != null && r.performanceScore < 0.5)) f[r.url] = true;
    return f;
  }
  function renderResults() {
    const { data, runId, failingOnly } = resultsState;
    const failing = failingUrls(data.results);
    const rows = data.results.filter((r) => !failingOnly || failing[r.url]);
    const run = data.run;
    drawer.set(`<h2 class="drawer-t">Site check results</h2>
      <p class="c-muted small">${e(P.fmtDate(run.startedAt))} · ${run.completedSites}/${run.totalSites} sites completed${run.failedSites ? `, ${run.failedSites} failed` : ''}${run.rejectedSites ? `, ${run.rejectedSites} rejected before auditing (invalid/disallowed URL)` : ''}</p>
      <div class="drawer-tools"><label class="check check--inline"><input type="checkbox" id="res-failing" ${failingOnly ? 'checked' : ''}/><span>Failing sites only${Object.keys(failing).length ? ` (${Object.keys(failing).length})` : ''}</span></label>
        <a class="btn btn-ghost btn-sm" href="/api/schedule-runs/${e(runId)}/results.csv">${I.download} CSV</a></div>
      <p class="note" style="padding:0 0 8px">“Failing” = either device didn’t complete, or scored below 50.</p>
      ${rows.length ? `<table class="tbl"><thead><tr><th>Site</th><th>Device</th><th>Status</th><th>Score</th><th>LCP</th><th>CLS</th></tr></thead><tbody>${rows.map((r) => `<tr ${r.auditStatus === 'completed' ? `data-open-audit="${e(r.auditId)}"` : 'class="no-hover"'}>
        <td class="url" title="${e(r.url)}">${e(P.host(r.url))}</td><td class="dim">${e(r.device || '—')}</td><td>${statusPill(r.auditStatus)}</td>
        <td>${scoreHtml(r.performanceScore)}</td><td>${r.lcpMs == null ? '—' : P.fmtMs(r.lcpMs, { seconds: true })}</td><td>${r.cls == null ? '—' : r.cls.toFixed(3)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="empty">${failingOnly ? 'No failing sites — every site completed with a good score on both devices.' : 'No sites in this run.'}</div>`}`);
    $('#res-failing', drawer.body())?.addEventListener('change', (ev) => { resultsState.failingOnly = ev.target.checked; renderResults(); });
  }
  async function openListResults(runId) {
    drawer.set('<div class="empty">Loading…</div>');
    const tok = ++drawer.seq;
    try {
      const data = await P.api(`/api/schedule-runs/${encodeURIComponent(runId)}/results`);
      if (tok !== drawer.seq) return;
      resultsState = { runId, data, failingOnly: false };
      renderResults();
    } catch {
      if (tok === drawer.seq) drawer.set('<div class="empty">Couldn’t load results.</div>');
    }
  }

  P.pages['site-lists'] = {
    render() {
      return `${pageHead('Site lists', 'Save a list of sites and check all of their homepages at once — one row per site with every score. Runs only when you press “Run now”.')}
        <div class="ws-grid ws-grid--side">
          <section class="card ws-card">
            <h2 class="ws-card-t">${I.list} New list</h2>
            <form id="sl-form" class="form">
              <label class="field"><span>List name</span><input id="sl-name" class="input" type="text" placeholder="Portfolio homepages" required /></label>
              <label class="field"><span>Site URLs <small>one per line</small></span><textarea id="sl-urls" class="input input--mono" rows="7" placeholder="https://site1.com&#10;https://site2.com" required></textarea></label>
              <label class="check"><input id="sl-ai" type="checkbox" /><span><b>Use AI to prioritize fixes</b><small>Optional, adds time per site.</small></span></label>
              <button class="btn btn-primary" type="submit" id="sl-save">Save list</button>
            </form>
          </section>
          <section class="card ws-card">
            <h2 class="ws-card-t">Your lists</h2>
            <div id="sl-table" class="tbl-wrap" style="padding:0"><div class="c-muted small">Loading…</div></div>
          </section>
        </div>`;
    },
    mount(root) {
      loadLists();
      $('#sl-form', root).addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const urls = $('#sl-urls').value.split('\n').map((u) => u.trim()).filter(Boolean);
        const btn = $('#sl-save');
        btn.disabled = true;
        try {
          const res = await post('/api/schedules', { name: $('#sl-name').value.trim(), urls, aiEnabled: $('#sl-ai').checked });
          if (!res.ok) P.toast(await readError(res, 'Could not save this site list.'), 6000);
          else { ev.target.reset(); P.toast('Site list saved'); await loadLists(); }
        } catch { P.toast('Could not save this site list.', 6000); }
        btn.disabled = false;
      });
    },
  };

  // ============================================================ Remediation
  let remediationAuditId = null;
  const SEV_TONE = { critical: 'poor', high: 'poor', medium: 'warn', low: 'info' };
  const CONF_TONE = { high: 'good', medium: 'warn', low: 'poor' };

  function planCard(plan) {
    const list = (items, fmt) => (items?.length ? `<ul>${items.map((x) => `<li>${e(fmt(x))}</li>`).join('')}</ul>` : '');
    const evidence = list(plan.evidence, (x) => x.statement);
    const limits = list(plan.limitations, (x) => x);
    return `<article class="plan">
      <div class="plan-h"><span class="pill info">${e(plan.metric)}</span><span class="pill ${SEV_TONE[plan.severity] || 'muted'}">${e(plan.severity)} severity</span>
        <span class="pill ${CONF_TONE[plan.confidence] || 'muted'}">${e(plan.confidence)} confidence</span></div>
      <h3 class="plan-t">${e(plan.rootCause)}</h3>
      <div class="plan-cols">
        <div><h4>Recommended fix</h4>${list(plan.actions, (a) => a.description) || '<p class="c-muted small">No specific action recorded.</p>'}</div>
        ${evidence || limits ? `<div class="plan-side">${evidence ? `<h4>Evidence</h4>${evidence}` : ''}${limits ? `<h4>Limitations</h4>${limits}` : ''}</div>` : ''}
      </div></article>`;
  }

  async function loadRemediation(auditId) {
    const el = $('#rm-body');
    if (!el) return;
    el.innerHTML = '<div class="empty">Loading…</div>';
    try {
      const data = await P.api(`/api/audits/${encodeURIComponent(auditId)}/remediation`);
      // Only render if this is still the audit selected (switching quickly
      // could otherwise let a slower, older response win).
      if (!onView('remediation') || auditId !== remediationAuditId) return;
      if (!data.plans.length) {
        el.innerHTML = `<section class="card"><div class="empty">No remediation plans for this audit (${e(data.targetUrl)}). Fix plans are created automatically when an audit finds a slow main image, files that block the first paint, or heavy scripts.</div></section>`;
        return;
      }
      const byPage = new Map();
      for (const plan of data.plans) {
        const k = plan.pageUrl || data.targetUrl;
        if (!byPage.has(k)) byPage.set(k, []);
        byPage.get(k).push(plan);
      }
      const counts = {};
      data.plans.forEach((p) => (counts[p.metric] = (counts[p.metric] || 0) + 1));
      el.innerHTML = `<div class="stat-row">
          <div class="stat"><div class="stat-v">${data.plans.length}</div><div class="stat-k">Fix plans</div></div>
          <div class="stat"><div class="stat-v">${byPage.size}</div><div class="stat-k">Pages affected</div></div>
          ${Object.entries(counts).map(([m, n]) => `<div class="stat"><div class="stat-v">${n}</div><div class="stat-k">${e(m)} plans</div></div>`).join('')}
        </div>
        ${[...byPage].map(([url, plans]) => `<section class="card ws-card">
          <div class="ws-card-h"><h2 class="ws-card-t url-t" title="${e(url)}">${e(P.pagePath(url))}</h2>
            <button class="btn btn-ghost btn-sm" data-open-audit="${e(auditId)}">View in dashboard ${I.chevron}</button></div>
          <div class="plans">${plans.map(planCard).join('')}</div></section>`).join('')}`;
    } catch {
      el.innerHTML = '<section class="card"><div class="empty">Couldn’t load the fix plans. Reload the page, or restart the app if it keeps happening.</div></section>';
    }
  }

  P.pages.remediation = {
    render() {
      return `${pageHead('Fix plans', 'Evidence-based fix plans the engine generates automatically once an audit completes — grouped by page.', '<label class="field field--inline"><span>Audit</span><select id="rm-audit" class="input"><option>Loading…</option></select></label>')}
        <div id="rm-body"><div class="empty">Loading…</div></div>`;
    },
    async mount() {
      let audits;
      try { audits = await P.api('/api/audits'); } catch { $('#rm-body').innerHTML = '<div class="empty">Couldn’t load audits.</div>'; return; }
      if (!onView('remediation')) return;
      const done = audits.filter((a) => a.status === 'completed');
      const sel = $('#rm-audit');
      if (!done.length) {
        sel.closest('.field').hidden = true;
        $('#rm-body').innerHTML = `<section class="card"><div class="empty">${audits[0]?.status === 'running' ? 'An audit is running — remediation appears once it completes.' : 'Run an audit first to find performance issues and available fixes.'}<br><br><button class="btn btn-primary" data-nav="new-audit">New audit</button></div></section>`;
        return;
      }
      // Default to the audit the dashboard is showing, else the newest.
      // A "View fix plan" link from the dashboard asks for the audit being viewed.
      if (P.pendingRemediationAudit && done.some((a) => a.id === P.pendingRemediationAudit)) remediationAuditId = P.pendingRemediationAudit;
      P.pendingRemediationAudit = null;
      if (!done.some((a) => a.id === remediationAuditId)) remediationAuditId = done.some((a) => a.id === P.state.auditId) ? P.state.auditId : done[0].id;
      sel.innerHTML = done.map((a) => `<option value="${e(a.id)}"${a.id === remediationAuditId ? ' selected' : ''}>${e(P.host(a.targetUrl))} — ${e(P.fmtDate(a.startedAt))}</option>`).join('');
      sel.addEventListener('change', () => { remediationAuditId = sel.value; loadRemediation(remediationAuditId); });
      loadRemediation(remediationAuditId);
    },
  };

  // ============================================================ History
  let allAudits = [];
  let historyQuery = '';

  function renderHistoryTable() {
    const el = $('#hs-table');
    if (!el) return;
    const q = historyQuery.trim().toLowerCase();
    const rows = q ? allAudits.filter((a) => a.targetUrl.toLowerCase().includes(q)) : allAudits;
    $('#hs-count').textContent = `${rows.length} of ${allAudits.length}`;
    if (!allAudits.length) { el.innerHTML = '<div class="empty" style="padding:28px">No audits yet.<br><br><button class="btn btn-primary" data-nav="new-audit">Run your first audit</button></div>'; return; }
    if (!rows.length) { el.innerHTML = `<div class="empty">No audits match “${e(historyQuery)}”.</div>`; return; }
    el.innerHTML = `<table class="tbl"><thead><tr><th>Site</th><th>Started</th><th>Status</th><th>Pages</th><th></th></tr></thead><tbody>${rows.map((a) => {
      const viewing = a.id === P.state.auditId;
      // Compare needs an earlier finished audit of the same site with pages in it.
      const canCompare = a.status === 'completed' && allAudits.some((b) => b.targetUrl === a.targetUrl && b.status === 'completed' && b.pagesAudited > 0 && b.startedAt < a.startedAt);
      const noPages = a.status === 'completed' && a.pagesDiscovered === 0;
      return `<tr class="no-hover${viewing ? ' is-sel' : ''}">
        <td><div class="site-cell"><span class="site-ini">${e(P.host(a.targetUrl).replace(/^www\./, '').charAt(0).toUpperCase())}</span><div><div class="url" title="${e(a.targetUrl)}">${e(P.host(a.targetUrl))}</div>${viewing ? '<div class="c-info small">Showing in dashboard</div>' : ''}</div></div></td>
        <td><div>${e(P.fmtDate(a.startedAt))}</div><div class="c-muted small">${e(P.ago(a.startedAt))}</div>${a.note ? `<div class="small audit-note" title="${e(a.note)}" style="max-width:260px;white-space:normal;color:var(--text-2)">${e(a.note)}</div>` : ''}</td>
        <td>${noPages ? '<span class="pill warn" title="The site couldn’t be reached or had no pages to audit">No pages found</span>' : statusPill(a.status)}</td>
        <td>${a.pagesDiscovered} page${a.pagesDiscovered === 1 ? '' : 's'}${a.pagesFailed ? ` <span class="pill poor" title="${a.pagesFailed} page(s) failed">${a.pagesFailed} failed</span>` : ''}</td>
        <td class="row-actions">
          ${a.status === 'completed' && !noPages ? `<button class="btn btn-primary btn-sm" data-open-audit="${e(a.id)}">Open</button>` : ''}
          ${canCompare ? `<button class="btn btn-ghost btn-sm" data-compare="${e(a.id)}" title="What changed since the previous audit of this site">${I.compare} Compare</button>` : ''}
          <details class="menu"><summary class="icon-btn" aria-label="More actions">${I.dots}</summary><div class="menu-list">
            <button data-report="${e(a.id)}">${I.download} HTML report</button>
            <a href="/api/audits/${e(a.id)}/report.pdf">${I.download} PDF report</a>
            <a href="/api/audits/${e(a.id)}/summary.pdf">${I.download} Client summary (PDF)</a>
            <a href="/api/audits/${e(a.id)}/summary.html" target="_blank" rel="noopener">${I.chevron} Client summary (view)</a>
            <a href="/api/audits/${e(a.id)}/findings.csv">${I.download} Findings CSV</a>
            <button data-note="${e(a.id)}">${I.note} ${a.note ? 'Edit note' : 'Add note'}</button>
            <button class="danger" data-delete-audit="${e(a.id)}">${I.trash} Delete audit</button>
          </div></details></td></tr>`;
    }).join('')}</tbody></table>`;
  }
  async function loadHistory() {
    try {
      allAudits = await P.api('/api/audits');
      renderHistoryTable();
    } catch {
      const el = $('#hs-table');
      if (el) el.innerHTML = '<div class="empty">Couldn’t load stored audits.</div>';
    }
  }
  const DELTA = { improved: ['Improved', 'good'], regressed: ['Regressed', 'poor'], unchanged: ['Unchanged', 'muted'], unknown: ['No data', 'muted'] };
  function fmtDelta(metric, v) {
    if (v == null) return '—';
    if (metric === 'performanceScore') return Math.round(v);
    if (metric === 'cls') return v.toFixed(3);
    if (metric === 'tbt') return `${Math.round(v)} ms`;
    return `${(v / 1000).toFixed(2)} s`;
  }
  function findingList(items, empty) {
    if (!items.length) return `<p class="c-muted small">${e(empty)}</p>`;
    return `<ul class="f-list">${items.slice(0, 10).map((f) => `<li><span class="pill muted">${e(f.metric)}</span> ${e(f.rootCause)}<div class="c-muted small">${e(P.pagePath(f.url))} · ${e(f.device)}</div></li>`).join('')}</ul>${items.length > 10 ? `<p class="c-muted small">+${items.length - 10} more</p>` : ''}`;
  }
  async function openCompare(auditId) {
    drawer.open('<div class="empty">Comparing…</div>', 'Compare audits');
    const tok = ++drawer.seq;
    const res = await fetch(`/api/audits/${encodeURIComponent(auditId)}/compare`).catch(() => null);
    if (tok !== drawer.seq) return;
    if (!res) return drawer.set('<div class="empty">Couldn’t load the comparison.</div>');
    const data = await res.json().catch(() => ({}));
    if (tok !== drawer.seq) return;
    if (!res.ok) return drawer.set(`<h2 class="drawer-t">Compare</h2><div class="empty">${e(data.error || 'Couldn’t compare this audit.')}</div>`);
    const c = data.comparison;
    drawer.set(`<h2 class="drawer-t">What changed</h2>
      <p class="c-muted small">${e(P.host(data.targetUrl))} · ${e(P.fmtDate(data.previousAudit.startedAt))} → ${e(P.fmtDate(data.currentAudit.startedAt))} · ${c.matchedPageCount} page(s) matched</p>
      ${Object.entries(c.metricDeltasByDevice).map(([device, deltas]) => `<h3 class="drawer-h3">${e(device.charAt(0).toUpperCase() + device.slice(1))}</h3>
        <div class="delta-grid">${deltas.map((d) => `<div class="delta"><div class="c-muted small">${e(d.label)}</div><div>${fmtDelta(d.metric, d.previous)} → <b>${fmtDelta(d.metric, d.current)}</b></div><span class="pill ${DELTA[d.direction][1]}">${DELTA[d.direction][0]}</span></div>`).join('')}</div>`).join('')}
      <h3 class="drawer-h3">New issues (${c.newFindings.length})</h3>${findingList(c.newFindings, 'Nothing new since the previous audit.')}
      <h3 class="drawer-h3">Resolved issues (${c.resolvedFindings.length})</h3>${findingList(c.resolvedFindings, 'None yet.')}`);
  }

  P.pages.history = {
    render() {
      return `${pageHead('Audit history', 'Every audit that’s been run, newest first. Open one in the dashboard, compare it with the run before, or export it.', '<button class="btn btn-danger-ghost btn-sm" id="hs-delete-all">Delete all</button>')}
        <section class="card ws-card">
          <div class="toolbar"><input id="hs-search" class="input" type="search" placeholder="Search by URL…" autocomplete="off" value="${e(historyQuery)}" /><span class="c-muted small" id="hs-count"></span></div>
          <div id="hs-table" class="tbl-wrap" style="padding:0"><div class="c-muted small">Loading…</div></div>
        </section>`;
    },
    mount(root) {
      loadHistory();
      let searchTimer;
      $('#hs-search', root).addEventListener('input', (ev) => {
        historyQuery = ev.target.value;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderHistoryTable, 150);
      });
      $('#hs-delete-all', root).addEventListener('click', async () => {
        if (!allAudits.length) return;
        const ok = await confirmDialog({ title: `Delete all ${allAudits.length} audits?`, body: 'Every stored audit is removed permanently, along with its report files. Running audits are kept. This can’t be undone.', confirmLabel: 'Delete all', danger: true });
        if (!ok) return;
        const res = await post('/api/audits', undefined, 'DELETE').catch(() => null);
        if (!res?.ok) return P.toast('Could not delete the audits.', 6000);
        P.toast('All audits deleted');
        await loadHistory();
        P.state.auditId = null;
        P.loadAudit(null);
      });
    },
  };

  // ============================================================ Compare sites
  // Google's Core Web Vitals thresholds (good ≤ first, poor > second) — the
  // same numbers as src/analysis/vitals-rating.ts.
  const CMP_METRICS = [
    { id: 'lcp', abbr: 'LCP', label: 'Main content shows', good: 2500, poor: 4000 },
    { id: 'inp', abbr: 'INP', label: 'Responds to taps and clicks', good: 200, poor: 500 },
    { id: 'cls', abbr: 'CLS', label: 'Layout stays stable', good: 0.1, poor: 0.25, isCls: true },
    { id: 'fcp', abbr: 'FCP', label: 'First content appears', good: 1800, poor: 3000 },
    { id: 'tbt', abbr: 'TBT', label: 'Busy while loading', good: 200, poor: 600 },
    { id: 'ttfb', abbr: 'TTFB', label: 'Server starts responding', good: 800, poor: 1800 },
  ];
  const CMP_TONE = { good: ['Good', 'good'], ni: ['Needs improvement', 'warn'], poor: ['Poor', 'poor'] };
  const VERDICT_TONE = { passing: ['Passing', 'good'], 'needs-work': ['Needs work', 'warn'], failing: ['Failing', 'poor'] };
  const cmp = { audits: [], a: null, b: null, seq: 0 };

  function cmpRate(m, v) {
    if (v == null) return null;
    return v <= m.good ? 'good' : v <= m.poor ? 'ni' : 'poor';
  }
  function cmpFmt(m, v) {
    if (v == null) return 'No data';
    if (m.isCls) return v.toFixed(2);
    return v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`;
  }
  const cmpSite = (a) => P.host(a.targetUrl).replace(/^www\./, '');
  function cmpOptions(selected) {
    const done = cmp.audits.filter((a) => a.status === 'completed' && a.pagesAudited > 0);
    const latest = [];
    const seen = new Set();
    for (const a of done) { if (!seen.has(cmpSite(a))) { seen.add(cmpSite(a)); latest.push(a); } }
    const earlier = done.filter((a) => !latest.includes(a));
    const opt = (a) => `<option value="${e(a.id)}"${a.id === selected ? ' selected' : ''}>${e(P.host(a.targetUrl))} · ${e(P.fmtDate(a.startedAt))}</option>`;
    return `<optgroup label="Latest audit per site">${latest.map(opt).join('')}</optgroup>${earlier.length ? `<optgroup label="Earlier audits">${earlier.map(opt).join('')}</optgroup>` : ''}`;
  }
  function cmpCell(m, v) {
    const r = cmpRate(m, v);
    return r ? `<span class="pill ${CMP_TONE[r][1]}" title="${e(CMP_TONE[r][0])}">${e(cmpFmt(m, v))}</span>` : '<span class="c-muted">No data</span>';
  }
  function renderCompareResult(data) {
    const { a, b } = data;
    const devices = ['mobile', 'desktop'].filter((d) => a.devices.includes(d) || b.devices.includes(d));
    const devName = (d) => (d === 'mobile' ? 'Mobile' : 'Desktop');
    const tables = devices.map((d) => {
      const rows = CMP_METRICS.map((m) => {
        const va = a.averages[d]?.[m.id] ?? null;
        const vb = b.averages[d]?.[m.id] ?? null;
        let winner = '<span class="c-muted">—</span>';
        let win = null;
        if (va != null && vb != null) {
          const same = m.isCls ? va.toFixed(2) === vb.toFixed(2) : Math.round(va) === Math.round(vb);
          win = same ? 'tie' : va < vb ? 'a' : 'b';
          winner = win === 'tie' ? '<span class="pill muted">Tie</span>' : `<span class="pill info">${I.check} ${e(win === 'a' ? a.host : b.host)}</span>`;
        }
        return `<tr class="no-hover" data-metric="${m.id}" data-winner="${win || ''}"><td>${e(m.label)} <span class="c-muted small">(${m.abbr})</span></td>
          <td${win === 'a' ? ' style="font-weight:600"' : ''}>${cmpCell(m, va)}</td><td${win === 'b' ? ' style="font-weight:600"' : ''}>${cmpCell(m, vb)}</td><td>${winner}</td></tr>`;
      }).join('');
      return `<section class="card ws-card" data-device="${d}"><h2 class="ws-card-t">${e(devName(d))}</h2>
        <div class="tbl-wrap" style="padding:0"><table class="tbl"><thead><tr><th>What it measures</th><th>${e(a.host)}</th><th>${e(b.host)}</th><th>Better</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
    }).join('');
    const siteCard = (s, label) => {
      const verdicts = devices.map((d) => {
        const v = s.verdicts[d];
        if (!v || !v.verdict) return `<div class="small"><b>${e(devName(d))}:</b> <span class="c-muted">No data</span></div>`;
        const src = v.source === 'real-users' ? 'Google’s real-visitor data' : 'a simulated lab visit';
        return `<div style="margin-bottom:6px"><b>${e(devName(d))}:</b> <span class="pill ${VERDICT_TONE[v.verdict][1]}" data-verdict="${e(v.verdict)}">${e(VERDICT_TONE[v.verdict][0])}</span> <span class="c-muted small">based on ${e(src)}</span><div class="c-muted small">${e(v.sentence)}</div></div>`;
      }).join('');
      const fixes = s.topFixes.length
        ? `<ol class="f-list" style="padding-left:18px">${s.topFixes.map((t) => `<li>${e(t)}</li>`).join('')}</ol>`
        : '<p class="c-muted small">No significant issues found.</p>';
      return `<section class="card ws-card" data-site="${e(label)}"><h2 class="ws-card-t">${e(s.host)} <span class="c-muted small">${e(label)} · ${e(P.fmtDate(s.startedAt))} · ${s.pagesDiscovered ?? s.pagesAudited} page${(s.pagesDiscovered ?? s.pagesAudited) === 1 ? '' : 's'}</span></h2>
        ${verdicts}<h3 class="drawer-h3">Top fixes</h3>${fixes}</section>`;
    };
    const note = (a.pagesDiscovered ?? a.pagesAudited) !== (b.pagesDiscovered ?? b.pagesAudited) ? `<p class="c-muted small">These audits checked a different number of pages (${a.pagesDiscovered ?? a.pagesAudited} vs ${b.pagesDiscovered ?? b.pagesAudited}), so the averages cover different parts of each site.</p>` : '';
    return `${note}${devices.length ? tables : '<div class="empty">Neither audit has speed numbers to compare.</div>'}<div class="ws-grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr)">${siteCard(a, 'Your site')}${siteCard(b, 'Compare with')}</div>`;
  }
  async function loadCompareResult() {
    const el = $('#cs-result');
    if (!el) return;
    if (!cmp.a || !cmp.b) return;
    if (cmp.a === cmp.b) { el.innerHTML = '<div class="empty">Pick two different audits to compare.</div>'; return; }
    el.innerHTML = '<div class="c-muted small">Comparing…</div>';
    const tok = ++cmp.seq;
    const res = await fetch(`/api/compare-sites?a=${encodeURIComponent(cmp.a)}&b=${encodeURIComponent(cmp.b)}`).catch(() => null);
    const data = res ? await res.json().catch(() => ({})) : {};
    if (tok !== cmp.seq || !el.isConnected) return;
    if (!res || !res.ok) { el.innerHTML = `<div class="empty">${e(data.error || 'Couldn’t load the comparison.')}</div>`; return; }
    el.innerHTML = renderCompareResult(data);
  }
  function renderComparePickers() {
    const el = $('#cs-pick');
    if (!el) return;
    const done = cmp.audits.filter((a) => a.status === 'completed' && a.pagesAudited > 0);
    if (!done.length) {
      el.innerHTML = '<div class="empty">No finished audits yet. Audit your own site from New audit, then use the box below to check a competitor.</div>';
      $('#cs-result').innerHTML = '';
      return;
    }
    const sites = new Set(done.map(cmpSite));
    if (!done.some((a) => a.id === cmp.a)) cmp.a = done.some((a) => a.id === P.state?.auditId) ? P.state.auditId : done[0].id;
    if (!done.some((a) => a.id === cmp.b)) {
      const siteA = cmpSite(done.find((a) => a.id === cmp.a));
      cmp.b = (done.find((a) => cmpSite(a) !== siteA) || done.find((a) => a.id !== cmp.a) || done[0]).id;
    }
    el.innerHTML = `<div class="form-row">
        <label class="field"><span>Your site</span><select id="cs-a" class="input">${cmpOptions(cmp.a)}</select></label>
        <label class="field"><span>Compare with</span><select id="cs-b" class="input">${cmpOptions(cmp.b)}</select></label>
      </div>${sites.size < 2 ? '<p class="c-muted small" style="margin:10px 0 0">Only one site has been audited so far. Audit a competitor below to compare against it.</p>' : ''}`;
    $('#cs-a').addEventListener('change', (ev) => { cmp.a = ev.target.value; loadCompareResult(); });
    $('#cs-b').addEventListener('change', (ev) => { cmp.b = ev.target.value; loadCompareResult(); });
    if (done.length < 2) {
      $('#cs-result').innerHTML = '<div class="empty">You need two finished audits to compare. Audit a competitor below — it takes about a minute.</div>';
      return;
    }
    loadCompareResult();
  }

  P.pages.compare = {
    render() {
      return `${pageHead('Compare sites', 'See how your site stacks up against a competitor: the key speed numbers side by side, who is faster on each, and what each site should fix first.')}
        <section class="card ws-card"><h2 class="ws-card-t">${I.compare} Pick two audits</h2><div id="cs-pick"><div class="c-muted small">Loading…</div></div></section>
        <div id="cs-result"></div>
        <section class="card ws-card">
          <h2 class="ws-card-t">${I.play} Audit a competitor</h2>
          <form id="cs-audit-form" class="form">
            <div class="form-row">
              <label class="field"><span>Competitor’s website</span><input id="cs-url" class="input input--mono" type="text" placeholder="https://competitor.com" autocomplete="off" required /></label>
              <button class="btn btn-primary" type="submit">Run quick check</button>
            </div>
            <p class="c-muted small" style="margin:0">Runs a quick 1-page check of their homepage on mobile and desktop. When it finishes, come back here and pick it under “Compare with”.</p>
          </form>
        </section>`;
    },
    async mount(root) {
      $('#cs-audit-form', root).addEventListener('submit', (ev) => {
        ev.preventDefault();
        const url = $('#cs-url', root).value.trim();
        if (!url) return;
        P.startAudit({ url, maxPages: 1, ai: false });
      });
      try {
        cmp.audits = await P.api('/api/audits');
      } catch {
        const el = $('#cs-pick', root);
        if (el) el.innerHTML = '<div class="empty">Couldn’t load stored audits.</div>';
        return;
      }
      renderComparePickers();
    },
  };

  // ============================================================ Settings
  const INTEGRATIONS = [
    {
      id: 'gemini', title: 'AI provider', sub: 'Google Gemini', icon: I.spark, route: '/api/settings/gemini', env: 'GEMINI_API_KEY', label: 'Gemini API key',
      desc: 'Prioritizes and explains findings in plain language. The key is encrypted at rest and never shown again once saved.',
      descFile: 'Prioritizes and explains findings in plain language. The key is never shown again once saved.',
      removeText: 'AI prioritization stops working unless GEMINI_API_KEY is also set in .env.',
      extra: (s) => (s.configured && s.activeProvider && s.activeProvider !== 'gemini' ? `The active AI provider is “${s.activeProvider}”, so this key isn’t in use.` : null),
    },
    {
      id: 'pagespeed', title: 'PageSpeed Insights', sub: 'Google PSI API', icon: I.key, route: '/api/settings/pagespeed', env: 'PAGESPEED_API_KEY', label: 'PageSpeed Insights API key',
      desc: 'Adds a second Lighthouse run on Google’s servers, plus real-user field data, to every audit. Encrypted at rest.',
      descFile: 'Adds a second Lighthouse run on Google’s servers, plus real-user field data, to every audit.',
      removeText: 'PSI field data stops being collected unless PAGESPEED_API_KEY is also set in .env.',
    },
  ];
  function integCard(c) {
    return `<section class="card ws-card integ-card" id="set-${c.id}">
      <div class="ws-card-h"><h2 class="ws-card-t">${c.icon} ${e(c.title)} <span class="c-muted small">${e(c.sub)}</span></h2><span class="pill muted" data-chip>Checking…</span></div>
      <p class="c-muted small" data-desc>${e(c.desc)}</p>
      <div data-body><div class="c-muted small">Loading…</div></div></section>`;
  }
  function renderIntegState(c, state, message, isError) {
    const card = $(`#set-${c.id}`);
    if (!card) return;
    const chip = card.querySelector('[data-chip]');
    chip.className = `pill ${state.configured ? 'good' : 'muted'}`;
    chip.textContent = state.configured ? 'Connected' : 'Not connected';
    // 'file' = command-line mode: keys live in a local owner-only file next to
    // the database instead of the desktop app's encrypted store.
    const fileMode = state.storage === 'file';
    if (fileMode) card.querySelector('[data-desc]').textContent = c.descFile;
    const envText = fileMode ? `From .env (${c.env}). A key saved here overrides it.` : `Set by the ${c.env} environment variable (read-only here).`;
    const detail = [
      state.configured && state.maskedKey ? `Key ${state.maskedKey}` : null,
      state.source === 'env' ? envText : state.source === 'stored' ? (fileMode ? 'Saved here.' : 'Saved securely in this app.') : null,
      c.extra ? c.extra(state) : null,
    ].filter(Boolean).join(' · ');
    const storageNote = fileMode && state.storageFile ? `<div class="c-muted small">Stored on this computer in <code>${e(state.storageFile)}</code></div>` : '';
    card.querySelector('[data-body]').innerHTML = `${detail ? `<div class="key-detail">${e(detail)}</div>` : ''}${storageNote}
      <form class="form" data-form>
        <label class="field"><span>${e(c.label)}</span><input class="input input--mono" type="password" autocomplete="off" placeholder="Paste a key to save or replace it" data-key /></label>
        <div class="form-row"><button class="btn btn-primary" type="submit" data-save>Save key</button><button class="btn btn-ghost" type="button" data-test>Test connection</button>
          ${state.source === 'stored' ? '<button class="btn btn-danger-ghost" type="button" data-remove>Remove key</button>' : ''}</div>
      </form><p class="set-msg ${isError ? 'is-err' : ''}" role="status" aria-live="polite">${e(message || '')}</p>`;
    wireInteg(c, card);
  }
  function wireInteg(c, card) {
    const msg = (t, err) => { const m = card.querySelector('.set-msg'); m.textContent = t || ''; m.classList.toggle('is-err', Boolean(err)); };
    const key = card.querySelector('[data-key]');
    const btns = () => card.querySelectorAll('button');
    const busy = (b) => btns().forEach((x) => (x.disabled = b));
    card.querySelector('[data-form]').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const apiKey = key.value.trim();
      if (!apiKey) return msg('Enter an API key to save.', true);
      busy(true); msg('Saving…');
      try {
        const res = await post(c.route, { apiKey });
        const data = await res.json();
        if (!res.ok) { busy(false); return msg(data.error || 'Could not save the key.', true); }
        key.value = '';
        configCache = null;
        renderIntegState(c, data, 'API key saved.');
      } catch { busy(false); msg('Could not save the key.', true); }
    });
    card.querySelector('[data-test]').addEventListener('click', async () => {
      const candidate = key.value.trim();
      busy(true); msg('Checking…');
      try {
        const res = await post(`${c.route}/test`, candidate ? { apiKey: candidate } : {});
        const data = await res.json();
        msg(res.ok ? data.message : data.error || 'Could not test the key.', !res.ok || data.status !== 'valid');
      } catch { msg('Could not reach the engine to test the key.', true); }
      busy(false);
    });
    card.querySelector('[data-remove]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: `Remove the saved ${c.title} key?`, body: c.removeText, confirmLabel: 'Remove key', danger: true });
      if (!ok) return;
      busy(true);
      try {
        const res = await post(c.route, undefined, 'DELETE');
        const data = await res.json();
        if (!res.ok) { busy(false); return msg(data.error || 'Could not remove the key.', true); }
        configCache = null;
        renderIntegState(c, data, 'API key removed.');
      } catch { busy(false); msg('Could not remove the key.', true); }
    });
  }
  async function loadInteg(c) {
    const card = $(`#set-${c.id}`);
    try {
      const res = await fetch(c.route);
      if (!card.isConnected) return;
      if (!res.ok) throw new Error();
      renderIntegState(c, await res.json());
    } catch {
      card.querySelector('[data-body]').innerHTML = '<div class="set-msg is-err">Couldn’t load these settings. Reload the page, or restart the app if it keeps happening.</div>';
    }
  }

  P.pages.settings = {
    render() {
      return `${pageHead('Settings', 'Connect optional services. The engine works without them — they add AI explanations and Google’s real-user data.')}
        <div class="ws-grid">${INTEGRATIONS.map(integCard).join('')}</div>`;
    },
    mount() { INTEGRATIONS.forEach(loadInteg); },
  };

  // ============================================================ events
  document.addEventListener('click', async (ev) => {
    const t = ev.target.closest('[data-open-audit],[data-run-again],[data-list-run],[data-list-history],[data-list-results],[data-list-delete],[data-compare],[data-report],[data-delete-audit],[data-note]');
    if (!t) return;
    const d = t.dataset;
    if (d.openAudit) {
      drawer.close();
      P.state.view = 'overview';
      if (d.openAudit === P.state.auditId && P.state.summary) return P.render();
      P.state.detail = null;
      return P.loadAudit(d.openAudit);
    }
    if ('runAgain' in d) return startAudit({ url: run.url, maxPages: run.maxPages, ai: run.ai, workers: run.workers, runs: run.runs });
    if (d.listRun) {
      const s = schedules.find((x) => x.id === d.listRun);
      activeListRuns[d.listRun] = { status: 'running', completedSites: 0, totalSites: s ? s.urls.length : 0, failedSites: 0 };
      renderListsTable();
      try {
        const res = await post(`/api/schedules/${encodeURIComponent(d.listRun)}/run-now`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not run this site list.');
        pollListRun(d.listRun, data.scheduleRunId);
      } catch (err) {
        delete activeListRuns[d.listRun];
        renderListsTable();
        P.toast(err.message, 6000);
      }
      return;
    }
    if (d.listHistory) return openListHistory(d.listHistory);
    if (d.listResults) return openListResults(d.listResults);
    if (d.listDelete) {
      const s = schedules.find((x) => x.id === d.listDelete);
      const ok = await confirmDialog({ title: `Delete “${s?.name || 'this list'}”?`, body: 'The list is removed. Audits it already produced stay in Audit history.', confirmLabel: 'Delete list', danger: true });
      if (!ok) return;
      const res = await post(`/api/schedules/${encodeURIComponent(d.listDelete)}`, undefined, 'DELETE').catch(() => null);
      if (!res?.ok) return P.toast(res ? await readError(res, 'Could not delete this list.') : 'Could not delete this list.', 6000);
      P.toast('Site list deleted');
      return loadLists();
    }
    if (d.compare) { t.closest('details')?.removeAttribute('open'); return openCompare(d.compare); }
    if (d.note) {
      t.closest('details')?.removeAttribute('open');
      const a = allAudits.find((x) => x.id === d.note);
      const text = await noteDialog({
        title: a?.note ? 'Edit note' : 'Add a note',
        body: `Record what changed around this audit of ${a ? P.host(a.targetUrl) : 'this site'} (${a ? P.fmtDate(a.startedAt) : ''}), e.g. “New theme deployed”. It shows here and on the client summary’s trend.`,
        value: a?.note || '',
      });
      if (text === null) return;
      const res = await post(`/api/audits/${encodeURIComponent(d.note)}/note`, { note: text || null }).catch(() => null);
      if (!res?.ok) return P.toast(res ? await readError(res, 'Could not save the note.') : 'Could not save the note.', 6000);
      P.toast(text ? 'Note saved' : 'Note removed');
      return loadHistory();
    }
    if (d.report) {
      t.closest('details')?.removeAttribute('open');
      P.toast('Generating the HTML report…', 0);
      try {
        const res = await post(`/api/audits/${encodeURIComponent(d.report)}/report`);
        const data = await res.json();
        if (!data.reportUrl) throw new Error();
        const a = document.createElement('a');
        a.href = data.reportUrl;
        a.download = 'report.html';
        document.body.appendChild(a);
        a.click();
        a.remove();
        P.toast('Report downloaded — a single self-contained HTML file you can share.', 5000);
      } catch { P.toast('Could not generate the report.', 6000); }
      return;
    }
    if (d.deleteAudit) {
      t.closest('details')?.removeAttribute('open');
      const a = allAudits.find((x) => x.id === d.deleteAudit);
      const ok = await confirmDialog({ title: 'Delete this audit?', body: `The audit of ${a ? P.host(a.targetUrl) : 'this site'} from ${a ? P.fmtDate(a.startedAt) : ''} is removed permanently, with its report files. This can’t be undone.`, confirmLabel: 'Delete audit', danger: true });
      if (!ok) return;
      const res = await post(`/api/audits/${encodeURIComponent(d.deleteAudit)}`, undefined, 'DELETE').catch(() => null);
      if (!res?.ok) return P.toast(res ? await readError(res, 'Could not delete this audit.') : 'Could not delete this audit.', 6000);
      P.toast('Audit deleted');
      await loadHistory();
      if (d.deleteAudit === P.state.auditId) { P.state.auditId = null; P.loadAudit(null); }
      else P.refreshAuditList();
    }
  });
})();
