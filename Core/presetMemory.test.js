// Core/presetMemory.test.js — the two-tier learning core (v2.74.1210): what rises instance→preset, what seeds back.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPromotableToPreset, promotableToPreset, seedInstanceFromPreset } from './presetMemory.js';

const delta = (body, over = {}) => ({ kind: 'delta', body, ...over });
const belief = (body, over = {}) => ({ kind: 'belief', body, ...over });

describe('presetMemory — isPromotableToPreset (only confirmed behavior-rules rise)', () => {
  it('a canonical delta rises; lesser tiers + beliefs never do', () => {
    assert.equal(isPromotableToPreset(delta('confirm resolution before closing', { tier: 'canonical' })), true);
    assert.equal(isPromotableToPreset(delta('x', { tier: 'confirmed' })), false);                       // not HITL-confirmed yet
    assert.equal(isPromotableToPreset(belief('Acme is enterprise', { tier: 'canonical' })), false);     // a FACT stays home
    assert.equal(isPromotableToPreset(delta('x', { tier: 'observation' })), false);
    assert.equal(isPromotableToPreset(null), false);
  });
});

describe('presetMemory — promotableToPreset', () => {
  it('filters a mixed instance store to the canonical deltas only (facts + unconfirmed rules stay)', () => {
    const items = [
      delta('rule A', { tier: 'canonical' }),
      belief('a private fact', { tier: 'canonical' }),
      delta('rule B', { tier: 'confirmed' }),
      delta('rule C', { tier: 'canonical' }),
    ];
    assert.deepEqual(promotableToPreset(items).map((x) => x.body), ['rule A', 'rule C']);
    assert.deepEqual(promotableToPreset(null), []);
  });
});

describe('presetMemory — seedInstanceFromPreset (the baseline a new instance starts with)', () => {
  it('seeds preset rules + hand-authored baseline as confirmed deltas tagged preset-baseline', () => {
    const out = seedInstanceFromPreset([delta('generic rule', { tier: 'canonical' })], { baseline: [delta('authored rule')] });
    assert.equal(out.length, 2);
    for (const r of out) {
      assert.equal(r.kind, 'delta');
      assert.equal(r.tier, 'confirmed');                 // trusted, but NOT canonical → won't immediately re-promote UP
      assert.equal(r.provenance, 'preset-baseline');
    }
    assert.deepEqual(out.map((r) => r.body).sort(), ['authored rule', 'generic rule']);
  });
  it('facts never seed (only behavior rules); dups collapse case-insensitively; empty → []', () => {
    assert.deepEqual(seedInstanceFromPreset([belief('a fact', { tier: 'canonical' })]), []);
    assert.equal(seedInstanceFromPreset([delta('same'), delta('SAME')]).length, 1);
    assert.deepEqual(seedInstanceFromPreset(null), []);
  });
});
