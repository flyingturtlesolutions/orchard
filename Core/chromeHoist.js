// Core/chromeHoist.js — hoist recurring "chrome" Features off the per-archetype Locales
// onto the Ground, so global header/nav/footer controls are modeled ONCE instead of
// re-captured (and re-poked for depth) on every Locale. This is the redundancy
// GROUND_SPEC § 4 exists to remove.
//
// Mechanism (GROUND_SPEC § 4): a Feature's `id` is its cross-Locale UID (the content
// script mints it as djb2(kind|role|label|selector), so the SAME chrome element on two
// pages yields the SAME id — `Feature.id == Landmark.uid`). When a UID is observed in
// ≥ `minLocales` Locales it is PROMOTED to `Ground.chrome`; each Locale then references
// it and keeps only a tiny `chromeOverrides` delta for per-archetype variation (e.g.
// "search collapsed until scroll-top" → `visibleAtRest:false` on that archetype).
//
// PURE: no DOM / chrome / storage. This is the detector (hoistChrome), the depth graft
// (graftChromeDepth), and the per-Locale chrome read (chromeFeaturesForLocale); background
// persists `Ground.chrome`, grafts depth onto skipped Locales, and skips re-poking known chrome.
//
// @module Core/chromeHoist
// @version 2.74.480

/** Fields that legitimately VARY per archetype for the same chrome control → captured as an
 *  override (e.g. "search collapsed until scroll-top" → visibleAtRest:false on that archetype).
 *  `reveals` is deliberately NOT here — it's a capture artifact (poked vs un-poked), handled by
 *  the depth machinery (chromeLayers/graftChromeDepth), not a per-archetype variation. */
export const CHROME_OVERRIDE_FIELDS = Object.freeze(['visibleAtRest', 'hidden']);

/** Feature kinds eligible to be chrome (controls). Regions are structural (used for labeling,
 *  not promoted); collections are page CONTENT, never chrome. */
const _PROMOTABLE_KINDS = new Set(['input', 'action', 'navigation', 'disclosure', 'composite']);

/** Normalize the input to `[{ key, locale }]` from an array of locales, an array of
 *  {key,locale}, or a plain `{ key: locale }` map. `key` is the Locale's cache key. */
function _entries(input) {
  if (Array.isArray(input)) {
    return input.map((it, i) => {
      if (it && it.locale) return { key: String(it.key ?? it.locale.url ?? i), locale: it.locale };
      return { key: String((it && it.url) ?? i), locale: it };
    }).filter((e) => e.locale && typeof e.locale === 'object');
  }
  if (input && typeof input === 'object') {
    return Object.entries(input).map(([key, locale]) => ({ key, locale })).filter((e) => e.locale);
  }
  return [];
}

/** Center-point containment of a feature's rect within a region's rect (with slack). */
function _within(region, feat) {
  const r = region?.location?.absRect, f = feat?.location?.absRect;
  if (!r || !f) return false;
  const cx = f.x + (f.w || 0) / 2, cy = f.y + (f.h || 0) / 2;
  const pad = 2;
  return cx >= r.x - pad && cx <= r.x + (r.w || 0) + pad && cy >= r.y - pad && cy <= r.y + (r.h || 0) + pad;
}

/** Smallest-area region label containing a feature (header/nav/footer hint), else null. */
function _regionLabelFor(feat, regionFeats) {
  let best = null, bestArea = Infinity;
  for (const rg of regionFeats) {
    if (!_within(rg, feat)) continue;
    const r = rg.location.absRect;
    const area = (r.w || 0) * (r.h || 0) || Infinity;
    if (area < bestArea) { bestArea = area; best = rg.label || rg.a11yRole || null; }
  }
  return best;
}

function _eq(a, b) {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a === 'object' || typeof b === 'object') { try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; } }
  return false;
}

/**
 * Detect recurring chrome across a Ground's Locales and split it into a promoted global
 * set + per-Locale overrides.
 *
 * @param {Array|Object} localeEntries  [{key,locale}] | [locale] | { key: locale }
 * @param {{minLocales?:number, requireRegion?:boolean}} [opts]
 *   minLocales   — sightings needed to promote (default 2: "second Locale sees the same UID")
 *   requireRegion — only promote features that fall inside a header/nav/footer region (default false:
 *                   recurrence across distinct archetypes is itself the chrome signal)
 * @returns {{
 *   chrome: Object<string, object>,            // promoted Features keyed by UID (Ground.chrome)
 *   overrides: Object<string, Object>,          // localeKey -> { uid: {field:value} } deltas
 *   promotedIds: string[],
 *   stats: { locales:number, candidates:number, promoted:number }
 * }}
 */
