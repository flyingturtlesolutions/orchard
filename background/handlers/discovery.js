// background/handlers/discovery.js — CR-X3b (v2.74.952): the DISCOVERY domain, migrated whole from
// the background legacy switch (START_DISCOVERY's sitemap-first bounded crawl + ABORT_DISCOVERY)
// together with its state: the per-ground abort-flag map and the Cloudflare-tolerant in-tab sitemap
// fetcher. Registered beside the SG + explore handlers; dispatch, `.catch` net, and _invokeSgHandler
// apply unchanged. Handler bodies are byte-identical to the legacy cases except the case wrappers
// became handlers (START returns its promise chain) and the two background-local siteMap helpers
// arrive via the asserted ctx seam. The moved fetcher adopts Services/TabUtils.waitForTabComplete
// (CR-D5) instead of background's hand-rolled copy.
//
// Logger tags stay 'background' DELIBERATELY — trace/`gl` continuity.

import { Logger }           from '../../Core/Logger.js';
import * as SiteMap         from '../../Core/siteMap.js';
import { StorageManager }   from '../../Services/StorageManager.js';
import { DiscoveryService } from '../../Services/DiscoveryService.js';
import * as SitemapService  from '../../Services/SitemapService.js';
import { waitForTabComplete } from '../../Services/TabUtils.js';
import { startHarvestSession, stopHarvestSession } from './sg.js';   // §17 (1b) — auto-harvest ride-recipes during the architecture crawl
import { runForage } from './forage.js';   // §19 — auto-chain Forage after Discovery (the decided trigger): drive the read-safe nav to harvest the section/param surface

// v2.74.952 (CR-X3b) — the discovery ctx seam contract, asserted at wiring time.
const REQUIRED_CTX_KEYS = Object.freeze(['readSiteMap', 'mergeSiteMapForGround']);

/** Throw (at SW startup) if the seam object is missing any contract key. */
export function assertDiscoveryCtx(ctx) {
  const missing = REQUIRED_CTX_KEYS.filter((k) => typeof ctx?.[k] !== 'function');
  if (missing.length) throw new Error(`createDiscoveryHandlers: ctx is missing [${missing.join(', ')}]`);
  return ctx;
}

/**
 * Active Discovery abort flags keyed by groundId (Pass 4).
 * Set to true when ABORT_DISCOVERY is received; checked between page visits
 * in DiscoveryService.
 */
const discoveryAbortFlags = new Map();

/**
 * v2.74.455 — Read a site's sitemap from an IN-TAB content-script context. A
 * Cloudflare/WAF-gated sitemap 403s a service-worker fetch even when credentialed (the
 * request lacks a real navigation's fingerprint and the challenge JS can't run in a
 * worker). A tab navigated to the origin auto-solves the managed challenge, after which a
 * content-script fetch is a genuine first-party request (carries cf_clearance + real
 * UA/TLS fingerprint + Sec-Fetch-* headers) and Cloudflare serves the XML. This is the
 * authoritative URL set that powers removal detection (drift §8) — a budgeted crawl can't
 * prove a page is GONE — so it's worth a short-lived tab.
 *
 * Opens a background tab on `origin`, runs SitemapService's same walk (index fan-out,
 * caps, origin filtering, block detection) over a content-script-backed fetcher, and
 * ALWAYS closes the tab. Returns the fetchSitemapUrls result, or null on failure.
 *
 * @param {string} origin
 * @param {() => boolean} [isAborted]
 * @returns {Promise<object|null>}
 */
