// Core/orchFeedback.test.js — ORCH-FB unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFeedback, planCorrection, applyRetraction, isActiveCapability, CORRECTIVE_KINDS } from './orchFeedback.js';

describe('orchFeedback — the corrective-feedback layer (ORCH-FB)', () => {
  it('classifyFeedback: distinguishes reject-match / reject-run / retract / undo / affirm', () => {
    assert.equal(classifyFeedback('not that one').kind, 'reject_match');
    assert.equal(classifyFeedback('wrong option').kind, 'reject_match');
    assert.equal(classifyFeedback("that's wrong").kind, 'reject_run');
    assert.equal(classifyFeedback("that didn't work").kind, 'reject_run');
    assert.equal(classifyFeedback('delete that capability').kind, 'retract');
    assert.equal(classifyFeedback("that's broken").kind, 'retract');
    assert.equal(classifyFeedback('undo that').kind, 'undo');
    assert.equal(classifyFeedback("yes that's right").kind, 'affirm');
    assert.equal(classifyFeedback('perfect, thanks').kind, 'affirm');
  });

  it('classifyFeedback: an ordinary ask is NOT feedback (the normal turn path is untouched)', () => {
    assert.equal(classifyFeedback('search for music').isFeedback, false);
    assert.equal(classifyFeedback('how many results are there').isFeedback, false);
  });

  it('classifyFeedback: negative polarity for corrections, positive for affirmation', () => {
    assert.equal(classifyFeedback('not that').polarity, 'negative');
    assert.equal(classifyFeedback('great, works now').polarity, 'positive');
  });

  it('planCorrection reject_match: de-alias ONLY (no global demote), then offer alternatives/record (capability KEPT)', () => {
    const p = planCorrection('reject_match', { capabilityId: 'cap1', groundId: 'g', ask: 'search vectors', alternatives: [{ id: 'cap2' }] });
    const ops = p.ops.map((o) => o.op);
    assert.ok(ops.includes('de_alias'));
    assert.ok(!ops.includes('demote'), 'a wrong MATCH must not globally demote a healthy capability (per-ask penalty handles it)');
    assert.ok(!ops.includes('retract'), 'a wrong MATCH does not delete the capability');
    assert.equal(p.ops.find((o) => o.op === 'de_alias').phrase, 'search vectors');
    assert.equal(p.followup, 'alternatives');
  });

  it('planCorrection retract: a single retract op (soft-delete), no Studio needed', () => {
    const p = planCorrection('retract', { capabilityId: 'capX', groundId: 'g' });
    assert.deepEqual(p.ops.map((o) => o.op), ['retract']);
    assert.equal(p.ops[0].capabilityId, 'capX');
  });

  it('planCorrection wrong_value: with a correction → rebind+rerun; without → ask for the value', () => {
    const withCorr = planCorrection('wrong_value', { capabilityId: 'c', correction: { CATEGORY: 'Vectors' } });
    assert.equal(withCorr.ops[0].op, 'rebind');
    assert.deepEqual(withCorr.ops[0].bindings, { CATEGORY: 'Vectors' });
    assert.equal(withCorr.followup, 'rerun');
    const noCorr = planCorrection('wrong_value', { capabilityId: 'c' });
    assert.equal(noCorr.ops.length, 0);
    assert.equal(noCorr.followup, 'ask_value');
  });

  it('planCorrection affirm: reinforces the ask→capability alias (flywheel)', () => {
    const p = planCorrection('affirm', { capabilityId: 'c', ask: 'search music' });
    assert.equal(p.ops[0].op, 'confirm_alias');
    assert.equal(p.ops[0].phrase, 'search music');
  });

  it('planCorrection: no capability in context → no-op ops (nothing to correct yet)', () => {
    assert.equal(planCorrection('reject_match', {}).ops.length, 0);
    assert.equal(planCorrection('retract', {}).ops.length, 0);
  });

  it('applyRetraction + isActiveCapability: retracted caps are filtered from matching', () => {
    const cap = { id: 'c', intent: 'x' };
    assert.equal(isActiveCapability(cap), true);
    const r = applyRetraction(cap, { now: 123 });
    assert.equal(r.retracted, true);
    assert.equal(r.retractedAt, 123);
    assert.equal(isActiveCapability(r), false, 'retracted → never surfaces again');
    assert.equal(isActiveCapability({ id: 'd', disabled: true }), false);
    assert.notEqual(cap.retracted, true, 'pure: the original is untouched');
  });

  it('CORRECTIVE_KINDS covers every kind planCorrection handles', () => {
    for (const k of CORRECTIVE_KINDS) assert.ok(planCorrection(k, { capabilityId: 'c' }), `planCorrection handles ${k}`);
  });
});
