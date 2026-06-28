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

import { fillEndpoint, fillBody, recipeForOrigin } from '../../Core/connectorRecipes.js';
import { pickRideTab, assessProbe, rideAction, STATUS, classifyReachProbe } from '../../Core/connection.js';
import { armable } from '../../Core/rideRecipe.js';   // §18 — the arm guard: a non-armable (disabled / pending / rejected) per-Ground recipe must not run
import { Logger } from '../../Core/Logger.js';   // §20 — SESSION_REPLAY outcome observability (Invariant #1)

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
function _replayFetchFunc(url, apiHost, method) {
  return (async function () {
    try {
      var store = window.__ahub_ride_auth || {};
      var cap = store[apiHost] || null;
      if (!cap || !cap.headers || !cap.headers.authorization) return { noAuth: true, keys: Object.keys(store) };   // keys → diagnose a host-key mismatch vs an empty global
      var headers = { accept: 'application/json' };
      for (var k in cap.headers) { if (Object.prototype.hasOwnProperty.call(cap.headers, k)) headers[k] = cap.headers[k]; }
      var res = await fetch(url, { method: method || 'GET', headers: headers, credentials: 'omit' });   // §20 — Bearer HEADER auth, not cookies; 'include' imposes credentialed-CORS the header-auth API rejects (Failed to fetch)
      var status = res.status, body = null;
      try { body = await res.json(); } catch (e) { try { body = await res.text(); } catch (e2) { body = null; } }
      return { status: status, body: body };
    } catch (e) { return { error: String((e && e.message) || e) }; }
  })();
}

export function createConnectorHandlers({ ensureContentScript, readRideRecipes } = {}) {
  const fetchVia = (tabId, url, method, body) =>
    chrome.tabs.sendMessage(tabId, { type: 'SESSION_FETCH', payload: { url, method, body } }, { frameId: 0 });
  // The TOP-FRAME content script can be orphaned (an extension reload kills it; the all-frames PING can read a live
  // SUBframe as "live" while frame 0 is dead). On a frame-0 connection error, force-reinject + retry once.
  const fetchViaHealed = async (tabId, url, method, body) => {
    try { return await fetchVia(tabId, url, method, body); }
    catch (e) {
      if (!/Receiving end does not exist|Could not establish connection/i.test((e && e.message) || '')) throw e;
      try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['ContentScripts/contentScript.js'] }); } catch { /* */ }
      await new Promise((r) => setTimeout(r, 300));
      return await fetchVia(tabId, url, method, body);
    }
  };

  return {
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
          const isWrite = method !== 'GET' && method !== 'HEAD';
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

          if (typeof ensureContentScript === 'function') {
            const ok = await ensureContentScript(tab.id);
            if (!ok) { sendResponse({ success: false, error: 'no-content-script', origin }); return; }
          }

          // 3) Identity verdict (§14/§16) — verify the returned identity; guard the expected account.
          if (payload && payload.verifyIdentity) {
            const probePath = String(payload.identityProbe || '/api/v2/users/me.json');
            const probeUrl = `https://${origin}${probePath.startsWith('/') ? probePath : '/' + probePath}`;
            const verdict = assessProbe(await fetchViaHealed(tab.id, probeUrl, 'GET'), expectedAccount);
            if (rideAction(verdict, { ephemeral }).action === 'reauth-focus') {
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
          const body = isWrite ? fillBody(payload && payload.body, args) : undefined;
          const reply = await fetchViaHealed(tab.id, url, method, body);
          sendResponse(reply && reply.success ? { ...reply, origin } : (reply || { success: false, error: 'no-reply' }));
        } catch (e) {
          sendResponse({ success: false, error: (e && e.message) || 'invoke-session-failed' });
        } finally {
          if (ephemeralOrigin) _releaseEphemeralTab(ephemeralOrigin);   // idle-close (a burst reuses first; a re-auth-focused tab was promoted out)
        }
      })();
      return true;   // async — keep the sendResponse channel open
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
          if (method !== 'GET' && method !== 'HEAD') { sendResponse({ success: false, error: 'replay-reads-only' }); return; }   // §9 — header-replay reads only for now
          const args = (payload && typeof payload.params === 'object' && payload.params) || {};
          const path = fillEndpoint(String((payload && payload.endpoint) || ''), args);
          if (!sessionHost || !apiHost || !path) { sendResponse({ success: false, error: 'replay-missing-fields' }); return; }
          const url = `https://${apiHost}${path.startsWith('/') ? path : '/' + path}`;
          let tabs = []; try { tabs = await chrome.tabs.query({ url: `*://${sessionHost}/*` }); } catch { tabs = []; }
          const tab = pickRideTab(tabs);
          if (!tab) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → NO-APP-TAB on ${sessionHost} (open it + arm Forage)`); } catch { /* */ } sendResponse({ success: false, error: 'no-app-tab', hint: `open ${sessionHost} (your logged-in app) and arm Forage` }); return; }
          let out = null;
          try { out = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: _replayFetchFunc, args: [url, apiHost, method] }); }
          catch (e) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} exec-failed: ${e && e.message}`); } catch { /* */ } sendResponse({ success: false, error: 'replay-exec-failed' }); return; }
          const r = out && out[0] && out[0].result;
          if (!r) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} no-result (tab ${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: 'replay-no-result' }); return; }
          // §20 — outcome observability (Invariant #1: `SESSION_REPLAY ▸` is in studio.js _DECISION_RE). Body-SHAPE only (no PII): array length / object-key count, never the rows.
          const _shape = Array.isArray(r.body) ? `array[${r.body.length}]` : (r.body && typeof r.body === 'object' ? `object{${Object.keys(r.body).length}}` : (r.body == null ? 'empty' : typeof r.body));
          if (r.noAuth) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → NO-AUTH on tab ${tab.id} (looked for "${apiHost}"; captured hosts: [${(r.keys || []).join(', ')}])`); } catch { /* */ } sendResponse({ success: false, error: 'no-session-captured', hint: `arm Forage on ${sessionHost} to capture the session, then retry` }); return; }
          if (r.error) { try { Logger.warn('background', `SESSION_REPLAY ▸ ${apiHost} ${method} → fetch-error: ${r.error} (tab ${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: r.error }); return; }
          if (r.status === 401 || r.status === 403) { try { Logger.info('ride', `SESSION_REPLAY ▸ ${apiHost} ${method} → ${r.status} session-expired (tab ${tab.id})`); } catch { /* */ } sendResponse({ success: false, error: 'session-expired', hint: `re-arm Forage on ${sessionHost} to refresh the session` }); return; }
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
            verdict = classifyReachProbe({ finalUrl: url });
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
