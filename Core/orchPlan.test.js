// Core/orchPlan.test.js — ORCH-X compiler-spine unit tests (node --test). PURE.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness (shim describe/it).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { connectionForOutputType, validatePlan, planStep, OUTPUT_CONNECTION, STEP_KINDS, STEP_EFFECTS, STEP_SCOPES, effectForKind } from './orchPlan.js';

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

  // ── Control-flow NODES (body-carrying foreach / loop / gate) ─────────────────────────────────────────────────
  it('validatePlan: the canonical FOREACH plan passes — search → observe(list) → foreach{ open; observe salary }', () => {
    // "search recently-posted jobs in japan, check each job and let me know the salaries of each"
    const plan = { goal: 'salaries of each job', steps: [
      planStep.fragment('search', 'cap-search', { bindings: { recency: 'recent', location: 'japan' } }),
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [
        planStep.fragment('open', 'cap-open-job'),
        planStep.observe('salary', { outputType: 'scalar' }),
      ], { collect: 'SALARIES' }),
    ] };
    const r = validatePlan(plan);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
  });

  it('validatePlan: gate over a predicate and loop over a count pass; a foreach over a scalar is rejected', () => {
    const gate = { steps: [planStep.observe('o', { outputType: 'predicate' }), planStep.gate('g', 'o', [planStep.fragment('f', 'c')])] };
    assert.equal(validatePlan(gate).ok, true);
    const loop = { steps: [planStep.observe('o', { outputType: 'count' }), planStep.loop('l', 'o', [planStep.fragment('f', 'c')])] };
    assert.equal(validatePlan(loop).ok, true);
    const bad = { steps: [planStep.observe('o', { outputType: 'scalar' }), planStep.foreach('each', 'o', [planStep.fragment('f', 'c')])] };
    const rb = validatePlan(bad);
    assert.equal(rb.ok, false);
    assert.ok(rb.errors.some((e) => /foreach "each"\.over needs an output connecting via "foreach"/.test(e)));
  });

  it('validatePlan: a foreach node requires a non-empty body', () => {
    const r = validatePlan({ steps: [planStep.observe('o', { outputType: 'list' }), planStep.foreach('e', 'o', [])] });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /foreach "e"\.body required/.test(e)));
  });

  it('validatePlan: a body step sees an ENCLOSING-earlier step (lexical scope)', () => {
    // gate inside the loop body references `cond` declared before the foreach — visible.
    const plan = { steps: [
      planStep.observe('cond', { outputType: 'predicate' }),
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [
        planStep.gate('g', 'cond', [planStep.fragment('f', 'c')]),
      ]),
    ] };
    assert.equal(validatePlan(plan).ok, true);
  });

  it('validatePlan: a forward reference INSIDE a body is rejected', () => {
    const plan = { steps: [
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [
        planStep.fragment('f', 'c', { forEach: 'later' }),   // refs a later body step
        planStep.observe('ob', { outputType: 'list' }),
        planStep.analyze('later', 'ob', 'list'),
      ]),
    ] };
    const r = validatePlan(plan);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /forward reference/.test(e)));
  });

  it('validatePlan: an OUTER step cannot reference a BODY step (body ids do not leak out)', () => {
    const plan = { steps: [
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [planStep.analyze('inner', 'jobs', 'list')]),
      planStep.fragment('f', 'c', { forEach: 'inner' }),   // 'inner' lives in the body — out of scope here
    ] };
    const r = validatePlan(plan);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /forward reference/.test(e)));
  });

  it('validatePlan: a duplicate id ACROSS scopes (outer vs body) is caught', () => {
    const plan = { steps: [
      planStep.observe('x', { outputType: 'list' }),
      planStep.foreach('each', 'x', [planStep.observe('x', { outputType: 'scalar' })]),
    ] };
    assert.ok(validatePlan(plan).errors.some((e) => /duplicate step id "x"/.test(e)));
  });

  // ── WAIT (pacing leaf) ───────────────────────────────────────────────────────────────────────────────────────
  it('validatePlan: a click-in-place foreach with a WAIT settle between click and read passes', () => {
    assert.ok(STEP_KINDS.includes('wait'));
    const plan = { goal: 'salary of each (click in place)', steps: [
      planStep.fragment('search', 'cap-search'),
      planStep.observe('jobs', { outputType: 'list' }),
      planStep.foreach('each', 'jobs', [
        planStep.fragment('click', null, { clickItem: true }),
        planStep.wait('settle', { ms: 900 }),
        planStep.observe('salary', { outputType: 'scalar', fixed: true }),
      ], { collect: 'SALARIES' }),
    ] };
    const r = validatePlan(plan);
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    assert.equal(planStep.wait('w').ms, 800, 'the wait constructor carries a sensible default floor');
  });

  it('validatePlan: a malformed wait (negative ms / empty forSelector) is rejected', () => {
    const negMs = { steps: [planStep.observe('o', { outputType: 'list' }), planStep.foreach('e', 'o', [planStep.wait('w', { ms: -5 })])] };
    assert.ok(validatePlan(negMs).errors.some((e) => /wait "w"\.ms must be a non-negative number/.test(e)));
    const badSel = { steps: [planStep.wait('w', { forSelector: '   ' })] };
    assert.ok(validatePlan(badSel).errors.some((e) => /wait "w"\.forSelector must be a non-empty selector/.test(e)));
  });

  // ── ORCH-CB slot tags (effect / role / scope / ground) ───────────────────────────────────────────────────────
  it('effectForKind: a leaf maps to its work-kind (read/act/reason); a control-flow node has none', () => {
    assert.equal(effectForKind('observe'), 'read');
    assert.equal(effectForKind('fragment'), 'act');
    assert.equal(effectForKind('analyze'), 'reason');
    assert.equal(effectForKind('foreach'), null);
    assert.equal(effectForKind('wait'), null);
    assert.deepEqual([...STEP_EFFECTS], ['read', 'act', 'reason']);
    assert.deepEqual([...STEP_SCOPES], ['locale', 'ground', 'global']);
  });

  it('validatePlan: a plan WITH slot tags (effect/role/scope/ground) validates; a plan WITHOUT them still does', () => {
    const tagged = { steps: [
      planStep.fragment('search', 'cap-search', { effect: 'act', scope: 'ground', role: 'head' }),
      planStep.observe('cond', { outputType: 'list', effect: 'read', scope: 'ground', role: 'condition' }),
      planStep.fragment('book', 'cap-book', { effect: 'act', scope: 'global', ground: 'calendar.google.com', role: 'consequent' }),
    ] };
    assert.deepEqual(validatePlan(tagged).errors, [], 'tags are accepted (additive)');
    // the SAME plan without tags is equally valid — the tags are optional
    const untagged = { steps: [planStep.fragment('search', 'cap-search'), planStep.observe('cond', { outputType: 'list' }), planStep.fragment('book', 'cap-book')] };
    assert.deepEqual(validatePlan(untagged).errors, []);
  });

  it('validatePlan: an unknown effect / scope, or an empty role / ground, is rejected', () => {
    const badEffect = { steps: [planStep.fragment('f', 'c', { effect: 'do' })] };
    assert.ok(validatePlan(badEffect).errors.some((e) => /effect must be one of read\/act\/reason/.test(e)));
    const badScope = { steps: [planStep.fragment('f', 'c', { scope: 'site' })] };
    assert.ok(validatePlan(badScope).errors.some((e) => /scope must be one of locale\/ground\/global/.test(e)));
    const badRole = { steps: [planStep.fragment('f', 'c', { role: '  ' })] };
    assert.ok(validatePlan(badRole).errors.some((e) => /role must be a non-empty string/.test(e)));
    const badGround = { steps: [planStep.fragment('f', 'c', { ground: '' })] };
    // ground: '' is falsy → not flagged (treated as absent); a whitespace ground IS flagged
    assert.deepEqual(validatePlan(badGround).errors, [], 'an empty-string ground is treated as absent');
    const wsGround = { steps: [planStep.fragment('f', 'c', { ground: '   ' })] };
    assert.ok(validatePlan(wsGround).errors.some((e) => /ground must be a non-empty string/.test(e)));
  });
});
