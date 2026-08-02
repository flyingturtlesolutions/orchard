/**
 * Core/searchWarnings.js — v2.74.1927: THE SEARCH-FIELD CONTRACT.
 *
 * A search backend that drops an unrecognized filter and returns the UNFILTERED set is the most dangerous
 * response shape there is: 200 OK, well-formed rows, a plausible count, and an answer about the wrong
 * population. Proven live (HAR #3, 2026-08-01) — `staff_member:"Kat Owens"` against the Shopify orders index:
 *
 *   "parsed":   {"and":[{"field":"staff_member","match_phrase":"Kat Owens"},
 *                       {"field":"has_unbatched_fulfillment_order","match_all":"true"}]}
 *   "warnings": [{"field":"staff_member","message":"Invalid search field for this query.","code":"invalid_field"}]
 *
 * …alongside FIFTY edges — exactly the list the OTHER predicate returns on its own. The rejected term is silently
 * removed from the AND. Shopify's own admin is fooled by this at the same time: its telemetry renders a filter
 * CHIP (`current_filters:["staff_member:Kat Owens"]`) for a filter the server never applied.
 *
 * So the server DOES tell you — in `extensions.search[].warnings` — and the only failure mode is not looking.
 * This module is the looking. PURE: no DOM, no chrome, no network.
 *
 * The rule the executor enforces with it: a read whose search string had a field DROPPED is a FAILURE, never a
 * result. "No orders matched" and "your filter was ignored, here is everything" are indistinguishable downstream
 * — by row shape, by count, and by render — so the distinction has to be made here or not at all.
 */

/** Codes that mean THE PREDICATE DID NOT APPLY. Anything else (deprecations, hints) is noise we pass through. */
const _FATAL = new Set(['invalid_field', 'invalid_value', 'unsupported_field', 'unknown_field']);

/** Every warning the backend attached to a search, flattened. PURE. @returns {Array<{field,code,message,path}>} */
export function searchWarnings(value) {
  const ext = value && typeof value === 'object' ? value.extensions : null;
  const searches = ext && Array.isArray(ext.search) ? ext.search : [];
  const out = [];
  for (const s of searches) {
    if (!s || !Array.isArray(s.warnings)) continue;
    const path = Array.isArray(s.path) ? s.path.join('.') : '';
    for (const w of s.warnings) {
      if (!w) continue;
      out.push({
        field: String(w.field || ''),
        code: String(w.code || ''),
        message: String(w.message || ''),
        path,
      });
    }
  }
  return out;
}

/**
 * The FATAL subset: field names the backend refused to apply. A non-empty result means the rows in hand answer a
 * DIFFERENT question than the one asked. PURE. @returns {string[]} distinct field names, in first-seen order.
 */
export function droppedSearchFields(value) {
  const out = [];
  for (const w of searchWarnings(value)) {
    if (!_FATAL.has(w.code) || !w.field) continue;
    if (!out.includes(w.field)) out.push(w.field);
  }
  return out;
}

/**
 * The honest failure sentence for a dropped-field response. Names the field AND says what the rows would have
 * been, because "no results" is the wrong lesson to draw from a filter that never ran. PURE.
 */
export function droppedSearchDetail(fields) {
  const f = (Array.isArray(fields) ? fields : []).filter(Boolean);
  if (!f.length) return '';
  const list = f.length === 1 ? `"${f[0]}"` : `${f.slice(0, -1).map((x) => `"${x}"`).join(', ')} and "${f[f.length - 1]}"`;
  return `the search field ${list} ${f.length === 1 ? 'is' : 'are'} not supported on this query — the site DROPPED it and would have returned unfiltered rows, so these results answer a different question`;
}
