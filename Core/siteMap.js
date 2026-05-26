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
// v2.74.435 — Completeness arc, slice 1: id-segment TEMPLATING. Nodes now key on a
// template pattern (/product/123 + /product/456 → /product/{id}) so the siteMap is
// an archetype graph, not a per-URL census — and one Explore per archetype suffices.
// Each node carries an `exemplarUrl` (a concrete URL to Explore) + `instanceCount`
// (how many real pages it represents). SLUG templates (/blog/my-post) need the full
// URL corpus to detect; that refinement folds in with sitemap.xml ingestion (slice 2).

export const SITEMAP_SCHEMA = 2;

/** Max sample of concrete instance URLs kept per archetype node (for exemplar + display). */
const INSTANCE_SAMPLE_CAP = 8;

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

/**
 * Replace an id-like path segment with a placeholder so instance URLs collapse to
 * one archetype. Conservative single-URL heuristic: numeric / uuid / long-hash /
 * embedded-digit-run (covers /123, /page/2, uuids, /sku-987654, mongo ids). SLUG
 * instances (/blog/my-post) look like real pages to a single-URL view and need the
 * full corpus to detect — that lands with sitemap.xml ingestion (slice 2).
 */
export function templateSegment(seg) {
  if (!seg) return seg;
  if (/^\d+$/.test(seg)) return '{id}';                                                       // /123, /page/2
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return '{uuid}';
  if (/^[0-9a-f]{12,}$/i.test(seg)) return '{hash}';                                          // sha/mongo-ish
  if (/\d{5,}/.test(seg)) return '{id}';                                                      // sku-987654, 12345-title
  return seg;
}

// ── Corpus templating (slice 2a) ─────────────────────────────────────────────
// The single-URL heuristic can't see that /blog/my-post and /blog/other-post are
// the SAME archetype — the slug looks like a real page. Given the FULL URL set
// (sitemap.xml), a position with many varied, slug-like sibling values IS a
// parameter. deriveTemplateRules() emits parameterized template strings (e.g.
// "https://x.com/blog/{slug}"); BOTH the sitemap stubs AND the crawl/Explore
// contributions template through these SAME rules, so a /blog/my-post crawl node
// and the sitemap stub share one archetype id (the stub→discovered→modeled chain
// stays intact). Without the shared rules the two sources would split.

const MIN_LOCALE_SIBLINGS    = 3;   // distinct locale-code siblings to call a position a {locale} axis
const LOCALE_FRACTION        = 0.7; // … and they must be this majority of the position's values
const MIN_SLUG_SIBLINGS      = 8;   // distinct sibling values at a DEEP position to suspect a parameter
// v2.74.437 — depth-0 needs a far higher bar: distinct *sections* (/privacy-policy,
// /terms-of-service, …) live at the top and are often hyphenated, so they'd trip the
// slug test at the deep threshold and wrongly collapse to /{slug}. Real top-level
// instance sets (a flat CMS) number in the dozens+, so a high root bar spares sections
// while still catching genuine flat-instance sites.
const MIN_SLUG_SIBLINGS_ROOT = 20;
const SLUG_FRACTION          = 0.6; // ≥ this fraction must look slug-like (not fixed section words)

/** Looks like an instance identifier (slug), not a fixed section word ("about"). */
function isSluggish(seg) {
  return seg.length >= 12 || seg.includes('-') || /\d/.test(seg);
}

/**
 * Language/locale path segment: en, de, fr, en-US, zh-Hans, pt_br, … Used only in
 * CORPUS context, where several such SIBLINGS at one position confirm a language axis
 * — so the same page repeated per locale collapses to ONE archetype (/{locale}/x)
 * instead of being modeled once per language. Bare 2-letter is ambiguous alone
 * (e.g. /id/ for an ID), but a majority of locale-shaped siblings disambiguates it.
 */
function isLocaleCode(seg) {
  return /^[a-z]{2}([-_][a-z0-9]{2,4})?$/i.test(seg);
}

/** Split a rule string ("https://x.com/blog/{slug}") WITHOUT new URL (which %7B-encodes braces). */
function ruleParts(rule) {
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(String(rule || ''));
  if (!m) return null;
  return { origin: m[1], segs: (m[2] || '').split('/').filter(Boolean) };
}

const isParamSeg = (s) => s.length > 1 && s.startsWith('{') && s.endsWith('}');

