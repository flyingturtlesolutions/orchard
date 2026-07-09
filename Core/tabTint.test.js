// Core/tabTint.test.js — v2.74.1416 active-tab tint colour math (node --test). PURE.
// Run via the temp-dir ESM harness (npm test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  rgbToHsl, hslToRgb, toHex, relativeLuminance, contrastRatio,
  clampSurface, samplePalette, tintFor, tintTokens, tintCss,
  lerpTokens, tokensClose, bandAt, polarityFor,
  TEXT_ON_DARK, TEXT_ON_LIGHT, NEUTRAL_HUE, TINT_MAX_S, TINT_MAX_L, BAND_COUNT,
  POLARITY_ENTER_LIGHT, POLARITY_LEAVE_LIGHT,
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
      if (sIn >= 0.02) {
        const dh = Math.abs(hOut - hIn);
        assert.ok(Math.min(dh, 360 - dh) < 6, `hue drift ${hIn} → ${hOut}`);
      }
    }
  });

  it('achromatic pages fall back to a warm neutral, not a cold grey', () => {
    for (const grey of [[255, 255, 255], [0, 0, 0], [128, 128, 128]]) {
      const out = clampSurface(grey, 0, 'dark');
      const { h, s } = rgbToHsl(...out);

      // At 5% saturation in the dark band the channel delta is ~3/255, where hue is
      // quantized to roughly ±10°. The warmth ORDERING is the real invariant; the
      // exact hue there is rounding noise, so it gets a loose bound.
      assert.ok(s > 0, 'a flat grey would read as screen, not paper');
      assert.ok(out[0] >= out[1] && out[1] >= out[2], `not warm: ${out}`);
      const dh = Math.abs(h - NEUTRAL_HUE);
      assert.ok(Math.min(dh, 360 - dh) <= 15, `hue ${h} strayed out of the warm band`);
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
    assert.ok(rgbToHsl(...clampSurface([0, 0, 0], -5, 'dark')).l >= 0.06 - 0.01);
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

  it('clampSurface lands the SAME input in opposite bands, per polarity', () => {
    const white = [255, 255, 255];
    assert.ok(relativeLuminance(clampSurface(white, 0, 'light')) > 0.7);
    assert.ok(relativeLuminance(clampSurface(white, 0, 'dark')) < 0.1);
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

  it('bands slice the page top → bottom and track its vertical flow', () => {
    const rows = [...Array(5).fill([250, 250, 250]), ...Array(5).fill([10, 10, 40])];
    const { bands } = samplePalette(imageFromRows(rows, 4));

    assert.equal(bands.length, BAND_COUNT);
    assert.ok(bands[0][0] > 200, `first band ${bands[0]} should be the white top`);
    const last = bands[bands.length - 1];
    assert.ok(last[2] > last[0], `last band ${last} should be the blue bottom`);
  });

  it('bands survive an image shorter than BAND_COUNT — no empty slice, no throw', () => {
    const { bands } = samplePalette(imageFromRows([[200, 20, 20], [20, 20, 200]], 4));
    assert.equal(bands.length, BAND_COUNT);
    for (const b of bands) assert.ok(b.every(Number.isFinite), `bad band ${b}`);
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

  it('bandAt wraps around the ring and interpolates between neighbours', () => {
    const bands = [[0, 0, 0], [100, 100, 100], [200, 200, 200]];

    assert.deepEqual(bandAt(bands, 0), [0, 0, 0]);
    assert.deepEqual(bandAt(bands, 1), [100, 100, 100]);
    assert.deepEqual(bandAt(bands, 0.5), [50, 50, 50]);
    assert.deepEqual(bandAt(bands, 3), [0, 0, 0], 'a full cycle returns to the start');
    assert.deepEqual(bandAt(bands, -1), [200, 200, 200], 'negative phase wraps backwards');
    assert.deepEqual(bandAt(bands, 2.5), [100, 100, 100], 'the last band wraps into the first');
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
    assert.ok(p.bands.every((b) => b.every((v, i) => v === p.bands[0][i])), 'fixture must be uniform');

    const quarter = BAND_COUNT / 4;   // sin peaks here — maximum swing from phase 0
    assert.notEqual(tintFor(p, 0).gradient, tintFor(p, quarter).gradient);
  });

  it('the breath clears the noise deadband — phases must not be swallowed as jitter', () => {
    const p = samplePalette(UNIFORM);
    const a = tintTokens(p, 0);
    const b = tintTokens(p, BAND_COUNT / 4);
    assert.ok(!tokensClose(a, b), 'a peak-to-zero swing would be mistaken for sensor noise');
  });

  it('the phase is cyclic — a full cycle returns to the same tint', () => {
    const p = samplePalette(STRIPED);
    assert.deepEqual(tintTokens(p, 0), tintTokens(p, BAND_COUNT));
    assert.deepEqual(tintTokens(p, 1.5), tintTokens(p, 1.5 + BAND_COUNT));
  });

  it('only the gradient breathes — surfaces stay pinned across every phase', () => {
    const p = samplePalette(STRIPED);
    const base = tintTokens(p, 0);
    for (let phase = 0; phase < BAND_COUNT; phase += 0.25) {
      const t = tintTokens(p, phase);
      for (const key of ['bg', 'bgElevated', 'bgSubtle', 'border', 'borderSoft', 'scrollbar']) {
        assert.deepEqual(t[key], base[key], `${key} moved at phase ${phase}`);
      }
    }
  });

  it('NO phase of the breath dips below AAA, for any page colour, at its own polarity', () => {
    for (const rgb of HOSTILE) {
      for (let phase = 0; phase < BAND_COUNT; phase += 0.25) {
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
      for (let phase = 0; phase < BAND_COUNT; phase += 0.1) {
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

  // Interpolating dark-bg/light-text into light-bg/dark-text drags both through mid-grey,
  // where they meet at ~1:1. No easing fixes that — the midpoint IS the problem. So the
  // flip must snap, and lerpTokens enforces it rather than trusting the caller.
  it('a polarity flip SNAPS — it is never interpolated through the unreadable middle', () => {
    const dark = pageTokens([10, 10, 12]);
    const light = pageTokens([255, 255, 255]);
    assert.notEqual(dark.polarity, light.polarity, 'fixtures must straddle the flip');

    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      assert.deepEqual(lerpTokens(dark, light, t), light, `t=${t} must already be the target`);
    }
  });

  it('no frame of a flip is ever unreadable, because no frame exists', () => {
    const dark = pageTokens([10, 10, 12]);
    const light = pageTokens([255, 255, 255]);
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const frame = lerpTokens(dark, light, t);
      assert.ok(contrastRatio(frame.bg, frame.text) >= 7, `t=${t.toFixed(2)} went unreadable`);
    }
  });

  it('tokensClose treats a polarity flip as a real change, however near the channels', () => {
    const a = pageTokens([255, 255, 255]);
    const b = { ...a, polarity: 'dark' };
    assert.ok(!tokensClose(a, b), 'a flip must never be swallowed by the deadband');
  });

  it('tokensClose absorbs sensor noise but not a real colour change', () => {
    const a = tokensOf([24, 119, 242]);
    assert.ok(tokensClose(a, a), 'identical must be close');

    // ±2 per channel is JPEG/bucket-mean jitter, not a page repaint.
    const jittered = lerpTokens(a, a, 0);
    jittered.bg = [a.bg[0] + 2, a.bg[1] - 2, a.bg[2] + 1];
    assert.ok(tokensClose(a, jittered), 'a 2-unit wobble must not trigger a tween');

    assert.ok(!tokensClose(a, tokensOf([200, 20, 20])), 'blue → red must trigger a tween');
  });

  it('tokensClose honours a custom tolerance', () => {
    const a = tokensOf([24, 119, 242]);
    const b = { ...a, bg: [a.bg[0] + 5, a.bg[1], a.bg[2]] };
    assert.ok(!tokensClose(a, b));
    assert.ok(tokensClose(a, b, 5));
  });
});