async function _fetchSitemapViaTab(origin, isAborted = () => false) {
  let tab = null;
  try { tab = await chrome.tabs.create({ url: origin, active: false }); }
  catch (e) { Logger.warn('background', `sitemap in-tab: tab open failed: ${e.message}`); return null; }
  const tabId = tab.id;
  try {
    await waitForTabComplete(tabId, { timeoutMs: 15000 });   // v2.74.952 (CR-X3b) — the D5 shared wait (background's 7th hand-rolled copy stays behind for its other callers)
    // Settle: let Cloudflare's managed challenge auto-solve + reload to the real page.
    await new Promise(r => setTimeout(r, 3000));
    // Poll content-script readiness (re-injected at document_start on each navigation).
    let ready = false;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (isAborted()) return null;
      try {
        const pong = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
        if (pong?.ready || pong?.success) { ready = true; break; }
      } catch { /* not injected yet — retry */ }
      await new Promise(r => setTimeout(r, 400));
    }
    if (!ready) { Logger.warn('background', `sitemap in-tab: content script not ready on ${origin}`); return null; }
    const tabFetch = async (url) => {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'FETCH_URL_TEXT', payload: { url } });
        return { text: res?.ok ? (res.text ?? null) : null, status: res?.status ?? 0 };
      } catch { return { text: null, status: 0 }; }
    };
    return await SitemapService.fetchSitemapUrls(origin, { fetchText: tabFetch });
  } catch (e) {
    Logger.warn('background', `sitemap in-tab fetch failed: ${e.message}`);
    return null;
  } finally {
    try { await chrome.tabs.remove(tabId); } catch { /* best-effort */ }
  }
}

/**
 * @param {object} ctx  background-local helpers: { readSiteMap, mergeSiteMapForGround }
 * @returns {Record<string, (payload:object, sender:object, sendResponse:Function) => (Promise<void>|void)>}
 */
