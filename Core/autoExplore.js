// Core/autoExplore.js — EX-6a: the PURE brain of the auto-explore orchestrator
// (Win E). No chrome / DOM / storage / LLM — the I/O glue (auto-ground, navigate,
// invoke EXPLORE_PAGE_STRUCTURE) is EX-6b, a thin verify-live handler over these
// two tested decisions. Scope-agnostic: needed whether or not a later slice chains
// into auto-authoring.

import { pagesForAsk } from './siteMap.js';
import { localeTrust } from './locale.js';

/**
 * Decide WHICH page to explore for an ask. When the Ground already has a siteMap,
 * relevance-pick the best archetype (EX-7 pagesForAsk) and explore its concrete
 * exemplar; otherwise fall back to the start URL (a fresh/empty Ground has no map
 * yet — explore where we are). ONE page, no crawl.
 * @param {{ ask?:string, startUrl?:string, siteMap?:{nodes:Object}|null }} [args]
 * @returns {{ exploreUrl:string|null, picked:object|null, reason:string }}
 *   reason ∈ relevance-pick | relevance-pick-no-exemplar | no-relevant-page | no-sitemap | no-target
 */
export function planAutoExplore({ ask = '', startUrl = '', siteMap = null } = {}) {
  const start = String(startUrl || '');
  const nodeCount = siteMap && siteMap.nodes ? Object.keys(siteMap.nodes).length : 0;
  if (ask && nodeCount) {
    const top = pagesForAsk(siteMap, ask, { limit: 1 })[0] || null;
    if (top) {
      const url = top.exemplarUrl || start;
      if (url) return { exploreUrl: url, picked: top, reason: top.exemplarUrl ? 'relevance-pick' : 'relevance-pick-no-exemplar' };
    }
  }
  if (start) return { exploreUrl: start, picked: null, reason: nodeCount ? 'no-relevant-page' : 'no-sitemap' };
  return { exploreUrl: null, picked: null, reason: 'no-target' };
}

/**
 * After EXPLORE_PAGE_STRUCTURE built a Locale, decide what the orchestrator does next,
 * from the PURE trust score (EX-5 localeTrust over coverage + structure.stats):
 *   ready        (trusted)   → author      — the substrate is good enough to build on
 *   partial      (partial)   → author      — usable, but trust.reasons carry the caveats
 *   insufficient (untrusted) → reexplore    — half-explored/aborted/truncated; don't mint junk
 *   failed       (no model)  → abort        — nothing was captured
 * @param {object|null} model      the built Locale
 * @param {object|null} structure  the sweep artifact (stats.aborted etc.)
 * @returns {{ status:'ready'|'partial'|'insufficient'|'failed', action:'author'|'reexplore'|'abort', trust:object }}
 */
export function autoExploreVerdict(model, structure = null) {
  const trust = localeTrust(model, structure);
  if (!model || typeof model !== 'object') return { status: 'failed', action: 'abort', trust };
  if (trust.tier === 'trusted') return { status: 'ready', action: 'author', trust };
  if (trust.tier === 'partial') return { status: 'partial', action: 'author', trust };
  return { status: 'insufficient', action: 'reexplore', trust };
}
