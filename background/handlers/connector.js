// background/handlers/connector.js — the connector domain (DESIGN_connectors.md §7, §13–14). CX-3/CX-4a.
//
// INVOKE_SESSION (session-ride): the user's existing browser login IS the credential. A login cookie only rides a
// SAME-ORIGIN request from the app's own page, so we never fetch here — we locate the open, logged-in tab on the
// recipe's origin (or derive it from the open *.appHost tab — the tab you're in IS the connection), ensure its
// content script is live, and have it do the fetch (SESSION_FETCH). Read-only; URL built from a VETTED recipe.
//
// Identity probe (CS Tools lesson, §14): a logged-out session returns HTTP 200 + an anonymous sentinel, so a list
// read would look like "0 results". When a recipe sets verifyIdentity we probe first, verify the RETURNED identity
// (never the status), and reuse the probed user id for {me} ("my X" recipes). Writes are refused (CX-6 gates them).

import { fillEndpoint } from '../../Core/connectorRecipes.js';

export function createConnectorHandlers({ ensureContentScript } = {}) {
  const fetchVia = (tabId, url, method, body) =>
    chrome.tabs.sendMessage(tabId, { type: 'SESSION_FETCH', payload: { url, method, body } }, { frameId: 0 });

  return {
    'INVOKE_SESSION': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const args = (payload && typeof payload.args === 'object' && payload.args) || {};
          const method = String((payload && payload.method) || 'GET').toUpperCase();
          // CX-6 — writes are allowed but EXECUTOR-GATED: a non-GET requires explicit `confirmed:true` (the panel sets
          // it only AFTER the HITL confirm — CX-6b). The CSRF token is read page-side in SESSION_FETCH. Belt #1.
          const isWrite = method !== 'GET' && method !== 'HEAD';
          if (isWrite && !(payload && payload.confirmed === true)) { sendResponse({ success: false, error: 'write-needs-confirm' }); return; }

          // Resolve a live, logged-in tab: an explicit origin (templated from args), or the open *.appHost tab.
          let origin = fillEndpoint(String((payload && payload.origin) || ''), args).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const appHost = String((payload && payload.appHost) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const queryHost = origin || (appHost ? `*.${appHost}` : '');
          if (!queryHost) { sendResponse({ success: false, error: 'session-no-recipe' }); return; }

          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: `*://${queryHost}/*` }); } catch { tabs = []; }
          // Disambiguate multiple open instances (another Zendesk, a second login): prefer an active tab, then the
          // most-recently-used — "the connection the user is actually looking at" (§13/CX-7).
          const live = (Array.isArray(tabs) ? tabs : []).filter((t) => t && t.id != null && !t.discarded);
          live.sort((a, b) => (Number(b.active === true) - Number(a.active === true)) || ((b.lastAccessed || 0) - (a.lastAccessed || 0)));
          const tab = live[0] || null;
          if (!tab) { sendResponse({ success: false, error: 'no-authenticated-tab', host: appHost || origin, hint: `open ${appHost || origin} and sign in` }); return; }
          if (!origin) { try { origin = new URL(tab.url).host; } catch { origin = appHost; } }

          if (typeof ensureContentScript === 'function') {
            const ok = await ensureContentScript(tab.id);
            if (!ok) { sendResponse({ success: false, error: 'no-content-script', origin }); return; }
          }

          // Identity probe — verify identity, not status; reuse the probed id for {me}. (Zendesk-shaped sentinel
          // check today; a per-app probe/check is the generalization.)
          if (payload && payload.verifyIdentity) {
            const probePath = String(payload.identityProbe || '/api/v2/users/me.json');
            const me = await fetchVia(tab.id, `https://${origin}${probePath.startsWith('/') ? probePath : '/' + probePath}`, 'GET');
            const u = me && me.success && me.value && me.value.user;
            const anon = !u || u.id === -1 || u.id == null || u.email === 'invalid@example.com';
            if (anon) { sendResponse({ success: false, error: 'not-logged-in', origin, hint: `open https://${origin} and sign in` }); return; }
            if (u.id != null) args.me = u.id;
          }

          const path = fillEndpoint(String((payload && payload.endpoint) || ''), args);
          if (!path) { sendResponse({ success: false, error: 'session-no-recipe' }); return; }
          const url = `https://${origin}${path.startsWith('/') ? path : '/' + path}`;
          const reply = await fetchVia(tab.id, url, method, payload && payload.body);
          sendResponse(reply && reply.success ? { ...reply, origin } : (reply || { success: false, error: 'no-reply' }));   // origin → ticket-url synthesis
        } catch (e) {
          sendResponse({ success: false, error: (e && e.message) || 'invoke-session-failed' });
        }
      })();
      return true;   // async — keep the sendResponse channel open
    },
  };
}
