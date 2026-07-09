// background/handlers/connector.js — the connector domain (DESIGN_connectors.md §7, §13–14, §16). CX-3/CX-4a/CX-7.
//
// INVOKE_SESSION (session-ride): the user's existing browser login IS the credential. A login cookie only rides a
// SAME-ORIGIN request from the app's own page, so we never fetch here — we resolve a live, logged-in tab on the
// recipe's origin (or derive it from the open *.appHost tab), ensure its content script is live, and have it do the
// fetch (SESSION_FETCH). Full CRUD — a write (non-GET) is fail-closed behind explicit `confirmed:true` (Belt #1, §9).
//
// CX-7 cold start (§16): when no logged-in tab is open, fall back to an EPHEMERAL MANAGED TAB — open the origin in a
// BACKGROUND tab (it inherits the cookie jar), ride it, close it on idle; a burst reuses one tab per origin. If the
// tab turns out unauthenticated (anon probe, or the wrong principal) we FOCUS it for the human to sign in / switch —
// opening a tab inherits auth, it can't create it — and never act (the §16 re-auth rule).
//
// Identity (CS Tools §14): verify the RETURNED identity, never `res.ok`. The verdict + the open-tab-vs-ephemeral
// decision live in the pure `Core/connection.js` core; this handler is the live tab glue.

import { fillEndpoint, fillBody, recipeForOrigin, isReadOnlyGql } from '../../Core/connectorRecipes.js';
import { pickRideTab, assessProbe, rideAction, STATUS, classifyReachProbe } from '../../Core/connection.js';
import { armable } from '../../Core/rideRecipe.js';   // §18 — the arm guard: a non-armable (disabled / pending / rejected) per-Ground recipe must not run
import { brokerInvokeGate, brokerReplyFromCloud } from '../../Core/brokerInvoke.js';   // CX-5b — the broker (OAuth/MCP) fail-closed gate + cloud-reply normalizer (pure)
import { BROKER_CATALOG } from '../../Core/brokerCatalog.js';   // v1342 — UNLINK clears this provider's liveTools cache entries
import { pkcePair, authorizeUrl, parseAuthRedirect } from '../../Core/oauthLink.js';   // MP-3 — the pure client half of the link dance (§5.2 pinned contract)
import { providerScopes } from '../../Core/mcpServers.js';                             // MP-3 — one dance grants every server the provider fronts
import { Logger } from '../../Core/Logger.js';   // §20 — SESSION_REPLAY outcome observability (Invariant #1)
import { armRideAuthCapture, markEngineBusy } from './sg.js';   // §20 — keep the page-local token fresh on the app tab (no import cycle: sg.js doesn't import connector.js); FL-1c — SHOW_SOURCES busy-marks its driven navigation (Invariant #2)

// ── Ephemeral managed-tab registry (§16) — module singleton, lives within a SW lifetime ─────────────────────────────
const IDLE_CLOSE_MS = 8000;                 // close an Orchard-opened tab this long after its last ride (burst-reuse window)
const _managed = new Map();                 // origin → { tabId, timer }
const _lastOriginByAppHost = new Map();     // appHost → last concrete origin seen (lets a cold start open the right host)

const _clearTimer = (rec) => { if (rec && rec.timer) { clearTimeout(rec.timer); rec.timer = null; } };
async function _tabAlive(tabId) { try { const t = await chrome.tabs.get(tabId); return !!(t && t.id != null); } catch { return false; } }

// Reuse a still-open managed tab for the origin, else open a fresh BACKGROUND one. → { tabId, opened }.
async function _acquireEphemeralTab(origin) {
  const rec = _managed.get(origin);
  if (rec && await _tabAlive(rec.tabId)) { _clearTimer(rec); return { tabId: rec.tabId, opened: false }; }
  if (rec) _managed.delete(origin);
  const created = await chrome.tabs.create({ url: `https://${origin}/`, active: false });
  const tabId = created && created.id;
  if (tabId == null) throw new Error('ephemeral-tab-open-failed');
  _managed.set(origin, { tabId, timer: null });
  return { tabId, opened: true };
}

// Schedule the managed tab to close after the idle window; a later ride to the same origin cancels it (reuse).
function _releaseEphemeralTab(origin) {
  const rec = _managed.get(origin);
  if (!rec) return;
  _clearTimer(rec);
  const { tabId } = rec;
  rec.timer = setTimeout(() => { _managed.delete(origin); chrome.tabs.remove(tabId).catch(() => {}); }, IDLE_CLOSE_MS);
}

// Best-effort: wait for a freshly opened tab to finish loading, so the origin context (and a write's CSRF meta) exists.
async function _waitTabComplete(tabId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let status = '';
    try { const t = await chrome.tabs.get(tabId); status = (t && t.status) || ''; } catch { return false; }
    if (status === 'complete') return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return true;   // proceed anyway — the probe/verdict will catch a not-ready page
}

// Focus a tab to the foreground (re-auth, §16): bring the tab + its window forward so the user lands on the login page.
async function _focusTab(tabId) {
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (t && t.windowId != null) { try { await chrome.windows.update(t.windowId, { focused: true }); } catch { /* */ } }
  } catch { /* */ }
}

// §16 re-auth RESUME — after focusing the tab, wait for the user to sign in, then return the authenticated verdict
// (or null on timeout / the user closing the tab). webNavigation-driven: re-probe on each settled TOP-FRAME nav (an
// IdP-hop probe reads anon cross-origin; the return-to-origin nav reads the real identity), so it's event-woken, not
// a busy poll. LIVE-EDGE caveat: a long idle wait can outlive the MV3 service worker (nav events wake it, but the
// robust form — chrome.alarms + a persisted continuation + out-of-band delivery — is the §16 build-3 hardening).
function _waitForReauth({ tabId, probe, expectedAccount, timeoutMs = 90000 }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; cleanup(); resolve(v); };
    const reprobe = async () => {
      await new Promise((r) => setTimeout(r, 400));                 // let the post-login redirect settle
      if (done) return;
      try { const verdict = assessProbe(await probe(), expectedAccount); if (verdict.status === STATUS.FRESH) finish(verdict); }
      catch { /* still signing in — keep waiting */ }
    };
    const onNav = (d) => { if (d && d.tabId === tabId && d.frameId === 0) reprobe(); };
    const onRemoved = (id) => { if (id === tabId) finish(null); };  // user closed the tab → give up
    const timer = setTimeout(() => finish(null), timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      try { chrome.webNavigation.onCompleted.removeListener(onNav); } catch { /* */ }
      try { chrome.webNavigation.onHistoryStateUpdated.removeListener(onNav); } catch { /* */ }
      try { chrome.tabs.onRemoved.removeListener(onRemoved); } catch { /* */ }
    }
    try { chrome.webNavigation.onCompleted.addListener(onNav); } catch { /* */ }
    try { chrome.webNavigation.onHistoryStateUpdated.addListener(onNav); } catch { /* */ }   // SPA logins
    try { chrome.tabs.onRemoved.addListener(onRemoved); } catch { /* */ }
  });
}

