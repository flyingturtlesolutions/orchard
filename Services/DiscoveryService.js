/**
 * @file Services/DiscoveryService.js
 * @description Read-only crawler that feeds the Ground siteMap — structural
 * knowledge of a Ground. Visits the seed URL, classifies the page via
 * AnthropicService.classifyPage, follows same-origin outgoing links to
 * configurable depth, and records form fields along the way. Returns the
 * crawled `pages` array; the caller folds it into the siteMap
 * (GROUND_SPEC § 7) via SiteMap.siteMapFromCrawl. (v2.74.434 — the legacy
 * persisted GroundMap was retired; the siteMap subsumes it.)
 *
 * Safety invariants:
 *   1. NEVER fires CLICK, TYPE, SELECT, or SUBMIT.
 *   2. Navigation is performed via chrome.tabs.update — page loads only.
 *   3. Same-origin only. External links are recorded but not followed.
 *   4. Dangerous link text ("delete", "sign out", etc.) is skipped.
 *   5. Depth and page-count caps prevent runaway crawls.
 *
 * @module Services/DiscoveryService
 * @author Agent HUB
 */

import { Logger }           from '../Core/Logger.js';
import { waitForTabComplete } from './TabUtils.js';   // v2.74.944 (CR-D5)
import { StorageManager }   from './StorageManager.js';
import { AnthropicService } from './AnthropicService.js';
import { templatePattern }  from '../Core/siteMap.js';   // v2.74.440 — archetype-driven crawl

// ── Configuration ────────────────────────────────────────────────────────────

/** Max depth of the crawl from the seed URL (0 = seed only, 1 = seed + its links, …). */
const DEFAULT_MAX_DEPTH = 2;

/** Hard safety cap on total pages visited per Discovery run (archetype budget is the
 *  effective limit; this just bounds pathological cases). v2.74.440 raised 20→60. */
const DEFAULT_MAX_PAGES = 60;

/** v2.74.440 — Primary budget: distinct page ARCHETYPES to confirm/classify per run.
 *  The crawl visits ONE representative per template (sitemap stubs collapse instances),
 *  so coverage is measured in archetypes, not raw pages. Tunable. */
const DEFAULT_MAX_ARCHETYPES = 40;

/** Milliseconds to wait after navigation before capturing a DOM snapshot. */
const NAV_SETTLE_MS = 2000;

/** Timeout for the DOM-ready signal per page. */
const PAGE_READY_TIMEOUT_MS = 12000;

/** Link text substrings that disqualify a link from being followed. */
const DANGEROUS_LINK_TEXT = [
  'delete', 'remove', 'cancel', 'sign out', 'log out', 'logout',
  'unsubscribe', 'destroy', 'reset',
];

// ── DiscoveryService class ───────────────────────────────────────────────────

export class DiscoveryService {

