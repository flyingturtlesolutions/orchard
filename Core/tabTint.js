/**
 * @file Core/tabTint.js
 * @description v2.74.1433 — pure colour math for the active-tab background tint.
 *
 * The side panel samples a downscaled screenshot of the active tab and derives a
 * gradient from it. This module is the PURE half: pixels in → hex tokens out. No
 * DOM, no chrome.*, no canvas. The capture/apply half lives in Services/Chat/tabTint.js.
 *
 * SAMPLING reads a ring of eight cells around a 3x3 grid, so the page's spatial layout —
 * a left/right split, a hero band — reaches the gradient. Plus `dominant` (the bulk
 * colour, which anchors the surfaces) and `accent` (its characteristic hue).
 *
 * POLARITY is the first decision: a light page gets a light panel with dark text, a dark
 * page the reverse. Before that existed, the foreground was a fixed off-white and every
 * background had to stay dark enough to sit under it — which crushed pure white and pure
 * black into the same 5% lightness sliver, so every site rendered as the same brown.
 *
 * The CLAMP is the second. A sampled colour is fitted into its polarity's (wide) band, and
 * only then pushed away from the text until it clears its contrast floor. Solving for
 * contrast rather than assuming it is what lets a saturated purple stay purple instead of
 * washing out to white. tabTint.test.js asserts every floor against each polarity's OWN
 * text, which is what makes the clamp a contract rather than a guess.
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
 * The bands are WIDE, and deliberately: they only have to place a colour plausibly, since
 * clampSurface then solves for contrast rather than assuming it. Narrow bands were the
 * white-out bug — the light band spanned lightness 0.86..0.93 with saturation capped at
 * 0.22, so every page, purple or white, landed on the same near-white.
 */
const BAND = {
  dark:  { base: 0.06, slope: 0.22, dir: +1, minL: 0.05, maxL: 0.45, maxS: 0.55, minS: 0.06, achroS: 0.05 },
  light: { base: 0.55, slope: 0.40, dir: -1, minL: 0.45, maxL: 0.97, maxS: 0.55, minS: 0.04, achroS: 0.03 },
};

/**
 * Contrast a surface owes the text that sits on it. Backgrounds behind body copy hold AAA;
 * elevated/subtle cards hold AA (a lift moves TOWARD the text, spending contrast on
 * purpose); borders and the scrollbar carry no text and are exempt.
 */
const SURFACE_AAA = 7;
const SURFACE_AA = 4.5;
const SURFACE_NONE = 1;

/** The dark band's caps, exposed so the tests can assert against them by name. */
export const TINT_MAX_L = BAND.dark.maxL;
export const TINT_MAX_S = BAND.dark.maxS;

/** How far muted/subtle text travels from the foreground toward the background. */
const MUTED_MIX = { dark: 0.28, light: 0.30 };
const SUBTLE_MIX = { dark: 0.52, light: 0.45 };

/** Minimum contrast the accent must hold against the panel it sits on. */
const ACCENT_MIN_CONTRAST = 4.5;

/**
 * Opacity of the Rail's frosted background over the thread behind it.
 *
 * Contrast turns out not to constrain this at all: everything the Rail can sit over is a
 * surface from the same polarity band, so the composite lands in that band too and clears
 * AAA even at alpha 0.40 (worst case measured: 8.74:1 over bgSubtle). The value is chosen
 * for LOOK — clear enough that the gradient reads through, opaque enough that the frost
 * has a surface. tabTint.test.js pins the contrast bound anyway, so lowering it further
 * cannot quietly become a legibility bug.
 *
 * The blur contributes nothing to contrast — it destroys detail, not luminance. It does
 * mean the flat-surface model the test uses is the right one: a large-radius blur is a
 * local average, which is exactly a flat surface.
 */
export const RAIL_ALPHA = 0.55;

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

/**
 * The single rounding point. Channels are carried as FLOATS through interpolation — see
 * lerpTokens — and are quantised to 8 bits only here, on the way to CSS.
 */
