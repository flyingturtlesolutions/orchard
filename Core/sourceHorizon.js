// Core/sourceHorizon.js — HZ-1 (v2.74.1956): EVERY READ LEG HAS A HORIZON, AND NONE OF THEM COULD SAY SO.
//
// UPS keeps standard tracking online for ~120 days. Ask about a five-month-old shipment and the API returns a
// clean, successful, EMPTY answer — which rendered as "Nothing to read — the list came back empty", i.e. *the
// package does not exist* when the truth is *the record aged out*. Same defect family as the Shopify
// `searchWarnings` trap (an unrecognized filter is silently DROPPED and returns unfiltered rows): in both, a
// result whose SCOPE differs from the ask's scope is presented as if it matched. There it was a confident wrong
// answer; here it is a confident wrong ABSENCE, which is harder to notice because absence looks like an answer.
//
// DELIBERATELY NOT A GATE. 120 days is UPS's approximate published figure, not something we have observed, and
// refusing an ask on an approximate boundary would decline requests that would have worked. The horizon shapes
// the ANSWER, never the decision to call. That is why `approximate` is carried and surfaced as "about".
//
// Placement (answering "where does this belong?"): on the RECIPE — it is a property of the SOURCE, not of any
// instance, conversation or user, so it is catalog-owned and refreshes into already-seeded Grounds on a catalog
// upgrade. Not preset/instance memory, which is where LEARNED deltas live. Threads hops 1+3 (a reader needs it);
// hop 4 is skipped on purpose — the executor never uses it, only the answer does.

const _int = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : null);

/** The declared retention window of a leg's source, or null. Accepts a leg, a leg.tool, or a raw recipe. PURE. */
export function sourceHorizon(legOrRecipe) {
  const o = (legOrRecipe && typeof legOrRecipe === 'object') ? legOrRecipe : null;
  if (!o) return null;
  const t = (o.tool && typeof o.tool === 'object') ? o.tool : o;
  const r = t.retention || o.retention || null;
  if (!r || typeof r !== 'object') return null;
  const days = _int(r.days);
  if (!days) return null;
  return {
    days,
    approximate: r.approximate !== false,          // default to hedged; a hard bound must opt IN
    source: typeof r.source === 'string' ? r.source : null,
  };
}

/** "about 120 days (4 months)" — months only when they divide near-evenly, so we never invent false precision. */
function _span(days) {
  const months = days / 30;
  const rounded = Math.round(months);
  const clean = rounded >= 2 && Math.abs(months - rounded) < 0.2;
  return clean ? `${days} days (about ${rounded} months)` : `${days} days`;
}

/**
 * The sentence to append when a read came back EMPTY and its source has a horizon — the whole point of the field.
 * Returns null when there is no horizon, so callers can `const n = …; if (n) …` without branching on shape. PURE.
 */
export function emptyResultNote(legOrRecipe) {
  const h = sourceHorizon(legOrRecipe);
  if (!h) return null;
  const hedge = h.approximate ? 'only keeps these records for about ' : 'keeps these records for ';
  const who = _who(legOrRecipe);
  return `${who} ${hedge}${_span(h.days)}, so an empty result can mean the record aged out rather than that it doesn't exist.`;
}

function _who(legOrRecipe) {
  const o = (legOrRecipe && typeof legOrRecipe === 'object') ? legOrRecipe : {};
  const t = (o.tool && typeof o.tool === 'object') ? o.tool : o;
  const host = String(t.appHost || t.origin || o.appHost || o.origin || '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return host ? `${host} ` : 'This source ';
}