  /**
   * Run a Discovery pass on a Ground. Opens a dedicated tab, crawls from the
   * Ground's URL, and returns the crawled `pages` for the caller to fold into
   * the siteMap (the legacy persisted GroundMap was retired in v2.74.434).
   *
   * @param {Object} options
   * @param {string} options.groundId
   * @param {Function} [options.onProgress] - Called with { visited, total, currentUrl, currentPageType }
   * @param {Function} [options.isAborted]  - Returns true if the user cancelled
   * @param {number}  [options.maxDepth=2]
   * @param {number}  [options.maxPages=20]
   * @returns {Promise<{ pages: Array, error: string|null, aborted?: boolean }>}
   *          `pages` = crawled page records ({ url, title, pageType, formFields,
   *          outgoing, visitedAt }); the caller folds them into the siteMap.
   */
  static async discover({
    groundId,
    onProgress = () => {},
    isAborted  = () => false,
    maxDepth   = DEFAULT_MAX_DEPTH,
    maxPages   = DEFAULT_MAX_PAGES,
    // v2.74.41 — Optional existing tab to crawl with (sidepanel-launched
    // discovery). When provided, the tab is reused (navigated to seedUrl)
    // and NOT closed at the end. When null, the original behavior runs:
    // open a fresh background tab and close it on completion.
    existingTabId = null,
    // v2.74.440 — Architecture crawl (slice 3). `templateRules` (corpus rules from
    // sitemap ingestion) let the crawl group URLs by ARCHETYPE; `seedUrls` (sitemap
    // stub exemplars, one per archetype) seed the frontier so coverage spans the real
    // architecture — not just what's link-reachable from the homepage within maxDepth.
    // The crawl then visits ONE representative per archetype, budgeted by maxArchetypes.
    templateRules = [],
    seedUrls      = [],
    maxArchetypes = DEFAULT_MAX_ARCHETYPES,
  }) {
    if (!groundId) {
      return { pages: [], error: 'groundId required' };
    }

    const ground = await StorageManager.getGround(groundId);
    if (!ground?.url) {
      return { pages: [], error: `Ground ${groundId} has no URL` };
    }

    const seedUrl = ground.url;
    let seedOrigin;
    try { seedOrigin = new URL(seedUrl).origin; }
    catch { return { pages: [], error: `Invalid seed URL: ${seedUrl}` }; }

    // v2.74.440 — archetype key for a URL (corpus rules collapse instances → one template).
    const archetypeOf = (u) => { try { return templatePattern(u, templateRules); } catch { return String(u || ''); } };

    Logger.info('DiscoveryService', `Starting discovery — ${seedUrl} (depth ${maxDepth}, ≤${maxArchetypes} archetypes, ${seedUrls.length} sitemap seed(s))${existingTabId != null ? ` reusing tab ${existingTabId}` : ''}`);

    let tabId = null;
    let openedNewTab = false;
    let aborted = false;
    let lastNavUrl = seedUrl;   // v2.74.440 — tab starts at the seed (created/navigated below)
    const pages = [];
    const visited = new Set();             // URLs we've already dequeued
    const visitedArchetypes = new Set();   // v2.74.440 — one representative visited per archetype
    // Seed the frontier with the live tab's seed URL, then the sitemap stub exemplars
    // (one concrete URL per known archetype) so the crawl confirms the whole architecture.
    const queue   = [{ url: seedUrl, depth: 0 }];
    for (const u of seedUrls) {
      if (u && u !== seedUrl && DiscoveryService.#sameOrigin(u, seedOrigin)) queue.push({ url: u, depth: 0 });
    }

    try {
      if (existingTabId != null) {
        // Reuse the user's current tab. Navigate it to the seed URL so
        // the first loop iteration runs against the right page (the
        // loop skips navigation for the first item assuming the tab is
        // already there — mirrors the chrome.tabs.create case below).
        tabId = existingTabId;
        await DiscoveryService.#navigate(tabId, seedUrl);
      } else {
        // Open a dedicated tab for the crawl
        const tab = await chrome.tabs.create({ url: seedUrl, active: false });
        tabId = tab.id;
        openedNewTab = true;
      }

      while (queue.length > 0 && pages.length < maxPages && visitedArchetypes.size < maxArchetypes) {
        if (isAborted()) {
          Logger.info('DiscoveryService', 'Discovery aborted by user');
          aborted = true;
          break;
        }

        const { url, depth } = queue.shift();
        if (visited.has(url)) continue;
        visited.add(url);

        // v2.74.440 — one representative per archetype: if we've already classified a
        // page of this template, skip its siblings (the siteMap node is the same node).
        const arch = archetypeOf(url);
        if (visitedArchetypes.has(arch)) continue;

        onProgress({
          visited         : pages.length,
          total           : maxArchetypes,
          currentUrl      : url,
          currentPageType : null,
        });

        try {
          // Navigate only when the tab isn't already at this URL. v2.74.440 — keyed on
          // the tab's actual location (not pages.length): with sitemap exemplars seeded,
          // a failed seed must NOT make the next page skip navigation.
          if (url !== lastNavUrl) {
            await DiscoveryService.#navigate(tabId, url);
            lastNavUrl = url;
          }
          await DiscoveryService.#waitForPageReady(tabId);
          await DiscoveryService.#sleep(NAV_SETTLE_MS);

          // Capture DOM + title
          const snapshot = await DiscoveryService.#captureSnapshot(tabId);
          if (!snapshot) {
            Logger.warn('DiscoveryService', `No snapshot captured for ${url}`);
            continue;
          }

          // Classify via Claude — pageType + formFields are judgment tasks the
          // LLM is good at. Link extraction is NOT: it's a deterministic DOM
          // task (see #extractLinks below), so we no longer use
          // classification.outgoingLinks for the crawl/siteMap.
          const classification = await AnthropicService.classifyPage({
            url,
            title       : snapshot.title,
            domSnapshot : snapshot.dom,
          });
          if (!classification) {
            Logger.warn('DiscoveryService', `Classification failed for ${url}`);
            continue;
          }

          // v2.74.433 — Deterministic outgoing-link extraction (every <a href>,
          // resolved + deduped) from the live DOM. This is the source of both the
          // BFS frontier and the siteMap edges — replacing the LLM's unreliable,
          // over-restrictive (no nav/footer, max 8) outgoingLinks that produced
          // empty siteMaps. Falls back to the classifier's links if the content
          // script call fails.
          let outgoing = await DiscoveryService.#extractLinks(tabId);
          if (!outgoing || outgoing.length === 0) {
            outgoing = Array.isArray(classification.outgoingLinks) ? classification.outgoingLinks : [];
          }

          const pageRecord = {
            url,
            title         : classification.title,
            pageType      : classification.pageType,
            formFields    : classification.formFields,
            outgoing,
            visitedAt     : Date.now(),
          };
          pages.push(pageRecord);
          visitedArchetypes.add(arch);   // v2.74.440 — this archetype is now confirmed

          onProgress({
            visited         : visitedArchetypes.size,
            total           : maxArchetypes,
            currentUrl      : url,
            currentPageType : classification.pageType,
          });

          // Enqueue follow-up links (same-origin, safe). Skip links whose archetype is
          // already confirmed — the siteMap node exists, no need to visit a sibling.
          if (depth < maxDepth) {
            for (const link of outgoing) {
              const nextUrl = DiscoveryService.#canonicalize(link.href, url);
              if (!nextUrl) continue;
              if (visited.has(nextUrl))                               continue;
              if (!DiscoveryService.#sameOrigin(nextUrl, seedOrigin)) continue;
              if (DiscoveryService.#isDangerousLink(link))            continue;
              if (visitedArchetypes.has(archetypeOf(nextUrl)))        continue;
              queue.push({ url: nextUrl, depth: depth + 1 });
            }
          }
        } catch (err) {
          Logger.warn('DiscoveryService', `Error at ${url}: ${err.message}`);
          // Continue to next page — one bad page shouldn't abort the crawl
        }
      }

      // v2.74.434 — No persisted GroundMap anymore: the siteMap (built by the
      // caller from `pages` via SiteMap.siteMapFromCrawl) is the canonical
      // structural record. We just hand back the crawled pages.
      Logger.info('DiscoveryService', `Discovery ${aborted ? 'aborted' : 'complete'} — crawled ${pages.length} page(s)`);

      // v2.74.41 — Site-level summary. Asks Claude for a brand name,
      // aliases, and a 1-2 sentence description based on the crawled
      // sample. Used by the Ground sidepanel to auto-fill empty
      // name/aliases fields and to populate the description shown in
      // the Ground header card. Best-effort: if the summary call
      // fails or returns null, the existing Ground record is left as
      // it was.
      if (!aborted && pages.length > 0) {
        try {
          const summary = await AnthropicService.summarizeSite({
            domain: new URL(seedUrl).hostname,
            pages,
          });
          if (summary) {
            const groundNow = await StorageManager.getGround(groundId);
            if (groundNow) {
              // Don't clobber a name or aliases the user explicitly
              // entered; only fill when those are empty.
              const hasUserName    = typeof groundNow.name === 'string' && groundNow.name.trim().length > 0;
              const hasUserAliases = Array.isArray(groundNow.aliases) && groundNow.aliases.length > 0;
              await StorageManager.saveGround({
                ...groundNow,
                name        : hasUserName    ? groundNow.name    : (summary.name || groundNow.name || ''),
                aliases     : hasUserAliases ? groundNow.aliases : (summary.aliases ?? []),
                description : summary.description || groundNow.description || '',
                updatedAt   : Date.now(),
              });
              Logger.info('DiscoveryService', `Site summary saved — name="${summary.name}" aliases=${summary.aliases?.length ?? 0}`);
            }
          }
        } catch (e) {
          Logger.warn('DiscoveryService', `summarizeSite step failed: ${e.message}`);
        }
      }

      return { pages, error: null, aborted };

    } catch (err) {
      Logger.error('DiscoveryService', `Discovery failed: ${err.message}`);
      return { pages: [], error: err.message };
    } finally {
      // v2.74.41 — Only close the tab if WE opened it. When the caller
      // supplied an existingTabId, the user is actively using that tab
      // and we leave it where the crawl ended (the Ground sidepanel
      // refresh handles the UI side).
      if (openedNewTab && tabId !== null) {
        try { await chrome.tabs.remove(tabId); }
        catch (e) { Logger.warn('DiscoveryService', `Could not close tab: ${e.message}`); }
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Navigate a tab to a URL, waiting for the 'complete' status. */
  static async #navigate(tabId, url) {
    await chrome.tabs.update(tabId, { url });
    // v2.74.944 (CR-D5) — via TabUtils (one waiter); this caller's contract: REJECT on not-complete.
    // Also GAINS the already-complete poll the inline copy was missing (a cached/instant load could
    // complete before the listener attached and burn the full timeout).
    const r = await waitForTabComplete(tabId, { timeoutMs: PAGE_READY_TIMEOUT_MS });
    if (!r.ok) throw new Error('navigation timeout');
  }

  /** Wait for content script readiness by polling a simple DOM query. */
  static async #waitForPageReady(tabId) {
    const deadline = Date.now() + PAGE_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'CHECK_ELEM', payload: { selector: 'body' } });
        if (res?.found) return;
      } catch {
        // Content script may not be injected yet — retry
      }
      await DiscoveryService.#sleep(300);
    }
  }

