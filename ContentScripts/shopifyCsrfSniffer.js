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
    var post = function (tok) { try { window.postMessage({ __ahub_sniffed_csrf: { token: String(tok).slice(0, 400), host: location.host } }, location.origin); } catch (e) { /* */ } };
    var OP_RE = /\/api\/operations\/([a-f0-9]{16,64})\/(\w+)\/shopify\/([^/?#]+)/i;
    var postOp = function (u) { try { var m = String(u || '').match(OP_RE); if (m) window.postMessage({ __ahub_sniffed_op: { sha: m[1], name: m[2], handle: m[3], host: location.host } }, location.origin); } catch (e) { /* */ } };
    var scan = function (h) {
      try {
        if (!h) return null;
        if (typeof Headers !== 'undefined' && h instanceof Headers) return h.get('x-csrf-token');
        if (Array.isArray(h)) { for (var i = 0; i < h.length; i++) if (String(h[i][0]).toLowerCase() === 'x-csrf-token') return h[i][1]; return null; }
        for (var k in h) if (String(k).toLowerCase() === 'x-csrf-token') return h[k];
      } catch (e) { /* */ }
      return null;
    };
    var of = window.fetch;
    window.fetch = function (input, init) {
      try { var tok = scan(init && init.headers) || (input && typeof input === 'object' && input.headers ? scan(input.headers) : null); if (tok) post(tok); postOp(typeof input === 'string' ? input : (input && input.url)); } catch (e) { /* */ }
      return of.apply(this, arguments);
    };
    var osrh = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      try { if (String(name).toLowerCase() === 'x-csrf-token' && value) post(value); } catch (e) { /* */ }
      return osrh.apply(this, arguments);
    };
    var oopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { postOp(url); } catch (e) { /* */ }
      return oopen.apply(this, arguments);
    };
  } catch (e) { /* */ }
})();
