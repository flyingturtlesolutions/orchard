// background/handlers/forage.js — §19 (DESIGN_connectors.md): FORAGE — the purpose-built recipe-capture crawler.
// READ-ONLY by construction. RIDES THE LOGGED-IN SESSION the only way that actually works for a modern SPA: it drives
// CLIENT-SIDE navigation INSIDE the user's LIVE logged-in tab. Many apps (e.g. the Deako CS tool, a static S3 SPA) hold
// their auth token IN MEMORY — so a fresh tab, a duplicated tab, OR a hard `tabs.update` reload all boot ANONYMOUS (cookies
// transfer, but sessionStorage/in-memory auth don't survive a fresh document). The fix (v2.74.1283): inject a driver into
// the live tab that CLICKS read-safe in-app <a href> nav links → the SPA router changes route WITHOUT a reload → the app
// fetches each route with the in-memory token still held in that tab → the §17 tee (MAIN world, injected on the live tab)
// captures those AUTHENTICATED reads. No new tab, no duplicate, no hard load. Banks `pending` via the §17 bank. Composes —
// the tee (start/stopHarvestSession) · recipeFromHarvest (inside the bank). NOTE: the URL-frontier path (Core/readSafe.js +
// Core/forageFrontier.js, a background hard-nav crawl) is PARKED for a future cookie-auth MPA mode — it can't ride
// in-memory auth, which is why this live-tab client-side driver replaced it.

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { startHarvestSession, stopHarvestSession } from './sg.js';

const _forageAbort = new Map();   // groundId → bool (concurrency guard; ABORT_FORAGE sets true)
const MAX_VISITS = 16;            // bounded client-side crawl (kept short so the awaited executeScript stays inside the SW idle window)

