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

import { fillEndpoint, fillBody, recipeForOrigin, isReadOnlyGql, persistedOpsForHost, csrfSniffHosts } from '../../Core/connectorRecipes.js';   // LEG-2a (v2.74.1594) — the ops viewer's wanted-vs-banked checklist; v1760 — csrfSniffHosts for pre-warm
import { pickRideTab, rideTabUrlPatterns, isCsrfColdFailure, assessProbe, rideAction, STATUS, classifyReachProbe, probedUser, isAnonUser } from '../../Core/connection.js';   // v1471 — probedUser/isAnonUser for the SESSION_REPLAY {me} fill; v1758 — rideTabUrlPatterns; v1759 — isCsrfColdFailure
import { armable } from '../../Core/rideRecipe.js';   // §18 — the arm guard: a non-armable (disabled / pending / rejected) per-Ground recipe must not run
import { reportLegOutcome } from './vitals.js';   // VT-0 (v2.74.1569, DESIGN_vitals.md §4) — the ONE outcome funnel per executor: presence → drift classification in order (subsumes the v1566 _healTick + the side-by-side reportAuthSignal calls)
import { brokerInvokeGate, brokerReplyFromCloud } from '../../Core/brokerInvoke.js';   // CX-5b — the broker (OAuth/MCP) fail-closed gate + cloud-reply normalizer (pure)
import { registerConnTransitionListener } from './connections.js';   // v2.74.1853 — presence is the csrf bank's TRUE lifecycle clock (signed-out → the session-bound token is certainly dead)
import { BROKER_CATALOG } from '../../Core/brokerCatalog.js';   // v1342 — UNLINK clears this provider's liveTools cache entries
import { pkcePair, authorizeUrl, parseAuthRedirect } from '../../Core/oauthLink.js';   // MP-3 — the pure client half of the link dance (§5.2 pinned contract)
import { providerScopes } from '../../Core/mcpServers.js';                             // MP-3 — one dance grants every server the provider fronts
import { Logger } from '../../Core/Logger.js';   // §20 — SESSION_REPLAY outcome observability (Invariant #1)
import { armRideAuthCapture, markEngineBusy } from './sg.js';   // §20 — keep the page-local token fresh on the app tab (no import cycle: sg.js doesn't import connector.js); FL-1c — SHOW_SOURCES busy-marks its driven navigation (Invariant #2)
import { reportAuthSignal } from './connections.js';   // CP-1 (v2.74.1506) — every auth outcome feeds the connections registry (one write door)
import { payloadShapeLine, payloadShapeKey } from '../../Core/payloadShape.js';   // v1872 — the keys-only response shape (Invariant #1: `PAYLOAD ▸`); v1888 — payloadShapeKey: the length-normalised comparison key, so a list's length is not a "new shape"
import { assessLiveness } from '../../Core/connectionPresence.js';   // CP-1 — the json-liveness probe verdict (the ride-outcome→signal classifier moved into the VT-0 funnel, Core/vitals.js)

// ── Ephemeral managed-tab registry (§16) — module singleton, lives within a SW lifetime ─────────────────────────────
const IDLE_CLOSE_MS = 8000;                 // close an Orchard-opened tab this long after its last ride (burst-reuse window)
const _managed = new Map();                 // origin → { tabId, timer }
const _lastOriginByAppHost = new Map();     // appHost → last concrete origin seen (lets a cold start open the right host)
// v2.74.1872 — recipeIds whose response shape has already been logged. Same SW lifetime as the registry above,
// which is the right scope: a reload is exactly when you want to re-see the shapes.
const _payloadShapeSeen = new Map();   // v1887 — recipeId → the last PAYLOAD line emitted (keyed on the SHAPE, not on "seen")

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
// v2.74.1862 — an unfilled-param refusal NAMES ITS CHOICES when the recipe declares an enum. Live 171211: "get
// everything on that warranty task" bound an address but no status and got *"needs status. tell me which status
// and I'll fetch it"* — honest, and a dead end, because nothing on screen says a status is one of four words.
// DELIBERATELY NOT A DEFAULT: defaulting `status` to "open" would silently miss the closed task the sibling ask
// actually wanted (live: task 4867009 is Closed), which is the confidently-wrong class this project refuses.
// Ask, but ask answerably.
function _enumHint(payload, name) {
  try {
    const props = payload && payload.paramSchema && payload.paramSchema.properties;
    const vals = (props && props[name] && Array.isArray(props[name].enum)) ? props[name].enum.filter(Boolean).slice(0, 8) : [];
    if (vals.length) return `which ${name}? ${vals.join(' / ')}`;
  } catch { /* the hint is a courtesy — never break the refusal it decorates */ }
  return `tell me which ${name} and I’ll fetch it`;
}

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
// CX-9o (v2.74.1453) — injected into the ride tab (isolated world) by CLICK_TEXT_ON_TAB: click the most SPECIFIC
// visible element containing `text`, climbing ≤4 levels to its clickable unit (link/button/row). Returns what was
// clicked (tag + a short excerpt) or {clicked:false}. Self-contained — no page/extension state touched.
function _clickTextFunc(text) {
  const q = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!q) return { clicked: false };
  let best = null;
  for (const el of document.querySelectorAll('a,button,[role],tr,td,li,div,span')) {
    const t = (el.textContent || '').toLowerCase().replace(/\s+/g, ' ');
    if (!t.includes(q)) continue;
    if (el.getClientRects().length === 0) continue;                    // invisible → not a real target
    if (!best || t.length < best.len) best = { el, len: t.length };    // smallest containing element = most specific
  }
  if (!best) return { clicked: false };
  let target = best.el;
  let n = best.el;
  for (let d = 0; d < 4 && n; d++, n = n.parentElement) {              // climb to the clickable UNIT (row/link/button)
    let hits = false;
    try { hits = n.matches('a,button,[role="button"],[role="row"],[role="link"],tr,[onclick]'); } catch { hits = false; }
    if (hits) { target = n; break; }
  }
  try { target.click(); } catch { return { clicked: false }; }
  return { clicked: true, tag: target.tagName };
}

