// Core/tabTint.test.js — v2.74.1435 active-tab tint colour math (node --test). PURE.
// Run via the temp-dir ESM harness (npm test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  rgbToHsl, hslToRgb, toHex, relativeLuminance, contrastRatio,
  clampSurface, samplePalette, tintFor, tintTokens, tintCss,
  lerpTokens, flipTokens, regionAt, polarityFor, compositeOver,
  TEXT_ON_DARK, TEXT_ON_LIGHT, NEUTRAL_HUE, TINT_MAX_S, TINT_MAX_L, REGION_COUNT,
  POLARITY_ENTER_LIGHT, POLARITY_LEAVE_LIGHT, RAIL_ALPHA,
} from './tabTint.js';

/** Build a flat RGBA image; `rows` is an array of per-row [r,g,b] (or [r,g,b,a]). */
const imageFromRows = (rows, width) => {
  const height = rows.length;
  const data = new Uint8ClampedArray(width * height * 4);
  rows.forEach(([r, g, b, a = 255], y) => {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  });
  return { data, width, height };
};

/** Build an RGBA image from per-COLUMN colours — the shape the ring's horizontal axis needs. */
const imageFromCols = (cols, height) => {
  const width = cols.length;
  const data = new Uint8ClampedArray(width * height * 4);
  cols.forEach(([r, g, b, a = 255], x) => {
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a;
    }
  });
  return { data, width, height };
};

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

// A spread that deliberately includes the hostile cases: pure white (docs),
// pure black, and fully-saturated primaries (marketing pages).
const HOSTILE = [
  [255, 255, 255], [0, 0, 0], [128, 128, 128],
  [255, 0, 0], [0, 255, 0], [0, 0, 255],
  [255, 255, 0], [0, 255, 255], [255, 0, 255],
  [217, 119, 87], [31, 29, 27], [24, 119, 242], [255, 105, 180],
];

/** A page's palette, and the tokens it actually renders with (at its own polarity). */
const pageTokens = (rgb, phase = 0) => {
  const p = samplePalette(imageFromRows([rgb], 4));
  return tintTokens(p, phase, polarityFor(p.dominant));
};

describe('tabTint — colour space', () => {
  it('rgbToHsl → hslToRgb round-trips within rounding error', () => {
    for (const rgb of HOSTILE) {
      const { h, s, l } = rgbToHsl(...rgb);
      const back = hslToRgb(h, s, l);
      back.forEach((v, i) => assert.ok(Math.abs(v - rgb[i]) <= 1, `${rgb} → ${back}`));
    }
  });

  it('rgbToHsl: achromatic inputs report zero saturation, no NaN at the extremes', () => {
    for (const grey of [[0, 0, 0], [255, 255, 255], [128, 128, 128]]) {
      const { h, s, l } = rgbToHsl(...grey);
      assert.equal(s, 0);
      assert.equal(h, 0);
      assert.ok(Number.isFinite(l));
    }
  });

  it('toHex zero-pads each channel', () => {
    assert.equal(toHex([0, 0, 0]), '#000000');
    assert.equal(toHex([31, 29, 27]), '#1f1d1b');
    assert.equal(toHex([255, 255, 255]), '#ffffff');
  });

  // toHex is the ONLY place channels are quantised — interpolation carries floats.
  it('toHex rounds floats and clamps out-of-gamut channels', () => {
    assert.equal(toHex([0.6, 0.4, 30.5]), '#01001f');
    assert.equal(toHex([-3, 260, 128.2]), '#00ff80');
  });

  it('contrastRatio is order-independent and spans the WCAG range', () => {
    assert.ok(Math.abs(contrastRatio([0, 0, 0], [255, 255, 255]) - 21) < 0.01);
    assert.equal(contrastRatio([0, 0, 0], [255, 255, 255]), contrastRatio([255, 255, 255], [0, 0, 0]));
    assert.equal(contrastRatio([50, 50, 50], [50, 50, 50]), 1);
  });

  it('relativeLuminance matches WCAG anchors', () => {
    assert.ok(Math.abs(relativeLuminance([255, 255, 255]) - 1) < 1e-9);
    assert.equal(relativeLuminance([0, 0, 0]), 0);
  });
});

