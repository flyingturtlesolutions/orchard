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

import { fillEndpoint, fillBody } from '../../Core/connectorRecipes.js';
import { pickRideTab, assessProbe, rideAction, STATUS } from '../../Core/connection.js';

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

export function createConnectorHandlers({ ensureContentScript } = {}) {
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
  };
}
