// Core/orchComprehend.test.js — ORCH-CB slice 3: the comprehenders (node --test). PURE — substrate-free.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { comprehend } from './orchComprehend.js';
import { validatePlan } from './orchPlan.js';

// every leaf carries an effect + scope tag
function assertTagged(steps) {
  for (const s of steps) {
    if (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate') { assert.equal(s.scope, 'ground'); assertTagged(s.body || []); }
    else if (s.kind === 'wait') { /* structural */ }
    else { assert.ok(['read', 'act', 'reason'].includes(s.effect), `${s.kind} has an effect`); assert.equal(s.scope, 'ground'); assert.ok(s.role, 'has a role'); }
  }
}

describe('orchComprehend — ask → a PlanShape of unbound, effect-tagged slots (ORCH-CB)', () => {
  it('a single READ → one observe slot (effect read), unbound', () => {
    const c = comprehend('the salary');
    assert.equal(c.shape, 'read');
    assert.equal(c.steps.length, 1);
    assert.equal(c.steps[0].kind, 'observe');
    assert.equal(c.steps[0].effect, 'read');
    assert.equal(c.steps[0].capabilityId, null, 'unbound — a gap until BIND');
    assertTagged(c.steps);
  });

  it('a single ACTION → one fragment slot (effect act)', () => {
    const c = comprehend('sort by date');
    assert.equal(c.shape, 'action');
    assert.equal(c.steps[0].kind, 'fragment');
    assert.equal(c.steps[0].effect, 'act');
  });

  it('a SEQUENCE → an ordered slot per clause, effect-classified', () => {
    const c = comprehend('search for jobs and filter by date');
    assert.equal(c.shape, 'sequence');
    assert.equal(c.steps.length, 2);
    assert.equal(c.steps.every((s) => s.capabilityId === null), true);
    assertTagged(c.steps);
  });

  it('a CONDITIONAL → observe(read) → analyze(reason) → gate{ fragment(act) }, substrate-free', () => {
    const c = comprehend('if there are any jobs, sort by date');
    assert.equal(c.shape, 'conditional');
    const kinds = c.steps.map((s) => s.kind);
    assert.deepEqual(kinds, ['observe', 'analyze', 'gate']);
    assert.equal(c.steps[0].effect, 'read');
    assert.equal(c.steps[1].effect, 'reason');
    assert.equal(c.steps[2].body[0].kind, 'fragment');
    assert.equal(c.steps[2].body[0].effect, 'act');
    assertTagged(c.steps);
    assert.deepEqual(validatePlan({ steps: c.steps }).errors, [], 'the comprehended shape is a valid plan');
  });

  it('a GUARDED SEQUENCE → leading action is an UNGATED head; only the consequent is gated', () => {
    const c = comprehend('search for jobs and if there are any jobs, sort by date');
    assert.equal(c.shape, 'conditional');
    assert.equal(c.steps[0].kind, 'fragment', 'the search head runs ungated');
    assert.equal(c.steps[0].effect, 'act');
    assert.equal(c.steps[0].role, 'head');
    const gate = c.steps.find((s) => s.kind === 'gate');
    assert.ok(gate && gate.body.length === 1 && gate.body[0].kind === 'fragment', 'only the sort is gated');
    assert.deepEqual(validatePlan({ steps: c.steps }).errors, []);
  });

  it('an "unless" CONDITIONAL (trailing) → the observation is hoisted ahead, the predicate negated', () => {
    const c = comprehend('apply unless it is taken');
    assert.equal(c.shape, 'conditional');
    assert.equal(c.steps[0].kind, 'observe');
    const an = c.steps.find((s) => s.kind === 'analyze');
    assert.equal(an.predicate.negate, true);
    const gate = c.steps.find((s) => s.kind === 'gate');
    assert.equal(gate.body[0].intent, 'apply');
  });

  it('a FOREACH → escalate:true (the body split is semantic), with a best-effort flat decomposition', () => {
    const c = comprehend('click each job and read the salary');
    assert.equal(c.shape, 'foreach');
    assert.equal(c.escalate, true, 'defer the collection/body MEANING split to the LLM');
    assert.ok(c.steps.length >= 1, 'still decomposes (so an empty ground can show gaps)');
    assertTagged(c.steps);
  });

  it('comprehension touches NO substrates — same output regardless of any ground', () => {
    const a = comprehend('if there are any jobs, sort by date');
    const b = comprehend('if there are any jobs, sort by date');
    assert.deepEqual(a.steps.map((s) => s.kind), b.steps.map((s) => s.kind));
    assert.equal(a.steps.every((s) => JSON.stringify(s).includes('"capabilityId":null') || s.kind === 'analyze' || s.kind === 'gate'), true);
  });
});

describe('orchComprehend — T3X global scope (the cross-Ground recursion harness)', () => {
  // every leaf carries scope === expected (recurses into control-flow bodies)
  function assertScope(steps, expected) {
    for (const s of steps) {
      if (s.kind === 'foreach' || s.kind === 'loop' || s.kind === 'gate') { assert.equal(s.scope, expected); assertScope(s.body || [], expected); }
      else if (s.kind === 'wait') { /* structural */ }
      else { assert.equal(s.scope, expected, `${s.kind} scope`); }
    }
  }

  it('defaultScope omitted → every leaf ground-scoped (T2, unchanged)', () => {
    assertScope(comprehend('search for jobs and apply').steps, 'ground');
    assertScope(comprehend('the salary').steps, 'ground');
  });

  it("defaultScope:'global' → every leaf global-scoped (T3X); ground stays unresolved", () => {
    const c = comprehend('find a job on linkedin and save it to notion', { defaultScope: 'global' });
    assertScope(c.steps, 'global');
    assert.equal(c.steps.every((s) => s.ground == null), true, 'ground is filled later by resolution, not at comprehend time');
    // intents all the way down: the SHAPE is identical to the ground pass — only the scope tag differs.
    const g = comprehend('find a job on linkedin and save it to notion');
    assert.deepEqual(c.steps.map((s) => s.kind), g.steps.map((s) => s.kind));
  });

  it('a global-tagged plan still validates (the IR seam was always there)', () => {
    const c = comprehend('research a topic then post a summary', { defaultScope: 'global' });
    assert.deepEqual(validatePlan({ steps: c.steps }).errors, [], 'global scope is a valid plan');
  });
});