/** Match a concrete URL against a corpus rule (same origin, same length, literals equal, params wild). */
function matchTemplate(url, rules) {
  let u; try { u = new URL(url); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean).map(templateSegment);
  for (const rule of rules) {
    const rp = ruleParts(rule);
    if (!rp || rp.origin !== u.origin || rp.segs.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < rp.segs.length; i++) {
      if (isParamSeg(rp.segs[i])) continue;            // {slug}/{id}/… matches anything
      if (rp.segs[i] !== segs[i]) { ok = false; break; }
    }
    if (ok) return rule;
  }
  return null;
}

/**
 * Derive parameterized template rules from a URL corpus. Level-order so nested
 * params compose (/blog/{slug}/comments): at each depth, bucket URLs by their
 * already-templated prefix, and flag a position as {slug} when its distinct
 * sibling values are numerous AND mostly slug-like. Pure.
 * @param {string[]} urls
 * @returns {string[]} distinct template patterns
 */
export function deriveTemplateRules(urls) {
  const items = [];
  for (const u of (Array.isArray(urls) ? urls : [])) {
    let url; try { url = new URL(u); } catch { continue; }
    items.push({ origin: url.origin, segs: url.pathname.split('/').filter(Boolean).map(templateSegment), out: [] });
  }
  const maxDepth = items.reduce((m, it) => Math.max(m, it.segs.length), 0);
  for (let i = 0; i < maxDepth; i++) {
    const buckets = new Map();   // (origin + templated-prefix) → { vals:Set, members:[] }
    for (const it of items) {
      if (i >= it.segs.length) continue;
      const key = it.origin + '\n' + it.out.join('/');
      let b = buckets.get(key);
      if (!b) { b = { vals: new Set(), members: [] }; buckets.set(key, b); }
      b.vals.add(it.segs[i]); b.members.push(it);
    }
    const minSibs = i === 0 ? MIN_SLUG_SIBLINGS_ROOT : MIN_SLUG_SIBLINGS;  // sections live at depth 0
    for (const b of buckets.values()) {
      const nonParam = [...b.vals].filter((v) => !isParamSeg(v));
      let param = null;
      // Locale axis FIRST: the same page repeated per language (/en/x, /de/x, …).
      // Low sibling bar (sites have few languages) but high precision via the code
      // shape + majority — so a lone /id/ route never trips it.
      const localeLike = nonParam.filter(isLocaleCode).length;
      if (localeLike >= MIN_LOCALE_SIBLINGS && nonParam.length && (localeLike / nonParam.length) >= LOCALE_FRACTION) {
        param = '{locale}';
      } else if (b.vals.size >= minSibs && nonParam.length >= minSibs
        && (nonParam.filter(isSluggish).length / nonParam.length) >= SLUG_FRACTION) {
        param = '{slug}';
      }
      for (const it of b.members) it.out.push(param ?? it.segs[i]);
    }
  }
  const rules = new Set();
  for (const it of items) rules.add(it.origin + (it.out.length ? '/' + it.out.join('/') : ''));
  return [...rules];
}

/**
 * Archetype template for a URL: origin + templated pathname (query/hash dropped).
 * With corpus `rules`, a matching rule wins (catches slugs); otherwise the
 * single-URL heuristic applies. Pure (no DOM/chrome).
 *   https://x.com/product/123?ref=a → https://x.com/product/{id}
 *   https://x.com/blog/my-post  (+rules) → https://x.com/blog/{slug}
 */
export function templatePattern(url, rules = null) {
  if (rules && rules.length) {
    const matched = matchTemplate(url, rules);
    if (matched) return matched;
  }
  const raw = normalizePattern(url);
  try {
    const u = new URL(raw);
    const path = u.pathname.split('/').map(templateSegment).join('/').replace(/\/+$/, '');
    return (u.origin + path) || u.origin;
  } catch {
    return raw;
  }
}

/**
 * Given a URL and the corpus rules, return the value occupying the `{locale}` slot of
 * its matching rule (e.g. /en/products + /{locale}/products → "en"), else null. Lets
 * the builders record WHICH language each instance is, so a collapsed archetype keeps a
 * per-locale exemplar map — the enabler for language-agnostic modeling (GROUND_SPEC § 7).
 */
export function localeFromUrl(url, rules) {
  if (!rules || !rules.length) return null;
  const matched = matchTemplate(url, rules);
  if (!matched) return null;
  const rp = ruleParts(matched);
  if (!rp) return null;
  const li = rp.segs.indexOf('{locale}');
  if (li < 0) return null;
  let u; try { u = new URL(url); } catch { return null; }
  const segs = u.pathname.split('/').filter(Boolean);
  return segs[li] ?? null;
}