describe('tabTint — clampSurface (dark band)', () => {
  it('preserves hue but caps saturation and lightness, for every hostile input', () => {
    for (const rgb of HOSTILE) {
      const { h: hIn, s: sIn } = rgbToHsl(...rgb);
      const { h: hOut, s: sOut, l: lOut } = rgbToHsl(...clampSurface(rgb, 0, 'dark'));

      // Tolerances absorb one 8-bit round-trip, not slack in the clamp. Down in the
      // dark band the channel spread is small (d ~ 0.1, denom ~ 0.27), so a ±0.5/255
      // rounding error on each endpoint inflates the *derived* saturation by ~0.015.
      assert.ok(sOut <= TINT_MAX_S + 0.02, `sat ${sOut} for ${rgb}`);
      assert.ok(lOut <= TINT_MAX_L + 0.01, `lum ${lOut} for ${rgb}`);

      // Hue is only meaningful where the channels have room to differ. The dark band
      // floors at lightness 0.05, where the spread is 1-2/255 and hue is quantisation
      // noise — so only hold the tight bound once the output is out of the mud.
      if (sIn >= 0.02 && lOut > 0.12) {
        const dh = Math.abs(hOut - hIn);
        assert.ok(Math.min(dh, 360 - dh) < 6, `hue drift ${hIn} → ${hOut}`);
      }
    }
  });

  it('achromatic pages fall back to a warm neutral, not a cold grey', () => {
    for (const grey of [[255, 255, 255], [0, 0, 0], [128, 128, 128]]) {
      const out = clampSurface(grey, 0, 'dark');
      const { h, s } = rgbToHsl(...out);

      // The warmth ORDERING is the invariant. At the band floor (black in, lightness
      // 0.05) the channel spread collapses to 1/255 and hue is not merely noisy but
      // undefined — r == g == b reads back as hue 0. Only bound the hue where the
      // channels can actually express one.
      assert.ok(s > 0, 'a flat grey would read as screen, not paper');
      assert.ok(out[0] >= out[1] && out[1] >= out[2], `not warm: ${out}`);

      const spread = Math.max(...out) - Math.min(...out);
      if (spread >= 3) {
        const dh = Math.abs(h - NEUTRAL_HUE);
        assert.ok(Math.min(dh, 360 - dh) <= 15, `hue ${h} strayed out of the warm band`);
      }
    }
  });

  it('lift raises lightness monotonically', () => {
    const l = (lift) => rgbToHsl(...clampSurface([24, 119, 242], lift, 'dark')).l;
    assert.ok(l(0) < l(0.035));
    assert.ok(l(0.035) < l(0.06));
    assert.ok(l(0.06) < l(0.095));
  });

  it('lift cannot escape the band — the caps hold at the extremes', () => {
    assert.ok(rgbToHsl(...clampSurface([255, 255, 0], 5, 'dark')).l <= TINT_MAX_L + 0.01);
    // 0.04, not the 0.05 band floor: an 8-bit round-trip of a near-black channel reads back under it.
    assert.ok(rgbToHsl(...clampSurface([0, 0, 0], -5, 'dark')).l >= 0.04);
  });
});

describe('tabTint — polarity', () => {
  it('a white page picks the LIGHT panel, a black page the DARK one', () => {
    assert.equal(polarityFor([255, 255, 255]), 'light');
    assert.equal(polarityFor([250, 250, 250]), 'light');
    assert.equal(polarityFor([0, 0, 0]), 'dark');
    assert.equal(polarityFor([31, 29, 27]), 'dark');
  });

  // The whole point of this rework: a white page must actually LOOK white.
  it('a white page yields a light background and a dark foreground', () => {
    const t = pageTokens([255, 255, 255]);
    assert.equal(t.polarity, 'light');
    assert.ok(relativeLuminance(t.bg) > 0.7, `bg ${toHex(t.bg)} is not light`);
    assert.ok(relativeLuminance(t.text) < 0.1, `text ${toHex(t.text)} is not dark`);
    assert.deepEqual(t.text, TEXT_ON_LIGHT);
  });

  it('a dark page keeps the original dark panel and off-white text', () => {
    const t = pageTokens([20, 20, 24]);
    assert.equal(t.polarity, 'dark');
    assert.ok(relativeLuminance(t.bg) < 0.05, `bg ${toHex(t.bg)} is not dark`);
    assert.deepEqual(t.text, TEXT_ON_DARK);
  });

  // A single threshold would strobe the whole panel on a page hovering at the boundary.
  it('hysteresis: a page between the thresholds keeps the polarity it already had', () => {
    const between = hslToRgb(0, 0, 0.65);
    const lum = relativeLuminance(between);
    assert.ok(lum > POLARITY_LEAVE_LIGHT && lum < POLARITY_ENTER_LIGHT, `fixture lum ${lum} not between`);

    assert.equal(polarityFor(between, 'light'), 'light', 'must not flip out of light');
    assert.equal(polarityFor(between, 'dark'), 'dark', 'must not flip into light');
  });

  it('hysteresis still flips when the page crosses the FAR threshold', () => {
    assert.equal(polarityFor([255, 255, 255], 'dark'), 'light');
    assert.equal(polarityFor([0, 0, 0], 'light'), 'dark');
  });

  it('clampSurface lands the SAME input in opposite regions, per polarity', () => {
    const white = [255, 255, 255];
    assert.ok(relativeLuminance(clampSurface(white, 0, 'light')) > 0.7);
    assert.ok(relativeLuminance(clampSurface(white, 0, 'dark')) < 0.1);
  });

  // REGRESSION, the other half. The light band used to be base 0.86 / slope 0.07 with
  // saturation capped at 0.22, so a saturated purple (#8000be) came out #ede7f0 — hue
  // intact, everything else gone. Contrast is now SOLVED for rather than assumed.
  it('a saturated colour survives the light panel instead of washing out to white', () => {
    const purple = clampSurface([128, 0, 190], 0, 'light');
    const { h, s } = rgbToHsl(...purple);

    assert.ok(Math.abs(h - 280) < 8, `hue drifted to ${h.toFixed(0)}`);
    assert.ok(s > 0.35, `saturation collapsed to ${s.toFixed(2)} — this is the white-out bug`);
    assert.ok(contrastRatio(purple, TEXT_ON_LIGHT) >= 7, 'but it must still hold AAA');
  });

  it('a saturated colour survives the dark panel too', () => {
    const purple = clampSurface([128, 0, 190], 0, 'dark');
    const { h, s } = rgbToHsl(...purple);
    assert.ok(Math.abs(h - 280) < 8, `hue drifted to ${h.toFixed(0)}`);
    assert.ok(s > 0.35, `saturation collapsed to ${s.toFixed(2)}`);
    assert.ok(contrastRatio(purple, TEXT_ON_DARK) >= 7);
  });

  it('a lift always moves TOWARD the text, whichever way that is', () => {
    const page = [24, 119, 242];
    const lum = (pol, lift) => relativeLuminance(clampSurface(page, lift, pol));

    assert.ok(lum('dark', 0.06) > lum('dark', 0), 'dark panel: elevated is lighter');
    assert.ok(lum('light', 0.06) < lum('light', 0), 'light panel: elevated is darker');
  });
});

