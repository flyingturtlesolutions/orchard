// Core/urlPostcondition.js — v2.74.885. PURE, no DOM/LLM/storage.
//
// A `url_matches` postcondition baked with the DEMO param value — e.g. `"/videos/"`, authored when the trial
// ran with CATEGORY=Videos — FALSE-FAILS when the SAME capability later runs with a different bound value
// (CATEGORY=Vectors → the page is `/vectors/`; the live "search pixabay for cool vectors" gap). The STEPS
// already generalize across param values (they correctly drove to /vectors/); this lets the VERIFY generalize
// the same way, WITHOUT re-authoring: a failing url_matches is RELAXED if swapping a mismatching path segment
// of the pattern for the SLUG of a bound param value makes it match the actual URL — i.e. the navigation
// reached the page the param NAMES, just a different option than the demo.
//
// (The clean long-term form is to TEMPLATE the postcondition at authoring — `/{{CATEGORY}}/` — so replay
// substitution + this slug match cover it; this runtime relax covers capabilities authored before that.)

// URL slug for a value: lowercase, non-alphanumeric runs → single hyphen, trimmed. "Vectors"→"vectors",
// "Sound Effects"→"sound-effects".
export const urlSlug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Slug each '/'-separated PATH segment but KEEP the separators, so a path fragment stays a path fragment:
// "/videos/" → "/videos/", "https://pixabay.com/Sound Effects/" → "https//pixabay-com/sound-effects/".
const _slugPath = (s) => String(s || '').toLowerCase().split('/').map((seg) => seg.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).join('/');

// Slugged, non-empty path segments: "/videos/search/fable/" → ["videos","search","fable"].
const _segs = (s) => _slugPath(s).split('/').filter(Boolean);

/**
 * Does `url` satisfy a `url_matches` `pattern` when each mismatching pattern PATH SEGMENT may be filled by a bound
 * param value? PURE. The pattern's segments must appear as a CONTIGUOUS run in the url's segments, where each
 * pattern segment matches LITERALLY or is a "param slot" the url filled with a BOUND param value (slug-compared).
 * v2.74.886 — generalizes across ALL the capability's params at once: "/videos/" → "/vectors/" (CATEGORY) AND
 * "/videos/search/fable/" → "/vectors/search/cool/" (CATEGORY + SEARCH). Conservative: only bound slugs ≥ 3 chars
 * count, and a swap satisfies a WHOLE segment, so a keyword can't loosely match part of a path.
 * @param {string} pattern   the postcondition pattern (e.g. "/videos/")
 * @param {string} url       the actual URL the fragment landed on (e.g. "https://pixabay.com/vectors/")
 * @param {string[]} boundValues  the run's bound param VALUES (e.g. ["Vectors", "cool"])
 * @returns {boolean}
 */
export function urlMatchesWithParams(pattern, url, boundValues = []) {
  const pSegs = _segs(pattern);
  const uSegs = _segs(url);
  if (!pSegs.length || pSegs.length > uSegs.length) return false;
  const slugSet = new Set([...new Set((Array.isArray(boundValues) ? boundValues : []).map(urlSlug))].filter((s) => s.length >= 3));
  // Slide the pattern over the url's segments; a window matches if every pattern segment is LITERAL-equal OR the
  // url segment there is a bound param value (the pattern's demo literal that the run re-parameterized).
  for (let start = 0; start + pSegs.length <= uSegs.length; start++) {
    let ok = true;
    for (let k = 0; k < pSegs.length; k++) {
      const p = pSegs[k], u = uSegs[start + k];
      if (p === u || slugSet.has(u)) continue;
      ok = false; break;
    }
    if (ok) return true;
  }
  return false;
}
