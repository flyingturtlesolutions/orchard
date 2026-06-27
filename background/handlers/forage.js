// background/handlers/forage.js — §19 (DESIGN_connectors.md): FORAGE — the purpose-built recipe-capture crawler.
// READ-ONLY by construction: it drives the app's OWN navigation (read-safe GET URLs only — forageFrontier/readSafe via a
// self-contained a[href] extract) by `chrome.tabs.update`, so each section LOADS with the §17 harvest tee armed → it
// captures the read-API SURFACE that Discovery's breadth (landing reads) and Explore's nav-guarded poke (same-page XHR)
// both miss. Banks `pending` via the §17 bank. Composes — no new capture/generalize/bank: the tee (start/stopHarvestSession)
// · recipeFromHarvest (inside the bank) · waitForTabComplete. State is DISPOSABLE (own throwaway tab, or the caller's).

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { waitForTabComplete } from '../../Services/TabUtils.js';
import { forageFrontier, normForVisit } from '../../Core/forageFrontier.js';
import { startHarvestSession, stopHarvestSession } from './sg.js';

const _forageAbort = new Map();   // groundId → bool (ABORT_FORAGE sets true; checked between visits)
const MAX_VISITS = 24;            // bounded crawl
const DRY_LIMIT = 4;              // K consecutive no-new-url visits → stop (loop-until-dry)

// Self-contained link extractor — runs in the page (ISOLATED is fine: reads a[href] only, NEVER mutates). Serialized by
// executeScript, so no imports/closures. The read-safety + frontier prioritization happen background-side (readSafe).
function _extractLinksFunc() {
  try {
    return [...document.querySelectorAll('a[href]')].slice(0, 500).map((a) => ({
      href: a.href,
      label: (a.textContent || a.getAttribute('aria-label') || a.title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      role: a.getAttribute('role') || '', tag: 'a',
    }));
  } catch (e) { return []; }
}

/**
 * §19 — run a read-safe nav-following harvest crawl on a Ground. Arms the §17 tee, BFS-crawls the app's read-safe nav
 * (sections → a capped sample of filters/pagination/detail), banks the captured reads `pending`. MODULE-LEVEL so the
 * Discovery handler can auto-chain it directly (the decided trigger). existingTabId reuses the caller's tab (Discovery's);
 * null → a throwaway tab. Read-only + consent-gated; never blocks. Returns { ok, visits, banked }.
 */
export async function runForage({ groundId = '', existingTabId = null, readRideRecipes, writeRideRecipes } = {}) {
  groundId = String(groundId || '').trim();
  if (!groundId || typeof readRideRecipes !== 'function' || typeof writeRideRecipes !== 'function') return { ok: false, error: 'groundId + ride store required', visits: 0, banked: 0 };
  if (_forageAbort.get(groundId) != null) return { ok: false, error: 'forage already running', visits: 0, banked: 0 };
  _forageAbort.set(groundId, false);

  let tabId = typeof existingTabId === 'number' ? existingTabId : null;
  let ownTab = false, harvestStarted = false, visits = 0, banked = 0;
  try {
    const g = await StorageManager.getGround(groundId);
    const seedUrl = g && g.url;
    if (!seedUrl) return { ok: false, error: 'no ground url', visits: 0, banked: 0 };
    const host = new URL(seedUrl).host;
    const hr = await startHarvestSession({ groundId, host, appHost: host, origin: host, tabId: tabId == null ? undefined : tabId });
    if (!hr.ok) { Logger.info('background', `FORAGE not armed: ${hr.error} (ground ${groundId})`); return { ok: false, error: hr.error, visits: 0, banked: 0 }; }
    harvestStarted = true;
    if (typeof tabId !== 'number') { const t = await chrome.tabs.create({ url: 'about:blank', active: false }); tabId = t.id; ownTab = true; }   // about:blank first so document_start fires on the FIRST real load

    const visited = new Set();
    const seedNorm = normForVisit(seedUrl, seedUrl);
    const queue = [{ url: seedNorm, label: 'home', class: 'nav' }];
    visited.add(seedNorm);
    let dry = 0;
    while (queue.length && visits < MAX_VISITS && _forageAbort.get(groundId) !== true) {
      const step = queue.shift(); visits++;
      try {
        await chrome.tabs.update(tabId, { url: step.url });
        await waitForTabComplete(tabId, { timeoutMs: 12000 });
        await new Promise((r) => setTimeout(r, 900));   // settle — let the page's read APIs fire + the tee capture
        let links = [];
        try { const out = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: _extractLinksFunc }); links = Array.isArray(out?.[0]?.result) ? out[0].result : []; } catch { /* */ }
        const next = forageFrontier({ links, baseUrl: step.url, visited, max: 12 });
        if (!next.length) dry++; else dry = 0;
        for (const n of next) { if (visits + queue.length < MAX_VISITS) { queue.push(n); visited.add(n.url); } }
        if (dry >= DRY_LIMIT) break;
      } catch (e) { Logger.warn('background', `FORAGE ▸ visit failed (${step.url}): ${e.message}`); }
    }
    Logger.info('ride', `FORAGE ▸ ${visits} read-safe page(s) visited (ground ${groundId})`);
  } catch (err) {
    Logger.error('background', `FORAGE failed: ${err.message}`);
  } finally {
    _forageAbort.delete(groundId);
    if (harvestStarted) {
      try {
        const sr = await stopHarvestSession({ groundId, tabId: typeof tabId === 'number' ? tabId : null, readRideRecipes, writeRideRecipes });
        banked = sr.banked || 0;
        Logger.info('ride', `FORAGE harvest: ${(sr.captures || []).length} capture(s) → banked ${banked} recipe(s) (ground ${groundId})`);
      } catch (e) { Logger.warn('background', `FORAGE bank failed: ${e.message}`); }
    }
    if (ownTab && typeof tabId === 'number') { try { await chrome.tabs.remove(tabId); } catch { /* */ } }
  }
  return { ok: true, visits, banked };
}

/** Request abort of a running forage (checked between visits). */
export function abortForage(groundId) { const id = String(groundId || '').trim(); if (_forageAbort.get(id) != null) { _forageAbort.set(id, true); return true; } return false; }

/**
 * @param {object} ctx  { readRideRecipes, writeRideRecipes }
 */
export function createForageHandlers(ctx) {
  return {
    // §19 — fire-and-forget: returns started:true; the crawl runs in the background + banks pending on completion.
    FORAGE: (payload, _sender, sendResponse) => {
      const groundId = String(payload?.groundId ?? '').trim();
      if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
      sendResponse({ success: true, started: true });
      runForage({ groundId, existingTabId: typeof payload?.existingTabId === 'number' ? payload.existingTabId : null, readRideRecipes: ctx.readRideRecipes, writeRideRecipes: ctx.writeRideRecipes })
        .catch((e) => { try { Logger.warn('background', `FORAGE handler: ${e.message}`); } catch { /* */ } });
    },
    ABORT_FORAGE: (payload, _sender, sendResponse) => {
      const ok = abortForage(payload?.groundId);
      sendResponse(ok ? { success: true } : { success: false, error: 'no active forage' });
    },
  };
}
