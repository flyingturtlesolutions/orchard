// Core/slug.js — CR-D2 (v2.74.940): THE label→UPPER_SNAKE name builder. Five modules carried their own
// copy with drifted caps (uncapped / 40 chars / 3 words) and four different fallbacks — and HS-2's scope
// wiring connects an observation's OUTPUT name to a fragment's PARAM name by STRING EQUALITY, so the two
// coupled sites (tier2Lower outputs ↔ capabilitySynth params) silently failed to wire whenever a long
// label rounded differently through the two builders. One function; per-site options stay EXPLICIT at
// the call sites; the HS-2-coupled pair MUST keep identical options (pinned by slug.test.js).
//
// PURE. @module Core/slug

/**
 * @param {string} label
 * @param {object} [opts]
 * @param {number} [opts.maxLen=0]    truncate to N chars (0 = uncapped); trailing '_' re-stripped
 * @param {number} [opts.maxWords=0]  keep the first N '_'-separated words (0 = all)
 * @param {string} [opts.fallback=''] returned when the slug is empty
 * @returns {string}
 */
export function slugUpper(label, { maxLen = 0, maxWords = 0, fallback = '' } = {}) {
  let s = String(label || '').trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (maxWords > 0) s = s.split('_').filter(Boolean).slice(0, maxWords).join('_');
  if (maxLen > 0) s = s.slice(0, maxLen).replace(/_+$/g, '');
  return s || fallback;
}
