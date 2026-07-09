/**
 * @file Core/tabTint.js
 * @description v2.74.1416 — pure colour math for the active-tab background tint.
 *
 * The side panel samples a downscaled screenshot of the active tab and derives a
 * gradient from it. This module is the PURE half: pixels in → hex tokens out. No
 * DOM, no chrome.*, no canvas. The capture/apply half lives in Services/Chat/tabTint.js.
 *
 * POLARITY is the first decision: a light page gets a light panel with dark text, a dark
 * page the reverse. Before that existed, the foreground was a fixed off-white and every
 * background had to stay dark enough to sit under it — which crushed pure white and pure
 * black into the same 5% lightness sliver, so every site rendered as the same brown.
 *
 * The clamp is the second. Within a polarity a sampled colour is still arbitrary, so it
 * is forced into that polarity's band: hue survives, lightness and saturation do not.
 * tabTint.test.js asserts the resulting contrast ratios against each polarity's OWN text,
 * which is what makes the clamp a contract rather than a guess.
 */

/** Foreground for a DARK panel — the historical --c-text. */
export const TEXT_ON_DARK = [232, 227, 216];

/** Foreground for a LIGHT panel: warm near-black, the mirror of the above. */
export const TEXT_ON_LIGHT = [35, 32, 28];

/** The brand accent, before it is pushed to clear contrast on whichever panel it lands. */
const ACCENT_BASE = [217, 119, 87];

/** Hue used when a page is achromatic — keeps greys warm instead of drifting blue. */
export const NEUTRAL_HUE = 32;

/**
 * Polarity thresholds on the dominant colour's relative luminance, with a deliberate gap.
 *
 * A single threshold would make a page sitting near it flip the entire panel back and
 * forth on every re-sample — a strobe. The gap is hysteresis: once light, a page must get
 * genuinely dark before the panel flips back, and vice versa.
 */
export const POLARITY_ENTER_LIGHT = 0.45;
export const POLARITY_LEAVE_LIGHT = 0.30;

/**
 * Each polarity's surface band: where backgrounds may live, and which way "elevated" moves.
 *
 * `dir` is the sign of a lift. On a dark panel an elevated surface is LIGHTER than the
 * base; on a light panel it is DARKER. Both mean "further from the background, toward the
 * text" — one constant instead of two mirrored code paths.
 *
 * Light panels get a tighter saturation cap: the same 38% that reads as a rich tint at 12%
 * lightness reads as a highlighter at 93%.
 */
const BAND = {
  dark:  { base: 0.09, slope: 0.10, dir: +1, minL: 0.06, maxL: 0.24, maxS: 0.38, minS: 0.06, achroS: 0.05 },
  light: { base: 0.86, slope: 0.07, dir: -1, minL: 0.80, maxL: 0.96, maxS: 0.22, minS: 0.04, achroS: 0.03 },
};

/** The dark band's caps, exposed so the tests can assert against them by name. */
export const TINT_MAX_L = BAND.dark.maxL;
export const TINT_MAX_S = BAND.dark.maxS;

/** How far muted/subtle text travels from the foreground toward the background. */
const MUTED_MIX = { dark: 0.28, light: 0.30 };
const SUBTLE_MIX = { dark: 0.52, light: 0.45 };

/** Minimum contrast the accent must hold against the panel it sits on. */
const ACCENT_MIN_CONTRAST = 4.5;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

// ── Colour space ───────────────────────────────────────────────────────────

/** @param {number} r @param {number} g @param {number} b — 0..255 → {h:0..360, s:0..1, l:0..1} */
export function rgbToHsl(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;

  if (d === 0) return { h: 0, s: 0, l };

  const denom = 1 - Math.abs(2 * l - 1);
  const s = denom === 0 ? 0 : d / denom;

  let h;
  if (max === rn) h = 60 * (((gn - bn) / d) % 6);
  else if (max === gn) h = 60 * ((bn - rn) / d + 2);
  else h = 60 * ((rn - gn) / d + 4);
  if (h < 0) h += 360;

  return { h, s: clamp01(s), l };
}

/** @returns {[number,number,number]} 0..255 */
export function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = clamp01(s);
  l = clamp01(l);

  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));

  let r, g, b;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const m = l - c / 2;
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