export function hoistChrome(localeEntries, { minLocales = 2, requireRegion = false } = {}) {
  const entries = _entries(localeEntries);

  // 1. Tally each UID across Locales: which keys saw it, a representative feature, the
  //    per-key instance, and any region labels it sat inside.
  const seen = new Map(); // uid -> { keys:Set, rep, byKey:Map, regions:Set }
  const localeByKey = new Map();   // key -> locale (for grafting depth from whichever Locale poked it)
  for (const { key, locale } of entries) {
    localeByKey.set(key, locale);
    const feats = locale.features || {};
    const regionFeats = Object.values(feats).filter((f) => f && f.kind === 'region' && f.location?.absRect);
    for (const f of Object.values(feats)) {
      if (!f || !f.id || !_PROMOTABLE_KINDS.has(f.kind)) continue;
      let rec = seen.get(f.id);
      if (!rec) { rec = { keys: new Set(), rep: f, byKey: new Map(), regions: new Set() }; seen.set(f.id, rec); }
      rec.keys.add(key);
      rec.byKey.set(key, f);
      const rg = _regionLabelFor(f, regionFeats);
      if (rg) rec.regions.add(rg);
    }
  }

  // 2. Promote UIDs seen in ≥ minLocales (and, if required, region-anchored).
  const chrome = {};
  const overrides = {};
  const chromeLayers = {};   // promoted disclosures' reveal Layers (depth captured once)
  const chromeHidden = {};   // those Layers' hidden child Features (chrome-by-association)
  const promotedIds = [];
  let candidates = 0;
  for (const [uid, rec] of seen) {
    if (rec.keys.size >= 2) candidates++;
    if (rec.keys.size < minLocales) continue;
    if (requireRegion && rec.regions.size === 0) continue;
    promotedIds.push(uid);

    // Baseline = the representative instance + provenance. Per-page noise (evidence,
    // exact location) rides along as the canonical; meaningful variation is the override.
    chrome[uid] = {
      ...rec.rep,
      regions: [...rec.regions].sort(),
      seenIn: [...rec.keys].sort(),
      promotedBy: 'recurrence',
    };

    // Per-Locale override: only the CHROME_OVERRIDE_FIELDS that differ from the baseline.
    for (const [key, f] of rec.byKey) {
      const delta = {};
      for (const field of CHROME_OVERRIDE_FIELDS) {
        if (!_eq(f[field], rec.rep[field])) delta[field] = f[field] ?? null;
      }
      if (Object.keys(delta).length) {
        (overrides[key] ||= {})[uid] = delta;
      }
    }

    // Capture chrome DEPTH: a promoted disclosure's reveal Layer + its hidden children,
    // taken from whichever Locale actually poked it. So a later Explore can GRAFT the depth
    // (graftChromeDepth) instead of re-poking the same menu — the compute redundancy
    // GROUND_SPEC § 4 targets. NB: the rep is often an UN-POKED instance (a header button
    // enumerates as kind 'action'; only the poked Locale's instance becomes 'disclosure',
    // same UID) — so DON'T gate on rec.rep.kind; scan every instance for one carrying depth.
    // Hidden children rarely recur on their own (only the poked Locale captured them), so
    // they're pulled in chrome-by-association, not by recurrence.
    for (const key of rec.keys) {
      const loc = localeByKey.get(key);
      const f = rec.byKey.get(key);
      const layerId = f && f.reveals;
      const layer = layerId && loc?.layers?.[layerId];
      if (!layer) continue;
      chromeLayers[layerId] = { ...layer };
      for (const fid of layer.features || []) {
        const hf = loc.features?.[fid];
        if (hf && !chromeHidden[fid]) chromeHidden[fid] = hf;
      }
      chrome[uid].reveals = layerId;     // point the promoted trigger at the captured layer
      chrome[uid].kind = 'disclosure';   // and type it as one (the rep may have been the flat instance)
      break;                              // first Locale with depth wins
    }
  }

  return {
    chrome,
    overrides,
    chromeLayers,
    chromeHidden,
    promotedIds: promotedIds.sort(),
    stats: { locales: entries.length, candidates, promoted: promotedIds.length, layers: Object.keys(chromeLayers).length },
  };
}

