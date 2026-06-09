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

// Sentinel locale for the UNPREFIXED default-language variant (Google hreflang's term).
const DEFAULT_LOCALE_TAG = 'x-default';

/**
 * Detect locale PREFIX segments at depth 0 for default-unprefixed sites — where the
 * locale codes are NOT a position-0 majority (the unprefixed default-language pages
 * dilute them), so the in-loop majority test misses them. Signal: a locale-shaped top
 * segment whose subtree MIRRORS the unprefixed pages or another locale's subtree
 * (`/de/products` ↔ `/products` and/or `/fr/products`). Returns the confirmed locale
 * prefixes + the set of suffixes that exist in a localized form (so the matching
 * UNPREFIXED page is recognized as the default-locale variant). Pure.
 * @param {Array} items  [{ segs:string[] }] — single-URL-templated path segments
 */
function _detectLocalePrefixes(items) {
  const empty = { localePrefixes: new Set(), localizedSuffixes: new Set() };
  const childSuffixes = new Map();   // locale candidate → Set(suffix after it)
  const unprefixed = new Set();      // full templated path of non-locale-headed items
  for (const it of items) {
    if (it.segs.length && isLocaleCode(it.segs[0])) {
      const suf = it.segs.slice(1).join('/');
      if (!childSuffixes.has(it.segs[0])) childSuffixes.set(it.segs[0], new Set());
      childSuffixes.get(it.segs[0]).add(suf);
    } else {
      unprefixed.add(it.segs.join('/'));
    }
  }
  if (childSuffixes.size < 2) return empty;
  const cands = [...childSuffixes.keys()];
  const localePrefixes = new Set();
  const localizedSuffixes = new Set();
  for (const c of cands) {
    for (const suf of childSuffixes.get(c)) {
      const mirrored = unprefixed.has(suf) || cands.some((o) => o !== c && childSuffixes.get(o).has(suf));
      if (mirrored) { localePrefixes.add(c); localizedSuffixes.add(suf); }
    }
  }
  // Need ≥2 mirroring locale prefixes to treat depth-0 as a language axis (mirroring is
  // the precision guard, so a low bar is safe — a lone /id/ has nothing to mirror).
  return localePrefixes.size >= 2 ? { localePrefixes, localizedSuffixes } : empty;
}

/** Split a rule string ("https://x.com/blog/{slug}") WITHOUT new URL (which %7B-encodes braces). */
function ruleParts(rule) {
  const m = /^(https?:\/\/[^/]+)(\/.*)?$/i.exec(String(rule || ''));
  if (!m) return null;
  return { origin: m[1], segs: (m[2] || '').split('/').filter(Boolean) };
}

const isParamSeg = (s) => s.length > 1 && s.startsWith('{') && s.endsWith('}');

