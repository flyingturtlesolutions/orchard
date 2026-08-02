// ContentScripts/shopifyCsrfSniffer.js — CX-7d (v2.74.1391). The PROACTIVE CSRF/op tee: runs at document_start in
// the MAIN world on admin.shopify.com, BEFORE the admin SPA bootstraps, so it catches the very first x-csrf-token
// the SPA sends on its own page-load requests. The token is then already cached before Orchard's first ask — the
// user never has to "click around the admin once" to prime it (that hint only fired because the on-demand tee
// installed too late, after the SPA's load traffic had passed).
//
// Posts ONLY the token + any /api/operations/<sha>/<Op>/shopify/<handle> URL (same-origin postMessage); the
// isolated-world content script caches them (contentScript.js). Mirrors the on-demand tee in
// background/handlers/connector.js (_csrfSnifferFunc) and SHARES its guard flag (window.__ahubCsrfSniff) so the
// two never double-wrap. Pure passthrough — every wrapped call is forwarded unchanged.

(function () {
  try {
    if (window.__ahubCsrfSniff) return; window.__ahubCsrfSniff = true;
    // v2.74.1945 — THE TEE GETS A PULSE. Five mechanisms were proposed and eliminated for "www.ups.com never banks"
    // (worker context · cookie mirror · orphaned relay · reload race · un-generalized header names) because the ONLY
    // observable was the SW-side bank, where "dry" is the same string for: tee never ran · page made no requests ·
    // requests carried no matching header · the postMessage relay dropped it. These counters split those apart and
    // cost one integer per request. NEVER record header VALUES — names and counts only (a value here would put a
    // live credential in a log). `names` is a set of header names actually seen, so a site spelling its token
    // something new (the v1936 class) is self-reporting instead of structurally invisible.
    var stats = { req: 0, hdr: 0, matched: 0, names: {}, at: 0 };
    window.__ahubCsrfStats = stats;
    var note = function (n) { try { var k = String(n || '').toLowerCase(); if (!k) return; stats.hdr++; if (/csrf|xsrf|token|verif/.test(k)) stats.names[k] = (stats.names[k] || 0) + 1; } catch (e) { /* */ } };
    var post = function (tok) { try { stats.matched++; stats.at = Date.now(); window.postMessage({ __ahub_sniffed_csrf: { token: String(tok).slice(0, 400), host: location.host } }, location.origin); } catch (e) { /* */ } };
    var OP_RE = /\/api\/operations\/([a-f0-9]{16,64})\/(\w+)\/shopify\/([^/?#]+)/i;
    var postOp = function (u) { try { var m = String(u || '').match(OP_RE); if (m) window.postMessage({ __ahub_sniffed_op: { sha: m[1], name: m[2], handle: m[3], host: location.host } }, location.origin); } catch (e) { /* */ } };
    var scan = function (h) {
      try {
        if (!h) return null;
        var NAMES = ['x-csrf-token', 'x-xsrf-token', 'x-xsrf-header'];   // v1936 — every known spelling
        if (typeof Headers !== 'undefined' && h instanceof Headers) { for (var n0 = 0; n0 < NAMES.length; n0++) { var hv = h.get(NAMES[n0]); if (hv) return hv; } return null; }
        if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) if (NAMES.indexOf(String(h[i][0]).toLowerCase()) >= 0) return h[i][1]; return null; }
        for (var k in h) if (NAMES.indexOf(String(k).toLowerCase()) >= 0) return h[k];
      } catch (e) { /* */ }
      return null;
    };
    var noteAll = function (h) {
      try {
        if (!h) return;
        if (typeof Headers !== 'undefined' && h instanceof Headers) { h.forEach(function (v, k) { note(k); }); return; }
        if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) note(h[i][0]); return; }
        for (var k in h) note(k);
      } catch (e) { /* */ }
    };
    var of = window.fetch;
    window.fetch = function (input, init) {
      try { stats.req++; noteAll(init && init.headers); if (input && typeof input === 'object' && input.headers) noteAll(input.headers); var tok = scan(init && init.headers) || (input && typeof input === 'object' && input.headers ? scan(input.headers) : null); if (tok) post(tok); postOp(typeof input === 'string' ? input : (input && input.url)); } catch (e) { /* */ }
      return of.apply(this, arguments);
    };
    var osrh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { note(name); if (['x-csrf-token', 'x-xsrf-token', 'x-xsrf-header'].indexOf(String(name).toLowerCase()) >= 0 && value) post(value); } catch (e) { /* */ }   // v1936 — UPS spells it x-xsrf-token; one hardcoded name made the mechanism blind to a whole site
      return osrh.apply(this, arguments);
    };
    var oopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { stats.req++; postOp(url); } catch (e) { /* */ }
      return oopen.apply(this, arguments);
    };
  } catch (e) { /* */ }
})();