export function toHex([r, g, b]) {
  const h = (n) => Math.min(255, Math.max(0, Math.round(n))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

const linearize = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/** Inverse of `linearize`: linear-light 0..1 back to an sRGB channel 0..255 (float). */
const delinearize = (u) => {
  const v = u <= 0.0031308 ? u * 12.92 : 1.055 * Math.pow(u, 1 / 2.4) - 0.055;
  return v * 255;
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

/** The foreground a polarity ships with. Every surface is measured against this. */
const textFor = (polarity) => (polarity === 'light' ? TEXT_ON_LIGHT : TEXT_ON_DARK);

/**
 * Force an arbitrary sampled colour into one polarity's surface band.
 * Hue is preserved (that's the tint); lightness and saturation are re-fitted.
 *
 * Two stages, and the second is why a purple page no longer renders as white.
 *
 *   1. Map the source lightness through the polarity's band, and cap saturation. The band
 *      is WIDE — a light panel spans lightness 0.45..0.97 — so a page's own light/dark
 *      structure survives instead of collapsing onto a single value.
 *   2. Only then enforce contrast, by pushing the colour AWAY from the text until it
 *      clears `minContrast`. Nothing is crushed pre-emptively.
 *
 * The previous version had no stage 2, so stage 1 had to be conservative enough to be
 * safe for every input: base 0.86, slope 0.07, saturation capped at 0.22. That mapped a
 * saturated purple (#8000be) to #ede7f0 — hue intact, everything else gone. Solving for
 * contrast instead of assuming it lets the same purple land near #c79add, which still
 * clears 7:1 against the dark text.
 *
 * @param {[number,number,number]} rgb
 * @param {number} [lift] — distance from the base surface, TOWARD the text (see BAND.dir)
 * @param {'light'|'dark'} [polarity]
 * @param {number} [minContrast] — floor against this polarity's text; SURFACE_NONE to skip
 */
export function clampSurface(rgb, lift = 0, polarity = 'dark', minContrast = SURFACE_AAA) {
  const cfg = BAND[polarity];
  const { h, s, l } = rgbToHsl(rgb[0], rgb[1], rgb[2]);

  // A near-grey page has no meaningful hue to keep — fall back to the warm base
  // rather than amplifying whatever rounding noise the screenshot left behind.
  const achromatic = s < 0.02;
  const hue = achromatic ? NEUTRAL_HUE : h;
  const sat = achromatic ? cfg.achroS : Math.min(Math.max(s, cfg.minS), cfg.maxS);
  const lum = Math.min(cfg.maxL, Math.max(cfg.minL, cfg.base + cfg.slope * l + cfg.dir * lift));

  const fitted = hslToRgb(hue, sat, lum);
  if (minContrast <= SURFACE_NONE) return fitted;

  // `dir` points toward the text; contrast is bought by moving the other way.
  return pushUntilContrast(fitted, textFor(polarity), minContrast, -cfg.dir);
}

const mixRgb = (a, b, t) => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t));

/**
 * `fg` at `alpha` painted over `bg` — what the browser actually renders for a translucent
 * surface like the Rail.
 *
 * Blends in sRGB, NOT linear light, and that asymmetry with lerpTokens is deliberate: CSS
 * alpha compositing is defined on the encoded channels, so matching the renderer matters
 * more here than the affine-luminance property we exploit when interpolating.
 */
export function compositeOver(fg, alpha, bg) {
  const a = clamp01(alpha);
  return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
}

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
 * Most-common colour bucket in a rect, returned as the true mean of its members.
 * Ties resolve to the first bucket seen (Map preserves insertion order) — deterministic.
 *
 * @returns {[number,number,number]|null} null when every pixel was filtered out.
 */
function dominantIn(data, width, rect, filter) {
  const { x0, x1, y0, y1 } = rect;
  const buckets = new Map();

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
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
 * The page is diced into a 3x3 grid and the gradient draws from the RING of eight cells
 * around it, clockwise from the top-left.
 *
 * It used to be five horizontal bands, which was blind to horizontal structure: on a page
 * split left/right — a sidebar, a split hero — every row is the same mixture, so every
 * band returned the same modal colour and the gradient came out flat. A ring sees both
 * axes. It is also cyclic and spatially adjacent, so the breath sweeps neighbours and
 * wraps without a seam, and opposite ring positions (i, i+4) are opposite corners — which
 * is exactly what the gradient's two endpoints want.
 *
 * The centre cell is left out on purpose: it is where `dominant` already looks.
 */
const RING = [[0, 0], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]];

/** Length of one full breath cycle, in region units. */
export const REGION_COUNT = RING.length;

/**
 * @param {{data: Uint8ClampedArray|number[], width: number, height: number}} image — RGBA
 * @returns {{regions: number[][], dominant: number[], accent: number[]}}
 *
 * `regions` are the ring cells, in ring order. The gradient's endpoints ride a cursor
 * over them, so the panel drifts through the page's actual spatial colour layout.
 *
 * `dominant` is the page's bulk colour — it anchors the surfaces that must NOT move.
 * `accent` is its characteristic hue (a brand red survives a 95%-white page).
 */
export function samplePalette(image) {
  const { data, width, height } = image;

  const full = { x0: 0, x1: width, y0: 0, y1: height };
  const dominant = dominantIn(data, width, full) ?? [31, 29, 27];

  const edge = (n, total) => {
    const a = Math.floor((n * total) / 3);
    const b = Math.min(total, Math.max(a + 1, Math.floor(((n + 1) * total) / 3)));
    return [a, b];
  };

  const regions = RING.map(([cx, cy]) => {
    const [x0, x1] = edge(cx, width);
    const [y0, y1] = edge(cy, height);
    return dominantIn(data, width, { x0, x1, y0, y1 }) ?? dominant;
  });

  return {
    regions,
    dominant,
    accent: dominantIn(data, width, full, isAccent) ?? dominant,
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
 * nothing. This oscillation is what keeps such a page breathing. It also has to clear
 * one rounded colour step (~1/255), or the swing would quantise away to nothing and the
 * panel would sit still on exactly the pages that need it most.
 */
export const BREATH_AMPLITUDE = 0.022;

const mod = (n, m) => ((n % m) + m) % m;

/**
 * Sample the region ring at a continuous, wrapping position — `x` need not be an integer.
 * Interpolating BETWEEN adjacent cells is what makes the sweep a drift rather than an
 * eight-step slideshow, and the ring's neighbours are spatial neighbours, so the blend is
 * between colours that actually touch on the page.
 */
export function regionAt(regions, x) {
  const n = regions.length;
  const pos = mod(x, n);
  const i = Math.floor(pos);
  const f = pos - i;
  const a = regions[i];
  const b = regions[(i + 1) % n];
  return [0, 1, 2].map((c) => Math.round(a[c] + (b[c] - a[c]) * f));
}

/**
 * Palette → the panel's surface colours as raw rgb triples.
 * This is the lerpable form: the tint tweens between two of these, then renders.
 * Every entry passes through clampSurface, so every one clears its contrast floor.
 *
 * `phase` (in region units; one full cycle is REGION_COUNT) drives the breath. The gradient's
 * two endpoints ride the band ring half a cycle apart, so they cross and part like a
 * chest rising — while a counter-phased lightness swing keeps even a flat page moving.
 *
 * The surface tokens deliberately ignore `phase`. A drifting BACKGROUND is ambient; a
 * drifting border or card edge around the text you are reading is just nausea. Only the
 * gradient breathes.
 */
export function tintTokens(palette, phase = 0, polarity = 'dark') {
  const { regions, dominant, accent } = palette;
  const n = regions.length;
  const cfg = BAND[polarity];

  const swing = BREATH_AMPLITUDE * Math.sin((2 * Math.PI * phase) / n);
  const surface = (rgb, lift = 0, minContrast = SURFACE_AAA) => clampSurface(rgb, lift, polarity, minContrast);

  const bg = surface(dominant);
  const text = textFor(polarity);

  // The accent must be legible on whichever panel it landed on: lighten it on a dark
  // panel, darken it on a light one. `dir` already encodes "away from the background".
  const accentFg = pushUntilContrast(ACCENT_BASE, bg, ACCENT_MIN_CONTRAST, cfg.dir);
  const accentHsl = rgbToHsl(accentFg[0], accentFg[1], accentFg[2]);

  return {
    polarity,

    bg,
    bgElevated: surface(dominant, 0.035, SURFACE_AA),
    bgSubtle: surface(dominant, 0.06, SURFACE_AA),
    border: surface(dominant, 0.095, SURFACE_NONE),
    borderSoft: surface(dominant, 0.05, SURFACE_NONE),
    scrollbar: surface(dominant, -0.03, SURFACE_NONE),

    // Opposite ring positions are opposite corners of the page, so a left/right split
    // reads as a gradient rather than as one flat colour.
    gradTop: surface(regionAt(regions, phase), 0.02 + swing),
    gradMid: surface(accent, 0.005),
    gradBot: surface(regionAt(regions, phase + n / 2), -0.015 - swing),

    text,
    textMuted: mixRgb(text, bg, MUTED_MIX[polarity]),
    textSubtle: mixRgb(text, bg, SUBTLE_MIX[polarity]),
    accent: accentFg,
    accentHover: hslToRgb(accentHsl.h, accentHsl.s, clamp01(accentHsl.l - 0.05)),
  };
}

/** Round a float channel for use in an rgba() string. */
const ch = (n) => Math.min(255, Math.max(0, Math.round(n)));

/** Tokens → the CSS custom-property values the panel sets on :root. */
export function tintCss(tokens) {
  const { gradTop, gradMid, gradBot, accent, bgElevated } = tokens;
  const [ar, ag, ab] = accent;
  const [er, eg, eb] = bgElevated;

  return {
    polarity: tokens.polarity,

    bg: toHex(tokens.bg),
    bgElevated: toHex(tokens.bgElevated),

    // The Rail's frosted fill: the elevated surface, made translucent. Emitted as rgba
    // rather than left to color-mix() in CSS, which would compute to `transparent` — an
    // invisible Rail — anywhere the function is unsupported.
    railBg: `rgba(${ch(er)}, ${ch(eg)}, ${ch(eb)}, ${RAIL_ALPHA})`,
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

/** Blend one channel in LINEAR light, returning a float sRGB channel. */
const lerpChannel = (a, b, t) => delinearize(linearize(a) + (linearize(b) - linearize(a)) * t);

const copyTokens = (t) => {
  const out = { polarity: t.polarity };
  for (const key of TOKEN_KEYS) out[key] = [t[key][0], t[key][1], t[key][2]];
  return out;
};

/**
 * Interpolate two token sets. `t` is clamped to [0,1].
 *
 * DOES NOT ROUND. Channels stay floating point, and toHex quantises them on the way to
 * CSS. This is load-bearing for the exponential follower in Services/Chat/tabTint.js: it
 * advances by k = 1 - exp(-dt/tau) per frame, which at 60fps and tau=2200ms is ~0.0075.
 * Rounding each step would snap a 26-unit gap's 0.196-unit advance straight back to where
 * it started, and the follower would never move at all. Round once, at the end.
 *
 * BLENDS IN LINEAR LIGHT, and that is a correctness requirement, not a nicety. Luminance
 * is AFFINE in linear light, so lum(lerp(a,b,t)) sits exactly between lum(a) and lum(b);
 * contrast is monotone in luminance; therefore a blend of two surfaces that each clear a
 * floor clears it too, at every frame, in EITHER polarity.
 *
 * Blending in sRGB instead only bounds luminance from ABOVE (relativeLuminance is convex
 * there). That is the right direction on a dark panel, where lower luminance means more
 * contrast against light text — and the wrong one on a light panel, where a blend of two
 * surfaces sitting at exactly 7.00:1 can sag below the floor between them. It did.
 *
 * ACROSS a polarity, no interpolation is safe — the foreground moves too, and drags
 * through mid-grey to meet the background at ~1:1. So this refuses the job and returns
 * `b` outright. Crossing a polarity is flipTokens', which lerps the surfaces but CHOOSES
 * the foreground rather than blending it.
 */
export function lerpTokens(a, b, t) {
  if (a.polarity !== b.polarity) return b;

  const k = clamp01(t);
  if (k === 0) return copyTokens(a);   // exact endpoints; the linear round-trip is lossy at 1e-13
  if (k === 1) return copyTokens(b);

  const out = { polarity: b.polarity };
  for (const key of TOKEN_KEYS) {
    const [ar, ag, ab] = a[key];
    const [br, bg, bb] = b[key];
    out[key] = [lerpChannel(ar, br, k), lerpChannel(ag, bg, k), lerpChannel(ab, bb, k)];
  }
  return out;
}

/** The surfaces the foreground actually sits on. A flip frame is judged against all of them. */
const FLIP_SURFACES = ['bg', 'bgElevated', 'bgSubtle', 'gradTop', 'gradMid', 'gradBot'];

/**
 * The contrast at a flip's crossover — where the two foregrounds' curves meet. Not a knob:
 * it falls out of TEXT_ON_DARK and TEXT_ON_LIGHT, and measures 3.50:1. Used to scale the
 * secondary-text mix, so `headroom` is 0 exactly at the trough.
 */
const FLIP_FLOOR = 3.5;

/**
 * One frame of a POLARITY CROSSFADE — the transition lerpTokens refuses to make.
 *
 * The trick is that the foreground is not interpolated, it is CHOSEN. Surfaces lerp
 * normally; then each candidate text is scored by its worst contrast across every
 * surface it sits on, and the winner takes the frame. Early frames pick the old text,
 * late frames the new one, and the swap lands exactly at the crossover — the background
 * luminance where the two curves meet.
 *
 * That crossover is the transition's floor, and it is a fixed property of the two
 * foregrounds rather than a tuning choice: roughly 3.5:1, for a single frame, recovering
 * immediately on either side. Below the 7:1 the settled panel holds, but nowhere near the
 * ~1:1 that interpolating the text through mid-grey would produce.
 *
 * `polarity` flips with the text, so a caller keying CSS off it (the .tinted-light class,
 * and the accent palette it carries) switches on the same frame the background crosses.
 */
export function flipTokens(a, b, t) {   // v2.74.1433
  const k = clamp01(t);

  const frame = { };
  for (const key of TOKEN_KEYS) frame[key] = mixRgb(a[key], b[key], k);

  const worstAgainst = (text) => Math.min(...FLIP_SURFACES.map((key) => contrastRatio(frame[key], text)));
  const polarity = worstAgainst(TEXT_ON_LIGHT) >= worstAgainst(TEXT_ON_DARK) ? 'light' : 'dark';
  const text = polarity === 'light' ? TEXT_ON_LIGHT : TEXT_ON_DARK;

  frame.polarity = polarity;
  frame.text = text;

  // Secondary text is the foreground mixed TOWARD the background, which spends contrast
  // the flip's trough cannot afford: at the crossover the primary holds only ~3.5:1, and a
  // full mix would sink muted to ~2.2:1. So the mix shrinks with the headroom — muted and
  // subtle converge on the primary exactly where they must, and are untouched at rest
  // (a settled frame has 12:1+, so `headroom` saturates at 1 and this reduces to a no-op).
  const headroom = clamp01((contrastRatio(frame.bg, text) - FLIP_FLOOR) / (7 - FLIP_FLOOR));
  frame.textMuted = mixRgb(text, frame.bg, MUTED_MIX[polarity] * headroom);
  frame.textSubtle = mixRgb(text, frame.bg, SUBTLE_MIX[polarity] * headroom);

  // Re-derive rather than lerp: a lerped accent would sag through the middle exactly
  // where the background is least forgiving.
  frame.accent = pushUntilContrast(ACCENT_BASE, frame.bg, ACCENT_MIN_CONTRAST, BAND[polarity].dir);
  const { h, s, l } = rgbToHsl(frame.accent[0], frame.accent[1], frame.accent[2]);
  frame.accentHover = hslToRgb(h, s, clamp01(l - 0.05));

  return frame;
}