export function toHex([r, g, b]) {
  const h = (n) => n.toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const linearize = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/** WCAG 2.x relative luminance. */
export function relativeLuminance([r, g, b]) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/** WCAG 2.x contrast ratio, 1..21. Order-independent. */
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Polarity ───────────────────────────────────────────────────────────────

/**
 * Should the panel be light or dark for this page? Hysteretic: pass the CURRENT polarity
 * and a page must cross the far threshold to flip, so a borderline page cannot strobe.
 *
 * @param {[number,number,number]} dominant — the page's bulk colour
 * @param {'light'|'dark'} [previous]
 * @returns {'light'|'dark'}
 */
export function polarityFor(dominant, previous = 'dark') {
  const lum = relativeLuminance(dominant);
  return previous === 'light'
    ? (lum < POLARITY_LEAVE_LIGHT ? 'dark' : 'light')
    : (lum > POLARITY_ENTER_LIGHT ? 'light' : 'dark');
}

// ── The clamp ──────────────────────────────────────────────────────────────

/**
 * Force an arbitrary sampled colour into one polarity's surface band.
 * Hue is preserved (that's the tint); lightness and saturation are not.
 *
 * This is why a white page can now produce a white-ish panel: polarity picks the band,
 * and the band decides what "background" means. The old single dark band mapped every
 * page — pure white to pure black — into a 5% lightness sliver, so every site looked
 * like the same brown.
 *
 * @param {[number,number,number]} rgb
 * @param {number} [lift] — distance from the base surface, TOWARD the text (see BAND.dir)
 * @param {'light'|'dark'} [polarity]
 */
export function clampSurface(rgb, lift = 0, polarity = 'dark') {
  const cfg = BAND[polarity];
  const { h, s, l } = rgbToHsl(rgb[0], rgb[1], rgb[2]);

  // A near-grey page has no meaningful hue to keep — fall back to the warm base
  // rather than amplifying whatever rounding noise the screenshot left behind.
  const achromatic = s < 0.02;
  const hue = achromatic ? NEUTRAL_HUE : h;
  const sat = achromatic ? cfg.achroS : Math.min(Math.max(s, cfg.minS), cfg.maxS);
  const lum = Math.min(cfg.maxL, Math.max(cfg.minL, cfg.base + cfg.slope * l + cfg.dir * lift));

  return hslToRgb(hue, sat, lum);
}

const mixRgb = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

/**
 * Walk a colour's lightness until it clears `ratio` against `bg`, or runs out of room.
 * Bounded and deterministic — no search, just a fixed march.
 *
 * The brand terracotta clears 4.5:1 on the dark panel unchanged, but lands near 2.7:1 on a
 * light one. Rather than pick a second accent by hand, derive it: same hue, pushed until
 * it's legible.
 */
function pushUntilContrast(rgb, bg, ratio, dir) {
  let { h, s, l } = rgbToHsl(rgb[0], rgb[1], rgb[2]);
  for (let i = 0; i < 100; i++) {
    if (contrastRatio(hslToRgb(h, s, l), bg) >= ratio) break;
    const next = clamp01(l + dir * 0.01);
    if (next === l) break;   // hit 0 or 1; this is as far as the hue goes
    l = next;
  }
  return hslToRgb(h, s, l);
}

// ── Sampling ───────────────────────────────────────────────────────────────

/** 12-bit bucket key: 4 bits per channel. Coarse enough that anti-aliasing collapses. */
const binKey = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);

/** A colour is "characteristic" if it's saturated and neither blown out nor crushed. */
const isAccent = (r, g, b) => {
  const { s, l } = rgbToHsl(r, g, b);
  return s >= 0.25 && l >= 0.15 && l <= 0.85;
};

/**
 * Most-common colour bucket in a row range, returned as the true mean of its members.
 * Ties resolve to the first bucket seen (Map preserves insertion order) — deterministic.
 *
 * @returns {[number,number,number]|null} null when every pixel was filtered out.
 */
function dominantIn(data, width, rowStart, rowEnd, filter) {
  const buckets = new Map();

  for (let y = rowStart; y < rowEnd; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;

      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (filter && !filter(r, g, b)) continue;

      const k = binKey(r, g, b);
      let e = buckets.get(k);
      if (!e) { e = { n: 0, r: 0, g: 0, b: 0 }; buckets.set(k, e); }
      e.n++; e.r += r; e.g += g; e.b += b;
    }
  }

  if (buckets.size === 0) return null;

  let best = null;
  for (const e of buckets.values()) if (best === null || e.n > best.n) best = e;
  return [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
}

