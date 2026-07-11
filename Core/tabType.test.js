// Core/tabType.test.js — v2.74.1436 active-tab typography derivation (node --test). PURE.
// Run via the temp-dir ESM harness (npm test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveType, TYPE_MIN_FS, TYPE_MAX_FS, TYPE_MIN_LH, TYPE_MAX_LH } from './tabType.js';

/** A plausible sample: Georgia body text. */
const georgia = (over = {}) => ({
  ff: 'Georgia, "Times New Roman", serif', fs: 18, fw: '400', lh: '28.8px', ls: 'normal', n: 900, ...over,
});
const arial = (over = {}) => ({
  ff: 'Arial, Helvetica, sans-serif', fs: 14, fw: '400', lh: '21px', ls: 'normal', n: 100, ...over,
});

describe('tabType — the family election', () => {
  it('the biggest text mass wins — body font beats nav font', () => {
    // 900 chars of Georgia vs three 100-char Arial widgets: Georgia is the body.
    const t = deriveType([georgia(), arial(), arial(), arial()]);
    assert.match(t.family, /^Georgia/);
  });

  it('a single pathological element cannot be the whole election', () => {
    // One 50k-char wall (capped to 2000) vs 3x1500 of the other: the many win.
    const t = deriveType([georgia({ n: 50000 }), arial({ n: 1500 }), arial({ n: 1500 }), arial({ n: 1500 })]);
    assert.match(t.family, /^Arial/);
  });

  it('metrics come from the WINNING family only — the sidebar does not vote on leading', () => {
    // Georgia wins; the Arial sample's 10px size must not drag the median down.
    const t = deriveType([georgia({ fs: 16, lh: '25.6px' }), georgia({ fs: 16, lh: '25.6px' }), arial({ fs: 10, lh: '11px' })]);
    assert.equal(t.fontSize, '16px');
    assert.equal(t.lineHeight, '1.6');
  });

  it('a stack without a generic tail gets one appended', () => {
    const t = deriveType([georgia({ ff: '"Custom Grotesk", "Helvetica Neue"' })]);
    assert.ok(t.family.endsWith(', sans-serif'), t.family);
  });

  it('a stack already ending on a generic is left alone', () => {
    const t = deriveType([georgia()]);
    assert.equal(t.family, 'Georgia, "Times New Roman", serif');
  });
});

describe('tabType — the clamp (legibility is enforced, character survives)', () => {
  it('font-size is held to the readable band', () => {
    assert.equal(deriveType([georgia({ fs: 11, lh: '15.4px' })]).fontSize, `${TYPE_MIN_FS}px`);
    assert.equal(deriveType([georgia({ fs: 26, lh: '36px' })]).fontSize, `${TYPE_MAX_FS}px`);
  });

  it('line-height is carried as a RATIO and floored/capped', () => {
    // 18px font at 18px leading = ratio 1.0 -> floor 1.4; at 45px = 2.5 -> cap 1.9.
    assert.equal(deriveType([georgia({ lh: '18px' })]).lineHeight, String(TYPE_MIN_LH));
    assert.equal(deriveType([georgia({ lh: '45px' })]).lineHeight, String(TYPE_MAX_LH));
  });

  it('line-height "normal" contributes nothing — empty string means keep the panel default', () => {
    assert.equal(deriveType([georgia({ lh: 'normal' })]).lineHeight, '');
  });

  it('weight is banded: no hairline prose, no shouting prose', () => {
    assert.equal(deriveType([georgia({ fw: '100' })]).fontWeight, '300');
    assert.equal(deriveType([georgia({ fw: '800' })]).fontWeight, '600');
    assert.equal(deriveType([georgia({ fw: '500' })]).fontWeight, '500');
  });

  it('letter-spacing is banded and "normal" round-trips to normal', () => {
    assert.equal(deriveType([georgia()]).letterSpacing, 'normal');
    assert.equal(deriveType([georgia({ ls: '0.3px' })]).letterSpacing, '0.3px');
    assert.equal(deriveType([georgia({ ls: '6px' })]).letterSpacing, '1px');
    assert.equal(deriveType([georgia({ ls: '-4px' })]).letterSpacing, '-0.5px');
  });
});

describe('tabType — rejection (null means keep the panel default)', () => {
  it('a decorative-first stack is not prose', () => {
    assert.equal(deriveType([georgia({ ff: 'cursive' })]), null);
    assert.equal(deriveType([georgia({ ff: 'fantasy, serif' })]), null);
  });

  it('but a decorative name deeper in the stack is fine — the first name is the intent', () => {
    assert.notEqual(deriveType([georgia({ ff: 'Georgia, cursive' })]), null);
  });

  it('garbage in, null out — never a throw', () => {
    assert.equal(deriveType(null), null);
    assert.equal(deriveType([]), null);
    assert.equal(deriveType([{}]), null);
    assert.equal(deriveType([georgia({ ff: '' })]), null);
    assert.equal(deriveType([georgia({ fs: NaN })]), null);
    assert.equal(deriveType([georgia({ n: 0 })]), null);
  });

  it('a hostile oversized family string is discarded per-sample', () => {
    const t = deriveType([georgia({ ff: 'X'.repeat(500) }), arial()]);
    assert.match(t.family, /^Arial/, 'the oversized sample must not win by default');
  });
});

describe('tabType — output shape', () => {
  it('emits ready-to-setProperty strings on a half-px / 2-dp grid', () => {
    const t = deriveType([georgia({ fs: 15.3, lh: '24.174px' })]);
    assert.equal(t.fontSize, '15.5px');
    assert.equal(t.lineHeight, '1.58');
    assert.equal(t.fontWeight, '400');
  });

  it('is deterministic', () => {
    const s = [georgia(), arial(), georgia({ fs: 17 })];
    assert.deepEqual(deriveType(s), deriveType(s));
  });
});
