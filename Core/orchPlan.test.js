// Core/orchPlan.test.js — ORCH-X compiler-spine unit tests (node --test). PURE.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness (shim describe/it).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectionForOutputType, validatePlan, planStep, OUTPUT_CONNECTION, STEP_KINDS } from './orchPlan.js';

describe('orchPlan — ORCH-X compiler spine', () => {
  it('connectionForOutputType: list→foreach, scalar→binding, predicate→gate, count→loop (§6)', () => {
    assert.equal(connectionForOutputType('list'), 'foreach');
    assert.equal(connectionForOutputType('scalar'), 'binding');
    assert.equal(connectionForOutputType('select'), 'binding');
    assert.equal(connectionForOutputType('predicate'), 'gate');
    assert.equal(connectionForOutputType('bool'), 'gate');
    assert.equal(connectionForOutputType('count'), 'loop');
    assert.equal(connectionForOutputType('mystery'), 'binding', 'unknown → safe default');
    assert.ok(STEP_KINDS.includes('fragment') && STEP_KINDS.includes('observe') && STEP_KINDS.includes('analyze'));
  });

  it('validatePlan: a well-formed "apply to each senior job" plan passes', () => {
    // search → observe titles → keep-senior (list) → FOREACH apply
    const plan = { goal: 'apply to senior jobs', steps: [
      planStep.fragment('search', 'cap-search', { bindings: { KEYWORD: 'developer' } }),
      planStep.observe('titles'),
      planStep.analyze('senior', 'titles', 'list'),
      planStep.fragment('apply', 'cap-apply', { forEach: 'senior' }),
    ] };
    const r = validatePlan(plan);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  it('validatePlan: a gate plan (predicate) and a loop plan (count) pass', () => {
    const gatePlan = { steps: [planStep.observe('o'), planStep.analyze('isRemote', 'o', 'predicate'), planStep.fragment('f', 'c', { gatedBy: 'isRemote' })] };
    assert.equal(validatePlan(gatePlan).ok, true);
    const loopPlan = { steps: [planStep.observe('o'), planStep.analyze('count', 'o', 'count'), planStep.fragment('f', 'c', { loopUntil: 'count' })] };
    assert.equal(validatePlan(loopPlan).ok, true);
  });

  it('validatePlan: a list output cannot GATE (connection/type mismatch)', () => {
    const bad = { steps: [planStep.observe('o'), planStep.analyze('a', 'o', 'list'), planStep.fragment('f', 'c', { gatedBy: 'a' })] };
    const r = validatePlan(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /needs an analyze whose output connects via "gate"/.test(e)));
  });

  it('validatePlan: forward reference is rejected', () => {
    const bad = { steps: [planStep.fragment('f', 'c', { forEach: 'a' }), planStep.observe('o'), planStep.analyze('a', 'o', 'list')] };
    const r = validatePlan(bad);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /forward reference/.test(e)));
  });

  it('validatePlan: analyze.over must point at an observe; ids unique; non-empty', () => {
    const overBad = { steps: [planStep.fragment('x', 'c'), planStep.analyze('a', 'x', 'list')] };
    assert.ok(validatePlan(overBad).errors.some((e) => /must reference an observe step/.test(e)));
    const dup = { steps: [planStep.observe('o'), planStep.observe('o')] };
    assert.ok(validatePlan(dup).errors.some((e) => /duplicate step id/.test(e)));
    assert.equal(validatePlan({ steps: [] }).ok, false, 'an empty plan is invalid');
  });
});
