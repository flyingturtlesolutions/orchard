// Core/presetMemory.test.js — the two-tier learning core (v2.74.1210): what rises instance→preset, what seeds back.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isPromotableToPreset, promotableToPreset, seedInstanceFromPreset, presetMemoryKey, distillCandidates, presetRuleFromAbstract } from './presetMemory.js';

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

describe('presetMemory — §10.2 distill-up core', () => {
  it('presetMemoryKey: preset:<id>, blank → ""', () => {
    assert.equal(presetMemoryKey('support'), 'preset:support');
    assert.equal(presetMemoryKey('  inbox '), 'preset:inbox');
    assert.equal(presetMemoryKey(''), '');
    assert.equal(presetMemoryKey(null), '');
  });
  it('distillCandidates: confirmed deltas NOT preset-sourced; facts + other tiers + preset/distilled provenance excluded', () => {
    const items = [
      delta('verify the refund window', { tier: 'confirmed', provenance: 'act-ok' }),        // earned → candidate
      delta('summarize before escalating', { tier: 'confirmed', provenance: 'user-rule' }),  // earned → candidate
      delta('already vetted', { tier: 'canonical', provenance: 'user-rule' }),               // canonical = already shared → no
      belief('Acme is enterprise', { tier: 'canonical' }),                                   // a FACT is barred (privacy boundary)
      delta('still a hypothesis', { tier: 'hypothesis' }),                                   // not earned yet → no
      delta('came down from preset', { tier: 'confirmed', provenance: 'preset-baseline' }),  // seeded down → never re-rises
      delta('already rose once', { tier: 'confirmed', provenance: 'distilled-up' }),         // already shared → no loop
    ];
    assert.deepEqual(distillCandidates(items).map((x) => x.body), ['verify the refund window', 'summarize before escalating']);
    assert.deepEqual(distillCandidates(null), []);
  });
  it('distillCandidates carries the store id through (the caller canonizes that item)', () => {
    assert.equal(distillCandidates([{ kind: 'delta', body: 'a rule', tier: 'confirmed', id: 'gm-xyz' }])[0].id, 'gm-xyz');
  });
  it('presetRuleFromAbstract: abstracted body → a canonical distilled-up preset delta; blank → null', () => {
    const r = presetRuleFromAbstract({ trigger: 'before closing a ticket', body: 'confirm the resolution with the customer' });
    assert.equal(r.kind, 'delta');
    assert.equal(r.tier, 'canonical');
    assert.equal(r.provenance, 'distilled-up');
    assert.equal(r.trigger, 'before closing a ticket');
    assert.equal(r.body, 'confirm the resolution with the customer');
    assert.equal(presetRuleFromAbstract({ body: '   ' }), null);
    assert.equal(presetRuleFromAbstract({}), null);
  });
});