// A user-closed managed tab must leave the registry (never reuse a dead id).
try {
  chrome.tabs.onRemoved.addListener((tabId) => {
    for (const [origin, rec] of _managed) if (rec && rec.tabId === tabId) { _clearTimer(rec); _managed.delete(origin); }
  });
} catch { /* no chrome.tabs in this context */ }

// §20 (v2.74.1288) — the MAIN-world REPLAY fetch, injected into the app tab. Reads the page-captured auth headers
// (window.__ahub_ride_auth[apiHost], stashed by the §20 tee) and fetches the (cross-origin) endpoint WITH them. Runs from
// the app's own origin so the API's CORS is satisfied; the token never leaves the page. Self-contained (serialized). GET-
// shaped reads only. → { status, body } | { noAuth } | { error }.
function _replayFetchFunc(url, apiHost, method, reqBody, contentType) {
  return (async function () {
    try {
      var store = window.__ahub_ride_auth || {};
      var cap = store[apiHost] || null;
      if (!cap || !cap.headers || !cap.headers.authorization) return { noAuth: true, keys: Object.keys(store) };   // keys → diagnose a host-key mismatch vs an empty global
      var headers = { accept: 'application/json' };
      for (var k in cap.headers) { if (Object.prototype.hasOwnProperty.call(cap.headers, k)) headers[k] = cap.headers[k]; }
      var init = { method: method || 'GET', headers: headers, credentials: 'omit' };   // §20 — Bearer HEADER auth, not cookies; credentialed CORS ('include') is rejected by a header-auth API (Failed to fetch)
      if (reqBody != null && method && method !== 'GET' && method !== 'HEAD') { init.body = reqBody; if (contentType) headers['content-type'] = contentType; }   // CX-6 — a confirmed WRITE: attach the filled body + its content type
      var res = await fetch(url, init);
      var status = res.status, body = null;
      try { body = await res.json(); } catch (e) { try { body = await res.text(); } catch (e2) { body = null; } }
      return { status: status, body: body };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  })();
}

// CX-5c — the LINKED-PROVIDER cache: which providers this install has OAuth-granted. Written by LINK/UNLINK (and
// refreshed from the backend by GET_CONNECTOR_STATUS); read by the palette so broker legs only surface when runnable.
// Cache-stale is safe: a stale "linked" fails honestly at invoke (connector-not-linked); a stale "unlinked" merely
// hides legs until the next status refresh.
const LINKED_KEY = 'connector:linkedProviders';
async function _readLinkedProviders() {
  try { const o = await chrome.storage.local.get(LINKED_KEY); return Array.isArray(o[LINKED_KEY]) ? o[LINKED_KEY] : []; } catch { return []; }
}
async function _writeLinkedProviders(list) {
  try { await chrome.storage.local.set({ [LINKED_KEY]: [...new Set((list || []).filter(Boolean))] }); } catch { /* */ }
}
// MP-2c (v2.74.1319) — the LIVE-TOOLS cache: { server → raw MCP tool descriptors } from the backend's tools/list
// discovery. The palette prefers these over the hand-transcribed seed (brokerCatalog liveTools override) — schemas
// from the source can't drift. Empty/absent is always safe: the seed serves.
const LIVETOOLS_KEY = 'connector:liveTools';
async function _readLiveTools() {
  try { const o = await chrome.storage.local.get(LIVETOOLS_KEY); return (o[LIVETOOLS_KEY] && typeof o[LIVETOOLS_KEY] === 'object') ? o[LIVETOOLS_KEY] : {}; } catch { return {}; }
}
async function _writeLiveTools(map) {
  try { await chrome.storage.local.set({ [LIVETOOLS_KEY]: (map && typeof map === 'object') ? map : {} }); } catch { /* */ }
}

export function createConnectorHandlers({ ensureContentScript, readRideRecipes, cloudInvokeConnector, cloudLinkConnector, cloudUnlinkConnector, cloudListConnectorTools, cloudHasSession } = {}) {
  // v2.74.1340 (review A) — `confirmed` rides through to SESSION_FETCH so the CONTENT-SCRIPT boundary can hold its
  // own fail-closed write belt (second belt): only a caller that already passed the HITL gate hands it a write.
  const fetchVia = (tabId, url, method, body, confirmed = false, contentType = '', extra = null) =>
    chrome.tabs.sendMessage(tabId, { type: 'SESSION_FETCH', payload: { url, method, body, contentType: contentType || undefined, confirmed: confirmed === true,
      headers: (extra && extra.headers) || undefined, gqlRead: !!(extra && extra.gqlRead) } }, { frameId: 0 });   // CX-7 — sniffed-CSRF header + the gql-read carve-out flag (re-validated page-side)
  // The TOP-FRAME content script can be orphaned (an extension reload kills it; the all-frames PING can read a live
  // SUBframe as "live" while frame 0 is dead). On a frame-0 connection error, force-reinject + retry once.
  const fetchViaHealed = async (tabId, url, method, body, confirmed = false, contentType = '', extra = null) => {
    try { return await fetchVia(tabId, url, method, body, confirmed, contentType, extra); }
    catch (e) {
      if (!/Receiving end does not exist|Could not establish connection/i.test((e && e.message) || '')) throw e;
      try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
      await new Promise((r) => setTimeout(r, 300));
      return await fetchVia(tabId, url, method, body, confirmed, contentType, extra);
    }
  };

  // ── CX-7 (v2.74.1386) — SNIFFED CSRF (the Shopify class, ride-legs-spec §Shopify): the admin SPA's POSTs need an
  // `x-csrf-token` that lives in NO meta tag — the CS stack captures it off the SPA's own outbound requests. Same
  // trick, in-tab: a MAIN-world tee wraps fetch/XHR, posts the first token it sees to the content script (which
  // caches it); we cache per-origin here too. The SPA fires its own calls continuously while the admin is open, so
  // a token usually appears within seconds; an idle tab may need one interaction (the failure hint says so). ──
  const _sniffedCsrf = new Map();               // origin → { token, at }
  const CSRF_TTL_MS = 20 * 60e3;
  function _csrfSnifferFunc() {
    try {
      if (window.__ahubCsrfSniff) return; window.__ahubCsrfSniff = true;
      var post = function (tok) { try { window.postMessage({ __ahub_sniffed_csrf: { token: String(tok).slice(0, 400), host: location.host } }, location.origin); } catch (e) { /* */ } };
      // CX-7b — PERSISTED-OP capture: the admin's mutations POST /api/operations/<sha>/<OpName>/shopify/<handle>;
      // the sha is per-store + rotates on deploys. Capturing the URL off the SPA's own traffic (the user performing
      // the action once by hand) banks the op for replay — the CS stack's save-shopify-session step, done in-tab.
      var OP_RE = /\/api\/operations\/([a-f0-9]{16,64})\/(\w+)\/shopify\/([^/?#]+)/i;
      var postOp = function (u) {
        try {
          var m = String(u || '').match(OP_RE);
          if (m) window.postMessage({ __ahub_sniffed_op: { sha: m[1], name: m[2], handle: m[3], host: location.host } }, location.origin);
        } catch (e) { /* */ }
      };
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
        try {
          var tok = scan(init && init.headers) || (input && typeof input === 'object' && input.headers ? scan(input.headers) : null); if (tok) post(tok);
          postOp(typeof input === 'string' ? input : (input && input.url));
        } catch (e) { /* */ }
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
  }
  // CX-7b — the per-origin PERSISTED-OP BANK (chrome.storage: survives SW restarts, per store instance). Sniffed
  // ops flow CS → the acquire poll → here. TRUSTED data only — a model-supplied op_sha never reaches an endpoint.
  const _OPS_KEY = (origin) => `rideOps:${origin}`;
  async function _persistSniffedOps(origin, ops) {
    if (!ops || typeof ops !== 'object' || !Object.keys(ops).length) return;
    try {
      const got = await chrome.storage.local.get(_OPS_KEY(origin));
      const cur = got[_OPS_KEY(origin)] || {};
      let changed = false;
      for (const [name, o] of Object.entries(ops)) {
        if (o && o.sha && (!cur[name] || cur[name].sha !== o.sha)) { cur[name] = { sha: o.sha, handle: o.handle || null, at: Date.now() }; changed = true; }
      }
      if (changed) { await chrome.storage.local.set({ [_OPS_KEY(origin)]: cur }); try { Logger.info('connector', `SESSION ▸ op bank ${origin} ← ${Object.keys(ops).join(', ')}`); } catch { /* */ } }
    } catch { /* */ }
  }
  async function _bankedOp(origin, name) {
    try { const got = await chrome.storage.local.get(_OPS_KEY(origin)); return (got[_OPS_KEY(origin)] || {})[name] || null; } catch { return null; }
  }
  async function _clearBankedOp(origin, name) {
    try { const got = await chrome.storage.local.get(_OPS_KEY(origin)); const cur = got[_OPS_KEY(origin)] || {}; if (cur[name]) { delete cur[name]; await chrome.storage.local.set({ [_OPS_KEY(origin)]: cur }); } } catch { /* */ }
  }
  // CX-7 (v2.74.1401) — the sniffed-CSRF PERSIST bank. The token was cached only in SW memory (_sniffedCsrf, dies on
  // MV3 SW restart) + the page-scoped window.__ahubSniffCsrfTok (dies on tab reload), so a write after a reload found
  // no token → the belt hard-rejected `no-csrf` and an idle tab fired no request to re-capture. Persisting per-origin
  // (like the op bank) makes a token captured from ANY admin request survive restarts/reloads — a write reuses it, a
  // stale one 40x's → the force-reacquire path re-mints. TTL-bounded; it's the user's own session anti-forgery token
  // (paired with the session cookie the browser holds — inert alone), extension-private, same class as the op bank.
  const _CSRF_KEY = (origin) => `rideCsrf:${origin}`;
  async function _persistCsrf(origin, token) {
    if (!origin || !token) return;
    try { await chrome.storage.local.set({ [_CSRF_KEY(origin)]: { token: String(token).slice(0, 400), at: Date.now() } }); } catch { /* */ }
  }
  async function _bankedCsrf(origin) {
    try { const got = await chrome.storage.local.get(_CSRF_KEY(origin)); const c = got[_CSRF_KEY(origin)]; return (c && c.token && (Date.now() - (c.at || 0)) < CSRF_TTL_MS) ? c.token : null; } catch { return null; }
  }

  // ── CX-7c (v2.74.1388) — the SHOPIFY LIVENESS PROBE (spec §2 probeShopify): a GraphQL `{ shop { name } }` before
  // the real call, so a signed-out session fails FAST + honest instead of mid-write. Cached 60s per origin (a burst
  // of reads probes once). Reuses the sniffed CSRF the main call needs anyway. A non-JSON body (the login/challenge
  // HTML masquerading as 200 — the spec's trap) or a missing `data.shop.name` = not logged in. Returns the shop
  // name on success (for a "signed into <shop>" confirmation). ──
  const _shopLive = new Map();                  // origin → { name, at }
  const SHOP_LIVE_TTL_MS = 60e3;
  async function _probeShopLiveness(tabId, origin, handle, csrfTok) {
    const c = _shopLive.get(origin);
    if (c && (Date.now() - c.at) < SHOP_LIVE_TTL_MS) return { live: true, name: c.name };
    const url = `https://${origin}/api/shopify/${encodeURIComponent(handle)}`;
    const body = { query: '{ shop { name } }' };
    const reply = await fetchViaHealed(tabId, url, 'POST', body, false, 'application/json',
      { gqlRead: true, headers: csrfTok ? { 'x-csrf-token': csrfTok } : undefined });
    if (!reply || reply.success === false) {
      // non-json (login/challenge page) or http-40x → signed out; anything else is transient (treat as live-unknown, let the real call speak)
      if (reply && (reply.error === 'non-json' || /^http-40[13]$/.test(String(reply.error || '')))) return { live: false };
      return { live: true, name: null, unknown: true };
    }
    const name = reply.value && reply.value.data && reply.value.data.shop && reply.value.data.shop.name;
    if (!name) return { live: false };
    _shopLive.set(origin, { name, at: Date.now() });
    return { live: true, name };
  }
  async function _acquireSniffedCsrf(tabId, origin, { force = false } = {}) {
    let c = _sniffedCsrf.get(origin);
    // v1401 — seed the in-memory cache from the PERSISTED bank when memory is cold/stale (SW restart cleared it): a
    // token captured during an earlier admin interaction is reused, so an idle tab needn't re-fire a request first.
    if (!force && !(c && (Date.now() - c.at) < CSRF_TTL_MS)) {
      const banked = await _bankedCsrf(origin);
      if (banked) { c = { token: banked, at: Date.now() }; _sniffedCsrf.set(origin, c); }
    }
    const ask = async () => {
      try {
        const r = await chrome.tabs.sendMessage(tabId, { type: 'GET_SNIFFED_CSRF', payload: {} }, { frameId: 0 });
        if (r && r.ops) await _persistSniffedOps(origin, r.ops);   // CX-7b — bank any ops the tee saw, whatever we came for
        if (r && r.token) { _sniffedCsrf.set(origin, { token: r.token, at: Date.now() }); await _persistCsrf(origin, r.token); }   // v1401 — persist any FRESH token so it survives a restart/reload
        return (r && r.token) || null;
      } catch { return null; }
    };
    if (!force && c && (Date.now() - c.at) < CSRF_TTL_MS) { await ask(); return (_sniffedCsrf.get(origin) || c).token; }   // still harvest ops + refresh on the warm path
    let tok = await ask();                       // ORDER MATTERS: the first ask wires the page's message listener…
    if (!tok || force) {
      try { await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: _csrfSnifferFunc }); } catch { /* CSP-proof: MAIN-world exec needs no page <script> */ }
      const deadline = Date.now() + 8000;        // …so the tee (injected after) can never post into the void
      while (!tok && Date.now() < deadline) { await new Promise((r) => setTimeout(r, 500)); tok = await ask(); }
    }
    if (tok) { _sniffedCsrf.set(origin, { token: tok, at: Date.now() }); await _persistCsrf(origin, tok); }
    return tok || null;
  }

  // MP-2c — refresh linked-state + LIVE TOOLS from the backend (fires at link time + on GET_CONNECTOR_STATUS).
  // Logs `CONNECTOR_TOOLS ▸` (Invariant #1: in studio.js _DECISION_RE). Returns the summary or null (no cloud client).
  async function _refreshConnectorState() {
    if (typeof cloudListConnectorTools !== 'function') return null;
    const r = await cloudListConnectorTools({});
    const linked = (r && Array.isArray(r.linked)) ? r.linked : [];
    await _writeLinkedProviders(linked);
    const prev = await _readLiveTools();
    const map = { ...prev };   // v1342 — merge per-server: one transient tools/list failure must not wipe cached schemas
    let toolCount = 0, errCount = 0;
    for (const s of ((r && Array.isArray(r.servers)) ? r.servers : [])) {
      if (s && s.server && Array.isArray(s.tools) && s.tools.length) { map[s.server] = s.tools; toolCount += s.tools.length; }
      else if (s && s.error) errCount += 1;
    }
    await _writeLiveTools(map);
    try { Logger.info('connector', `CONNECTOR_TOOLS ▸ ${linked.length} linked · ${Object.keys(map).length} live server(s) · ${toolCount} tool(s)${errCount ? ` · ${errCount} error(s)` : ''}`); } catch { /* */ }
    return { linked, liveServers: Object.keys(map).length, liveToolCount: toolCount };
  }

  return {
    // FL-1c (v2.74.1347, DESIGN_app_fleet.md) — SHOW_SOURCES: ground-truth viewing with REUSE-THEN-NAVIGATE. One
    // tab per origin, ever: reuse the origin's existing tab (the same one session-ride picks — the session tab IS
    // the evidence tab), focus it, navigate it to each target sequentially (Zendesk's agent workspace accumulates
    // them as internal workspace tabs); only with NO tab on the origin do we create ONE. URLs are validated to the
    // claimed https origin (the panel builds them from trusted templates — Core/proposals.targetUrls — but this end
    // re-checks; fail-closed). The driven navigation span is busy-marked (Invariant #2).
    'SHOW_SOURCES': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const host = String((payload && payload.origin) || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
          if (!host) { sendResponse({ success: false, error: 'no-origin' }); return; }
          const urls = (Array.isArray(payload && payload.urls) ? payload.urls : [])
            .map((u) => String(u || ''))
            .filter((u) => { try { const p = new URL(u); return p.protocol === 'https:' && p.host.toLowerCase() === host; } catch { return false; } })
            .slice(0, 6);
          if (!urls.length) { sendResponse({ success: false, error: 'no-valid-urls' }); return; }
          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: `*://${host}/*` }); } catch { tabs = []; }
          let tab = pickRideTab(tabs);
          let reused = true;
          if (!tab) { tab = await chrome.tabs.create({ url: urls[0], active: true }); reused = false; await _waitTabComplete(tab.id); }
          markEngineBusy(tab.id, true);   // engine-driven navigation — keep it out of the interaction monitor
          try {
            for (const u of (reused ? urls : urls.slice(1))) {
              await chrome.tabs.update(tab.id, { url: u, active: true });
              await _waitTabComplete(tab.id);
            }
          } finally { markEngineBusy(tab.id, false); }
          try { if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* */ }
          try { await chrome.tabs.update(tab.id, { active: true }); } catch { /* */ }
          try { Logger.info('connector', `SHOW ▸ ${host} ← ${urls.length} target(s) (${reused ? 'reused tab' : 'new tab'} ${tab.id})`); } catch { /* */ }
          sendResponse({ success: true, tabId: tab.id, shown: urls.length, reused });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'show-failed' }); }
      })();
      return true;
    },

    // CX-7d (v2.74.1396) — GET_RIDE_OPS: the op-bank VIEWER (makes T4 verifiable). Resolve the store's admin tab,
    // harvest any freshly-captured ops off it (the sniffer's window state → banked), then report what's banked for
    // the origin. Read-only introspection over the user's own captured operations; never drives a write.
    'GET_RIDE_OPS': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          let origin = String((payload && payload.origin) || '').replace(/^https?:\/\//, '').replace(/\/+$/, '').toLowerCase();
          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: origin ? `*://${origin}/*` : '*://admin.shopify.com/*' }); } catch { tabs = []; }
          const tab = pickRideTab(tabs);
          if (tab && !origin) { try { origin = new URL(tab.url).host; } catch { /* */ } }
          if (tab && origin) {   // harvest what the tee has seen since the last connector call, then it's banked
            try { if (typeof ensureContentScript === 'function') await ensureContentScript(tab.id); } catch { /* */ }
            try { await _acquireSniffedCsrf(tab.id, origin); } catch { /* */ }
          }
          let banked = {};
          if (origin) { try { const got = await chrome.storage.local.get(_OPS_KEY(origin)); banked = got[_OPS_KEY(origin)] || {}; } catch { /* */ } }
          const ops = Object.entries(banked).map(([name, o]) => ({ name, sha8: String((o && o.sha) || '').slice(0, 8), handle: (o && o.handle) || null, at: (o && o.at) || 0 }));
          sendResponse({ success: true, origin: origin || null, ops, tab: !!tab });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'ride-ops-failed' }); }
      })();
      return true;
    },

    'INVOKE_SESSION': (payload, _sender, sendResponse) => {
      (async () => {
        let ephemeralOrigin = null;          // set when this ride opened/reused a managed tab (→ idle-close on exit)
        try {
          // §18 arm guard (the observability layer's teeth) — a per-Ground recipe that's disabled / pending / rejected
          // must NOT run. If we know the Ground + recipe and a stored record exists, refuse unless armable. No record
          // (the curated catalog is trusted, or not yet seeded) → fall through to existing behavior. Best-effort.
          if (payload && payload.groundId && payload.recipeId && typeof readRideRecipes === 'function') {
            try {
              const _recs = await readRideRecipes(payload.groundId);
              const _rec = Array.isArray(_recs) ? _recs.find((r) => r && r.id === payload.recipeId) : null;
              if (_rec && !armable(_rec)) { sendResponse({ success: false, error: 'recipe-not-armable', hint: _rec.reviewState === 'pending' ? 'accept this recipe in Studio first' : 'this recipe is disabled in Studio' }); return; }
            } catch { /* never block on the guard's own failure */ }
          }
          const args = (payload && typeof payload.args === 'object' && payload.args) || {};
          const method = String((payload && payload.method) || 'GET').toUpperCase();
          // CX-6 — a non-GET is fail-closed behind explicit post-HITL `confirmed:true` (Belt #1). CSRF is page-side (Belt #2).
          // CX-7 — carve-out: a GraphQL READ is a POST whose document is provably read-only (the curated query text is
          // STATIC — params fill only `variables`). Validated here on the template AND re-validated on the final body
          // at the content-script boundary (belt #2) — a mutation document always needs the write gate.
          const isGqlRead = !!(payload && payload.gql === true && method === 'POST' && payload.body && typeof payload.body === 'object' && isReadOnlyGql(payload.body.query));
          const isWrite = (method !== 'GET' && method !== 'HEAD') && !isGqlRead;
          if (isWrite && !(payload && payload.confirmed === true)) { sendResponse({ success: false, error: 'write-needs-confirm' }); return; }

          let origin = fillEndpoint(String((payload && payload.origin) || ''), args).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const appHost = String((payload && payload.appHost) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const queryHost = origin || (appHost ? `*.${appHost}` : '');
          if (!queryHost) { sendResponse({ success: false, error: 'session-no-recipe' }); return; }
          const expectedAccount = (payload && payload.account) || null;

          // 1) Prefer an already-open, live, logged-in tab (the user's real context) — §16 default path.
          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: `*://${queryHost}/*` }); } catch { tabs = []; }
          let tab = pickRideTab(tabs);
          let ephemeral = false;

          // 2) Cold start (§16): no open tab → open an ephemeral managed tab — IF we know a concrete origin to open.
          //    appHost-only with no remembered instance can't guess the subdomain → the classic no-tab surface.
          if (!tab) {
            const coldOrigin = origin || _lastOriginByAppHost.get(appHost) || '';
            if (!coldOrigin) { sendResponse({ success: false, error: 'no-authenticated-tab', host: appHost || origin, hint: `open ${appHost || origin} and sign in` }); return; }
            origin = coldOrigin;
            const got = await _acquireEphemeralTab(origin);
            ephemeralOrigin = origin; ephemeral = true;
            tab = { id: got.tabId };
            if (got.opened) await _waitTabComplete(got.tabId);
          } else if (!origin) {
            try { origin = new URL(tab.url).host; } catch { origin = appHost; }
          }
          if (origin && appHost) _lastOriginByAppHost.set(appHost, origin);   // remember the instance for next cold start

          // v1380 (live: "sweep only runs if the zendesk tab is visible") — a BACKGROUND ride tab gets DISCARDED
          // (Memory Saver) or FROZEN by Chrome: its content script is gone/paused, so the page-side fetch hangs
          // or fails — which reads as "works only when the tab is focused". Revive WITHOUT focusing (a background
          // reload never touches the screen), wait for load, then ride as normal. `frozen` guards === true so
          // older Chrome (no field) skips.
          try {
            const t = await chrome.tabs.get(tab.id);
            if (t && (t.discarded === true || t.frozen === true)) {
              await chrome.tabs.reload(tab.id);
              await _waitTabComplete(tab.id);
            }
          } catch { /* revive is best-effort; ensureContentScript below still gates */ }

          if (typeof ensureContentScript === 'function') {
            const ok = await ensureContentScript(tab.id);
            if (!ok) { sendResponse({ success: false, error: 'no-content-script', origin }); return; }
          }

          // CX-7 — tab-URL params: fill e.g. {handle} from the RIDE TAB's own URL (admin.shopify.com/store/<handle>/…).
          // TRUSTED source (the user's real workspace tab), never the model — a model-supplied value is DELETED first.
          if (payload && payload.urlParam && payload.urlParam.name && payload.urlParam.pattern) {
            delete args[payload.urlParam.name];
            try {
              const t = await chrome.tabs.get(tab.id);
              const m = String((t && t.url) || '').match(new RegExp(payload.urlParam.pattern));
              if (m && m[1]) args[payload.urlParam.name] = m[1];
            } catch { /* */ }
            if (args[payload.urlParam.name] == null) {
              sendResponse({ success: false, error: 'no-url-param', origin, hint: `open your ${appHost || origin} workspace (a /store/… page) so the {${payload.urlParam.name}} can be read from the tab` });
              return;
            }
          }

          // CX-7 — acquire the sniffed CSRF ONCE here (the liveness probe + the main call both ride it), so we don't
          // double-sniff. Cached per-origin inside _acquireSniffedCsrf; null is fine (a gql read may go cookie-only).
          let csrfTok = null;
          if (payload && payload.csrf === 'sniff') { csrfTok = await _acquireSniffedCsrf(tab.id, origin); }

          // CX-7c (ADVISORY since v2.74.1389) — the liveness probe NEVER blocks the call. The first cut hard-gated
          // on it and BLOCKED a signed-in user: the probe needs the sniffed CSRF, and a cold/idle admin tab hasn't
          // fired an SPA request yet, so no token is captured → the probe 403s → misread as "signed out". A 403
          // without a token is a CSRF-not-ready problem, not a login one — and Shopify's REAL signed-out signal (an
          // HTML login page → SESSION_FETCH 'non-json' with an honest hint) is already caught by the main call.
          // So we probe only when a token exists, purely to warm the shop cache; the main call is the source of truth.
          if (payload && payload.shopProbe && csrfTok) {
            try { await _probeShopLiveness(tab.id, origin, args[(payload.urlParam && payload.urlParam.name) || 'handle'], csrfTok); } catch { /* advisory — never blocks */ }
          }

          // CX-7b — persisted-op hash: {op_sha} fills from the SNIFFED per-origin bank ONLY (model values deleted).
          // No banked op yet → inject the tee and ask the human to perform the action once by hand — that demo IS
          // the capture (their save-shopify-session step, in-tab); the next attempt replays it.
          if (payload && payload.persistedOp) {
            delete args.op_sha;
            const op = await _bankedOp(origin, String(payload.persistedOp));
            if (op && op.sha) args.op_sha = op.sha;
            else {
              try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: _csrfSnifferFunc }); } catch { /* */ }
              sendResponse({ success: false, error: 'op-not-captured', origin, hint: `do one ${String(payload.persistedOp)} by hand in the admin (e.g. create any customer) while this tab stays open — Orchard captures the operation and can replay it from then on` });
              return;
            }
          }

          // 3) Identity verdict (§14/§16) — verify the returned identity; guard the expected account.
          if (payload && payload.verifyIdentity) {
            const probePath = String(payload.identityProbe || '/api/v2/users/me.json');
            const probeUrl = `https://${origin}${probePath.startsWith('/') ? probePath : '/' + probePath}`;
            const verdict = assessProbe(await fetchViaHealed(tab.id, probeUrl, 'GET'), expectedAccount);
            if (rideAction(verdict, { ephemeral }).action === 'reauth-focus') {
              // H-1a (v2.74.1376) — a HEADLESS caller (the scheduled sweep) must NEVER steal the screen or hang
              // waiting for a human: no focus, no wait — fail fast as signed-out. The sweep's status note + `show
              // work` carry the honest reason; the ephemeral tab (if any) idle-closes via the managed registry.
              if (payload && payload.headless === true) {
                sendResponse({ success: false, error: 'not-logged-in', origin, hint: `sign in to ${origin} to continue` });
                return;
              }
              // Opening inherits auth, can't create it → focus the login/SSO page for the human (§16), then WAIT for
              // sign-in and RESUME — never make them re-ask. A focused tab is now the user's: drop it from the
              // disposable registry so it's never auto-closed.
              if (ephemeralOrigin) { const rec = _managed.get(ephemeralOrigin); _clearTimer(rec); _managed.delete(ephemeralOrigin); ephemeralOrigin = null; }
              await _focusTab(tab.id);
              const resumed = await _waitForReauth({ tabId: tab.id, origin, probe: () => fetchViaHealed(tab.id, probeUrl, 'GET'), expectedAccount });
              if (!resumed) {
                const isWrong = verdict.status === STATUS.WRONG_ACCOUNT;
                sendResponse({ success: false, reauth: true, error: isWrong ? 'wrong-account' : 'not-logged-in', origin,
                  hint: isWrong ? 'signed in as a different account — switch to continue' : `sign in to ${origin} to continue` });
                return;
              }
              if (resumed.user && resumed.user.id != null) args.me = resumed.user.id;   // signed in — bind {me}, fall through to the call
            } else if (verdict.user && verdict.user.id != null) {
              args.me = verdict.user.id;
            }
          }

          // 4) Build + run the call (write body filled from args incl. {me}; SESSION_FETCH JSON-encodes + adds CSRF).
          const path = fillEndpoint(String((payload && payload.endpoint) || ''), args);
          if (!path) { sendResponse({ success: false, error: 'session-no-recipe' }); return; }
          const url = `https://${origin}${path.startsWith('/') ? path : '/' + path}`;
          let body = undefined;
          const contentType = String((payload && payload.contentType) || '');
          if (isWrite || isGqlRead) {
            // v1342 — panel may pre-fill via fillWriteBody (string body + contentType); else template fillBody.
            // CX-7 — a gql READ builds its body too (the query document + filled variables).
            if (typeof payload.body === 'string') body = payload.body;
            else body = fillBody(payload && payload.body, args);
          }
          // CX-7 — sniffed-CSRF transport: ride the token acquired above (the liveness probe already sniffed it);
          // a 403 = stale/missing token → one forced re-mint + retry, then surface honestly with the interact-once hint.
          let extra = isGqlRead ? { gqlRead: true } : null;
          if ((isWrite || isGqlRead) && payload && payload.csrf === 'sniff') {
            extra = { ...(extra || {}), headers: csrfTok ? { 'x-csrf-token': csrfTok } : undefined };
          }
          let reply = await fetchViaHealed(tab.id, url, method, body, isWrite, contentType, extra);   // v1340 — the write already passed the confirmed:true gate above; carry it to the content-script belt
          // v1401 — a cold write hits the content-script belt's `no-csrf` HARD reject (not an http-40x), so include it
          // in the re-mint predicate: force-reacquire (inject the tee + poll) and retry once with a fresh token.
          if (reply && reply.success === false && (/^http-40[13]$/.test(String(reply.error || '')) || reply.error === 'no-csrf') && payload && payload.csrf === 'sniff') {
            const tok2 = await _acquireSniffedCsrf(tab.id, origin, { force: true });
            if (tok2) reply = await fetchViaHealed(tab.id, url, method, body, isWrite, contentType, { ...(extra || {}), headers: { 'x-csrf-token': tok2 } });
            if (reply && reply.success === false && (/^http-40[13]$/.test(String(reply.error || '')) || reply.error === 'no-csrf')) reply = { ...reply, hint: 'no CSRF token yet — click anywhere in the admin tab once (it fires a request Orchard reads), then retry' };
          }
          // CX-7b — HASH_STALE (the spec's deploy-rotation trap): a persisted-op 404/406 means the store's op hash
          // changed — clear the banked op so the next attempt re-captures, and say so honestly.
          if (reply && reply.success === false && payload && payload.persistedOp && /^http-40[46]$/.test(String(reply.error || ''))) {
            await _clearBankedOp(origin, String(payload.persistedOp));
            reply = { ...reply, error: 'op-hash-stale', hint: `the store's ${String(payload.persistedOp)} operation changed (admin deploy) — do one by hand with the tab open, then retry` };
          }
          // CX-7 — GraphQL's 200-is-not-ok trap (spec summarizeResult): top-level errors OR nested userErrors on a
          // 2xx is a FAILURE — surface it, never hand a poisoned success downstream.
          if (reply && reply.success && (payload && (payload.gql === true || payload.persistedOp)) && reply.value && typeof reply.value === 'object') {
            const v = reply.value;
            let msg = Array.isArray(v.errors) && v.errors.length ? String(v.errors[0].message || 'GraphQL error') : '';
            if (!msg && v.data && typeof v.data === 'object') {
              for (const node of Object.values(v.data)) {
                if (node && typeof node === 'object' && Array.isArray(node.userErrors) && node.userErrors.length) { msg = String(node.userErrors[0].message || 'validation error'); break; }
              }
            }
            if (msg) reply = { success: false, error: 'graphql-error', detail: msg.slice(0, 200), origin };
          }
          // CX-7e — surface the tab-derived urlParam (handle) so the panel can build the record's human page for
          // "show profile" (the itemUrl needs {handle}, which lives on the ride tab, not on the record). TRUSTED.
          const _urlArgs = (payload && payload.urlParam && payload.urlParam.name && args[payload.urlParam.name] != null)
            ? { [payload.urlParam.name]: args[payload.urlParam.name] } : undefined;
          sendResponse(reply && reply.success ? { ...reply, origin, urlArgs: _urlArgs } : (reply || { success: false, error: 'no-reply' }));
        } catch (e) {
          sendResponse({ success: false, error: (e && e.message) || 'invoke-session-failed' });
        } finally {
          if (ephemeralOrigin) _releaseEphemeralTab(ephemeralOrigin);   // idle-close (a burst reuses first; a re-auth-focused tab was promoted out)
        }
      })();
      return true;   // async — keep the sendResponse channel open
    },

    // CX-5b (v2.74.1306) — INVOKE_CONNECTOR (OAuth/MCP broker, §5/§7): the model SELECTED a broker tool; we hand
    // {server, tool, args} to the cloud proxy, which injects the vaulted OAuth secret at egress (the extension never
    // sees a third-party token). A WRITE is fail-closed behind explicit confirmed:true HERE (Belt #1, §9) before it
    // leaves the extension; the proxy re-checks. A 404/501 (proxy not provisioned) → 'broker-unavailable' (honest).
    // Never drives a tab → not busy-marked. Logs `CONNECTOR_INVOKE ▸` (Invariant #1: in studio.js _DECISION_RE).
    'INVOKE_CONNECTOR': (payload, _sender, sendResponse) => {
      (async () => {
        const gate = brokerInvokeGate(payload);
        const who = `${(payload && payload.server) || '?'}/${(payload && payload.tool) || '?'}`;
        if (!gate.ok) {
          try { Logger.info('connector', `CONNECTOR_INVOKE ▸ ${who} → BLOCKED (${gate.error})`); } catch { /* */ }
          sendResponse({ success: false, error: gate.error, hint: gate.hint }); return;
        }
        if (typeof cloudInvokeConnector !== 'function') {
          try { Logger.warn('connector', `CONNECTOR_INVOKE ▸ ${who} → no proxy client wired`); } catch { /* */ }
          sendResponse({ success: false, error: 'broker-unavailable', hint: 'the connector proxy is not wired' }); return;
        }
        let resp = null, err = null;
        try { resp = await cloudInvokeConnector(gate.request); } catch (e) { err = e; }
        const reply = brokerReplyFromCloud({ resp, err });
        try { Logger.info('connector', `CONNECTOR_INVOKE ▸ ${gate.request.server}/${gate.request.tool} ${gate.write ? '(write)' : '(read)'} → ${reply.success ? 'ok' : reply.error}`); } catch { /* */ }
        sendResponse(reply);
      })();
      return true;   // async — keep the sendResponse channel open
    },

    // MP-3 (v2.74.1310) — LINK_CONNECTOR (§5.2 pinned contract): dance the provider's PKCE authorize CLIENT-side
    // via chrome.identity.launchWebAuthFlow, then hand ONLY {code, redirectUri, codeVerifier} to the JWT-authed
    // proxy, which exchanges + vaults the refresh token. The extension never sees a secret or a refresh token; the
    // state param is VERIFIED (parseAuthRedirect) so an injected redirect can't smuggle a code. The client id is
    // PUBLIC config — chrome.storage.local `connector:oauthClientId:{provider}` (set once per install/deploy).
    // Logs `CONNECTOR_LINK ▸` (Invariant #1: in studio.js _DECISION_RE).
    'LINK_CONNECTOR': (payload, _sender, sendResponse) => {
      (async () => {
        const provider = String((payload && payload.provider) || '').trim();
        try {
          if (!provider) { sendResponse({ success: false, error: 'no-provider' }); return; }
          if (typeof cloudLinkConnector !== 'function') { sendResponse({ success: false, error: 'broker-unavailable', hint: 'the connector proxy is not wired' }); return; }
          const cfgKey = `connector:oauthClientId:${provider}`;
          const clientId = String((payload && payload.clientId) || (await chrome.storage.local.get(cfgKey))[cfgKey] || '').trim();
          if (!clientId) {
            try { Logger.info('connector', `CONNECTOR_LINK ▸ ${provider} → BLOCKED (no client id)`); } catch { /* */ }
            sendResponse({ success: false, error: 'connector-not-configured', hint: `set ${cfgKey} in chrome.storage.local (the PUBLIC OAuth client id)` }); return;
          }
          // v2.74.1312 — PREFLIGHT the Orchard session BEFORE the consent dance: the vault POST rides the Cognito
          // JWT, so a signed-out user would otherwise walk the whole Google consent flow and THEN fail. Fail fast.
          if (typeof cloudHasSession === 'function' && !(await cloudHasSession())) {
            try { Logger.info('connector', `CONNECTOR_LINK ▸ ${provider} → BLOCKED (not signed in to Orchard cloud)`); } catch { /* */ }
            sendResponse({ success: false, error: 'orchard-not-signed-in', hint: 'sign in to Orchard cloud first (Studio → Cloud) — the link vaults on your cloud account' }); return;
          }
          const scopes = providerScopes(provider);
          const { verifier, challenge } = await pkcePair();
          const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
          const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/${provider}`;
          const url = authorizeUrl({ provider, clientId, redirectUri, scopes, state, codeChallenge: challenge });
          if (!url) { sendResponse({ success: false, error: 'unknown-provider' }); return; }
          const redirectedTo = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
          const parsed = parseAuthRedirect(redirectedTo, state);
          if (!parsed.ok) {
            try { Logger.info('connector', `CONNECTOR_LINK ▸ ${provider} → ${parsed.error}`); } catch { /* */ }
            sendResponse({ success: false, error: parsed.error }); return;
          }
          const reply = await cloudLinkConnector(provider, { code: parsed.code, redirectUri, codeVerifier: verifier });
          await _writeLinkedProviders([...(await _readLinkedProviders()), provider]);   // CX-5c — the palette gate reads this
          _refreshConnectorState().catch(() => { /* MP-2c — best-effort live-tools discovery; the seed serves until it lands */ });
          try { Logger.info('connector', `CONNECTOR_LINK ▸ ${provider} → linked (${(reply && reply.scope) || 'no scope reported'})`); } catch { /* */ }
          sendResponse({ success: true, provider, scope: (reply && reply.scope) || '' });
        } catch (e) {
          // launchWebAuthFlow rejects on user-cancel too — surface it plainly, never as a fake failure elsewhere.
          // v2.74.1313 — thread the PROXY'S HINT through (CloudClientError carries the 502 body — e.g. Google's
          // `invalid_client` on a bad env secret). Dropping it turned the first live link failure into a guessing
          // game: the cause was captured at both ends and visible at neither (findings 2026-07-01 23:06).
          const hint = (e && e.body && typeof e.body === 'object' && e.body.hint) ? String(e.body.hint) : null;
          try { Logger.info('connector', `CONNECTOR_LINK ▸ ${provider} → ${(e && e.message) || 'link-failed'}${hint ? ` (${hint})` : ''}`); } catch { /* */ }
          sendResponse({ success: false, error: (e && e.message) || 'link-failed', hint });
        }
      })();
      return true;   // async — keep the sendResponse channel open
    },

    // CX-5c — UNLINK_CONNECTOR: revoke + drop the vault record (proxy-side), then clear the local palette gate.
    'UNLINK_CONNECTOR': (payload, _sender, sendResponse) => {
      (async () => {
        const provider = String((payload && payload.provider) || '').trim();
        try {
          if (!provider) { sendResponse({ success: false, error: 'no-provider' }); return; }
          if (typeof cloudUnlinkConnector === 'function') { try { await cloudUnlinkConnector(provider); } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'unlink-failed' }); return; } }
          await _writeLinkedProviders((await _readLinkedProviders()).filter((p) => p !== provider));
          // v1342 (review H P4) — drop this provider's liveTools entries so the palette doesn't carry stale schemas.
          try {
            const lt = await _readLiveTools();
            for (const entry of BROKER_CATALOG) {
              if (entry && entry.provider === provider && entry.server) delete lt[entry.server];
            }
            await _writeLiveTools(lt);
          } catch { /* */ }
          try { Logger.info('connector', `CONNECTOR_LINK ▸ ${provider} → unlinked`); } catch { /* */ }
          sendResponse({ success: true, provider, unlinked: true });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'unlink-failed' }); }
      })();
      return true;
    },

    // CX-5c — GET_CONNECTOR_STATUS: the backend's linked-state is the truth; refresh the local cache from it (the
    // Studio/status surface calls this; the palette reads the cache). Cloud-unreachable → the cache, marked stale.
    'GET_CONNECTOR_STATUS': (_payload, _sender, sendResponse) => {
      (async () => {
        try {
          try {
            const st = await _refreshConnectorState();   // MP-2c — linked + live tools in one refresh
            if (st) { sendResponse({ success: true, ...st, stale: false }); return; }
          } catch { /* fall through to the cache */ }
          sendResponse({ success: true, linked: await _readLinkedProviders(), stale: true });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'status-failed' }); }
      })();
      return true;
    },

    // §20 (v2.74.1288) — SESSION_REPLAY (header-replay session-ride): for a cross-origin Bearer/JWT API (a static SPA's
    // data API, where a cookie can't ride), execute a harvested READ by replaying the page-captured auth headers FROM the
    // app tab. Finds the live app tab on `sessionHost` (where the login + captured token live) and runs `_replayFetchFunc`
    // there in the MAIN world. GET-shaped reads only — a header-replay write is a future, harder HITL slice. The token
    // stays page-local; the background only ever sees the response. → { success, value } | { success:false, error, hint }.
    'SESSION_REPLAY': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const sessionHost = String((payload && payload.sessionHost) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const apiHost = String((payload && payload.origin) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const method = String((payload && payload.method) || 'GET').toUpperCase();
          const isWrite = (method !== 'GET' && method !== 'HEAD');
          // §18 arm guard (v2.74.1340, review A) — SESSION_REPLAY is where HARVESTED recipes execute, so it re-checks
          // armable at run time exactly like INVOKE_SESSION: a recipe disabled / un-accepted / rejected in Studio after
          // projection must not run. Same fall-through semantics: no {groundId, recipeId} or no stored record → proceed.
          if (payload && payload.groundId && payload.recipeId && typeof readRideRecipes === 'function') {
            try {
              const _recs = await readRideRecipes(payload.groundId);
              const _rec = Array.isArray(_recs) ? _recs.find((r) => r && r.id === payload.recipeId) : null;
              if (_rec && !armable(_rec)) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → BLOCKED (recipe ${payload.recipeId} not armable)`); } catch { /* */ } sendResponse({ success: false, error: 'recipe-not-armable', hint: _rec.reviewState === 'pending' ? 'accept this recipe in Studio first' : 'this recipe is disabled in Studio' }); return; }
            } catch { /* never block on the guard's own failure */ }
          }
          // CX-6 (v2.74.1303) — FAIL-CLOSED write gate: a header-replay WRITE fires ONLY with explicit confirmation
          // (the panel's HITL confirm passes confirmed:true). A write can NEVER run unattended or without the user
          // approving THIS exact request — the execution boundary itself refuses it, independent of any caller.
          if (isWrite && !(payload && payload.confirmed === true)) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → BLOCKED (write, not confirmed)`); } catch { /* */ } sendResponse({ success: false, error: 'write-needs-confirm' }); return; }
          const reqBody = isWrite ? ((payload && typeof payload.body === 'string') ? payload.body : ((payload && payload.body != null) ? JSON.stringify(payload.body) : null)) : null;
          const contentType = isWrite ? String((payload && payload.contentType) || '') : '';
          const args = (payload && typeof payload.params === 'object' && payload.params) || {};
          const path = fillEndpoint(String((payload && payload.endpoint) || ''), args);
          if (!sessionHost || !apiHost || !path) { sendResponse({ success: false, error: 'replay-missing-fields' }); return; }
          const url = `https://${apiHost}${path.startsWith('/') ? path : '/' + path}`;
          let tabs = []; try { tabs = await chrome.tabs.query({ url: `*://${sessionHost}/*` }); } catch { tabs = []; }
          const tab = pickRideTab(tabs);
          if (!tab) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → NO-APP-TAB on ${sessionHost} (open it + arm Forage)`); } catch { /* */ } sendResponse({ success: false, error: 'no-app-tab', hint: `open ${sessionHost} (your logged-in app) and arm Forage` }); return; }
          try { await armRideAuthCapture({ host: sessionHost, tabId: tab.id }); } catch { /* §20 — keep the token fresh for next time (+ in-place arm now); best-effort */ }
          let out = null;
          try { out = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: _replayFetchFunc, args: [url, apiHost, method, reqBody, contentType] }); }
          catch (e) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} exec-failed: ${e && e.message}`); } catch { /* */ } sendResponse({ success: false, error: 'replay-exec-failed' }); return; }
          const r = out && out[0] && out[0].result;
          if (!r) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} no-result (tab ${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: 'replay-no-result' }); return; }
          // §20 — outcome observability (Invariant #1: `SESSION_REPLAY ▸` is in studio.js _DECISION_RE). Body-SHAPE only (no PII): array length / object-key count, never the rows.
          const _shape = Array.isArray(r.body) ? `array[${r.body.length}]` : (r.body && typeof r.body === 'object' ? `object{${Object.keys(r.body).length}}` : (r.body == null ? 'empty' : typeof r.body));
          if (r.noAuth) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → NO-AUTH on tab ${tab.id} (looked for "${apiHost}"; captured hosts: [${(r.keys || []).join(', ')}])`); } catch { /* */ } sendResponse({ success: false, error: 'no-session-captured', hint: `arm Forage on ${sessionHost} to capture the session, then retry` }); return; }
          if (r.error) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} ${method} → fetch-error: ${r.error} (tab ${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: r.error }); return; }
          if (r.status === 401 || r.status === 403) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → ${r.status} session-expired (tab ${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: 'session-expired', hint: `re-arm Forage on ${sessionHost} to refresh the session` }); return; }
          if (r.status >= 400) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → ${r.status} http-error (tab ${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: `http-${r.status}`, hint: 'the server rejected the request', status: r.status, value: r.body }); return; }
          try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → ${r.status} ${_shape} (tab ${tab.id})`); } catch { /* */ }
          sendResponse({ success: true, value: r.body, status: r.status, origin: apiHost });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'replay-failed' }); }
      })();
      return true;
    },

    // VERIFY_CONNECTION (AS-4) — setup-time "is this site connected?" check for ONE origin. A recipe-backed site uses
    // the STRONG identity probe (catches the §14 200+anon sentinel); a generic site loads its origin and classifies the
    // final URL (login page → signed-out). On not-connected, the tab is FOREGROUNDED for the human to sign in (§16).
    // → { success, verdict:'connected'|'signed-out'|'unreachable', origin, identity? }.
    'VERIFY_CONNECTION': (payload, _sender, sendResponse) => {
      (async () => {
        let ephemeralOrigin = null;                          // a throwaway verify tab we should close (unless kept for sign-in)
        try {
          const origin = String((payload && payload.origin) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          if (!origin) { sendResponse({ success: false, error: 'no-origin' }); return; }

          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: `*://${origin}/*` }); } catch { tabs = []; }
          let tab = pickRideTab(tabs);
          if (!tab) { const got = await _acquireEphemeralTab(origin); ephemeralOrigin = origin; tab = { id: got.tabId }; if (got.opened) await _waitTabComplete(got.tabId); }
          if (typeof ensureContentScript === 'function') { try { await ensureContentScript(tab.id); } catch { /* */ } }

          const recipe = recipeForOrigin(origin);
          let verdict, identity = null;
          if (recipe && recipe.verifyIdentity) {
            const probePath = String(recipe.identityProbe || '/api/v2/users/me.json');
            const reply = await fetchViaHealed(tab.id, `https://${origin}${probePath.startsWith('/') ? probePath : '/' + probePath}`, 'GET');
            const v = assessProbe(reply, null);
            verdict = v.status === STATUS.FRESH ? 'connected' : 'signed-out';
            if (v.user) identity = { id: v.user.id ?? null, name: v.user.name ?? null, email: v.user.email ?? null };
          } else {
            let url = '';
            try { const t = await chrome.tabs.get(tab.id); url = (t && t.url) || ''; } catch { /* */ }
            // review P1-6: pass the requested HOST (no port) so a landing on a wholly different host that isn't a
            // login/IdP redirect is caught as a park/redirect (belt over classifyReachProbe's non-http→unreachable floor).
            let requestedHost = ''; try { requestedHost = new URL(`https://${origin}`).hostname; } catch { /* */ }
            verdict = classifyReachProbe({ finalUrl: url, requestedHost });
          }

          if (verdict !== 'connected') { await _focusTab(tab.id); ephemeralOrigin = null; }   // bring it forward for sign-in; keep it
          sendResponse({ success: true, verdict, origin, identity });
        } catch (e) {
          sendResponse({ success: false, error: (e && e.message) || 'verify-failed' });
        } finally {
          if (ephemeralOrigin) _releaseEphemeralTab(ephemeralOrigin);
        }
      })();
      return true;
    },
  };
}
