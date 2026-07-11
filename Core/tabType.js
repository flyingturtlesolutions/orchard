/**
 * @file Core/tabType.js
 * @description v2.74.1436 — pure typography derivation for the active-tab text match.
 *
 * The chat panel's message prose adopts the ACTIVE TAB's text style, the way its
 * background adopts the tab's colours (Core/tabTint.js). This module is the PURE half:
 * raw per-element style samples in → clamped CSS values out. No DOM, no chrome.*.
 * The sampling half lives in Services/Chat/tabTint.js, which reads computed styles via
 * chrome.scripting — pixels can name a colour, but only the DOM can name a font.
 *
 * Two facts shape the design:
 *
 *   WEBFONTS DO NOT TRANSFER. A page's @font-face font is not installed in the panel.
 *   But pages declare their own fallbacks ("Söhne, Helvetica Neue, Arial, sans-serif"),
 *   and adopting the WHOLE stack captures the page's intended character with whatever is
 *   locally available. System-font sites transfer exactly.
 *
 *   THE CLAMP CARRIES OVER from the tint: character survives, legibility is enforced.
 *   Sizes are held to a readable panel range, line-height is floored, decorative stacks
 *   are rejected outright. An 11px condensed body font is the typographic white-out bug.
 */

/** Font-size the prose may adopt, px. The panel column is ~400px; 15px is its native size. */
export const TYPE_MIN_FS = 13;
export const TYPE_MAX_FS = 16;

/** Line-height as a RATIO of font-size. The native prose is 1.65. */
export const TYPE_MIN_LH = 1.4;
export const TYPE_MAX_LH = 1.9;

/** Prose weight band: lighter turns hairline on small text, heavier reads as shouting. */
export const TYPE_MIN_FW = 300;
export const TYPE_MAX_FW = 600;

/** Letter-spacing band, px. Outside this it is display styling, not body styling. */
export const TYPE_MIN_LS = -0.5;
export const TYPE_MAX_LS = 1;

/** A single sample may not exceed this share of the total vote — one long article body
 *  should win by mass, but one pathological element should not be the whole election. */
const MAX_SAMPLE_WEIGHT = 2000;

/** Stacks that OPEN on a decorative generic are display faces, not prose. */
const DECORATIVE_FIRST = /^(cursive|fantasy)$/i;

const GENERIC = /^(serif|sans-serif|monospace|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|math|emoji|fangsong)$/i;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

const median = (nums) => {
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Split a font-family list into trimmed, unquoted names. */
const familyNames = (stack) => stack.split(',').map((n) => n.trim().replace(/^["']|["']$/g, '')).filter(Boolean);

/**
 * Raw page samples → the prose tokens the panel applies, or null for "keep the default".
 *
 * @param {Array<{ff: string, fs: number, fw: string|number, lh: string, ls: string, n: number}>} samples
 *   ff — computed font-family (the declared stack, serialized by the page's own CSS engine)
 *   fs — computed font-size, px
 *   fw — computed font-weight ("400" | 400 | ...)
 *   lh — computed line-height ("24px" | "normal")
 *   ls — computed letter-spacing ("0.3px" | "normal")
 *   n  — visible text length this element carries: its vote weight
 *
 * @returns {{family: string, fontSize: string, lineHeight: string, fontWeight: string, letterSpacing: string}|null}
 *
 * The family election is weighted by TEXT MASS, so the body font wins over nav links and
 * footers by construction — the page's most-read font is the one the panel adopts.
 * Metrics are then the medians of the winning family's own samples: a serif site with a
 * sans sidebar contributes only its serif measurements.
 */
export function deriveType(samples) {
  if (!Array.isArray(samples)) return null;

  const clean = samples.filter((s) =>
    s && typeof s.ff === 'string' && s.ff.length > 0 && s.ff.length <= 400 &&
    Number.isFinite(s.fs) && s.fs > 0 && Number.isFinite(s.n) && s.n > 0);
  if (clean.length === 0) return null;

  const votes = new Map();
  for (const s of clean) {
    votes.set(s.ff, (votes.get(s.ff) || 0) + Math.min(s.n, MAX_SAMPLE_WEIGHT));
  }
  let family = null, best = -1;
  for (const [ff, n] of votes) if (n > best) { best = n; family = ff; }

  const names = familyNames(family);
  if (names.length === 0) return null;
  if (DECORATIVE_FIRST.test(names[0])) return null;   // a cursive/fantasy body is not prose

  // The stack must END on a generic, or a machine missing every named font falls back to
  // the browser default instead of the page's intent.
  const stack = GENERIC.test(names[names.length - 1]) ? family : `${family}, sans-serif`;

  const winners = clean.filter((s) => s.ff === family);

  const fs = clamp(median(winners.map((s) => s.fs)), TYPE_MIN_FS, TYPE_MAX_FS);

  // Computed line-height is px or "normal"; carry it as a RATIO so it scales with the
  // clamped size rather than importing the page's absolute leading onto a different size.
  const ratios = winners
    .map((s) => (typeof s.lh === 'string' && s.lh.endsWith('px') ? parseFloat(s.lh) / s.fs : null))
    .filter((r) => Number.isFinite(r) && r > 0);
  const lh = ratios.length ? clamp(median(ratios), TYPE_MIN_LH, TYPE_MAX_LH) : null;

  const weights = winners.map((s) => parseInt(s.fw, 10)).filter((w) => Number.isFinite(w) && w >= 1 && w <= 1000);
  const fw = weights.length ? clamp(median(weights), TYPE_MIN_FW, TYPE_MAX_FW) : null;

  const spacings = winners
    .map((s) => (typeof s.ls === 'string' && s.ls.endsWith('px') ? parseFloat(s.ls) : (s.ls === 'normal' ? 0 : null)))
    .filter((v) => Number.isFinite(v));
  const ls = spacings.length ? clamp(median(spacings), TYPE_MIN_LS, TYPE_MAX_LS) : 0;

  return {
    family: stack,
    fontSize: `${Math.round(fs * 2) / 2}px`,           // half-px grid: enough resolution, no jitter
    lineHeight: lh === null ? '' : String(Math.round(lh * 100) / 100),
    fontWeight: fw === null ? '' : String(Math.round(fw)),
    letterSpacing: ls === 0 ? 'normal' : `${Math.round(ls * 100) / 100}px`,
  };
}
