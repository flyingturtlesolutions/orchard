// Core/siteMap.js — Ground siteMap (GROUND_SPEC § 7): the navigation graph of a
// site's territory. PURE (no chrome / DOM) so it runs in the background, the
// sidepanel, and node unit tests alike — mirroring Core/locale.js + Core/outcomes.js.
//
// nodes = page archetypes (keyed by normalized urlPattern); edges = the navigation
// Features that link them. A captured Locale contributes a `modeled` node for its
// own page plus `discovered` nodes + `link` edges for every same-site navigation
// destination it surfaced — so a SINGLE Explore yields the skeleton of the whole
// site graph (the current page modeled, every nav target discovered). The locale
// index IS the set of `modeled` nodes (GROUND_SPEC § 7 — no separate index).
//
// v2.74.431 — Ground arc, siteMap slice 1: pure builder/merge/stats.

export const SITEMAP_SCHEMA = 1;

/** djb2 — same deriver style as the other Core modules (base36). */
function hashId(s) {
  const str = String(s);
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Normalize a URL to an archetype urlPattern: origin + pathname, sans query/hash and
 * trailing slash. Coarse by design (query-only variants collapse to one archetype);
 * refinement (id-segment templating) is a later slice.
 */
export function normalizePattern(url) {
  try {
    const u = new URL(url);
    const p = (u.origin + u.pathname).replace(/\/+$/, '');
    return p || u.origin;
  } catch {
    return String(url || '').split(/[?#]/)[0].replace(/\/+$/, '');
  }
}

export function archetypeId(pattern) { return 'arch_' + hashId(pattern); }

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

/**
 * Build ONE Locale's contribution to the siteMap.
 * @param {object} locale  a built Locale (has url, title, goals{}, features{})
 * @param {object} opts    { localeKey } — the localeCache key, stored on the modeled node
 * @returns {{ nodes:Object, edges:Array }}
 */
export function siteMapFromLocale(locale, { localeKey = null } = {}) {
  const nodes = {};
  const edges = [];
  if (!locale || !locale.url) return { nodes, edges };
  const selfPattern = normalizePattern(locale.url);
  const selfId = archetypeId(selfPattern);
  const host = hostOf(locale.url);
  const goalLabels = locale.goals ? Object.values(locale.goals).map((g) => g && g.label).filter(Boolean) : [];
  nodes[selfId] = {
    id: selfId, urlPattern: selfPattern, localeId: localeKey ?? null,
    name: locale.title || selfPattern, goals: goalLabels, status: 'modeled', pageType: null, visitedAt: null,
  };
  const feats = locale.features ? Object.values(locale.features) : [];
  const seenEdge = new Set();
  for (const f of feats) {
    if (!f || f.kind !== 'navigation' || !f.href) continue;
    if (host && hostOf(f.href) !== host) continue;        // same-site territory only
    const pat = normalizePattern(f.href);
    if (!pat || pat === selfPattern) continue;            // self / in-page anchor
    const nid = archetypeId(pat);
    if (!nodes[nid]) {
      nodes[nid] = { id: nid, urlPattern: pat, localeId: null, name: f.label || pat, goals: [], status: 'discovered', pageType: null, visitedAt: null };
    }
    const ekey = selfId + '->' + nid + '|' + f.id;
    if (!seenEdge.has(ekey)) {
      seenEdge.add(ekey);
      edges.push({ from: selfId, to: nid, via: f.id, label: f.label || '', kind: 'link' });
    }
  }
  return { nodes, edges };
}

/**
 * Build the siteMap from a Ground DISCOVERY crawl (GROUND_SPEC § 9 bootstrapping):
 * the crawl visited N pages and recorded each page's outgoing links + pageType.
 * This is the breadth source — every crawled page becomes a `discovered` node
 * (carrying pageType + title), every same-site outgoing link an edge. A later
 * Explore of a page upgrades its node to `modeled` (mergeSiteMap status precedence).
 * @param {Array} pages  crawl pages: [{ url, title, pageType, outgoing:[{href,text?}], visitedAt }]
 * @returns {{ nodes:Object, edges:Array }}
 */
export function siteMapFromCrawl(pages) {
  const nodes = {};
  const edges = [];
  const list = Array.isArray(pages) ? pages : [];
  // Pass 1 — a node for every crawled page (carries pageType + title).
  for (const p of list) {
    if (!p || !p.url) continue;
    const pat = normalizePattern(p.url);
    const id = archetypeId(pat);
    if (!nodes[id]) {
      nodes[id] = { id, urlPattern: pat, localeId: null, name: p.title || pat, goals: [], status: 'discovered', pageType: p.pageType ?? null, visitedAt: p.visitedAt ?? null };
    } else {
      if (p.title) nodes[id].name = p.title;
      if (p.pageType) nodes[id].pageType = p.pageType;
    }
  }
  // Pass 2 — edges from each page's outgoing links (same-site as that page).
  const seenEdge = new Set();
  for (const p of list) {
    if (!p || !p.url) continue;
    const fromPat = normalizePattern(p.url);
    const fromId = archetypeId(fromPat);
    const host = hostOf(p.url);
    for (const link of Array.isArray(p.outgoing) ? p.outgoing : []) {
      let abs;
      try { abs = new URL(link && link.href, p.url).href; } catch { continue; }   // resolve relative against the page
      if (!/^https?:/i.test(abs)) continue;
      if (host && hostOf(abs) !== host) continue;
      const toPat = normalizePattern(abs);
      if (!toPat || toPat === fromPat) continue;
      const toId = archetypeId(toPat);
      if (!nodes[toId]) {
        nodes[toId] = { id: toId, urlPattern: toPat, localeId: null, name: (link.text || link.label || toPat), goals: [], status: 'discovered', pageType: null, visitedAt: null };
      }
      const ekey = fromId + '->' + toId;                 // crawl edges have no Feature id (via=null)
      if (!seenEdge.has(ekey)) { seenEdge.add(ekey); edges.push({ from: fromId, to: toId, via: null, label: (link.text || link.label || ''), kind: 'link' }); }
    }
  }
  return { nodes, edges };
}

// Status precedence: a node modeled by some Locale outranks one merely discovered
// via a nav link, which outranks a stub (known from a sitemap, never visited).
const STATUS_RANK = { stub: 0, discovered: 1, modeled: 2 };

/**
 * Merge a fresh contribution into an existing siteMap. Upgrades node status
 * (stub < discovered < modeled), keeps the richer (modeled) metadata, and dedups
 * edges by (from, to, via). Pure — returns a new map.
 */
export function mergeSiteMap(existing, fresh) {
  const map = existing && existing.nodes
    ? { schema: SITEMAP_SCHEMA, nodes: { ...existing.nodes }, edges: [...(existing.edges || [])] }
    : { schema: SITEMAP_SCHEMA, nodes: {}, edges: [] };
  for (const [id, n] of Object.entries(fresh.nodes || {})) {
    const cur = map.nodes[id];
    if (!cur) { map.nodes[id] = { ...n }; continue; }
    const freshWins = STATUS_RANK[n.status] >= STATUS_RANK[cur.status];
    const winner = freshWins ? n : cur;
    map.nodes[id] = {
      id,
      urlPattern: cur.urlPattern || n.urlPattern,
      localeId: n.localeId ?? cur.localeId ?? null,
      name: winner.name || cur.name || n.name,
      goals: (n.goals && n.goals.length) ? n.goals : (cur.goals || []),
      status: freshWins ? n.status : cur.status,
      pageType: n.pageType ?? cur.pageType ?? null,        // crawl supplies pageType; Locale doesn't
      visitedAt: n.visitedAt ?? cur.visitedAt ?? null,
    };
  }
  const seen = new Set(map.edges.map((e) => e.from + '->' + e.to + '|' + e.via));
  for (const e of fresh.edges || []) {
    const k = e.from + '->' + e.to + '|' + e.via;
    if (!seen.has(k)) { seen.add(k); map.edges.push(e); }
  }
  return map;
}

/** Coverage tallies for the UI ("modeled M of N discovered archetypes"). */
export function siteMapStats(map) {
  const ns = map && map.nodes ? Object.values(map.nodes) : [];
  let modeled = 0, discovered = 0, stub = 0;
  for (const n of ns) {
    if (n.status === 'modeled') modeled++;
    else if (n.status === 'discovered') discovered++;
    else stub++;
  }
  return { nodes: ns.length, modeled, discovered, stub, edges: map && map.edges ? map.edges.length : 0 };
}