/** Match a concrete URL against a corpus rule (same origin, literals equal, params wild). */
function matchTemplate(url, rules) {
  let u; try { u = new URL(url); } catch { return null; }
  const origin = u.origin;
  const segs = u.pathname.split('/').filter(Boolean).map(templateSegment);
  const litEq = (rsegs) => {                            // rsegs.length === segs.length assumed
    for (let i = 0; i < rsegs.length; i++) {
      // {locale} is NOT fully wild — it matches only a locale-shaped segment, so a bare
      // /products doesn't get swallowed by the per-locale home rule /{locale}.
      if (rsegs[i] === '{locale}') { if (!isLocaleCode(segs[i])) return false; continue; }
      // v2.74.461 — {id}/{hash}/{uuid} are SHAPE params minted by templateSegment, so they
      // match ONLY a segment templateSegment classifies the same way (segs[] is already
      // mapped → compare the param directly). Previously they were fully wild, so a corpus
      // {id} rule born from a SINGLE numeric value (e.g. pixabay's /images/search/2025 →
      // {id}) swallowed every non-numeric sibling (/images/search/ocean, …), splitting
      // keyword pages inconsistently — some literal, some {id}. {slug} stays wild below
      // (it's a fuzzy cohort param with no fixed shape).
      if (rsegs[i] === '{id}' || rsegs[i] === '{hash}' || rsegs[i] === '{uuid}') {
        if (segs[i] !== rsegs[i]) return false;
        continue;
      }
      if (isParamSeg(rsegs[i])) continue;               // {slug} (and any future param) match anything
      if (rsegs[i] !== segs[i]) return false;
    }
    return true;
  };
  // Pass 1 — exact length (locale present, or a non-locale rule).
  for (const rule of rules) {
    const rp = ruleParts(rule);
    if (!rp || rp.origin !== origin || rp.segs.length !== segs.length) continue;
    if (litEq(rp.segs)) return rule;
  }
  // Pass 2 — locale-ABSENT: the UNPREFIXED default-locale variant of a {locale} rule
  // (/products ↔ /{locale}/products, / ↔ /{locale}). Skip a non-empty all-param
  // remainder (e.g. /{locale}/{slug}) — it would swallow any bare /section.
  for (const rule of rules) {
    const rp = ruleParts(rule);
    if (!rp || rp.origin !== origin) continue;
    const li = rp.segs.indexOf('{locale}');
    if (li < 0) continue;
    const rem = rp.segs.slice(0, li).concat(rp.segs.slice(li + 1));
    if (rem.length !== segs.length) continue;
    if (rem.length > 0 && rem.every(isParamSeg)) continue;
    if (litEq(rem)) return rule;
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
  // Default-locale unification: canonicalize the depth-0 locale slot BEFORE templating, per
  // origin. A prefixed page (/de/products) → {locale}/products; an UNPREFIXED page whose
  // suffix is also served localized (/products, with /de/products present) → {locale}/products
  // too (the default-locale variant). So /products, /de/products, /fr/products share ONE
  // archetype, and the bare URL resolves via matchTemplate's locale-absent pass.
  const byOrigin = new Map();
  for (const it of items) { if (!byOrigin.has(it.origin)) byOrigin.set(it.origin, []); byOrigin.get(it.origin).push(it); }
  for (const group of byOrigin.values()) {
    const { localePrefixes, localizedSuffixes } = _detectLocalePrefixes(group);
    if (!localePrefixes.size) continue;
    for (const it of group) {
      if (it.segs.length && localePrefixes.has(it.segs[0])) it.segs = ['{locale}', ...it.segs.slice(1)];
      else if (localizedSuffixes.has(it.segs.join('/'))) it.segs = ['{locale}', ...it.segs];
    }
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
      // v2.74.454 — PER-VALUE slug folding. A {slug} position can hold a structural
      // literal mixed in with the instance cohort: /3d-models/{search,lego-castle-3954,…}
      // — `search` is a section HUB (it heads /search/<query>), the rest are detail
      // leaves. The old all-or-nothing push parameterized `search` too, yielding the bogus
      // /3d-models/{slug}/<query> (cousin: /forum/{slug}/create). Fix: when the position is
      // {slug}, keep a value LITERAL iff it is non-sluggish AND heads a subtree (a member
      // continues past it) — i.e. a fixed hub word, not a leaf instance. Sluggish values and
      // non-sluggish leaves still fold, so genuine flat-slug sites are unaffected.
      const deepVals = param === '{slug}'
        ? new Set(b.members.filter((it) => it.segs.length > i + 1).map((it) => it.segs[i]))
        : null;
      for (const it of b.members) {
        if (param === '{slug}') {
          const v = it.segs[i];
          it.out.push((!isSluggish(v) && deepVals.has(v)) ? v : '{slug}');
        } else {
          it.out.push(param ?? it.segs[i]);
        }
      }
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
  if (segs.length === rp.segs.length) return segs[li] ?? null;        // exact: locale present
  if (segs.length === rp.segs.length - 1) return DEFAULT_LOCALE_TAG;  // unprefixed default variant
  return null;
}

/**
 * v2.74.476 — Bridge a Locale's `leadsTo` edges to the Ground siteMap (GROUND_SPEC § 7). The
 * spec calls `leadsTo` "also a GROUND.siteMap edge" (PAGEMODEL_SPEC § 1): a nav
 * feature points at a destination URL, and that URL collapses — through the SAME
 * corpus template rules the siteMap was built with — to one of the map's archetype
 * nodes. This resolves each Locale-local nav edge to its concrete site-graph node, so
 * the two graph layers connect: you can tell whether a link's target is already
 * `modeled` / `discovered` / `stub`, or `unknown` (a node the map has never seen — a
 * discovery gap worth crawling). PURE — neither the map nor the edges are mutated.
 *
 * Cross-origin destinations (`sameOrigin === false`) belong to another Ground, so they
 * are NOT templated against this site's rules — they resolve to status `external`.
 *
 * @param {Array<{to?:string, kind?:string, sameOrigin?:boolean}>} edges  localeEdges(), kind 'leadsTo'
 * @param {{nodes?:Object, templateRules?:string[]}} map  the Ground siteMap
 * @returns {Array<object>} enriched COPIES: { ...edge, pattern, archetypeId, status, name, known }
 */
export function reconcileLeadsTo(edges, map) {
  const list = Array.isArray(edges) ? edges : [];
  const nodes = (map && map.nodes) || {};
  const rules = (map && map.templateRules) || [];
  const out = [];
  for (const e of list) {
    if (!e || (e.kind && e.kind !== 'leadsTo') || !e.to) continue;
    if (e.sameOrigin === false) {        // another site's graph — don't template here
      out.push({ ...e, pattern: null, archetypeId: null, status: 'external', name: null, known: false });
      continue;
    }
    const pattern = templatePattern(e.to, rules);
    const aid = archetypeId(pattern);
    const node = nodes[aid] || null;
    out.push({
      ...e,
      pattern,
      archetypeId: aid,
      status: node ? (node.status || 'discovered') : 'unknown',
      name: node ? (node.name || pattern) : null,
      known: !!node,
    });
  }
  return out;
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
 * @returns {{ nodes:Object, edges:Array, templateRules:string[] }}
 */
export function siteMapFromCrawl(pages, { rules: sitemapRules = null } = {}) {
  const nodes = {};
  const edges = [];
  const list = Array.isArray(pages) ? pages : [];
  // v2.74.453 — Corpus templating from the CRAWL's OWN harvested URLs. The locale/slug
  // folding engine (deriveTemplateRules) previously ran ONLY on a sitemap.xml corpus;
  // when the sitemap is unreachable (Cloudflare bot-challenge → templateRules empty) the
  // crawl degraded to single-URL templating and locale families stayed split (/de/photos
  // vs /photos; /fr/photos/{id} vs /photos/{id}). But the crawl already harvests hundreds
  // of locale-mirrored URLs — a corpus rich enough to detect the {locale} axis on its own.
  // Derive rules from page URLs + every outgoing href, UNION with any authoritative sitemap
  // rules (sitemap first so it wins match order), and template through the combined set.
  // Field-verified on pixabay: folds /{locale}/… and /{locale}/photos/{id} into one
  // archetype each with NO sitemap. Returned so the merge persists them → Explore +
  // re-discovery template identically (stable archetype ids across actions).
  // v2.74.454 — restrict the corpus to SAME-SITE URLs (hosts the crawl actually
  // visited). An external outgoing link (cdn.pixabay.com/photo/{id}/…, istockphoto,
  // google-support) can never match a same-site node — matchTemplate keys on origin —
  // so its derived rule is pure noise in templateRules. Drop it at the source: the
  // page set defines the site's host(s); only those URLs seed rule derivation.
  const siteHosts = new Set();
  for (const p of list) { if (p && p.url) { const h = hostOf(p.url); if (h) siteHosts.add(h); } }
  const corpus = [];
  for (const p of list) {
    if (!p || !p.url) continue;
    corpus.push(p.url);
    for (const link of Array.isArray(p.outgoing) ? p.outgoing : []) {
      try {
        const abs = new URL(link && link.href, p.url).href;
        if (siteHosts.has(hostOf(abs))) corpus.push(abs);   // same-site only
      } catch { /* skip unresolvable */ }
    }
  }
  const derived = corpus.length ? deriveTemplateRules(corpus) : [];
  const seenRule = new Set();
  const rules = [];
  for (const r of [...(Array.isArray(sitemapRules) ? sitemapRules : []), ...derived]) {
    if (!seenRule.has(r)) { seenRule.add(r); rules.push(r); }
  }
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
  return { nodes, edges, templateRules: rules };   // v2.74.453 — persist combined rules for alignment
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

// ── Site capability catalog ──────────────────────────────────────────────────
// "What can I do across this site?" — the site-level roll-up of the per-archetype
// goals Explore synthesizes (a Locale's L2 goals, copied as LABELS onto each modeled
// node). siteMapStats answers "how much is modeled"; this answers "what does the modeled
// territory let me DO". The full goal objects (description + achievableVia features) live
// in each archetype's Locale — this is the site-wide index over their labels.

/**
 * Normalize a goal label: lowercase, collapse whitespace, drop trailing sentence punctuation.
 * Exported so consumers that need to RE-FIND a catalog goal in a specific archetype's Locale
 * (e.g. capability synthesis) match the SAME way the catalog deduped — the catalog keeps one
 * archetype's original-cased label as the representative, so an exact compare against a
 * different archetype's variant would miss.
 */
export function normalizeGoalLabel(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.!?…]+$/, '').trim();
}

/**
 * Aggregate every modeled archetype's goal labels into a deduplicated, prevalence-ranked
 * capability catalog. One entry per DISTINCT goal (by normalized label), annotated with the
 * archetype(s) that offer it + their pageType(s). Pure (no DOM/chrome/storage).
 *
 * Dedup is exact-on-normalized-label: case / whitespace / trailing-punctuation variants merge;
 * semantically-near labels ("search media" vs "search the library") stay distinct (semantic
 * clustering is a later LLM-backed slice). Within one archetype, repeated labels collapse, so
 * `count` is the number of distinct archetypes offering the goal.
 *
 * @param {{nodes:Object}} map
 * @returns {{ capabilities: Array<{goal:string,count:number,pageTypes:string[],archetypes:Array}>,
 *             byPageType: Object<string,string[]>,
 *             totals: { modeled:number, withGoals:number, distinct:number } }}
 */
export function siteMapCapabilities(map) {
  const ns = map && map.nodes ? Object.values(map.nodes) : [];
  const byNorm = new Map();   // normalized label → entry
  let modeled = 0, withGoals = 0;
  for (const n of ns) {
    if (n.status === 'modeled') modeled++;
    const goals = Array.isArray(n.goals) ? n.goals : [];
    if (!goals.length) continue;
    withGoals++;
    const arch = {
      id: n.id, urlPattern: n.urlPattern, name: n.name || n.urlPattern,
      pageType: n.pageType ?? null, exemplarUrl: n.exemplarUrl || null, status: n.status,
    };
    const seen = new Set();   // collapse repeated labels within one archetype
    for (const label of goals) {
      const key = normalizeGoalLabel(label);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      let e = byNorm.get(key);
      if (!e) { e = { goal: label, pageTypes: new Set(), archetypes: [] }; byNorm.set(key, e); }
      if (arch.pageType) e.pageTypes.add(arch.pageType);
      e.archetypes.push(arch);
    }
  }
  const capabilities = [...byNorm.values()]
    .map((e) => ({ goal: e.goal, count: e.archetypes.length, pageTypes: [...e.pageTypes].sort(), archetypes: e.archetypes }))
    .sort((a, b) => b.count - a.count || (a.goal < b.goal ? -1 : a.goal > b.goal ? 1 : 0));
  const byPageType = {};
  for (const cap of capabilities) {
    for (const pt of (cap.pageTypes.length ? cap.pageTypes : ['(unknown)'])) (byPageType[pt] ??= []).push(cap.goal);
  }
  return { capabilities, byPageType, totals: { modeled, withGoals, distinct: capabilities.length } };
}

// Intent → capability matching. Given a free-text user intent and the catalog above, rank the
// site's goals by lexical overlap so the UI can answer "where do I go / what do I run to do X".
// PURE + deterministic (token overlap, no LLM) — a solid, testable v1; an LLM re-rank for
// synonymy / paraphrase is a later slice that layers on top of these candidates.
// (Named matchSITEcapabilities to not collide with CapabilityAPI.matchCapabilities, which
// matches runnable Strategies/Workflows — a different notion of "capability".)

const _MATCH_STOP = new Set([
  'a','an','the','to','of','for','and','or','my','me','i','it','is','this','that','on','in','with',
  'want','wanna','need','would','like','how','do','can','could','please','find','get','go','see','my','site','page',
]);
/** Content tokens of a string: lowercase alphanumerics, length>1, minus stopwords. */
function _matchTokens(s) {
  return (String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter((t) => t.length > 1 && !_MATCH_STOP.has(t));
}

/**
 * Rank a site's capability catalog against a free-text intent by lexical overlap. Pure.
 * Score = 0.7·(fraction of the GOAL's content tokens the intent covers) + 0.3·(fraction of the
 * INTENT's tokens the goal covers); ties broken by prevalence (count) then label. Goals with no
 * shared token are dropped. Returns the top `limit` candidates, each carrying the archetype(s)
 * (with exemplarUrl) to navigate to.
 * @param {string} intent
 * @param {{capabilities:Array}} catalog  — output of siteMapCapabilities
 * @param {{limit?:number}} [opts]
 * @returns {Array<{goal,score,matched:string[],count,pageTypes:string[],archetypes:Array}>}
 */
export function matchSiteCapabilities(intent, catalog, { limit = 8 } = {}) {
  const want = _matchTokens(intent);
  if (!want.length) return [];
  const wantSet = new Set(want);
  const caps = (catalog && Array.isArray(catalog.capabilities)) ? catalog.capabilities : [];
  const scored = [];
  for (const c of caps) {
    const goalToks = _matchTokens(c.goal);
    if (!goalToks.length) continue;
    const matched = [...new Set(goalToks.filter((t) => wantSet.has(t)))];
    if (!matched.length) continue;
    const goalCover   = matched.length / new Set(goalToks).size;   // how much of the goal the intent hits
    const intentCover = matched.length / wantSet.size;             // how much of the intent the goal hits
    const score = +(goalCover * 0.7 + intentCover * 0.3).toFixed(4);
    scored.push({ goal: c.goal, score, matched, count: c.count, pageTypes: c.pageTypes, archetypes: c.archetypes });
  }
  scored.sort((a, b) => b.score - a.score || b.count - a.count || (a.goal < b.goal ? -1 : a.goal > b.goal ? 1 : 0));
  return scored.slice(0, limit);
}

/**
 * Apply an LLM re-ranking onto a capability pool. `ranking` is [{i, why}] with 1-BASED indices
 * into `capabilities` (as the pool was numbered in the prompt). Returns the referenced
 * capabilities in ranked order, each annotated with a short `why`, deduped, with invalid /
 * out-of-range indices dropped. Pure — the LLM provides the order, this just resolves it safely.
 * Empty/garbage ranking → []; the caller then falls back to the lexical matcher.
 * @param {Array} capabilities  the pool shown to the model (e.g. siteMapCapabilities().capabilities)
 * @param {Array<{i:number,why?:string}>} ranking
 * @returns {Array} capability objects (cloned) in ranked order, each with `.why`
 */
export function applyCapabilityRanking(capabilities, ranking) {
  const pool = Array.isArray(capabilities) ? capabilities : [];
  const out = [];
  const seen = new Set();
  for (const r of (Array.isArray(ranking) ? ranking : [])) {
    const oneBased = Number.isInteger(r && r.i) ? r.i : parseInt(r && r.i, 10);
    const i = oneBased - 1;                                   // 1-based prompt index → 0-based
    if (!(i >= 0 && i < pool.length) || seen.has(i)) continue;
    seen.add(i);
    const why = (r && typeof r.why === 'string') ? r.why.trim().slice(0, 80) : '';
    out.push({ ...pool[i], why });
  }
  return out;
}

// ── Ask → page selection (EX-7, critic #2) ───────────────────────────────────
// matchSiteCapabilities answers "which GOAL" but only over MODELED nodes (those
// that already have synthesized goals). The auto-explore orchestrator needs the
// complementary question — "which PAGE should I navigate to and explore for this
// ask" — which must ALSO rank DISCOVERED / STUB nodes that have no goals yet (the
// whole point of auto-explore is to pick an unexplored page). pagesForAsk ranks
// the typed siteMap NODES by lexical overlap of the ask against each node's
// searchable surface — synthesized goals (strongest: what you can DO there) >
// name/title ≈ url path segments > pageType — so unexplored nodes are selectable
// via their url + name alone. PURE + deterministic; reuses the _matchTokens
// tokenizer (+ its stopword set) shared with matchSiteCapabilities.

const _SEG_PLACEHOLDER = /\{[a-z]+\}/gi;   // {id} {slug} {uuid} {hash} {locale}

/** Path-only content tokens of a urlPattern (origin/host + {placeholders} stripped). */
function _patternTokens(urlPattern) {
  let path = String(urlPattern || '');
  try { path = new URL(path).pathname; } catch { path = path.replace(/^[a-z]+:\/\/[^/]+/i, ''); }
  return _matchTokens(path.replace(_SEG_PLACEHOLDER, ' '));
}

/** Strongest field-weight per matched ask-token (goal 3 > name/url 2 > pageType 1). */
function _nodeMatch(node, wantSet) {
  const goalToks = new Set();
  for (const g of (Array.isArray(node.goals) ? node.goals : [])) for (const t of _matchTokens(g)) goalToks.add(t);
  const fields = [
    [3, goalToks],
    [2, new Set(_matchTokens(node.name))],
    [2, new Set(_patternTokens(node.urlPattern))],
    [1, new Set(_matchTokens(node.pageType))],
  ];
  let score = 0; const matched = [];
  for (const t of wantSet) {
    let best = 0;
    for (const [w, bag] of fields) if (w > best && bag.has(t)) best = w;
    if (best > 0) { score += best; matched.push(t); }
  }
  matched.sort();
  return { score, matched, intentCover: wantSet.size ? +(matched.length / wantSet.size).toFixed(4) : 0 };
}

function _statusRank(s) { return s === 'modeled' ? 0 : s === 'discovered' ? 1 : s === 'stub' ? 2 : 3; }

/**
 * Rank the siteMap's page archetypes against a free-text ask. Pure, deterministic.
 * @param {{nodes:Object}} siteMap
 * @param {string} ask  free-text intent ("find data engineer jobs")
 * @param {{limit?:number, minScore?:number, status?:string|null}} [opts]
 *        status — restrict to one node status (e.g. 'discovered' to pick an UNEXPLORED page)
 * @returns {Array<{id,urlPattern,name,exemplarUrl,status,pageType,score,intentCover,matched:string[]}>}  best first
 */
export function pagesForAsk(siteMap, ask, opts = {}) {
  const { limit = 5, minScore = 1, status = null } = opts;
  const nodes = (siteMap && siteMap.nodes) ? Object.values(siteMap.nodes) : [];
  const wantSet = new Set(_matchTokens(ask));
  if (!wantSet.size) return [];
  const rows = [];
  for (const n of nodes) {
    if (!n || (status && n.status !== status)) continue;
    const m = _nodeMatch(n, wantSet);
    if (m.score < minScore) continue;
    rows.push({
      id: n.id, urlPattern: n.urlPattern, name: n.name || n.urlPattern,
      exemplarUrl: n.exemplarUrl || (Array.isArray(n.instances) && n.instances[0]) || null,
      status: n.status, pageType: n.pageType ?? null,
      score: m.score, intentCover: m.intentCover, matched: m.matched,
    });
  }
  rows.sort((a, b) =>
    b.score - a.score ||
    b.intentCover - a.intentCover ||
    _statusRank(a.status) - _statusRank(b.status) ||
    (a.urlPattern < b.urlPattern ? -1 : a.urlPattern > b.urlPattern ? 1 : 0));
  return rows.slice(0, Math.max(0, limit));
}

// ── Drift & re-discovery (GROUND_SPEC § 8) ───────────────────────────────────

/**
 * Diff two siteMaps by archetype — what a re-discovery CHANGED about the site's
 * architecture: added / removed archetypes + status or pageType changes on shared ones.
 * Keyed by archetype id (stable for a given urlPattern). Pure; the engine for "what
 * changed on the site" + re-discovery prioritization (slice 1 of the drift arc).
 * @returns {{ added, removed, statusChanged, pageTypeChanged, unchanged:number, counts }}
 */
export function diffSiteMap(prev, next) {
  const P = (prev && prev.nodes) || {};
  const N = (next && next.nodes) || {};
  const sum = (n) => ({ id: n.id, urlPattern: n.urlPattern, status: n.status, name: n.name || n.urlPattern });
  const added = [], removed = [], statusChanged = [], pageTypeChanged = [];
  let unchanged = 0;
  for (const id of Object.keys(N)) {
    const b = N[id], a = P[id];
    if (!a) { added.push(sum(b)); continue; }
    let ch = false;
    if (a.status !== b.status) { statusChanged.push({ ...sum(b), from: a.status, to: b.status }); ch = true; }
    if ((a.pageType ?? null) !== (b.pageType ?? null)) { pageTypeChanged.push({ ...sum(b), from: a.pageType ?? null, to: b.pageType ?? null }); ch = true; }
    if (!ch) unchanged++;
  }
  for (const id of Object.keys(P)) if (!N[id]) removed.push(sum(P[id]));
  return {
    added, removed, statusChanged, pageTypeChanged, unchanged,
    counts: { added: added.length, removed: removed.length, statusChanged: statusChanged.length, pageTypeChanged: pageTypeChanged.length, unchanged },
  };
}

/**
 * Archetypes whose capture is STALE: visited (crawled/modeled) longer ago than maxAgeMs.
 * Stubs (never visited, visitedAt null) are excluded — they're un-crawled, not stale.
 * Pure (pass `now`). Feeds re-crawl prioritization + a "needs refresh" UI signal.
 */
export function staleNodes(map, { maxAgeMs = 1000 * 60 * 60 * 24 * 30, now = Date.now() } = {}) {
  const ns = map && map.nodes ? Object.values(map.nodes) : [];
  return ns
    .filter((n) => n.visitedAt && (now - n.visitedAt) > maxAgeMs)
    .map((n) => ({ id: n.id, urlPattern: n.urlPattern, status: n.status, name: n.name || n.urlPattern, visitedAt: n.visitedAt, ageMs: now - n.visitedAt }))
    .sort((a, b) => b.ageMs - a.ageMs);
}