/**
 * Graft promoted chrome DEPTH into a Locale model: for each promoted chrome disclosure the
 * model already has (by UID), inject the reveal Layer + hidden children from `Ground.chrome`
 * if the Locale didn't capture them itself. Lets an Explore SKIP re-poking known chrome and
 * still end up with a self-contained Locale (so feature readers need no chrome composition).
 * Retypes the local trigger to a disclosure when needed (an un-poked header button enumerates
 * as a plain action). Idempotent; never overwrites depth the Locale poked itself. Pure (mutates
 * the passed model and returns it — caller owns the model).
 *
 * @param {object} model  a Locale model
 * @param {{chrome?:Object, chromeLayers?:Object, chromeHidden?:Object}} artifact  Ground.chrome
 * @returns {object} the same model, with chrome depth grafted
 */
export function graftChromeDepth(model, { chrome = {}, chromeLayers = {}, chromeHidden = {} } = {}) {
  if (!model || !model.features) return model;
  model.layers = model.layers || {};
  let grafted = 0;
  for (const [uid, base] of Object.entries(chrome)) {
    if (!base || base.kind !== 'disclosure') continue;
    const layerId = base.reveals;
    if (!layerId || !chromeLayers[layerId]) continue;
    // Match the local trigger by UID, falling back to SELECTOR — the Explore skip set is
    // keyed by selector, so if this page minted a different id (a drifted label/kind) we'd
    // otherwise skip poking yet fail to graft, losing the depth. Selector keeps them aligned.
    const trig = model.features[uid]
      || (base.selector ? Object.values(model.features).find((f) => f && f.selector === base.selector) : null);
    if (!trig) continue;                  // this Locale doesn't even have the trigger → nothing to graft onto
    if (model.layers[layerId]) continue;  // already poked locally — keep the local depth
    // Re-anchor the grafted depth to THIS Locale's trigger id: when matched by selector the
    // local id differs from the captured one, so the layer's openedBy + each child's revealedBy
    // must point at `trig.id` or downstream gating (pathToGoal / capabilitySynth) breaks.
    model.layers[layerId] = { ...chromeLayers[layerId], openedBy: trig.id };
    for (const fid of chromeLayers[layerId].features || []) {
      if (!model.features[fid] && chromeHidden[fid]) model.features[fid] = { ...chromeHidden[fid], revealedBy: trig.id };
    }
    trig.kind = 'disclosure';
    trig.reveals = layerId;
    trig.interaction = trig.interaction || { pattern: 'click', effect: 'reveal' };
    grafted++;
  }
  if (grafted && model.coverage && model.coverage.fidelity === 'L0') model.coverage.fidelity = 'L1';
  return model;
}

/**
 * The EFFECTIVE chrome Features for a given Locale, straight from the Ground.chrome artifact:
 * every promoted feature with this Locale's overrides applied (e.g. visibleAtRest:false where
 * "search collapsed until scroll-top" on that archetype). This is the read that CONSUMES
 * chromeOverrides — against the unslimmed reality (Locales keep their own copies; graft keeps
 * them self-contained), so hand it the artifact + a Locale key and get that page's chrome view.
 * Used to augment resolve hints so a control modeled once resolves on every page. Pure; returns
 * features in stable id order.
 *
 * @param {{chrome?:Object, overrides?:Object}} artifact  Ground.chrome
 * @param {string|null} [localeKey]  the Locale cache key whose overrides to apply
 * @returns {Array<object>} override-applied chrome features
 */
export function chromeFeaturesForLocale(artifact, localeKey = null) {
  const chrome = (artifact && artifact.chrome) || {};
  const ov = (localeKey && artifact && artifact.overrides && artifact.overrides[localeKey]) || {};
  return Object.keys(chrome).sort().map((id) => (ov[id] ? { ...chrome[id], ...ov[id] } : { ...chrome[id] }));
}