/**
 * How many horizontal slices of the page the gradient can draw its endpoints from.
 * The breath sweeps a cursor across these, so this is also the length of one cycle.
 */
export const BAND_COUNT = 5;

/**
 * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} image — RGBA
 * @returns {{bands: number[][], dominant: number[], accent: number[]}}
 *
 * `bands` are the page's horizontal slices, ordered top → bottom. The gradient's
 * endpoints ride a cursor over them, so the panel drifts through the page's vertical
 * colour flow rather than pinning to its extremes.
 *
 * `dominant` is the page's bulk colour — it anchors the surfaces that must NOT move.
 * `accent` is its characteristic hue (a brand red survives a 95%-white page).
 */
export function samplePalette(image) {
  const { data, width, height } = image;

  const dominant = dominantIn(data, width, 0, height) ?? [31, 29, 27];

  const bands = [];
  for (let i = 0; i < BAND_COUNT; i++) {
    const y0 = Math.floor((i * height) / BAND_COUNT);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((i + 1) * height) / BAND_COUNT)));
    bands.push(dominantIn(data, width, y0, y1) ?? dominant);
  }

  return {
    bands,
    dominant,
    accent: dominantIn(data, width, 0, height, isAccent) ?? dominant,
  };
}

// ── Tokens ─────────────────────────────────────────────────────────────────

/** The token names, in the order lerpTokens/tintCss walk them. All are rgb triples. */
const TOKEN_KEYS = [
  'bg', 'bgElevated', 'bgSubtle', 'border', 'borderSoft', 'scrollbar',
  'gradTop', 'gradMid', 'gradBot',
  'text', 'textMuted', 'textSubtle', 'accent', 'accentHover',
];

/**
 * Peak lightness swing of the breath, in clampSurface's lift units.
 *
 * Band-sweeping alone cannot move a UNIFORM page — a solid-colour site has no second
 * colour to drift toward, so every band is identical and the cursor sweeps through
 * nothing. This oscillation is what keeps such a page breathing. It must also exceed the
 * glue's noise deadband (~2/255 per channel), or small phases would be swallowed as
 * jitter and the panel would stutter instead of drift.
 */
export const BREATH_AMPLITUDE = 0.022;

const mod = (n, m) => ((n % m) + m) % m;

/**
 * Sample the band ring at a continuous, wrapping position — `x` need not be an integer.
 * Interpolating BETWEEN adjacent bands is what makes the sweep a drift rather than a
 * five-step slideshow.
 */
export function bandAt(bands, x) {
  const n = bands.length;
  const pos = mod(x, n);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = bands[i];
  const b = bands[(i + 1) % n];
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f));
}

/**
 * Palette → the panel's surface colours as raw rgb triples.
 * This is the lerpable form: the tint tweens between two of these, then renders.
 * Every entry passes through clampSurface, so every one clears its contrast floor.
 *
 * `phase` (in band units; one full cycle is BAND_COUNT) drives the breath. The gradient's
 * two endpoints ride the band ring half a cycle apart, so they cross and part like a
 * chest rising — while a counter-phased lightness swing keeps even a flat page moving.
 *
 * The surface tokens deliberately ignore `phase`. A drifting BACKGROUND is ambient; a
 * drifting border or card edge around the text you are reading is just nausea. Only the
 * gradient breathes.
 */
