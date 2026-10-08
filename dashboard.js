/* Metric dashboard — a live view over stored audits, served by the GUI
 * server at /dashboard.html. Every number shown comes from the engine's own
 * stored evidence (see src/gui/dashboard-data.ts); anything that wasn't
 * measured renders as "—" or an explicit "not measured" note, never a
 * placeholder figure. */
window.PSI = window.PSI || { pages: {} };
(() => {
  'use strict';

  // ---------------------------------------------------------------- metrics
  const METRICS = {
    LCP: {
      name: 'Largest Contentful Paint', short: 'LCP', key: 'lcp', unit: 'ms', good: 2500, poor: 4000,
      desc: 'Time until the largest image or text block is painted.',
      why: 'LCP is when visitors feel the page has loaded. A slow LCP usually traces to a late-discovered hero image, a slow server response, or render-blocking CSS/JS in front of it.',
    },
    FCP: {
      name: 'First Contentful Paint', short: 'FCP', key: 'fcp', unit: 'ms', good: 1800, poor: 3000,
      desc: 'Time until the browser paints the first text or image.',
      why: 'Until FCP the screen is blank. Everything requested before it — stylesheets, synchronous scripts, fonts — delays the first paint.',
    },
    INP: {
      name: 'Interaction to Next Paint', short: 'INP', key: 'inp', unit: 'ms', good: 200, poor: 500,
      desc: 'Delay between a user interaction and the next frame painted.',
      why: 'When the main thread is busy running JavaScript, clicks, taps and keypresses wait in line. Long tasks are the usual cause of slow interactions.',
    },
    CLS: {
      name: 'Cumulative Layout Shift', short: 'CLS', key: 'cls', unit: '', good: 0.1, poor: 0.25,
      desc: 'How much visible content moves unexpectedly while loading.',
      why: 'Layout shifts make people mis-click and lose their place. They come from images without dimensions, late-injected banners/embeds, and web fonts swapping in.',
    },
    TBT: {
      name: 'Total Blocking Time', short: 'TBT', key: 'tbt', unit: 'ms', good: 200, poor: 600,
      desc: 'Time spent blocking the main thread, preventing interaction.',
      why: 'When the main thread is executing JavaScript, it can’t respond to user input. Any task over 50 ms blocks clicks, taps and scrolls until that work is finished.',
    },
    TTFB: {
      name: 'Time to First Byte', short: 'TTFB', key: 'ttfb', unit: 'ms', good: 800, poor: 1800,
      desc: 'Time until the server starts sending the HTML document.',
      why: 'Every other metric waits on TTFB. It’s driven by server processing, redirects, DNS/TLS setup and a missing CDN or page cache.',
    },
  };
  // Google's grouping: the three Core Web Vitals, then supporting metrics.
  const SIDEBAR_CWV = ['LCP', 'INP', 'CLS'];
  const SIDEBAR_OTHER = ['FCP', 'TBT', 'TTFB'];
  const CATEGORIES = {
    seo: { label: 'SEO', scoreKey: 'seo', findingMetric: 'SEO' },
    accessibility: { label: 'Accessibility', scoreKey: 'accessibility', findingMetric: 'Accessibility' },
    'best-practices': { label: 'Best Practices', scoreKey: 'bestPractices', findingMetric: 'Best Practices' },
  };
  /** Finding metric → the category page that covers it. */
  const CATEGORY_OF = { Accessibility: 'accessibility', 'Best Practices': 'best-practices', SEO: 'seo' };
  const BREAKDOWN_COLORS = {
    'Script Evaluation': '#3d7bf5',
    'Style & Layout': '#3fb67a',
    Rendering: '#e8b73a',
    'Parse HTML & CSS': '#e0544a',
    'Script Parsing & Compilation': '#37a3b8',
    'Garbage Collection': '#8b6cf0',
    Other: '#5b6b82',
  };
  const LONG_TASK_MS = 50;

  function CATEGORIES_KEYS() {
    return ['seo', 'accessibility', 'best-practices'];
  }

  // ------------------------------------------------------------------ state
  const params = new URLSearchParams(location.search);
  // Workspace pages (new audit, site lists, remediation, history, settings)
  // live in dashboard-pages.js and register themselves on window.PSI.pages.
  const WORKSPACE = new Set(['new-audit', 'site-lists', 'remediation', 'history', 'compare', 'settings']);
  // Links written for the old GUI (/#history, /#settings, …) still land on the right page.
  const LEGACY_HASH = { 'run-audit': 'new-audit', 'site-list': 'site-lists', remediation: 'remediation', history: 'history', settings: 'settings' };
  // A fresh launch opens on New Audit rather than surfacing the last site's
  // data; a link naming an audit or metric (History → Open, a reload of the
  // dashboard) still lands on that audit's analysis.
  const initialView =
    LEGACY_HASH[location.hash.slice(1)] ||
    params.get('view') ||
    (params.has('audit') || params.has('metric') ? 'metric' : 'new-audit');
  const state = {
    auditId: params.get('audit'),
    summary: null,
    device: params.get('device') === 'desktop' ? 'desktop' : 'mobile',
    pageId: null,
    detail: null,
    view: CATEGORIES_KEYS().includes(initialView) ? 'category' : initialView === 'all-metrics' ? 'overview' : initialView, // metric | overview | all-metrics | category | network | diagnostics | a WORKSPACE page
    metric: METRICS[params.get('metric')] ? params.get('metric') : 'LCP',
    category: CATEGORIES_KEYS().includes(initialView) ? initialView : 'seo',
    tab: 'findings',
    selected: null, // selected script URL / row key for the right-hand detail card
    snippetSide: 'after',
    sort: {},
    chartScale: 'fit',
    // Simple view hides technical tables and detail for non-technical readers (remembered per browser).
    simple: (() => { try { return window.localStorage.getItem('pmw-simple') === '1'; } catch { return false; } })(),
    ownerFilter: null,
    vlFrame: null,
  };
  document.body.classList.toggle('simple-mode', state.simple);

  const $ = (sel, root = document) => root.querySelector(sel);
  const main = $('#main');
  const right = $('#right');

  // ---------------------------------------------------------------- helpers
  function esc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function num(n, d = 0) {
    return Number(n).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtMs(ms, { seconds = false } = {}) {
    if (ms == null || Number.isNaN(ms)) return '—';
    if (seconds && ms >= 1000) return `${num(ms / 1000, 1)} s`;
    return `${num(Math.round(ms))} ms`;
  }
  function fmtMetric(metric, v) {
    if (v == null) return '—';
    if (metric === 'CLS') return num(v, v < 0.1 ? 3 : 2);
    return fmtMs(v, { seconds: metric === 'LCP' || metric === 'FCP' || metric === 'TTFB' });
  }
  function fmtBytes(b) {
    if (b == null) return '—';
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${num(b / 1024, 1)} KB`;
    return `${num(b / 1024 / 1024, 2)} MB`;
  }
  function rating(metric, v) {
    const m = METRICS[metric];
    if (v == null || !m) return 'none';
    return v <= m.good ? 'good' : v <= m.poor ? 'warn' : 'poor';
  }
  function scoreRating(s) {
    if (s == null) return 'none';
    return s >= 0.9 ? 'good' : s >= 0.5 ? 'warn' : 'poor';
  }
  const RATING_WORD = { good: 'Good', warn: 'Needs improvement', poor: 'Poor', none: 'N/A' };
  function metricValue(vitals, metric) {
    if (!vitals) return null;
    const m = METRICS[metric];
    const entry = vitals[m.key];
    if (!entry) return null;
    return metric === 'CLS' ? entry.value ?? null : entry.valueMs ?? null;
  }
  function fmtDate(iso) {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function ago(iso) {
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return 'just now';
    const unit = (n, word) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
    if (s < 3600) return unit(Math.round(s / 60), 'minute');
    if (s < 86400) return unit(Math.round(s / 3600), 'hour');
    return unit(Math.round(s / 86400), 'day');
  }
  function host(u) {
    try { return new URL(u).hostname; } catch { return u; }
  }
  function shortUrl(u) {
    try {
      const url = new URL(u);
      const parts = url.pathname.split('/').filter(Boolean);
      const tail = parts.slice(-2).join('/') || url.hostname;
      return (tail.length > 38 ? '…' + tail.slice(-37) : tail) + (url.search ? url.search.slice(0, 14) : '');
    } catch { return u; }
  }
  function pagePath(u) {
    try { const p = new URL(u).pathname; return p === '/' ? '/ (home)' : p; } catch { return u; }
  }
  /** `action` ({label, run}) adds a button — e.g. "Open" for a finished audit. */
  function toast(msg, ms = 3500, action = null) {
    const t = $('#toast');
    t.textContent = msg;
    if (action) {
      const b = document.createElement('button');
      b.className = 'toast-action';
      b.textContent = action.label;
      b.addEventListener('click', () => { t.hidden = true; action.run(); });
      t.append(' ', b);
    }
    t.hidden = false;
    clearTimeout(toast._t);
    if (ms) toast._t = setTimeout(() => (t.hidden = true), ms);
  }
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', ...(opts.headers || {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
    return body;
  }
  function setLive(on) {
    $('#rail-live').classList.toggle('is-off', !on);
  }
  const ICON = {
    warn: '<svg viewBox="0 0 24 24"><path d="M12 3L2 21h20z"/><path d="M12 10v5M12 18h.01" stroke-width="2"/></svg>',
    good: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/></svg>',
    bulb: '<svg viewBox="0 0 24 24"><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/></svg>',
    globe: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>',
    gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  };

  // ------------------------------------------------------------ data access
  function pagesForDevice() {
    return (state.summary?.pages || []).filter((p) => p.device === state.device);
  }
  function currentSummaryPage() {
    return (state.summary?.pages || []).find((p) => p.id === state.pageId) || null;
  }
  function findingsFor(metric) {
    const all = state.detail?.findings || [];
    const set = metric === 'TBT' || metric === 'INP' ? [metric, 'JavaScript'] : [metric];
    return all.filter((f) => set.includes(f.metric)).sort((a, b) => a.priority.localeCompare(b.priority));
  }
  function networkDomainInfo(url) {
    return (state.detail?.network || []).find((r) => r.url === url) || null;
  }

  function isWorkspace() {
    return WORKSPACE.has(state.view);
  }
  /** Writes into the analysis area only when an analysis view is showing, so a background reload never clobbers a workspace page. */
  function setMain(html) {
    if (!isWorkspace()) {
      main.innerHTML = html;
      right.innerHTML = '';
    }
  }

  // Every audit/page load gets a sequence number; a response is only used if
  // no newer load started since (switching audits, pages or devices quickly
  // used to let a slow, older response overwrite the newer view).
  let auditSeq = 0;
  let pageSeq = 0;

  async function loadAudit(auditId) {
    const seq = ++auditSeq;
    setMain('<div class="empty">Loading audit…</div>');
    let summary;
    try {
      if (!auditId) {
        const audits = await api('/api/audits');
        if (seq !== auditSeq) return;
        const firstDone = audits.find((a) => a.status === 'completed' && a.pagesAudited > 0);
        if (!firstDone) {
          // Nothing to analyze yet — the New Audit page is the natural start.
          state.summary = null;
          state.auditId = null;
          state.detail = null;
          state.guide = null;
          state.pageId = null;
          resetChrome();
          setLive(true);
          if (!isWorkspace()) {
            state.view = 'new-audit';
            render();
          } else if (!document.querySelector('.ws-head')) render();
          else renderSidebar();
          return;
        }
        auditId = firstDone.id;
      }
      summary = await api(`/api/audits/${encodeURIComponent(auditId)}/dashboard`);
      if (seq !== auditSeq) return;
      setLive(true);
    } catch (err) {
      if (seq !== auditSeq) return;
      setLive(false);
      setMain(`<div class="empty">Couldn’t load the audit: ${esc(err.message)}</div>`);
      return;
    }
    // Only now does the dashboard switch to the new audit — until the summary
    // arrived, everything (including "is this audit already showing?"
    // checks elsewhere) kept describing the previous one.
    state.auditId = auditId;
    state.summary = summary;
    state.ownerFilter = null;
    const devices = new Set(state.summary.pages.map((p) => p.device));
    if (!devices.has(state.device) && devices.size) state.device = [...devices][0];
    pickDefaultPage();
    renderChrome();
    await loadPage();
  }

  /** Clears everything the top bar and sidebar show about a loaded audit — used once none is left. */
  function resetChrome() {
    $('#url-input').value = '';
    syncRunButton();
    $('#audit-select').innerHTML = '';
    $('#page-select').innerHTML = '';
    $('#site-domain').textContent = 'No audit selected';
    $('#site-date').textContent = '';
    $('#site-thumb').style.backgroundImage = '';
    document.querySelectorAll('#device-toggle button').forEach((b) => {
      b.disabled = true;
      b.classList.remove('is-active');
    });
  }

  /** Re-reads the list of this site's audits for the top-bar picker (e.g. after one was deleted). */
  async function refreshAuditList() {
    if (!state.summary) return;
    try {
      const all = await api(`/api/audits?targetUrl=${encodeURIComponent(state.summary.audit.targetUrl)}`);
      state.summary.allAudits = all.map((a) => ({ id: a.id, startedAt: a.startedAt, status: a.status }));
      renderChrome();
    } catch { /* the picker just keeps its current options */ }
  }

  function pickDefaultPage() {
    if (!state.summary) return;
    const pages = pagesForDevice();
    const target = state.summary.audit.targetUrl.replace(/\/$/, '');
    const prevUrl = currentSummaryPage()?.url;
    const match =
      (prevUrl && pages.find((p) => p.url === prevUrl)) ||
      pages.find((p) => p.url.replace(/\/$/, '') === target && p.status !== 'failed') ||
      pages.find((p) => p.status !== 'failed') ||
      pages[0];
    state.pageId = match ? match.id : null;
  }

  async function loadPage() {
    const seq = ++pageSeq;
    const auditId = state.auditId;
    const pageId = state.pageId;
    state.detail = null;
    state.guide = null;
    state.selected = null;
    // Per-page view state doesn't carry over to another page.
    state.vlFrame = null;
    state.sourceLine = null;
    state.sourceSearch = '';
    if (isWorkspace()) renderSidebar();
    else render();
    if (!pageId) return;
    const stale = () => seq !== pageSeq || state.auditId !== auditId || state.pageId !== pageId;
    // The guide column loads alongside the page evidence and fills in when ready.
    api(`/api/audits/${encodeURIComponent(auditId)}/dashboard/pages/${encodeURIComponent(pageId)}/guide`)
      .then((g) => {
        if (stale()) return;
        state.guide = g;
        if (state.detail && !isWorkspace()) { renderRight(); drawCanvases(); }
      })
      .catch(() => {
        if (stale()) return;
        state.guide = { history: [], previous: null, metrics: {}, failed: true };
        if (state.detail && !isWorkspace()) renderRight();
      });
    let detail;
    try {
      detail = await api(`/api/audits/${encodeURIComponent(auditId)}/dashboard/pages/${encodeURIComponent(pageId)}`);
    } catch (err) {
      if (!stale()) setMain(`<div class="empty">Couldn’t load this page’s evidence: ${esc(err.message)}</div>`);
      return;
    }
    if (stale()) return;
    state.detail = detail;
    $('#site-thumb').style.backgroundImage = detail.screenshot ? `url("${detail.screenshot}")` : '';
    // A background reload (e.g. a finished audit) only refreshes the sidebar under a workspace page.
    if (isWorkspace()) renderSidebar();
    else render();
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.auditId) p.set('audit', state.auditId);
    p.set('device', state.device);
    if (isWorkspace()) p.set('view', state.view);
    else if (state.view === 'metric') p.set('metric', state.metric);
    else p.set('view', state.view === 'category' ? state.category : state.view);
    history.replaceState(null, '', `?${p}`);
  }

  // --------------------------------------------------------------- chrome
  function renderChrome() {
    const s = state.summary;
    const audit = s.audit;
    $('#url-input').value = audit.targetUrl;
    syncRunButton();
    $('#site-domain').textContent = host(audit.targetUrl);
    $('#scope-site').textContent = host(audit.targetUrl);
    $('#site-date').textContent = fmtDate(audit.startedAt);
    $('#audit-select').innerHTML = s.allAudits
      .map((a) => `<option value="${esc(a.id)}"${a.id === audit.id ? ' selected' : ''}>${esc(fmtDate(a.startedAt))}${a.status !== 'completed' ? ` (${esc(a.status)})` : ''}</option>`)
      .join('');
    const devs = new Set(s.pages.map((p) => p.device));
    document.querySelectorAll('#device-toggle button').forEach((b) => {
      b.classList.toggle('is-active', b.dataset.device === state.device);
      b.disabled = !devs.has(b.dataset.device);
    });
    const pages = pagesForDevice();
    $('#page-select').innerHTML = pages
      .map((p) => `<option value="${esc(p.id)}"${p.id === state.pageId ? ' selected' : ''}>${esc(pagePath(p.url))}${p.status === 'failed' ? ' (failed)' : ''}</option>`)
      .join('');
    $('#page-options').innerHTML = pages.map((p) => `<option value="${esc(pagePath(p.url))}"></option>`).join('');
    $('#site-path').textContent = pagePath(currentSummaryPage()?.url || '');
  }

  /** "Users 1.7 s" line under a sidebar metric — real-user p75 from CrUX (INP's main value already is one). */
  function sideRealUser(sp, k) {
    const ru = sp?.realUsers;
    const key = { LCP: 'lcp', FCP: 'fcp', CLS: 'cls', TTFB: 'ttfb' }[k];
    if (!ru || !key || ru[key] == null) return '';
    const r = rating(k, ru[key]);
    return `<span class="val-ru" title="Real Chrome users, p75 over 28 days (${ru.scope === 'page' ? 'this URL' : 'whole site'})">Users <b class="c-${r}">${esc(fmtMetric(k, ru[key]))}</b></span>`;
  }

  function renderSidebar() {
    document.querySelector('.sidebar').classList.toggle('is-empty', !state.summary);
    const sp = currentSummaryPage();
    const vitals = sp?.vitals;
    const metricItem = (k) => {
      const m = METRICS[k];
      const v = metricValue(vitals, k);
      const r = rating(k, v);
      const active = state.view === 'metric' && state.metric === k;
      return `<button class="side-item${active ? ' is-active' : ''}" data-metric="${k}">
        <i class="side-dot ${r}"></i>
        <span>${esc(m.name)} (${m.short})<span class="val c-${r === 'none' ? 'muted' : r}">${v == null ? 'Not measured' : esc(fmtMetric(k, v))}</span>${sideRealUser(sp, k)}</span>
      </button>`;
    };
    $('#side-cwv').innerHTML = SIDEBAR_CWV.map(metricItem).join('');
    $('#side-other').innerHTML = SIDEBAR_OTHER.map(metricItem).join('');

    const net = state.detail?.network || [];
    const findingsCount = state.detail?.findings?.length ?? Object.values(sp?.findingsByMetric || {}).reduce((a, b) => a + b, 0);
    $('#side-page').innerHTML = [
      `<button class="side-item${state.view === 'network' ? ' is-active' : ''}" data-nav="network">${ICON.globe}<span>Network requests</span>
        <span class="pill muted">${net.length || '—'}</span></button>`,
      `<button class="side-item${state.view === 'diagnostics' ? ' is-active' : ''}" data-nav="diagnostics">${ICON.gear}<span>All findings</span>
        <span class="pill ${findingsCount ? 'info' : 'good'}">${findingsCount}</span></button>`,
      `<button class="side-item${state.view === 'experiments' ? ' is-active' : ''}" data-nav="experiments"><svg viewBox="0 0 24 24"><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3"/></svg><span>Try a fix</span></button>`,
      `<button class="side-item${state.view === 'source' ? ' is-active' : ''}" data-nav="source"><svg viewBox="0 0 24 24"><path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/></svg><span>Source code</span></button>`,
    ].join('');
  }

  function renderNavState() {
    // Network and All findings live under Performance (they're this page's evidence).
    const topKey = ['metric', 'network', 'diagnostics', 'source', 'experiments'].includes(state.view) ? 'performance' : state.view === 'category' ? state.category : state.view;
    document.querySelectorAll('#toptabs button').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === topKey));
    const railKey = isWorkspace() ? state.view : 'dashboard';
    document.querySelectorAll('.rail-btn[data-nav]').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === railKey));
    document.querySelector('.shell').classList.toggle('is-wide', isWorkspace());
    document.querySelector('.shell').classList.toggle('no-audit', !state.summary);
  }

  // ---------------------------------------------------------------- render
  function render() {
    renderSidebar();
    renderNavState();
    syncUrl();
    if (isWorkspace()) {
      const page = window.PSI.pages[state.view];
      right.innerHTML = '';
      main.innerHTML = page ? page.render() : '<div class="empty">Loading…</div>';
      main.scrollTop = 0;
      page?.mount?.(main);
      return;
    }
    if (!state.summary) {
      state.view = 'new-audit';
      return render();
    }
    if (!state.pageId) {
      main.innerHTML = `<section class="card"><div class="empty">This audit of ${esc(state.summary.audit.targetUrl)} has no measured pages on ${esc(state.device)}${state.summary.pages.length ? ' — try the other device.' : '.'}<br><br><button class="btn btn-primary" data-nav="new-audit">Run a new audit</button></div></section>`;
      right.innerHTML = '';
      return;
    }
    if (!state.detail) {
      main.innerHTML = '<div class="empty">Loading page evidence…</div>';
      right.innerHTML = '';
      return;
    }
    if (state.detail.status === 'failed') {
      const other = state.device === 'mobile' ? 'desktop' : 'mobile';
      main.innerHTML = `<div class="card"><div class="empty"><b>This page couldn’t be audited on ${esc(state.device)}.</b><br><br>
        Usually the site was slow to respond, blocked the test browser, or was briefly down. Try <b>Re-Run Audit</b> above; if it keeps failing, open the page in your own browser to check it loads.
        <br><br><button class="btn btn-ghost btn-sm" data-device-switch="${other}">View ${other} instead</button>
        <details style="margin-top:14px"><summary class="c-muted small">Technical details</summary><div class="c-muted small" style="margin-top:6px">${esc(state.detail.error || 'unknown error')}</div></details></div></div>`;
      right.innerHTML = '';
      return;
    }
    const views = { metric: renderMetricView, overview: renderOverview, category: renderCategory, network: renderNetworkView, diagnostics: renderDiagnostics, source: renderSourceView, experiments: renderExperimentsView };
    main.innerHTML = (views[state.view] || renderMetricView)();
    applyGlossary(main);
    if (state.view === 'source' && state.sourceTab === 'code' && state.sourceLine) {
      document.getElementById(`L${state.sourceLine}`)?.scrollIntoView({ block: 'center' });
    }
    renderRight();
    drawCanvases();
  }

  // ------------------------------------------------------------ metric view
  function renderMetricView() {
    const k = state.metric;
    const m = METRICS[k];
    const v = metricValue(state.detail.vitals, k);
    const r = rating(k, v);
    // Simple view keeps the plain-language tabs only.
    const tabIds = (METRIC_TABS[k] || METRIC_TABS.TBT).filter((id) => !state.simple || SIMPLE_TABS.has(id));
    if (!tabIds.includes(state.tab)) state.tab = 'findings';
    const tabs = tabIds.map((id) => [id, TAB_DEFS[id].label(k)]);
    const heroIcon = r === 'good' ? ICON.good : ICON.warn;
    const inpNote = k !== 'INP' ? ''
      : v == null ? '<span class="pill muted">Needs real visitors — Google has no data for this page yet</span>'
        : '<span class="pill info" title="p75 of real Chrome users over the last 28 days (Chrome UX Report via PageSpeed Insights)">Real-user data</span>';
    const body = TAB_DEFS[state.tab].render(k);

    return `${explainerFor(k)}
      <section class="card hero">
        <div class="hero-grid">
          <div>
            <div class="hero-title"><span class="hero-icon ${r}">${heroIcon}</span>${esc(m.name)} (${m.short})
              <span class="pill ${r === 'none' ? 'muted' : r}">${RATING_WORD[r]}</span>${inpNote}</div>
            <div class="hero-value">${esc(fmtMetric(k, v))}</div>
            <div class="hero-desc">${esc(m.desc)}</div>
            ${thresholdBar(k, v)}
          </div>
          <div class="why">
            <div class="why-h">${ICON.bulb}Why this matters</div>
            ${esc(m.why)}
          </div>
        </div>
        ${sourcesStrip(k)}
        <nav class="tabs">${tabs.map(([id, label]) => `<button data-tab="${id}" class="${state.tab === id ? 'is-active' : ''}">${esc(label)}</button>`).join('')}</nav>
      </section>
      ${body}`;
  }

  // ------------------------------------------------------- per-metric tabs
  // Each metric gets tabs built from the evidence that actually drives it.
  // Findings (the engine's own diagnosis + timeline) always comes first.
  const METRIC_TABS = {
    LCP: ['findings', 'real-users', 'visual', 'lcp-element', 'images', 'render-blocking', 'server'],
    FCP: ['findings', 'real-users', 'visual', 'render-blocking', 'fonts', 'unused-css', 'chain'],
    CLS: ['findings', 'real-users', 'visual', 'culprits', 'unsized', 'fonts'],
    INP: ['findings', 'real-users', 'long-tasks', 'scripts', 'third-parties', 'dom'],
    TBT: ['findings', 'real-users', 'long-tasks', 'scripts', 'third-parties', 'unused-js'],
    TTFB: ['findings', 'real-users', 'server', 'chain'],
  };
  const SIMPLE_TABS = new Set(['findings', 'real-users', 'visual']);
  const ins = () => state.detail.insights || {};
  const countLabel = (label, list) => (Array.isArray(list) ? `${label} (${list.length})` : label);
  const TAB_DEFS = {
    // "Diagnosis": what's wrong first, then the timeline that shows it. Detail
    // tables live in their own tabs (Scripts, Network…) rather than repeating here.
    findings: { label: (k) => `Diagnosis (${findingsFor(k).length})`, render: (k) => pageStoryCard(k) + (k === 'INP' ? labInteractionsCard() : '') + findingsCard(findingsFor(k), `What’s slowing ${METRICS[k].short}`) + (state.simple ? '' : metricChartCard(k) + (k === 'CLS' ? metricTableCard(k) : '')) },
    'long-tasks': { label: () => `Long Tasks (${(state.detail.longTasks || []).length})`, render: () => longTasksCard() },
    scripts: { label: () => `Scripts (${(state.detail.scripts || []).length})`, render: () => scriptsCard('Scripts', 'Every script Lighthouse measured main-thread time for. Click a row for details.') },
    'real-users': { label: () => 'Real Users', render: (k) => realUsersTab(k) },
    visual: { label: () => 'Visual Load', render: (k) => visualTab(k) },
    'lcp-element': { label: () => 'LCP Element', render: () => lcpElementTab() },
    images: { label: () => `Images (${imageRows().length})`, render: () => imagesTab() },
    'render-blocking': { label: () => countLabel('Render-blocking', ins().renderBlocking), render: () => renderBlockingTab() },
    server: { label: () => 'Server Response', render: () => serverTab() },
    fonts: { label: () => `Fonts (${fontRows().length})`, render: (k) => fontsTab(k) },
    'unused-css': { label: () => countLabel('Unused CSS', ins().unusedCss), render: () => unusedTab('css') },
    'unused-js': { label: () => countLabel('Unused JS', ins().unusedJs), render: () => unusedTab('js') },
    chain: { label: () => 'Request Chain', render: () => chainTab() },
    culprits: { label: () => countLabel('Culprits', ins().clsCulprits), render: () => culpritsTab() },
    unsized: { label: () => countLabel('Unsized Images', ins().unsizedImages), render: () => unsizedTab() },
    'third-parties': { label: () => countLabel('Third Parties', ins().thirdParties), render: () => thirdPartiesTab() },
    dom: { label: () => 'DOM & Reflow', render: () => domTab() },
  };

  // --------------------------------------------- Google PSI + CrUX (real users)
  // Three sources, never blended: this engine's own lab run, Google's lab
  // run (PageSpeed Insights, from Google's servers), and real Chrome users
  // (Chrome UX Report, p75 over a rolling 28 days — for this URL when Google
  // has enough traffic for it, otherwise for the whole origin).
  const CRUX = {
    LCP: { ms: 'lcpMs', cat: 'lcpCategory', dist: 'lcpDistribution', hist: 'lcpMs', lab: 'lcpMs' },
    FCP: { ms: 'fcpMs', cat: 'fcpCategory', dist: 'fcpDistribution', hist: 'fcpMs', lab: 'fcpMs' },
    INP: { ms: 'inpMs', cat: 'inpCategory', dist: 'inpDistribution', hist: 'inpMs', lab: null },
    CLS: { ms: 'cls', cat: 'clsCategory', dist: 'clsDistribution', hist: 'cls', lab: 'cls' },
    TTFB: { ms: 'ttfbMs', cat: 'ttfbCategory', dist: 'ttfbDistribution', hist: 'ttfbMs', lab: 'ttfbMs' },
    TBT: { ms: null, cat: null, dist: null, hist: null, lab: 'tbtMs' },
  };
  const CAT = { FAST: ['Good', 'good'], AVERAGE: ['Needs improvement', 'warn'], SLOW: ['Poor', 'poor'] };
  const google = () => state.detail?.google || null;
  /** URL-level CrUX if Google has it for this page, else origin-level; with which one it is. */
  function realUserScope() {
    const g = google();
    if (g?.field) return { data: g.field, scope: 'page' };
    if (g?.origin) return { data: g.origin, scope: 'origin' };
    return null;
  }
  function distBar(dist, k) {
    if (!dist?.length) return '';
    const [good, ni, poor] = [0, 1, 2].map((i) => (dist[i]?.proportion ?? 0) * 100);
    const m = METRICS[k];
    const fmt = (x) => fmtMetric(k, x);
    return `<div class="dist" title="Share of real page loads: good ≤ ${esc(fmt(m.good))}, poor > ${esc(fmt(m.poor))}">
      <i class="g" style="width:${good}%"></i><i class="n" style="width:${ni}%"></i><i class="p" style="width:${poor}%"></i></div>
      <div class="dist-legend"><span class="c-good">${Math.round(good)}% good</span><span class="c-warn">${Math.round(ni)}%</span><span class="c-poor">${Math.round(poor)}% poor</span></div>`;
  }
  function sourcesStrip(k) {
    const c = CRUX[k];
    const g = google();
    // INP's page value comes from real users (lab tools can't measure it).
    // INP has no load-time lab value; the engine's tap test fills that box when it ran.
    const tapTest = k === 'INP' ? state.detail.interactionEvidence : null;
    const lab = k === 'INP' ? (tapTest?.worstMs ?? null) : metricValue(state.detail.vitals, k);
    const googleLab = c.lab && g?.lab?.metrics ? g.lab.metrics[c.lab] : null;
    const ru = realUserScope();
    const ruVal = ru && c.ms ? ru.data[c.ms] : null;
    const cell = (label, sub, v, extra = '') => {
      const r = rating(k, v);
      return `<div class="src"><div class="src-k">${label}</div><div class="src-v c-${v == null ? 'muted' : r === 'none' ? 'muted' : r}">${v == null ? '—' : esc(fmtMetric(k, v))}</div><div class="src-sub">${sub}</div>${extra}</div>`;
    };
    const ruSub = !c.ms ? 'Google doesn’t collect this from visitors — see INP'
      : !ru ? (g ? 'Too few Chrome visits for Google to report' : 'Google data wasn’t fetched for this audit')
        : ru.scope === 'page' ? 'Real visitors · this page · last 28 days' : 'Real visitors · whole site · last 28 days';
    return `<div class="sources">
      ${cell('Engine test', k === 'INP' ? (tapTest?.tested?.length ? `Tap test · slowest of ${tapTest.tested.length} taps` : 'Needs real clicks — see Real visitors') : 'This engine · simulated device', lab)}
      ${cell('Google test', c.lab ? (g?.lab ? 'PageSpeed Insights · Google servers' : 'Google’s test wasn’t run') : 'Needs real clicks', googleLab)}
      ${cell('Real visitors', ruSub, ruVal, ru && c.dist ? distBar(ru.data[c.dist], k) : '')}
    </div>${whyDifferent(k, lab, googleLab, ruVal, ru)}`;
  }

  function cruxScopeCard(title, scope, k, emptyText) {
    const c = CRUX[k];
    if (!scope) return `<div class="ru-card"><div class="ru-t">${esc(title)}</div><div class="c-muted small">${esc(emptyText)}</div></div>`;
    const v = scope[c.ms];
    const cat = CAT[scope[c.cat]];
    return `<div class="ru-card"><div class="ru-t">${esc(title)}</div>
      <div class="ru-v"><b class="c-${cat ? cat[1] : 'muted'}">${v == null ? '—' : esc(fmtMetric(k, v))}</b>${cat ? `<span class="pill ${cat[1]}">${cat[0]}</span>` : ''}</div>
      ${distBar(scope[c.dist], k)}</div>`;
  }

  const CRUX_UNAVAILABLE = {
    'not-configured': 'The weekly real-visitor history needs a Google API key. In the desktop app, add it under Settings; when running from the command line, set PAGESPEED_API_KEY in the .env file.',
    'api-not-enabled': 'The Chrome UX Report History API isn’t enabled for your Google Cloud project yet — enable “Chrome UX Report API” in the Google Cloud console, then re-run the audit.',
    'no-data': 'Google doesn’t have enough real-user traffic for this site to publish a weekly history.',
    error: 'Google’s CrUX History API returned an error for this audit.',
  };

  function realUsersTab(k) {
    const c = CRUX[k];
    const g = google();
    if (!c.ms) {
      const ru = realUserScope();
      const inp = ru?.data?.inpMs;
      return card('Real users', '',
        `<div class="pad"><p class="c-muted">TBT is a lab-only metric — real browsers don’t report it. Its real-user counterpart is <b>Interaction to Next Paint (INP)</b>: how long real visitors wait after tapping or clicking. Heavy main-thread work (what TBT measures) is the usual cause of a slow INP.</p>
        ${inp != null ? `<div class="ru-inline">Real-user INP (${ru.scope === 'page' ? 'this URL' : 'whole site'}): <b class="c-${rating('INP', inp)}">${esc(fmtMetric('INP', inp))}</b> <button class="rcard-link" data-metric="INP">Open INP →</button></div>` : ''}</div>`);
    }
    const hist = state.summary?.crux?.[state.device];
    const histBody = hist?.available && hist.weeks?.some((w) => w[c.hist] != null)
      ? `<div class="chart-box pad"><canvas id="crux-canvas" height="220" data-crux-metric="${esc(k)}"></canvas></div>
         <div class="note">Each point is the p75 of the 28 days ending that week, for the whole site (origin) on ${esc(state.device)}. Shaded bands mark Google’s good / needs-improvement / poor thresholds. Because every point is a 28-day window, a fix shows up gradually over about four weeks — the history shows when a change actually started.</div>`
      : `<div class="empty">${esc(hist ? (hist.unavailableReason === 'api-not-enabled' && hist.errorMessage) || CRUX_UNAVAILABLE[hist.unavailableReason] || 'No weekly history is available.' : 'CrUX history wasn’t collected for this audit.')}</div>`;
    return card(`${METRICS[k].short} · real users`, g ? `Chrome UX Report data from PageSpeed Insights, fetched ${esc(fmtDate(g.fetchedAt))}. p75 = the value 75% of real page loads were at or better than.` : '',
        g ? `<div class="ru-grid pad">${cruxScopeCard('This URL', g.field, k, 'Not enough real-user traffic for this exact URL in Chrome UX Report.')}${cruxScopeCard('Whole site (origin)', g.origin, k, 'Not enough real-user traffic for this origin in Chrome UX Report.')}</div>`
          : '<div class="empty">PageSpeed Insights wasn’t collected for this page — add a PageSpeed Insights key in Settings and re-run the audit.</div>')
      + card(`${METRICS[k].short} · weekly history (CrUX)`, hist?.available ? `${hist.weeks.length} weeks of real-user data` : '', histBody);
  }

  function drawCruxHistory() {
    const canvas = $('#crux-canvas');
    if (!canvas) return;
    const k = canvas.dataset.cruxMetric;
    const key = CRUX[k].hist;
    const weeks = (state.summary?.crux?.[state.device]?.weeks || []).filter((w) => w[key] != null);
    if (!weeks.length) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const m = METRICS[k];
    const vals = weeks.map((wk) => wk[key]);
    const max = Math.max(...vals, m.poor) * 1.12;
    const pad = { l: 46, r: 12, t: 10, b: 22 };
    const x = (i) => pad.l + (i / Math.max(1, weeks.length - 1)) * (w - pad.l - pad.r);
    const y = (v) => pad.t + (1 - v / max) * (h - pad.t - pad.b);
    // threshold bands
    const band = (from, to, color) => { ctx.fillStyle = color; ctx.fillRect(pad.l, y(to), w - pad.l - pad.r, y(from) - y(to)); };
    band(0, m.good, 'rgba(34,192,122,0.08)');
    band(m.good, m.poor, 'rgba(242,179,61,0.08)');
    band(m.poor, max, 'rgba(239,90,76,0.08)');
    ctx.font = '10px Inter, sans-serif';
    ctx.fillStyle = '#8494ab';
    ctx.strokeStyle = 'rgba(140,160,190,0.25)';
    ctx.setLineDash([3, 3]);
    for (const [v, label] of [[m.good, 'good'], [m.poor, 'poor']]) {
      ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
      ctx.fillText(fmtMetric(k, v), 2, y(v) + 3);
      ctx.fillText(label, w - pad.r - 26, y(v) - 3);
    }
    ctx.setLineDash([]);
    // line + points
    ctx.strokeStyle = '#5aa2ff'; ctx.lineWidth = 1.8;
    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
    vals.forEach((v, i) => {
      const r = rating(k, v);
      ctx.fillStyle = r === 'good' ? '#22c07a' : r === 'warn' ? '#f2b33d' : '#ef5a4c';
      ctx.beginPath(); ctx.arc(x(i), y(v), i === vals.length - 1 ? 3.5 : 2.2, 0, Math.PI * 2); ctx.fill();
    });
    ctx.fillStyle = '#8494ab';
    const labelAt = [0, Math.floor((weeks.length - 1) / 2), weeks.length - 1];
    labelAt.forEach((i, n) => {
      const t = weeks[i].endDate;
      const tx = n === 0 ? x(i) : n === 2 ? x(i) - ctx.measureText(t).width : x(i) - ctx.measureText(t).width / 2;
      ctx.fillText(t, tx, h - 6);
    });
    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      const i = Math.max(0, Math.min(weeks.length - 1, Math.round(((e.clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (weeks.length - 1))));
      const wk = weeks[i];
      showTip(e, `<b class="c-${rating(k, wk[key])}">${esc(fmtMetric(k, wk[key]))}</b> p75<br>${esc(wk.startDate)} → ${esc(wk.endDate)}`);
    };
    canvas.onmouseleave = hideTip;
  }

  function cwvAssessmentCard(defaultScope = 'page') {
    const detailGoogle = google();
    const siteOrigin = state.summary?.siteRealUsers?.[state.device] || null;
    const g = detailGoogle || siteOrigin ? { field: detailGoogle?.field || null, origin: detailGoogle?.origin || siteOrigin } : null;
    if (!g || (!g.field && !g.origin)) {
      return `<section class="card"><div class="card-h"><span class="card-t">Real users (Chrome UX Report)</span></div>
        <div class="empty">${g ? 'Google doesn’t have enough real-user traffic for this page or site yet.' : 'PageSpeed Insights wasn’t collected for this page — add a PageSpeed Insights key in Settings and re-run the audit.'}</div></section>`;
    }
    const want = state.cruxScope || defaultScope;
    const scopeKey = want === 'origin' ? (g.origin ? 'origin' : 'page') : g.field ? 'page' : 'origin';
    const scope = scopeKey === 'page' ? g.field : g.origin;
    const verdict = scope.cwvAssessment;
    const tile = (k, core) => {
      const c = CRUX[k];
      const v = scope[c.ms];
      const cat = CAT[scope[c.cat]];
      return `<div class="cwv-tile${core ? ' core' : ''}" data-metric="${k}"><div class="k">${esc(METRICS[k].name)}${core ? '' : ' <span class="c-muted">(diagnostic)</span>'}</div>
        <div class="v c-${cat ? cat[1] : 'muted'}">${v == null ? '—' : esc(fmtMetric(k, v))}</div>${distBar(scope[c.dist], k)}</div>`;
    };
    return `<section class="card cwv"><div class="card-h"><span class="card-t">Core Web Vitals Assessment</span>
        ${verdict ? `<span class="pill ${verdict === 'passed' ? 'good' : 'poor'} cwv-verdict">${verdict === 'passed' ? 'Passed' : 'Failed'}</span>` : '<span class="pill muted">Not enough data</span>'}
        <div class="card-tools"><div class="seg" role="group" aria-label="Real-user data scope">
          <button data-crux-scope="page" class="${scopeKey === 'page' ? 'is-active' : ''}" ${g.field ? '' : 'disabled title="No URL-level data"'}>This URL</button>
          <button data-crux-scope="origin" class="${scopeKey === 'origin' ? 'is-active' : ''}" ${g.origin ? '' : 'disabled'}>Whole site</button></div></div></div>
      <div class="card-sub">Real Chrome users over the last 28 days (p75). Passes only when LCP, INP and CLS are all good.</div>
      <div class="cwv-grid">${tile('LCP', true)}${tile('INP', true)}${tile('CLS', true)}${tile('FCP', false)}${tile('TTFB', false)}</div></section>`;
  }


  // ------------------------------------------------------------ visual load
  // Lighthouse's filmstrip + final screenshot, per device, with the moments
  // that matter and the shifted / LCP elements boxed on the final view.
  function visualSourceFor(dev) {
    const both = state.detail.visualLoad?.[dev];
    if (!both) return null;
    const want = state.visualSource;
    if (want && both[want]) return { key: want, data: both[want] };
    // Default: this engine's frames unless they're the distorted pre-fix kind.
    if (both.engine && both.engine.framesMatchScreen !== false) return { key: 'engine', data: both.engine };
    if (both.google) return { key: 'google', data: both.google };
    return both.engine ? { key: 'engine', data: both.engine } : null;
  }

  function visualTab(k) {
    // Only the device selected in the scope bar — the Mobile/Desktop toggle switches it.
    const dev = state.device;
    const vl = state.detail.visualLoad;
    const mine = vl?.[dev];
    const anyGoogle = Boolean(mine?.google);
    const anyEngine = Boolean(mine?.engine);
    const current = visualSourceFor(dev)?.key;
    const toggle = `<div class="seg" role="group" aria-label="Screenshot source">
      <button data-visual-source="engine" class="${current === 'engine' ? 'is-active' : ''}" ${anyEngine ? '' : 'disabled'}>This engine</button>
      <button data-visual-source="google" class="${current === 'google' ? 'is-active' : ''}" ${anyGoogle ? '' : 'disabled title="PSI not collected"'}>Google PSI</button></div>`;
    const focus = k === 'CLS' ? 'shifts' : 'lcp';
    const rows = visualRow(dev, focus);
    return card(`Visual load · ${dev === 'mobile' ? 'Mobile' : 'Desktop'}`, `How the page appeared while loading on ${dev}. Switch Mobile / Desktop at the top to see the other device. ${k === 'CLS' ? 'Boxes on the final view mark the elements that shifted (numbered by how much).' : 'The dashed box on the final view marks the LCP element.'} Times are from the recorded load — the headline metric is Lighthouse’s throttled estimate, so it runs longer.`,
      `<div class="pad">${rows}</div>`, `<div class="card-tools">${toggle}</div>`);
  }

  function visualRow(dev, focus) {
    const src = visualSourceFor(dev);
    const label = dev === 'mobile' ? 'Mobile' : 'Desktop';
    if (!src) {
      const audited = state.detail.visualLoad?.[dev] != null;
      const why = audited ? `No screenshots were captured for ${label.toLowerCase()} — re-run the audit to get them.` : `This page wasn’t audited on ${label.toLowerCase()}.`;
      return `<div class="vl-row"><div class="vl-dev">${label}</div><div class="c-muted small">${why}</div></div>`;
    }
    const v = src.data;
    const m = v.moments || {};
    const badgeFor = (ms, frames) => {
      if (ms == null) return -1;
      const i = frames.findIndex((f) => f.timingMs >= ms);
      return i === -1 ? frames.length - 1 : i;
    };
    const frames = v.frames || [];
    const marks = {};
    const put = (i, text, cls) => { if (i >= 0) (marks[i] ||= []).push(`<span class="vl-badge ${cls}">${text}</span>`); };
    put(badgeFor(m.firstContentMs, frames), 'First content', 'fc');
    put(badgeFor(m.largestPaintMs, frames), 'Largest paint', 'lp');
    put(badgeFor(m.visuallyCompleteMs, frames), 'Visually complete', 'vc');
    const overlaysOk = v.framesMatchScreen !== false;
    const shifts = (v.shifts || []).filter((x) => x.box).sort((a, b) => (b.score || 0) - (a.score || 0));
    const boxes = !overlaysOk ? '' : [
      // Shifts show on every metric's view, faded when the LCP element is the focus.
      ...shifts.map((x, i) => `<i class="vl-box shift${focus === 'shifts' ? '' : ' dim'}" style="${boxStyle(x.box)}" data-tip="${esc(esc(`Shift ${num(x.score, 4)} · ${x.selector || 'element'}`))}"><b>${i + 1}</b></i>`),
      v.lcp?.box ? `<i class="vl-box lcp${focus === 'lcp' ? ' focus' : ''}" style="${boxStyle(v.lcp.box)}" data-tip="${esc(esc(`LCP element · ${v.lcp.selector || ''}`))}"><b>LCP</b></i>` : '',
    ].join('');
    return `<div class="vl-row">
      <div class="vl-dev">${label} <span class="pill muted">${src.key === 'google' ? 'Google PSI' : 'This engine'}</span>${!overlaysOk ? ' <span class="pill warn" title="These screenshots were captured before the engine’s screenshot fix and don’t match the device screen — switch to Google PSI for an accurate view.">Distorted frames</span>' : ''}</div>
      <div class="vl-grid ${dev}">
        <div class="vl-strip">${frames.map((f, i) => `<figure class="vl-frame${marks[i] ? ' marked' : ''}${state.vlFrame === i ? ' is-picked' : ''}"${v.requests?.length ? ` data-vl-frame="${i}" role="button" tabindex="0" title="Click to see what had loaded at this moment"` : ''}><img src="${esc(f.data)}" alt="${esc(label)} at ${esc(fmtMs(f.timingMs, { seconds: true }))}" loading="lazy"><figcaption>${esc(fmtMs(f.timingMs, { seconds: true }))}${marks[i] ? `<div class="vl-marks">${marks[i].join('')}</div>` : ''}</figcaption></figure>`).join('') || '<div class="c-muted small">No filmstrip recorded.</div>'}</div>
        ${v.final ? `<div class="vl-final"><div class="vl-final-t">Final view</div><div class="vl-shot"><img src="${esc(v.final)}" alt="${esc(label)} final view">${boxes}</div>
          ${'' /* legend follows */}${overlaysOk && shifts.length ? `<ol class="vl-legend">${shifts.slice(0, 5).map((x) => `<li><code>${esc(x.selector || 'element')}</code> <span class="c-muted">${esc(num(x.score, 4))}</span></li>`).join('')}</ol>` : overlaysOk && focus === 'shifts' ? '<div class="c-muted small">No layout shifts on the first screen.</div>' : ''}</div>` : ''}
      </div>${state.vlFrame != null ? frameLoadPanel(v, state.vlFrame) : v.requests?.length ? '<div class="note">Tip: click a screenshot to see which files had loaded at that moment.</div>' : ''}</div>`;
  }
  function boxStyle(b) {
    const pct = (x) => `${Math.max(0, Math.min(100, x * 100)).toFixed(2)}%`;
    return `left:${pct(b.x)};top:${pct(b.y)};width:${pct(Math.min(b.w, 1 - b.x))};height:${pct(Math.min(b.h, 1 - b.y))}`;
  }

  function card(title, sub, body, extra = '') {
    return `<section class="card"><div class="card-h"><span class="card-t">${esc(title)}</span>${extra}</div>${sub ? `<div class="card-sub">${sub}</div>` : ''}${body}</section>`;
  }
  const notCaptured = (what) => `<div class="empty">${esc(what)} wasn’t captured for this page (the Lighthouse version that ran may not report it).</div>`;
  function insightPill(id) {
    const sm = ins().summaries?.[id];
    if (!sm?.displayValue) return '';
    return `<span class="pill ${sm.score != null && sm.score < 0.9 ? 'warn' : 'good'}">${esc(sm.displayValue)}</span>`;
  }
  function barCell(value, max, label, tone = '') {
    const pct = max > 0 && value != null ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
    return `<div class="barcell ${tone}"><i style="width:${pct}%"></i><span>${label}</span></div>`;
  }
  function checklistHtml(checks) {
    return `<ul class="checks">${checks.map((c) => `<li class="${c.pass ? 'ok' : 'bad'}"><b>${c.pass ? '✓' : '✕'}</b>${esc(c.label)}</li>`).join('')}</ul>`;
  }
  function phaseBar(phases) {
    const total = phases.reduce((a, p) => a + (p.durationMs || 0), 0) || 1;
    const colors = ['#3d7bf5', '#e8b73a', '#37a3b8', '#e0544a', '#8b6cf0', '#3fb67a'];
    return `<div class="phasebar">${phases.map((p, i) => `<i style="width:${(p.durationMs / total) * 100}%;background:${colors[i % colors.length]}" data-tip="${esc(`<b>${esc(p.label)}</b><br>${fmtMs(p.durationMs)} · ${Math.round((p.durationMs / total) * 100)}%`)}"></i>`).join('')}</div>
      <div class="phase-legend">${phases.map((p, i) => `<div><span style="background:${colors[i % colors.length]}"></span>${esc(p.label)}<b>${fmtMs(p.durationMs)}</b><em>${Math.round((p.durationMs / total) * 100)}%</em></div>`).join('')}</div>`;
  }
  function codeSnippet(html) {
    return html ? `<pre class="code-inline">${esc(html)}</pre>` : '';
  }

  // LCP ---------------------------------------------------------------
  function lcpElementTab() {
    const d = state.detail;
    const L = ins().lcp || {};
    const e = d.lcpEvidence || {};
    const el = L.element;
    const phases = L.phases?.length ? L.phases
      : e.phases ? [['Time to first byte', e.phases.ttfbMs], ['Resource load delay', e.phases.resourceLoadDelayMs], ['Resource load duration', e.phases.resourceLoadDurationMs], ['Element render delay', e.phases.elementRenderDelayMs]]
          .filter(([, v]) => v != null).map(([label, durationMs]) => ({ label, durationMs })) : [];
    const worst = [...phases].sort((a, b) => b.durationMs - a.durationMs)[0];
    const img = e.imageUrl ? imageRows().find((r) => r.url === e.imageUrl) : null;
    const elementBody = el || e.elementSelector
      ? `<div class="kv2">
          <div><span>Element</span><code>${esc(el?.selector || e.elementSelector)}</code></div>
          ${e.elementType ? `<div><span>Type</span>${esc(e.elementType)}</div>` : ''}
          ${e.imageUrl ? `<div><span>Resource</span><a class="lnk" data-select="${esc(e.imageUrl)}">${esc(shortUrl(e.imageUrl))}</a></div>` : ''}
          ${el?.width ? `<div><span>On screen</span>${Math.round(el.width)}×${Math.round(el.height)} px</div>` : ''}
          ${e.transferSize != null ? `<div><span>Size</span>${fmtBytes(e.transferSize)}${e.imageFormat ? ` · ${esc(e.imageFormat)}` : ''}</div>` : ''}
          ${img?.wastedBytes ? `<div><span>Could save</span><b class="c-warn">${fmtBytes(img.wastedBytes)}</b></div>` : ''}
        </div>${codeSnippet(el?.snippet)}`
      : '<div class="empty">No LCP element was identified.</div>';
    const flags = [
      e.isLazyLoaded != null && { label: 'Not lazy-loaded (LCP images must load eagerly)', pass: !e.isLazyLoaded },
      e.isPreloaded != null && e.elementType === 'image' && { label: 'Preloaded so the browser finds it early', pass: e.isPreloaded },
    ].filter(Boolean);
    const checks = [...(L.discovery || []), ...flags];
    return card('LCP element', 'The element the browser painted last among the largest — everything below explains what delayed it.', `<div class="pad">${elementBody}</div>`)
      + card('Where the LCP time went', worst ? `The biggest share is <b>${esc(worst.label)}</b> (${fmtMs(worst.durationMs)}). Fix that phase first. <span class="c-muted">Phases are measured from the recorded page load, while the headline ${esc(fmtMetric('LCP', metricValue(d.vitals, 'LCP')))} is Lighthouse’s throttled-network estimate — so they won’t add up exactly; the proportions are what matter.</span>` : '', phases.length ? `<div class="pad">${phaseBar(phases)}</div>` : '<div class="empty">No phase breakdown was captured.</div>')
      + card('Discovery checks', 'Can the browser find and prioritize the LCP resource early?', checks.length ? `<div class="pad">${checklistHtml(checks)}</div>` : '<div class="empty">No discovery checks apply (the LCP element may be text).</div>', insightPill('lcp-discovery-insight'));
  }

  function imageRows() {
    const d = state.detail;
    const byUrl = new Map();
    for (const im of d.resources?.images || []) byUrl.set(im.url, { ...im });
    // The resource collector records rendered images in detail; the network log adds every other image request.
    for (const r of d.network || []) {
      if (r.resourceType !== 'image' || byUrl.has(r.url) || r.url.startsWith('data:')) continue;
      const ext = (r.url.split('?')[0].match(/\.(avif|webp|png|jpe?g|gif|svg|ico)$/i) || [])[1];
      // Tracking beacons (tiny extensionless "images" from ad/analytics tags) aren't content.
      if (!ext && (r.transferSize ?? 0) < 1024) continue;
      byUrl.set(r.url, { url: r.url, transferSize: r.transferSize, format: ext ? ext.toLowerCase().replace('jpg', 'jpeg') : null, fromNetwork: true });
    }
    for (const x of ins().imageDelivery || []) {
      const row = byUrl.get(x.url) || { url: x.url };
      byUrl.set(x.url, { ...row, wastedBytes: x.wastedBytes, reasons: x.reasons, selector: x.selector, transferSize: row.transferSize ?? x.totalBytes });
    }
    return [...byUrl.values()].sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).map((r) => {
      const need = r.renderedWidth && r.devicePixelRatio ? r.renderedWidth * r.devicePixelRatio : r.renderedWidth;
      return { ...r, isLcp: r.isLcpCandidate || r.url === d.lcpEvidence?.imageUrl, oversized: r.intrinsicWidth && need ? r.intrinsicWidth > need * 1.5 : false };
    });
  }
  function imagesTab() {
    const rows = imageRows();
    const maxWaste = Math.max(0, ...rows.map((r) => r.wastedBytes || 0));
    const total = rows.reduce((a, r) => a + (r.wastedBytes || 0), 0);
    return card('Images', `Every image this page requested, with Lighthouse’s estimate of what better delivery would save${total ? ` — <b>${fmtBytes(total)}</b> in total` : ''}. Click one for details.`,
      `<div class="tbl-wrap">${table('images', [
        { key: 'thumb', label: '', render: (r) => `<img class="thumb" src="${esc(r.url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.visibility='hidden'">`, sortVal: () => 0 },
        { key: 'url', label: 'Image', render: (r) => `${esc(shortUrl(r.url))}${r.isLcp ? ' <span class="pill warn">LCP</span>' : ''}`, cls: 'url', title: (r) => r.url, sortVal: (r) => shortUrl(r.url) },
        { key: 'format', label: 'Format', render: (r) => esc((r.format || '').replace('image/', '') || '—') },
        { key: 'transferSize', label: 'Size', render: (r) => fmtBytes(r.transferSize) },
        { key: 'dims', label: 'Actual → shown', render: (r) => (r.intrinsicWidth ? `${r.intrinsicWidth}×${r.intrinsicHeight} → ${Math.round(r.renderedWidth || 0)}×${Math.round(r.renderedHeight || 0)}${r.oversized ? ' <span class="pill warn">Oversized</span>' : ''}` : '<span class="c-muted">—</span>'), sortVal: (r) => (r.intrinsicWidth || 0) - (r.renderedWidth || 0) },
        { key: 'isLazyLoaded', label: 'Loading', render: (r) => (r.isLazyLoaded == null ? '—' : r.isLazyLoaded ? (r.isLcp ? '<span class="pill poor">lazy</span>' : 'lazy') : 'eager') },
        { key: 'wastedBytes', label: 'Could save', render: (r) => (r.wastedBytes ? barCell(r.wastedBytes, maxWaste, fmtBytes(r.wastedBytes), 'warn') : '<span class="c-muted">—</span>') },
      ], rows, { defaultSort: 'wastedBytes', rowKey: (r) => r.url, empty: 'No images were recorded on this page.' })}</div>`, insightPill('image-delivery-insight'));
  }

  function renderBlockingTab() {
    const rows = ins().renderBlocking;
    if (!rows) return card('Render-blocking requests', '', notCaptured('Render-blocking data'));
    const max = Math.max(0, ...rows.map((r) => r.wastedMs || 0));
    return card('Render-blocking requests', 'Stylesheets and synchronous scripts the browser must finish before it can paint anything. Inline critical CSS, defer the rest, and add <code>defer</code>/<code>async</code> to scripts.',
      `<div class="tbl-wrap">${table('rb', [
        { key: 'url', label: 'File / URL', render: (r) => esc(shortUrl(r.url)), cls: 'url', title: (r) => r.url, sortVal: (r) => shortUrl(r.url) },
        { key: 'domain', label: 'Domain', render: (r) => esc(host(r.url)), sortVal: (r) => host(r.url) },
        { key: 'type', label: 'Type', render: (r) => (/\.css/.test(r.url) ? 'CSS' : /\.js/.test(r.url) ? 'JS' : '—'), sortVal: (r) => r.url },
        { key: 'totalBytes', label: 'Size', render: (r) => fmtBytes(r.totalBytes) },
        { key: 'wastedMs', label: 'Delays paint by', render: (r) => barCell(r.wastedMs, max, fmtMs(r.wastedMs), 'poor') },
      ], rows, { defaultSort: 'wastedMs', rowKey: (r) => r.url, empty: 'Nothing blocks rendering on this page. 🎉' })}</div>`, insightPill('render-blocking-insight'));
  }

  function serverTab() {
    const d = state.detail;
    const b = d.ttfbBreakdown;
    const phases = b ? [['Redirects', b.redirectMs], ['DNS lookup', b.dnsMs], ['Connection', b.connectMs], ['TLS', b.tlsMs], ['Network latency', b.requestMs], ['Server processing', b.waitingMs]]
      .filter(([, v]) => v != null && v > 0.5).map(([label, durationMs]) => ({ label, durationMs })) : [];
    const doc = ins().documentLatency || {};
    return card('Time to first byte', b ? `The HTML document’s first byte arrived after <b>${fmtMs(b.totalMs)}</b>. Every other metric waits on this.` : '',
      phases.length ? `<div class="pad">${phaseBar(phases)}</div>` : '<div class="empty">No server timing breakdown was captured.</div>')
      + card('Document request checks', doc.serverResponseMs != null ? `Lighthouse observed a server response time of <b>${fmtMs(doc.serverResponseMs)}</b> (good is under 600 ms).` : '',
        doc.checks ? `<div class="pad">${checklistHtml(doc.checks)}</div>` : notCaptured('The document latency check'), insightPill('document-latency-insight'));
  }

  // FCP / CLS fonts -----------------------------------------------------
  function fontRows() {
    const byUrl = new Map();
    for (const f of state.detail.resources?.fonts || []) byUrl.set(f.url, { ...f });
    for (const f of ins().fontDisplay || []) byUrl.set(f.url, { ...(byUrl.get(f.url) || { url: f.url }), wastedMs: f.wastedMs });
    return [...byUrl.values()];
  }
  function fontsTab(k) {
    const rows = fontRows();
    const max = Math.max(0, ...rows.map((r) => r.wastedMs || 0));
    const sub = k === 'CLS'
      ? 'Web fonts that swap in late re-flow text and shift the layout. Preload key fonts and use <code>font-display: optional</code> or a size-matched fallback.'
      : 'Fonts without <code>font-display: swap</code> keep text invisible until they download, delaying the first paint.';
    return card('Web fonts', sub, `<div class="tbl-wrap">${table('fonts', [
      { key: 'url', label: 'Font', render: (r) => esc(shortUrl(r.url)), cls: 'url', title: (r) => r.url, sortVal: (r) => shortUrl(r.url) },
      { key: 'domain', label: 'Domain', render: (r) => esc(host(r.url)), sortVal: (r) => host(r.url) },
      { key: 'fontDisplay', label: 'font-display', render: (r) => esc(r.fontDisplay || '—') },
      { key: 'transferSize', label: 'Size', render: (r) => fmtBytes(r.transferSize) },
      { key: 'wastedMs', label: 'Invisible text for', render: (r) => (r.wastedMs ? barCell(r.wastedMs, max, fmtMs(r.wastedMs), 'warn') : '<span class="c-muted">—</span>') },
    ], rows, { defaultSort: 'wastedMs', rowKey: (r) => r.url, empty: 'No web fonts were loaded on this page.' })}</div>`, insightPill('font-display-insight'));
  }

  function unusedTab(kind) {
    const rows = kind === 'css' ? ins().unusedCss : ins().unusedJs;
    const title = kind === 'css' ? 'Unused CSS' : 'Unused JavaScript';
    if (!rows) return card(title, '', notCaptured(title));
    const total = rows.reduce((a, r) => a + (r.wastedBytes || 0), 0);
    const sub = kind === 'css'
      ? `CSS rules downloaded but never applied on this page — <b>${fmtBytes(total)}</b> the browser parses before painting. Split or purge stylesheets per page.`
      : `JavaScript downloaded but never executed during load — <b>${fmtBytes(total)}</b> of parse and compile work on the main thread. Code-split or drop unused libraries.`;
    return card(title, sub, `<div class="tbl-wrap">${table(`unused-${kind}`, [
      { key: 'url', label: 'File / URL', render: (r) => esc(/^https?:/.test(r.url) ? shortUrl(r.url) : 'Inline'), cls: 'url', title: (r) => r.url, sortVal: (r) => shortUrl(r.url) },
      { key: 'domain', label: 'Domain', render: (r) => esc(/^https?:/.test(r.url) ? host(r.url) : '—'), sortVal: (r) => host(r.url) },
      { key: 'totalBytes', label: 'Size', render: (r) => fmtBytes(r.totalBytes) },
      { key: 'wastedBytes', label: 'Unused', render: (r) => fmtBytes(r.wastedBytes), cls: 'num' },
      { key: 'wastedPercent', label: '% unused', render: (r) => barCell(r.wastedPercent, 100, `${Math.round(r.wastedPercent || 0)}%`, (r.wastedPercent || 0) > 60 ? 'poor' : 'warn') },
    ], rows, { defaultSort: 'wastedBytes', rowKey: (r) => r.url, empty: `No significant ${title.toLowerCase()} was found. 🎉` })}</div>`, insightPill(kind === 'css' ? 'unused-css-rules' : 'unused-javascript'));
  }

  function chainTab() {
    const c = ins().requestChain;
    if (!c) return card('Critical request chain', '', notCaptured('The request chain'));
    let count = 0;
    const nodeHtml = (n, depth) => {
      if (++count > 120) return '';
      return `<li class="${n.isLongest ? 'longest' : ''}"><div class="chain-row" data-tip="${esc(esc(n.url))}"><span class="chain-url">${esc(depth === 0 ? n.url : shortUrl(n.url))}</span><span class="c-muted">${fmtBytes(n.transferSize)}</span><b>${fmtMs(n.endMs)}</b></div>
        ${n.children.length ? `<ul>${n.children.sort((a, b) => (b.endMs || 0) - (a.endMs || 0)).map((ch) => nodeHtml(ch, depth + 1)).join('')}</ul>` : ''}</li>`;
    };
    return card('Critical request chain', `Requests that had to load one after another before the page could render. The highlighted path is the longest — <b>${fmtMs(c.longestMs)}</b>. Shorten it by preloading late-discovered resources and removing chained imports.`,
      `<div class="pad"><ul class="chain">${c.roots.map((n) => nodeHtml(n, 0)).join('')}</ul></div>`);
  }

  // CLS -----------------------------------------------------------------
  function culpritsTab() {
    const rows = ins().clsCulprits;
    if (!rows) return card('Layout shift culprits', '', notCaptured('Layout shift culprit data'));
    if (!rows.length) return card('Layout shift culprits', '', '<div class="empty">No elements shifted during load. 🎉</div>');
    const max = Math.max(...rows.map((r) => r.score || 0));
    return card('Layout shift culprits', 'Elements that moved, how much each contributed, and what the browser saw cause it.',
      `<div class="culprits">${rows.map((r) => `<div class="culprit">
        <div class="culprit-h"><code>${esc(r.selector || r.label || 'Unknown element')}</code>${barCell(r.score, max, num(r.score, 4), (r.score || 0) >= 0.1 ? 'poor' : (r.score || 0) >= 0.05 ? 'warn' : '')}</div>
        ${r.causes.length ? `<ul class="causes">${r.causes.map((c) => `<li><span class="pill muted">${esc(c.cause)}</span>${c.url ? ` <span class="c-muted" title="${esc(c.url)}">${esc(shortUrl(c.url))}</span>` : ''}</li>`).join('')}</ul>` : '<div class="c-muted small">No specific cause reported.</div>'}
        ${codeSnippet(r.snippet)}</div>`).join('')}</div>`, insightPill('cls-culprits-insight'));
  }
  function unsizedTab() {
    const rows = ins().unsizedImages;
    if (!rows) return card('Unsized images', '', notCaptured('Unsized image data'));
    return card('Images without width & height', 'Without explicit dimensions the browser can’t reserve space, so content jumps when these load. Add <code>width</code> and <code>height</code> attributes (or <code>aspect-ratio</code>).',
      `<div class="tbl-wrap">${table('unsized', [
        { key: 'url', label: 'Image', render: (r) => esc(r.url ? shortUrl(r.url) : '—'), cls: 'url', title: (r) => r.url || '', sortVal: (r) => shortUrl(r.url || '') },
        { key: 'selector', label: 'Element', render: (r) => `<code>${esc(r.selector || '—')}</code>`, cls: 'url', title: (r) => r.selector || '' },
        { key: 'width', label: 'Shown at', render: (r) => (r.width ? `${Math.round(r.width)}×${Math.round(r.height)}` : '—') },
      ], rows, { defaultSort: 'width', rowKey: (r) => r.url || null, empty: 'Every image has explicit dimensions. 🎉' })}</div>`, insightPill('unsized-images'));
  }

  // INP / TBT -----------------------------------------------------------
  function thirdPartiesTab() {
    const rows = ins().thirdParties;
    if (!rows) return card('Third parties', '', notCaptured('Third-party data'));
    const max = Math.max(0, ...rows.map((r) => r.mainThreadMs || 0));
    return card('Third parties', 'External services by the main-thread time they cost. Delay non-essential tags until after load or user interaction, or load them through a facade.',
      `<div class="tbl-wrap">${table('tp', [
        { key: 'entity', label: 'Provider', render: (r) => `<b>${esc(r.entity)}</b> <span class="c-muted small">${r.urls.length} file${r.urls.length === 1 ? '' : 's'}</span>` },
        { key: 'transferSize', label: 'Transfer', render: (r) => fmtBytes(r.transferSize) },
        { key: 'mainThreadMs', label: 'Main-thread time', render: (r) => barCell(r.mainThreadMs, max, fmtMs(r.mainThreadMs), (r.mainThreadMs || 0) > 250 ? 'poor' : 'warn') },
      ], rows, { defaultSort: 'mainThreadMs', rowKey: (r) => r.urls[0]?.url || null, empty: 'No third-party code ran on this page.' })}</div>`, insightPill('third-parties-insight'));
  }
  function domTab() {
    const dom = ins().domSize;
    const reflow = ins().forcedReflow;
    const stats = dom ? `<div class="ov-grid" style="padding:0 10px 10px">${dom.map((x) => `<div class="ov-tile" style="cursor:default"><div class="k">${esc(x.statistic)}</div><div class="v">${x.value == null ? '—' : num(x.value)}</div>${x.selector ? `<div class="c-muted small url" title="${esc(x.selector)}">${esc(x.selector)}</div>` : ''}</div>`).join('')}</div>` : notCaptured('DOM size data');
    const maxR = Math.max(0, ...(reflow || []).map((r) => r.reflowMs || 0));
    return card('DOM size', 'Large or deep DOMs make every style recalculation and layout slower — which is what an interaction has to wait for. Under ~1,400 elements is healthy.', stats, insightPill('dom-size-insight'))
      + card('Forced reflows', 'JavaScript that reads layout (e.g. <code>offsetWidth</code>) right after changing styles forces the browser to lay out synchronously, blocking interactions.',
        reflow ? `<div class="tbl-wrap">${table('reflow', [
          { key: 'source', label: 'Source', render: (r) => esc(/^https?:/.test(r.source) ? shortUrl(r.source) : r.source), cls: 'url', title: (r) => r.source },
          { key: 'reflowMs', label: 'Reflow time', render: (r) => barCell(r.reflowMs, maxR, fmtMs(r.reflowMs), 'warn') },
        ], reflow, { defaultSort: 'reflowMs', empty: 'No forced reflows were detected. 🎉' })}</div>` : notCaptured('Forced reflow data'), insightPill('forced-reflow-insight'));
  }

  function thresholdBar(k, v) {
    const m = METRICS[k];
    const max = m.poor * 1.5;
    const pct = (x) => Math.min(100, (x / max) * 100);
    const unit = k === 'CLS' ? (x) => num(x, 2) : (x) => fmtMs(x, { seconds: x >= 1000 });
    return `<div class="thresh">
      <div class="thresh-bar">
        <i style="width:${pct(m.good)}%;background:var(--good)"></i>
        <i style="width:${pct(m.poor) - pct(m.good)}%;background:var(--warn)"></i>
        <i style="flex:1;background:var(--poor)"></i>
        ${v != null ? `<span class="thresh-marker" style="left:calc(${pct(v)}% - 1px)" title="This page: ${esc(fmtMetric(k, v))}"></span>` : ''}
      </div>
      <div class="thresh-labels">
        <span style="left:0">Threshold</span>
        <span style="left:${pct(m.good)}%">${esc(unit(m.good))}</span>
        <span style="left:${pct(m.poor)}%">${esc(unit(m.poor))}</span>
        <span style="left:96%">${esc(unit(max))}</span>
      </div>
    </div>`;
  }

  // Timeline ("thread blocking") chart per metric.
  function metricChartCard(k) {
    const d = state.detail;
    const vit = d.vitals;
    const markers = [];
    const fcp = metricValue(vit, 'FCP');
    const lcp = metricValue(vit, 'LCP');
    let rows = [];
    let title = '';
    let sub = '';
    let legend = '';
    if (k === 'TBT' || k === 'INP') {
      title = `${k} Thread Blocking`;
      sub = `Every long task (≥ 50 ms) on the main thread${d.longTaskSource === 'lighthouse' ? ', from Lighthouse’s trace' : ''}. The darker end of each bar is its blocking portion — the time beyond 50 ms that counts toward TBT.`;
      rows = [...(d.longTasks || [])]
        .sort((a, b) => a.startMs - b.startMs)
        .map((t, i) => {
          const net = t.scriptUrl ? networkDomainInfo(t.scriptUrl) : null;
          const label = t.scriptUrl ? `${shortUrl(t.scriptUrl)}` : 'Unattributed task';
          const party = net ? (net.isThirdParty ? 'Third party' : 'First party') : t.scriptUrl ? 'Script' : '';
          return {
            key: t.scriptUrl || `task-${i}`,
            label: party && t.scriptUrl ? `${party} · ${label}` : label,
            start: t.startMs,
            dur: t.durationMs,
            blockFrac: Math.max(0, t.durationMs - LONG_TASK_MS) / t.durationMs,
            cls: net ? (net.isThirdParty ? 'third' : 'first') : '',
            tip: `<b>${esc(t.scriptUrl || 'Unattributed long task')}</b><br>Start ${fmtMs(t.startMs)} · duration ${fmtMs(t.durationMs)} · blocking ${fmtMs(Math.max(0, t.durationMs - LONG_TASK_MS))}`,
            select: t.scriptUrl || null,
          };
        });
      if (fcp != null) markers.push({ at: fcp, label: 'FCP' });
      if (lcp != null) markers.push({ at: lcp, label: 'LCP' });
    } else if (k === 'LCP' || k === 'FCP') {
      const cutoff = k === 'LCP' ? lcp : fcp;
      title = k === 'LCP' ? 'LCP Load Timeline' : 'Render Path Before First Paint';
      sub = k === 'LCP'
        ? 'How the largest element got on screen: its four phases, the LCP file itself, what was blocking rendering, then everything else requested before LCP. Colours are explained in the key.'
        : 'What had to load before anything appeared: the files blocking the first paint first, then every other request that started before it. Colours are explained in the key.';
      const lcpUrl = d.lcpEvidence?.imageUrl;
      if (k === 'LCP' && d.lcpEvidence?.phases) rows.push({ heading: 'LCP phases' });
      if (k === 'LCP' && d.lcpEvidence?.phases) {
        const ph = d.lcpEvidence.phases;
        let t = 0;
        [['TTFB', ph.ttfbMs, 'kind-good'], ['Resource load delay', ph.resourceLoadDelayMs, 'kind-warn'], ['Resource load duration', ph.resourceLoadDurationMs, 'phase-dur'], ['Element render delay', ph.elementRenderDelayMs, 'kind-poor']]
          .forEach(([label, ms, cls]) => {
            if (ms == null) return;
            rows.push({ key: `phase-${label}`, label: `${label} · ${fmtMs(ms)}`, start: t, dur: ms, cls, tip: `<b>${esc(label)}</b><br>${fmtMs(ms)}` });
            t += ms;
          });
      }
      const blocking = new Set((ins().renderBlocking || []).map((x) => x.url));
      const reqs = (d.network || [])
        .filter((r) => cutoff == null || r.requestStartMs <= cutoff)
        .sort((a, b) => a.requestStartMs - b.requestStartMs);
      // Grouped so the rows that matter can't be missed: the LCP file, then
      // what blocked rendering, then everything else (chronological in each).
      const lcpReq = k === 'LCP' && lcpUrl ? (d.network || []).find((r) => r.url === lcpUrl) : null;
      const blockers = reqs.filter((r) => blocking.has(r.url) && r !== lcpReq);
      const others = reqs.filter((r) => r !== lcpReq && !blocking.has(r.url));
      const role = (r) => (r === lcpReq ? 'role-lcp' : blocking.has(r.url) ? 'role-block' : `role-${TYPE_ROLE[r.resourceType] || 'other'}`);
      const labelled = (r) => {
        const row = netRow(role)(r);
        if (r === lcpReq) row.label = `★ LCP resource · ${shortUrl(r.url)}`;
        else if (blocking.has(r.url)) row.label = `Render-blocking · ${row.label}`;
        return row;
      };
      if (lcpReq) rows.push({ heading: 'The LCP resource' }, labelled(lcpReq));
      else if (k === 'LCP') rows.push({ heading: d.lcpEvidence?.imageUrl ? 'The LCP resource (not in the recorded requests)' : 'The LCP element is text — no separate file to load' });
      if (blockers.length) rows.push({ heading: `Blocking ${k === 'LCP' ? 'rendering' : 'the first paint'} (${blockers.length})` }, ...blockers.map(labelled));
      const shownOthers = others.slice(0, 80);
      if (shownOthers.length) rows.push({ heading: `Other requests that started before ${k} (${others.length}${others.length > shownOthers.length ? `, first ${shownOthers.length} shown` : ''})` }, ...shownOthers.map(labelled));
      if (cutoff != null) markers.push({ at: cutoff, label: k });
      legend = timelineLegend(k, Boolean(lcpReq), blockers.length > 0);
    } else if (k === 'CLS') {
      title = 'Layout Shift Timeline';
      sub = 'Each layout shift, placed at the moment it happened. Shifts right after user input don’t count toward CLS.';
      const shifts = d.clsEvidence?.shifts || [];
      rows = shifts.map((s, i) => ({
        key: `shift-${i}`,
        label: `${num(s.value, 3)} · ${s.sources?.[0]?.selector || 'unknown element'}`,
        start: s.timestampMs,
        dur: Math.max(16, s.value * 4000),
        cls: s.hadRecentInput ? '' : s.value >= 0.1 ? 'kind-poor' : s.value >= 0.05 ? 'kind-warn' : 'kind-good',
        tip: `<b>Shift ${num(s.value, 4)}</b>${s.hadRecentInput ? ' (after input — excluded)' : ''}<br>${esc((s.sources || []).map((x) => x.selector).filter(Boolean).join(', ') || 'No source element recorded')}<br>at ${fmtMs(s.timestampMs)}`,
      }));
      if (lcp != null) markers.push({ at: lcp, label: 'LCP' });
    } else if (k === 'TTFB') {
      title = 'Server Response Phases';
      sub = 'How the time to first byte of the HTML document breaks down.';
      const b = d.ttfbBreakdown || {};
      let t = 0;
      [['Redirect', b.redirectMs], ['DNS', b.dnsMs], ['Connect', b.connectMs], ['TLS', b.tlsMs], ['Request', b.requestMs], ['Server wait', b.waitingMs]]
        .forEach(([label, ms], i) => {
          if (ms == null) return;
          rows.push({ key: label, label: `${label} · ${fmtMs(ms)}`, start: t, dur: ms, cls: i === 5 ? 'kind-warn' : '', tip: `<b>${label}</b><br>${fmtMs(ms)}` });
          t += ms;
        });
    }
    const chart = rows.length
      ? gantt(rows, markers)
      : `<div class="empty">${k === 'TBT' || k === 'INP' ? 'No long tasks were recorded — the main thread never blocked for more than 50 ms.' : 'No timeline evidence was captured for this metric on this page.'}</div>`;
    return `<section class="card">
      <div class="card-h"><span class="card-t">${esc(title)}</span>
        <div class="card-tools">
          <div class="seg" role="group"><button data-scale="time" class="${state.chartScale === 'time' ? 'is-active' : ''}">Full load</button><button data-scale="fit" class="${state.chartScale === 'fit' ? 'is-active' : ''}">Zoomed</button></div>
        </div>
      </div>
      <div class="card-sub">${esc(sub)}</div>
      ${legend}
      <div class="gantt-wrap">${chart}</div>
    </section>`;
  }

  // Resource type → colour role for the request timelines.
  const TYPE_ROLE = { stylesheet: 'css', script: 'js', font: 'font', image: 'img', document: 'doc' };
  function timelineLegend(k, hasLcp, hasBlocking) {
    const item = (cls, label) => `<span class="lg-item"><i class="lg-sw ${cls}"></i>${label}</span>`;
    return `<div class="g-legend">
      ${k === 'LCP' ? `${item('kind-good', 'Server response')}${item('kind-warn', 'Load delay')}${item('phase-dur', 'Load duration')}${item('kind-poor', 'Render delay')}` : ''}
      ${hasLcp ? item('role-lcp', '<b>LCP resource</b>') : ''}${hasBlocking ? item('role-block', 'Render-blocking') : ''}
      ${item('role-css', 'Stylesheet')}${item('role-js', 'Script')}${item('role-font', 'Font')}${item('role-img', 'Image')}${item('role-other', 'Other')}
      <span class="lg-item c-muted">Faded = third party · white line = ${esc(k)}</span></div>`;
  }

  function netRow(extraCls) {
    return (r) => ({
      key: r.url,
      label: `${r.resourceType} · ${shortUrl(r.url)}`,
      start: r.requestStartMs,
      dur: Math.max(4, r.durationMs ?? (r.responseEndMs != null ? r.responseEndMs - r.requestStartMs : 4)),
      cls: `${r.isThirdParty ? 'third' : 'first'} ${extraCls ? extraCls(r) : ''}`,
      tip: `<b>${esc(r.url)}</b><br>${esc(r.resourceType)} · ${r.isThirdParty ? 'third party' : 'first party'} · ${fmtBytes(r.transferSize)}<br>start ${fmtMs(r.requestStartMs)} · ${fmtMs(r.durationMs)}${r.failed ? ' · <span class="c-poor">failed</span>' : ''}`,
      select: r.url,
    });
  }

  function niceStep(max, target = 9) {
    if (!(max > 0)) return 1; // an all-zero chart would otherwise loop forever
    const raw = max / target;
    const pow = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) || raw;
  }

  function gantt(rows, markers = []) {
    const bars = rows.filter((r) => !r.heading);
    if (!bars.length) return '<div class="empty">Nothing was recorded for this timeline.</div>';
    const minStart = state.chartScale === 'fit' ? Math.max(0, Math.min(...bars.map((r) => r.start), ...markers.map((m) => m.at)) * 0.97) : 0;
    const maxEnd = Math.max(...bars.map((r) => r.start + r.dur), ...markers.map((m) => m.at)) * 1.03;
    const span = Math.max(1, maxEnd - minStart);
    const x = (t) => ((t - minStart) / span) * 100;
    const step = niceStep(span);
    const ticks = [];
    for (let t = Math.ceil(minStart / step) * step; t <= maxEnd; t += step) ticks.push(t);
    const tickLabel = (t) => (span >= 3000 ? `${num(t / 1000, t % 1000 ? 1 : 0)}s` : `${Math.round(t)}ms`);
    const sel = state.selected;
    const rowHtml = rows
      .map((r) => {
        if (r.heading) return `<div class="g-head">${esc(r.heading)}</div>`;
        const left = x(r.start);
        const w = Math.max(0.35, (r.dur / span) * 100);
        const narrow = w < 14;
        const blk = r.blockFrac ? `<i class="blk" style="width:${(r.blockFrac * 100).toFixed(1)}%"></i>` : '';
        const isSel = sel && r.select === sel ? ' is-sel' : '';
        const lbl = `<span>${esc(r.label)}</span>`;
        const strong = /\brole-(lcp|block)\b/.test(r.cls || '') ? ` ${/role-lcp/.test(r.cls) ? 'lbl-lcp' : 'lbl-block'}` : '';
        return `<div class="g-row${/\brole-lcp\b/.test(r.cls || '') ? ' is-lcp-row' : ''}"><div class="g-bar ${esc(r.cls || '')}${isSel}" style="left:${left}%;width:${w}%" data-tip="${esc(r.tip || '')}"${r.select ? ` data-select="${esc(r.select)}"` : ''}>${blk}${narrow ? '' : lbl}</div>${narrow ? (left + w > 60 ? `<span class="g-lbl${strong}" style="right:calc(${100 - left}% + 4px)">${esc(r.label)}</span>` : `<span class="g-lbl${strong}" style="left:calc(${left + w}% + 4px)">${esc(r.label)}</span>`) : ''}</div>`;
      })
      .join('');
    return `<div class="gantt"><div class="gantt-inner" style="min-height:100%">
        <div class="gantt-grid">${ticks.map((t) => `<i style="left:${x(t)}%"></i>`).join('')}</div>
        ${markers.map((m, i) => `<div class="g-marker" style="left:${x(m.at)}%"><b style="top:${i > 0 && Math.abs(x(m.at) - x(markers[i - 1].at)) < 8 ? 13 : 1}px">${esc(m.label)}</b></div>`).join('')}
        <div style="padding:${markers.length > 1 ? 28 : 16}px 0 6px">${rowHtml}</div>
      </div></div>
      <div class="g-axis">${ticks.map((t) => `<span style="left:${x(t)}%">${tickLabel(t)}</span>`).join('')}</div>`;
  }

  // ----------------------------------------------------------------- tables
  function table(id, cols, rows, { defaultSort, rowKey, empty = 'Nothing recorded.' } = {}) {
    if (!rows.length) return `<div class="empty">${esc(empty)}</div>`;
    const sort = state.sort[id] || defaultSort;
    const col = cols.find((c) => c.key === sort);
    const sorted = col
      ? [...rows].sort((a, b) => {
          const av = col.sortVal ? col.sortVal(a) : a[col.key];
          const bv = col.sortVal ? col.sortVal(b) : b[col.key];
          if (typeof av === 'string' || typeof bv === 'string') return String(av ?? '').localeCompare(String(bv ?? ''));
          return (bv ?? -Infinity) - (av ?? -Infinity);
        })
      : rows;
    return `<table class="tbl"><thead><tr>${cols
      .map((c) => `<th data-sort="${esc(id)}:${esc(c.key)}" class="${c.key === sort ? 'sorted' : ''}">${esc(c.label)}</th>`)
      .join('')}</tr></thead><tbody>${sorted
      .map((r, i) => {
        const key = rowKey ? rowKey(r) : null;
        return `<tr${key ? ` data-select="${esc(key)}"` : ''} class="${key && key === state.selected ? 'is-sel' : ''}">${cols
          .map((c) => `<td class="${c.cls || ''}"${c.title ? ` title="${esc(c.title(r))}"` : ''}>${c.render ? c.render(r, i) : esc(r[c.key] ?? '—')}</td>`)
          .join('')}</tr>`;
      })
      .join('')}</tbody></table>`;
  }

  const SCRIPT_COLS = [
    { key: '#', label: '#', render: (_r, i) => i + 1, cls: 'dim' },
    { key: 'url', label: 'File / URL', render: (r) => esc(shortUrl(r.url)), cls: 'url', title: (r) => r.url, sortVal: (r) => shortUrl(r.url) },
    { key: 'domain', label: 'Domain', render: (r) => esc(r.domain || '—') },
    { key: 'attributedBlockingMs', label: 'Blocking Time', render: (r) => (r.attributedBlockingMs == null ? '<span class="c-muted">—</span>' : fmtMs(r.attributedBlockingMs)), cls: 'num' },
    { key: 'totalMs', label: 'Total Time', render: (r) => fmtMs(r.totalMs) },
    { key: 'attributedTaskCount', label: 'Tasks', render: (r) => r.attributedTaskCount || '<span class="c-muted">0</span>' },
  ];

  function scriptsCard(title, sub) {
    const scripts = state.detail.scripts || [];
    return `<section class="card">
      <div class="card-h"><span class="card-t">${esc(title)}</span></div>
      <div class="card-sub">${esc(sub)}</div>
      <div class="tbl-wrap">${table('scripts', SCRIPT_COLS, scripts, { defaultSort: 'attributedBlockingMs', rowKey: (r) => r.url, empty: 'Lighthouse didn’t measure any script execution on this page.' })}</div>
      <div class="note">Blocking time and task counts come only from long tasks whose own script URL names that file — tasks the browser couldn’t attribute are left out rather than guessed. Total time is Lighthouse’s measured main-thread time for the script.</div>
    </section>`;
  }

  function metricTableCard(k) {
    const d = state.detail;
    if (k === 'TBT' || k === 'INP') {
      return scriptsCard('Long Task Files', 'JavaScript files by main-thread cost. Sort by blocking time to see the biggest culprits.');
    }
    if (k === 'CLS') {
      const shifts = (d.clsEvidence?.shifts || []).map((s, i) => ({ ...s, i, selector: s.sources?.map((x) => x.selector).filter(Boolean).join(', ') || null }));
      return `<section class="card"><div class="card-h"><span class="card-t">Layout Shifts</span></div>
        <div class="card-sub">Every shift the browser recorded, largest first.</div>
        <div class="tbl-wrap">${table('shifts', [
          { key: 'i', label: '#', render: (r) => r.i + 1, cls: 'dim' },
          { key: 'selector', label: 'Element', render: (r) => esc(r.selector || 'Unknown element'), cls: 'url', title: (r) => r.selector || '' },
          { key: 'timestampMs', label: 'Time', render: (r) => fmtMs(r.timestampMs) },
          { key: 'value', label: 'Shift Score', render: (r) => num(r.value, 4), cls: 'num' },
          { key: 'hadRecentInput', label: 'Counts', render: (r) => (r.hadRecentInput ? '<span class="c-muted">No (after input)</span>' : 'Yes') },
        ], shifts, { defaultSort: 'value', empty: 'No layout shifts were recorded.' })}</div></section>`;
    }
    if (k === 'TTFB') {
      const b = d.ttfbBreakdown;
      const rows = b ? Object.entries(b).filter(([key]) => key !== 'totalMs').map(([key, ms]) => ({ phase: key.replace(/Ms$/, ''), ms })) : [];
      return `<section class="card"><div class="card-h"><span class="card-t">Response Phases</span></div>
        <div class="tbl-wrap">${table('ttfb', [
          { key: 'phase', label: 'Phase' },
          { key: 'ms', label: 'Time', render: (r) => fmtMs(r.ms), cls: 'num' },
        ], rows, { defaultSort: 'ms', empty: 'No server timing breakdown was captured.' })}</div></section>`;
    }
    const cutoff = metricValue(d.vitals, k);
    const reqs = (d.network || []).filter((r) => cutoff == null || r.requestStartMs <= cutoff);
    return `<section class="card"><div class="card-h"><span class="card-t">${k === 'LCP' ? 'Requests Before LCP' : 'Requests Before First Paint'}</span></div>
      <div class="card-sub">${reqs.length} requests started before ${k}. Sort by duration or size to spot what’s in the way.</div>
      <div class="tbl-wrap">${networkTable(reqs, `req-${k}`)}</div></section>`;
  }

  function networkTable(reqs, id) {
    return table(id, [
      { key: '#', label: '#', render: (_r, i) => i + 1, cls: 'dim' },
      { key: 'url', label: 'File / URL', render: (r) => esc(shortUrl(r.url)), cls: 'url', title: (r) => r.url, sortVal: (r) => shortUrl(r.url) },
      { key: 'domain', label: 'Domain' },
      { key: 'resourceType', label: 'Type' },
      { key: 'requestStartMs', label: 'Start', render: (r) => fmtMs(r.requestStartMs), sortVal: (r) => -r.requestStartMs },
      { key: 'durationMs', label: 'Duration', render: (r) => fmtMs(r.durationMs), cls: 'num' },
      { key: 'transferSize', label: 'Size', render: (r) => fmtBytes(r.transferSize) },
    ], reqs, { defaultSort: 'requestStartMs', rowKey: (r) => r.url, empty: 'No network requests were recorded.' });
  }

  function longTasksCard() {
    const tasks = (state.detail.longTasks || []).map((t, i) => ({ ...t, i, blockingMs: Math.max(0, t.durationMs - LONG_TASK_MS) }));
    const total = tasks.reduce((a, t) => a + t.blockingMs, 0);
    return `<section class="card"><div class="card-h"><span class="card-t">Long Tasks</span><span class="pill info">${fmtMs(total)} blocking in total</span></div>
      <div class="card-sub">Main-thread tasks longer than 50 ms, as recorded ${state.detail.longTaskSource === 'lighthouse' ? 'in Lighthouse’s trace' : 'by the Chrome DevTools Protocol'} during load.</div>
      <div class="tbl-wrap">${table('longtasks', [
        { key: 'i', label: '#', render: (r) => r.i + 1, cls: 'dim', sortVal: (r) => -r.i },
        { key: 'scriptUrl', label: 'Script', render: (r) => (r.scriptUrl ? esc(shortUrl(r.scriptUrl)) : '<span class="c-muted">Unattributed</span>'), cls: 'url', title: (r) => r.scriptUrl || '' },
        { key: 'startMs', label: 'Start', render: (r) => fmtMs(r.startMs), sortVal: (r) => -r.startMs },
        { key: 'durationMs', label: 'Duration', render: (r) => fmtMs(r.durationMs) },
        { key: 'blockingMs', label: 'Blocking', render: (r) => fmtMs(r.blockingMs), cls: 'num' },
      ], tasks, { defaultSort: 'blockingMs', rowKey: (r) => r.scriptUrl || null, empty: 'No long tasks were recorded.' })}</div></section>`;
  }

  function networkChartCard() {
    const reqs = [...(state.detail.network || [])].sort((a, b) => a.requestStartMs - b.requestStartMs).slice(0, 150);
    const markers = [];
    const fcp = metricValue(state.detail.vitals, 'FCP');
    const lcp = metricValue(state.detail.vitals, 'LCP');
    if (fcp != null) markers.push({ at: fcp, label: 'FCP' });
    if (lcp != null) markers.push({ at: lcp, label: 'LCP' });
    return `<section class="card"><div class="card-h"><span class="card-t">Network Waterfall</span>
      <div class="card-tools"><div class="seg"><button data-scale="time" class="${state.chartScale === 'time' ? 'is-active' : ''}">Full load</button><button data-scale="fit" class="${state.chartScale === 'fit' ? 'is-active' : ''}">Zoomed</button></div></div></div>
      <div class="card-sub">${(state.detail.network || []).length} requests${reqs.length < (state.detail.network || []).length ? ` (first ${reqs.length} shown)` : ''}. Lighter bars are third-party.</div>
      <div class="gantt-wrap">${reqs.length ? gantt(reqs.map(netRow()), markers) : '<div class="empty">No network requests were recorded.</div>'}</div></section>`;
  }
  function networkTableCard() {
    return `<section class="card"><div class="card-h"><span class="card-t">Requests</span></div><div class="tbl-wrap">${networkTable(state.detail.network || [], 'net-all')}</div></section>`;
  }

  /** Lab INP: the engine tapped real buttons/menus on a slowed-down phone and timed the response. */
  function labInteractionsCard() {
    const ev = state.detail?.interactionEvidence;
    if (!ev) return card('Tested in the lab', '', '<div class="empty">This audit didn’t test interactions — re-run the audit to measure how fast the page responds to taps.</div>');
    if (!ev.tested?.length) return card('Tested in the lab', '', `<div class="empty">No safe buttons, menus or fields were found to test${ev.skippedReason ? ` (${esc(ev.skippedReason)})` : ''}.</div>`);
    const worst = ev.worstMs;
    const r = rating('INP', worst);
    const rows = [...ev.tested].sort((a, b) => b.durationMs - a.durationMs).map((t) => {
      const parts = [['Waiting to start', t.inputDelayMs, 'wait'], ['Running the code', t.processingMs, 'run'], ['Updating the screen', t.presentationMs, 'paint']];
      const total = Math.max(1, t.durationMs);
      const label = t.label.length > 70 ? `${t.label.slice(0, 68)}…"` : t.label;
      return `<tr class="no-hover"><td class="inp-what"><b title="${esc(t.label)}">${esc(label)}</b><div class="c-muted small tech-only sel-trunc" title="${esc(t.selector)}"><code>${esc(t.selector)}</code></div></td>
        <td class="num"><b class="c-${rating('INP', t.durationMs)}">${esc(fmtMs(t.durationMs))}</b></td>
        <td><div class="inp-bar">${parts.map(([l, ms, c]) => `<i class="${c}" style="width:${((ms || 0) / total) * 100}%" data-tip="${esc(esc(`${l}: ${fmtMs(ms)}`))}"></i>`).join('')}</div></td>
        <td class="small">${t.scripts?.length ? esc(t.scripts.slice(0, 2).map((x) => `${shortUrl(x.url)} (${fmtMs(x.durationMs)})`).join(', ')) : '<span class="c-muted">—</span>'}</td></tr>`;
    }).join('');
    const slow = ev.worst;
    const dominant = slow ? [['inputDelayMs', 'the page was busy with other work when the tap came in, so it had to wait'], ['processingMs', 'the code that runs on this tap is slow'], ['presentationMs', 'redrawing the page after the tap is heavy']].sort((a, b) => (slow[b[0]] || 0) - (slow[a[0]] || 0))[0][1] : '';
    return card('Tested in the lab', `The engine tapped ${ev.tested.length} thing${ev.tested.length === 1 ? '' : 's'} on this page on a ${ev.cpuSlowdown > 1 ? `phone slowed ${ev.cpuSlowdown}× (like a mid-range device)` : 'desktop'} and timed how long each took to respond. Slowest: <b class="c-${r}">${esc(fmtMs(worst))}</b>${slow ? ` (${esc(slow.label)}) — mostly because ${esc(dominant)}` : ''}. Google’s “good” limit is 200 ms.`,
      `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>What was tapped</th><th>Response</th><th>Where the time went</th><th>Scripts involved</th></tr></thead><tbody>${rows}</tbody></table></div>
      <div class="inp-legend"><span><i class="wait"></i>Waiting to start</span><span><i class="run"></i>Running the code</span><span><i class="paint"></i>Updating the screen</span></div>
      <div class="note">A lab estimate from a few taps — real visitors (the Real Users tab) are what Google uses for INP.</div>`);
  }

  // --------------------------------------------------------- try-a-fix view
  // Changes applied only inside the test browser, measured against the page
  // as-is. Options load on demand; a running experiment is polled.
  async function ensureExperiments(force = false) {
    const key = `${state.auditId}|${state.pageId}`;
    if (!force && state.exp?.key === key) return;
    const prev = state.exp?.key === key ? state.exp : null;
    state.exp = { key, data: prev?.data ?? null, error: null, picked: prev?.picked ?? { fixes: new Set(), block: new Set() } };
    try {
      const data = await api(`/api/audits/${encodeURIComponent(state.auditId)}/dashboard/pages/${encodeURIComponent(state.pageId)}/experiments`);
      if (state.exp?.key !== key) return;
      state.exp.data = data;
      if (data.active) pollExperiment(data.active.id, key);
    } catch (err) {
      if (state.exp?.key === key) state.exp.error = err.message;
    }
    if (state.view === 'experiments') render();
  }
  function pollExperiment(id, key) {
    clearTimeout(pollExperiment.t);
    pollExperiment.t = setTimeout(async () => {
      if (state.exp?.key !== key) return;
      let job;
      try { job = await api(`/api/experiments/${encodeURIComponent(id)}`); } catch { return; }
      if (state.exp?.key !== key) return;
      state.exp.data.active = job.status === 'queued' || job.status === 'running' ? job : null;
      if (job.status === 'done') { toast('Experiment finished'); await ensureExperiments(true); return; }
      if (job.status === 'failed') { toast(`The experiment couldn’t run: ${job.error || 'unknown error'}`, 7000); state.exp.data.active = null; }
      if (state.view === 'experiments') render();
      if (job.status === 'queued' || job.status === 'running') pollExperiment(id, key);
    }, 2500);
  }

  function renderExperimentsView() {
    ensureExperiments();
    const e = state.exp;
    const head = `<section class="card hero" style="padding-bottom:10px"><div class="hero-title">Try a fix <span class="pill muted">${esc(pagePath(state.detail.url))} · ${esc(state.device)}</span></div>
      <div class="hero-desc" style="margin-left:0">Test a change before anyone touches the site: the engine loads the page several times as it is and several times with your changes applied — in its own test browser only — then compares. Nothing on your real site changes.</div></section>`;
    if (!e?.data && !e?.error) return `${head}<div class="empty">Loading…</div>`;
    if (e.error) return `${head}<div class="card"><div class="empty">${esc(e.error)}</div></div>`;
    const d = e.data;
    const running = d.active;
    const fixRows = d.fixes.map((f) => `<label class="exp-opt${f.available ? '' : ' is-na'}"><input type="checkbox" data-exp-fix="${esc(f.id)}" ${e.picked.fixes.has(f.id) ? 'checked' : ''} ${f.available && !running ? '' : 'disabled'}>
        <span><b>${esc(f.title)}</b><small>${esc(f.available ? f.why : 'Doesn’t apply to this page')}</small><small class="c-muted">${esc(f.description)}</small></span></label>`).join('');
    const tpRows = d.thirdParties.map((t) => `<label class="exp-opt"><input type="checkbox" data-exp-block="${esc(t.domains[0])}" ${t.domains.every((x) => e.picked.block.has(x)) ? 'checked' : ''} ${running ? 'disabled' : ''}>
        <span><b>${esc(t.entity)}</b><small>${esc(t.purpose)}</small><small class="c-muted">${esc(fmtBytes(t.transferBytes))}${t.blockingMs != null ? ` · ${esc(fmtMs(t.blockingMs))} blocking` : ''} · ${esc(t.domains.slice(0, 2).join(', '))}</small></span></label>`).join('');
    const count = e.picked.fixes.size + e.picked.block.size;
    const action = running
      ? `<div class="exp-running"><div class="spinner"></div><div><b>${running.status === 'queued' ? 'Waiting to start…' : `Measuring… ${running.done} of ${running.total} page loads`}</b><div class="c-muted small">About ${state.device === 'mobile' ? '1–3' : '1'} minute${state.device === 'mobile' ? 's' : ''}. You can keep using the dashboard.</div></div></div>`
      : `<div class="f-actions"><button class="btn btn-primary" data-exp-run ${count ? '' : 'disabled'}>Run experiment${count ? ` (${count} change${count === 1 ? '' : 's'})` : ''}</button><span class="c-muted small">3 loads as-is and 3 with the changes, alternating, on a simulated ${state.device === 'mobile' ? 'mid-range phone over slow 4G' : 'desktop'}.</span></div>`;
    const setup = `<section class="card"><div class="card-h"><span class="card-t">1 · Pick changes to try</span></div>
        ${d.hasSource ? '' : '<div class="pad c-muted small">This audit didn’t capture the page’s source, so fewer fixes are suggested — re-run the audit for all of them.</div>'}
        <div class="exp-grid">${fixRows}</div></section>
      ${d.thirdParties.length ? `<section class="card"><div class="card-h"><span class="card-t">2 · Switch off an outside service (optional)</span></div><div class="card-sub">See how much faster the page is without it — useful for deciding whether a tool is worth keeping.</div><div class="exp-grid">${tpRows}</div></section>` : ''}
      <section class="card"><div class="pad">${action}</div></section>`;
    return `${head}${setup}${(d.history || []).map((h, i) => experimentResultCard(h, i === 0)).join('')}`;
  }

  function experimentResultCard(h, open) {
    const r = h.result;
    const b = r.baseline.median;
    const v = r.variant.median;
    const rows = [['LCP', 'lcpMs'], ['FCP', 'fcpMs'], ['CLS', 'cls'], ['TBT', 'tbtMs']].map(([k, key]) => {
      const verdict = changeVerdict(k, b[key], v[key]);
      return `<tr class="no-hover"><td>${esc(METRICS[k].name)} <span class="c-muted">(${k})</span></td><td class="num">${esc(fmtMetric(k, b[key]))}</td><td class="num"><b class="c-${v[key] == null ? 'muted' : rating(k, v[key])}">${esc(fmtMetric(k, v[key]))}</b></td>
        <td>${verdict ? `<span class="c-${verdict.tone}">${verdict.tone === 'good' ? '▼ better' : verdict.tone === 'poor' ? '▲ worse' : '≈ same'}</span>` : '—'}</td></tr>`;
    }).join('');
    const better = ['LCP', 'FCP', 'CLS', 'TBT'].filter((k) => changeVerdict(k, b[{ LCP: 'lcpMs', FCP: 'fcpMs', CLS: 'cls', TBT: 'tbtMs' }[k]], v[{ LCP: 'lcpMs', FCP: 'fcpMs', CLS: 'cls', TBT: 'tbtMs' }[k]])?.tone === 'good');
    const worse = ['LCP', 'FCP', 'CLS', 'TBT'].filter((k) => changeVerdict(k, b[{ LCP: 'lcpMs', FCP: 'fcpMs', CLS: 'cls', TBT: 'tbtMs' }[k]], v[{ LCP: 'lcpMs', FCP: 'fcpMs', CLS: 'cls', TBT: 'tbtMs' }[k]])?.tone === 'poor');
    const headline = better.length && !worse.length ? ['good', `Worth doing: ${better.join(', ')} improved and nothing got worse.`]
      : worse.length && !better.length ? ['poor', `Not worth it as-is: ${worse.join(', ')} got worse.`]
        : better.length ? ['muted', `Mixed: ${better.join(', ')} improved, ${worse.join(', ')} got worse.`]
          : ['muted', 'No real difference — within normal test-to-test variation.'];
    const tried = [...r.fixes.map((f) => state.exp.data.fixes.find((x) => x.id === f)?.title || f), ...r.block.map((d) => `Without ${d}`)];
    return `<section class="card"><details class="exp-result"${open ? ' open' : ''}><summary><span class="card-t">${esc(fmtDate(h.createdAt))}</span> <span class="c-muted small">${esc(tried.join(' + '))}</span> <span class="pill ${headline[0]}">${headline[0] === 'good' ? 'Better' : headline[0] === 'poor' ? 'Worse' : 'No clear change'}</span></summary>
      <div class="pad"><div class="ba-verdict ${headline[0]}">${esc(headline[1])}</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Metric</th><th>As it is</th><th>With the change</th><th></th></tr></thead><tbody>${rows}
        <tr class="no-hover"><td class="c-muted">Data downloaded</td><td class="num c-muted">${esc(fmtBytes(b.bytes))}</td><td class="num c-muted">${esc(fmtBytes(v.bytes))}</td><td></td></tr></tbody></table></div>
      ${r.notes.length ? `<h4 class="sw-h">What was changed in the test</h4><ul class="plain-list">${r.notes.slice(0, 20).map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
      ${r.blockedRequests ? `<div class="c-muted small">${r.blockedRequests} request${r.blockedRequests === 1 ? '' : 's'} to the switched-off service${r.block.length === 1 ? '' : 's'} were blocked.</div>` : ''}
      <div class="note">Medians of ${r.baseline.runs.length} loads each, measured by this engine (not a Lighthouse score). Check the site still works after making a change like this for real — especially when deferring scripts.</div></div></details></section>`;
  }

  // ------------------------------------------------------------ source view
  // Loaded on demand — the analysis, the HTML itself and file contents are
  // separate requests so the rest of the dashboard never waits on them.
  const SOURCE_TABS = [
    ['issues', 'Code issues'],
    ['head', '<head>'],
    ['code', 'View code'],
    ['added', 'Added by JS'],
    ['coverage', 'Unused code'],
    ['critical', 'Critical CSS'],
    ['tags', 'Tag Manager'],
    ['changes', 'Changes'],
  ];
  const AREA_LABEL = { loading: 'Loading', images: 'Images', fonts: 'Fonts', scripts: 'Scripts', styles: 'Stylesheets', 'third-party': 'Third parties', seo: 'SEO', accessibility: 'Accessibility', html: 'HTML' };

  async function ensureSource() {
    const key = `${state.auditId}|${state.pageId}`;
    if (state.source?.key === key) return;
    state.source = { key, data: null, html: {}, error: null };
    try {
      const data = await api(`/api/audits/${encodeURIComponent(state.auditId)}/dashboard/pages/${encodeURIComponent(state.pageId)}/source`);
      if (state.source?.key !== key) return;
      state.source.data = data;
    } catch (err) {
      if (state.source?.key === key) state.source.error = err.message;
    }
    if (state.view === 'source') render();
  }
  async function ensureHtml(kind) {
    const s = state.source;
    if (!s || s.html[kind] !== undefined) return;
    s.html[kind] = null;
    try {
      const r = await api(`/api/audits/${encodeURIComponent(state.auditId)}/dashboard/pages/${encodeURIComponent(state.pageId)}/source/html?kind=${kind}`);
      if (state.source === s) s.html[kind] = r.html;
    } catch (err) {
      if (state.source === s) s.html[kind] = { error: err.message };
    }
    if (state.view === 'source' && state.sourceTab === 'code') render();
  }

  function renderSourceView() {
    ensureSource();
    const s = state.source;
    const head = `<section class="card hero" style="padding-bottom:10px"><div class="hero-title">Source code <span class="pill muted">${esc(pagePath(state.detail.url))} · ${esc(state.device)}</span></div>
      <div class="hero-desc" style="margin-left:0">What the page’s own HTML and code reveal — with the exact line to change. Captured in a separate, unthrottled load of the page.</div></section>`;
    if (!s?.data && !s?.error) return `${head}<div class="empty">Loading the page’s source…</div>`;
    if (s.error) return `${head}<div class="card"><div class="empty">Couldn’t load the source: ${esc(s.error)}</div></div>`;
    const d = s.data;
    if (!d.available) return `${head}<div class="card"><div class="empty">No source was captured for this page — this audit ran before the engine read page source. <b>Re-run the audit</b> to get it.</div></div>`;
    const tab = SOURCE_TABS.some(([id]) => id === state.sourceTab) ? state.sourceTab : 'issues';
    const count = { issues: d.analysis?.issues.length, head: d.analysis?.head.length, coverage: d.coverage?.files.length, tags: d.tagManagers?.reduce((a, c) => a + c.tags.length, 0), added: d.analysis ? d.analysis.injected.scripts.length + d.analysis.injected.stylesheets.length + d.analysis.injected.images.length + d.analysis.injected.iframes.length : 0 };
    const tabs = `<nav class="tabs">${SOURCE_TABS.filter(([id]) => (id !== 'tags' || d.tagManagers?.length) && (id !== 'changes' || d.diff) && (id !== 'critical' || d.criticalCss)).map(([id, label]) => `<button data-source-tab="${id}" class="${tab === id ? 'is-active' : ''}">${esc(label)}${count[id] != null ? ` (${count[id]})` : ''}</button>`).join('')}</nav>`;
    const body = { issues: sourceIssuesTab, head: sourceHeadTab, code: sourceCodeTab, added: sourceAddedTab, coverage: sourceCoverageTab, critical: sourceCriticalTab, tags: sourceTagsTab, changes: sourceChangesTab }[tab](d);
    return `${head}${sourceStatsCard(d)}<section class="card tabs-card">${tabs}</section>${body}`;
  }

  function sourceStatsCard(d) {
    const a = d.analysis;
    if (!a) return '';
    const st = a.stats;
    const tile = (k, v, tone = '') => `<div class="ov-tile" style="cursor:default"><div class="k">${esc(k)}</div><div class="v ${tone}" style="font-size:18px">${esc(v)}</div></div>`;
    const c = d.coverage?.totals;
    const pct = (t) => (t && t.bytes ? `${Math.round(((t.bytes - t.usedBytes) / t.bytes) * 100)}% unused` : '—');
    return `<section class="card"><div class="ov-grid" style="padding:12px 10px 10px">
        ${tile('HTML size', fmtBytes(st.htmlBytes), st.htmlBytes > 500_000 ? 'c-poor' : '')}
        ${tile('Elements on the page', st.domElements != null ? num(st.domElements) : num(st.rawElements), (st.domElements ?? 0) > 1500 ? 'c-warn' : '')}
        ${tile('Scripts / stylesheets', `${st.externalScripts} / ${st.externalStylesheets}`)}
        ${tile('Images / iframes', `${st.images} / ${st.iframes}`)}
        ${tile('Inline code', fmtBytes(st.inlineScriptBytes + st.inlineStyleBytes), st.inlineScriptBytes + st.inlineStyleBytes > 50_000 ? 'c-warn' : '')}
        ${c ? tile('JavaScript', pct(c.js), c.js.bytes && c.js.usedBytes / c.js.bytes < 0.5 ? 'c-warn' : '') : ''}
        ${c ? tile('CSS', pct(c.css), c.css.bytes && c.css.usedBytes / c.css.bytes < 0.5 ? 'c-warn' : '') : ''}
      </div>
      <div class="src-meta tech-only">${[['Title', a.meta.title], ['Description', a.meta.description], ['Built with', a.meta.generator], ['Viewport', a.meta.viewport], ['Language', a.meta.lang]].filter(([, v]) => v).map(([k, v]) => `<span><b>${esc(k)}:</b> ${esc(v)}</span>`).join('')}</div></section>`;
  }

  function codeBlock(snippet, lines) {
    if (!snippet) return '';
    return `<div class="src-snip"><span class="src-ln">${esc(lines?.length ? `line ${lines.join(', ')}` : '')}</span><code>${esc(snippet)}</code></div>`;
  }
  function sourceIssuesTab(d) {
    const issues = d.analysis?.issues || [];
    if (!issues.length) return card('Issues in the code', '', '<div class="empty">No problems found in this page’s HTML. 🎉</div>');
    const sev = { high: 'poor', medium: 'warn', low: 'info' };
    const groups = {};
    for (const i of issues) (groups[i.area] ||= []).push(i);
    return Object.entries(groups).map(([area, list]) => `<section class="card"><div class="card-h"><span class="card-t">${esc(AREA_LABEL[area] || area)}</span><span class="pill muted">${list.length}</span></div>
      <div class="findings">${list.map((i, n) => `<details class="finding"${n === 0 && area === Object.keys(groups)[0] ? ' open' : ''}>
        <summary><span class="pill ${sev[i.severity] || 'muted'}">${esc(i.severity)}</span><span class="f-title">${esc(i.title)}</span><span class="chip-owner" title="Who usually fixes this">${esc(OWNER_LABEL[i.owner] || i.owner)}</span>${i.lines?.length ? `<span class="pill muted">line ${esc(i.lines.slice(0, 3).join(', '))}${i.lines.length > 3 ? '…' : ''}</span>` : ''}</summary>
        <div class="f-body"><div>${esc(i.detail)}</div>
          ${codeBlock(i.snippet, i.lines?.slice(0, 3))}
          ${i.fix ? `<h4>Fix</h4><div>${esc(i.fix)}</div>` : ''}
          ${i.fixCode ? `<div class="src-fix"><div class="src-fix-h">Change it to <button class="rcard-link" data-copy-text="${esc(i.fixCode)}">Copy</button></div><pre><code>${esc(i.fixCode)}</code></pre></div>` : ''}
          ${i.lines?.length ? `<div class="f-actions"><button class="btn btn-ghost btn-sm" data-source-line="${i.lines[0]}">View line ${i.lines[0]} in the code →</button></div>` : ''}
        </div></details>`).join('')}</div></section>`).join('');
  }

  function sourceHeadTab(d) {
    const items = d.analysis?.head || [];
    if (!items.length) return card('The <head>', '', '<div class="empty">No &lt;head&gt; section was found.</div>');
    const blocking = items.filter((h) => h.blocking).length;
    return card('The <head>, in order', `Everything the browser reads before it can show the page, top to bottom. <b>${blocking}</b> item${blocking === 1 ? '' : 's'} must finish loading before anything appears (red). The fewer and later the better.`,
      `<div class="tbl-wrap"><table class="tbl head-tbl"><thead><tr><th>Line</th><th>What</th><th>Details</th><th></th></tr></thead><tbody>${items.map((h) => `<tr class="${h.blocking ? 'is-blocking' : ''}" data-source-line="${h.line}" title="Click to view line ${h.line}">
        <td class="num">${h.line}</td><td><span class="pill ${h.blocking ? 'poor' : 'muted'}">${esc(h.kind)}</span></td>
        <td><div>${esc(h.label)}</div>${h.note ? `<div class="c-muted small">${esc(h.note)}</div>` : ''}<code class="head-snip tech-only">${esc(h.snippet)}</code></td>
        <td>${h.blocking ? '<span class="c-poor small">Blocks rendering</span>' : ''}</td></tr>`).join('')}</tbody></table></div>`);
  }

  function sourceCodeTab(d) {
    const kind = state.sourceKind === 'rendered' && d.hasRendered ? 'rendered' : 'raw';
    ensureHtml(kind);
    const html = state.source.html[kind];
    const toggle = `<div class="seg" role="group" aria-label="Which HTML"><button data-source-kind="raw" class="${kind === 'raw' ? 'is-active' : ''}">As sent by the server</button><button data-source-kind="rendered" class="${kind === 'rendered' ? 'is-active' : ''}" ${d.hasRendered ? '' : 'disabled'}>After scripts ran</button></div>`;
    if (html == null) return card('Page code', '', '<div class="empty">Loading the code…</div>', `<div class="card-tools">${toggle}</div>`);
    if (html.error) return card('Page code', '', `<div class="empty">${esc(html.error)}</div>`, `<div class="card-tools">${toggle}</div>`);
    // Lines named by issues are marked; the one asked for is highlighted and scrolled to.
    const flagged = new Set(kind === 'raw' ? (d.analysis?.issues || []).flatMap((i) => i.lines || []) : []);
    const lines = html.split('\n');
    const MAX = 6000;
    const q = (state.sourceSearch || '').toLowerCase();
    const target = kind === 'raw' ? state.sourceLine : null;
    // Show the first MAX lines — or, for a line further down, a window around it.
    const from = target && target > MAX ? Math.max(0, target - MAX / 2) : 0;
    const shown = q ? lines.map((l, i) => [l, i]).filter(([l]) => l.toLowerCase().includes(q)).slice(0, MAX) : lines.slice(from, from + MAX).map((l, i) => [l, from + i]);
    const rows = shown.map(([l, i]) => {
      const n = i + 1;
      const text = l.length > 2000 ? `${l.slice(0, 2000)} … (${num(l.length - 2000)} more characters)` : l;
      return `<div class="cl${flagged.has(n) ? ' flag' : ''}${target === n ? ' target' : ''}" id="L${n}"><span class="cn">${n}</span><span class="ct">${esc(text)}</span></div>`;
    }).join('');
    const search = `<input class="scope-search src-search" type="search" placeholder="Search the code…" value="${esc(state.sourceSearch || '')}" data-source-search aria-label="Search the code">`;
    return card(`Page code · ${kind === 'raw' ? 'as sent by the server' : 'after scripts ran'}`, `${num(lines.length)} lines${q ? ` · ${num(shown.length)} match${shown.length === 1 ? '' : 'es'}` : lines.length > MAX ? ` (lines ${num(from + 1)}–${num(Math.min(lines.length, from + MAX))} shown)` : ''}. Lines with an issue are marked in red${target ? `; line ${target} is highlighted` : ''}.${kind === 'raw' ? '' : ' This is the page after JavaScript changed it — compare with “As sent” to see what scripts added.'}`,
      `<div class="pad" style="padding-top:0">${search}</div><div class="code-view">${rows || '<div class="empty">No lines match.</div>'}</div>`, `<div class="card-tools">${toggle}</div>`);
  }

  function sourceAddedTab(d) {
    const inj = d.analysis?.injected;
    if (!inj || inj.elementsAdded == null) return card('Added by scripts', '', '<div class="empty">The page after scripts ran wasn’t captured, so there’s nothing to compare.</div>');
    const list = (label, xs) => (xs.length ? `<h4 class="sw-h">${esc(label)} (${xs.length})</h4><ul class="plain-list">${xs.slice(0, 30).map((u) => `<li title="${esc(u)}"><code>${esc(u.length > 110 ? `${u.slice(0, 110)}…` : u)}</code></li>`).join('')}${xs.length > 30 ? `<li class="c-muted">+${xs.length - 30} more</li>` : ''}</ul>` : '');
    const lcp = inj.lcpOnlyInRendered === true
      ? '<div class="src-alert poor">⚠️ The main (LCP) image is <b>not in the HTML the server sends</b> — JavaScript adds it later, so the browser can’t start downloading it early. Put the image in the HTML directly (or preload it).</div>'
      : inj.lcpOnlyInRendered === false ? '<div class="src-alert good">✓ The main (LCP) image is in the HTML the server sends, so the browser can find it early.</div>' : '';
    return card('Added by scripts', `What JavaScript added after the page arrived — about <b>${num(inj.elementsAdded)}</b> elements in total. Things added late load late; anything important for the first screen should be in the HTML itself.`,
      `<div class="pad">${lcp}${list('Scripts', inj.scripts)}${list('Stylesheets', inj.stylesheets)}${list('Images', inj.images)}${list('Iframes', inj.iframes)}${!inj.scripts.length && !inj.stylesheets.length && !inj.images.length && !inj.iframes.length ? '<div class="c-muted small">Scripts didn’t add any files to the page.</div>' : ''}</div>`);
  }

  function sourceCoverageTab(d) {
    const files = d.coverage?.files || [];
    if (!files.length) return card('Unused code', '', '<div class="empty">No script or stylesheet coverage was recorded.</div>');
    return card('Unused code', 'How much of each file actually ran while the page loaded. Code that only runs on a click or scroll counts as unused here, so treat this as “not needed to show the page”. Click a file to see exactly which parts ran.',
      `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>File</th><th>Size</th><th>Used during load</th><th>Unused</th><th>What to do</th></tr></thead><tbody>${files.slice(0, 40).map((f) => `<tr data-source-file="${esc(f.contentHash)}" title="${esc(f.url)}">
        <td><b>${esc(f.label && f.label.length > 4 ? f.label : shortUrl(f.url))}</b> <span class="pill muted">${f.type.toUpperCase()}</span>${f.loads > 1 ? ` <span class="pill warn" title="The page loads this same file ${f.loads} times">loaded ${f.loads}×</span>` : ''}${f.renderBlocking ? ' <span class="pill poor">blocks rendering</span>' : ''}${f.isThirdParty ? ' <span class="pill muted">third party</span>' : ''}</td>
        <td class="num">${esc(fmtBytes(f.bytes))}</td>
        <td>${barCell(f.usedPercent, 100, `${Math.round(f.usedPercent)}%`, f.usedPercent < 30 ? 'poor' : f.usedPercent < 60 ? 'warn' : 'good')}</td>
        <td class="num">${esc(fmtBytes(f.unusedBytes))}</td><td class="small">${esc(f.advice)}</td></tr>`).join('')}</tbody></table></div>`);
  }

  async function openSourceFile(hash) {
    const D = window.PSI.drawer;
    D.open('<div class="empty">Loading the file…</div>', 'File coverage');
    const tok = ++D.seq;
    let f;
    try {
      f = await api(`/api/audits/${encodeURIComponent(state.auditId)}/dashboard/pages/${encodeURIComponent(state.pageId)}/source/file/${encodeURIComponent(hash)}`);
    } catch (err) {
      if (tok === D.seq) D.set(`<div class="empty">Couldn’t load the file: ${esc(err.message)}</div>`);
      return;
    }
    if (tok !== D.seq) return;
    const LIMIT = 150_000;
    const text = f.content.slice(0, LIMIT);
    let out = '';
    let pos = 0;
    for (const [s, e] of f.usedRanges) {
      if (s >= LIMIT) break;
      if (s > pos) out += `<span class="unused">${esc(text.slice(pos, s))}</span>`;
      out += `<span class="used">${esc(text.slice(s, Math.min(e, LIMIT)))}</span>`;
      pos = Math.min(e, LIMIT);
    }
    if (pos < text.length) out += `<span class="unused">${esc(text.slice(pos))}</span>`;
    D.set(`<h2 class="drawer-t">${esc(shortUrl(f.url))}</h2><p class="c-muted small">${esc(f.url)}</p>
      <p class="small">${Math.round((f.usedBytes / Math.max(1, f.bytes)) * 100)}% of ${esc(fmtBytes(f.bytes))} ran during page load. <span class="used">Highlighted</span> = ran, <span class="unused">faded</span> = didn’t.${f.content.length > LIMIT ? ` Showing the first ${esc(fmtBytes(LIMIT))}.` : ''}</p>
      <pre class="cov-view">${out}</pre>`);
  }

  function sourceCriticalTab(d) {
    const c = d.criticalCss;
    if (!c) return card('Critical CSS', '', '<div class="empty">No critical CSS could be worked out for this page.</div>');
    const snippet = `<style id="critical-css">${c.css}</style>\n${(c.sourceUrls || []).map((u) => `<link rel="stylesheet" href="${u}" media="print" onload="this.media='all'">\n<noscript><link rel="stylesheet" href="${u}"></noscript>`).join('\n')}`;
    return card('Critical CSS', `The CSS needed to draw the first screen on ${esc(state.device)} (${c.viewport?.width}×${c.viewport?.height}): <b>${esc(fmtBytes(c.bytes))}</b> out of ${esc(fmtBytes(c.originalBytes))} in the blocking stylesheets (${num(c.keptRules)} of ${num(c.totalRules)} rules). Put it inline in the <code>&lt;head&gt;</code> and load the full stylesheets without blocking — the first screen can then appear without waiting for them.`,
      `<div class="pad"><div class="f-actions" style="margin:0 0 8px"><button class="btn btn-primary btn-sm" data-copy-text="${esc(snippet)}">Copy ready-to-paste HTML</button><button class="btn btn-ghost btn-sm" data-copy-text="${esc(c.css)}">Copy just the CSS</button><button class="btn btn-ghost btn-sm" data-nav="experiments">Try it first →</button></div>
      <pre class="cov-view" style="max-height:50vh">${esc(c.css.slice(0, 60000))}${c.css.length > 60000 ? '\n/* … */' : ''}</pre>
      <div class="note">Worked out for one screen size. Test on both mobile and desktop, and re-generate after design changes. Most WordPress speed plugins (WP Rocket, Perfmatters, LiteSpeed) can do this automatically.</div></div>`);
  }

  function sourceTagsTab(d) {
    const tms = d.tagManagers || [];
    if (!tms.length) return card('Tag Manager', '', '<div class="empty">No Google Tag Manager or gtag.js container was found on this page.</div>');
    return tms.map((c) => card(`${c.kind === 'gtm' ? 'Google Tag Manager' : 'Google tag (gtag.js)'}${c.containerId ? ` · ${c.containerId}` : ''}`, esc(c.summary),
      `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Tag</th><th>Company</th><th>Loads from</th><th>IDs</th></tr></thead><tbody>${c.tags.map((t) => `<tr class="no-hover"><td><b>${esc(t.name)}</b></td><td class="small">${esc(t.vendor && t.vendor !== t.name ? t.vendor : '—')}</td><td class="small">${esc(t.domains.join(', ') || '—')}</td><td class="small tech-only">${esc(t.ids.join(', ') || '—')}</td></tr>`).join('')}</tbody></table></div>
      <div class="note">Every tag here runs on every page that loads this container. Ask whoever manages marketing tags whether each is still needed — removing unused ones is one of the easiest speed wins.</div>`)).join('');
  }

  function sourceChangesTab(d) {
    const x = d.diff;
    if (!x) return card('Changes since last audit', '', '<div class="empty">There’s no earlier audit of this page with source to compare.</div>');
    const list = (label, xs, tone) => (xs.length ? `<h4 class="sw-h">${label} (${xs.length})</h4><ul class="plain-list">${xs.map((i) => `<li class="c-${tone}">${esc(i.kind)} · ${esc(i.label)}${i.url ? ` <code class="tech-only">${esc(i.url)}</code>` : ''}</li>`).join('')}</ul>` : '');
    const grew = x.htmlBytes.after - x.htmlBytes.before;
    return card('Changes since last audit', `Compared with ${esc(fmtDate(x.previousStartedAt))}. ${esc(x.summary)}`,
      `<div class="pad">${list('Added', x.added, 'poor')}${list('Removed', x.removed, 'good')}
        ${x.changedMeta.length ? `<h4 class="sw-h">Changed settings</h4><ul class="plain-list">${x.changedMeta.map((m) => `<li><b>${esc(m.field)}</b>: ${esc(m.before ?? '—')} → ${esc(m.after ?? '—')}</li>`).join('')}</ul>` : ''}
        ${x.issuesNew.length ? `<h4 class="sw-h">New problems in the code</h4><ul class="plain-list">${x.issuesNew.map((t) => `<li class="c-poor">${esc(t)}</li>`).join('')}</ul>` : ''}
        ${x.issuesResolved.length ? `<h4 class="sw-h">Fixed since then</h4><ul class="plain-list">${x.issuesResolved.map((t) => `<li class="c-good">${esc(t)}</li>`).join('')}</ul>` : ''}
        <div class="c-muted small">HTML size: ${esc(fmtBytes(x.htmlBytes.before))} → ${esc(fmtBytes(x.htmlBytes.after))} (${grew >= 0 ? '+' : '−'}${esc(fmtBytes(Math.abs(grew)))})</div></div>`);
  }

  function sourceRight() {
    const d = state.source?.data;
    const a = d?.analysis;
    if (!a) return '';
    const top = a.issues.filter((i) => i.severity === 'high').slice(0, 4);
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Most important in the code</span></div>
      ${top.length ? `<ol class="plain-list">${top.map((i) => `<li>${esc(i.title)}${i.lines?.length ? ` <a class="lnk" data-source-line="${i.lines[0]}">line ${i.lines[0]}</a>` : ''}</li>`).join('')}</ol>` : '<div class="c-muted small">No high-priority problems in the HTML.</div>'}</section>
      ${a.libraries?.length ? `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Libraries found</span></div><ul class="plain-list">${a.libraries.map((l) => `<li><b>${esc(l.name)}</b>${l.version ? ` ${esc(l.version)}` : ''}${l.line ? ` <a class="lnk" data-source-line="${l.line}">line ${l.line}</a>` : ''}</li>`).join('')}</ul></section>` : ''}
      <section class="card rcard"><div class="rcard-h"><span class="rcard-t">About this capture</span></div><div class="c-muted small">Read from ${esc(d.finalUrl)} on ${esc(fmtDate(d.capturedAt))}, in a separate load without the slow-phone throttling (so it doesn’t skew the speed numbers). Unused-code figures cover the page load only.</div></section>`;
  }

  // ------------------------------------------------ plain-language helpers
  /** Why the engine test, Google's test and real visitors disagree — only the reasons that apply here. */
  function whyDifferent(k, lab, googleLab, ruVal, ru) {
    const vals = [lab, googleLab, ruVal].filter((v) => v != null);
    if (vals.length < 2) return '';
    const hi = Math.max(...vals), lo = Math.min(...vals);
    const differ = hi > 0 && (hi - lo) / hi > 0.2 && new Set(vals.map((v) => rating(k, v))).size > 1;
    if (!differ) return '';
    const reasons = [];
    const phone = state.device === 'mobile';
    const labWorse = ruVal != null && [lab, googleLab].some((v) => v != null && v > ruVal * 1.2);
    const realWorse = ruVal != null && [lab, googleLab].filter((v) => v != null).every((v) => ruVal > v * 1.2);
    if (labWorse) reasons.push(`Both tests simulate a <b>first visit on ${phone ? 'a mid-range phone over a slow 4G connection' : 'a desktop with nothing cached'}</b>. Most real visitors have faster ${phone ? 'phones and connections' : 'connections'}, and returning visitors already have parts of the site saved in their browser.`);
    if (realWorse) reasons.push('Real visitors are <b>slower than the tests</b>. That usually means things the tests don’t see: pop-ups, chat or ad scripts that load later, logged-in content, or many visitors on older phones.');
    if (lab != null && googleLab != null && Math.abs(lab - googleLab) / Math.max(lab, googleLab) > 0.2) reasons.push('The two tests run from different places — this engine from your computer and network, Google from its own data centres — so server distance and normal run-to-run variation move the numbers. Differences under about 20% are normal.');
    if (ru && ru.scope !== 'page') reasons.push('Google doesn’t have enough visits to report this page on its own, so the real-visitor number is for <b>the whole site</b>.');
    if (ruVal != null) reasons.push('Real-visitor data covers the <b>last 28 days</b>, so a fix made recently can take up to 4 weeks to show fully.');
    reasons.push('Google judges Core Web Vitals on <b>real visitors</b>; the tests are for finding causes and checking fixes.');
    return `<details class="why-diff"><summary>Why are these numbers different?</summary><ul>${reasons.map((r) => `<li>${r}</li>`).join('')}</ul></details>`;
  }

  /** The page's load, told in plain English (server: analysis/shared/page-story.ts). */
  function pageStoryCard(k) {
    const story = state.detail?.story;
    if (!story || (k && !['LCP', 'FCP', 'TTFB'].includes(k))) return '';
    const steps = (story.steps || []).map((st) => `<li class="st-${esc(st.tone)}"><span class="st-at">${esc(fmtMs(st.atMs, { seconds: true }))}</span>${esc(st.text)}</li>`).join('');
    return `<section class="card story"><div class="card-h"><span class="card-t">📖 How this page loads</span><span class="pill muted">${esc(pagePath(state.detail.url))} · ${esc(state.device)}</span></div>
      <div class="story-text">${esc(story.summary)}</div>
      ${steps ? `<details class="story-steps"><summary>Step by step</summary><ol>${steps}</ol></details>` : ''}</section>`;
  }

  /** What-if estimate, platform-specific steps and "check it yourself" for one finding. */
  function fixExtras(f) {
    const out = [];
    if (f.guidance?.whatIf) out.push(`<div class="f-whatif">🔮 ${esc(f.guidance.whatIf.text)}</div>`);
    if (f.playbook?.steps?.length) out.push(`<h4>${esc(f.playbook.title)}</h4><ol class="f-steps">${f.playbook.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`);
    if (f.verify?.length) out.push(`<details class="f-verify"><summary>✔ How to check it yourself</summary><ol class="f-steps">${f.verify.map((x) => `<li>${esc(x)}</li>`).join('')}</ol></details>`);
    return out.join('');
  }

  // ------------------------------------------------------------- glossary
  const GLOSSARY = [
    ['Core Web Vitals', 'Google’s three main page-experience measures — LCP (loading), INP (responsiveness) and CLS (visual stability). They affect search ranking.'],
    ['LCP', 'Largest Contentful Paint — how long until the main content (usually the big image or headline) shows up. Good: under 2.5 s.'],
    ['FCP', 'First Contentful Paint — how long the screen stays blank before anything appears. Good: under 1.8 s.'],
    ['CLS', 'Cumulative Layout Shift — how much things jump around while loading. Good: under 0.1.'],
    ['INP', 'Interaction to Next Paint — how fast the page reacts to taps and clicks. Only measurable from real visitors. Good: under 200 ms.'],
    ['TBT', 'Total Blocking Time — how long scripts keep the page too busy to respond while it loads. Good: under 200 ms.'],
    ['TTFB', 'Time to First Byte — how long the server takes to start sending the page. Good: under 0.8 s.'],
    ['render-blocking', 'A file (usually CSS or JavaScript) the browser must finish downloading before it can show anything.'],
    ['third-party', 'Something loaded from another company’s server — tag managers, analytics, chat widgets, videos, ads.'],
    ['third party', 'Something loaded from another company’s server — tag managers, analytics, chat widgets, videos, ads.'],
    ['p75', '75th percentile: 3 out of 4 real visits were this fast or faster. It’s the number Google uses.'],
    ['CrUX', 'Chrome UX Report — Google’s data from real Chrome visitors over the last 28 days.'],
    ['long task', 'A chunk of script work taking over 50 ms, during which the page can’t respond to taps or clicks.'],
    ['main thread', 'The browser’s single worker that runs scripts and draws the page. If it’s busy, the page feels frozen.'],
    ['fetchpriority', 'An HTML hint telling the browser to download an important file (like the hero image) first.'],
    ['lazy-load', 'Waiting to download an image until it scrolls into view — good below the fold, bad for the main image.'],
    ['font-display', 'A CSS setting that decides whether text waits for the web font or shows right away in a fallback font.'],
    ['CDN', 'Content Delivery Network — copies of your files on servers around the world, so they load from somewhere close.'],
    ['DOM', 'The page’s structure of elements. A very large DOM makes the page slower to update.'],
    ['lab', 'A simulated test visit (this engine or Google’s PageSpeed test) — useful for finding causes, not what real visitors get.'],
  ];
  const GLOSSARY_RE = GLOSSARY.map(([term, def]) => ({
    def: `<b>${esc(term)}</b><br>${esc(def)}`,
    re: /^[A-Z0-9]+$/.test(term) ? new RegExp(`\\b${term}\\b`) : new RegExp(`\\b${term.replace(/[-\s]/g, '[-\\s]')}\\b`, 'i'),
  }));
  const GLOSS_SKIP = '.code-view,.cov-view,.head-snip,.src-snip,.task-md,code,pre,script,style,button,a,input,textarea,select,option,canvas,svg,h1,h2,h3,h4,.gl,.g-bar,.g-lbl,.pill,.hero-value,.hero-title,.card-h,.rcard-h,.ff-title,.tooltip,.src-v,.src-k,.ff-num,.side-item,summary';
  /** Adds a hover definition to the first use of each jargon term in every card. */
  function applyGlossary(root) {
    if (!root) return;
    for (const scope of root.querySelectorAll('.card, .rcard')) {
      const used = new Set();
      const walker = document.createTreeWalker(scope, window.NodeFilter.SHOW_TEXT);
      const nodes = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.trim().length > 2 && !n.parentElement.closest(GLOSS_SKIP)) nodes.push(n);
      for (const node of nodes) {
        for (let i = 0; i < GLOSSARY_RE.length; i++) {
          if (used.has(i)) continue;
          const m = GLOSSARY_RE[i].re.exec(node.nodeValue);
          if (!m) continue;
          used.add(i);
          const after = node.splitText(m.index);
          after.nodeValue = after.nodeValue.slice(m[0].length);
          const span = document.createElement('span');
          span.className = 'gl';
          span.tabIndex = 0;
          span.setAttribute('role', 'button');
          span.dataset.glossary = '';
          span.textContent = m[0];
          span.dataset.tip = GLOSSARY_RE[i].def;
          node.parentNode.insertBefore(span, after);
          break; // one term per text node keeps the walk simple
        }
      }
    }
  }
  function openGlossary() {
    const seen = new Set();
    const rows = GLOSSARY.filter(([, d]) => (seen.has(d) ? false : seen.add(d))).map(([t, d]) => `<dt>${esc(t)}</dt><dd>${esc(d)}</dd>`).join('');
    window.PSI.drawer.open(`<h2 class="drawer-t">What the terms mean</h2><p class="c-muted small">Hover any dotted-underlined word in the dashboard for the same explanation. <button class="rcard-link" data-tour-start>Take the tour again →</button></p><dl class="glossary">${rows}</dl>`, 'Glossary');
  }

  // ------------------------------------------------- owner task lists
  function ownerTasks() {
    const issues = (state.summary.siteIssues?.[state.device] || []).filter((g) => !g.guidance?.informational && !isIgnored(g.key));
    const by = {};
    for (const g of issues) (by[g.guidance?.owner || 'developer'] ||= []).push(g);
    return by;
  }
  function exportTasks() {
    const by = ownerTasks();
    const site = host(state.summary.audit.targetUrl);
    const md = Object.entries(by).map(([owner, list]) => `## ${OWNER_LABEL[owner] || owner} (${list.length})\n\n${list.map((g, i) => `${i + 1}. **${g.guidance?.plainTitle || g.title}** — ${EFFORT_LABEL[g.guidance?.effort] || ''}, affects ${g.pageCount}/${g.totalPages} pages\n   - ${g.recommendation}`).join('\n')}`).join('\n\n');
    const header = `# Speed fixes for ${site} (${state.device})\n\n_From the PMW Speed Engine audit on ${fmtDate(state.summary.audit.startedAt)}._\n\n`;
    const counts = Object.entries(by).map(([o, l]) => `<li><b>${esc(OWNER_LABEL[o] || o)}</b> — ${l.length} task${l.length === 1 ? '' : 's'}</li>`).join('');
    window.PSI.drawer.open(`<h2 class="drawer-t">Task lists by owner</h2><p class="c-muted small">${esc(site)} · ${esc(state.device)} · ignored issues left out.</p><ul>${counts}</ul>
      <div class="f-actions"><button class="btn btn-primary btn-sm" data-export-copy>Copy all as text</button><button class="btn btn-ghost btn-sm" data-export-csv>Download CSV</button></div>
      <pre class="task-md">${esc(header + md)}</pre>`, 'Task lists');
    exportTasks.md = header + md;
    exportTasks.csv = [['Owner', 'Task', 'Size', 'Pages affected', 'What to do', 'Metric', 'Priority'].join(','),
      ...Object.entries(by).flatMap(([o, list]) => list.map((g) => [OWNER_LABEL[o] || o, g.guidance?.plainTitle || g.title, EFFORT_LABEL[g.guidance?.effort] || '', `${g.pageCount}/${g.totalPages}`, g.recommendation, g.metric, g.priority].map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')))].join('\n');
  }
  function downloadText(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new window.Blob([text], { type }));
    a.download = name;
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  // ------------------------------------------ filmstrip: what had loaded
  function frameLoadPanel(v, frameIdx) {
    const f = v.frames?.[frameIdx];
    const reqs = v.requests || [];
    if (!f || !reqs.length) return '';
    const t = f.timingMs;
    const blocking = new Set((ins().renderBlocking || []).map((x) => x.url));
    const lcpUrl = state.detail.lcpEvidence?.imageUrl;
    const done = reqs.filter((r) => r.endMs <= t);
    const loading = reqs.filter((r) => r.startMs <= t && r.endMs > t);
    const later = reqs.filter((r) => r.startMs > t);
    const name = (r) => `${r === reqs.find((x) => x.url === lcpUrl) ? '★ ' : ''}${shortUrl(r.url)}`;
    const tag = (r) => (r.url === lcpUrl ? 'lcp' : blocking.has(r.url) ? 'block' : '');
    const list = (xs) => xs.slice(0, 12).map((r) => `<li class="${tag(r)}"><span class="c-muted">${esc(r.type)}</span> ${esc(name(r))}</li>`).join('') + (xs.length > 12 ? `<li class="c-muted">+${xs.length - 12} more</li>` : '');
    const lcpState = lcpUrl ? (done.some((r) => r.url === lcpUrl) ? 'The main (LCP) image <b>had finished downloading</b>.' : loading.some((r) => r.url === lcpUrl) ? 'The main (LCP) image <b>was still downloading</b>.' : 'The main (LCP) image <b>hadn’t started downloading yet</b>.') : '';
    const blockLeft = loading.filter((r) => blocking.has(r.url)).length + later.filter((r) => blocking.has(r.url)).length;
    return `<div class="vl-at"><div class="vl-at-h">At ${esc(fmtMs(t, { seconds: true }))}: ${done.length} files finished · ${loading.length} still downloading · ${later.length} not started yet <button class="rcard-link" data-vl-frame="${frameIdx}">Close</button></div>
      <div class="c-muted small">${lcpState} ${blockLeft ? `<b class="c-poor">${blockLeft} render-blocking file${blockLeft === 1 ? ' was' : 's were'} still not done</b> — that’s why the screen may still look empty.` : blocking.size ? 'All render-blocking files were done.' : ''}</div>
      <div class="vl-at-cols"><div><h4>Still downloading</h4><ul>${list(loading) || '<li class="c-muted">Nothing</li>'}</ul></div><div><h4>Finished by now</h4><ul>${list([...done].reverse()) || '<li class="c-muted">Nothing yet</li>'}</ul></div></div>
      <div class="note">From the same test run as these screenshots. ★ = main (LCP) image, red = render-blocking.</div></div>`;
  }

  // --------------------------------------------------------------- findings
  // Who usually fixes it and how big a job it is — plain words for non-developers.
  const OWNER_LABEL = { developer: 'Developer', content: 'Content editor', hosting: 'Hosting / server', marketing: 'Marketing (tags & tools)' };
  const EFFORT_LABEL = { quick: 'Quick fix', moderate: 'Moderate job', bigger: 'Bigger job' };
  function guidanceChips(g) {
    if (!g) return '';
    return `<span class="chip-owner" title="Who usually fixes this">${esc(OWNER_LABEL[g.owner] || g.owner)}</span><span class="chip-effort ${esc(g.effort)}" title="Rough size of the job">${esc(EFFORT_LABEL[g.effort] || g.effort)}</span>`;
  }

  // "Mark fixed" / "Ignore" decisions, per site, saved on the server.
  function findingState(key) {
    return (key && state.summary?.findingStates?.[key]) || null;
  }
  /** Marked fixed before this audit ran, yet the audit still finds it. */
  function cameBack(st) {
    return st?.status === 'fixed' && state.summary && st.updatedAt < state.summary.audit.startedAt;
  }
  function stateBadge(key) {
    const st = findingState(key);
    if (!st) return '';
    if (cameBack(st)) return '<span class="pill poor" title="Marked fixed earlier, but this audit still finds it">Came back</span>';
    if (st.status === 'fixed') return '<span class="pill good" title="Marked fixed — re-run the audit to confirm">Marked fixed</span>';
    return '<span class="pill muted">Ignored</span>';
  }
  function stateControls(key) {
    if (!key || !state.summary?.site) return '';
    const st = findingState(key);
    const btn = (status, label, cls = 'btn-ghost') => `<button class="btn ${cls} btn-sm" data-fstate="${status}" data-fkey="${esc(key)}">${label}</button>`;
    if (!st) return `${btn('fixed', '✓ Mark as fixed')}${btn('ignored', 'Ignore on this site')}`;
    const when = `<span class="c-muted small">${st.status === 'fixed' ? 'Marked fixed' : 'Ignored'} ${esc(ago(st.updatedAt))}</span>`;
    return `${when}${btn('clear', st.status === 'fixed' ? 'Undo' : 'Stop ignoring')}`;
  }
  const isIgnored = (key) => findingState(key)?.status === 'ignored';
  /** Hides ignored findings unless the user asked to see them; returns the kept list and how many were hidden. */
  function withoutIgnored(list, keyOf = (f) => f.key) {
    if (state.showIgnored) return { list, hidden: 0 };
    const kept = list.filter((f) => !isIgnored(keyOf(f)));
    return { list: kept, hidden: list.length - kept.length };
  }
  function ignoredToggle(hidden) {
    if (!hidden && !state.showIgnored) return '';
    return `<div class="pad" style="padding-top:4px"><button class="rcard-link" data-toggle-ignored>${state.showIgnored ? 'Hide ignored issues' : `Show ${hidden} ignored issue${hidden === 1 ? '' : 's'}`}</button></div>`;
  }

  function findingsCard(findings, title) {
    const { list, hidden } = withoutIgnored(findings);
    return `<section class="card"><div class="card-h"><span class="card-t">${esc(title)}</span><span class="pill muted">${list.length}</span></div>
      <div class="findings">${list.length ? list.map(findingHtml).join('') : `<div class="empty" style="padding:14px">${hidden ? 'Only ignored issues here.' : 'No issues found for this metric. 🎉'}</div>`}</div>${ignoredToggle(hidden)}</section>`;
  }
  function findingHtml(f) {
    const sev = { critical: 'poor', high: 'poor', medium: 'warn', low: 'info' }[f.severity] || 'muted';
    const g = f.guidance;
    const plain = g && !g.informational && g.plainTitle !== f.rootCause ? g.plainTitle : null;
    return `<details class="finding${isIgnored(f.key) ? ' is-ignored' : ''}">
      <summary><span class="pill ${sev}">${esc(f.priority)}</span><span class="f-title">${plain ? `${esc(plain)}<span class="f-tech">${esc(f.rootCause)}</span>` : esc(f.rootCause)}</span>${stateBadge(f.key)}${g && !g.informational ? guidanceChips(g) : ''}<span class="pill muted">${esc(f.metric)}</span></summary>
      <div class="f-body">
        ${g?.gain ? `<div class="f-gain">📈 ${esc(g.gain)}</div>` : ''}
        ${f.culprit ? `<h4 class="tech-only">Culprit</h4><div class="tech-only">${esc(f.culprit.description)}${f.culprit.url ? ` — <code>${esc(f.culprit.url)}</code>` : ''}${f.culprit.selector ? ` — <code>${esc(f.culprit.selector)}</code>` : ''}</div>` : ''}
        <h4 class="tech-only">Evidence</h4><ul class="tech-only">${(f.evidence || []).map((e) => `<li>${esc(e.description ?? e.statement ?? JSON.stringify(e))}</li>`).join('')}</ul>
        ${f.sourceRefs?.length ? `<h4>In your HTML</h4>${f.sourceRefs.map((r) => `<div class="src-snip"><span class="src-ln"><a class="lnk" data-source-line="${r.line}">line ${r.line}</a></span><code>${esc(r.snippet)}</code></div>`).join('')}` : ''}
        <h4>Fix</h4><div>${esc(f.recommendation)}</div>
        ${fixExtras(f)}
        ${f.implementationGuidance ? `<h4 class="tech-only">How</h4><div class="tech-only">${esc(f.implementationGuidance)}</div>` : ''}
        <div class="c-muted small tech-only" style="margin-top:8px">${esc(f.confidence)} confidence</div>
        <div class="f-actions"><button class="btn btn-ghost btn-sm" data-copy-dev="${esc(f.id)}" title="Copy a ready-to-paste ticket for your developer">⧉ Copy for developer</button>${stateControls(f.key)}</div>
        ${findingLinks(f)}
      </div></details>`;
  }

  /** A ready-to-paste ticket (Markdown) for one finding: where, what, evidence, the fix, and the PMW guide it maps to. */
  function developerTicket(f) {
    const d = state.detail;
    const k = f.metric === 'JavaScript' ? 'TBT' : f.metric;
    const val = METRICS[k] ? metricValue(d.vitals, k) : null;
    const lines = [
      `## ${f.guidance && !f.guidance.informational ? f.guidance.plainTitle : f.rootCause}`,
      '',
      `**Page:** ${d.url} (${state.device})`,
      `**Metric:** ${f.metric}${val != null ? ` — currently ${fmtMetric(k, val)} (good ≤ ${fmtMetric(k, METRICS[k].good)})` : ''}`,
      `**Priority:** ${f.priority} · ${f.severity} severity · ${f.confidence} confidence`,
      f.guidance ? `**Owner / size:** ${OWNER_LABEL[f.guidance.owner]} · ${EFFORT_LABEL[f.guidance.effort]}` : '',
      f.guidance?.gain ? `**Expected impact:** ${f.guidance.gain}` : '',
      '',
      '### What’s wrong',
      f.rootCause,
    ];
    if (f.culprit) {
      lines.push('', '### Culprit', `${f.culprit.description}${f.culprit.url ? `\n- File: ${f.culprit.url}` : ''}${f.culprit.selector ? `\n- Element: \`${f.culprit.selector}\`` : ''}`);
    }
    if (f.evidence?.length) lines.push('', '### Evidence', ...f.evidence.map((e) => `- ${e.description ?? e.statement ?? ''}`));
    if (f.sourceRefs?.length) lines.push('', '### In the page HTML', ...f.sourceRefs.map((r) => `- Line ${r.line}: \`${r.snippet}\``));
    lines.push('', '### Fix', f.recommendation);
    if (f.guidance?.whatIf) lines.push('', `_Estimate: ${f.guidance.whatIf.text}_`);
    if (f.playbook?.steps?.length) lines.push('', `### ${f.playbook.title}`, ...f.playbook.steps.map((x, i) => `${i + 1}. ${x}`));
    if (f.implementationGuidance) lines.push('', '### How', f.implementationGuidance);
    if (f.verify?.length) lines.push('', '### How to check it’s fixed', ...f.verify.map((x, i) => `${i + 1}. ${x}`));
    if (f.codeExample?.after) {
      lines.push('', '### Code example');
      if (f.codeExample.before) lines.push('Before:', '```' + (f.codeExample.language || ''), f.codeExample.before, '```');
      lines.push('After:', '```' + (f.codeExample.language || ''), f.codeExample.after, '```');
    }
    if (f.pmwGuides?.length) lines.push('', '### PMW guide', ...f.pmwGuides.map((g) => `- ${g.title} (${g.source})`));
    if (f.relatedResources?.length) lines.push('', '### References', ...f.relatedResources.map((r) => `- ${r}`));
    lines.push('', `_Found by PMW Speed Engine on ${fmtDate(state.summary.audit.startedAt)}. Re-run the audit after the change to confirm._`);
    return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
  }
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  /** Where to go next from a finding: its metric's full evidence, and its generated fix plan when there is one. */
  function findingLinks(f) {
    const metric = f.metric === 'JavaScript' ? 'TBT' : f.metric;
    const links = [];
    if (METRICS[metric] && !(state.view === 'metric' && state.metric === metric)) {
      links.push(`<button class="btn btn-ghost btn-sm" data-metric="${metric}">Open ${esc(metric)} evidence →</button>`);
    }
    const plan = (state.detail?.remediationPlans || []).find((p) => p.findingId === f.id);
    if (plan) links.push(`<button class="btn btn-ghost btn-sm" data-open-fix>View fix plan →</button>`);
    return links.length ? `<div class="f-links">${links.join('')}</div>` : '';
  }

  // ------------------------------------------------------- other main views
  function gaugeSvg(score, size = 64) {
    const r = scoreRating(score);
    const col = { good: 'var(--good)', warn: 'var(--warn)', poor: 'var(--poor)', none: 'var(--line-2)' }[r];
    const pct = score == null ? 0 : score;
    const c = 2 * Math.PI * 26;
    return `<svg class="gauge" viewBox="0 0 64 64" style="width:${size}px;height:${size}px"><circle cx="32" cy="32" r="26" stroke="var(--line-2)" stroke-width="5"/>
      <circle cx="32" cy="32" r="26" stroke="${col}" stroke-width="5" stroke-dasharray="${c * pct} ${c}" transform="rotate(-90 32 32)"/>
      <text x="32" y="37" text-anchor="middle" fill="${col}" stroke="none" style="font:600 16px Inter,sans-serif">${score == null ? '—' : Math.round(score * 100)}</text></svg>`;
  }

  function renderOverview() {
    const d = state.detail;
    const sc = d.scores;
    const pages = pagesForDevice().filter((p) => p.status !== 'failed');
    const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const sitePerf = avg(pages.map((p) => p.scores.performance).filter((x) => x != null));
    return `<section class="card hero" style="padding-bottom:10px">
        <div class="hero-title">Site overview <span class="pill muted">${esc(host(state.summary.audit.targetUrl))} · ${esc(state.device)} · ${pages.length} page${pages.length === 1 ? '' : 's'}</span></div>
        <div class="ov-scores">
          <div class="ov-score" data-nav="performance" title="Average lab performance score across every audited page">${gaugeSvg(sitePerf)}<div class="lbl">Performance<br><span class="c-muted small">site average</span></div></div>
          ${[['Accessibility', 'accessibility'], ['Best Practices', 'bestPractices'], ['SEO', 'seo']].map(([l, key]) => {
            const v = avg(pages.map((p) => p.scores[key]).filter((x) => x != null));
            const nav = { accessibility: 'accessibility', bestPractices: 'best-practices', seo: 'seo' }[key];
            return `<div class="ov-score" data-nav="${nav}">${gaugeSvg(v)}<div class="lbl">${l}<br><span class="c-muted small">site average</span></div></div>`;
          }).join('')}
        </div>
      </section>
      ${cwvAssessmentCard('origin')}
      ${fixFirstCard()}
      ${pageStoryCard(null)}
      ${quickWinsCard()}
      ${siteWideCard()}
      ${sitePagesCard()}
      ${state.simple ? '' : thirdPartyCard()}
      <section class="card hero" style="padding-bottom:12px">
        <div class="card-h" style="padding:0 0 6px"><span class="card-t">Selected page · ${esc(pagePath(d.url))}</span>
          <div class="card-tools"><button class="rcard-link" data-metric="LCP">Open its performance →</button></div></div>
        <div class="ov-scores" style="padding:4px 0 10px">
          ${[['Performance', sc.performance, 'performance'], ['Accessibility', sc.accessibility, 'accessibility'], ['Best Practices', sc.bestPractices, 'best-practices'], ['SEO', sc.seo, 'seo']]
            .map(([l, v, nav]) => `<div class="ov-score" data-nav="${nav}">${gaugeSvg(v, 56)}<div class="lbl">${l}</div></div>`).join('')}
          ${d.google?.lab?.performanceScore != null ? `<div class="ov-score ov-score--google" title="Google’s own Lighthouse run (PageSpeed Insights), from Google’s servers">${gaugeSvg(d.google.lab.performanceScore, 56)}<div class="lbl">Performance<br><span class="c-muted small">Google PSI</span></div></div>` : ''}
        </div>
        ${vitalTilesInner(['LCP', 'INP', 'CLS', 'FCP', 'TBT', 'TTFB'])}
      </section>`;
  }

  /** Issues that recur across the site's pages — the "fix these and many pages improve" list. */
  function fixFirstCard() {
    const all = state.summary.siteIssues?.[state.device] || [];
    if (!all.length) return '';
    // Informational items (e.g. "our test and real visitors disagree") aren't jobs to schedule.
    const { list: unfiltered, hidden } = withoutIgnored(all.filter((g) => !g.guidance?.informational));
    // "Who does it" filter — each owner's own task list.
    const ownerCounts = {};
    for (const g of unfiltered) ownerCounts[g.guidance?.owner || 'developer'] = (ownerCounts[g.guidance?.owner || 'developer'] || 0) + 1;
    if (state.ownerFilter && !ownerCounts[state.ownerFilter]) state.ownerFilter = null;
    const actionable = state.ownerFilter ? unfiltered.filter((g) => (g.guidance?.owner || 'developer') === state.ownerFilter) : unfiltered;
    const chips = `<div class="owner-chips" role="group" aria-label="Filter by who does it"><button class="chip-f${!state.ownerFilter ? ' is-active' : ''}" data-owner-filter="">Everyone (${unfiltered.length})</button>${Object.keys(OWNER_LABEL).filter((o) => ownerCounts[o]).map((o) => `<button class="chip-f${state.ownerFilter === o ? ' is-active' : ''}" data-owner-filter="${o}">${esc(OWNER_LABEL[o])} (${ownerCounts[o]})</button>`).join('')}<button class="rcard-link" data-export-tasks style="margin-left:auto">Export task lists →</button></div>`;
    const top = actionable.slice(0, 3);
    const rest = actionable.slice(3);
    const shownRest = state.showAllIssues ? rest : rest.slice(0, 5);
    const sev = { P0: 'poor', P1: 'poor', P2: 'warn', P3: 'info' };
    const metricLink = (g) => (METRICS[g.metric] ? `<button class="pill muted pill-btn" data-metric="${g.metric}" title="Open ${esc(g.metric)}">${esc(g.metric)}</button>`
      : CATEGORY_OF[g.metric] ? `<button class="pill muted pill-btn" data-nav="${CATEGORY_OF[g.metric]}" title="Open ${esc(g.metric)}">${esc(g.metric)}</button>`
        : `<span class="pill muted">${esc(g.metric)}</span>`);
    const pagesList = (g) => `<ul class="page-links">${g.pages.slice(0, 12).map((p) => `<li><a class="lnk" data-open-page="${esc(p.pageId)}" data-open-metric="${esc(METRICS[g.metric] ? g.metric : g.metric === 'JavaScript' ? 'TBT' : '')}" data-open-category="${esc(CATEGORY_OF[g.metric] || '')}">${esc(pagePath(p.url))}</a></li>`).join('')}${g.pages.length > 12 ? `<li class="c-muted">+${g.pages.length - 12} more</li>` : ''}</ul>`;
    const plainOf = (g) => g.guidance?.plainTitle || g.title;
    const topHtml = top.map((g, i) => `<div class="ff-item">
        <div class="ff-num">${i + 1}</div>
        <div class="ff-main">
          <div class="ff-title">${esc(plainOf(g))} ${stateBadge(g.key)}${g.keyPage ? ' <span class="pill info" title="Affects a page you marked as key">★ Key page</span>' : ''}</div>
          <div class="ff-meta">${guidanceChips(g.guidance)}<span class="c-muted small">Affects ${g.pageCount} of ${g.totalPages} page${g.totalPages === 1 ? '' : 's'}</span>${metricLink(g)}</div>
          ${g.guidance?.gain ? `<div class="f-gain">📈 ${esc(g.guidance.gain)}${g.pageCount > 1 ? ' (on the worst page)' : ''}</div>` : ''}
          ${g.guidance?.whatIf ? `<div class="f-whatif">🔮 ${esc(g.guidance.whatIf.text)}</div>` : ''}
          <details class="ff-more"><summary>What to do</summary>
            <div class="f-body"><div class="f-tech" style="margin:0 0 6px">${esc(g.title)}</div><div>${esc(g.recommendation)}</div><h4>Affected pages</h4>${pagesList(g)}</div></details>
          <div class="f-actions">${stateControls(g.key)}</div>
        </div></div>`).join('');
    const restHtml = shownRest.map((g) => `<details class="finding${isIgnored(g.key) ? ' is-ignored' : ''}">
        <summary><span class="pill ${sev[g.priority] || 'muted'}">${esc(g.priority)}</span><span class="f-title">${esc(plainOf(g))}</span>${stateBadge(g.key)}${guidanceChips(g.guidance)}${metricLink(g)}
          <span class="reach" title="${g.pageCount} of ${g.totalPages} pages"><i style="width:${Math.round((g.pageCount / g.totalPages) * 100)}%"></i><b>${g.pageCount}/${g.totalPages}</b></span></summary>
        <div class="f-body">${g.guidance?.gain ? `<div class="f-gain">📈 ${esc(g.guidance.gain)}</div>` : ''}<div class="f-tech" style="margin:0 0 6px">${esc(g.title)}</div><h4>Fix</h4><div>${esc(g.recommendation)}</div>
          <h4>Affected pages</h4>${pagesList(g)}<div class="f-actions">${stateControls(g.key)}</div></div></details>`).join('');
    return `<section class="card"><div class="card-h"><span class="card-t">Fix this first</span><span class="pill muted">${actionable.length} issue${actionable.length === 1 ? '' : 's'}</span></div>
      <div class="card-sub">The ${Math.min(3, actionable.length)} most important fixes across the site (${esc(state.device)}), in plain words — who usually does it, how big a job it is, and how many pages it helps. Issues on pages you starred as key rank first.</div>
      ${chips}
      ${top.length ? `<div class="ff-list">${topHtml}</div>` : '<div class="empty" style="padding:14px">Nothing left to fix here — everything is fixed or ignored. 🎉</div>'}
      ${rest.length ? `<div class="ff-rest-h">More issues</div><div class="findings">${restHtml}</div>` : ''}
      ${rest.length > 5 ? `<div class="pad"><button class="rcard-link" data-toggle-issues>${state.showAllIssues ? 'Show fewer' : `Show all ${rest.length} more`}</button></div>` : ''}
      ${ignoredToggle(hidden)}</section>`;
  }

  function vitalTilesInner(keys) {
    const v = state.detail.vitals;
    return `<div class="ov-grid" style="padding:0">${keys.map((k) => {
        const val = metricValue(v, k);
        const r = rating(k, val);
        return `<div class="ov-tile" data-metric="${k}"><div class="k">${esc(METRICS[k].name)}</div>
          <div class="v c-${r === 'none' ? 'muted' : r}">${esc(fmtMetric(k, val))}</div><span class="pill ${r === 'none' ? 'muted' : r}">${RATING_WORD[r]}</span>${k === 'INP' && val != null ? ' <span class="pill info" title="Lab tools can’t measure INP — this is real Chrome users (p75, 28 days)">Real users</span>' : ' <span class="pill muted">Lab</span>'}</div>`;
      }).join('')}
      ${v?.speedIndex?.valueMs != null ? `<div class="ov-tile" style="cursor:default"><div class="k">Speed Index</div><div class="v">${esc(fmtMs(v.speedIndex.valueMs, { seconds: true }))}</div><span class="pill muted">Lab</span></div>` : ''}
      </div>`;
  }

  // ---------------------------------------------- site-level insight cards
  function quickWinsCard() {
    const wins = state.summary.quickWins?.[state.device] || [];
    if (!wins.length) return '';
    return `<section class="card"><div class="card-h"><span class="card-t">⚡ Quick wins</span><span class="pill muted">${wins.length}</span></div>
      <div class="card-sub">Cheap fixes the engine spotted in the recorded files — each one is a fact from this audit, not a guess.</div>
      <div class="findings">${wins.slice(0, 8).map((w) => `<details class="finding">
        <summary><span class="f-title">${esc(w.title)}</span>${w.savings ? `<span class="pill good">${esc(w.savings)}</span>` : ''}${guidanceChips({ owner: w.owner, effort: w.effort })}${w.pageCount > 1 ? `<span class="c-muted small">${w.pageCount} pages</span>` : ''}</summary>
        <div class="f-body"><div>${esc(w.detail)}</div>
          ${w.urls?.length ? `<h4 class="tech-only">Files</h4><ul class="tech-only">${w.urls.slice(0, 6).map((u) => `<li><code>${esc(u)}</code></li>`).join('')}${w.urls.length > 6 ? `<li class="c-muted">+${w.urls.length - 6} more</li>` : ''}</ul>` : ''}
          ${w.pages?.length > 1 ? `<h4>Pages</h4><ul class="page-links">${w.pages.slice(0, 8).map((p) => `<li><a class="lnk" data-open-page="${esc(p.pageId)}">${esc(pagePath(p.url))}</a></li>`).join('')}</ul>` : ''}
        </div></details>`).join('')}</div></section>`;
  }

  function pageQuickWinsCard() {
    const wins = state.detail?.quickWins || [];
    if (!wins.length) return '';
    return `<section class="card"><div class="card-h"><span class="card-t">⚡ Quick wins on this page</span><span class="pill muted">${wins.length}</span></div>
      <div class="findings">${wins.map((w) => `<details class="finding"><summary><span class="f-title">${esc(w.title)}</span>${w.savings ? `<span class="pill good">${esc(w.savings)}</span>` : ''}${guidanceChips({ owner: w.owner, effort: w.effort })}</summary>
        <div class="f-body"><div>${esc(w.detail)}</div>${w.urls?.length ? `<ul class="tech-only">${w.urls.slice(0, 6).map((u) => `<li><code>${esc(u)}</code></li>`).join('')}</ul>` : ''}</div></details>`).join('')}</div></section>`;
  }

  function siteWideCard() {
    const sp = state.summary.sitePatterns?.[state.device];
    if (!sp) return '';
    const files = sp.sharedFiles || [];
    const tpl = sp.templates || [];
    if (!files.length && tpl.length < 2) return '';
    const kindLabel = { 'render-blocking': 'Blocks rendering', script: 'Script', stylesheet: 'Stylesheet', font: 'Font', image: 'Image', 'third-party': 'Third party' };
    const filesHtml = files.length ? `<h4 class="sw-h">Fix once, helps every page</h4><div class="findings">${files.slice(0, 8).map((f) => `<div class="sw-row">
        <span class="pill ${f.kind === 'render-blocking' ? 'poor' : 'muted'}">${esc(kindLabel[f.kind] || f.kind)}</span>
        <span class="sw-name" title="${esc(f.url)}">${esc(f.label)}</span>
        <span class="reach" title="${f.pageCount} of ${f.totalPages} pages"><i style="width:${Math.round((f.pageCount / f.totalPages) * 100)}%"></i><b>${f.pageCount}/${f.totalPages}</b></span>
        <div class="c-muted small sw-note">${esc(f.note)}</div></div>`).join('')}</div>` : '';
    const tplHtml = tpl.length >= 2 ? `<h4 class="sw-h">Page types</h4><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Type</th><th>Pages</th><th>Score</th><th>LCP</th><th>CLS</th><th>TBT</th></tr></thead><tbody>${tpl.map((t) => `<tr class="no-hover"><td><b>${esc(t.name)}</b> <span class="c-muted small">${esc(t.pattern)}</span></td><td class="num">${t.pageCount}</td>
        <td>${t.avg.performance == null ? '—' : `<span class="score-chip ${scoreRating(t.avg.performance / 100)}">${Math.round(t.avg.performance)}</span>`}</td>
        <td class="c-${rating('LCP', t.avg.lcpMs)}">${esc(fmtMetric('LCP', t.avg.lcpMs))}</td><td class="c-${rating('CLS', t.avg.cls)}">${esc(fmtMetric('CLS', t.avg.cls))}</td><td class="c-${rating('TBT', t.avg.tbtMs)}">${esc(fmtMetric('TBT', t.avg.tbtMs))}</td></tr>`).join('')}</tbody></table></div>
        <div class="note">Pages built from the same template usually share the same problems — fix the template and all of them improve.</div>` : '';
    return `<section class="card"><div class="card-h"><span class="card-t">🔁 Site-wide patterns</span></div>
      <div class="card-sub">Files and page types shared across the site, so one fix can help many pages at once.</div><div class="pad">${filesHtml}${tplHtml}</div></section>`;
  }

  function thirdPartyCard() {
    const list = state.summary.thirdParties?.[state.device] || [];
    if (!list.length) return '';
    const totalBytes = list.reduce((a, t) => a + (t.transferBytes || 0), 0);
    return `<section class="card"><div class="card-h"><span class="card-t">🧩 Third-party services</span><span class="pill muted">${list.length} · ${esc(fmtBytes(totalBytes))}</span></div>
      <div class="card-sub">Every outside service the site loads, what it’s for, and what it costs. Worth asking: do we still need each of these?</div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Service</th><th>What it’s for</th><th>Blocking</th><th>Size</th><th>Requests</th><th>Pages</th></tr></thead><tbody>${list.slice(0, 20).map((t) => `<tr class="no-hover">
        <td><b>${esc(t.entity)}</b><div class="c-muted small tech-only">${esc((t.domains || []).slice(0, 2).join(', '))}</div></td>
        <td class="small">${esc(t.purpose)}</td>
        <td class="num">${t.blockingMs == null ? '<span class="c-muted">—</span>' : `<span class="c-${t.blockingMs > 250 ? 'poor' : t.blockingMs > 50 ? 'warn' : 'good'}">${esc(fmtMs(t.blockingMs))}</span>`}</td>
        <td class="num">${esc(fmtBytes(t.transferBytes))}</td><td class="num">${t.requests}</td><td class="num">${t.pageCount}/${t.totalPages}</td></tr>`).join('')}</tbody></table></div></section>`;
  }

  function platformCard() {
    const pf = state.summary.platform;
    if (!pf || (!pf.platform && !pf.plugins?.length)) return '';
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Built with</span></div>
      <div class="pf-name">${esc(pf.platform?.name || 'Unknown platform')}</div>
      ${pf.plugins?.length ? `<div class="pf-plugins">${pf.plugins.slice(0, 10).map((p) => `<span class="pill muted">${esc(p.name)}</span>`).join(' ')}</div>` : ''}
      <div class="c-muted small" style="margin-top:6px">Fix steps below are tailored to this${pf.plugins?.length ? ' and its plugins' : ''}.</div>
      <details class="tech-only" style="margin-top:6px"><summary class="c-muted small">How we know</summary><ul class="small c-muted">${(pf.evidence || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details></section>`;
  }

  function notesList(auditIds) {
    const notes = state.summary.notes || {};
    const hist = (state.summary.allAudits || []).filter((a) => notes[a.id] && (!auditIds || auditIds.includes(a.id)));
    if (!hist.length) return '';
    return `<div class="notes-list"><div class="c-muted small">📝 Notes</div><ul>${hist.map((a) => `<li><b>${esc(fmtDate(a.startedAt))}</b> — ${esc(notes[a.id])}</li>`).join('')}</ul></div>`;
  }

  function sitePagesCard() {
    const rows = pagesForDevice().map((p) => ({
      id: p.id, url: p.url, perf: p.scores.performance,
      lcp: metricValue(p.vitals, 'LCP'), inp: metricValue(p.vitals, 'INP'), cls: metricValue(p.vitals, 'CLS'), tbt: metricValue(p.vitals, 'TBT'),
      issues: Object.values(p.findingsByMetric || {}).reduce((a, b) => a + b, 0),
      selected: p.id === state.pageId,
    }));
    return `<section class="card"><div class="card-h"><span class="card-t">Pages</span><span class="pill muted">${rows.length} · ${esc(state.device)}</span></div>
      <div class="card-sub">Worst performance score first. Click a page to open it; star your most important pages (home, contact, listings) so their issues rank first.</div>
      <div class="tbl-wrap">${table('pages', [
        { key: 'key', label: '★', render: (r) => `<button class="star-btn${isKeyPage(r.url) ? ' is-on' : ''}" data-key-page="${esc(r.url)}" title="${isKeyPage(r.url) ? 'Key page — click to unmark' : 'Mark as a key page (its issues rank higher)'}" aria-label="Key page" aria-pressed="${isKeyPage(r.url)}">${isKeyPage(r.url) ? '★' : '☆'}</button>`, sortVal: (r) => (isKeyPage(r.url) ? 0 : 1) },
        { key: 'url', label: 'Page', render: (r) => `${esc(pagePath(r.url))}${r.selected ? ' <span class="pill info">selected</span>' : ''}`, cls: 'url', title: (r) => r.url, sortVal: (r) => pagePath(r.url) },
        { key: 'perf', label: 'Score', render: (r) => (r.perf == null ? '—' : `<span class="score-chip ${scoreRating(r.perf)}">${Math.round(r.perf * 100)}</span>`), sortVal: (r) => -(r.perf ?? 2) },
        { key: 'lcp', label: 'LCP', render: (r) => `<span class="c-${rating('LCP', r.lcp)}">${fmtMetric('LCP', r.lcp)}</span>` },
        { key: 'inp', label: 'INP', render: (r) => (r.inp == null ? '<span class="c-muted">—</span>' : `<span class="c-${rating('INP', r.inp)}" title="Real users">${fmtMetric('INP', r.inp)}</span>`) },
        { key: 'cls', label: 'CLS', render: (r) => `<span class="c-${rating('CLS', r.cls)}">${fmtMetric('CLS', r.cls)}</span>` },
        { key: 'tbt', label: 'TBT', render: (r) => `<span class="c-${rating('TBT', r.tbt)}">${fmtMetric('TBT', r.tbt)}</span>` },
        { key: 'issues', label: 'Findings', cls: 'num' },
      ], rows, { defaultSort: 'perf', rowKey: (r) => `page:${r.id}` })}</div></section>`;
  }

  function renderCategory() {
    const c = CATEGORIES[state.category];
    const d = state.detail;
    const score = d.scores[c.scoreKey];
    const findings = (d.findings || []).filter((f) => f.metric === c.findingMetric);
    const checks = d.categoryChecks?.[state.category];
    const rows = pagesForDevice().map((p) => ({ id: p.id, url: p.url, score: p.scores[c.scoreKey], issues: p.findingsByMetric[c.findingMetric] || 0 }));
    const WHAT = {
      seo: 'Whether search engines can crawl, index and understand the page: titles, meta descriptions, link text, robots directives and structured markup.',
      accessibility: 'Whether people using screen readers, keyboards or zoom can use the page: contrast, labels, alt text, landmarks and focus order.',
      'best-practices': 'General web-platform hygiene: HTTPS, console errors, deprecated APIs, image aspect ratios and safe third-party usage.',
    };
    const checksBody = !checks ? '<div class="empty">Lighthouse’s check list isn’t available for this page.</div>'
      : !checks.failedCount ? `<div class="empty">Every applicable check passed. 🎉</div>`
        : checks.groups.map((g) => `<div class="check-group"><div class="check-group-t">${esc(g.title)} <span class="c-muted">${g.checks.length}</span></div>
            ${g.checks.map((ch) => `<details class="finding check"><summary><span class="check-dot ${ch.score >= 0.5 ? 'warn' : 'poor'}"></span><span class="f-title">${esc(ch.title)}</span>${ch.displayValue ? `<span class="pill muted">${esc(ch.displayValue)}</span>` : ''}</summary>
              <div class="f-body">${ch.description ? `<div>${esc(ch.description)}</div>` : ''}<div class="c-muted small" style="margin-top:6px">Lighthouse check <code>${esc(ch.id)}</code> · weight ${esc(num(ch.weight, ch.weight % 1 ? 1 : 0))} in the ${esc(c.label)} score</div></div></details>`).join('')}</div>`).join('');
    return `<section class="card hero" style="padding-bottom:12px"><div class="hero-grid">
        <div style="display:flex;gap:16px;align-items:center">${gaugeSvg(score, 76)}<div>
          <div class="hero-title" style="font-size:19px">${esc(c.label)} <span class="pill ${scoreRating(score) === 'none' ? 'muted' : scoreRating(score)}">${RATING_WORD[scoreRating(score)]}</span></div>
          <div class="hero-desc" style="margin-left:0">Lighthouse ${esc(c.label)} score for ${esc(pagePath(d.url))} on ${esc(state.device)}.</div></div></div>
        <div class="why"><div class="why-h">${ICON.bulb}What’s checked?</div>${esc(WHAT[state.category])}</div>
      </div></section>
      ${card(`Failed checks`, checks ? `${checks.failedCount} failed · ${checks.passed} passed · ${checks.notApplicable} not applicable${checks.manual ? ` · ${checks.manual} to verify manually` : ''} — grouped the way PageSpeed Insights groups them, highest-weighted first.` : '', `<div class="pad">${checksBody}</div>`, checks ? `<span class="pill ${checks.failedCount ? 'warn' : 'good'}">${checks.failedCount}</span>` : '')}
      ${findings.length ? findingsCard(findings, `${c.label} findings with fixes`) : ''}
      <section class="card"><div class="card-h"><span class="card-t">${esc(c.label)} across the site</span></div>
      <div class="card-sub">Lowest score first. Click a page to open it here.</div>
      <div class="tbl-wrap">${table(`cat-${state.category}`, [
        { key: 'url', label: 'Page', render: (r) => esc(pagePath(r.url)), cls: 'url', title: (r) => r.url },
        { key: 'score', label: 'Score', render: (r) => (r.score == null ? '—' : `<span class="score-chip ${scoreRating(r.score)}">${Math.round(r.score * 100)}</span>`), sortVal: (r) => -(r.score ?? 2) },
        { key: 'issues', label: 'Findings', cls: 'num' },
      ], rows, { defaultSort: 'score', rowKey: (r) => `page:${r.id}` })}</div></section>`;
  }

  function renderNetworkView() {
    const net = state.detail.network || [];
    const bytes = net.reduce((a, r) => a + (r.transferSize || 0), 0);
    const third = net.filter((r) => r.isThirdParty);
    const failed = net.filter((r) => r.failed);
    const tiles = [['Requests', net.length], ['Transferred', fmtBytes(bytes)], ['Third-party requests', third.length], ['Failed', failed.length]];
    return `<section class="card hero" style="padding-bottom:12px"><div class="hero-title">Network</div>
        <div class="ov-grid" style="padding:10px 0 0">${tiles.map(([k, v]) => `<div class="ov-tile"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`).join('')}</div></section>
      ${networkChartCard()}${networkTableCard()}`;
  }

  function renderDiagnostics() {
    const { list: kept, hidden } = withoutIgnored(state.detail.findings || []);
    const all = [...kept].sort((a, b) => a.priority.localeCompare(b.priority));
    if (!all.length) return findingsCard(state.detail.findings || [], 'All findings on this page');
    const order = ['LCP', 'INP', 'CLS', 'FCP', 'TBT', 'TTFB', 'JavaScript', 'Network', 'Accessibility', 'Best Practices', 'SEO', 'Agentic Browsing', 'Other'];
    const groups = new Map();
    for (const f of all) {
      const key = f.metric === 'JavaScript' ? 'TBT' : f.metric;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(f);
    }
    const sorted = [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    return `<section class="card hero" style="padding-bottom:10px"><div class="hero-title">All findings <span class="pill muted">${esc(pagePath(state.detail.url))} · ${esc(state.device)} · ${all.length}</span></div>
        <div class="hero-desc" style="margin-left:0">Everything the engine found on this page, grouped by what it affects. Open a group’s metric for its full evidence.</div></section>
      ${pageStoryCard(null)}${pageQuickWinsCard()}
      ${sorted.map(([metric, list]) => {
        const nav = METRICS[metric] ? `<button class="rcard-link" data-metric="${metric}">Open ${esc(metric)} →</button>`
          : CATEGORIES[{ Accessibility: 'accessibility', 'Best Practices': 'best-practices', SEO: 'seo' }[metric]] ? `<button class="rcard-link" data-nav="${{ Accessibility: 'accessibility', 'Best Practices': 'best-practices', SEO: 'seo' }[metric]}">Open ${esc(metric)} →</button>` : '';
        return `<section class="card"><div class="card-h"><span class="card-t">${esc(metric === 'TBT' ? 'TBT / JavaScript' : metric)}</span><span class="pill muted">${list.length}</span><div class="card-tools">${nav}</div></div>
          <div class="findings">${list.map(findingHtml).join('')}</div></section>`;
      }).join('')}${hidden || state.showIgnored ? `<section class="card">${ignoredToggle(hidden)}</section>` : ''}`;
  }

  // ------------------------------------------------------------- right rail
  function renderRight() {
    if (state.view === 'metric') {
      const k = state.metric;
      const mainThread = k === 'TBT' || k === 'INP';
      right.innerHTML = detailCard() + guideCard(k) + beforeNowCard(k) + fixVerifyCard(k)
        + (mainThread && !state.simple ? breakdownCard() + surfaceCard() : '');
      applyGlossary(right);
      drawSparkline();
      return;
    }
    const views = { overview: overviewRight, category: categoryRight, network: networkRight, diagnostics: diagnosticsRight, source: sourceRight, experiments: () => '' };
    right.innerHTML = (views[state.view] || overviewRight)();
    applyGlossary(right);
  }

  // Right-column content for the non-metric views — each about the view it sits beside.
  function sinceLastAuditCard() {
    const hist = state.summary.history || [];
    const cur = hist.find((h) => h.id === state.auditId)?.devices?.[state.device];
    const prev = hist.filter((h) => h.id !== state.auditId)[0];
    const prevD = prev?.devices?.[state.device];
    const head = '<div class="rcard-h"><span class="rcard-t">Since the last audit</span><button class="rcard-link" data-nav="history">History →</button></div>';
    if (!prev || !cur || !prevD) return `<section class="card rcard">${head}<div class="c-muted small">This is the first audit of this site on ${esc(state.device)} — re-run it after making fixes to see what changed.</div></section>`;
    const rows = [['Performance', 'performance', null], ['LCP', 'lcp', 'LCP'], ['INP', 'inp', 'INP'], ['CLS', 'cls', 'CLS'], ['TBT', 'tbt', 'TBT']].map(([label, key, k]) => {
      const a = prevD[key];
      const b = cur[key];
      if (a == null || b == null) return '';
      const isScore = key === 'performance';
      const delta = b - a;
      const better = isScore ? delta > 0 : delta < 0;
      const txt = isScore ? `${delta >= 0 ? '+' : '−'}${Math.round(Math.abs(delta) * 100)}` : k === 'CLS' ? `${delta >= 0 ? '+' : '−'}${num(Math.abs(delta), 3)}` : `${delta >= 0 ? '+' : '−'}${fmtMs(Math.abs(delta))}`;
      const flat = isScore ? Math.abs(delta) < 0.005 : k === 'CLS' ? Math.abs(delta) < 0.0005 : Math.abs(delta) < 1;
      const fmt = (v) => (isScore ? Math.round(v * 100) : fmtMetric(k, v));
      return `<div class="delta-row"><span>${label}</span><span class="c-muted">${esc(fmt(a))} → <b style="color:var(--text)">${esc(fmt(b))}</b></span><span class="pill ${flat ? 'muted' : better ? 'good' : 'poor'}">${flat ? '±0' : esc(txt)}</span></div>`;
    }).join('');
    return `<section class="card rcard">${head}<div class="c-muted small" style="margin-bottom:6px">Site averages, ${esc(state.device)} · vs ${esc(fmtDate(prev.startedAt))}</div>${rows}</section>`;
  }

  function fixPlansCard() {
    const plans = state.detail?.remediationPlans || [];
    const byMetric = {};
    plans.forEach((p) => (byMetric[p.metric] = (byMetric[p.metric] || 0) + 1));
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Fix plans</span></div>
      ${plans.length
        ? `<div class="c-muted small">${plans.length} generated fix plan${plans.length === 1 ? '' : 's'} for this page: ${Object.entries(byMetric).map(([m, n]) => `${n} ${esc(m)}`).join(', ')}.</div>
           <button class="btn btn-ghost btn-sm" data-open-fix style="margin-top:8px">Open fix plans →</button>`
        : '<div class="c-muted small">No fix plans were generated for this page.</div>'}</section>`;
  }

  function overviewRight() {
    const notes = notesList();
    return shareCard() + platformCard() + sinceLastAuditCard() + (notes ? `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Change notes</span><button class="rcard-link" data-nav="history">Add in History →</button></div>${notes}</section>` : '') + (state.simple ? '' : breakdownCard()) + fixPlansCard();
  }

  /** One-page, plain-English summary for clients and managers. */
  function shareCard() {
    const id = encodeURIComponent(state.auditId);
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Share with a client</span></div>
      <div class="c-muted small">A one-page summary in plain English: pass or fail, key numbers, the top fixes and the trend.</div>
      <div class="f-actions"><a class="btn btn-primary btn-sm" href="/api/audits/${id}/summary.pdf">Download PDF</a><a class="btn btn-ghost btn-sm" href="/api/audits/${id}/summary.html" target="_blank" rel="noopener">View</a></div></section>`;
  }

  function categoryRight() {
    const c = CATEGORIES[state.category];
    const url = state.detail.url;
    const both = (state.summary.pages || []).filter((p) => p.url === url);
    const devRows = ['mobile', 'desktop'].map((dev) => {
      const p = both.find((x) => x.device === dev);
      const sc = p?.scores?.[c.scoreKey];
      return `<div class="delta-row"><span>${dev.charAt(0).toUpperCase() + dev.slice(1)}</span><span></span>${sc == null ? '<span class="c-muted">—</span>' : `<span class="score-chip ${scoreRating(sc)}">${Math.round(sc * 100)}</span>`}</div>`;
    }).join('');
    const worst = pagesForDevice().filter((p) => p.scores?.[c.scoreKey] != null).sort((a, b) => a.scores[c.scoreKey] - b.scores[c.scoreKey]).slice(0, 5);
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">This page on each device</span></div>${devRows}</section>
      <section class="card rcard"><div class="rcard-h"><span class="rcard-t">Lowest ${esc(c.label)} scores</span></div>
        ${worst.map((p) => `<div class="delta-row" data-select="page:${esc(p.id)}" style="cursor:pointer"><span class="url" title="${esc(p.url)}">${esc(pagePath(p.url))}</span><span></span><span class="score-chip ${scoreRating(p.scores[c.scoreKey])}">${Math.round(p.scores[c.scoreKey] * 100)}</span></div>`).join('') || '<div class="c-muted small">No scores recorded.</div>'}</section>
      <section class="card rcard"><div class="rcard-h"><span class="rcard-t">How this score works</span></div>
        <div class="c-muted small">Lighthouse weights each check; a failed high-weight check costs more of the score than a low-weight one, so the failed checks list starts with the heaviest. Checks that don’t apply to the page don’t count either way.</div></section>`;
  }

  function networkRight() {
    const net = state.detail.network || [];
    const byType = {};
    let first = 0;
    let third = 0;
    for (const r of net) {
      byType[r.resourceType] = (byType[r.resourceType] || 0) + (r.transferSize || 0);
      if (r.isThirdParty) third += r.transferSize || 0;
      else first += r.transferSize || 0;
    }
    const total = first + third || 1;
    const types = Object.entries(byType).sort((a, b) => b[1] - a[1]);
    const max = types[0]?.[1] || 1;
    return detailCard() + `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">What the page downloads</span></div>
      ${types.map(([t, b]) => `<div class="mix-row"><span>${esc(t)}</span>${barCell(b, max, fmtBytes(b))}</div>`).join('')}
      <div class="mix-split"><div style="width:${(first / total) * 100}%" class="fp"></div><div style="width:${(third / total) * 100}%" class="tp"></div></div>
      <div class="dist-legend"><span>First party ${fmtBytes(first)}</span><span class="c-warn">Third party ${fmtBytes(third)}</span></div></section>`;
  }

  function diagnosticsRight() {
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
    (state.detail.findings || []).forEach((f) => (counts[f.priority] = (counts[f.priority] || 0) + 1));
    const tone = { P0: 'poor', P1: 'poor', P2: 'warn', P3: 'info' };
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">By priority</span></div>
      ${Object.entries(counts).map(([p, n]) => `<div class="delta-row"><span class="pill ${tone[p]}">${p}</span><span class="c-muted small">${{ P0: 'Fix now', P1: 'Fix soon', P2: 'Worth fixing', P3: 'Minor' }[p]}</span><b>${n}</b></div>`).join('')}</section>` + fixPlansCard();
  }

  function detailCard() {
    const d = state.detail;
    const k = state.view === 'metric' ? state.metric : 'TBT';
    const selImg = state.view === 'metric' && state.selected ? imageRows().find((r) => r.url === state.selected) : null;
    if (selImg) {
      return rcard('Image details', `
        <div class="img-preview"><img src="${esc(selImg.url)}" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.style.display='none'"></div>
        <div class="sd-name" title="${esc(selImg.url)}">${esc(shortUrl(selImg.url))}</div>
        <div class="sd-val"><b>${fmtBytes(selImg.transferSize)}</b>${selImg.isLcp ? '<span class="pill warn">LCP image</span>' : ''}${selImg.oversized ? '<span class="pill warn">Oversized</span>' : ''}</div>
        ${selImg.wastedBytes ? `<div class="sd-score">Could save <span class="pill poor">${fmtBytes(selImg.wastedBytes)}</span></div>` : ''}
        <dl class="kv" style="margin-top:8px">
          <dt>Format</dt><dd>${esc((selImg.format || '—').replace('image/', ''))}</dd>
          <dt>Actual</dt><dd>${selImg.intrinsicWidth ? `${selImg.intrinsicWidth}×${selImg.intrinsicHeight}` : '—'}</dd>
          <dt>Shown at</dt><dd>${selImg.renderedWidth ? `${Math.round(selImg.renderedWidth)}×${Math.round(selImg.renderedHeight)}${selImg.devicePixelRatio ? ` @${selImg.devicePixelRatio}x` : ''}` : '—'}</dd>
          <dt>Loading</dt><dd>${selImg.isLazyLoaded == null ? '—' : selImg.isLazyLoaded ? 'lazy' : 'eager'}</dd>
          <dt>Responsive</dt><dd>${selImg.hasResponsiveSource == null ? '—' : selImg.hasResponsiveSource ? 'srcset / picture' : 'single source'}</dd>
        </dl>
        ${selImg.reasons?.length ? `<div class="reasons">${selImg.reasons.map((x) => `<div>${esc(x.reason)}${x.wastedBytes ? ` <b>${fmtBytes(x.wastedBytes)}</b>` : ''}</div>`).join('')}</div>` : ''}`, true);
    }
    if (state.view === 'network') {
      const net = d.network || [];
      const r = (state.selected && net.find((x) => x.url === state.selected)) || net.find((x) => x.resourceType === 'document') || net[0];
      return r ? rcard('Request details', requestDetails(r), Boolean(state.selected)) : rcard('Request details', '<div class="c-muted">No requests recorded.</div>');
    }
    if (k === 'LCP' && state.view === 'metric') {
      const e = d.lcpEvidence;
      if (!e) return rcard('LCP element', '<div class="c-muted">No LCP element was captured.</div>');
      return rcard('LCP element', `
        <div class="sd-name" title="${esc(e.imageUrl || e.elementSelector || '')}">${esc(e.imageUrl ? shortUrl(e.imageUrl) : e.elementSelector || e.elementType || 'Unknown')}</div>
        <div class="sd-val"><b>${fmtMetric('LCP', e.valueMs)}</b><span class="c-muted" title="Measured in the engine’s own Chrome DevTools run, which isn’t network-throttled like Lighthouse’s headline figure">in the engine’s own run</span>
          ${e.elementType ? `<span class="pill info">${esc(e.elementType)}</span>` : ''}${e.isLazyLoaded ? '<span class="pill poor">Lazy-loaded</span>' : ''}${e.isPreloaded ? '<span class="pill good">Preloaded</span>' : ''}</div>
        <dl class="kv" style="margin-top:8px">
          <dt>Selector</dt><dd title="${esc(e.elementSelector || '')}">${esc(e.elementSelector || '—')}</dd>
          <dt>Format</dt><dd>${esc(e.imageFormat || '—')}</dd>
          <dt>Size</dt><dd>${fmtBytes(e.transferSize)}</dd>
          <dt>Dimensions</dt><dd>${e.imageDimensions ? `${e.imageDimensions.width}×${e.imageDimensions.height}` : '—'}</dd>
          <dt>Load delay</dt><dd>${fmtMs(e.phases?.resourceLoadDelayMs)}</dd>
          <dt>Render delay</dt><dd>${fmtMs(e.phases?.elementRenderDelayMs)}</dd>
        </dl>`);
    }
    const topCulprit = k === 'CLS' ? [...(ins().clsCulprits || [])].sort((a, b) => (b.score || 0) - (a.score || 0))[0] : null;
    if (topCulprit && state.view === 'metric') {
      return rcard('Top shift culprit', `
        <div class="sd-name" title="${esc(topCulprit.selector || '')}">${esc(topCulprit.selector || topCulprit.label || 'Unknown element')}</div>
        <div class="sd-val"><b>${num(topCulprit.score, 4)}</b><span class="c-muted">of the ${esc(fmtMetric('CLS', metricValue(d.vitals, 'CLS')))} total</span></div>
        ${topCulprit.causes.length ? `<div class="reasons">${topCulprit.causes.map((c) => `<div><b>${esc(c.cause)}</b>${c.url ? `<br><span class="c-muted">${esc(shortUrl(c.url))}</span>` : ''}</div>`).join('')}</div>` : '<div class="c-muted small">No specific cause reported.</div>'}`);
    }
    if (k === 'CLS' && state.view === 'metric') {
      const shifts = [...(d.clsEvidence?.shifts || [])].filter((s) => !s.hadRecentInput).sort((a, b) => b.value - a.value);
      const s = shifts[0];
      if (!s) return rcard('Largest shift', '<div class="c-muted">No layout shifts were recorded.</div>');
      return rcard('Largest shift', `
        <div class="sd-name">${esc(s.sources?.[0]?.selector || 'Unknown element')}</div>
        <div class="sd-val"><b>${num(s.value, 4)}</b><span class="c-muted">shift score</span></div>
        <dl class="kv" style="margin-top:8px"><dt>At</dt><dd>${fmtMs(s.timestampMs)}</dd><dt>Sources</dt><dd>${s.sources?.length || 0}</dd><dt>Total shifts</dt><dd>${shifts.length}</dd></dl>`);
    }
    if (state.view === 'metric' && (k === 'FCP' || k === 'TTFB')) {
      const net = d.network || [];
      const docReq = net.find((r) => r.resourceType === 'document');
      const target = (state.selected && net.find((r) => r.url === state.selected)) || docReq || net[0];
      if (!target) return rcard('Request details', '<div class="c-muted">No requests recorded.</div>');
      return rcard('Request details', requestDetails(target));
    }
    // Scripts (TBT / INP and non-metric views)
    const scripts = d.scripts || [];
    const selUrl = state.selected;
    const netSel = selUrl && !scripts.some((s) => s.url === selUrl) ? (d.network || []).find((r) => r.url === selUrl) : null;
    if (netSel) return rcard('Request details', requestDetails(netSel));
    const ranked = [...scripts].sort((a, b) => (b.attributedBlockingMs ?? -1) - (a.attributedBlockingMs ?? -1) || b.totalMs - a.totalMs);
    const s = scripts.find((x) => x.url === selUrl) || ranked[0];
    if (!s) return rcard('Script details', '<div class="c-muted">Lighthouse didn’t measure any script execution on this page.</div>');
    const total = scripts.reduce((a, x) => a + x.totalMs, 0) || 1;
    const share = s.totalMs / total;
    const impact = share >= 0.25 ? ['High Impact', 'poor'] : share >= 0.1 ? ['Medium Impact', 'warn'] : ['Low Impact', 'good'];
    const party = s.isThirdParty == null ? ['Unknown party', 'muted'] : s.isThirdParty ? ['Third party', 'poor'] : ['First party', 'info'];
    const hasBlocking = s.attributedBlockingMs != null;
    const start = s.firstTaskStartMs ?? s.requestStartMs;
    return rcard('Script details', `
      <div class="sd-name" title="${esc(s.url)}">${esc(host(s.url) === shortUrl(s.url) ? host(s.url) : `${host(s.url)} (${shortUrl(s.url)})`)}</div>
      <div class="sd-val"><b>${fmtMs(hasBlocking ? s.attributedBlockingMs : s.totalMs)}</b>
        <span class="pill ${party[1]}">${party[0]}</span><span class="pill ${impact[1]}">${impact[0]}</span></div>
      <div class="sd-sub">${hasBlocking ? 'blocking time' : 'main-thread time (no attributed long tasks)'}</div>
      <div class="sd-score">Main-thread share <span class="pill ${impact[1]}">${Math.round(share * 100)}%</span></div>
      <dl class="kv">
        <dt>Domain</dt><dd title="${esc(s.url)}">${esc(s.domain || host(s.url))}</dd>
        <dt>Type</dt><dd><span class="pill muted">${party[0]}</span></dd>
        <dt>Execution</dt><dd>${fmtMs(s.totalMs)} (total)${hasBlocking ? ` · ${fmtMs(s.attributedBlockingMs)} (blocking)` : ''}</dd>
        <dt>Scripting</dt><dd>${fmtMs(s.scriptingMs)}${s.parseCompileMs != null ? ` · parse ${fmtMs(s.parseCompileMs)}` : ''}</dd>
        <dt>Start time</dt><dd>${fmtMs(start)}</dd>
        <dt>Size</dt><dd>${fmtBytes(s.transferSize)}</dd>
      </dl>`, true);
  }

  function requestDetails(r) {
    return `<div class="sd-name" title="${esc(r.url)}">${esc(shortUrl(r.url))}</div>
      <div class="sd-val"><b>${fmtMs(r.durationMs)}</b><span class="pill ${r.isThirdParty ? 'poor' : 'info'}">${r.isThirdParty ? 'Third party' : 'First party'}</span><span class="pill muted">${esc(r.resourceType)}</span></div>
      <dl class="kv" style="margin-top:8px">
        <dt>URL</dt><dd title="${esc(r.url)}">${esc(r.url)}</dd>
        <dt>Domain</dt><dd>${esc(r.domain)}</dd>
        <dt>Status</dt><dd>${r.failed ? '<span class="c-poor">Failed</span>' : esc(r.status ?? '—')}</dd>
        <dt>Start</dt><dd>${fmtMs(r.requestStartMs)}</dd>
        <dt>Size</dt><dd>${fmtBytes(r.transferSize)}</dd>
      </dl>`;
  }

  function rcard(title, body, closable = false) {
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">${esc(title)}</span>${closable && state.selected ? `<button class="close-x" data-select="" aria-label="Clear selection">${ICON.x}</button>` : ''}</div>${body}</section>`;
  }

  function breakdownCard() {
    const pages = pagesForDevice().filter((p) => p.mainThreadBreakdown.length);
    if (!pages.length) return rcard('Main-thread work by page', '<div class="c-muted">No main-thread breakdown was recorded.</div>');
    return rcard('Main-thread work by page', `<div class="chart-box"><canvas id="breakdown-canvas" height="150"></canvas></div>
      <div class="note" style="padding:4px 0 0">Main-thread work per audited page (${esc(state.device)}), by category. Hover for details.</div>`);
  }

  function snippetHtml() {
    const d = state.detail;
    const k = state.view === 'metric' ? state.metric : null;
    const metricSet = k === 'TBT' || k === 'INP' ? [k, 'JavaScript', 'TBT'] : k ? [k] : null;
    const plan = (d.remediationPlans || []).find((p) => p.codeChange && (!metricSet || metricSet.includes(p.metric)));
    const finding = (d.findings || [])
      .filter((f) => !metricSet || metricSet.includes(f.metric))
      .sort((a, b) => a.priority.localeCompare(b.priority))
      .find((f) => f.codeExample?.after || f.codeExample?.before) ;
    let code = null;
    let src = '';
    if (plan) {
      code = { before: plan.codeChange.before, after: plan.codeChange.after };
      src = `Remediation plan · ${plan.rootCause}${plan.codeChange.validated ? '' : ' (not validated)'}`;
    } else if (finding) {
      code = { before: finding.codeExample.before, after: finding.codeExample.after };
      src = finding.rootCause;
    }
    const topFinding = (d.findings || []).filter((f) => !metricSet || metricSet.includes(f.metric)).sort((a, b) => a.priority.localeCompare(b.priority))[0];
    const side = code && code[state.snippetSide] ? state.snippetSide : code?.after ? 'after' : 'before';
    const snippet = code
      ? `<div class="snippet"><div class="snippet-h"><span>Auto-generated fix snippet</span>
          <span class="snippet-tabs">${code.before ? `<button data-snippet="before" class="${side === 'before' ? 'is-active' : ''}">Before</button>` : ''}${code.after ? `<button data-snippet="after" class="${side === 'after' ? 'is-active' : ''}">After</button>` : ''}<button data-copy aria-label="Copy snippet" title="Copy">${ICON.copy}</button></span></div>
          <pre id="snippet-code">${highlight(code[side] || '')}</pre>
          <div class="note" style="padding:0 8px 8px">${esc(src)}</div></div>`
      : `<div class="snippet"><div class="snippet-h"><span>Fix guidance</span></div><pre>${esc(topFinding ? `${topFinding.recommendation}${topFinding.implementationGuidance ? '\n\n' + topFinding.implementationGuidance : ''}` : 'No fixes needed for this view.')}</pre></div>`;
    return snippet;
  }

  // ------------------------------------------------------- PMW guide column
  // Everything metric-specific in the right column: which PMW guidance this
  // page's findings matched, the rest of PMW's playbook, how this page's
  // findings changed since the last run, and how PMW says to verify a fix.
  const SUB_METRIC_LABEL = { LCP: 'LCP', FCP: 'FCP', CLS: 'CLS', INP: 'INP', TBT: 'TBT', TTFB: 'TTFB' };
  const TEAM_LABEL = { 'pmw.team.design': 'Design', 'pmw.team.content': 'Content', 'pmw.team.seo': 'SEO', 'pmw.team.project-account': 'Project / Account', 'pmw.team.development': 'Development' };
  const guideFor = (k) => state.guide?.metrics?.[k] || null;
  // Which guide items the viewer expanded/collapsed, so re-renders keep them.
  const guideOpen = new Map();
  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d instanceof HTMLDetailsElement && d.dataset.gid) guideOpen.set(d.dataset.gid, d.open);
  }, true);
  /** PMW knowledge text cross-references other items by internal id, e.g. "(pmw.templates.script-placement-guidance)" — noise for a reader. */
  const clean = (t) => String(t || '').replace(/\s*\(pmw\.[\w.-]+\)/g, '').replace(/\bpmw\.[\w.-]+/g, '').replace(/\s{2,}/g, ' ').trim();
  function firstSentence(t) {
    const text = clean(t);
    const m = text.match(/^(.{20,170}?[.!?])(\s|$)/);
    if (m) return m[1];
    return text.length > 150 ? `${text.slice(0, 150).replace(/\s+\S*$/, '')}…` : text;
  }
  function itemHeadline(it) {
    if (it.knowledgeType === 'example') {
      // Case studies carry their own quoted title: Documented case study: "Wolfnest — Moved header scripts…"
      const quoted = it.explanation.match(/case study:\s*[“"]([^”"]+)[”"]/i);
      if (quoted) return quoted[1].replace(/\.$/, '');
      // Otherwise a short title from the item's own name: pmw.templates.onyx-vs-coastal-oak-example → "Onyx Vs Coastal Oak (templates)".
      const [, area = '', slug = ''] = it.id.split('.');
      const AREA = { gtm: 'GTM', youtube: 'YouTube', templates: 'templates' };
      const title = slug.replace(/-(real-)?example$/, '').split('-').map((w) => (w === 'vs' ? 'vs' : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
      return title ? `${title} (${AREA[area] || area})` : firstSentence(it.explanation);
    }
    return it.knowledgeType === 'guidance' && !/^NOT DOCUMENTED/.test(it.rootCause) ? clean(it.rootCause) : firstSentence(it.recommendation);
  }
  const documented = (v) => v && v !== 'NOT DOCUMENTED';
  function guideItem(it, { open = false, matches = null } = {}) {
    const isOpen = guideOpen.has(it.id) ? guideOpen.get(it.id) : open;
    return `<details class="gitem${matches ? ' is-match' : ''}" data-gid="${esc(it.id)}"${isOpen ? ' open' : ''}>
      <summary><span class="gitem-t">${esc(itemHeadline(it))}</span>${matches ? `<span class="pill ${matches.some((m) => m.strength === 'strong') ? 'good' : 'info'}">${matches.some((m) => m.strength === 'strong') ? 'Strong match' : 'Match'}</span>` : ''}</summary>
      <div class="gitem-b">
        ${matches ? `<h5>Why it applies here</h5><p>${esc(matches[0].matchReason)}</p>
          <ul class="gitem-ev tech-only">${[...new Set(matches.flatMap((m) => m.matchedSignals))].slice(0, 3).map((sig) => `<li><code>${esc(sig)}</code></li>`).join('')}</ul>
          ${it.findings?.length ? `<p class="c-muted">Tied to ${it.findings.length} finding${it.findings.length === 1 ? '' : 's'} on this page.</p>` : '<p class="c-muted">Detected from this page’s evidence (no finding covers it directly).</p>'}` : ''}
        ${it.knowledgeType === 'guidance' && documented(it.explanation) ? `<h5>Why it matters</h5><p>${esc(clean(it.explanation))}</p>` : ''}
        ${it.knowledgeType === 'example' ? `<h5>What happened</h5><p>${esc(clean(it.explanation))}</p>` : ''}<h5>${it.knowledgeType === 'example' ? 'The lesson' : 'What to do'}</h5><p>${esc(clean(it.recommendation))}</p>
        ${documented(it.implementationGuidance) ? `<h5>How</h5><p>${esc(clean(it.implementationGuidance))}</p>` : ''}
        ${documented(it.validationGuidance) ? `<h5>Verify</h5><p>${esc(clean(it.validationGuidance))}</p>` : ''}
        <div class="gitem-src">${esc(it.source.document.replace(/\.(docx|pptx)$/, ''))} · ${esc(it.source.location)}${it.documentedStatus === 'partially-documented' ? ' · partially documented' : ''}</div>
      </div></details>`;
  }

  function guideCard(k) {
    const g = guideFor(k);
    const head = `<div class="rcard-h"><span class="pmw-badge">PMW</span><span class="rcard-t">${esc(SUB_METRIC_LABEL[k])} guide</span></div>`;
    if (!state.guide) return `<section class="card rcard guide">${head}<div class="c-muted small">Loading PMW guidance…</div></section>`;
    if (state.guide.failed) return `<section class="card rcard guide">${head}<div class="c-muted small">Couldn’t load the PMW guide. Pick the page again to retry.</div></section>`;
    if (!g) return '';
    const { matched, playbook, examples } = g.knowledge;
    if (!matched.length && !playbook.length && !examples.length) {
      return `<section class="card rcard guide">${head}<div class="c-muted small">PMW’s performance documents don’t cover ${esc(k)} as its own metric. It’s the first phase of LCP — see the LCP guide.</div></section>`;
    }
    const showAll = state.guideExpanded === k;
    const pb = showAll ? playbook : playbook.slice(0, 4);
    return `<section class="card rcard guide">${head}
      ${matched.length
        ? `<div class="guide-sec">Applies to this page <span class="c-muted">${matched.length}</span></div>${matched.map((m, i) => guideItem(m, { open: i === 0, matches: m.matches })).join('')}`
        : `<div class="guide-sec">Applies to this page</div><div class="c-muted small guide-empty">None of PMW’s ${esc(k)} rules fired on this page’s evidence. The playbook below is reference.</div>`}
      ${playbook.length ? `<div class="guide-sec">PMW ${esc(k)} playbook <span class="c-muted">${playbook.length}</span></div>${pb.map((it) => guideItem(it)).join('')}
        ${playbook.length > 4 ? `<button class="rcard-link guide-more" data-guide-more="${esc(k)}">${showAll ? 'Show fewer' : `Show all ${playbook.length}`}</button>` : ''}` : ''}
      ${examples.length ? `<div class="guide-sec">From PMW case studies</div>${examples.slice(0, 3).map((it) => guideItem(it)).join('')}` : ''}
    </section>`;
  }

  // A one-time, plain-English intro the first time someone opens each metric.
  const PLAIN_INTRO = {
    LCP: 'LCP = how long until the main thing on the page (usually the big image or headline) shows up. Under 2.5 seconds is good.',
    FCP: 'FCP = how long the screen stays blank before anything appears. Under 1.8 seconds is good.',
    CLS: 'CLS = how much things jump around while the page loads (e.g. a button moving just as you tap it). Under 0.1 is good.',
    INP: 'INP = how quickly the page reacts when someone taps or clicks. It can only be measured from real visitors. Under 200 ms is good.',
    TBT: 'TBT = how long scripts keep the page too busy to respond while it loads. Under 200 ms is good — it’s the lab stand-in for INP.',
    TTFB: 'TTFB = how long the server takes to start sending the page. Under 0.8 seconds is good. Slow TTFB delays everything else.',
  };
  function explainerFor(k) {
    let seen = false;
    try { seen = window.localStorage.getItem(`pmw-intro-${k}`) === '1'; } catch { /* private window: just show it */ }
    if (seen || !PLAIN_INTRO[k]) return '';
    return `<div class="explainer" role="note">${ICON.bulb}<div><b>New to ${esc(k)}?</b> ${esc(PLAIN_INTRO[k])} Tabs below show what’s causing it; the right column shows how to fix it.</div><button class="x" data-dismiss-intro="${esc(k)}" aria-label="Got it, hide this">×</button></div>`;
  }

  const HISTORY_KEY = { LCP: 'lcpMs', FCP: 'fcpMs', CLS: 'cls', INP: 'inpMs', TBT: 'tbtMs', TTFB: 'ttfbMs' };
  /**
   * Plain-language "did it get better?" — ignores changes smaller than normal
   * run-to-run noise (about 10% for timings, 0.02 for CLS) so a re-test
   * doesn't claim a win or a loss that's really just variance.
   */
  function changeVerdict(k, then, now) {
    if (then == null || now == null) return null;
    const delta = now - then;
    const noise = k === 'CLS' ? 0.02 : Math.max(50, then * 0.1);
    if (Math.abs(delta) < noise) return { tone: 'muted', text: `No real change in ${k} — within normal test-to-test variation.` };
    const r = rating(k, now);
    return delta < 0
      ? { tone: 'good', text: `${k} got better${r === 'good' ? ' and is now in the good range' : ''}.` }
      : { tone: 'poor', text: `${k} got worse since the previous audit.` };
  }

  /** Side-by-side drawer: this page's previous audit vs now — key numbers and each run's loading filmstrip. */
  async function openBeforeAfter() {
    const D = window.PSI.drawer;
    D.open('<div class="empty">Loading…</div>', 'Before and after');
    const tok = ++D.seq;
    let data;
    try {
      data = await api(`/api/audits/${encodeURIComponent(state.auditId)}/dashboard/pages/${encodeURIComponent(state.pageId)}/before-after`);
    } catch (err) {
      if (tok === D.seq) D.set(`<div class="empty">Couldn’t load the comparison: ${esc(err.message)}</div>`);
      return;
    }
    if (tok !== D.seq) return;
    if (!data.before) return D.set('<h2 class="drawer-t">Before and after</h2><div class="empty">There’s no earlier audit of this page to compare with yet. Use “Re-test this page” after making a change.</div>');
    const keys = ['LCP', 'CLS', 'TBT', 'FCP', 'TTFB', 'INP'];
    const verdicts = keys.map((k) => [k, changeVerdict(k, metricValue(data.before.vitals, k), metricValue(data.now.vitals, k))]).filter(([, v]) => v);
    const better = verdicts.filter(([, v]) => v.tone === 'good').map(([k]) => k);
    const worse = verdicts.filter(([, v]) => v.tone === 'poor').map(([k]) => k);
    const headline = better.length && !worse.length ? ['good', `Better: ${better.join(', ')} improved and nothing got worse.`]
      : worse.length && !better.length ? ['poor', `Worse: ${worse.join(', ')} got slower.`]
        : better.length ? ['muted', `Mixed: ${better.join(', ')} improved; ${worse.join(', ')} got worse.`]
          : ['muted', 'No real change — differences are within normal test-to-test variation.'];
    const col = (label, side) => {
      const fs = side.filmstrip;
      const frames = (fs?.frames || []).filter((f) => f.data);
      return `<div class="ba-col"><h3>${label}</h3><div class="c-muted small">${esc(fmtDate(side.startedAt))}${side.score != null ? ` · score ${Math.round(side.score * 100)}` : ''}</div>
        <div class="ba-metrics">${['LCP', 'CLS', 'TBT'].map((k) => { const v = metricValue(side.vitals, k); return `<div>${k}<b class="c-${v == null ? 'muted' : rating(k, v)}">${esc(fmtMetric(k, v))}</b></div>`; }).join('')}</div>
        ${frames.length ? `<div class="ba-strip">${frames.map((f) => `<figure><img src="${esc(f.data)}" alt="Page at ${esc(fmtMs(f.timingMs, { seconds: true }))}"/>${esc(fmtMs(f.timingMs, { seconds: true }))}</figure>`).join('')}</div>` : '<div class="c-muted small">No loading screenshots for this run.</div>'}</div>`;
    };
    D.set(`<h2 class="drawer-t">Before and after</h2>
      <p class="c-muted small">${esc(pagePath(data.url))} · ${esc(data.device)}</p>
      <div class="ba-verdict ${headline[0]}">${esc(headline[1])}</div>
      <div class="ba-grid">${col('Before', data.before)}${col('Now', data.now)}</div>
      <p class="note">Each strip shows the page as it loaded, left to right. Earlier content = a faster-feeling page. Small differences between runs are normal; re-test once more if a result looks surprising.</p>`);
  }

  function beforeNowCard(k) {
    const head = '<div class="rcard-h"><span class="rcard-t">Before → now</span><button class="rcard-link" data-nav="history">History →</button></div>';
    if (!state.guide) return `<section class="card rcard">${head}<div class="c-muted small">Loading…</div></section>`;
    if (state.guide.failed) return `<section class="card rcard">${head}<div class="c-muted small">Couldn’t load this page’s earlier audits.</div></section>`;
    const pts = state.guide.history.filter((h) => h[HISTORY_KEY[k]] != null);
    const diff = guideFor(k)?.diff;
    const retestBtn = '<button class="btn btn-ghost btn-sm" data-retest title="Audit just this page again (about a minute) to check a fix">↻ Re-test this page</button>';
    if (!state.guide.previous) {
      return `<section class="card rcard">${head}<div class="c-muted small">This is the first audit of this page on ${esc(state.device)}. After making a fix, re-test just this page to see what changed.</div><div class="f-actions">${retestBtn}</div></section>`;
    }
    // "This audit" is the audit being viewed — never an earlier point that
    // happens to be the last one with a value.
    const now = pts.find((p) => p.auditId === state.auditId)?.[HISTORY_KEY[k]];
    const prevPt = [...pts].reverse().find((p) => p.auditId === state.guide.previous.auditId);
    const then = prevPt?.[HISTORY_KEY[k]];
    const delta = now != null && then != null ? now - then : null;
    const better = delta != null && delta < 0;
    const deltaTxt = delta == null ? '' : k === 'CLS' ? `${delta >= 0 ? '+' : '−'}${num(Math.abs(delta), 3)}` : `${delta >= 0 ? '+' : '−'}${fmtMs(Math.abs(delta))}`;
    const list = (items, tone, icon, label) => (items?.length ? `<div class="diff-h ${tone}">${icon} ${label} <span>${items.length}</span></div><ul class="diff-list">${items.slice(0, 4).map((f) => `<li>${esc(f.rootCause)}</li>`).join('')}${items.length > 4 ? `<li class="c-muted">+${items.length - 4} more</li>` : ''}</ul>` : '');
    return `<section class="card rcard">${head}
      <div class="bn-row"><div><div class="c-muted small">${esc(fmtDate(state.guide.previous.startedAt))}</div><b>${esc(fmtMetric(k, then))}</b></div>
        <span class="bn-arrow">→</span><div><div class="c-muted small">This audit</div><b class="c-${rating(k, now) === 'none' ? 'muted' : rating(k, now)}">${esc(fmtMetric(k, now))}</b></div>
        ${delta != null && Math.abs(delta) > (k === 'CLS' ? 0.0005 : 0.5) ? `<span class="pill ${better ? 'good' : 'poor'}">${esc(deltaTxt)}</span>` : delta != null ? '<span class="pill muted">±0</span>' : ''}</div>
      ${changeVerdict(k, then, now) ? `<div class="bn-verdict c-${changeVerdict(k, then, now).tone}">${esc(changeVerdict(k, then, now).text)}</div>` : ''}
      <div class="f-actions" style="margin:4px 0 8px">${retestBtn}<button class="btn btn-ghost btn-sm" data-before-after>Compare loading side by side</button></div>
      ${pts.length > 1 ? `<div class="chart-box"><canvas id="spark-canvas" height="46" data-spark-metric="${esc(k)}"></canvas></div><div class="note" style="padding:2px 0 6px">This page (${esc(state.device)}) across ${pts.length} audits · ${esc(k)} good ≤ ${esc(fmtMetric(k, METRICS[k].good))}</div>` : ''}
      ${diff ? (diff.resolved.length + diff.added.length + diff.stillOpen.length
        ? list(diff.resolved, 'good', '✓', 'Resolved since last audit') + list(diff.added, 'poor', '✕', 'New this audit') + list(diff.stillOpen, 'muted', '•', 'Still open')
        : `<div class="c-muted small">No ${esc(k)} findings in either audit.</div>`) : ''}
      ${notesList(state.guide.history.map((h) => h.auditId))}
    </section>`;
  }
  function drawSparkline() {
    const canvas = $('#spark-canvas');
    if (!canvas || !state.guide) return;
    const k = canvas.dataset.sparkMetric;
    const pts = state.guide.history.filter((h) => h[HISTORY_KEY[k]] != null);
    const { ctx, w, h } = setupCanvas(canvas);
    const vals = pts.map((p) => p[HISTORY_KEY[k]]);
    const max = Math.max(...vals, METRICS[k].good) * 1.1;
    const x = (i) => 6 + (i / Math.max(1, pts.length - 1)) * (w - 12);
    const y = (v) => h - 4 - (v / max) * (h - 10);
    ctx.strokeStyle = 'rgba(34,192,122,0.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, y(METRICS[k].good)); ctx.lineTo(w, y(METRICS[k].good)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = '#5aa2ff'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    vals.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(i), y(v))));
    ctx.stroke();
    const hits = [];
    vals.forEach((v, i) => {
      const r = rating(k, v);
      ctx.fillStyle = r === 'good' ? '#22c07a' : r === 'warn' ? '#f2b33d' : '#ef5a4c';
      ctx.beginPath(); ctx.arc(x(i), y(v), i === vals.length - 1 ? 3.6 : 2.6, 0, Math.PI * 2); ctx.fill();
      hits.push({ x: x(i), p: pts[i], v });
    });
    const hit = (e) => { const r = canvas.getBoundingClientRect(); return hits.reduce((best, c) => (Math.abs(c.x - (e.clientX - r.left)) < Math.abs(best.x - (e.clientX - r.left)) ? c : best), hits[0]); };
    canvas.onmousemove = (e) => { const c = hit(e); showTip(e, `<b>${esc(fmtMetric(k, c.v))}</b><br>${esc(fmtDate(c.p.startedAt))}${c.p.auditId === state.auditId ? ' · this audit' : '<br><span class="c-muted">Click to open this audit</span>'}`); };
    canvas.onmouseleave = hideTip;
    canvas.onclick = (e) => { const c = hit(e); if (c.p.auditId !== state.auditId) loadAudit(c.p.auditId); };
  }

  function fixVerifyCard(k) {
    const g = guideFor(k);
    const kn = g?.knowledge;
    const verify = [];
    const add = (t) => { if (documented(t) && !verify.includes(t)) verify.push(t); };
    (kn?.matched || []).forEach((it) => add(it.validationGuidance));
    if (!verify.length) (kn?.playbook || []).filter((it) => it.primary).slice(0, 2).forEach((it) => add(it.validationGuidance));
    const pr = (id) => (kn?.principles || []).find((p) => p.id === id);
    const field = pr('pmw.lab-field.crux-28-day-window') || pr('pmw.lab-field.field-data-model');
    const whenNot = pr('pmw.principle.change-when-not-whether') || pr('pmw.gtm.optimize-not-delay') || pr('pmw.principle.dont-load-everything-immediately') || pr('pmw.principle.prioritize-what-users-see-first');
    const owners = (kn?.team || []).map((t) => `<span class="pill muted" data-tip="${esc(esc(clean(t.recommendation)))}">${esc(TEAM_LABEL[t.id] || t.id)}</span>`).join(' ');
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Fix & verify</span></div>
      ${snippetHtml()}
      ${verify.length || field ? `<div class="guide-sec" style="margin-top:12px">How PMW verifies it</div><ol class="verify">
        ${verify.map((v) => `<li>${esc(clean(v))}</li>`).join('')}
        ${field && k !== 'TBT' && k !== 'FCP' ? `<li>${esc(firstSentence(field.recommendation))}</li>` : ''}
        <li>A fix isn’t finished until it’s re-tested in the lab and confirmed in real-user data.</li></ol>` : ''}
      ${whenNot ? `<div class="principle">${ICON.bulb}<span>${esc(firstSentence(whenNot.recommendation))}</span></div>` : ''}
      ${owners ? `<div class="guide-sec" style="margin-top:12px">Who owns this at PMW</div><div class="owners">${owners}</div>` : ''}
    </section>`;
  }

  function surfaceCard() {
    return `<section class="card rcard"><div class="rcard-h"><span class="rcard-t">Blocking across the site</span></div>
      <div class="rc-desc">Main-thread blocking for every audited page (depth) across load time (width). Peaks show where long tasks stall pages site-wide.</div>
      <div class="chart-box"><canvas id="surface-canvas" height="190"></canvas></div></section>`;
  }

  function highlight(code) {
    return esc(code)
      .replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="tk-tag">$2</span>')
      .replace(/([\w-]+)=(&quot;.*?&quot;)/g, '<span class="tk-attr">$1</span>=<span class="tk-str">$2</span>');
  }

  // ---------------------------------------------------------------- canvases
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = Number(canvas.getAttribute('height'));
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    return { ctx, w, h };
  }

  function drawCanvases() {
    drawBreakdown();
    drawSurface();
    drawCruxHistory();
  }

  let breakdownHit = [];
  function drawBreakdown() {
    const canvas = $('#breakdown-canvas');
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const pages = pagesForDevice().filter((p) => p.mainThreadBreakdown.length).slice(0, 24);
    const totals = pages.map((p) => p.mainThreadBreakdown.reduce((a, b) => a + b.ms, 0));
    const max = Math.max(...totals) * 1.08;
    const padL = 36, padB = 16, padT = 4;
    const ch = h - padB - padT;
    ctx.font = '9.5px Inter, sans-serif';
    ctx.fillStyle = '#6f7f96';
    ctx.strokeStyle = 'rgba(120,140,170,0.12)';
    const step = niceStep(max, 4);
    for (let t = 0; t <= max; t += step) {
      const y = padT + ch - (t / max) * ch;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.fillText(t >= 1000 ? `${num(t / 1000, 1)}s` : `${Math.round(t)}`, 0, y + 3);
    }
    const slot = (w - padL) / pages.length;
    const bw = Math.max(3, Math.min(14, slot * 0.7));
    breakdownHit = [];
    pages.forEach((p, i) => {
      let y = padT + ch;
      const x = padL + i * slot + (slot - bw) / 2;
      const groups = [...p.mainThreadBreakdown].sort((a, b) => Object.keys(BREAKDOWN_COLORS).indexOf(a.group) - Object.keys(BREAKDOWN_COLORS).indexOf(b.group));
      groups.forEach((g) => {
        const gh = (g.ms / max) * ch;
        ctx.fillStyle = BREAKDOWN_COLORS[g.group] || BREAKDOWN_COLORS.Other;
        ctx.fillRect(x, y - gh, bw, Math.max(0, gh - 0.6));
        y -= gh;
      });
      if (p.id === state.pageId) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
        ctx.strokeRect(x - 1.5, y - 1.5, bw + 3, padT + ch - y + 3);
      }
      breakdownHit.push({ x0: padL + i * slot, x1: padL + (i + 1) * slot, page: p, total: totals[i] });
    });
    ctx.fillStyle = '#6f7f96';
    const labelEvery = Math.ceil(pages.length / 5);
    pages.forEach((p, i) => {
      if (i % labelEvery) return;
      const lbl = pagePath(p.url).replace(' (home)', '').slice(0, 8) || '/';
      ctx.fillText(lbl, padL + i * slot, h - 3);
    });
    canvas.onmousemove = (e) => {
      const r = canvas.getBoundingClientRect();
      const hit = breakdownHit.find((b) => e.clientX - r.left >= b.x0 && e.clientX - r.left < b.x1);
      if (!hit) return hideTip();
      showTip(e, `<b>${esc(pagePath(hit.page.url))}</b> · ${fmtMs(hit.total)}<br>${hit.page.mainThreadBreakdown
        .map((g) => `<span style="color:${BREAKDOWN_COLORS[g.group] || BREAKDOWN_COLORS.Other}">■</span> ${esc(g.group)}: ${fmtMs(g.ms)}`).join('<br>')}<br><span class="c-muted">Click to open this page</span>`);
    };
    canvas.onmouseleave = hideTip;
    canvas.onclick = (e) => {
      const r = canvas.getBoundingClientRect();
      const hit = breakdownHit.find((b) => e.clientX - r.left >= b.x0 && e.clientX - r.left < b.x1);
      if (hit) selectPage(hit.page.id);
    };
  }

  // Blocking-ms grid: rows = pages, columns = time buckets across load.
  function blockingGrid() {
    let pages = pagesForDevice().filter((p) => p.status !== 'failed');
    const cols = 20;
    const maxT = Math.max(1000, ...pages.flatMap((p) => p.longTasks.map((t) => t.startMs + t.durationMs)));
    const bucket = maxT / cols;
    let grid = pages.map((p) => {
      const row = new Array(cols).fill(0);
      for (const t of p.longTasks) {
        const bStart = t.startMs + LONG_TASK_MS;
        const bEnd = t.startMs + t.durationMs;
        for (let c = Math.floor(bStart / bucket); c <= Math.min(cols - 1, Math.floor(bEnd / bucket)); c++) {
          const overlap = Math.min(bEnd, (c + 1) * bucket) - Math.max(bStart, c * bucket);
          if (overlap > 0) row[c] += overlap;
        }
      }
      return row;
    });
    // Busiest pages toward the back, like a ridge.
    const order = grid.map((r, i) => [r.reduce((a, b) => a + b, 0), i]).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    grid = order.map((i) => grid[i]);
    pages = order.map((i) => pages[i]);
    while (grid.length < 4) { grid.unshift(new Array(cols).fill(0)); grid.push(new Array(cols).fill(0)); }
    // Two light 3×3 smoothing passes so the surface reads as terrain rather
    // than spikes (the peak height label is taken from the smoothed grid).
    const smooth = (g) => g.map((row, y) => row.map((_, x) => {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const v = g[y + dy]?.[x + dx];
        if (v != null) { const wgt = dx === 0 && dy === 0 ? 4 : 1; s += v * wgt; n += wgt; }
      }
      return s / n;
    }));
    const sm = smooth(smooth(grid));
    return { grid: sm, maxT, rows: sm.length, cols };
  }

  function turbo(t) {
    const stops = [[0, [48, 18, 130]], [0.2, [40, 100, 230]], [0.4, [30, 190, 220]], [0.6, [80, 220, 110]], [0.78, [240, 210, 50]], [1, [230, 60, 40]]];
    t = Math.max(0, Math.min(1, t));
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1];
        const [t1, c1] = stops[i];
        const f = (t - t0) / (t1 - t0);
        return c0.map((c, j) => Math.round(c + (c1[j] - c) * f));
      }
    }
    return stops.at(-1)[1];
  }

  function drawSurface() {
    const canvas = $('#surface-canvas');
    if (!canvas) return;
    const { ctx, w, h } = setupCanvas(canvas);
    const { grid, maxT, rows, cols } = blockingGrid();
    const zMax = Math.max(1, ...grid.flat());
    const flat = zMax <= 1;
    // Oblique projection (x → right, rows → up-right, z → up), then scaled to fit the canvas.
    const raw = (x, y, z) => [x + y * 0.55, -y * 0.32 + x * 0.06 - (z / zMax) * rows * 0.75];
    const corners = [];
    for (const x of [0, cols - 1]) for (const y of [0, rows - 1]) for (const z of [0, zMax]) corners.push(raw(x, y, z));
    const minX = Math.min(...corners.map((c) => c[0])), maxX = Math.max(...corners.map((c) => c[0]));
    const minY = Math.min(...corners.map((c) => c[1])), maxY = Math.max(...corners.map((c) => c[1]));
    const pad = { l: 30, r: 12, t: 18, b: 22 };
    const sx = (w - pad.l - pad.r) / (maxX - minX), sy = (h - pad.t - pad.b) / (maxY - minY);
    const P = (x, y, z) => { const [a, b] = raw(x, y, z); return [pad.l + (a - minX) * sx, pad.t + (b - minY) * sy]; };
    // Floor + walls grid
    ctx.strokeStyle = 'rgba(140,160,190,0.18)';
    ctx.lineWidth = 0.6;
    for (let x = 0; x <= cols; x += 2) { const a = P(x, 0, 0), b = P(x, rows - 1, 0); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
    for (let y = 0; y < rows; y += Math.max(1, Math.floor(rows / 8))) { const a = P(0, y, 0), b = P(cols - 1, y, 0); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
    for (let z = 0; z <= zMax; z += zMax / 4) { const a = P(0, rows - 1, z), b = P(cols - 1, rows - 1, z); ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); }
    // Quads back to front
    for (let y = rows - 2; y >= 0; y--) {
      for (let x = 0; x < cols - 1; x++) {
        const z = [grid[y][x], grid[y][x + 1], grid[y + 1][x + 1], grid[y + 1][x]];
        const pts = [P(x, y, z[0]), P(x + 1, y, z[1]), P(x + 1, y + 1, z[2]), P(x, y + 1, z[3])];
        const avg = (z[0] + z[1] + z[2] + z[3]) / 4 / zMax;
        const [r, g, b] = turbo(flat ? 0.15 : avg);
        ctx.beginPath();
        ctx.moveTo(...pts[0]);
        pts.slice(1).forEach((p) => ctx.lineTo(...p));
        ctx.closePath();
        ctx.fillStyle = `rgba(${r},${g},${b},0.92)`;
        ctx.fill();
        ctx.strokeStyle = 'rgba(10,17,29,0.35)';
        ctx.lineWidth = 0.4;
        ctx.stroke();
      }
    }
    ctx.fillStyle = '#8b9ab0';
    ctx.font = '9.5px Inter, sans-serif';
    const xl = P(cols * 0.35, 0, 0);
    ctx.fillText(`Load time → ${maxT >= 1000 ? num(maxT / 1000, 1) + 's' : Math.round(maxT) + 'ms'}`, xl[0], Math.min(h - 4, xl[1] + 14));
    const yl = P(cols - 1, rows * 0.35, 0);
    ctx.save(); ctx.translate(Math.min(w - 30, yl[0] + 4), yl[1] + 4); ctx.rotate(-0.5); ctx.fillText('Pages', 0, 0); ctx.restore();
    const zl = P(0, rows - 1, zMax);
    if (!flat) ctx.fillText(`${Math.round(zMax)} ms`, Math.max(16, zl[0] - 10), Math.max(10, zl[1] - 4));
    ctx.save(); ctx.translate(9, h / 2 + 30); ctx.rotate(-Math.PI / 2); ctx.fillText('Blocking (ms)', 0, 0); ctx.restore();
    if (flat) {
      ctx.fillStyle = '#a9b6c8';
      ctx.font = '11px Inter, sans-serif';
      ctx.fillText('No main-thread blocking recorded', w / 2 - 88, 22);
    }
  }

  // ---------------------------------------------------------------- tooltip
  // Tooltip content comes from a data-tip attribute and is inserted as HTML.
  // The browser decodes the attribute once, so every data-tip must be
  // `esc(html)` where `html` already has its own data escaped — i.e. data
  // ends up escaped twice. (Gantt tips follow this via esc(r.tip).)
  let tipEl = null;
  function showTip(e, html) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tooltip'; document.body.appendChild(tipEl); }
    tipEl.innerHTML = html;
    tipEl.style.display = 'block';
    const x = Math.min(e.clientX + 12, window.innerWidth - tipEl.offsetWidth - 8);
    const y = Math.min(e.clientY + 14, window.innerHeight - tipEl.offsetHeight - 8);
    tipEl.style.left = `${x}px`;
    tipEl.style.top = `${y}px`;
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el.dataset.tip) showTip(e, el.dataset.tip);
  });
  document.addEventListener('mousemove', (e) => {
    const el = e.target.closest('[data-tip]');
    if (el && el.dataset.tip) showTip(e, el.dataset.tip);
    else if (!e.target.closest('canvas')) hideTip();
  });

  // ----------------------------------------------------------------- events
  async function selectPage(id) {
    state.pageId = id;
    $('#page-select').value = id;
    $('#site-path').textContent = pagePath(currentSummaryPage()?.url || '');
    await loadPage();
  }

  document.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-exp-run],[data-source-tab],[data-source-kind],[data-source-line],[data-source-file],[data-copy-text],[data-glossary],[data-simple-toggle],[data-owner-filter],[data-export-tasks],[data-export-copy],[data-export-csv],[data-vl-frame],[data-key-page],[data-dismiss-intro],[data-fstate],[data-copy-dev],[data-toggle-ignored],[data-retest],[data-before-after],[data-visual-source],[data-toggle-issues],[data-open-fix],[data-open-page],[data-crux-scope],[data-guide-more],[data-metric],[data-nav],[data-tab],[data-sort],[data-select],[data-scale],[data-snippet],[data-copy]');
    if (!t) return;
    // A link inside a <details> summary acts as a link, not as expand/collapse.
    if (t.closest('summary') && t.tagName !== 'SUMMARY') e.preventDefault();
    if (t.dataset.metric) {
      state.view = 'metric';
      state.metric = t.dataset.metric;
      state.tab = 'findings';
      state.selected = null;
      return render();
    }
    if (t.dataset.nav) {
      const nav = t.dataset.nav;
      if (nav === 'dashboard') state.view = state.summary ? 'overview' : 'new-audit';
      else if (nav === 'performance') state.view = 'metric';
      else if (CATEGORIES[nav]) { state.view = 'category'; state.category = nav; }
      else state.view = nav;
      state.selected = null;
      return render();
    }
    if (t.dataset.tab) { state.tab = t.dataset.tab; return render(); }
    if ('toggleIssues' in t.dataset) { state.showAllIssues = !state.showAllIssues; return render(); }
    if ('expRun' in t.dataset) {
      const x = state.exp;
      if (!x?.data) return;
      const block = x.data.thirdParties.filter((tp) => x.picked.block.has(tp.domains[0])).flatMap((tp) => tp.domains);
      try {
        const job = await api(`/api/audits/${encodeURIComponent(state.auditId)}/dashboard/pages/${encodeURIComponent(state.pageId)}/experiments`, { method: 'POST', body: JSON.stringify({ fixes: [...x.picked.fixes], block }) });
        x.data.active = job;
        pollExperiment(job.id, x.key);
        toast('Experiment started — about a minute or two');
      } catch (err) {
        toast(err.message, 6000);
      }
      return render();
    }
    if (t.dataset.sourceTab) { state.sourceTab = t.dataset.sourceTab; return render(); }
    if (t.dataset.sourceKind) { state.sourceKind = t.dataset.sourceKind; state.sourceLine = null; return render(); }
    if (t.dataset.sourceLine) {
      state.view = 'source';
      state.sourceTab = 'code';
      state.sourceKind = 'raw';
      state.sourceSearch = '';
      state.sourceLine = Number(t.dataset.sourceLine);
      return render();
    }
    if (t.dataset.sourceFile) return openSourceFile(t.dataset.sourceFile);
    if (t.dataset.copyText != null) return toast((await copyText(t.dataset.copyText)) ? 'Copied' : 'Couldn’t copy');
    if ('glossary' in t.dataset) return openGlossary();
    if ('simpleToggle' in t.dataset) {
      state.simple = !state.simple;
      try { window.localStorage.setItem('pmw-simple', state.simple ? '1' : '0'); } catch { /* not remembered — fine */ }
      document.body.classList.toggle('simple-mode', state.simple);
      syncSimpleToggle();
      return render();
    }
    if ('ownerFilter' in t.dataset) { state.ownerFilter = t.dataset.ownerFilter || null; return render(); }
    if ('exportTasks' in t.dataset) return exportTasks();
    if ('exportCopy' in t.dataset) return toast((await copyText(exportTasks.md || '')) ? 'Copied — paste it into an email, doc or ticket' : 'Couldn’t copy');
    if ('exportCsv' in t.dataset) return downloadText(`speed-tasks-${host(state.summary.audit.targetUrl)}-${state.device}.csv`, exportTasks.csv || '', 'text/csv');
    if (t.dataset.vlFrame != null) {
      const i = Number(t.dataset.vlFrame);
      state.vlFrame = state.vlFrame === i ? null : i;
      return render();
    }
    if (t.dataset.keyPage) {
      const url = t.dataset.keyPage;
      const isKey = !isKeyPage(url);
      try {
        await api('/api/key-pages', { method: 'POST', body: JSON.stringify({ site: state.summary.site, url, key: isKey }) });
      } catch (err) {
        return toast(`Couldn’t save that: ${err.message}`);
      }
      const norm = normUrl(url);
      state.summary.keyPages = isKey ? [...(state.summary.keyPages || []), norm] : (state.summary.keyPages || []).filter((u) => u !== norm);
      toast(isKey ? 'Marked as a key page — its issues now rank higher' : 'No longer a key page');
      // Re-read the summary so issue ranking reflects the new key page.
      try {
        const fresh = await api(`/api/audits/${encodeURIComponent(state.auditId)}/dashboard`);
        if (fresh.audit.id === state.auditId) state.summary = fresh;
      } catch { /* keep the local update */ }
      return render();
    }
    if (t.dataset.dismissIntro) {
      try { window.localStorage.setItem(`pmw-intro-${t.dataset.dismissIntro}`, '1'); } catch { /* not persisted — fine */ }
      t.closest('.explainer')?.remove();
      return;
    }
    if ('toggleIgnored' in t.dataset) { state.showIgnored = !state.showIgnored; return render(); }
    if (t.dataset.fstate) {
      const key = t.dataset.fkey;
      const status = t.dataset.fstate === 'clear' ? null : t.dataset.fstate;
      try {
        await api('/api/finding-states', { method: 'POST', body: JSON.stringify({ site: state.summary.site, key, status }) });
      } catch (err) {
        return toast(`Couldn’t save that: ${err.message}`);
      }
      state.summary.findingStates ||= {};
      if (status) state.summary.findingStates[key] = { key, status, updatedAt: new Date().toISOString() };
      else delete state.summary.findingStates[key];
      toast(status === 'fixed' ? 'Marked as fixed — re-run the audit to confirm it’s gone' : status === 'ignored' ? 'Ignored on this site — it’s hidden from lists now' : 'Cleared');
      return render();
    }
    if (t.dataset.copyDev) {
      const f = (state.detail?.findings || []).find((x) => x.id === t.dataset.copyDev);
      if (!f) return;
      return toast((await copyText(developerTicket(f))) ? 'Copied — paste it into a ticket or message for your developer' : 'Couldn’t copy to the clipboard');
    }
    if ('retest' in t.dataset) {
      if (!state.detail) return;
      return window.PSI.startAudit({ url: state.detail.url, maxPages: 1, ai: false });
    }
    if ('beforeAfter' in t.dataset) return openBeforeAfter();
    if ('openFix' in t.dataset) {
      window.PSI.pendingRemediationAudit = state.auditId;
      state.view = 'remediation';
      return render();
    }
    if (t.dataset.openPage) {
      // From a site-wide issue: open that page, on the issue's metric when it has one.
      if (t.dataset.openMetric) { state.view = 'metric'; state.metric = t.dataset.openMetric; state.tab = 'findings'; }
      else if (t.dataset.openCategory) { state.view = 'category'; state.category = t.dataset.openCategory; }
      else state.view = 'diagnostics';
      return selectPage(t.dataset.openPage);
    }
    if (t.dataset.cruxScope) { state.cruxScope = t.dataset.cruxScope; return render(); }
    if (t.dataset.visualSource) { state.visualSource = t.dataset.visualSource; return render(); }
    if (t.dataset.guideMore) {
      state.guideExpanded = state.guideExpanded === t.dataset.guideMore ? null : t.dataset.guideMore;
      renderRight();
      return drawCanvases();
    }
    if (t.dataset.scale) { state.chartScale = t.dataset.scale; return render(); }
    if (t.dataset.snippet) { state.snippetSide = t.dataset.snippet; return renderRight(), drawCanvases(); }
    if (t.hasAttribute('data-copy')) {
      const text = $('#snippet-code')?.textContent || '';
      try { await navigator.clipboard.writeText(text); toast('Snippet copied'); } catch { toast('Couldn’t copy — select the text instead'); }
      return;
    }
    if (t.dataset.sort) {
      const [id, key] = t.dataset.sort.split(':');
      state.sort[id] = key;
      return render();
    }
    if ('select' in t.dataset) {
      const v = t.dataset.select;
      if (v.startsWith('page:')) {
        // From the site overview, a page opens into its performance view.
        if (state.view === 'overview') { state.view = 'metric'; state.metric = 'LCP'; state.tab = 'findings'; }
        return selectPage(v.slice(5));
      }
      state.selected = v || null;
      const scrollTop = main.scrollTop;
      render();
      main.scrollTop = scrollTop;
    }
  });

  $('#device-toggle').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-device]');
    if (!b || b.disabled || b.dataset.device === state.device || !state.summary) return;
    state.device = b.dataset.device;
    state.ownerFilter = null;
    pickDefaultPage();
    renderChrome();
    await loadPage();
  });
  // Try-a-fix checkboxes.
  main.addEventListener('change', (e) => {
    const el = e.target.closest('[data-exp-fix],[data-exp-block]');
    if (!el || !state.exp) return;
    const set = el.dataset.expFix ? state.exp.picked.fixes : state.exp.picked.block;
    const id = el.dataset.expFix || el.dataset.expBlock;
    if (el.checked) set.add(id); else set.delete(id);
    render();
  });
  // Code search in the Source view (debounced; re-renders only that view).
  let srcSearchT;
  main.addEventListener('input', (e) => {
    const el = e.target.closest('[data-source-search]');
    if (!el) return;
    clearTimeout(srcSearchT);
    srcSearchT = setTimeout(() => {
      state.sourceSearch = el.value;
      state.sourceLine = null;
      render();
      const again = main.querySelector('[data-source-search]');
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }, 250);
  });
  // "View desktop instead" on a failed page does what the toggle does.
  main.addEventListener('click', (e) => {
    const b = e.target.closest('[data-device-switch]');
    if (b) $(`#device-toggle button[data-device="${b.dataset.deviceSwitch}"]`)?.click();
  });
  $('#page-select').addEventListener('change', (e) => selectPage(e.target.value));
  // Type-to-find: pick a page by its path from the datalist suggestions.
  $('#page-search').addEventListener('change', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const hit = pagesForDevice().find((p) => pagePath(p.url).toLowerCase() === q) || pagesForDevice().find((p) => pagePath(p.url).toLowerCase().includes(q));
    e.target.value = '';
    if (hit) selectPage(hit.id);
    else if (q) toast('No page matches that path');
  });
  $('#audit-select').addEventListener('change', (e) => loadAudit(e.target.value));
  $('#rail-search').addEventListener('click', () => $('#page-search').focus());

  // "Re-Run" only when the box holds the site being viewed; any other URL is a new audit.
  function isCurrentSite(url) {
    return Boolean(state.summary) && url.trim().replace(/\/$/, '') === state.summary.audit.targetUrl.replace(/\/$/, '');
  }
  function syncRunButton() {
    $('#rerun-btn').textContent = isCurrentSite($('#url-input').value) ? 'Re-Run Audit' : 'Run Audit';
  }
  $('#url-input').addEventListener('input', syncRunButton);

  $('#rerun-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#url-input').value.trim();
    if (!url) return toast('Enter a URL to audit');
    const sameSite = isCurrentSite(url);
    window.PSI.startAudit({
      url,
      maxPages: sameSite ? state.summary.audit.options.maxPages : 20,
      ai: sameSite ? Boolean(state.summary.audit.options.aiEnabled) : false,
    });
  });

  let resizeT;
  window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(drawCanvases, 120); });

  function navigate(view) {
    state.view = view;
    state.selected = null;
    render();
  }

  // Simple / Detailed switch in the scope bar, and a glossary button on the rail.
  function syncSimpleToggle() {
    const b = $('#simple-toggle');
    if (!b) return;
    b.textContent = state.simple ? 'Simple view' : 'Detailed view';
    b.setAttribute('aria-pressed', String(state.simple));
    b.title = state.simple ? 'Showing the plain-English essentials — click for all technical detail' : 'Showing all technical detail — click for a simpler view';
  }
  (() => {
    const bar = $('#scopebar');
    if (bar && !$('#simple-toggle')) {
      const b = document.createElement('button');
      b.id = 'simple-toggle';
      b.className = 'simple-toggle';
      b.dataset.simpleToggle = '';
      bar.append(b);
      syncSimpleToggle();
    }
    const settingsBtn = document.querySelector('.rail [data-nav="settings"]');
    if (settingsBtn && !document.querySelector('.rail [data-glossary]')) {
      const g = document.createElement('button');
      g.className = 'rail-btn';
      g.dataset.glossary = '';
      g.title = 'What the terms mean';
      g.setAttribute('aria-label', 'Glossary');
      g.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><path d="M12 17h.01"/></svg>';
      settingsBtn.before(g);
    }
  })();

  // Same identity the server uses (keyPagePath): path + query, so www and apex share key pages.
  const normUrl = (u) => {
    try { const x = new URL(u); return `${x.pathname.replace(/\/+$/, '') || '/'}${x.search}`; } catch { return String(u || '').replace(/\/+$/, ''); }
  };
  const isKeyPage = (u) => (state.summary?.keyPages || []).includes(normUrl(u));

  // ------------------------------------------------------ welcome & tour
  // First launch: ask who's using the engine (sets Simple / Detailed view),
  // then a short tour that spotlights the main places. Steps whose target
  // isn't on screen (e.g. no audit yet) are skipped. Re-open from the ? rail button.
  const TOUR = [
    { view: 'new-audit', target: '#audit-form', title: 'Start here', text: 'Type any website and pick how much to check. “Quick check” (1 page) takes about 2 minutes; you can keep using the app while it runs.' },
    { view: 'overview', target: '.ff-list, .card:has(.ff-list)', title: 'Fix this first', text: 'After an audit, this is the to-do list: the most important fixes in plain words, who usually does each one, how big a job it is, and how many pages it helps. Mark them fixed or ignored as you go.' },
    { view: 'overview', target: '#side-cwv', title: 'The speed measures', text: 'Google’s three Core Web Vitals and the other speed measures for the selected page. Click one for what’s causing it, the loading filmstrip, and how to fix it. Hover dotted words for a plain explanation.' },
    { view: 'overview', target: '.side-item[data-nav="experiments"]', title: 'Try a fix first', text: 'Test a change before anyone touches the site — the engine measures the page with and without it, in its own test browser only.' },
    { view: 'overview', target: '.side-item[data-nav="source"]', title: 'The page’s code', text: 'For developers: the exact line of HTML behind each problem, unused code, what’s inside Tag Manager, and ready-made critical CSS.' },
    { view: 'overview', target: '.rcard:has(a[href$="summary.pdf"])', title: 'Share with a client', text: 'A one-page, plain-English PDF: pass or fail, key numbers, top fixes and the trend.' },
    { view: null, target: '#simple-toggle', title: 'Simple or detailed', text: 'Switch between the plain-English essentials and every technical detail at any time. The ? button on the left brings back the glossary and this tour.' },
  ];

  function onboarded() {
    try { return window.localStorage.getItem('pmw-onboarded') === '1'; } catch { return true; }
  }
  function markOnboarded() {
    try { window.localStorage.setItem('pmw-onboarded', '1'); } catch { /* shown again next time — harmless */ }
  }
  function tourLayer() {
    let el = document.getElementById('tour');
    if (!el) {
      el = document.createElement('div');
      el.id = 'tour';
      el.className = 'tour';
      el.setAttribute('role', 'dialog');
      el.setAttribute('aria-modal', 'true');
      document.body.append(el);
    }
    return el;
  }
  function closeTour() {
    document.getElementById('tour')?.remove();
    markOnboarded();
  }
  function showWelcome() {
    const el = tourLayer();
    el.innerHTML = `<div class="tour-back"></div><div class="tour-card tour-center" aria-labelledby="tour-t">
      <div class="tour-kicker">Welcome to PMW Speed Engine</div>
      <h2 id="tour-t">Who’s using it?</h2>
      <p>This sets how much detail you see. You can switch any time with the button at the top right.</p>
      <div class="tour-roles">
        <button class="tour-role" data-tour-role="simple"><b>I’m not technical</b><span>Plain English: what’s wrong, who fixes it, and how much it helps.</span></button>
        <button class="tour-role" data-tour-role="detailed"><b>I’m a developer</b><span>Everything: timelines, code lines, coverage, scripts and raw evidence.</span></button>
      </div>
      <div class="tour-actions"><button class="btn btn-ghost btn-sm" data-tour-skip>Skip for now</button></div></div>`;
    el.querySelector('.tour-role')?.focus();
  }
  async function showTourStep(i) {
    const steps = TOUR;
    if (i >= steps.length) return closeTour();
    const st = steps[i];
    if (st.view && st.view !== state.view && (isWorkspace() || state.summary || WORKSPACE.has(st.view))) {
      if (!WORKSPACE.has(st.view) && !state.summary) return showTourStep(i + 1); // needs an audit
      state.view = st.view;
      render();
      await new Promise((r) => setTimeout(r, 500));
    }
    const target = document.querySelector(st.target);
    if (!target || !target.getBoundingClientRect().width) return showTourStep(i + 1);
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = target.getBoundingClientRect();
    const el = tourLayer();
    const below = r.bottom + 220 < window.innerHeight;
    const cardTop = below ? r.bottom + 14 : Math.max(14, r.top - 14 - 200);
    const cardLeft = Math.min(Math.max(14, r.left), window.innerWidth - 380);
    const shown = steps.filter((s, n) => n <= i).length;
    el.innerHTML = `<div class="tour-hole" style="left:${r.left - 6}px;top:${r.top - 6}px;width:${r.width + 12}px;height:${r.height + 12}px"></div>
      <div class="tour-card" style="left:${cardLeft}px;top:${cardTop}px" aria-labelledby="tour-t">
        <div class="tour-kicker">${shown} of ${steps.length}</div><h3 id="tour-t">${esc(st.title)}</h3><p>${esc(st.text)}</p>
        <div class="tour-actions"><button class="btn btn-ghost btn-sm" data-tour-skip>Close</button>${i > 0 ? `<button class="btn btn-ghost btn-sm" data-tour-step="${i - 1}">Back</button>` : ''}<button class="btn btn-primary btn-sm" data-tour-step="${i + 1}">${i === steps.length - 1 ? 'Done' : 'Next'}</button></div></div>`;
    el.querySelector('[data-tour-step]:last-child')?.focus();
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-tour-role],[data-tour-skip],[data-tour-step],[data-tour-start]');
    if (!t) return;
    if (t.dataset.tourRole) {
      const simple = t.dataset.tourRole === 'simple';
      if (state.simple !== simple) $('#simple-toggle')?.click();
      markOnboarded();
      return showTourStep(0);
    }
    if ('tourSkip' in t.dataset) return closeTour();
    if (t.dataset.tourStep != null) return showTourStep(Number(t.dataset.tourStep));
    if ('tourStart' in t.dataset) { window.PSI.drawer.close?.(); return showWelcome(); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('tour')) closeTour();
  });

  Object.assign(window.PSI, {
    state, esc, num, api, fmtDate, ago, fmtMs, fmtBytes, host, pagePath, toast, setLive,
    scoreRating, ICON, gaugeSvg, render, navigate, loadAudit,
    /** Re-reads the audit being viewed (e.g. after a new run of the same site finishes). */
    refresh: () => loadAudit(state.auditId),
    refreshAuditList,
  });

  // A workspace page doesn't need audit data, so it's drawn straight away.
  if (isWorkspace()) render();
  loadAudit(state.auditId);
  if (!onboarded()) setTimeout(showWelcome, 600);
})();
