// Core/groundCatalog.js — T3X-1: the GLOBAL Ground catalog + ground resolution (intent → which site). PURE.
//
// T3 (cross-Ground) comprehension's FIRST step is choosing the Ground(s) a sub-intent runs on — the analog, one
// tier up, of choosing a Feature within a Locale. This module builds a catalog over ALL Grounds and ranks them
// against a sub-intent by lexical overlap of {host name, name, aliases, description, capability goal labels}.
// It is the cross-Ground funnel step-0 (DESIGN_comprehension_split.md §4 delta a; DESIGN_t3_cross_ground.md §5).
//
// The lexical ranker is the deterministic FLOOR (mirrors siteMap.matchSiteCapabilities one tier up); an LLM
// refinement layers on top exactly as the within-Ground matcher does. `resolveGround` adds the precision-first
// confidence band (resolved / ambiguous → "which site?" / miss). PURE — no DOM / chrome / storage / LLM.
//
// @module Core/groundCatalog
// @version 2.74.779

const _STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'on', 'in', 'at', 'my', 'me', 'it', 'this', 'that', 'with', 'from', 'by', 'is', 'are', 'find', 'get', 'do', 'then', 'all']);
const _TLD = new Set(['com', 'org', 'net', 'io', 'co', 'www', 'app', 'gov', 'edu', 'ai', 'so', 'dev']);

function _norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function _tokens(s) { return _norm(s).split(' ').filter((t) => t && t.length > 1 && !_STOP.has(t)); }

/** Host name tokens of a url/pattern: 'https://www.linkedin.com/*' → ['linkedin'] (drop scheme/www/tld/path). PURE. */
function _hostTokens(urlPattern) {
  try {
    const m = String(urlPattern || '').match(/^[a-z]+:\/\/([^/]+)/i);
    const host = (m ? m[1] : String(urlPattern || '')).toLowerCase().replace(/^www\./, '');
    return host.split('.').filter((p) => p && p.length > 1 && !_TLD.has(p));
  } catch { return []; }
}

/**
 * Build a global Ground catalog from Ground records (+ optional per-Ground capability goal labels). PURE.
 * Each entry is the matchable surface of a Ground: host name, name, aliases, description, and the goal labels of
 * the capabilities it offers (so "save a note" matches a Ground whose Strategy is "Save a page").
 * @param {object[]} grounds  Ground records ({id|groundId, name|site, aliases, url|urlPatterns, derivedDescription|description})
 * @param {Object<string,string[]>} [capLabelsByGround]  groundId → capability/goal labels (e.g. Strategy intents)
 * @returns {{groundId:string, name:string, aliases:string[], hostTokens:string[], terms:string[]}[]}
 */
export function buildGroundCatalog(grounds, capLabelsByGround = {}) {
  const out = [];
  for (const g of (Array.isArray(grounds) ? grounds : [])) {
    if (!g) continue;
    const groundId = g.id || g.groundId;
    if (!groundId) continue;
    const name = g.name || g.site || '';
    const aliases = Array.isArray(g.aliases) ? g.aliases : [];
    const urls = Array.isArray(g.urlPatterns) ? g.urlPatterns : (g.url ? [g.url] : []);
    const hostTokens = urls.flatMap(_hostTokens);
    const d = g.derivedDescription || (g.description && (g.description.identity || g.description.category)) || g.description || '';
    const desc = typeof d === 'string' ? d : '';
    const capLabels = Array.isArray(capLabelsByGround[groundId]) ? capLabelsByGround[groundId] : [];
    const terms = Array.from(new Set([
      ...hostTokens,
      ..._tokens(name),
      ...aliases.flatMap(_tokens),
      ..._tokens(desc),
      ...capLabels.flatMap(_tokens),
    ]));
    out.push({ groundId, name, aliases, hostTokens, terms });
  }
  return out;
}

/**
 * Rank the catalog's Grounds against a sub-intent by lexical overlap. PURE — the deterministic floor.
 * A HOST-name hit (the user naming the site, e.g. "…on linkedin") is a strong signal, boosted over generic term
 * overlap so a named site dominates. Returns ranked [{groundId, name, score, hostHit}] with score > minScore.
 * @param {string} subIntent
 * @param {ReturnType<typeof buildGroundCatalog>} catalog
 * @param {{minScore?:number, max?:number}} [opts]
 */
export function matchGrounds(subIntent, catalog, { minScore = 0.001, max = 5 } = {}) {
  const qSet = new Set(_tokens(subIntent));
  if (!qSet.size) return [];
  const ranked = [];
  for (const e of (Array.isArray(catalog) ? catalog : [])) {
    if (!e || !e.groundId) continue;
    const hostHit = (e.hostTokens || []).some((h) => qSet.has(h));
    const termSet = new Set(e.terms || []);
    let overlap = 0;
    for (const t of qSet) if (termSet.has(t)) overlap++;
    // coverage of the ask by this Ground's surface + a strong host-name boost (a named site beats generic overlap)
    let score = overlap / qSet.size;
    if (hostHit) score += 1;
    if (score >= minScore) ranked.push({ groundId: e.groundId, name: e.name, score, hostHit });
  }
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, max);
}

/**
 * Resolve a single Ground for a sub-intent with a precision-first confidence band (mirrors the HIT/MISS gate):
 * 'resolved' = a clear winner; 'ambiguous' = top two are close → ask "which site?"; 'miss' = nothing matched.
 * @returns {{decision:'resolved'|'ambiguous'|'miss', groundId:(string|null), candidates:object[], margin?:number}}
 */
export function resolveGround(subIntent, catalog, { margin = 0.34 } = {}) {
  const ranked = matchGrounds(subIntent, catalog);
  if (!ranked.length) return { decision: 'miss', groundId: null, candidates: [] };
  if (ranked.length === 1) return { decision: 'resolved', groundId: ranked[0].groundId, candidates: ranked };
  const gap = ranked[0].score - ranked[1].score;
  const decision = gap >= margin ? 'resolved' : 'ambiguous';
  return { decision, groundId: ranked[0].groundId, candidates: ranked, margin: gap };
}