function _replayFetchFunc(url, apiHost, method, reqBody, contentType, extraHeaders) {
  // v1477 — JWT helpers (MAIN-world, inlined so executeScript serializes them). Decode ONLY the payload's exp/iss/
  // aud claims — never the signature, never logged; the token stays in the page (background sees minutes-to-expiry).
  function _b64url(x) { try { x = String(x).replace(/-/g, '+').replace(/_/g, '/'); while (x.length % 4) x += '='; return atob(x); } catch (e) { return null; } }
  function _jwtPayload(tok) { try { var pr = String(tok).split('.'); if (pr.length !== 3 || pr[0].indexOf('eyJ') !== 0) return null; var j = _b64url(pr[1]); return j ? JSON.parse(j) : null; } catch (e) { return null; } }
  var _JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
  // Scan web storage for the FRESHEST still-valid JWT whose issuer + client/audience match the CAPTURED bearer.
  // OPAQUE-SAFE (v1478): a captured token that is NOT a JWT ('opaque') can't be matched by claims, so we NEVER
  // grab an unrelated storage JWT for it — return token:null and let the diagnostic say 'opaque' (the live-read
  // can't refresh it; a re-capture is needed). Returns { token, count, capKind }. Claims/counts only, never a value.
  function _freshestBearer(capAuth) {
    var count = 0, capKind = 'none';
    try {
      var capTok = null; if (capAuth) { var m = String(capAuth).match(/Bearer\s+(\S+)/i); capTok = m ? m[1] : String(capAuth); }
      var capPl = capTok ? _jwtPayload(capTok) : null;
      capKind = capTok ? (capPl ? 'jwt' : 'opaque') : 'none';
      var nowSec = Date.now() / 1000;
      var best = null, bestExp = (capPl && capPl.exp) ? capPl.exp : 0;   // must beat the captured token's own exp
      var stores = []; try { stores.push(localStorage); } catch (e) {} try { stores.push(sessionStorage); } catch (e) {}
      for (var si = 0; si < stores.length; si++) {
        var st = stores[si]; if (!st) continue;
        for (var i = 0; i < st.length; i++) {
          var v = null; try { v = st.getItem(st.key(i)); } catch (e) { continue; }
          if (!v || v.indexOf('eyJ') === -1) continue;
          var found = v.match(_JWT_RE); if (!found) continue;
          for (var c = 0; c < found.length; c++) {
            var pl = _jwtPayload(found[c]); if (!pl || !pl.exp) continue;
            count++;
            if (!capPl) continue;                                                                     // opaque capture → count only, never substitute
            if (capPl.iss && pl.iss && pl.iss !== capPl.iss) continue;                                 // same issuer
            var capAud = (capPl.client_id || capPl.aud), plAud = pl.client_id || pl.aud;
            if (capAud && plAud && String(plAud) !== String(capAud)) continue;                         // same client/audience
            if (pl.exp > nowSec && pl.exp > bestExp) { best = found[c]; bestExp = pl.exp; }            // valid + fresher
          }
        }
      }
      return { token: best, count: count, capKind: capKind };
    } catch (e) { return { token: null, count: count, capKind: capKind }; }
  }
  // v2.74.1480 (Fix B) — locate the app's OWN Cognito/Amplify store: { clientId, user, refreshToken, iss } from the
  // stable `CognitoIdentityServiceProvider.<clientId>.<user>.<type>` key layout. iss comes from the STORED access
  // token's own claim (never constructed), so the refresh POSTs only to the token's verified issuer. Reads only.
  function _findCognito() {
    try {
      var re = /^CognitoIdentityServiceProvider\.([^.]+)\.LastAuthUser$/;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i); var m = k && k.match(re); if (!m) continue;
        var clientId = m[1]; var user = localStorage.getItem(k); if (!user) continue;
        var base = 'CognitoIdentityServiceProvider.' + clientId + '.' + user + '.';
        var refreshToken = localStorage.getItem(base + 'refreshToken');
        var accessToken = localStorage.getItem(base + 'accessToken');
        var ap = accessToken ? _jwtPayload(accessToken) : null;
        if (refreshToken && ap && ap.iss) return { clientId: clientId, user: user, refreshToken: refreshToken, iss: ap.iss };
      }
    } catch (e) {}
    return null;
  }
  // v2.74.1480 (Fix B) — InitiateAuth REFRESH_TOKEN_AUTH at the token's OWN issuer (what amazon-cognito-identity-js
  // does). Returns { token, status, note } — the fresh ACCESS token or null + a diag NOTE (Cognito's error CODE /
  // http status ONLY). The refresh token + minted token NEVER leave the page and are NEVER logged. A dead refresh
  // token (NotAuthorizedException) → note carries Cognito's own reason → the user must actually re-login.
  async function _cognitoRefresh() {
    var c = null; try { c = _findCognito(); } catch (e) {}
    if (!c) return { token: null, note: 'no-cognito-store' };
    try {
      var endpoint; try { endpoint = new URL(c.iss).origin + '/'; } catch (e) { return { token: null, note: 'bad-iss' }; }
      var res = await fetch(endpoint, { method: 'POST', credentials: 'omit',
        headers: { 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth' },
        body: JSON.stringify({ AuthFlow: 'REFRESH_TOKEN_AUTH', ClientId: c.clientId, AuthParameters: { REFRESH_TOKEN: c.refreshToken } }) });
      var b = null; try { b = await res.json(); } catch (e) {}
      if (res.status === 200 && b && b.AuthenticationResult && b.AuthenticationResult.AccessToken) return { token: b.AuthenticationResult.AccessToken, status: res.status, note: 'ok' };
      var code = (b && b.__type) ? String(b.__type).split(/[#:.]/).pop() : ('http-' + res.status);
      return { token: null, status: res.status, note: code };
    } catch (e) { return { token: null, note: 'net-fail' }; }
  }
  return (async function () {
    try {
      var store = window.__ahub_ride_auth || {};
      var cap = store[apiHost] || null;
      var hasBearer = !!(cap && cap.headers && cap.headers.authorization);
      var sameOrigin = false; try { sameOrigin = (String(apiHost) === location.host); } catch (e) { sameOrigin = false; }
      // §20 (v2.74.1430) — AUTH MODEL, auto-selected (the replay handles BOTH, it no longer assumes Bearer): a captured
      // BEARER (a cross-origin header-auth API) replays with that header, cookies omitted. NO Bearer but the API is
      // SAME-ORIGIN as this logged-in page → ride the session COOKIE (credentials 'include'), exactly like a cookie-ride
      // read — a cookie-auth portal has no Authorization header for the tee to capture, so the old Bearer-only path wrongly
      // failed it as no-session-captured. A CROSS-origin API with no captured Bearer genuinely needs one (→ noAuth; arm + retry).
      if (!hasBearer && !sameOrigin) return { noAuth: true, keys: Object.keys(store) };   // keys → diagnose a host-key mismatch vs an empty global
      var headers = { accept: 'application/json' };
      // CX-10 (v2.74.1464) — the recipe's static requestHeaders ride BOTH auth modes (the v1459 class, third hop:
      // a BFF that requires a routing header — Aircall's `aircall-platform` — 401s the cookie fetch without it, and
      // the 401 reads as "session-expired" on a LIVE login). Captured bearer headers still override on collision.
      if (extraHeaders && typeof extraHeaders === 'object') { for (var xh in extraHeaders) { if (Object.prototype.hasOwnProperty.call(extraHeaders, xh)) headers[xh] = extraHeaders[xh]; } }
      var init;
      var refreshedBearer = '', capKindOut = 'none', storedJwtsOut = 0, cognitoNote = '';
      if (hasBearer) {
        for (var k in cap.headers) { if (Object.prototype.hasOwnProperty.call(cap.headers, k)) headers[k] = cap.headers[k]; }
        // v1477 — REFRESH the captured (possibly-expired) bearer from the SPA's OWN live token store. The SPA silently
        // rotates its token; our capture is a stale snapshot. Use the freshest matching token in web storage instead.
        try { var _fb = _freshestBearer(cap.headers.authorization); if (_fb) { capKindOut = _fb.capKind; storedJwtsOut = _fb.count; if (_fb.token) { headers.authorization = 'Bearer ' + _fb.token; refreshedBearer = 'store'; } } } catch (e) {}
        // v1480 (Fix B) — if the token we'd send is EXPIRED (or undecodeable), MINT a fresh one from the refresh token
        // (the SPA's own hourly refresh, done silently for the user). Cache the mint page-locally so the NEXT call
        // reuses it until IT expires — one mint per token-lifetime, not per request.
        try {
          var _curM = String(headers.authorization || '').match(/Bearer\s+(\S+)/i); var _curPl = _curM ? _jwtPayload(_curM[1]) : null;
          var _needMint = !_curPl || !_curPl.exp || (_curPl.exp < (Date.now() / 1000) + 30);
          if (_needMint) {
            var _cr = await _cognitoRefresh(); cognitoNote = _cr.note || '';
            if (_cr.token) {
              headers.authorization = 'Bearer ' + _cr.token; refreshedBearer = 'cognito';
              try { if (!window.__ahub_ride_auth) window.__ahub_ride_auth = {}; var _nh = {}; for (var _ck in cap.headers) { if (Object.prototype.hasOwnProperty.call(cap.headers, _ck)) _nh[_ck] = cap.headers[_ck]; } _nh.authorization = 'Bearer ' + _cr.token; window.__ahub_ride_auth[apiHost] = { headers: _nh, at: (window.performance && performance.now) ? performance.now() : 0 }; } catch (e) {}
            }
          }
        } catch (e) {}
        // v1466 — a SAME-ORIGIN bearer sends cookies TOO: the SPA's own same-origin fetches carry BOTH the session
        // cookie and the Authorization header, and an app can require the PAIR (live gc 18:38: Aircall /v3 401'd
        // `cookie+hdrs` AND `bearer+hdrs` — each alone). Cross-origin bearer keeps credentials:'omit' (credentialed
        // CORS is rejected by a header-auth API — the v1430 rationale, unchanged).
        init = { method: method || 'GET', headers: headers, credentials: sameOrigin ? 'include' : 'omit' };
      } else {
        init = { method: method || 'GET', headers: headers, credentials: 'include' };   // same-origin cookie-ride: the session cookie rides automatically
      }
      if (reqBody != null && method && method !== 'GET' && method !== 'HEAD') { init.body = reqBody; if (contentType) headers['content-type'] = contentType; }   // CX-6 — a confirmed WRITE: attach the filled body + its content type
      var res = await fetch(url, init);
      var status = res.status, body = null;
      try { body = await res.json(); } catch (e) { try { body = await res.text(); } catch (e2) { body = null; } }
      var capAgeMin = null; try { if (hasBearer && cap && cap.at && window.performance && performance.now) capAgeMin = Math.round((performance.now() - cap.at) / 60000); } catch (e) {}
      // v1477 — the SENT token's REAL freshness (minutes to expiry; negative = expired) — the honest number the
      // misleading capAge (snapshot age, not token age) obscured. Decoded from the token we actually sent.
      var tokExpMin = null; try { var _am = String(headers.authorization || '').match(/Bearer\s+(\S+)/i); var _sp = _am ? _jwtPayload(_am[1]) : null; if (_sp && _sp.exp) tokExpMin = Math.round((_sp.exp - Date.now() / 1000) / 60); } catch (e) {}
      // v1478 — the SENT token's KIND (jwt|opaque|none), unconditional: the datum that ends 'why didn't the live-read refresh?'.
      var tokKindOut = 'none'; try { var _tm = String(headers.authorization || '').match(/Bearer\s+(\S+)/i); tokKindOut = _tm ? (_jwtPayload(_tm[1]) ? 'jwt' : 'opaque') : 'none'; } catch (e) {}
      // v1476 — the WIRE: the NAMES actually sent (post-merge, lowercased) + the captured baseline's names, so the
      // background can diff "what we sent" vs "what the SPA's own request carried". NAMES ONLY — a value never leaves.
      var sentNames = []; try { sentNames = Object.keys(headers).map(function (h) { return String(h).toLowerCase(); }).sort(); } catch (e) {}
      var capNames = []; try { if (cap && cap.headers) capNames = Object.keys(cap.headers).map(function (h) { return String(h).toLowerCase(); }).sort(); } catch (e) {}
      // v1476 — the server's OWN failure STATEMENT (gql errors[].message / REST error|message|troubleshoot / a text
      // body's head). The Logger scrubber redacts any PII (email/phone) downstream; kept short. This is the token that
      // would have ended six rounds of guessing at the first 401 — the app TELLS you why, if you log what it says.
      var srvMsg = null;
      try {
        if (body && typeof body === 'object') {
          if (Array.isArray(body.errors) && body.errors.length) { var e0 = body.errors[0] || {}; srvMsg = e0.message || e0.code || e0.reason || (e0.extensions && e0.extensions.code) || 'error'; }
          else srvMsg = body.error || body.message || body.troubleshoot || body.error_description || body.detail || null;
          if (srvMsg && typeof srvMsg === 'object') srvMsg = (srvMsg.message || srvMsg.code || JSON.stringify(srvMsg));
          // v2.74.1559 — a CONTENTLESS extraction is a blind diagnostic (live 195557: the panel said only
          // `the server said: result` for a vs http-500 — the v1402 lesson: detail must reach the eyeball).
          // A short spaceless token (or nothing) falls back to a slice of the error body itself. Error bodies
          // are structural (.NET/GraphQL error JSON), and 180 chars bounds any payload echo.
          var _thin = !srvMsg || (typeof srvMsg === 'string' && srvMsg.length <= 8 && srvMsg.indexOf(' ') < 0);
          if (_thin) { try { var _bs = JSON.stringify(body); if (_bs && _bs.length > 2) srvMsg = (srvMsg ? srvMsg + ' · ' : '') + _bs.slice(0, 180); } catch { /* keep what we have */ } }
        } else if (typeof body === 'string' && body) { srvMsg = body.slice(0, 160); }
        if (srvMsg != null) srvMsg = String(srvMsg).replace(/\s+/g, ' ').trim().slice(0, 160);
      } catch (e) {}
      return { status: status, body: body, mode: hasBearer ? (sameOrigin ? 'bearer+cookie' : 'bearer') : 'cookie', hdrs: !!extraHeaders, capAge: capAgeMin, sent: sentNames, capNames: capNames, srvMsg: srvMsg, tokExp: tokExpMin, refreshed: refreshedBearer, tokKind: tokKindOut, capKind: capKindOut, storedJwts: storedJwtsOut, cognitoNote: cognitoNote };
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

export function createConnectorHandlers({ ensureContentScript, readRideRecipes, writeRideRecipes, cloudInvokeConnector, cloudLinkConnector, cloudUnlinkConnector, cloudListConnectorTools, cloudHasSession } = {}) {
  // VT-0 (v2.74.1569) — the v1566 `_healTick` moved INTO the vitals funnel (background/handlers/vitals.js):
  // every ride outcome makes ONE `reportLegOutcome` call; the funnel classifies presence FIRST (feeding the
  // connections registry, probe-spec self-heal riding along), gates drift evidence on the registry verdict
  // (the 404-on-anonymous false-drift fix), applies the routeHeal ticks, and records incidents. writeRideRecipes
  // stays in this ctx for the vitals wiring (background.js passes the same stores to initVitals).
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
  // v2.74.1853 — VALIDATE-ON-USE (findings 2026-07-27 correction): 20 minutes was a VALIDITY guess that expired
  // our copy while Shopify still honored the token (the 19:46→20:12 live wedge). Validity is now decided by the
  // server — a 403 clears the bank via the v1759 cold-ladder (the recovery that already existed); this TTL is
  // HYGIENE only (don't serve a token across days; presence signed-out clears it sooner — see the transition
  // listener below the prewarm).
  const CSRF_TTL_MS = 24 * 3600e3;
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
  async function _clearBankedCsrf(origin) {
    try { await chrome.storage.local.remove(_CSRF_KEY(origin)); } catch { /* */ }
    _sniffedCsrf.delete(origin);
  }

  // v2.74.1759 — soft-wake an idle ride tab so the SPA fires a request the CSRF tee can sniff. Briefly activates
  // the tab (does NOT focus the window — stays background-ish if the window isn't front), waits for traffic,
  // then restores the previously-active tab in that window so the user's chat surface isn't stolen.
  async function _softWakeRideTab(tabId) {
    let prevId = null;
    try {
      const t = await chrome.tabs.get(tabId);
      if (!t || t.id == null) return;
      if (t.discarded === true) { try { await chrome.tabs.reload(tabId); await _waitTabComplete(tabId); } catch { /* */ } }
      try {
        const actives = await chrome.tabs.query({ active: true, windowId: t.windowId });
        if (actives[0] && actives[0].id != null && actives[0].id !== tabId) prevId = actives[0].id;
      } catch { /* */ }
      if (t.active !== true) { try { await chrome.tabs.update(tabId, { active: true }); } catch { /* */ } }
      await new Promise((r) => setTimeout(r, 2000));
    } catch { /* */ }
    if (prevId != null) { try { await chrome.tabs.update(prevId, { active: true }); } catch { /* */ } }
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
  async function _acquireSniffedCsrf(tabId, origin, { force = false, wake = false } = {}) {
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
      // v2.74.1759 — soft-wake BEFORE the long poll when idle (don't burn 8s waiting for traffic that won't come).
      if (wake && !tok) {
        try { Logger.info('ride', `INVOKE ▸ csrf soft-wake ${origin}`); } catch { /* */ }
        await _softWakeRideTab(tabId);
        try { await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: _csrfSnifferFunc }); } catch { /* */ }
      }
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

  // v2.74.1760 — background CSRF pre-warm for sniff-class hosts (Shopify): when a tab is ALREADY open and the
  // bank is empty, soft-wake + sniff so the first ask doesn't pay the cold-403. Never opens a tab (§16b).
  const _prewarmAt = new Map();   // host → last attempt ms (throttle misses)
  const PREWARM_GAP_MS = 10 * 60e3;
  async function _prewarmCsrfOpenTabs() {
    const hosts = csrfSniffHosts();
    const summary = [];
    for (const host of hosts) {
      try {
        if (await _bankedCsrf(host)) { summary.push(`${host}:banked`); continue; }
        const last = _prewarmAt.get(host) || 0;
        if (Date.now() - last < PREWARM_GAP_MS) { summary.push(`${host}:throttled`); continue; }
        _prewarmAt.set(host, Date.now());
        const rec = recipeForOrigin(host);
        const patterns = rideTabUrlPatterns(host, (rec && rec.appHost) || host);
        let tabs = [];
        try { tabs = await chrome.tabs.query({ url: patterns }); } catch { tabs = []; }
        const tab = pickRideTab(tabs, { urlParam: (rec && rec.urlParam) || null });
        if (!tab) { summary.push(`${host}:no-tab`); continue; }
        if (typeof ensureContentScript === 'function') {
          try { await ensureContentScript(tab.id); } catch { /* */ }
        }
        const tok = await _acquireSniffedCsrf(tab.id, host, { wake: true });
        summary.push(`${host}:${tok ? 'ok' : 'miss'}`);
      } catch { summary.push(`${host}:err`); }
    }
    if (summary.length) {
      try { Logger.info('conn', `VITALS ▸ csrf prewarm ${summary.join(' · ')}`); } catch { /* */ }
    }
    return { hosts: summary };
  }

  // v2.74.1853 — the causal invalidation the 20-min TTL was approximating: a transition INTO signed-out on a
  // sniff-class host certainly kills its session-bound token, so clear the bank at that moment (and no other) —
  // a fresh sign-in's boot traffic re-banks via the document_start tee + the CSRF_TOKEN_SEEN push. Advisory by
  // VT-4 contract: a subscriber never breaks the write.
  try {
    registerConnTransitionListener((t) => {
      try {
        if (!t || t.to !== 'signed-out') return;
        const host = String(t.origin || '').toLowerCase();
        if (!csrfSniffHosts().includes(host)) return;
        void _clearBankedCsrf(host);
        try { Logger.info('conn', `VITALS ▸ csrf bank cleared — ${host} signed out`); } catch { /* */ }
      } catch { /* VT-4 — never break the transition */ }
    });
  } catch { /* */ }

  return {
    // CP-1/2 (v2.74.1506) — probe ONE origin's auth via its OPEN tab (the heartbeat / Check-now unit). No open tab
    // → honest 'no-tab' (NEVER opens one — no tab churn from a clock; §16b). Two verdict kinds: 'identity'
    // (assessProbe — the §14 anon-sentinel rule) and 'json' (liveness — VendorSuite-class endpoints that 403 when
    // signed out but carry no user shape). The verdict lands in the registry through the single write door.
    CONN_PROBE_ORIGIN: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const origin = String(payload?.origin || '').trim().toLowerCase();
          let probePath = String(payload?.probePath || '').trim();
          // v2.74.1518 — the probe SPEC is CATALOG-owned when the origin has a recipe (the live false-signed-out:
          // a registry entry taught a probePath WITHOUT its probeAccept, so Check-now judged VendorSuite's
          // user-less State JSON with the IDENTITY verdict → anon-sentinel → a false ✖ on a live session). The
          // stored/payload spec remains the fallback for recipe-less origins only.
          const rec = recipeForOrigin(origin);
          if (rec && rec.identityProbe) probePath = String(rec.identityProbe);
          const probeAccept = (rec && rec.probeAccept === 'json') ? 'json' : (payload.probeAccept === 'json' ? 'json' : null);
          const probeHeaders = (rec && rec.requestHeaders && typeof rec.requestHeaders === 'object') ? rec.requestHeaders
            : ((payload.probeHeaders && typeof payload.probeHeaders === 'object') ? payload.probeHeaders : null);
          if (!origin || !probePath) { sendResponse({ success: false, error: 'no-probe-spec' }); return; }
          const tabs = await chrome.tabs.query({ url: [`https://${origin}/*`] });
          const tab = pickRideTab(tabs);
          if (!tab) { sendResponse({ success: false, error: 'no-tab' }); return; }
          const extra = probeHeaders ? { headers: probeHeaders } : null;
          const reply = await fetchViaHealed(tab.id, `https://${origin}${probePath.startsWith('/') ? probePath : '/' + probePath}`, 'GET', null, false, '', extra);
          const verdict = probeAccept === 'json' ? assessLiveness(reply) : assessProbe(reply, null);
          await reportAuthSignal({ origin, status: verdict.status, cause: verdict.reason, source: payload.source === 'heartbeat' ? 'heartbeat' : 'probe',
            identityName: verdict.user ? (verdict.user.name || verdict.user.email || null) : null,
            probePath, probeHeaders, probeAccept });   // the corrected spec self-heals the registry entry
          sendResponse({ success: true, status: verdict.status });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'probe-failed' }); }
      })();
      return true;
    },

    // CX-9o (v2.74.1453) — CLICK_TEXT_ON_TAB: after a section navigation, open ONE item by clicking the most
    // specific visible element containing `text` (an address / task number), climbing to its clickable unit (row /
    // link / button). The SPA has no per-item URL — navigate + click IS "open that specific task". ENGINE-DRIVEN
    // → busy-marked (Invariant #2). Retries ~5s (the list renders after the hash nav). Best-effort by design: a
    // miss reports honestly (the durable upgrade is a TAUGHT drive click, which replaces this generic one).
    'CLICK_TEXT_ON_TAB': (payload, _sender, sendResponse) => {
      (async () => {
        const tabId = payload && payload.tabId;
        const text = String((payload && payload.text) || '').trim();
        if (!Number.isInteger(tabId) || !text) { sendResponse({ success: false, error: 'bad-args' }); return; }
        markEngineBusy(tabId, true);
        try {
          let hit = null;
          for (let i = 0; i < 10 && !hit; i++) {
            let out = null;
            try { out = await chrome.scripting.executeScript({ target: { tabId }, func: _clickTextFunc, args: [text] }); } catch { out = null; }
            const r = out && out[0] && out[0].result;
            if (r && r.clicked) hit = r;
            else await new Promise((res) => setTimeout(res, 500));
          }
          try { Logger.info('connector', `SECTION_NAV ▸ click "${text.slice(0, 40)}" → ${hit ? `${hit.tag}` : 'no-match'} (tab ${tabId})`); } catch { /* */ }
          sendResponse(hit ? { success: true, tag: hit.tag } : { success: false, error: 'text-not-found' });
        } catch (e) {
          sendResponse({ success: false, error: (e && e.message) || 'click-failed' });
        } finally { markEngineBusy(tabId, false); }
      })();
      return true;
    },

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
            // CX-9l (v2.74.1448) — `focusOnly`: a REUSED tab is FOCUSED, never re-navigated (a "go to <known site>"
            // must not blow away the page the user's live tab is on). A fresh tab still opens urls[0] above.
            for (const u of ((payload && payload.focusOnly === true && reused) ? [] : (reused ? urls : urls.slice(1)))) {
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
          // LEG-2a (v2.74.1594) — wanted-vs-banked: the catalog's persisted-op writes for this origin, each marked
          // banked or missing — the checklist that makes the T4 by-hand banking session turnkey.
          const wanted = persistedOpsForHost(origin).map((w) => {
            const b = banked[w.op];
            return { ...w, banked: !!(b && b.sha), sha8: (b && b.sha) ? String(b.sha).slice(0, 8) : null, at: (b && b.at) || 0 };
          });
          sendResponse({ success: true, origin: origin || null, ops, wanted, tab: !!tab });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'ride-ops-failed' }); }
      })();
      return true;
    },

    'INVOKE_SESSION': (payload, _sender, sendResponse) => {
      (async () => {
        let ephemeralOrigin = null;          // set when this ride opened/reused a managed tab (→ idle-close on exit)
        // v2.74.1892 — THE COLD RIDE'S RECEIPT. Six measurements across four passes (10.2 · 10.6 · 11.9 · 9.3 · 6.8 ·
        // 7.7s, mean ~9.4s) sit between `Message: INVOKE_SESSION` and `INVOKE ▸ … → ok` on the FIRST ride after a
        // reload, with NOTHING in the trace for any of it; the second ride of the same session takes 117ms. It is the
        // largest single latency in the product and the only one with no instrument, which is the shape this log keeps
        // learning to distrust — the stage nobody can see absorbs every theory. Candidates are tab discovery, the
        // discarded/frozen revive (a reload + full load wait), the content-script handshake, the CSRF sniff and the
        // identity probe, and the trace distinguishes NONE of them. So: per-stage deltas, one line, and only when the
        // ride was actually slow — a warm read stays silent, and a quiet fan-out cannot flood the ring.
        const _rideT0 = Date.now(); let _rideTPrev = _rideT0; const _rideSpans = [];
        const _mark = (name) => { const now = Date.now(); const d = now - _rideTPrev; _rideTPrev = now; if (d >= 25) _rideSpans.push(`${name}=${d}`); };
        try {
          // §18 arm guard (the observability layer's teeth) — a per-Ground recipe that's disabled / pending / rejected
          // must NOT run. If we know the Ground + recipe and a stored record exists, refuse unless armable. No record
          // (the curated catalog is trusted, or not yet seeded) → fall through to existing behavior. Best-effort.
          if (payload && payload.groundId && payload.recipeId && typeof readRideRecipes === 'function') {
            try {
              const _recs = await readRideRecipes(payload.groundId);
              const _rec = Array.isArray(_recs) ? _recs.find((r) => r && r.id === payload.recipeId) : null;
              if (_rec && !armable(_rec)) { try { Logger.info('ride', `INVOKE ▸ blocked recipe-not-armable [${payload.recipeId}] (${_rec.reviewState})`); } catch { /* */ } sendResponse({ success: false, error: 'recipe-not-armable', hint: _rec.reviewState === 'pending' ? 'accept this recipe in Studio first' : 'this recipe is disabled in Studio' }); return; }
            } catch { /* never block on the guard's own failure */ }
          }
          _mark('arm');
          const args = (payload && typeof payload.args === 'object' && payload.args) || {};
          const method = String((payload && payload.method) || 'GET').toUpperCase();
          // CX-6 — a non-GET is fail-closed behind explicit post-HITL `confirmed:true` (Belt #1). CSRF is page-side (Belt #2).
          // CX-7 — carve-out: a GraphQL READ is a POST whose document is provably read-only (the curated query text is
          // STATIC — params fill only `variables`). Validated here on the template AND re-validated on the final body
          // at the content-script boundary (belt #2) — a mutation document always needs the write gate.
          const isGqlRead = !!(payload && payload.gql === true && method === 'POST' && payload.body && typeof payload.body === 'object' && isReadOnlyGql(payload.body.query));
          const isWrite = (method !== 'GET' && method !== 'HEAD') && !isGqlRead;
          // v2.74.1857 — EVERY early exit names itself (`INVOKE ▸ blocked …`, the family the two narrated exits
          // already used). The lint's first ritual catch (gl 103120, 74 min after Experiment B landed): a
          // dispatch died in one of these bare sendResponses and the trace could not say WHICH — an exit that
          // doesn't say its name is the receipts-stage defect class itself.
          if (isWrite && !(payload && payload.confirmed === true)) { try { Logger.info('ride', `INVOKE ▸ blocked write-needs-confirm [${(payload && payload.recipeId) || '?'}]`); } catch { /* */ } sendResponse({ success: false, error: 'write-needs-confirm' }); return; }

          let origin = fillEndpoint(String((payload && payload.origin) || ''), args).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const appHost = String((payload && payload.appHost) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          // v2.74.1758 — bare host + `*.` wildcard (Chrome's `*.host` misses the bare host; Shopify appHost IS the host).
          const urlPatterns = rideTabUrlPatterns(origin, appHost);
          if (!urlPatterns.length) { try { Logger.info('ride', `INVOKE ▸ blocked session-no-recipe (no url patterns) [${(payload && payload.recipeId) || '?'}]`); } catch { /* */ } sendResponse({ success: false, error: 'session-no-recipe' }); return; }
          const expectedAccount = (payload && payload.account) || null;

          // 1) Prefer an already-open, live, logged-in tab (the user's real context) — §16 default path.
          //    Prefer a tab whose URL already carries urlParam (e.g. /store/<handle>/) over a bare admin root.
          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: urlPatterns }); } catch { tabs = []; }
          let tab = pickRideTab(tabs, { urlParam: (payload && payload.urlParam) || null });
          _mark('tabs');
          let ephemeral = false;

          // 2) Cold start (§16): no open tab → open an ephemeral managed tab — IF we know a concrete origin to open.
          //    appHost-only with no remembered instance can't guess the subdomain → the classic no-tab surface.
          if (!tab) {
            const coldOrigin = origin || _lastOriginByAppHost.get(appHost) || '';
            if (!coldOrigin) { try { Logger.info('ride', `INVOKE ▸ blocked no-authenticated-tab @${appHost || origin} [${(payload && payload.recipeId) || '?'}]`); } catch { /* */ } sendResponse({ success: false, error: 'no-authenticated-tab', host: appHost || origin, hint: `open ${appHost || origin} and sign in` }); return; }
            origin = coldOrigin;
            const got = await _acquireEphemeralTab(origin);
            ephemeralOrigin = origin; ephemeral = true;
            tab = { id: got.tabId };
            if (got.opened) await _waitTabComplete(got.tabId);
          } else if (!origin) {
            try { origin = new URL(tab.url).host; } catch { origin = appHost; }
          }
          _mark(ephemeral ? 'open-tab' : 'pick');
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
          _mark('revive');

          if (typeof ensureContentScript === 'function') {
            const ok = await ensureContentScript(tab.id);
            if (!ok) { try { Logger.info('ride', `INVOKE ▸ blocked no-content-script @${origin} [${(payload && payload.recipeId) || '?'}]`); } catch { /* */ } sendResponse({ success: false, error: 'no-content-script', origin }); return; }
          }
          _mark('content-script');

          // CX-7 — tab-URL params: fill e.g. {handle} from the RIDE TAB's own URL (admin.shopify.com/store/<handle>/…).
          // TRUSTED source (the user's real workspace tab), never the model — a model-supplied value is DELETED first.
          if (payload && payload.urlParam && payload.urlParam.name && payload.urlParam.pattern) {
            delete args[payload.urlParam.name];
            try {
              const t = await chrome.tabs.get(tab.id);
              const m = String((t && t.url) || '').match(new RegExp(payload.urlParam.pattern));
              if (m && m[1]) args[payload.urlParam.name] = m[1];
            } catch { /* */ }
            // LEG-1 (v2.74.1593) — the BANKED fallback: the last tab-derived value, stamped onto the record by the
            // outcome funnel on every successful ride (lastUrlArgs). Same trust class as the tab match (it CAME
            // from a real /store/ tab; the model still never supplies it). This is what lets the ephemeral daily
            // canary run when no /store/… tab exists — the recorded no-canary-skip limitation.
            if (args[payload.urlParam.name] == null && payload.groundId && payload.recipeId && typeof readRideRecipes === 'function') {
              try {
                const list = await readRideRecipes(payload.groundId);
                const rec = Array.isArray(list) ? list.find((r) => r && r.id === payload.recipeId) : null;
                let banked = rec && rec.lastUrlArgs && rec.lastUrlArgs[payload.urlParam.name];
                // v2.74.1851 (live 07-27 17:56: "search shopify for <email>" → needs handle, WITH a Shopify tab
                // open) — the bank was keyed PER-RECIPE, which is chicken-and-egg: a leg cannot bank the handle
                // until it succeeds, and cannot succeed without one. But {handle}/{portalId} is a fact about the
                // ORIGIN (your store slug, your portal), not about one recipe — so fall back to ANY recipe on
                // this Ground that banked the SAME param name. Same trust class throughout: every value in
                // lastUrlArgs came from a real workspace tab, never from the model.
                if ((banked == null || banked === '') && Array.isArray(list)) {
                  const sib = list.find((r) => r && r.lastUrlArgs && r.lastUrlArgs[payload.urlParam.name] != null && r.lastUrlArgs[payload.urlParam.name] !== '');
                  if (sib) { banked = sib.lastUrlArgs[payload.urlParam.name]; try { Logger.info('conn', `RIDE_TAB ▸ {${payload.urlParam.name}} from sibling leg ${sib.id} (no tab match, none banked on ${payload.recipeId})`); } catch { /* */ } }
                }
                if (banked != null && banked !== '') args[payload.urlParam.name] = String(banked);
              } catch { /* */ }
            }
            if (args[payload.urlParam.name] == null) {
              // v2.74.1851 — say WHAT was considered. The old failure was a bare "needs handle" with no record of
              // which tabs were looked at, whether one was DISCARDED (Chrome sleeps unfocused tabs — invisible to
              // the user, who still sees the tab), or whether a URL simply carried no /store/<slug>/ segment.
              try { Logger.info('conn', `RIDE_TAB ▸ {${payload.urlParam.name}} UNRESOLVED · ${tabs.length} candidate tab(s) · ${tabs.filter((t) => t && t.discarded).length} discarded · 0 matched ${payload.urlParam.pattern} · none banked on this Ground`); } catch { /* */ }
              sendResponse({ success: false, error: 'no-url-param', origin, hint: `open your ${appHost || origin} workspace (a /store/… page) so the {${payload.urlParam.name}} can be read from the tab` });
              return;
            }
          }

          // CX-7 — acquire the sniffed CSRF ONCE here (the liveness probe + the main call both ride it), so we don't
          // double-sniff. Cached per-origin inside _acquireSniffedCsrf; null is fine (a gql read may go cookie-only).
          // v2.74.1759 — wake:true soft-wakes an idle admin when nothing is banked yet (pre-warm after reload).
          let csrfTok = null;
          if (payload && payload.csrf === 'sniff') { csrfTok = await _acquireSniffedCsrf(tab.id, origin, { wake: true }); _mark('csrf'); }

          // CX-7c (ADVISORY since v2.74.1389) — the liveness probe NEVER blocks the call. The first cut hard-gated
          // on it and BLOCKED a signed-in user: the probe needs the sniffed CSRF, and a cold/idle admin tab hasn't
          // fired an SPA request yet, so no token is captured → the probe 403s → misread as "signed out". A 403
          // without a token is a CSRF-not-ready problem, not a login one — and Shopify's REAL signed-out signal (an
          // HTML login page → SESSION_FETCH 'non-json' with an honest hint) is already caught by the main call.
          // So we probe only when a token exists, purely to warm the shop cache; the main call is the source of truth.
          if (payload && payload.shopProbe && csrfTok) {
            try { await _probeShopLiveness(tab.id, origin, args[(payload.urlParam && payload.urlParam.name) || 'handle'], csrfTok); } catch { /* advisory — never blocks */ }
            _mark('shop-probe');
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
              try { Logger.info('ride', `INVOKE ▸ blocked op-not-captured (${String(payload.persistedOp)}) @${origin}`); } catch { /* */ }
              sendResponse({ success: false, error: 'op-not-captured', origin, hint: `do one ${String(payload.persistedOp)} by hand in the admin (e.g. create any customer) while this tab stays open — Orchard captures the operation and can replay it from then on` });
              return;
            }
          }

          // 3) Identity verdict (§14/§16) — verify the returned identity; guard the expected account.
          if (payload && payload.verifyIdentity) {
            const probePath = String(payload.identityProbe || '/api/v2/users/me.json');
            const probeUrl = `https://${origin}${probePath.startsWith('/') ? probePath : '/' + probePath}`;
            // CX-10 (v2.74.1459) — the probe carries the recipe's requestHeaders too. An app whose BFF requires a
            // routing header (Aircall's `aircall-platform: aircall-workspace`) returns 401 on the identity endpoint
            // WITHOUT it → assessProbe reads SIGNED_OUT → EVERY read of that app falsely fails "not logged in" even
            // though the session is live (a header-caused anon-sentinel). Null for header-less apps → unchanged.
            const _probeExtra = (payload.requestHeaders && typeof payload.requestHeaders === 'object') ? { headers: payload.requestHeaders } : null;
            const _probeReply = await fetchViaHealed(tab.id, probeUrl, 'GET', null, false, '', _probeExtra);
            const verdict = (payload.probeAccept === 'json') ? assessLiveness(_probeReply) : assessProbe(_probeReply, expectedAccount);   // CP-1 — json-liveness apps verify by parseable JSON
            // v1467 (obs #6) — the probe VERDICT with its cause is visible: "signed-out" alone can't distinguish a
            // real logout from a 401'd bare probe (the v1459 class) or an anon-sentinel (§14). Status token + hdrs
            // flag only — never identity values.
            try { Logger.info('ride', `IDENTITY_PROBE ▸ ${origin} → ${(verdict && verdict.status) || '?'}${_probeExtra ? ' (+hdrs)' : ''}`); } catch { /* */ }
            // CP-1 (v2.74.1506) — every pre-flight verdict feeds the connections registry (single write door).
            void reportAuthSignal({ origin, status: verdict.status, cause: verdict.reason, source: 'probe', identityName: verdict.user ? (verdict.user.name || verdict.user.email || null) : null, probePath, probeHeaders: (payload.requestHeaders && typeof payload.requestHeaders === 'object') ? payload.requestHeaders : null, probeAccept: 'identity' });
            if (rideAction(verdict, { ephemeral }).action === 'reauth-focus') {
              // H-1a (v2.74.1376) — a HEADLESS caller (the scheduled sweep) must NEVER steal the screen or hang
              // waiting for a human: no focus, no wait — fail fast as signed-out. The sweep's status note + `show
              // work` carry the honest reason; the ephemeral tab (if any) idle-closes via the managed registry.
              if (payload && payload.headless === true) {
                // CP-1 — the clock's skip still teaches the registry (Overview explains WHY the sweep skipped).
                void reportAuthSignal({ origin, status: 'signed-out', cause: 'not-logged-in', source: 'ride', probePath, probeAccept: 'identity' });
                try { Logger.info('ride', `INVOKE ▸ blocked not-logged-in (headless) @${origin}`); } catch { /* */ }
                sendResponse({ success: false, error: 'not-logged-in', origin, hint: `sign in to ${origin} to continue` });
                return;
              }
              // Opening inherits auth, can't create it → focus the login/SSO page for the human (§16), then WAIT for
              // sign-in and RESUME — never make them re-ask. A focused tab is now the user's: drop it from the
              // disposable registry so it's never auto-closed.
              if (ephemeralOrigin) { const rec = _managed.get(ephemeralOrigin); _clearTimer(rec); _managed.delete(ephemeralOrigin); ephemeralOrigin = null; }
              await _focusTab(tab.id);
              const resumed = await _waitForReauth({ tabId: tab.id, origin, probe: () => fetchViaHealed(tab.id, probeUrl, 'GET', null, false, '', _probeExtra), expectedAccount });   // CX-10 — reauth poll carries the routing header too
              if (!resumed) {
                const isWrong = verdict.status === STATUS.WRONG_ACCOUNT;
                try { Logger.info('ride', `INVOKE ▸ blocked ${isWrong ? 'wrong-account' : 'not-logged-in'} (reauth declined) @${origin}`); } catch { /* */ }
                sendResponse({ success: false, reauth: true, error: isWrong ? 'wrong-account' : 'not-logged-in', origin,
                  hint: isWrong ? 'signed in as a different account — switch to continue' : `sign in to ${origin} to continue` });
                return;
              }
              // CP-1 — the human signed back in: the registry flips fresh ("back in" is a real transition).
              void reportAuthSignal({ origin, status: 'fresh', source: 'reauth', identityName: resumed.user ? (resumed.user.name || resumed.user.email || null) : null, probePath, probeAccept: 'identity' });
              if (resumed.user && resumed.user.id != null) args.me = resumed.user.id;   // signed in — bind {me}, fall through to the call
            } else if (verdict.user && verdict.user.id != null) {
              args.me = verdict.user.id;
            }
          }

          _mark('identity');
          // 4) Build + run the call (write body filled from args incl. {me}; SESSION_FETCH JSON-encodes + adds CSRF).
          const path = fillEndpoint(String((payload && payload.endpoint) || ''), args);
          if (!path) { try { Logger.info('ride', `INVOKE ▸ blocked session-no-recipe [${(payload && payload.recipeId) || '?'}]`); } catch { /* */ } sendResponse({ success: false, error: 'session-no-recipe' }); return; }
          // v2.74.1433 — a `{param}` STILL in the path after fill = a missing REQUIRED param (the interpret binder left it
          // unbound). NEVER send it: `{taskId}` URL-encodes to %7BtaskId%7D and the app returns http-500. Refuse honestly,
          // naming the param — the same discipline the SESSION_REPLAY twin now enforces (keep both in lockstep).
          { const _miss = path.match(/\{([a-zA-Z_][\w-]*)\}/); if (_miss) { try { Logger.info('ride', `INVOKE ▸ blocked needs-${_miss[1]} (unfilled endpoint param) [${(payload && payload.recipeId) || '?'}]`); } catch { /* */ } sendResponse({ success: false, error: `needs ${_miss[1]}`, hint: _enumHint(payload, _miss[1]) }); return; } }
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
          // a 403 = stale/missing token → clear bank, soft-wake the idle SPA, force re-mint + retry (v1759), then
          // surface honestly with the interact-once hint only if warm still failed.
          let extra = isGqlRead ? { gqlRead: true } : null;
          const _rideHdrs = (payload && payload.requestHeaders && typeof payload.requestHeaders === 'object') ? payload.requestHeaders : null;
          if (_rideHdrs) extra = { ...(extra || {}), headers: { ...((extra && extra.headers) || {}), ..._rideHdrs } };
          if ((isWrite || isGqlRead) && payload && payload.csrf === 'sniff') {
            extra = { ...(extra || {}), headers: { ...((extra && extra.headers) || {}), ...(csrfTok ? { 'x-csrf-token': csrfTok } : {}) } };
          }
          let reply = await fetchViaHealed(tab.id, url, method, body, isWrite, contentType, extra);   // v1340 — the write already passed the confirmed:true gate above; carry it to the content-script belt
          _mark('fetch');
          // v1401 / v1759 — cold `no-csrf` or http-40x with sniff: drop stale bank, soft-wake, force re-mint, retry once.
          // v2.74.1853 — but only when there WAS a token to invalidate: an initial acquire that already woke the
          // tab and sniffed NOTHING makes a second identical wake pointless (same idle SPA, same dry well, ~12s
          // ago — live 201402 spent ~50s/ask rediscovering the 403). Fail fast instead, and say so on the reply
          // (`csrfNoToken`) so the panel skips ITS silent re-invoke too and offers the warm affordance.
          if (reply && reply.success === false && isCsrfColdFailure({ error: reply.error, hint: reply.hint, csrf: payload && payload.csrf })) {
            await _clearBankedCsrf(origin);
            let tok2 = null;
            if (csrfTok) {
              try { Logger.info('ride', `INVOKE ▸ csrf-cold warm → retry [${payload.recipeId || ''}]`); } catch { /* */ }
              tok2 = await _acquireSniffedCsrf(tab.id, origin, { force: true, wake: true });
            } else {
              try { Logger.info('ride', `INVOKE ▸ csrf-cold — sniff dry, fast-fail [${payload.recipeId || ''}] (no second wake)`); } catch { /* */ }
            }
            if (tok2) {
              csrfTok = tok2;
              reply = await fetchViaHealed(tab.id, url, method, body, isWrite, contentType, { ...(extra || {}), headers: { ...((extra && extra.headers) || {}), 'x-csrf-token': tok2 } });
            }
            if (reply && reply.success === false && isCsrfColdFailure({ error: reply.error, hint: reply.hint, csrf: payload && payload.csrf })) {
              reply = { ...reply, csrfNoToken: !tok2, hint: 'no CSRF token yet — use “Warm & retry” below, or click once in the admin tab and re-ask' };
            }
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
          // v2.74.1560 — the INVOKE twin of the SESSION_REPLAY verdict line (live 201357: "what's the homeowner's
          // phone?" ran the curated contacts leg and shaped "not found" — true or not, the trace couldn't say:
          // this channel logged NOTHING between dispatch and shape). Body-blind: status + the value's SHAPE only
          // (array length / object key NAMES — the same discipline as SESSION_REPLAY's `keys:[…]`).
          try {
            const _v = reply && reply.value;
            const _shape = Array.isArray(_v) ? `array[${_v.length}]`
              : (_v && typeof _v === 'object') ? (() => { const l = Object.values(_v).find((x) => Array.isArray(x)); return l ? `list[${l.length}]` : `object{${Object.keys(_v).length}} keys:[${Object.keys(_v).slice(0, 12).join(',')}]`; })()
              : (_v == null ? 'empty' : typeof _v);
            // v2.74.1670 — a per-item call inside a fan-out logs its SUCCESS at debug (dropped by the default
            // INFO floor) and its FAILURE at info, always.
            //
            // `INVOKE ▸` is in `_DECISION_RE`, and one INVOKE per leg call was right when a turn made one call.
            // A 121-division `RIDE_EACH` makes 121, and the live trace shows what that costs: 242 of 246 lines
            // in the decisions view were INVOKE, and the ring evicted the run's own `STEPS ▸` line from the FULL
            // log — the decisions view is worst exactly when a fan-out runs, which is when it is most needed.
            //
            // Invariant #1 says a new marker must be ADDED to `_DECISION_RE` or it is invisible. This is its
            // counterpart, and it had not been written down: a marker that fires PER ITEM must not be in
            // `_DECISION_RE` unsummarized, or it drowns the run it belongs to. The roll-up carries the successes;
            // only the failures need to be individually visible.
            const _ok = !!(reply && reply.success);
            // v2.74.1674 — a quiet SUCCESS is NOT LOGGED AT ALL. The v1670 attempt logged it at debug and was
            // inert, for a reason worth keeping: `background.js:148` calls `Logger.setLevel(LOG_LEVEL.DEBUG)`,
            // so the service worker persists debug lines (266 of them in trace 224332) — and `_isDecisionLine`
            // matches on the MARKER, not the level, so an `INVOKE ▸` at debug still floods the decisions view
            // exactly as it did at info. I had read `#minLevel = INFO` as the default and never checked whether
            // anything overrides it.
            //
            // Dropping the line is safe because the fan-out's roll-up already reports the successes in aggregate
            // (`121 ok, 0 failed, 22 row(s)`), and a FAILURE still logs individually — which is the only part a
            // roll-up cannot express.
            if (!(payload && payload.quiet && _ok)) {
              Logger.info('ride', `INVOKE ▸ ${origin} ${method} [${(payload && payload.recipeId) || '?'}] → ${_ok ? (reply.status || 'ok') : `FAIL ${(reply && reply.error) || 'no-reply'}`} ${_shape}`);
              // v2.74.1872 — the KEYS-ONLY shape of what came back. `object{2}` above says a fetch succeeded and
              // nothing about its structure, which is why "correct fetch, wrong field reaches prose" kept getting
              // diagnosed as a routing bug — the one stage with no instrument absorbs the blame. Paths + leaf TYPES
              // only, never values; PII-shaped keys masked (Core/payloadShape.js). A quiet fan-out skips this whole
              // block, so a 121-division sweep still costs zero lines.
              //
              // v2.74.1887 — KEYED ON THE SHAPE, NOT ON "SEEN", and this is the second time the gate has been the
              // bug rather than the instrument. A boolean per recipe hid the payload exactly when it was wanted:
              // `vs_warranty_stats` had been logged in an earlier SW lifetime, so the two turns whose count
              // contradicted the LIST leg (gl 08:50 — "1 open in Atlanta West" against `array[0]`) each printed
              // nothing, and the contradiction stayed undiagnosable for a third pass. Comparing the LINE also
              // retires the limitation this comment used to state: a recipe whose shape VARIES between calls (empty
              // list vs populated, a nested container that only appears when non-empty) now emits each distinct form
              // once instead of only its first, and says which are re-emissions.
              // v2.74.1888 — TWO CORRECTIONS to that gate, both from its own first live run.
              // (a) The key is the LENGTH-NORMALISED shape (`Core/payloadShape.payloadShapeKey`): array lengths are in
              //     every path, so an empty list and a one-row list looked like different shapes and re-printed.
              // (b) The key and the LABEL carry the ENDPOINT, because a resolve-via read borrows the CONSUMER's
              //     recipeId — live, the `vs_state` access blob printed as `[vs_warranty_tasks]` and then alternated
              //     with the real rows, which alone guaranteed a "changed" every turn. The endpoint's tail is enough
              //     to tell them apart and is a path template, never data.
              // v2.74.1892 — the COLD-RIDE receipt. `SPAN ▸` is the existing shape for "this took a while and here is
              // where it went" (Core/runLedger.js, chat.js's ORCHREQ spans), so no new marker and no `_DECISION_RE`
              // edit. Threshold, not always-on: a warm ride is ~120ms and would say nothing worth a line.
              if (Date.now() - _rideT0 >= 1200) {
                try { Logger.info('ride', `SPAN ▸ RIDE · ${Date.now() - _rideT0}ms · [${(payload && payload.recipeId) || '?'}] ${_rideSpans.join(' · ') || 'no stage over 25ms'}`); } catch { /* */ }
              }
              const _rid = (payload && payload.recipeId) || null;
              if (_ok && _rid) {
                const _ep = String((payload && payload.endpoint) || '');
                const _tail = _ep ? _ep.split('/').filter(Boolean).slice(-2).join('/') : '';
                const _seenKey = `${_rid}|${_ep}`;
                const _shapeKey = payloadShapeKey(reply && reply.value);
                if (_shapeKey && _payloadShapeSeen.get(_seenKey) !== _shapeKey) {
                  const _changed = _payloadShapeSeen.has(_seenKey);
                  _payloadShapeSeen.set(_seenKey, _shapeKey);
                  const _pl = payloadShapeLine(`${_rid}${_tail ? ` …/${_tail}` : ''}`, reply && reply.value);
                  if (_pl) Logger.info('ride', _changed ? `${_pl}  (shape CHANGED for this endpoint)` : _pl);
                }
              }
            }
          } catch { /* observability must never break the call */ }
          // VT-0 (v2.74.1569) — the ONE outcome-funnel call (presence → drift, in order; DESIGN_vitals.md §4).
          // jsonBody: the content-script marks a failed body's JSON-ness (`json`); a rewritten failure
          // (graphql-error / op-hash-stale) carries no http-NNN error → never route-miss evidence. Success is
          // fire-and-forget (pure latency otherwise); a FAILURE awaits the funnel so the response can carry the
          // drift state — RH-1b: the panel renders the "do one by hand and I'll relearn it" bar on it.
          const _evtBase = { transport: 'ride', origin, groundId: (payload && payload.groundId) || null, recipeId: (payload && payload.recipeId) || null,
            csrfInvolved: !!(payload && (payload.gql || payload.csrf)), probePath: (payload && payload.identityProbe) || null, probeAccept: (payload && payload.probeAccept) || null, probeHeaders: (payload && payload.requestHeaders) || null };
          if (reply && reply.success) {
            try { void reportLegOutcome({ ..._evtBase, ok: true, urlArgs: _urlArgs || null }); } catch { /* LEG-1 — the funnel banks lastUrlArgs off successful rides */ }
            sendResponse({ ...reply, origin, urlArgs: _urlArgs });
          } else {
            let _heal = null;
            try { _heal = await reportLegOutcome({ ..._evtBase, ok: false, status: reply && reply.status, error: (reply && reply.error) || '', jsonBody: !!(reply && reply.json === true) }); } catch { /* */ }
            sendResponse({ ...(reply || { success: false, error: 'no-reply' }), ...(_heal && _heal.suspect ? { driftSuspect: true, driftGroundId: (payload && payload.groundId) || null, driftRecipeId: (payload && payload.recipeId) || null } : {}) });
          }
        } catch (e) {
          try { Logger.info('ride', `INVOKE ▸ blocked ${String((e && e.message) || 'invoke-session-failed').slice(0, 80)} (exception)`); } catch { /* */ }
          sendResponse({ success: false, error: (e && e.message) || 'invoke-session-failed' });
        } finally {
          if (ephemeralOrigin) _releaseEphemeralTab(ephemeralOrigin);   // idle-close (a burst reuses first; a re-auth-focused tab was promoted out)
        }
      })();
      return true;   // async — keep the sendResponse channel open
    },

    // v2.74.1853 — the PUSH half of the capture pipeline: the tab tee captures organically while the user works,
    // but pull-only (GET_SNIFFED_CSRF at invoke time) left between-ask tokens solely in the tab, where an
    // extension reload strands them (the isolated world is discarded — the 19:46→20:12 live wedge). The relay
    // now pushes each NEW token; banking on arrival makes any click/browse durable within ms. Sender-validated:
    // accepted only from the tab whose host it claims, and only for csrf-sniff recipe hosts. Token value is
    // never logged (banked/cleared lines carry the host only).
    'CSRF_TOKEN_SEEN': (payload, sender, sendResponse) => {
      (async () => {
        try {
          const host = String((payload && payload.host) || '').toLowerCase();
          const token = (payload && payload.token) ? String(payload.token).slice(0, 400) : '';
          let senderHost = '';
          try { senderHost = new URL((sender && sender.tab && sender.tab.url) || '').host.toLowerCase(); } catch { /* */ }
          if (!host || !token || host !== senderHost || !csrfSniffHosts().includes(host)) { sendResponse({ success: false }); return; }
          const prev = _sniffedCsrf.get(host);
          _sniffedCsrf.set(host, { token, at: Date.now() });
          await _persistCsrf(host, token);
          if (!prev || prev.token !== token) { try { Logger.info('conn', `VITALS ▸ csrf banked ${host} (push)`); } catch { /* */ } }
          sendResponse({ success: true });
        } catch { sendResponse({ success: false }); }
      })();
      return true;
    },

    // v2.74.1853 — the consent affordance behind the panel's “Warm & retry” button: reload the ride tab ON THE
    // USER'S CLICK — a reload is a guaranteed re-capture (the document_start tee catches the SPA's boot traffic;
    // the push above banks it), and user-initiated means no unsaved-work gate is needed. Waits for complete + a
    // short grace so the boot requests actually fire before the caller re-asks.
    'RELOAD_RIDE_TAB': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const host = String((payload && payload.host) || '').toLowerCase();
          if (!host || !csrfSniffHosts().includes(host)) { sendResponse({ success: false, error: 'not-a-sniff-host' }); return; }
          const rec = recipeForOrigin(host);
          const patterns = rideTabUrlPatterns(host, (rec && rec.appHost) || host);
          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: patterns }); } catch { tabs = []; }
          const tab = pickRideTab(tabs, { urlParam: (rec && rec.urlParam) || null });
          if (!tab) { sendResponse({ success: false, error: 'no-tab', hint: `open ${host} first` }); return; }
          try { Logger.info('ride', `INVOKE ▸ csrf warm-reload ${host} (user click)`); } catch { /* */ }
          try { await chrome.tabs.reload(tab.id); } catch { /* */ }
          try { await _waitTabComplete(tab.id); } catch { /* */ }
          await new Promise((r) => setTimeout(r, 1500));
          const tok = await _acquireSniffedCsrf(tab.id, host, {});
          sendResponse({ success: true, warmed: !!tok });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'reload-failed' }); }
      })();
      return true;
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
          // v1467 (obs #3) — the RECIPE ID rides every outcome line: `workspace.aircall.io GET` was ambiguous across
          // 4 REST reads; the id has been in the payload since v1340 and was never printed. Ids only — body-blind.
          const _rid = (payload && payload.recipeId) ? ` [${String(payload.recipeId).slice(0, 40)}]` : '';
          // v2.74.1468 — a READ-ONLY GraphQL document is a READ despite POST (the twin of INVOKE_SESSION's isGqlRead,
          // v1386 — this executor never got it, so a curated roster read was write-gated and its body dropped). The
          // document is re-validated HERE, never trusted from the caller's flag alone: a `mutation` always fails
          // isReadOnlyGql and stays on the write path (confirm-gated, §9 both belts).
          const _bodyObj = (payload && payload.body && typeof payload.body === 'object') ? payload.body
            : ((payload && typeof payload.body === 'string') ? (() => { try { return JSON.parse(payload.body); } catch { return null; } })() : null);
          const isGqlRead = !!(payload && payload.gql === true && method === 'POST' && _bodyObj && isReadOnlyGql(String(_bodyObj.query || '')));
          const isWrite = (method !== 'GET' && method !== 'HEAD') && !isGqlRead;
          // §18 arm guard (v2.74.1340, review A) — SESSION_REPLAY is where HARVESTED recipes execute, so it re-checks
          // armable at run time exactly like INVOKE_SESSION: a recipe disabled / un-accepted / rejected in Studio after
          // projection must not run. Same fall-through semantics: no {groundId, recipeId} or no stored record → proceed.
          if (payload && payload.groundId && payload.recipeId && typeof readRideRecipes === 'function') {
            try {
              const _recs = await readRideRecipes(payload.groundId);
              const _rec = Array.isArray(_recs) ? _recs.find((r) => r && r.id === payload.recipeId) : null;
              if (_rec && !armable(_rec)) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → BLOCKED (recipe ${payload.recipeId} not armable)`); } catch { /* */ } sendResponse({ success: false, error: 'recipe-not-armable', hint: _rec.reviewState === 'pending' ? 'accept this recipe in Studio first' : 'this recipe is disabled in Studio' }); return; }
            } catch { /* never block on the guard's own failure */ }
          }
          // CX-6 (v2.74.1303) — FAIL-CLOSED write gate: a header-replay WRITE fires ONLY with explicit confirmation
          // (the panel's HITL confirm passes confirmed:true). A write can NEVER run unattended or without the user
          // approving THIS exact request — the execution boundary itself refuses it, independent of any caller.
          if (isWrite && !(payload && payload.confirmed === true)) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → BLOCKED (write, not confirmed)`); } catch { /* */ } sendResponse({ success: false, error: 'write-needs-confirm' }); return; }
          const args = { ...((payload && typeof payload.params === 'object' && payload.params) || {}) };
          if (!sessionHost || !apiHost || !(payload && payload.endpoint)) { sendResponse({ success: false, error: 'replay-missing-fields' }); return; }
          let tabs = []; try { tabs = await chrome.tabs.query({ url: `*://${sessionHost}/*` }); } catch { tabs = []; }
          const tab = pickRideTab(tabs);
          if (!tab) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → NO-APP-TAB on ${sessionHost} (open it + arm Forage)`); } catch { /* */ } sendResponse({ success: false, error: 'no-app-tab', hint: `open ${sessionHost} (your logged-in app) and arm Forage` }); return; }
          try { await armRideAuthCapture({ host: sessionHost, tabId: tab.id }); } catch { /* §20 — keep the token fresh for next time (+ in-place arm now); best-effort */ }
          // CX-10 (v2.74.1464) — the recipe's static requestHeaders ride the replay fetch (the v1459 class, this
          // executor: Aircall's BFF 401s a cookie fetch without `aircall-platform` → a false "session-expired").
          const _replayHdrs = (payload && payload.requestHeaders && typeof payload.requestHeaders === 'object') ? payload.requestHeaders : null;
          // v2.74.1471 — the {me} FILL, INVOKE_SESSION parity (live: "am I available?" → "needs me" — this executor
          // had no identity mechanism, and the write body's ID:'{me}' silently DROPPED chat-side → a 200-with-errors
          // "Sent" that never changed anything). When the endpoint or body template mentions {me}: probe the recipe's
          // identityProbe through the SAME auth model as the ride itself (_replayFetchFunc — bearer+cookie+hdrs),
          // extract the user via probedUser (flat + wrapped shapes), refuse anon (§14), bind args.me. Probe fails →
          // fall through; the v1433 unfilled-{param} guard below still refuses honestly.
          const _tmplStr = String((payload && payload.endpoint) || '') + ((payload && payload.bodyTemplate) ? JSON.stringify(payload.bodyTemplate) : '');
          // v2.74.1479 — GraphQL IDENTITY source (the {me}≠agent-id fix, live: UpdateAgent 200-GQL-ERRORS "coerced Null
          // for NonNull ID!"): when {me} is an app-internal AGENT id — NOT the REST user id — and the REST identityProbe
          // 401s while the gql transport works, resolve {me} from a GraphQL identity read. POST the recipe's identityGql
          // doc via the SAME working transport (_replayFetchFunc, bearer+cookie+hdrs), extract the id at idPath. Tried
          // FIRST (it rides the proven transport + returns the right id); the REST probe below stays as the fallback.
          const _ig = payload && payload.identityGql;
          if (args.me == null && _tmplStr.includes('{me}') && _ig && _ig.endpoint && _ig.body && _ig.idPath) {
            try {
              const igUrl = `https://${apiHost}${String(_ig.endpoint).startsWith('/') ? _ig.endpoint : '/' + _ig.endpoint}`;
              const igBody = (typeof _ig.body === 'string') ? _ig.body : JSON.stringify(_ig.body);
              const igOut = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: _replayFetchFunc, args: [igUrl, apiHost, 'POST', igBody, 'application/json', _replayHdrs] });
              const igr = igOut && igOut[0] && igOut[0].result;
              let _igVal = null;
              if (igr && igr.status === 200 && igr.body && typeof igr.body === 'object' && !(Array.isArray(igr.body.errors) && igr.body.errors.length)) {
                _igVal = String(_ig.idPath).split('.').reduce((o, k) => ((o && typeof o === 'object') ? o[k] : undefined), igr.body);
              }
              if (_igVal != null && _igVal !== '') args.me = _igVal;
              try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} {me} identityGql → ${igr ? `${igr.mode || '?'} ${igr.status ?? igr.error ?? '?'}` : 'no-result'}${args.me != null ? ' → filled' : ' → UNFILLED'}`); } catch { /* */ }
            } catch { /* fall through to the REST probe */ }
          }
          if (args.me == null && _tmplStr.includes('{me}') && payload && payload.identityProbe) {
            try {
              const probePath = String(payload.identityProbe);
              const probeUrl = `https://${apiHost}${probePath.startsWith('/') ? probePath : '/' + probePath}`;
              const _tryFill = (reply) => { const u = probedUser(reply); if (u && !isAnonUser(u) && u.id != null) { args.me = u.id; return true; } return false; };
              // v1473 — COOKIE mode first: the identity endpoint is the INVOKE_SESSION probe's home turf (v1459:
              // cookie + the recipe's routing headers — the HAR-proven shape); the captured data-path BEARER can 401
              // it (live 21:45:39: `bearer+cookie+hdrs 401` on current_user while the data reads 200 fine).
              let _pnote = '';
              try {
                const _probeExtra = _replayHdrs ? { headers: _replayHdrs } : null;
                const cookieReply = await fetchViaHealed(tab.id, probeUrl, 'GET', null, false, '', _probeExtra);
                _pnote = `cookie${_replayHdrs ? '+hdrs' : ''} ${(cookieReply && (cookieReply.status ?? cookieReply.error)) ?? '?'}`;
                _tryFill(cookieReply);
              } catch { _pnote = 'cookie exec-fail'; }
              if (args.me == null) {
                // fallback: the ride's own auth model (bearer+cookie) for apps whose identity endpoint IS bearer-auth
                const pOut = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: _replayFetchFunc, args: [probeUrl, apiHost, 'GET', null, '', _replayHdrs] });
                const pr = pOut && pOut[0] && pOut[0].result;
                if (pr && pr.status === 200) _tryFill({ success: true, value: pr.body });
                _pnote += ` · ${pr ? `${pr.mode || '?'}${pr.hdrs ? '+hdrs' : ''} ${pr.status ?? pr.error ?? '?'}` : 'no-result'}`;
              }
              // v1472 — the probe outcome is ALWAYS logged (the v1465 lesson applied to this line's own code).
              try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} {me} probe → ${_pnote}${args.me != null ? ' → filled' : ' → UNFILLED'}`); } catch { /* */ }
            } catch { /* best-effort — the {param} guard below carries the honest refusal */ }
          }
          // v2.74.1471 — the body fills at the EXECUTOR when a template rides (chat sends leg.tool.body verbatim):
          // fillBody after the {me} bind, so ID:'{me}' becomes the real id instead of silently dropping. The legacy
          // pre-filled `body` string stays for callers that still send it; template wins when both are present.
          let reqBody = null;
          if (isWrite || isGqlRead) {
            if (payload && payload.bodyTemplate && typeof payload.bodyTemplate === 'object') {
              const _filled = fillBody(payload.bodyTemplate, args);
              reqBody = _filled != null ? JSON.stringify(_filled) : null;
            } else {
              reqBody = (payload && typeof payload.body === 'string') ? payload.body : ((payload && payload.body != null) ? JSON.stringify(payload.body) : null);   // v1468 — a gql READ carries its document
            }
          }
          const contentType = (isWrite || isGqlRead) ? String((payload && payload.contentType) || '') : '';
          const path = fillEndpoint(String((payload && payload.endpoint) || ''), args);
          if (!path) { try { Logger.info('ride', `SESSION_REPLAY ▸ blocked replay-missing-fields [${(payload && payload.recipeId) || '?'}]`); } catch { /* v2.74.1857 — every exit names itself */ } sendResponse({ success: false, error: 'replay-missing-fields' }); return; }
          // v2.74.1433 — an unfilled `{param}` reaching here is a missing required param; never dispatch it (a literal
          // {taskId} → the app's http-500 "server rejected"). Refuse, naming the param. Twin of the INVOKE_SESSION guard.
          { const _miss = path.match(/\{([a-zA-Z_][\w-]*)\}/); if (_miss) { try { Logger.info('ride', `SESSION_REPLAY ▸ blocked needs-${_miss[1]} (unfilled endpoint param) [${(payload && payload.recipeId) || '?'}]`); } catch { /* */ } sendResponse({ success: false, error: `needs ${_miss[1]}`, hint: _enumHint(payload, _miss[1]) }); return; } }
          { const _bmiss = reqBody && reqBody.match(/\{(me)\}/); if (_bmiss) { sendResponse({ success: false, error: 'needs me', hint: 'could not resolve your identity on this app — open its tab logged-in and retry' }); return; } }
          const url = `https://${apiHost}${path.startsWith('/') ? path : '/' + path}`;
          let out = null;
          try { out = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: _replayFetchFunc, args: [url, apiHost, method, reqBody, contentType, _replayHdrs] }); }
          catch (e) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} exec-failed: ${e && e.message}`); } catch { /* */ } sendResponse({ success: false, error: 'replay-exec-failed' }); return; }
          const r = out && out[0] && out[0].result;
          if (!r) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} no-result (tab_${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: 'replay-no-result' }); return; }
          // v1476 — the diagnostic tokens: leg SOURCE (virtual = catalog-fresh via CX-9r, ground = stored+merged) +
          // payload FINGERPRINT (what the executor actually received) + the WIRE diff (sent vs captured baseline) +
          // the server's statement. NAMES + the app's own message only — the body-blind rule holds (no values, no rows).
          const _src = (payload && payload.groundId) ? 'ground' : 'virtual';
          const _pl = []; if (payload) { if (payload.gql) _pl.push('gql'); if (payload.bodyTemplate) _pl.push('tmpl'); if (payload.requestHeaders) _pl.push('hdrs'); if (payload.identityProbe) _pl.push('probe'); if (payload.confirmed === true) _pl.push('confirmed'); }
          const _ctx = ` src:${_src} pl:[${_pl.join(',')}]`;
          const _refl = r.refreshed === 'cognito' ? '↻' : (r.refreshed === 'store' ? '↑' : '');   // v1480 — ↻ minted from the refresh token, ↑ read from storage
          const _cog = (r.cognitoNote && r.cognitoNote !== 'ok') ? ` refresh:${r.cognitoNote}` : '';
          const _jwt = (r.tokKind && r.tokKind !== 'none') ? ` tok:${r.tokKind}${r.tokExp != null ? `(${r.tokExp}m)` : ''}${_refl}${_cog} stored:${r.storedJwts != null ? r.storedJwts : '?'}` : ((r.refreshed || r.cognitoNote) ? ` tok:none${_refl}${_cog}` : '');   // v1478/1480 — token kind/freshness + refresh mode + Cognito note; unconditional when a bearer was involved
          const _wire = (rr) => { try {
            const sent = Array.isArray(rr.sent) ? rr.sent : []; const cap = Array.isArray(rr.capNames) ? rr.capNames : [];
            const OURS = new Set(['accept', 'content-type']);
            const miss = cap.filter((h) => !sent.includes(h)); const extra = sent.filter((h) => !cap.includes(h) && !OURS.has(h));
            let d = sent.length ? ` sent:[${sent.join(',')}]` : '';
            if (cap.length && miss.length) d += ` miss:[${miss.join(',')}]`;
            if (cap.length && extra.length) d += ` extra:[${extra.join(',')}]`;
            if (rr.srvMsg) d += ` err:"${rr.srvMsg}"`;
            return d;
          } catch { return ''; } };
          // §20 — outcome observability (Invariant #1: `SESSION_REPLAY ▸` is in studio.js _DECISION_RE). Body-SHAPE only (no PII): array length / object-key count, never the rows.
          const _shape = Array.isArray(r.body) ? `array[${r.body.length}]` : (r.body && typeof r.body === 'object' ? `object{${Object.keys(r.body).length}}` : (r.body == null ? 'empty' : typeof r.body));
          // CX-9i (v2.74.1442) — plus the KEY NAMES (an object's, or the first row's): structure, never values — the
          // body-blind discipline holds, but a trace can now answer "what does this endpoint actually return" (the
          // guess-the-shape loop the vendorsuite detail cost three rounds).
          let _keys = '';
          try {
            const _o = Array.isArray(r.body) ? ((r.body[0] && typeof r.body[0] === 'object') ? r.body[0] : null) : ((r.body && typeof r.body === 'object') ? r.body : null);
            if (_o) { const ks = Object.keys(_o); _keys = ` keys:[${ks.slice(0, 30).join(',')}${ks.length > 30 ? `,+${ks.length - 30}` : ''}]`; }
          } catch { /* */ }
          if (r.noAuth) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → NO-AUTH on tab ${tab.id} (looked for "${apiHost}"; captured hosts: [${(r.keys || []).join(', ')}])`); } catch { /* */ } sendResponse({ success: false, error: 'no-session-captured', hint: `arm Forage on ${sessionHost} to capture the session, then retry` }); return; }
          if (r.error) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → fetch-error: ${r.error} (tab_${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: r.error }); return; }
          // v1465 — failure lines carry the attempted AUTH MODE + whether the recipe's requestHeaders were applied
          // (+ the body's key STRUCTURE, already computed above): `cookie+hdrs 401` vs `cookie 401` vs `bearer 401`
          // distinguishes "cookie auth rejected despite the routing header" (needs Bearer / more headers) from "the
          // headers never rode" (a threading gap / stale build) from "captured token rejected" — ONE gc decides.
          // v2.74.1471 — a GraphQL 200 can carry {errors}: HTTP status is NOT the verdict (live: UpdateAgent_Mutation
          // "Sent → 200" with keys:[data,errors] — the mutation FAILED and the render claimed success). Any gql-shaped
          // call with a non-empty errors array is a FAILURE; the first error message rides the hint (panel-only).
          if (r.status < 400 && r.body && typeof r.body === 'object' && Array.isArray(r.body.errors) && r.body.errors.length) {
            const _e0 = r.body.errors[0] || {};
            const _emsg = String(_e0.message || _e0.code || 'GraphQL error').slice(0, 200);
            try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → ${r.mode || '?'}${r.hdrs ? '+hdrs' : ''} ${r.status} GQL-ERRORS${_ctx}${_jwt}${_wire(r)}${_keys} (tab_${tab.id})`); } catch { /* */ }
            sendResponse({ success: false, error: 'gql-error', hint: _emsg, status: r.status, value: r.body }); return;
          }
          if (r.status === 401 || r.status === 403) {
            // v1474 — a bearer 401 is usually a STALE CAPTURE (the tee refreshes only from the SPA's own traffic; an
            // idle tab stops polling — live: the write 401'd at 21:02:10 and the identical dispatch 200'd 34s later).
            // READS retry ONCE after a short wait (a fresh poll may have re-captured); a WRITE is never auto-refired.
            if (!isWrite && !payload.__retried) {
              await new Promise((res) => setTimeout(res, 4000));
              let out2 = null;
              try { out2 = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: _replayFetchFunc, args: [url, apiHost, method, reqBody, contentType, _replayHdrs] }); } catch { /* */ }
              const r2 = out2 && out2[0] && out2[0].result;
              if (r2 && r2.status && r2.status < 400 && !(r2.body && typeof r2.body === 'object' && Array.isArray(r2.body.errors) && r2.body.errors.length)) {
                try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → retry ${r2.mode || '?'}${r2.hdrs ? '+hdrs' : ''} ${r2.status} (was ${r.status}${r.capAge != null ? ` bearer≈${r.capAge}m` : ''}) (tab_${tab.id})`); } catch { /* */ }
                try { void reportLegOutcome({ transport: 'ride', ok: true, origin: sessionHost, groundId: (payload && payload.groundId) || null, recipeId: (payload && payload.recipeId) || null }); } catch { /* VT-0 */ }
                sendResponse({ success: true, value: r2.body, status: r2.status, origin: apiHost }); return;
              }
            }
            try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → ${r.mode || '?'}${r.hdrs ? '+hdrs' : ''}${r.capAge != null ? `(≈${r.capAge}m)` : ''} ${r.status} session-expired${_ctx}${_jwt}${_wire(r)}${_keys} (tab_${tab.id})`); } catch { /* */ }
            // CP-1 (v2.74.1506) — a session-expired outcome is a FREE signed-out signal (the registry + Overview go red).
            void reportAuthSignal({ origin: sessionHost, status: 'signed-out', cause: 'session expired', source: 'ride', probePath: (payload && payload.identityProbe) || null, probeHeaders: (payload && payload.requestHeaders) || null, probeAccept: (payload && payload.probeAccept) || null });
            // v1476 — the hint speaks the SERVER's own reason when it gave one (the token that ends the guessing);
            // else the stale-capture nudge. srvMsg is short + Logger-scrubbed downstream.
            sendResponse({ success: false, error: 'session-expired', reauthOrigin: sessionHost, hint: (r.cognitoNote && r.cognitoNote !== 'ok' && r.cognitoNote !== 'no-cognito-store' && r.cognitoNote !== 'net-fail') ? `your ${sessionHost} login has fully expired — sign in to ${sessionHost} again, then re-ask` : (r.srvMsg ? `the app rejected the request: ${r.srvMsg}` : `refresh the ${sessionHost} tab (its token expired), then re-ask`) }); return;
          }
          if (r.status >= 400) {
            try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → ${r.mode || '?'}${r.hdrs ? '+hdrs' : ''} ${r.status} http-error${_ctx}${_jwt}${_wire(r)}${_keys} (tab_${tab.id})`); } catch { /* */ }
            // VT-0 (v2.74.1569) — the ONE outcome-funnel call subsumes the v1506 auth classification + the v1566
            // drift tick (presence → drift in order; the registry gate refuses drift evidence on a signed-out
            // origin). Awaited so the failure response carries the drift state (RH-1b's relearn bar). A structured
            // (object) body means the app answered; empty/text/HTML means the route missed.
            let _heal = null;
            try { _heal = await reportLegOutcome({ transport: 'ride', ok: false, status: r.status, jsonBody: !!(r.body && typeof r.body === 'object'), csrfInvolved: !!(payload && (payload.gql || payload.csrf)), origin: sessionHost, groundId: (payload && payload.groundId) || null, recipeId: (payload && payload.recipeId) || null, probePath: (payload && payload.identityProbe) || null, probeHeaders: (payload && payload.requestHeaders) || null, probeAccept: (payload && payload.probeAccept) || null }); } catch { /* */ }
            sendResponse({ success: false, error: `http-${r.status}`, ...(_heal && _heal.auth === 'signed-out' ? { reauthOrigin: sessionHost } : {}), hint: r.srvMsg ? `the server said: ${r.srvMsg}` : 'the server rejected the request', status: r.status, value: r.body, ...(_heal && _heal.suspect ? { driftSuspect: true, driftGroundId: (payload && payload.groundId) || null, driftRecipeId: (payload && payload.recipeId) || null } : {}) }); return;
          }
          try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method}${_rid} → ${r.mode ? r.mode + ' ' : ''}${r.status}${_ctx}${_jwt} ${_shape}${_keys} (tab_${tab.id})`); } catch { /* */ }
          // VT-0 (v2.74.1569) — one funnel call: a successful ride is a FREE fresh signal (probe-spec self-heal
          // riding along — VendorSuite's json-liveness probe registers on the first good ride) + the lastOkAt
          // stamp/ratchet-clear (RH-1a) in one door.
          try { void reportLegOutcome({ transport: 'ride', ok: true, origin: sessionHost, groundId: (payload && payload.groundId) || null, recipeId: (payload && payload.recipeId) || null, probePath: (payload && payload.identityProbe) || null, probeHeaders: (payload && payload.requestHeaders) || null, probeAccept: (payload && payload.probeAccept) || null }); } catch { /* */ }
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
          if (recipe && (recipe.verifyIdentity || recipe.identityProbe)) {   // CP-1 — a probe-bearing app (even json-liveness, no verifyIdentity pre-flight) verifies by its probe
            const probePath = String(recipe.identityProbe || '/api/v2/users/me.json');
            // CX-10 (v2.74.1464) — the probe carries the recipe's requestHeaders (the v1459 class, third executor:
            // a routing-header BFF 401s a bare probe → a false "signed-out" on a LIVE login at connect-check time).
            const _vcExtra = (recipe.requestHeaders && typeof recipe.requestHeaders === 'object') ? { headers: recipe.requestHeaders } : null;
            const reply = await fetchViaHealed(tab.id, `https://${origin}${probePath.startsWith('/') ? probePath : '/' + probePath}`, 'GET', null, false, '', _vcExtra);
            const v = (recipe.probeAccept === 'json') ? assessLiveness(reply) : assessProbe(reply, null);   // CP-1 — json-liveness apps (VendorSuite) verify by parseable JSON
            verdict = v.status === STATUS.FRESH ? 'connected' : 'signed-out';
            if (v.user) identity = { id: v.user.id ?? null, name: v.user.name ?? null, email: v.user.email ?? null };
            // CP-1 — connect-time checks feed the registry too (the Overview card is warm from the first setup).
            void reportAuthSignal({ origin, status: v.status, cause: v.reason, source: 'connect', identityName: v.user ? (v.user.name || v.user.email || null) : null, probePath, probeHeaders: (recipe.requestHeaders && typeof recipe.requestHeaders === 'object') ? recipe.requestHeaders : null, probeAccept: recipe.probeAccept === 'json' ? 'json' : 'identity' });
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

    // v2.74.1760 — CSRF_PREWARM: bank sniffed CSRF from already-open sniff-class tabs (Shopify) before the first ask.
    // Called from the vitals tick; never opens a tab. → { success, hosts:['admin.shopify.com:ok', …] }.
    'CSRF_PREWARM': (_payload, _sender, sendResponse) => {
      (async () => {
        try {
          const r = await _prewarmCsrfOpenTabs();
          sendResponse({ success: true, ...(r || {}) });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'prewarm-failed' }); }
      })();
      return true;
    },
  };
}
