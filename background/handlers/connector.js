// background/handlers/connector.js — the connector domain (DESIGN_connectors.md §7). CX-3 (+heal/headers v2.74.1152).
//
// INVOKE_SESSION (session-ride): the user's existing browser login IS the credential. A login cookie only rides a
// SAME-ORIGIN request from the app's own page — a cross-site fetch from the service worker drops SameSite cookies —
// so we never fetch here. We locate an open, logged-in tab on the recipe's origin, ensure its content script is live
// (auto-inject if the extension was just reloaded), and have ITS content script (SESSION_FETCH) do the fetch from the
// page origin. Read-only: the URL is built here from a VETTED recipe (origin + endpoint templated from the bound
// args), so untrusted page content never shapes the request; writes are refused (CX-6 gates them behind CSRF +
// confirm). INVOKE_CONNECTOR (the cloud/MCP broker) is CX-5 — not built here.
//
// PROVEN LIVE (v2.74.1151): Zendesk /api/v2/tickets/{id}.json returned the ticket JSON riding the user's session.

import { fillEndpoint } from '../../Core/connectorRecipes.js';

export function createConnectorHandlers({ ensureContentScript } = {}) {
  return {
    'INVOKE_SESSION': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const args = (payload && typeof payload.args === 'object' && payload.args) || {};
          const origin = fillEndpoint(String((payload && payload.origin) || ''), args)
            .replace(/^https?:\/\//i, '').replace(/\/+$/, '');
          const path = fillEndpoint(String((payload && payload.endpoint) || ''), args);
          const method = String((payload && payload.method) || 'GET').toUpperCase();
          if (!origin || !path) { sendResponse({ success: false, error: 'session-no-recipe' }); return; }
          if (method !== 'GET') { sendResponse({ success: false, error: 'session-write-not-built' }); return; }   // CX-6
          const url = `https://${origin}${path.startsWith('/') ? path : '/' + path}`;

          // Find an open, non-discarded tab on this origin (the cookies live there). An invalid pattern (e.g. an
          // unfilled {subdomain}) throws → treated as no tab.
          let tabs = [];
          try { tabs = await chrome.tabs.query({ url: `*://${origin}/*` }); } catch { tabs = []; }
          const tab = (Array.isArray(tabs) ? tabs : []).find((t) => t && t.id != null && !t.discarded) || null;
          if (!tab) { sendResponse({ success: false, error: 'no-authenticated-tab', origin }); return; }

          // Ensure the content script is live (cheap PING; auto-injects if the extension was just reloaded or the tab
          // predates it) so the user never has to manually reload the page. Mirrors the SG REPLAY stale-port recovery.
          if (typeof ensureContentScript === 'function') {
            const ok = await ensureContentScript(tab.id);
            if (!ok) { sendResponse({ success: false, error: 'no-content-script', origin }); return; }
          }

          const reply = await chrome.tabs.sendMessage(
            tab.id,
            { type: 'SESSION_FETCH', payload: { url, method, headers: (payload && payload.headers) || null } },
            { frameId: 0 },
          );
          sendResponse(reply || { success: false, error: 'no-reply' });
        } catch (e) {
          sendResponse({ success: false, error: (e && e.message) || 'invoke-session-failed' });
        }
      })();
      return true;   // async — keep the sendResponse channel open
    },
  };
}
