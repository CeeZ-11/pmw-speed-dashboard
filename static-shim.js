// View-only, password-protected dashboard for static hosting (GitHub Pages).
//
// `psi-audit export-site` writes every API response the dashboard needs as
// an AES-GCM encrypted file under d/ (file names are salted hashes, so they
// reveal nothing). This script asks for the team password, checks it against
// manifest.json, then answers the dashboard's fetch('/api/...') calls from
// those files before loading the normal dashboard scripts unchanged.
// Anything that would change data (POST/DELETE) is refused: running audits,
// Try a fix, re-tests and settings stay in the desktop app.
(function () {
  'use strict';
  var KEY_STORE = 'pmw-web-key';
  var manifest = null;
  var cryptoKey = null;
  var saltBytes = null;
  var enc = new TextEncoder();
  var dec = new TextDecoder();

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function hex(buf) {
    return Array.prototype.map.call(new Uint8Array(buf), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }

  async function decrypt(bytes) {
    var iv = bytes.slice(0, 12);
    var body = bytes.slice(12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, cryptoKey, body));
  }
  async function gunzip(bytes) {
    var stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function deriveKey(password) {
    var base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    var bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: manifest.iterations }, base, 256);
    return new Uint8Array(bits);
  }
  async function useRawKey(raw) {
    cryptoKey = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
    var check = dec.decode(await decrypt(b64ToBytes(manifest.check)));
    if (check !== 'pmw-speed-engine') throw new Error('bad key');
  }

  // Same normalisation as requestKey() in src/cli/commands/export-site.ts.
  function requestKey(url) {
    var u = new URL(url, 'http://x');
    u.searchParams.sort();
    var q = u.searchParams.toString();
    return u.pathname + (q ? '?' + q : '');
  }
  async function fileFor(key) {
    var data = new Uint8Array(saltBytes.length + enc.encode(key).length);
    data.set(saltBytes, 0);
    data.set(enc.encode(key), saltBytes.length);
    return 'd/' + hex(await crypto.subtle.digest('SHA-256', data)).slice(0, 40) + '.bin';
  }

  var TYPES = { j: 'application/json; charset=utf-8', h: 'text/html; charset=utf-8', p: 'application/pdf', c: 'text/csv; charset=utf-8' };
  function jsonResponse(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { 'Content-Type': 'application/json' } });
  }
  async function answer(pathAndQuery) {
    var res = await realFetch(await fileFor(requestKey(pathAndQuery)));
    if (!res.ok) return jsonResponse(404, { error: 'This isn’t included in the web dashboard. Open it in the PMW Speed Engine app.' });
    var plain = await decrypt(new Uint8Array(await res.arrayBuffer()));
    if (manifest.compressed === 'gzip') plain = await gunzip(plain);
    var type = TYPES[String.fromCharCode(plain[0])] || TYPES.j;
    return new Response(plain.slice(1), { status: 200, headers: { 'Content-Type': type } });
  }

  var realFetch = window.fetch.bind(window);
  function installFetch() {
    window.fetch = async function (input, init) {
      var url = typeof input === 'string' ? input : input.url;
      var parsed = new URL(url, location.href);
      if (parsed.origin === location.origin && parsed.pathname.indexOf('/api/') === 0) {
        var method = ((init && init.method) || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
        if (method !== 'GET') return jsonResponse(403, { error: 'The web dashboard is view-only. Use the PMW Speed Engine app for this.' });
        return answer(parsed.pathname + parsed.search);
      }
      return realFetch(input, init);
    };
    // Links to PDFs, CSVs and HTML views (client summary, findings) open from the encrypted files too.
    document.addEventListener('click', async function (e) {
      var a = e.target.closest && e.target.closest('a[href^="/api/"]');
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      var href = a.getAttribute('href');
      var res = await answer(href);
      if (!res.ok) { alertBox((await res.json()).error); return; }
      var blob = await res.blob();
      var objectUrl = URL.createObjectURL(blob);
      if (/\.(pdf|csv)$/.test(new URL(href, 'http://x').pathname)) {
        var dl = document.createElement('a');
        dl.href = objectUrl;
        dl.download = href.split('/').slice(-2).join('-');
        document.body.append(dl);
        dl.click();
        dl.remove();
      } else {
        window.open(objectUrl, '_blank', 'noopener');
      }
      setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
    }, true);
  }

  function alertBox(text) {
    var t = document.getElementById('toast');
    if (t) { t.textContent = text; t.hidden = false; setTimeout(function () { t.hidden = true; }, 4000); }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = reject;
      document.body.append(s);
    });
  }

  async function startDashboard() {
    installFetch();
    try { localStorage.setItem('pmw-onboarded', '1'); } catch (e) { /* tour may show; harmless */ }
    document.body.classList.add('static-mode');
    // Open on the newest audit's overview (or the page asked for) — never on New audit / Settings.
    var params = new URLSearchParams(location.search);
    var view = params.get('view');
    if (!params.get('audit') || ['new-audit', 'site-lists', 'settings'].indexOf(view) >= 0) {
      try {
        var audits = await (await window.fetch('/api/audits')).json();
        if (Array.isArray(audits) && audits.length) {
          params.set('audit', audits[0].id);
          if (!view || ['new-audit', 'site-lists', 'settings'].indexOf(view) >= 0) params.set('view', 'overview');
          history.replaceState(null, '', '?' + params.toString());
        }
      } catch (e) { /* the dashboard shows its own empty state */ }
    }
    var note = document.createElement('div');
    note.className = 'web-note';
    note.textContent = 'Web dashboard · view only · updated ' + new Date(manifest.generatedAt).toLocaleString();
    document.body.append(note);
    await loadScript('dashboard-pages.js');
    await loadScript('dashboard.js');
  }

  var STYLE = [
    '.static-mode #rerun-form,.static-mode #rerun-btn,.static-mode .rail [data-nav="new-audit"],.static-mode .rail [data-nav="site-lists"],',
    '.static-mode .rail [data-nav="settings"],.static-mode [data-retest],.static-mode [data-exp-run],.static-mode [data-fstate],',
    '.static-mode [data-note],.static-mode [data-delete-audit],.static-mode #hs-delete-all,.static-mode [data-run-again],',
    '.static-mode [data-list-run],.static-mode [data-list-delete]{display:none!important}',
    '.static-mode [data-key-page]{pointer-events:none;opacity:.6}',
    '.web-note{position:fixed;right:12px;bottom:10px;z-index:40;font:12px/1.3 system-ui,sans-serif;color:#9aa8b8;background:rgba(15,22,32,.92);',
    'border:1px solid #273442;border-radius:999px;padding:5px 11px;pointer-events:none}',
    '.gate{position:fixed;inset:0;display:grid;place-items:center;background:#0b1118;z-index:100;padding:20px;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.gate form{width:min(380px,100%);background:#121a24;border:1px solid #233142;border-radius:16px;padding:28px;display:grid;gap:14px;color:#e8edf3}',
    '.gate h1{margin:0;font-size:1.35rem}.gate p{margin:0;color:#95a3b3;font-size:.92rem;line-height:1.5}',
    '.gate .badge{display:inline-block;background:#f2b632;color:#1b1300;font-weight:800;font-size:.72rem;letter-spacing:.06em;padding:4px 7px;border-radius:5px;margin-right:8px}',
    '.gate input{font:inherit;padding:11px 12px;border-radius:10px;border:1px solid #2c3b4d;background:#0b1118;color:#e8edf3}',
    '.gate button{font:inherit;font-weight:700;padding:11px;border-radius:10px;border:0;background:#2f6bff;color:#fff;cursor:pointer}',
    '.gate .err{color:#ff8a7d;min-height:1.2em}',
  ].join('');

  function showGate() {
    return new Promise(function (resolve) {
      var gate = document.createElement('div');
      gate.className = 'gate';
      gate.innerHTML =
        '<form autocomplete="on"><h1><span class="badge">PMW</span>Speed Engine</h1>' +
        '<p>Team dashboard. Enter the team password to view the audits.</p>' +
        '<input id="pmw-pass" type="password" autocomplete="current-password" placeholder="Team password" aria-label="Team password" required>' +
        '<label style="display:flex;gap:8px;align-items:center;color:#95a3b3;font-size:.88rem"><input id="pmw-remember" type="checkbox" style="padding:0" checked> Keep me signed in on this browser</label>' +
        '<button type="submit">Unlock</button><p class="err" role="alert"></p></form>';
      document.body.append(gate);
      var form = gate.querySelector('form');
      var input = gate.querySelector('#pmw-pass');
      input.focus();
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = form.querySelector('button');
        btn.disabled = true;
        btn.textContent = 'Unlocking…';
        try {
          var raw = await deriveKey(input.value);
          await useRawKey(raw);
          var store = gate.querySelector('#pmw-remember').checked ? localStorage : sessionStorage;
          try { store.setItem(KEY_STORE, manifest.salt + ':' + bytesToB64(raw)); } catch (err) { /* asks again next time */ }
          gate.remove();
          resolve();
        } catch (err) {
          gate.querySelector('.err').textContent = 'That password didn’t work. Check it and try again.';
          btn.disabled = false;
          btn.textContent = 'Unlock';
        }
      });
    });
  }

  async function savedKey() {
    var stored = null;
    try { stored = sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE); } catch (e) { return false; }
    if (!stored) return false;
    var parts = stored.split(':');
    // A new export uses a new salt, so an old saved key simply asks for the password again.
    if (parts[0] !== manifest.salt) return false;
    try { await useRawKey(b64ToBytes(parts[1])); return true; } catch (e) { return false; }
  }

  async function main() {
    var style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);
    manifest = await (await realFetch('manifest.json', { cache: 'no-store' })).json();
    saltBytes = b64ToBytes(manifest.salt);
    if (!(await savedKey())) await showGate();
    await startDashboard();
  }
  main().catch(function (err) {
    document.body.innerHTML = '<p style="font-family:system-ui;padding:24px;color:#e8edf3;background:#0b1118">The dashboard could not load: ' + String(err && err.message || err) + '</p>';
  });
})();
