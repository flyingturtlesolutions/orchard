// ContentScripts/harvestTee.js — §17 (DESIGN_connectors.md): the body-blind network harvest TEE, injected into the PAGE
// (MAIN world) — either one-shot post-load by ARM_HARVEST_TEE (executeScript {files}) or at document_start for a whole
// HARVEST SESSION by START_HARVEST_SESSION (registerContentScripts). A CLASSIC self-installing IIFE — NO import/export
// (it is injected as a page script, not an ES module) and NO closure over the extension (only page globals).
//
// BODY-BLIND (DESIGN_llm_privacy.md): it wraps fetch + XHR to record ONLY {method, url, status} for SAME-SITE calls — it
// NEVER reads, clones, or parses a response body. Idempotent (a window flag guards re-injection) and FAIL-SAFE: every
// hook calls the original inside a try/catch and returns the page's own promise untouched, so it can never break or even
// observe the body of the page's requests. Two sinks, written together on each call:
//   • window.__ahub_harvest_buf        — THIS document's captures (pulled by DRAIN_HARVEST_TEE, the single-page path).
//   • sessionStorage['__ahub_harvest'] — captures ACCUMULATED across same-origin navigations (the SESSION path); read +
//     cleared by STOP_HARVEST_SESSION. Per-ORIGIN (a cross-subdomain hop starts a fresh accumulator) — acceptable, a
//     crawl stays on one origin; the document_start registration re-installs the tee on every navigation automatically.
(function () {
  if (window.__ahub_harvest_tee === true) return;
  window.__ahub_harvest_tee = true;
  var MAX = 500, SKEY = '__ahub_harvest';
  if (!Array.isArray(window.__ahub_harvest_buf)) window.__ahub_harvest_buf = [];
  // §19 (v2.74.1284) — capture the app's OWN API, even CROSS-ORIGIN. A Static SPA (e.g. an S3-hosted CS tool) serves static
  // files from one host but fetches its data from a SEPARATE API host (api.example.com / *.execute-api.*) — so a same-site
  // filter dropped exactly the reads worth banking. We only ever see fetch/XHR (never <script>/<img>/<link> asset loads),
  // so a cross-origin call here is almost always either the app's API (KEEP → bank PENDING for HITL review) or an analytics
  // beacon (DROP). NOISE = unambiguous telemetry/analytics hosts only (never an app's data API). Body-blind unchanged.
  var NOISE = /(?:^|\.)(?:google-analytics\.com|googletagmanager\.com|analytics\.google\.com|doubleclick\.net|segment\.(?:io|com)|sentry\.io|sentry-cdn\.com|datadoghq\.com|nr-data\.net|newrelic\.com|fullstory\.com|hotjar\.com|mixpanel\.com|amplitude\.com|heapanalytics\.com|clarity\.ms|bugsnag\.com|logrocket\.(?:io|com)|pendo\.io|cloudflareinsights\.com|intercom\.io|intercomcdn\.com|facebook\.(?:com|net))$/i;
  var keep = function (u) {
    try { return !NOISE.test(new URL(u, location.href).host); }   // app same-site OR its first-party API — drop only known beacons
    catch (e) { return false; }
  };
  var push = function (method, url, status) {
    try {
      if (!url || !keep(url)) return;   // capture the app's reads (same-site + cross-origin API); drop analytics/telemetry only
      var abs = ''; try { abs = new URL(url, location.href).href; } catch (e) { abs = String(url); }
      var rec = { method: String(method || 'GET').toUpperCase(), url: abs, status: Number(status) || 0, at: (window.performance && performance.now) ? performance.now() : 0 };
      var buf = window.__ahub_harvest_buf; buf.push(rec); if (buf.length > MAX) buf.splice(0, buf.length - MAX);
      try {   // SESSION accumulator (survives same-origin navigations); superset of buf for this origin
        var acc = []; var s = sessionStorage.getItem(SKEY); if (s) acc = JSON.parse(s) || [];
        acc.push(rec); if (acc.length > MAX) acc = acc.slice(acc.length - MAX);
        sessionStorage.setItem(SKEY, JSON.stringify(acc));
      } catch (e) { /* sessionStorage unavailable (sandboxed frame) — the window buffer still works */ }
    } catch (e) { /* never throw into the page */ }
  };
  try {
    var of = window.fetch;
    if (typeof of === 'function') {
      window.fetch = function (input, init) {
        var url = '', method = 'GET';
        try {
          if (input && typeof input === 'object' && 'url' in input) { url = input.url; method = input.method || 'GET'; }
          else { url = String(input); }
          if (init && init.method) method = init.method;
        } catch (e) { /* */ }
        var p = of.apply(this, arguments);
        // PASSIVE observer: a separate .then that reads only res.status/res.url — the page still gets `p` untouched and is
        // the one that consumes the body. We never read it.
        try { p.then(function (res) { try { push(method, (res && res.url) || url, res && res.status); } catch (e) {} }, function () {}); } catch (e) {}
        return p;
      };
    }
  } catch (e) { /* */ }
  try {
    var oo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { try { this.__ahub_m = m; this.__ahub_u = u; } catch (e) {} return oo.apply(this, arguments); };
    var os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try { var self = this; this.addEventListener('loadend', function () { try { push(self.__ahub_m, self.__ahub_u, self.status); } catch (e) {} }); } catch (e) {}
      return os.apply(this, arguments);
    };
  } catch (e) { /* */ }
})();
