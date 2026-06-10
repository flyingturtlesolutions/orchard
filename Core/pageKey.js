// Core/pageKey.js — CR-D1 (v2.74.941): THE comparison-time page identity (origin + pathname, query and
// fragment dropped, trailing slashes stripped). Six URL canonicalizers coexisted with a LIVE disagreement:
// accept's _urlScopePattern KEPT the trailing slash while siteMap's normalizePattern STRIPPED it, so
// `https://x.com/jobs` and `https://x.com/jobs/` minted different perspective ids and
// findMatchingPerspective failed to dedup the pair.
//
// IDENTITY-COMPAT RULE (read before "simplifying"):
//   • pageKey is for COMPARISONS (matching, dedup, grouping). Adopters: findMatchingPerspective,
//     siteMap.normalizePattern.
//   • It must NOT replace inputs that are HASHED into persisted ids or used as PERSISTED storage keys —
//     changing those bytes orphans existing records. The two deliberate stay-as-they-are variants:
//       - accept._urlScopePattern (hashed into mintPerspectiveId — keeps its trailing slash forever),
//       - GroundAssetStore.normalizeLocaleKey (persisted Locale-cache keys).
//     Both sides of any comparison go THROUGH pageKey instead, which makes the slash difference moot
//     without a migration.
//
// PURE. @module Core/pageKey

/** @param {string} url @returns {string} origin + pathname, trailing slashes stripped ('' for empty input) */
export function pageKey(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    const p = (u.origin + u.pathname).replace(/\/+$/, '');
    return p || u.origin;
  } catch {
    return String(url).split(/[?#]/)[0].replace(/\/+$/, '');
  }
}
