// Core/forageFrontier.js — §19 Forage: the read-safe nav frontier. PURE. From a page's enumerated links (+ the
// Ground.chrome nav), produce the PRIORITIZED, deduped, read-safe list of URLs the Forage driver should visit next —
// nav SECTIONS first (breadth), then a bounded SAMPLE of filters / pagination / detail (depth + the generalizer's
// param fuel). The driver calls this per page to expand its bounded crawl. No chrome / DOM / LLM.

import { classifyAffordance } from './readSafe.js';

const _CLASS_RANK = { nav: 0, filter: 1, paginate: 2, detail: 3 };   // sections first; one-rep detail last

/** Canonicalize a URL for visited-dedup: drop the hash, sort the query, resolve relative. PURE. */
export function normForVisit(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl);
    u.hash = '';
    const ps = [...u.searchParams.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)));
    u.search = '';
    for (const [k, v] of ps) u.searchParams.append(k, v);
    return u.href;
  } catch { return String(href || '').trim(); }
}

/**
 * Expand the read-safe frontier. PURE. Returns ordered [{ url, label, class }] of NEW read-safe URLs.
 * @param {{ links?:Array<{label?:string,href?:string,role?:string,tag?:string}>, chromeNav?:Array<{label?:string,href?:string}>,
 *           baseUrl?:string, visited?:Set<string>, max?:number, perClassCap?:object }} input
 * Per-class caps (default filter 6 · paginate 3 · detail 3; nav unlimited) keep ONE page-expansion from drowning the
 * crawl in detail links — a sample of each class is enough for recipeFromHarvest to template `{param}`/`{id}`.
 */
export function forageFrontier({ links = [], chromeNav = [], baseUrl = '', visited = new Set(), max = 24, perClassCap = {} } = {}) {
  const out = [];
  const seen = new Set(visited);
  const counts = { nav: 0, filter: 0, paginate: 0, detail: 0 };
  const caps = { nav: Infinity, filter: 6, paginate: 3, detail: 3, ...perClassCap };
  const consider = (aff, srcRank) => {
    const c = classifyAffordance(aff, baseUrl);
    if (!c.safe || c.class === 'search') return;   // a search box needs typing — not a URL to visit (a later slice)
    if ((counts[c.class] ?? 0) >= (caps[c.class] ?? 3)) return;
    const url = normForVisit(aff.href, baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url); counts[c.class] = (counts[c.class] ?? 0) + 1;
    out.push({ url, label: String(aff.label || '').trim().slice(0, 80), class: c.class, _rank: (_CLASS_RANK[c.class] ?? 5) + srcRank });
  };
  for (const n of (Array.isArray(chromeNav) ? chromeNav : [])) consider({ label: n && n.label, href: n && n.href }, 0);   // chrome nav = top priority (the app's own sections)
  for (const l of (Array.isArray(links) ? links : [])) consider(l, 0.5);
  out.sort((a, b) => a._rank - b._rank);
  return out.slice(0, Math.max(0, max | 0)).map(({ url, label, class: cls }) => ({ url, label, class: cls }));
}