export function createDiscoveryHandlers(ctx) {
  assertDiscoveryCtx(ctx);

  return {
    START_DISCOVERY: (payload, _sender, sendResponse) => {
      return (async () => {
        // v2.74.41 — existingTabId lets the Ground sidepanel run
        // discovery against the user's current tab instead of opening
        // a dedicated background tab.
        const { groundId, existingTabId = null } = payload;
        if (!groundId) { sendResponse({ success: false, error: 'groundId required' }); return; }
        if (discoveryAbortFlags.has(groundId)) {
          sendResponse({ success: false, error: 'Discovery already running for this ground' });
          return;
        }
        discoveryAbortFlags.set(groundId, false);
        Logger.info('background', `START_DISCOVERY — ground ${groundId}${existingTabId != null ? ` (reuse tab ${existingTabId})` : ''}`);

        // Fire-and-forget: broadcast progress and final result; return immediately
        sendResponse({ success: true, started: true });
        (async () => {
          let _harvestStarted = false;   // §17 (1b) — armed below if the ride-recipe store is wired + a durable tab + consent
          try {
            // v2.74.450 — drift (§8 slice 2): snapshot the prior siteMap BEFORE any merge,
            // so we can report what this (re-)discovery changed.
            const prevSiteMap = await ctx.readSiteMap(groundId);
            let sitemapUrls = [];   // v2.74.451 — kept for removal detection (authoritative set)
            let sitemapTruncated = false;   // v2.74.458 — was that set CAPPED (MAX_URLS)? then it's NOT authoritative
            // v2.74.438 — Completeness slice 2b: sitemap.xml is the authoritative page
            // set (the bounded crawl can't reach the whole site). Fetch it FIRST → fold
            // as `stub` archetypes + persist the corpus template rules, so the crawl
            // below templates through the SAME rules and upgrades these stubs in place
            // (stub → discovered). Best-effort; on any failure the crawl runs crawl-only.
            try {
              const g = await StorageManager.getGround(groundId);
              const origin = g?.url ? new URL(g.url).origin : null;
              if (origin && discoveryAbortFlags.get(groundId) !== true) {
                chrome.runtime.sendMessage({ type: 'DISCOVERY_PROGRESS', payload: { groundId, visited: 0, total: 0, currentUrl: 'Reading sitemap.xml…', currentPageType: 'sitemap' } }).catch(() => {});
                let { urls, count, blocked, status, reason, truncated } = await SitemapService.fetchSitemapUrls(origin);
                // v2.74.455 — the SW fetch was blocked by a bot-challenge (Cloudflare 403, or a
                // 200 "Just a moment…" interstitial). Retry over an IN-TAB content-script fetch:
                // a tab on the origin auto-solves the challenge and the content-script fetch rides
                // the user's first-party session, so the sitemap is reachable. This recovers the
                // authoritative URL set — the source of removal detection (drift §8) that the
                // crawl alone can't provide.
                if (blocked && !urls.length && discoveryAbortFlags.get(groundId) !== true) {
                  Logger.info('background', `sitemap[${groundId}] SW fetch BLOCKED (${reason}) — retrying via in-tab fetch…`);
                  chrome.runtime.sendMessage({ type: 'DISCOVERY_PROGRESS', payload: { groundId, visited: 0, total: 0, currentUrl: 'Reading sitemap.xml (in-tab)…', currentPageType: 'sitemap' } }).catch(() => {});
                  const viaTab = await _fetchSitemapViaTab(origin, () => discoveryAbortFlags.get(groundId) === true);
                  if (viaTab && Array.isArray(viaTab.urls) && viaTab.urls.length) {
                    ({ urls, count, blocked, status, reason, truncated } = viaTab);
                    Logger.info('background', `sitemap[${groundId}] in-tab fetch recovered ${count} URL(s)`);
                  } else if (viaTab) {
                    ({ blocked, status, reason } = viaTab);   // still blocked — keep the diagnostic
                  }
                }
                sitemapUrls = Array.isArray(urls) ? urls : [];
                sitemapTruncated = !!truncated;
                if (urls.length) {
                  await ctx.mergeSiteMapForGround(groundId, SiteMap.siteMapFromSitemap(urls));
                  await syncGroundAssetsAfterSave(groundId, { siteMap: true });
                  Logger.info('background', `sitemap seeded ${count} stub archetype URL(s) for ${groundId}`);
                } else if (blocked) {
                  // v2.74.452/455 — a Cloudflare/WAF challenge blocked the sitemap even via the
                  // in-tab fetch: removal detection is unavailable this run (the crawl can't prove
                  // absence). Templating still works — siteMapFromCrawl derives locale/slug rules
                  // from the crawl's own URLs (v453). Surface WHY so it's never a silent degrade.
                  Logger.warn('background', `sitemap[${groundId}] BLOCKED (${reason}) — even in-tab fetch could not reach it; removal detection off, templating from crawl corpus this run`);
                }
              }
            } catch (e) { Logger.warn('background', `sitemap ingestion skipped: ${e.message}`); }

            // v2.74.440 — Architecture crawl (slice 3): seed the crawl from the persisted
            // siteMap — corpus rules (so the crawl groups URLs by archetype) + one exemplar
            // URL per known archetype (so coverage spans the architecture, not just what's
            // link-reachable from the homepage). The crawl visits one representative per
            // archetype, upgrading stubs → discovered.
            let templateRules = [];
            let seedUrls = [];
            try {
              const sm = await ctx.readSiteMap(groundId);
              if (sm) {
                templateRules = sm.templateRules || [];
                seedUrls = sm.nodes ? Object.values(sm.nodes).map((n) => n.exemplarUrl).filter(Boolean) : [];
              }
            } catch (e) { Logger.warn('background', `siteMap seed read failed: ${e.message}`); }

            // §17 (1b, DESIGN_connectors.md) — ARM the body-blind harvest TEE for the crawl. As Discovery navigates each
            // archetype page (ticket/user/org…), the document_start tee records that page's read APIs ({method,url,status}
            // only — never a body); STOP banks them into the Ground's ride-recipe collection (pending, behind the §18 arm
            // guard). Host-scoped + CONSENT-GATED (C6 Track, default-deny). Gated on existingTabId: that's the durable tab
            // we can drain at stop — the dedicated-tab crawl closes its own tab (nothing to drain), so harvest only arms
            // for the reused-tab (Ground panel) path. Best-effort; never blocks discovery.
            if (typeof ctx.readRideRecipes === 'function' && typeof ctx.writeRideRecipes === 'function' && typeof existingTabId === 'number') {
              try {
                const g = await StorageManager.getGround(groundId);
                const host = g?.url ? new URL(g.url).host : '';
                if (host) {
                  const hr = await startHarvestSession({ groundId, host, appHost: host, origin: host, tabId: existingTabId });
                  _harvestStarted = hr.ok;
                  Logger.info(hr.ok ? 'ride' : 'background', hr.ok ? `discovery harvest armed on ${host} (ground ${groundId})` : `discovery harvest not armed: ${hr.error}`);
                }
              } catch (e) { Logger.warn('background', `harvest arm failed (continuing): ${e.message}`); }
            }

            const { pages, error, aborted } = await DiscoveryService.discover({
              groundId,
              existingTabId,
              templateRules,
              seedUrls,
              onProgress: (progress) => {
                chrome.runtime.sendMessage({
                  type: 'DISCOVERY_PROGRESS',
                  payload: { groundId, ...progress },
                }).catch(() => {});
              },
              isAborted: () => discoveryAbortFlags.get(groundId) === true,
            });
            if (error) {
              chrome.runtime.sendMessage({
                type: 'DISCOVERY_FAILED',
                payload: { groundId, error },
              }).catch(() => {});
            } else {
              // v2.74.432 — Ground arc: the multi-page crawl IS the siteMap's breadth
              // source (GROUND_SPEC § 9). Fold every crawled page → a node (with
              // pageType) and every same-site outgoing link → an edge. A later Explore
              // upgrades a page's node to `modeled`. v2.74.434 — the siteMap is now the
              // ONLY persisted structural record (the GroundMap was retired).
              const crawled = pages || [];
              let siteMapStats = null;
              let drift = null;
              try {
                // v2.74.438 — template the crawl through the corpus rules the sitemap
                // ingestion persisted, so crawl nodes align with the stub archetypes.
                const existing = await ctx.readSiteMap(groundId);
                const rules = (existing && existing.templateRules) || [];
                await ctx.mergeSiteMapForGround(groundId, SiteMap.siteMapFromCrawl(crawled, { rules }));
                await syncGroundAssetsAfterSave(groundId, { siteMap: true });
                const sm = await ctx.readSiteMap(groundId);
                siteMapStats = sm ? SiteMap.siteMapStats(sm) : null;
                // v2.74.450 — drift (§8): what changed vs the prior siteMap. The persisted
                // map is cumulative (merge is additive), so the diff gives `added` (NEW
                // archetypes) + `statusChanged` (upgrades, e.g. stub→discovered).
                // v2.74.451 — `removed` is computed separately against the AUTHORITATIVE
                // current sitemap URL set (a prior archetype absent from it is gone) —
                // only when a sitemap was found, since a budgeted crawl alone can't prove
                // absence. Report-only (no pruning yet).
                // v2.74.458 — …AND only when that set is COMPLETE. A truncated sitemap (capped
                // at MAX_URLS — pixabay returns 5000 of millions) is just a window, not the full
                // page set, so a prior stub's absence from it does NOT prove removal — it may
                // simply have fallen outside the cap (or the window shifted, e.g. pixabay's
                // dynamic search-keyword sitemap). Computing `removed` against a partial set
                // false-positives en masse, so suppress it when truncated.
                let removalSkipped = false;
                if (sm) {
                  try {
                    const d = SiteMap.diffSiteMap(prevSiteMap, sm).counts;
                    let removed = 0;
                    if (sitemapUrls.length && !sitemapTruncated && prevSiteMap?.nodes) {
                      const r2 = sm.templateRules || rules || [];
                      const runIds = new Set(sitemapUrls.map((u) => { try { return SiteMap.archetypeId(SiteMap.templatePattern(u, r2)); } catch { return null; } }));
                      // Only `stub` nodes are sitemap-ONLY (never crawled/modeled): a stub that
                      // vanished from the current sitemap is a confident removal. Crawl-discovered
                      // / Explore-modeled nodes legitimately live outside the sitemap (homepage,
                      // link-only pages) — judging them by sitemap membership false-positives.
                      removed = Object.values(prevSiteMap.nodes).filter((n) => n.status === 'stub' && !runIds.has(n.id)).length;
                    } else if (sitemapUrls.length && sitemapTruncated && prevSiteMap?.nodes) {
                      removalSkipped = true;   // had a sitemap + prior map, but the set was capped
                    }
                    drift = { ...d, removed, removalSkipped };
                  } catch { /* */ }
                }
              } catch (e) { Logger.warn('background', `siteMap from crawl failed (continuing): ${e.message}`); }
              if (drift) Logger.info('explore', `discovery drift[${groundId}]: +${drift.added} new · ${drift.statusChanged} status-changed · ${drift.removalSkipped ? 'removal n/a (sitemap truncated)' : `${drift.removed || 0} removed`} · ${drift.unchanged} unchanged`);
              chrome.runtime.sendMessage({
                type: 'DISCOVERY_COMPLETE',
                payload: { groundId, pageCount: crawled.length, siteMapStats, drift, aborted: !!aborted },
              }).catch(() => {});
            }
          } catch (err) {
            Logger.error('background', `Discovery unhandled: ${err.message}`);
            chrome.runtime.sendMessage({
              type: 'DISCOVERY_FAILED',
              payload: { groundId, error: err.message },
            }).catch(() => {});
          } finally {
            discoveryAbortFlags.delete(groundId);
            // §17 (1b) — STOP the harvest on EVERY crawl exit (complete / error / abort): unregister the tee, drain the
            // reused tab's accumulated captures, and bank them (generalize → polish → mergeRecipes, landing pending).
            if (_harvestStarted) {
              try {
                const sr = await stopHarvestSession({ groundId, tabId: existingTabId, readRideRecipes: ctx.readRideRecipes, writeRideRecipes: ctx.writeRideRecipes });
                Logger.info('ride', `discovery harvest: ${(sr.captures || []).length} capture(s) → banked ${sr.banked || 0} recipe(s) (ground ${groundId})`);
              } catch (e) { Logger.warn('background', `harvest stop/bank failed: ${e.message}`); }
            }
            // §19 — AUTO-CHAIN Forage (the decided trigger): Discovery built the frontier + banked landing-reads; Forage
            // now drives the read-safe nav to harvest the authenticated section/param surface Discovery's breadth missed.
            // Fire-and-forget (it arms its OWN harvest session, sequenced after the stop above). Pass existingTabId as the
            // SESSION tab: Forage drives CLIENT-SIDE nav INSIDE that live logged-in tab (clicks read-safe in-app links, no
            // reload → the in-memory auth token survives → authenticated reads captured), restoring the route after
            // (v2.74.1283). Gated on a real tab: no logged-in tab → nothing to ride → skip. Read-only + consent-gated inside.
            if (typeof ctx.readRideRecipes === 'function' && typeof ctx.writeRideRecipes === 'function' && typeof existingTabId === 'number') {
              runForage({ groundId, sessionTabId: existingTabId, readRideRecipes: ctx.readRideRecipes, writeRideRecipes: ctx.writeRideRecipes })
                .then((r) => { try { Logger.info('ride', `discovery→forage: ${r.visits || 0} page(s) → banked ${r.banked || 0} (ground ${groundId})`); } catch { /* */ } })
                .catch((e) => { try { Logger.warn('background', `discovery→forage failed: ${e.message}`); } catch { /* */ } });
            }
          }
        })();
      })();
    },

    ABORT_DISCOVERY: (payload, _sender, sendResponse) => {
      const { groundId: abortId } = payload;
      if (discoveryAbortFlags.has(abortId)) {
        discoveryAbortFlags.set(abortId, true);
        Logger.info('background', `Discovery abort requested for ground ${abortId}`);
        sendResponse({ success: true });
      } else {
        sendResponse({ success: false, error: 'No active discovery for this ground' });
      }
    },
  };
}