export function tintTokens(palette, phase = 0, polarity = 'dark') {
  const { bands, dominant, accent } = palette;
  const n = bands.length;
  const cfg = BAND[polarity];

  const swing = BREATH_AMPLITUDE * Math.sin((2 * Math.PI * phase) / n);
  const surface = (rgb, lift = 0) => clampSurface(rgb, lift, polarity);

  const bg = surface(dominant);
  const text = polarity === 'light' ? TEXT_ON_LIGHT : TEXT_ON_DARK;

  // The accent must be legible on whichever panel it landed on: lighten it on a dark
  // panel, darken it on a light one. `dir` already encodes "away from the background".
  const accentFg = pushUntilContrast(ACCENT_BASE, bg, ACCENT_MIN_CONTRAST, cfg.dir);
  const accentHsl = rgbToHsl(accentFg[0], accentFg[1], accentFg[2]);

  return {
    polarity,

    bg,
    bgElevated: surface(dominant, 0.035),
    bgSubtle: surface(dominant, 0.06),
    border: surface(dominant, 0.095),
    borderSoft: surface(dominant, 0.05),
    scrollbar: surface(dominant, -0.03),

    gradTop: surface(bandAt(bands, phase), 0.02 + swing),
    gradMid: surface(accent, 0.005),
    gradBot: surface(bandAt(bands, phase + n / 2), -0.015 - swing),

    text,
    textMuted: mixRgb(text, bg, MUTED_MIX[polarity]),
    textSubtle: mixRgb(text, bg, SUBTLE_MIX[polarity]),
    accent: accentFg,
    accentHover: hslToRgb(accentHsl.h, accentHsl.s, clamp01(accentHsl.l - 0.05)),
  };
}

/** Tokens → the CSS custom-property values the panel sets on :root. */
export function tintCss(tokens) {
  const { gradTop, gradMid, gradBot, accent } = tokens;
  const [ar, ag, ab] = accent;

  return {
    polarity: tokens.polarity,

    bg: toHex(tokens.bg),
    bgElevated: toHex(tokens.bgElevated),
    bgSubtle: toHex(tokens.bgSubtle),
    border: toHex(tokens.border),
    borderSoft: toHex(tokens.borderSoft),
    scrollbar: toHex(tokens.scrollbar),

    text: toHex(tokens.text),
    textMuted: toHex(tokens.textMuted),
    textSubtle: toHex(tokens.textSubtle),
    accent: toHex(accent),
    accentHover: toHex(tokens.accentHover),
    accentBg: `rgba(${ar}, ${ag}, ${ab}, 0.08)`,

    gradient: `linear-gradient(168deg, ${toHex(gradTop)} 0%, ${toHex(gradMid)} 52%, ${toHex(gradBot)} 100%)`,
  };
}

/** Palette → CSS in one step, at a given breath phase and polarity. */
export function tintFor(palette, phase = 0, polarity = 'dark') {
  return tintCss(tintTokens(palette, phase, polarity));
}

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

/**
 * Interpolate two token sets in sRGB. `t` is clamped to [0,1].
 *
 * Why sRGB is safe WITHIN a polarity, rather than merely convenient: relativeLuminance is
 * convex in sRGB (the v/12.92 leg's slope is below the ^2.4 leg's derivative at the join,
 * and x^2.4 is convex), so lum(lerp(a,b,t)) <= max(lum(a), lum(b)) for every t. Contrast
 * against a fixed foreground falls monotonically with background luminance. So a lerp
 * between two AAA-clearing backgrounds is itself AAA at every frame.
 *
 * ACROSS a polarity, that argument collapses — the foreground moves too. Interpolating a
 * dark-bg/light-text panel into a light-bg/dark-text one drags both through mid-grey,
 * where they meet at ~1:1 and the panel is briefly unreadable. There is no easing that
 * fixes it; the midpoint itself is the problem. So a flip SNAPS: this returns `b` outright.
 */
export function lerpTokens(a, b, t) {
  if (a.polarity !== b.polarity) return b;

  const k = clamp01(t);
  const out = { polarity: b.polarity };
  for (const key of TOKEN_KEYS) {
    const [ar, ag, ab] = a[key];
    const [br, bg, bb] = b[key];
    out[key] = [lerp(ar, br, k), lerp(ag, bg, k), lerp(ab, bb, k)];
  }
  return out;
}

/**
 * Are two token sets within `tol` on every channel, and the same polarity?
 *
 * JPEG noise and bucket-mean drift make a re-sample of an UNCHANGED page differ by a
 * unit or two. Without a deadband the panel would tween perpetually against sensor
 * noise — motion the page never actually made. A polarity flip is never "close",
 * however near the channels happen to land.
 */
export function tokensClose(a, b, tol = 2) {
  if (a.polarity !== b.polarity) return false;
  return TOKEN_KEYS.every((key) => a[key].every((v, i) => Math.abs(v - b[key][i]) <= tol));
}