  /** Capture a DOM snapshot + title from the tab. */
  static async #captureSnapshot(tabId) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'DOM_SNAPSHOT_RICH' });
      if (!res?.success) return null;
      return {
        title : res.title    ?? '',
        dom   : res.snapshot ?? '',
        url   : res.url      ?? '',
      };
    } catch (e) {
      Logger.warn('DiscoveryService', `Snapshot failed: ${e.message}`);
      return null;
    }
  }

  /**
   * v2.74.433 — Deterministic outgoing-link extraction. Asks the content script
   * to walk every <a href> (shadow-DOM aware), resolve to absolute http(s), and
   * dedupe. Returns [{href,text}]. This is the reliable source of the crawl
   * frontier + siteMap edges, replacing the LLM classifier's link guesses.
   */
  static async #extractLinks(tabId) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_LINKS' });
      if (!res?.success || !Array.isArray(res.links)) return [];
      return res.links;
    } catch (e) {
      Logger.warn('DiscoveryService', `Link extraction failed: ${e.message}`);
      return [];
    }
  }

  /** Canonicalize an outgoing link's href against a base URL. Returns null on failure. */
  static #canonicalize(href, baseUrl) {
    if (!href || typeof href !== 'string') return null;
    const h = href.trim();
    if (!h) return null;
    if (h.startsWith('javascript:')) return null;
    if (h.startsWith('#')) return null;                     // same-page anchor
    if (h.startsWith('mailto:') || h.startsWith('tel:')) return null;
    try {
      const u = new URL(h, baseUrl);
      // Strip hash and trailing slash variations — treat /x and /x/ as same
      u.hash = '';
      return u.toString();
    } catch {
      return null;
    }
  }

  /** Check if a URL is on the same origin as the seed. */
  static #sameOrigin(url, seedOrigin) {
    try { return new URL(url).origin === seedOrigin; }
    catch { return false; }
  }

  /** Check if a link's text looks like an action (not an exploration target). */
  static #isDangerousLink(link) {
    const haystack = `${link.text ?? ''} ${link.href ?? ''}`.toLowerCase();
    return DANGEROUS_LINK_TEXT.some(word => haystack.includes(word));
  }

  static #sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}