/**
 * Cross-locale alignment harvest (language-agnostic resolution, slice 3a). Given the
 * SAME page enumerated in multiple languages, fuse its features into ONE language-
 * agnostic set: match features across locales by a language-INVARIANT key (a nav link
 * by its DESTINATION archetype — `/de/products` and `/en/products` collapse to the same
 * target; everything else by `kind|role|selector`, which devs don't translate), and turn
 * the varying visible text into a `labelsByLocale` alias set. Downstream role/goal
 * matching can then hit ANY language's label (or use the invariant), so resolution stops
 * depending on the captured language. Pure.
 *
 * @param {Object} byLocale  { en: feature[], de: feature[], … } — enumeratePage features
 * @param {Object} opts      { rules } corpus template rules (to collapse localized nav hrefs)
 * @returns {Array} aligned features: { ...baseFeature, labelsByLocale:{loc:label}, locales:[…] }
 */
export function alignFeaturesAcrossLocales(byLocale, { rules = null } = {}) {
  const locales = Object.keys(byLocale || {});
  if (!locales.length) return [];
  const invariantKey = (f) => {
    if (!f) return '';
    if (f.kind === 'navigation' && f.href) {
      try { return 'nav|' + templatePattern(f.href, rules); } catch { return 'nav|' + f.href; }
    }
    return [f.kind || '', f.a11yRole || '', f.selector || ''].join('|');   // selectors are locale-independent
  };
  const merged = new Map();   // invariantKey → { base, labelsByLocale }
  for (const loc of locales) {
    const feats = Array.isArray(byLocale[loc]) ? byLocale[loc] : [];
    const seenThisLocale = new Set();   // first feature per key represents this locale
    for (const f of feats) {
      const k = invariantKey(f);
      if (!k || seenThisLocale.has(k)) continue;
      seenThisLocale.add(k);
      let rec = merged.get(k);
      if (!rec) { rec = { base: f, labelsByLocale: {} }; merged.set(k, rec); }
      if (f && typeof f.label === 'string' && f.label.trim()) rec.labelsByLocale[loc] = f.label.trim();
    }
  }
  const out = [];
  for (const { base, labelsByLocale } of merged.values()) {
    out.push({ ...base, labelsByLocale, locales: Object.keys(labelsByLocale).sort() });
  }
  return out;
}

function hostOf(url) { try { return new URL(url).host; } catch { return ''; } }

/**
 * Per-build instance accounting. A builder notes every concrete URL it folds into
 * an archetype, deduped on its NORMALIZED form (so /a?ref=1, /a?ref=2 and /a/ count
 * as one concrete page), tracking the full distinct set — NOT a capped includes()
 * check, which would double-count instances seen beyond the retained sample. After
 * building, `apply(nodes)` writes instanceCount (true distinct count), a capped
 * sample of ORIGINAL (navigable) URLs, and the exemplar (first URL seen) onto each node.
 */
function makeInstanceTracker(rules = null) {
  const recs = new Map();   // nodeId → { set, sample, exemplar, byLocale:Map<locale,url> }
  return {
    note(nodeId, url) {
      if (!nodeId || !url) return;
      let rec = recs.get(nodeId);
      if (!rec) { rec = { set: new Set(), sample: [], exemplar: null, byLocale: new Map() }; recs.set(nodeId, rec); }
      const norm = normalizePattern(url);
      if (!rec.set.has(norm)) {
        rec.set.add(norm);
        if (rec.sample.length < INSTANCE_SAMPLE_CAP) rec.sample.push(url);
      }
      if (!rec.exemplar) rec.exemplar = url;
      // Language dimension: record one concrete URL per locale (first seen wins).
      const loc = localeFromUrl(url, rules);
      if (loc && !rec.byLocale.has(loc)) rec.byLocale.set(loc, url);
    },
    apply(nodes) {
      for (const [nid, rec] of recs) {
        const node = nodes[nid];
        if (!node) continue;
        node.instances = rec.sample;
        node.instanceCount = rec.set.size;
        node.exemplarUrl = rec.exemplar;
        if (rec.byLocale.size) {
          node.locales = [...rec.byLocale.keys()].sort();
          node.exemplarByLocale = Object.fromEntries(rec.byLocale);
        }
      }
    },
  };
}

/** Fresh archetype node with the v2 (templated) shape. */
function makeNode(pattern, { status, name = null, localeId = null, pageType = null, visitedAt = null } = {}) {
  return {
    id: archetypeId(pattern), urlPattern: pattern, localeId,
    name: name || pattern, goals: [], status, pageType, visitedAt,
    exemplarUrl: null, instances: [], instanceCount: 0,
    locales: [], exemplarByLocale: {},   // language dimension (filled when a {locale} axis is present)
  };
}

