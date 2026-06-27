// Core/groundToolSurface.js — the tri-class per-Ground tool surface (DESIGN_connectors.md §18, v2.74.1268). ONE pure
// model BOTH Studio + the Ground side panel render, so the Drive / Ride / Broker hierarchy is a TESTED CONTRACT, not
// ad-hoc UI nesting (Ride is a peer of Drive at the CLASS level; recipes sit inside Ride as fragments sit inside Drive).
// DRIVE + BROKER sections are passed IN (surface-specific extraction); this module owns the class envelope + the
// RIDE-recipe shaping (rows + safety badges + the pending-review count — the genuinely new part). PURE.

import { armable, safetyRank } from './rideRecipe.js';

const _str = (v) => String(v == null ? '' : v);

/** Project a ride-recipe record into the display row both surfaces render. PURE. */
export function recipeRow(r) {
  const rec = (r && typeof r === 'object') ? r : {};
  return {
    id: _str(rec.id), name: _str(rec.name || rec.id), does: _str(rec.does),
    method: _str(rec.method || 'GET').toUpperCase(), endpoint: _str(rec.endpoint),
    params: Array.isArray(rec.params) ? rec.params : [],
    provenance: _str(rec.provenance || 'curated'),
    safetyClass: _str(rec.safetyClass || 'auto'),
    trust: typeof rec.trust === 'number' ? rec.trust : null,
    enabled: rec.enabled !== false,
    reviewState: _str(rec.reviewState || 'accepted'),
    armable: armable(rec),
  };
}

/**
 * The RIDE class's recipe section: rows (sorted safest-first, then by name) + the badges the surfaces show — total
 * count, pending-review count, and a by-safety histogram. PURE.
 */
export function rideSection(recipes) {
  const list = Array.isArray(recipes) ? recipes : [];
  const rows = list.map(recipeRow).sort((a, b) => (safetyRank(a.safetyClass) - safetyRank(b.safetyClass)) || a.name.localeCompare(b.name));
  const bySafety = { auto: 0, gated: 0, destructive: 0 };
  let pending = 0;
  for (const r of rows) { if (bySafety[r.safetyClass] !== undefined) bySafety[r.safetyClass]++; if (r.reviewState === 'pending') pending++; }
  return { type: 'recipes', label: 'Recipes', count: rows.length, pending, bySafety, entries: rows };
}

const _count = (sections) => (Array.isArray(sections) ? sections : [])
  .reduce((n, s) => n + (typeof s.count === 'number' ? s.count : (Array.isArray(s.entries) ? s.entries.length : 0)), 0);

/**
 * Build the tri-class per-Ground tool surface. PURE. `driveSections` + `brokerSections` are surface-extracted
 * `{type,label,count,entries}` lists (Drive substrate types — fragments/perspectives/… — and broker tools); RIDE is
 * built here from the recipe collection. Returns the ordered class list each surface renders, with per-class counts
 * (for the glance) and the Ride pending-review count (the badge that drives "N pending").
 * @returns {{ classes: Array<{ key:string, label:string, count:number, pending?:number, placeholder?:boolean, sections:Array }> }}
 */
export function groundToolSurface({ driveSections = [], recipes = [], brokerSections = [] } = {}) {
  const drive = Array.isArray(driveSections) ? driveSections : [];
  const broker = Array.isArray(brokerSections) ? brokerSections : [];
  const ride = rideSection(recipes);
  return {
    classes: [
      { key: 'drive', label: 'Drive', count: _count(drive), sections: drive },
      { key: 'ride', label: 'Ride', count: ride.count, pending: ride.pending, sections: [ride] },
      { key: 'broker', label: 'Broker', count: _count(broker), placeholder: broker.length === 0, sections: broker },
    ],
  };
}
