// Core/capabilitySynth.test.js — SG-T2-ACC unit tests (node --test). PURE: synthetic phases.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness. These document the contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildTier2CapabilityRecords, buildCapabilityRecords } from './capabilitySynth.js';

const phases = [
  { label: 'Initiate job search', actions: [{ action: 'TYPE', selector: '#q', value: 'test' }, { action: 'CLICK', selector: '#go' }] },
  { label: 'Apply pay filter to results', actions: [
    { action: 'CLICK', selector: '#salaryType_filter_button', landmark: { role: 'button', accessibleName: 'Pay', selector: '#salaryType_filter_button' } },
    { action: 'CLICK', selector: '#update', landmark: { role: 'button', accessibleName: 'Update', selector: '#update' } },
  ] },
];

describe('buildTier2CapabilityRecords — multi-fragment capability (SG-T2-ACC)', () => {
  it('builds one fragment per phase + a Strategy chaining them in order', () => {
    const recs = buildTier2CapabilityRecords(phases, { groundId: 'g', strategyId: 's1', fragmentIds: ['f1', 'f2'], name: 'search and filter by pay', goal: 'search and filter by pay', now: 1000 });
    assert.ok(recs);
    assert.equal(recs.fragments.length, 2);
    assert.deepEqual(recs.fragments.map((f) => f.id), ['f1', 'f2']);
    assert.equal(recs.strategy.id, 's1');
    assert.deepEqual(recs.strategy.fragmentSteps.map((s) => s.fragmentId), ['f1', 'f2']);
    assert.equal(recs.strategy.fragmentSteps[0].type, 'fragment');
  });

  it('the real commit CLICK + inline landmark survive into the persisted fragment (replay applies for real)', () => {
    const recs = buildTier2CapabilityRecords(phases, { groundId: 'g', strategyId: 's', fragmentIds: ['a', 'b'], now: 1 });
    const payActions = JSON.parse(recs.fragments[1].rawJson);
    assert.ok(payActions.some((a) => a.action === 'CLICK' && a.selector === '#update'), 'Update commit present (not deferred)');
    assert.ok(payActions[0].landmark, 'inline landmark kept for probe-or-recover');
  });

  it('returns null when nothing is runnable or fragmentIds are short', () => {
    assert.equal(buildTier2CapabilityRecords([], { groundId: 'g', strategyId: 's', fragmentIds: [] }), null);
    assert.equal(buildTier2CapabilityRecords(phases, { groundId: 'g', strategyId: 's', fragmentIds: ['only-one'] }), null);
    assert.equal(buildTier2CapabilityRecords(phases, { strategyId: 's', fragmentIds: ['a', 'b'] }), null);
  });

  it('single-fragment buildCapabilityRecords still works (regression)', () => {
    const r = buildCapabilityRecords({ name: 'x', goal: 'x', actions: [{ action: 'CLICK', selector: '#a' }], params: [] }, { groundId: 'g', fragmentId: 'f', strategyId: 's' });
    assert.ok(r && r.fragment && r.strategy);
    assert.equal(r.strategy.fragmentSteps.length, 1);
  });
});