/**
 * Build ONE Locale's contribution to the siteMap.
 * @param {object} locale  a built Locale (has url, title, goals{}, features{})
 * @param {object} opts    { localeKey } — the localeCache key, stored on the modeled node
 * @returns {{ nodes:Object, edges:Array }}
 */
export function siteMapFromLocale(locale, { localeKey = null, rules = null } = {}) {
  const nodes = {};
  const edges = [];
  if (!locale || !locale.url) return { nodes, edges };
  const inst = makeInstanceTracker(rules);
  const selfPattern = templatePattern(locale.url, rules);
  const selfId = archetypeId(selfPattern);
  const host = hostOf(locale.url);
  const goalLabels = locale.goals ? Object.values(locale.goals).map((g) => g && g.label).filter(Boolean) : [];
  nodes[selfId] = makeNode(selfPattern, { status: 'modeled', name: locale.title || selfPattern, localeId: localeKey ?? null });
  nodes[selfId].goals = goalLabels;
  inst.note(selfId, locale.url);
  const feats = locale.features ? Object.values(locale.features) : [];
  // Dedup edges by ARCHETYPE PAIR (from→to), not by feature id — otherwise a grid of
  // N nav cards that all collapse to one /product/{id} archetype emits N parallel
  // edges. `via` records the FIRST linking feature as representative provenance.
  const seenEdge = new Set();
  for (const f of feats) {
    if (!f || f.kind !== 'navigation' || !f.href) continue;
    if (host && hostOf(f.href) !== host) continue;        // same-site territory only
    const pat = templatePattern(f.href, rules);
    if (!pat || pat === selfPattern) continue;            // self / in-page / same-archetype anchor
    const nid = archetypeId(pat);
    if (!nodes[nid]) nodes[nid] = makeNode(pat, { status: 'discovered', name: f.label || pat });
    inst.note(nid, f.href);
    const ekey = selfId + '->' + nid;
    if (!seenEdge.has(ekey)) {
      seenEdge.add(ekey);
      edges.push({ from: selfId, to: nid, via: f.id, label: f.label || '', kind: 'link' });
    }
  }
  inst.apply(nodes);
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
export function siteMapFromCrawl(pages, { rules = null } = {}) {
  const nodes = {};
  const edges = [];
  const list = Array.isArray(pages) ? pages : [];
  const inst = makeInstanceTracker(rules);
  // Pass 1 — a node per crawled page ARCHETYPE (carries pageType + title).
  for (const p of list) {
    if (!p || !p.url) continue;
    const pat = templatePattern(p.url, rules);
    const id = archetypeId(pat);
    if (!nodes[id]) {
      nodes[id] = makeNode(pat, { status: 'discovered', name: p.title || pat, pageType: p.pageType ?? null, visitedAt: p.visitedAt ?? null });
    } else {
      if (p.title) nodes[id].name = p.title;
      if (p.pageType) nodes[id].pageType = p.pageType;
      if (p.visitedAt && !nodes[id].visitedAt) nodes[id].visitedAt = p.visitedAt;
    }
    inst.note(id, p.url);
  }
  // Pass 2 — edges from each page's outgoing links (same-site as that page).
  const seenEdge = new Set();
  for (const p of list) {
    if (!p || !p.url) continue;
    const fromPat = templatePattern(p.url, rules);
    const fromId = archetypeId(fromPat);
    const host = hostOf(p.url);
    for (const link of Array.isArray(p.outgoing) ? p.outgoing : []) {
      let abs;
      try { abs = new URL(link && link.href, p.url).href; } catch { continue; }   // resolve relative against the page
      if (!/^https?:/i.test(abs)) continue;
      if (host && hostOf(abs) !== host) continue;
      const toPat = templatePattern(abs, rules);
      if (!toPat || toPat === fromPat) continue;          // self / same-archetype link
      const toId = archetypeId(toPat);
      if (!nodes[toId]) nodes[toId] = makeNode(toPat, { status: 'discovered', name: (link.text || link.label || toPat) });
      inst.note(toId, abs);
      const ekey = fromId + '->' + toId;                 // crawl edges have no Feature id (via=null)
      if (!seenEdge.has(ekey)) { seenEdge.add(ekey); edges.push({ from: fromId, to: toId, via: null, label: (link.text || link.label || ''), kind: 'link' }); }
    }
  }
  inst.apply(nodes);
  return { nodes, edges };
}

/**
 * Build the siteMap from a sitemap.xml URL corpus (slice 2): every URL becomes a
 * `stub` archetype node (known to exist, never visited). Derives + applies corpus
 * template rules so slug-instances collapse, and RETURNS those rules — the caller
 * persists them on the map so the crawl + Explore contributions template the same
 * way (alignment) and upgrade these stubs in place. No edges (a sitemap has no link
 * structure). Pure.
 * @param {string[]} urls  absolute http(s) URLs from sitemap.xml
 * @returns {{ nodes:Object, edges:Array, templateRules:string[] }}
 */
export function siteMapFromSitemap(urls) {
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && /^https?:/i.test(u));
  const templateRules = deriveTemplateRules(list);
  const nodes = {};
  const inst = makeInstanceTracker(templateRules);
  for (const u of list) {
    const pat = templatePattern(u, templateRules);
    const id = archetypeId(pat);
    if (!nodes[id]) nodes[id] = makeNode(pat, { status: 'stub' });
    inst.note(id, u);
  }
  inst.apply(nodes);
  return { nodes, edges: [], templateRules };
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
  // Carry corpus template rules: a sitemap contribution supplies the authoritative
  // set; otherwise keep what the map already had (so crawl/Explore stay aligned).
  map.templateRules = (fresh.templateRules && fresh.templateRules.length)
    ? fresh.templateRules
    : (existing && existing.templateRules) || [];
  for (const [id, n] of Object.entries(fresh.nodes || {})) {
    const cur = map.nodes[id];
    if (!cur) { map.nodes[id] = { ...n }; continue; }
    const freshWins = STATUS_RANK[n.status] >= STATUS_RANK[cur.status];
    const winner = freshWins ? n : cur;
    // Union the concrete-instance samples (capped); instanceCount is best-effort —
    // sitemap.xml supplies the authoritative count (slice 2), so MAX dominates,
    // while disjoint small crawl/Locale samples still aggregate via the union size.
    const instances = [...(cur.instances || [])];
    for (const u of (n.instances || [])) if (!instances.includes(u) && instances.length < INSTANCE_SAMPLE_CAP) instances.push(u);
    map.nodes[id] = {
      id,
      urlPattern: cur.urlPattern || n.urlPattern,
      localeId: n.localeId ?? cur.localeId ?? null,
      name: winner.name || cur.name || n.name,
      goals: (n.goals && n.goals.length) ? n.goals : (cur.goals || []),
      status: freshWins ? n.status : cur.status,
      pageType: n.pageType ?? cur.pageType ?? null,        // crawl supplies pageType; Locale doesn't
      visitedAt: n.visitedAt ?? cur.visitedAt ?? null,
      exemplarUrl: cur.exemplarUrl || n.exemplarUrl || null,
      instances,
      instanceCount: Math.max(cur.instanceCount || 0, n.instanceCount || 0, instances.length),
      // Language dimension: union the locale sets; keep existing per-locale exemplars
      // (stable) and fill any the fresh contribution adds.
      locales: [...new Set([...(cur.locales || []), ...(n.locales || [])])].sort(),
      exemplarByLocale: { ...(n.exemplarByLocale || {}), ...(cur.exemplarByLocale || {}) },
    };
  }
  const seen = new Set(map.edges.map((e) => e.from + '->' + e.to + '|' + e.via));
  for (const e of fresh.edges || []) {
    const k = e.from + '->' + e.to + '|' + e.via;
    if (!seen.has(k)) { seen.add(k); map.edges.push(e); }
  }
  return map;
}

/**
 * Coverage tallies for the UI ("M of N archetypes modeled, ~P pages").
 * `pages` = Σ instanceCount (estimated concrete pages the graph represents);
 * `modeledPages` = the slice of those covered by a modeled archetype.
 */
export function siteMapStats(map) {
  const ns = map && map.nodes ? Object.values(map.nodes) : [];
  let modeled = 0, discovered = 0, stub = 0, pages = 0, modeledPages = 0;
  const localeCounts = {};   // locale → # of archetypes it appears on
  for (const n of ns) {
    const inst = n.instanceCount || 0;
    pages += inst;
    if (n.status === 'modeled') { modeled++; modeledPages += inst; }
    else if (n.status === 'discovered') discovered++;
    else stub++;
    for (const l of (n.locales || [])) localeCounts[l] = (localeCounts[l] || 0) + 1;
  }
  // Ground-level language rollup: the site's locale set + the most prevalent as default.
  const locales = Object.keys(localeCounts).sort();
  const defaultLocale = locales.length
    ? Object.entries(localeCounts).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]
    : null;
  return { nodes: ns.length, modeled, discovered, stub, edges: map && map.edges ? map.edges.length : 0, pages, modeledPages, locales, defaultLocale };
}