describe('tabTint — the readability contract', () => {
  // The foreground is no longer fixed, so every surface is measured against the text
  // its OWN polarity ships with. That is the contract the clamp has to keep.
  it('every page yields a base background at AAA (>= 7:1) against its own text', () => {
    for (const rgb of HOSTILE) {
      const t = pageTokens(rgb);
      const ratio = contrastRatio(t.bg, t.text);
      assert.ok(ratio >= 7, `${toHex(rgb)} [${t.polarity}] bg ${toHex(t.bg)} = ${ratio.toFixed(2)}:1`);
    }
  });

  it('elevated and subtle surfaces stay at AA (>= 4.5:1) against their own text', () => {
    for (const rgb of HOSTILE) {
      const t = pageTokens(rgb);
      for (const key of ['bgElevated', 'bgSubtle']) {
        const ratio = contrastRatio(t[key], t.text);
        assert.ok(ratio >= 4.5, `${toHex(rgb)} [${t.polarity}] ${key} = ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('holds across the full hue circle at full saturation — the worst case', () => {
    for (let h = 0; h < 360; h += 5) {
      const t = pageTokens(hslToRgb(h, 1, 0.5));
      const ratio = contrastRatio(t.bg, t.text);
      assert.ok(ratio >= 7, `hue ${h} [${t.polarity}] = ${ratio.toFixed(2)}:1`);
    }
  });

  // Message text sits over the gradient, not just over --c-bg, so each stop is a
  // background in its own right and owes the same floor.
  it('every gradient stop clears AAA too, not just the base token', () => {
    for (const rgb of HOSTILE) {
      const t = pageTokens(rgb);
      for (const key of ['gradTop', 'gradMid', 'gradBot']) {
        const ratio = contrastRatio(t[key], t.text);
        assert.ok(ratio >= 7, `${toHex(rgb)} [${t.polarity}] ${key} = ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('muted text holds AA, subtle text holds the large-text floor', () => {
    for (const rgb of HOSTILE) {
      const t = pageTokens(rgb);
      assert.ok(contrastRatio(t.textMuted, t.bg) >= 4.5, `${toHex(rgb)} muted`);
      assert.ok(contrastRatio(t.textSubtle, t.bg) >= 3, `${toHex(rgb)} subtle`);
    }
  });

  // The brand terracotta clears 4.5:1 on a dark panel unchanged and fails on a light
  // one, so it is derived per-polarity rather than fixed.
  it('the accent is pushed until it is legible on whichever panel it lands on', () => {
    for (const rgb of HOSTILE) {
      const t = pageTokens(rgb);
      const ratio = contrastRatio(t.accent, t.bg);
      assert.ok(ratio >= 4.5, `${toHex(rgb)} [${t.polarity}] accent ${toHex(t.accent)} = ${ratio.toFixed(2)}:1`);
    }
  });

  // The Rail is translucent over the thread, so its EFFECTIVE background is a composite.
  // The blur contributes nothing here — it destroys detail, not luminance — so the alpha
  // is the whole safety margin. Every surface the Rail can sit over must still work.
  it('the frosted Rail clears AAA over every surface it can overlay', () => {
    const BEHIND = ['bg', 'bgSubtle', 'bgElevated', 'gradTop', 'gradMid', 'gradBot'];

    for (const rgb of HOSTILE) {
      const t = pageTokens(rgb);
      for (const key of BEHIND) {
        const effective = compositeOver(t.bgElevated, RAIL_ALPHA, t[key]);
        const ratio = contrastRatio(effective, t.text);
        assert.ok(ratio >= 7, `${toHex(rgb)} [${t.polarity}] rail over ${key} = ${ratio.toFixed(2)}:1`);
      }
    }
  });

  it('the frosted Rail holds up mid-breath and mid-follow, not just at rest', () => {
    for (const rgb of HOSTILE) {
      for (let phase = 0; phase < REGION_COUNT; phase += 0.5) {
        const t = pageTokens(rgb, phase);
        const effective = compositeOver(t.bgElevated, RAIL_ALPHA, t.gradMid);
        assert.ok(contrastRatio(effective, t.text) >= 7, `${toHex(rgb)} phase=${phase}`);
      }
    }
  });

  it('compositeOver matches the browser: sRGB blend, endpoints exact', () => {
    const fg = [200, 100, 50];
    const bg = [0, 0, 0];
    assert.deepEqual(compositeOver(fg, 1, bg), fg);
    assert.deepEqual(compositeOver(fg, 0, bg), bg);
    assert.deepEqual(compositeOver([100, 100, 100], 0.5, [200, 200, 200]), [150, 150, 150]);
  });

  it('tintCss emits a railBg rgba derived from the resolved elevated surface', () => {
    const t = pageTokens([255, 255, 255]);
    const css = tintCss(t);
    const [r, g, b] = t.bgElevated.map((n) => Math.round(n));
    assert.equal(css.railBg, `rgba(${r}, ${g}, ${b}, ${RAIL_ALPHA})`);
  });

  it('tintCss emits an accentBg rgba derived from the resolved accent', () => {
    const t = pageTokens([255, 255, 255]);
    const css = tintCss(t);
    assert.equal(css.accentBg, `rgba(${t.accent[0]}, ${t.accent[1]}, ${t.accent[2]}, 0.08)`);
    assert.equal(css.polarity, 'light');
  });
});

describe('tabTint — samplePalette', () => {
  it('picks the most-common bucket, not the mean of the image', () => {
    // Three red rows, one blue: the mean would be purple; the mode is red.
    const img = imageFromRows([[200, 20, 20], [200, 20, 20], [200, 20, 20], [20, 20, 200]], 4);
    const { dominant } = samplePalette(img);
    assert.ok(dominant[0] > 150 && dominant[2] < 60, `got ${dominant}`);
  });

  it('averages within the winning bucket — near-identical shades collapse', () => {
    // Both rows land in the same 4-bit bucket; the result is their true mean.
    const img = imageFromRows([[200, 20, 20], [206, 26, 26]], 2);
    assert.deepEqual(samplePalette(img).dominant, [203, 23, 23]);
  });

  // v2.74.1435 — white votes at 52.5%, because most of the web is majority-white and an
  // unweighted mode hands every merely-half-colourful page to white.
  it('white LOSES a 50/50 split — its vote is discounted', () => {
    // 2 white rows (1.05 effective votes) vs 2 red rows (2.0): red must win.
    const img = imageFromRows([[255, 255, 255], [255, 255, 255], [200, 20, 20], [200, 20, 20]], 4);
    const { dominant } = samplePalette(img);
    assert.ok(dominant[0] > 150 && dominant[2] < 60, `got ${dominant} — white won a tie it should lose`);
  });

  it('white still wins a true majority — the discount is a thumb, not a veto', () => {
    // 3 white rows (1.575 effective) vs 1 red row (1.0): white holds.
    const img = imageFromRows([[255, 255, 255], [255, 255, 255], [255, 255, 255], [200, 20, 20]], 4);
    const { dominant } = samplePalette(img);
    assert.ok(dominant[0] > 240 && dominant[2] > 240, `got ${dominant} — a 75% white page must stay white`);
  });

  it('the weighted white bucket still averages to true white', () => {
    // Weighting must scale the sums with the votes, or the bucket mean drifts off-colour.
    const { dominant } = samplePalette(imageFromRows([[255, 255, 255]], 4));
    assert.deepEqual(dominant, [255, 255, 255]);
  });

  it('near-white below the top bucket votes at full weight', () => {
    // #ee (238) sits outside the >=240 white bucket: 50/50 against a colour, it WINS.
    const img = imageFromRows([[238, 238, 238], [238, 238, 238], [200, 20, 20], [200, 20, 20]], 4);
    const { dominant } = samplePalette(img);
    assert.ok(dominant[0] > 220 && dominant[2] > 220, `got ${dominant} — the discount leaked below the white bucket`);
  });

  it('the ring has eight cells and tracks vertical structure', () => {
    // ring order: TL TC TR RM BR BC BL LM — index 1 is top-centre, 5 is bottom-centre.
    const rows = [...Array(6).fill([250, 250, 250]), ...Array(6).fill([10, 10, 40])];
    const { regions } = samplePalette(imageFromRows(rows, 6));

    assert.equal(regions.length, REGION_COUNT);
    assert.equal(REGION_COUNT, 8);
    assert.ok(regions[1][0] > 200, `top-centre ${regions[1]} should be white`);
    assert.ok(regions[5][2] > regions[5][0], `bottom-centre ${regions[5]} should be blue`);
  });

  // REGRESSION. Bands were horizontal, so on a page split LEFT/RIGHT every row held the
  // same mixture, every band returned the same modal colour, and the gradient came out
  // flat. A 50% white / 50% purple page rendered as all white.
  it('the ring tracks HORIZONTAL structure — a left/right split is not flat', () => {
    const W = 6, H = 6;
    const { regions } = samplePalette(imageFromCols(
      Array.from({ length: W }, (_, x) => (x < W / 2 ? [255, 255, 255] : [128, 0, 190])), H));

    // ring index 0 is top-LEFT, index 2 is top-RIGHT: opposite sides of the split.
    assert.ok(regions[0][0] > 200 && regions[0][2] > 200, `top-left ${regions[0]} should be white`);
    assert.ok(regions[2][2] > 150 && regions[2][1] < 60, `top-right ${regions[2]} should be purple`);

    const distinct = new Set(regions.map((r) => r.join(','))).size;
    assert.ok(distinct > 1, 'a split page must not produce eight identical cells');
  });

  it('opposite ring positions are opposite corners — the gradient endpoints', () => {
    const W = 6, H = 6;
    const p = samplePalette(imageFromCols(
      Array.from({ length: W }, (_, x) => (x < W / 2 ? [255, 255, 255] : [128, 0, 190])), H));

    // gradTop rides phase, gradBot rides phase + n/2 — so they must disagree here.
    assert.notDeepEqual(p.regions[0], p.regions[4], 'ring[0] and ring[4] should be opposite corners');
  });

  it('regions survive an image smaller than the grid — no empty cell, no throw', () => {
    const { regions } = samplePalette(imageFromRows([[200, 20, 20], [20, 20, 200]], 2));
    assert.equal(regions.length, REGION_COUNT);
    for (const r of regions) assert.ok(r.every(Number.isFinite), `bad region ${r}`);
  });

  it('accent finds the characteristic hue on an overwhelmingly white page', () => {
    // 7 white rows, 1 brand-red row: dominant is white, accent is the red.
    const rows = [...Array(7).fill([255, 255, 255]), [220, 30, 30]];
    const { dominant, accent } = samplePalette(imageFromRows(rows, 4));
    assert.ok(dominant[0] > 240 && dominant[2] > 240, `dominant ${dominant}`);
    assert.ok(accent[0] > 180 && accent[2] < 70, `accent ${accent}`);
  });

  it('accent falls back to dominant when nothing is saturated enough', () => {
    const { dominant, accent } = samplePalette(imageFromRows([[250, 250, 250]], 4));
    assert.deepEqual(accent, dominant);
  });

  it('skips transparent pixels', () => {
    // A fully-transparent red row must not outvote the opaque blue one.
    const rows = [[255, 0, 0, 0], [255, 0, 0, 0], [20, 20, 200, 255]];
    const { dominant } = samplePalette(imageFromRows(rows, 4));
    assert.ok(dominant[2] > 150 && dominant[0] < 60, `got ${dominant}`);
  });

  it('an all-transparent image degrades to the default base rather than throwing', () => {
    const { dominant, accent } = samplePalette(imageFromRows([[9, 9, 9, 0]], 4));
    assert.deepEqual(dominant, [31, 29, 27]);
    assert.deepEqual(accent, [31, 29, 27]);
  });
});

describe('tabTint — tintFor', () => {
  it('emits a three-stop gradient of hex stops', () => {
    const { gradient } = tintFor(samplePalette(imageFromRows([[24, 119, 242]], 4)));
    assert.match(gradient, /^linear-gradient\(168deg, #[0-9a-f]{6} 0%, #[0-9a-f]{6} 52%, #[0-9a-f]{6} 100%\)$/);
  });

  it('orders the surface tokens light-over-dark, so elevation reads correctly', () => {
    const t = tintFor(samplePalette(imageFromRows([[24, 119, 242]], 4)));
    const lum = (hex) => relativeLuminance(hexToRgb(hex));
    assert.ok(lum(t.scrollbar) < lum(t.bg));
    assert.ok(lum(t.bg) < lum(t.bgElevated));
    assert.ok(lum(t.bgElevated) < lum(t.bgSubtle));
    assert.ok(lum(t.bgSubtle) < lum(t.border));
  });

  it('is deterministic — the same pixels yield the same tokens', () => {
    const img = imageFromRows([[24, 119, 242], [200, 20, 20]], 4);
    assert.deepEqual(tintFor(samplePalette(img)), tintFor(samplePalette(img)));
  });

  it('tintFor is exactly tintCss ∘ tintTokens', () => {
    const p = samplePalette(imageFromRows([[24, 119, 242], [200, 20, 20]], 4));
    assert.deepEqual(tintFor(p), tintCss(tintTokens(p)));
  });
});

describe('tabTint — the breath', () => {
  // A page with real vertical structure, and one with none. The breath must move both.
  const STRIPED = imageFromRows([[240, 240, 250], [200, 60, 60], [60, 160, 90], [40, 40, 120], [20, 20, 30]], 4);
  const UNIFORM = imageFromRows([[40, 90, 160]], 4);

  it('regionAt wraps around the ring and interpolates between neighbours', () => {
    const regions = [[0, 0, 0], [100, 100, 100], [200, 200, 200]];

    assert.deepEqual(regionAt(regions, 0), [0, 0, 0]);
    assert.deepEqual(regionAt(regions, 1), [100, 100, 100]);
    assert.deepEqual(regionAt(regions, 0.5), [50, 50, 50]);
    assert.deepEqual(regionAt(regions, 3), [0, 0, 0], 'a full cycle returns to the start');
    assert.deepEqual(regionAt(regions, -1), [200, 200, 200], 'negative phase wraps backwards');
    assert.deepEqual(regionAt(regions, 2.5), [100, 100, 100], 'the last band wraps into the first');
  });

  it('sweeping the phase moves the gradient on a structured page', () => {
    const p = samplePalette(STRIPED);
    const at = (phase) => tintFor(p, phase).gradient;
    assert.notEqual(at(0), at(1));
    assert.notEqual(at(1), at(2));
  });

  // The reason BREATH_AMPLITUDE exists: band-sweeping alone is a no-op here.
  it('breathes even on a UNIFORM page, where every band is identical', () => {
    const p = samplePalette(UNIFORM);
    assert.ok(p.regions.every((b) => b.every((v, i) => v === p.regions[0][i])), 'fixture must be uniform');

    const quarter = REGION_COUNT / 4;   // sin peaks here — maximum swing from phase 0
    assert.notEqual(tintFor(p, 0).gradient, tintFor(p, quarter).gradient);
  });

  // The swing has to survive 8-bit rounding. Below one colour step it quantises to
  // nothing, and the panel sits perfectly still on exactly the pages that need it most.
  it('a peak-to-zero swing moves the gradient by more than one rounded colour step', () => {
    const p = samplePalette(UNIFORM);
    const a = tintTokens(p, 0, 'dark');
    const b = tintTokens(p, REGION_COUNT / 4, 'dark');

    const maxDelta = (key) => Math.max(...[0, 1, 2].map((i) => Math.abs(a[key][i] - b[key][i])));
    assert.ok(maxDelta('gradTop') >= 2, `gradTop moved only ${maxDelta('gradTop')}/255`);
    assert.ok(maxDelta('gradBot') >= 2, `gradBot moved only ${maxDelta('gradBot')}/255`);
  });

  it('the phase is cyclic — a full cycle returns to the same tint', () => {
    const p = samplePalette(STRIPED);
    assert.deepEqual(tintTokens(p, 0), tintTokens(p, REGION_COUNT));
    assert.deepEqual(tintTokens(p, 1.5), tintTokens(p, 1.5 + REGION_COUNT));
  });

  it('only the gradient breathes — surfaces stay pinned across every phase', () => {
    const p = samplePalette(STRIPED);
    const base = tintTokens(p, 0);
    for (let phase = 0; phase < REGION_COUNT; phase += 0.25) {
      const t = tintTokens(p, phase);
      for (const key of ['bg', 'bgElevated', 'bgSubtle', 'border', 'borderSoft', 'scrollbar']) {
        assert.deepEqual(t[key], base[key], `${key} moved at phase ${phase}`);
      }
    }
  });

  it('NO phase of the breath dips below AAA, for any page colour, at its own polarity', () => {
    for (const rgb of HOSTILE) {
      for (let phase = 0; phase < REGION_COUNT; phase += 0.25) {
        const t = pageTokens(rgb, phase);
        for (const key of ['bg', 'gradTop', 'gradMid', 'gradBot']) {
          const ratio = contrastRatio(t[key], t.text);
          assert.ok(ratio >= 7, `${toHex(rgb)} [${t.polarity}] phase=${phase} ${key} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
  });

  it('the breath holds AAA on a structured page, in BOTH polarities', () => {
    const p = samplePalette(STRIPED);
    for (const polarity of ['dark', 'light']) {
      for (let phase = 0; phase < REGION_COUNT; phase += 0.1) {
        const t = tintTokens(p, phase, polarity);
        for (const key of ['gradTop', 'gradMid', 'gradBot']) {
          const ratio = contrastRatio(t[key], t.text);
          assert.ok(ratio >= 7, `[${polarity}] phase=${phase.toFixed(1)} ${key} = ${ratio.toFixed(2)}:1`);
        }
      }
    }
  });
});

describe('tabTint — tween (dynamic resample)', () => {
  const tokensOf = (rgb) => tintTokens(samplePalette(imageFromRows([rgb], 4)), 0, 'dark');

  it('lerpTokens hits both endpoints exactly and clamps t outside [0,1]', () => {
    const a = tokensOf([24, 119, 242]);
    const b = tokensOf([200, 20, 20]);

    assert.deepEqual(lerpTokens(a, b, 0), a);
    assert.deepEqual(lerpTokens(a, b, 1), b);
    assert.deepEqual(lerpTokens(a, b, -5), a);
    assert.deepEqual(lerpTokens(a, b, 5), b);
  });

  // REGRESSION. lerpTokens used to round each channel. The follower advances by
  // k = 1 - exp(-dt/tau) ≈ 0.0075 per frame at 60fps/2200ms, so a 26-unit gap moves 0.196
  // and Math.round snapped it straight back: the panel never moved at all. Floats now,
  // quantised once in toHex.
  it('lerpTokens does not round — a sub-unit step survives, and iterating converges', () => {
    const a = tokensOf([20, 40, 200]);
    const b = tokensOf([200, 30, 20]);
    const k = 1 - Math.exp(-16.67 / 2200);   // one 60fps frame at the follower's time constant

    const oneFrame = lerpTokens(a, b, k);
    assert.notDeepEqual(oneFrame.bg, a.bg, 'a single follower frame must move the background');

    // ~10s of frames is >3 time constants; the gap must close to under one colour step.
    let cur = a;
    for (let i = 0; i < 600; i++) cur = lerpTokens(cur, b, k);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(cur.bg[i] - b.bg[i]) < 1, `channel ${i} stalled at ${cur.bg[i]} (target ${b.bg[i]})`);
    }
  });

  it('the follower is frame-rate independent — same trajectory at 30, 60 and 144fps', () => {
    const a = tokensOf([20, 40, 200]);
    const b = tokensOf([200, 30, 20]);
    const TAU = 2200;

    // Advance each rate to the same WALL-CLOCK time; the results must agree.
    const after = (fps, ms) => {
      const dt = 1000 / fps;
      let cur = a;
      for (let t = 0; t < ms; t += dt) cur = lerpTokens(cur, b, 1 - Math.exp(-dt / TAU));
      return cur.bg[0];
    };

    const at60 = after(60, TAU);
    assert.ok(Math.abs(after(144, TAU) - at60) < 1, '144fps diverged from 60fps');
    assert.ok(Math.abs(after(30, TAU) - at60) < 1, '30fps diverged from 60fps');

    // One time constant closes ~63% of the gap — IN LINEAR LIGHT, which is where
    // lerpTokens blends. Measured in sRGB the same motion reads as ~74%, because gamma.
    const lin = (c) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const closed = (lin(at60) - lin(a.bg[0])) / (lin(b.bg[0]) - lin(a.bg[0]));
    assert.ok(Math.abs(closed - (1 - 1 / Math.E)) < 0.02, `closed ${closed.toFixed(3)} of the gap at tau (linear)`);
  });

  it('lerpTokens moves every token monotonically toward the target', () => {
    const a = tokensOf([10, 10, 10]);
    const b = tokensOf([255, 255, 0]);
    const mid = lerpTokens(a, b, 0.5);

    for (const key of Object.keys(a).filter((k) => k !== 'polarity')) {
      for (let i = 0; i < 3; i++) {
        const [lo, hi] = a[key][i] <= b[key][i] ? [a[key][i], b[key][i]] : [b[key][i], a[key][i]];
        assert.ok(mid[key][i] >= lo && mid[key][i] <= hi, `${key}[${i}] ${mid[key][i]} left [${lo},${hi}]`);
      }
    }
  });

  // The load-bearing property. Intermediate frames are backgrounds too, and no test
  // could enumerate them — so lean on convexity of luminance instead of sampling luck.
  it('NO frame of a same-polarity tween dips below AAA — luminance is convex in sRGB', () => {
    for (const polarity of ['dark', 'light']) {
      for (const from of HOSTILE) {
        for (const to of HOSTILE) {
          const mk = (rgb) => tintTokens(samplePalette(imageFromRows([rgb], 4)), 0, polarity);
          const a = mk(from);
          const b = mk(to);
          for (let t = 0; t <= 1.0001; t += 0.05) {
            const frame = lerpTokens(a, b, t);
            for (const key of ['bg', 'gradTop', 'gradMid', 'gradBot']) {
              const ratio = contrastRatio(frame[key], frame.text);
              assert.ok(ratio >= 7, `[${polarity}] ${toHex(from)}→${toHex(to)} t=${t.toFixed(2)} ${key} = ${ratio.toFixed(2)}:1`);
            }
          }
        }
      }
    }
  });

  // lerpTokens still refuses a flip — crossing polarity is flipTokens' job, and a caller
  // that reaches for the wrong one gets the target rather than an unreadable blend.
  it('lerpTokens refuses to interpolate across a polarity — it returns the target', () => {
    const dark = pageTokens([10, 10, 12]);
    const light = pageTokens([255, 255, 255]);
    assert.notEqual(dark.polarity, light.polarity, 'fixtures must straddle the flip');

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      assert.deepEqual(lerpTokens(dark, light, t), light, `t=${t} must already be the target`);
    }
  });

});

describe('tabTint — the polarity crossfade', () => {
  const SURFACES = ['bg', 'bgElevated', 'bgSubtle', 'gradTop', 'gradMid', 'gradBot'];
  const FLIPS = [
    ['black → white', [0, 0, 0], [255, 255, 255]],
    ['blue → white', [24, 119, 242], [250, 250, 250]],
    ['dark grey → light grey', [30, 30, 30], [240, 240, 240]],
    ['red → white', [255, 0, 0], [255, 255, 255]],
  ];

  /** Worst contrast the foreground holds against any surface it sits on, this frame. */
  const worstOfFrame = (f) => Math.min(...SURFACES.map((k) => contrastRatio(f[k], f.text)));

  it('reproduces both endpoints exactly — a flip starts and lands where it should', () => {
    for (const [name, from, to] of FLIPS) {
      const a = pageTokens(from);
      const b = pageTokens(to);
      assert.deepEqual(flipTokens(a, b, 0), a, `${name} t=0`);
      assert.deepEqual(flipTokens(a, b, 1), b, `${name} t=1`);
    }
  });

  // The floor is a PROPERTY of the two foregrounds, not a tuning choice: it is the
  // background luminance where the two contrast curves cross. Measured at 3.50:1.
  it('never drops below 3.4:1 at any frame — the crossover is the floor', () => {
    for (const [name, from, to] of FLIPS) {
      const a = pageTokens(from);
      const b = pageTokens(to);
      for (let t = 0; t <= 1.0001; t += 0.01) {
        const ratio = worstOfFrame(flipTokens(a, b, t));
        assert.ok(ratio >= 3.4, `${name} t=${t.toFixed(2)} = ${ratio.toFixed(2)}:1`);
      }
    }
  });

  // Guards the whole point of choosing the text instead of lerping it. A lerped
  // foreground bottoms out near 1:1; this must stay far above that.
  it('beats a naive lerp of the foreground by a wide margin at the midpoint', () => {
    const a = pageTokens([0, 0, 0]);
    const b = pageTokens([255, 255, 255]);

    const chosen = worstOfFrame(flipTokens(a, b, 0.5));
    const naiveBg = [0, 1, 2].map((i) => Math.round((a.bg[i] + b.bg[i]) / 2));
    const naiveText = [0, 1, 2].map((i) => Math.round((a.text[i] + b.text[i]) / 2));
    const naive = contrastRatio(naiveBg, naiveText);

    assert.ok(naive < 1.5, `sanity: a lerped foreground really is unreadable (${naive.toFixed(2)}:1)`);
    assert.ok(chosen > 3, `chosen foreground held ${chosen.toFixed(2)}:1`);
  });

  it('the text swaps exactly once, and monotonically — no flicker back and forth', () => {
    for (const [name, from, to] of FLIPS) {
      const a = pageTokens(from);
      const b = pageTokens(to);

      let swaps = 0;
      let prev = flipTokens(a, b, 0).polarity;
      for (let t = 0; t <= 1.0001; t += 0.005) {
        const p = flipTokens(a, b, t).polarity;
        if (p !== prev) { swaps++; prev = p; }
      }
      assert.equal(swaps, 1, `${name} swapped ${swaps} times`);
      assert.equal(prev, b.polarity, `${name} did not end on the target polarity`);
    }
  });

  it('polarity tracks the text, so .tinted-light switches on the crossover frame', () => {
    const a = pageTokens([0, 0, 0]);
    const b = pageTokens([255, 255, 255]);
    for (const t of [0, 0.2, 0.5, 0.8, 1]) {
      const f = flipTokens(a, b, t);
      const expected = f.text === TEXT_ON_LIGHT ? 'light' : 'dark';
      assert.equal(f.polarity, expected, `t=${t} polarity disagrees with its own text`);
    }
  });

  // Secondary text is the foreground mixed toward the background, so at the crossover —
  // where the foreground itself only holds 3.5:1 — a full mix would sink it to ~2.2:1.
  // flipTokens shrinks the mix as headroom shrinks, so muted converges on the primary
  // text exactly where it must, and returns to its normal weight once the flip lands.
  it('muted, subtle and accent are re-derived per frame, never left sagging', () => {
    const a = pageTokens([0, 0, 0]);
    const b = pageTokens([255, 255, 255]);
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const f = flipTokens(a, b, t);
      assert.ok(contrastRatio(f.accent, f.bg) >= 4.5, `t=${t.toFixed(2)} accent sagged`);
      assert.ok(contrastRatio(f.textMuted, f.bg) >= 3, `t=${t.toFixed(2)} muted sagged`);
      assert.ok(contrastRatio(f.textSubtle, f.bg) >= 2.5, `t=${t.toFixed(2)} subtle sagged`);
    }
  });

  it('at rest the mix is untouched — a settled flip matches tintTokens exactly', () => {
    const a = pageTokens([0, 0, 0]);
    const b = pageTokens([255, 255, 255]);
    assert.deepEqual(flipTokens(a, b, 1).textMuted, b.textMuted);
    assert.deepEqual(flipTokens(a, b, 1).textSubtle, b.textSubtle);
  });
});