// THE CLIENT-SIDE NAV DRIVER — injected into the user's LIVE logged-in tab (ISOLATED world via executeScript). Self-contained
// (serialized → no imports/closures). It CLICKS read-safe in-app <a href> links so the SPA router navigates CLIENT-SIDE (no
// page reload → the in-memory auth token survives → the app fetches each route AUTHENTICATED, and the tee captures it).
// READ-ONLY by construction: it clicks ONLY same-origin <a href> whose label is neither destructive nor a write verb, and
// whose path isn't an auth/destructive route — never buttons/divs (those could be actions), never target=_blank, never
// off-site. Inlines the EX-1 / Core/readSafe.js lexicons (a self-contained injected func can't import them). Async →
// executeScript awaits the whole bounded crawl. Restores the start route CLIENT-SIDE (history.go) — NEVER a hard nav, which
// would reboot the SPA and DROP the in-memory token (i.e. log the user out).
async function _forageSpaDriverFunc(maxVisits) {
  const DESTRUCTIVE = /\b(delete|deactivate|destroy|unsubscribe|publish|withdraw|log\s?out|sign\s?out|logout)\b|\b(empty|clear)\s+(cart|basket)\b|\b(cancel|close|delete|deactivate|remove)\s+(account|order|subscription|plan|membership|payment|profile)\b|\b(place|confirm)\s+(order|payment|purchase)\b|\b(buy|checkout|pay|bid)\b/i;
  const WRITE = /\b(submit|save|send|post|reply|comment|upload|create|edit|update|confirm|apply|sign\s?up|register|subscribe|follow|favou?rite|add\s+to|remove|report|flag|share|invite|message|delete)\b/i;
  const DESTRUCTIVE_PATH = /(?:^|\/)(logout|log-?out|signout|sign-?out|checkout|deactivate|unsubscribe)(?:\/|$)/i;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const keyOf = (u) => { try { const x = new URL(u, location.href); return x.pathname + x.search; } catch { return null; } };
  const readSafe = (a) => {
    try {
      if (a.target === '_blank') return false;
      const href = a.getAttribute('href') || '';
      if (!href || /^(javascript:|mailto:|tel:|#|data:|blob:)/i.test(href)) return false;
      if (new URL(a.href).origin !== location.origin) return false;            // same-origin only
      const label = (a.textContent || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim();
      if (DESTRUCTIVE.test(label) || WRITE.test(label)) return false;          // EX-1 + write veto on the label
      if (DESTRUCTIVE_PATH.test(keyOf(a.href) || '')) return false;            // …and on the path (icon-only logout/checkout)
      return true;
    } catch { return false; }
  };
  const startUrl = location.href;
  const visited = new Set([keyOf(location.href)]);
  let visits = 0, hops = 0;
  // BFS-ish over the LIVE DOM: each route renders its own nav, so re-enumerate every step and click the next unvisited
  // read-safe link. Bounded by maxVisits. A client-side route change keeps the document (and the in-memory token) alive.
  while (visits < maxVisits) {
    let next = null;
    for (const a of document.querySelectorAll('a[href]')) {
      const k = keyOf(a.href);
      if (k && !visited.has(k) && readSafe(a)) { next = a; visited.add(k); break; }
    }
    if (!next) break;
    visits++;
    try { next.click(); hops++; } catch { /* */ }
    await sleep(1100);   // settle — let the SPA fetch + render the new route (the tee records the fetches)
  }
  // Restore the user's view CLIENT-SIDE (history back the number of hops). NEVER location.assign/reload — that reboots the
  // SPA and drops the in-memory token. Best-effort; on overshoot the user lands on an app route, still logged in.
  try { if (hops > 0 && location.href !== startUrl) { history.go(-hops); await sleep(300); } } catch { /* */ }
  return { visits, startUrl, endUrl: location.href };
}

/**
 * §19 — harvest a Ground's AUTHENTICATED read surface by driving CLIENT-SIDE nav in the user's LIVE logged-in tab.
 * MODULE-LEVEL so the Discovery handler can auto-chain it. `sessionTabId` = the user's logged-in tab (REQUIRED — it is the
 * only context holding the in-memory auth token). Arms the §17 tee ON that tab (executeScript inject; the page is already
 * loaded), runs the in-tab client-side click-crawl, banks the captured reads `pending`. Read-only + consent-gated; never
 * navigates away with a hard load (that would log the user out). Returns { ok, visits, banked }.
 */
export async function runForage({ groundId = '', sessionTabId = null, readRideRecipes, writeRideRecipes } = {}) {
  groundId = String(groundId || '').trim();
  if (!groundId || typeof readRideRecipes !== 'function' || typeof writeRideRecipes !== 'function') return { ok: false, error: 'groundId + ride store required', visits: 0, banked: 0 };
  if (typeof sessionTabId !== 'number') return { ok: false, error: 'no logged-in tab to ride (sessionTabId required)', visits: 0, banked: 0 };
  if (_forageAbort.get(groundId) != null) return { ok: false, error: 'forage already running', visits: 0, banked: 0 };
  _forageAbort.set(groundId, false);

  const tabId = sessionTabId;
  let harvestStarted = false, visits = 0, banked = 0;
  try {
    const g = await StorageManager.getGround(groundId);
    let host = '';
    try { host = new URL((await chrome.tabs.get(tabId))?.url || (g && g.url) || '').host; } catch { /* */ }
    if (!host && g && g.url) { try { host = new URL(g.url).host; } catch { /* */ } }
    if (!host) return { ok: false, error: 'no host', visits: 0, banked: 0 };
    // Arm the tee ON the live tab (startHarvestSession injects on the already-loaded document). Client-side nav keeps that
    // same document, so the MAIN-world tee persists across the whole crawl and accumulates every authenticated fetch.
    const hr = await startHarvestSession({ groundId, host, appHost: host, origin: host, tabId });
    if (!hr.ok) { Logger.info('background', `FORAGE not armed: ${hr.error} (ground ${groundId})`); return { ok: false, error: hr.error, visits: 0, banked: 0 }; }
    harvestStarted = true;
    // Drive CLIENT-SIDE nav in the LIVE logged-in tab — the only context with the in-memory auth token.
    try {
      const out = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: _forageSpaDriverFunc, args: [MAX_VISITS] });
      visits = out?.[0]?.result?.visits || 0;
    } catch (e) { Logger.warn('background', `FORAGE ▸ client-side drive failed: ${e.message}`); }
    Logger.info('ride', `FORAGE ▸ ${visits} client-side route(s) crawled on the logged-in tab (ground ${groundId})`);
  } catch (err) {
    Logger.error('background', `FORAGE failed: ${err.message}`);
  } finally {
    _forageAbort.delete(groundId);
    if (harvestStarted) {
      try {
        const sr = await stopHarvestSession({ groundId, tabId, readRideRecipes, writeRideRecipes });
        banked = sr.banked || 0;
        Logger.info('ride', `FORAGE harvest: ${(sr.captures || []).length} capture(s) → banked ${banked} recipe(s) (ground ${groundId})`);
      } catch (e) { Logger.warn('background', `FORAGE bank failed: ${e.message}`); }
    }
    // Tell the Ground panel the crawl finished so it can re-render the Ride card with the newly-banked recipes (mirrors
    // DISCOVERY_COMPLETE). Best-effort; the manual trigger toasts on it, the Discovery auto-chain just silently refreshes.
    try { chrome.runtime.sendMessage({ type: 'FORAGE_COMPLETE', payload: { groundId, visits, banked } }).catch(() => { /* no listener */ }); } catch { /* */ }
  }
  return { ok: true, visits, banked };
}

/** Request abort of a running forage (the concurrency guard; the in-tab crawl is short and self-terminating). */
export function abortForage(groundId) { const id = String(groundId || '').trim(); if (_forageAbort.get(id) != null) { _forageAbort.set(id, true); return true; } return false; }

/**
 * @param {object} ctx  { readRideRecipes, writeRideRecipes }
 */
export function createForageHandlers(ctx) {
  return {
    // §19 — fire-and-forget: returns started:true; the in-tab crawl runs + banks pending on completion (FORAGE_COMPLETE).
    FORAGE: (payload, _sender, sendResponse) => {
      const groundId = String(payload?.groundId ?? '').trim();
      if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
      const sessionTabId = typeof payload?.sessionTabId === 'number' ? payload.sessionTabId : null;
      if (sessionTabId == null) { sendResponse({ success: false, error: 'no logged-in tab — open the app tab and try again' }); return; }
      sendResponse({ success: true, started: true });
      // sessionTabId = the user's LIVE logged-in tab to ride (the panel passes its active tab); it is where the crawl runs.
      runForage({ groundId, sessionTabId, readRideRecipes: ctx.readRideRecipes, writeRideRecipes: ctx.writeRideRecipes })
        .catch((e) => { try { Logger.warn('background', `FORAGE handler: ${e.message}`); } catch { /* */ } });
    },
    ABORT_FORAGE: (payload, _sender, sendResponse) => {
      const ok = abortForage(payload?.groundId);
      sendResponse(ok ? { success: true } : { success: false, error: 'no active forage' });
    },
  };
}
