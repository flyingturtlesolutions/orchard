// Core/orchTranslate.test.js — ORCH→Strategy translator (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { translatePlan } from './orchTranslate.js';
import { liftConditional } from './orchChain.js';

// the canonical conditional composite, as liftConditional produces it: head(search) · wait · observe · analyze · gate{sort}
function conditionalPlan() {
  const flat = [
    { capabilityId: 'cap-search', intent: 'Search jobs', kind: null, clause: 'search for android jobs', bindings: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android', EDIT_LOCATION: 'remote' } },
    { capabilityId: 'cap-jobs', intent: 'the list of jobs', kind: 'observation', outputType: 'list', clause: 'if there are any jobs' },
    { capabilityId: 'cap-sort', intent: 'Sort by date', kind: null, clause: 'sort by date' },
  ];
  return { steps: liftConditional(flat, 'search for android jobs and if there are any jobs, sort by date').steps };
}

// the resolution the handler would supply (StorageManager reads done elsewhere)
function resolvedFor(plan) {
  const r = {};
  const walk = (steps) => { for (const s of (steps || [])) {
    if (!s) continue;
    if (s.kind === 'fragment' && !s.clickItem) r[s.id] = { kind: 'fragment', fragmentSteps: [{ type: 'fragment', fragmentId: `frag-${s.capabilityId}`, paramBindings: {} }] };
    if (s.kind === 'observe') r[s.id] = { kind: 'observation', observationId: `obs-${s.capabilityId}` };
    if (Array.isArray(s.body)) walk(s.body);
  } };
  walk(plan.steps);
  return r;
}

describe('orchTranslate — ORCH composite IR → Strategy plan tree', () => {
  it('the conditional composite → fragment · wait · observation · detect{ orch_predicate → fragment }', () => {
    const plan = conditionalPlan();
    const r = translatePlan(plan, resolvedFor(plan), { params: ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY'], paramDefaults: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android' } });
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    const kinds = r.fragmentSteps.map((n) => n.type);
    assert.deepEqual(kinds, ['fragment', 'wait', 'observation', 'detect'], 'search · settle · read · gate — analyze ELIDED');
    // the gate became a single-branch DETECT whose condition is an orch_predicate over the observe binding
    const detect = r.fragmentSteps[3];
    assert.equal(detect.branches.length, 1);
    assert.deepEqual(detect.default, [], 'closed gate = empty default = skip');
    const cond = detect.branches[0].condition.conditions[0];
    assert.equal(cond.type, 'orch_predicate');
    assert.equal(typeof cond.specJson, 'string', 'the predicate rides as a JSON STRING (the canonical normalizer String()-ifies fields)');
    assert.equal(JSON.parse(cond.specJson).op, 'exists', 'the ORCH predicate rides into the condition (same evaluator at runtime)');
    assert.equal(detect.branches[0].body[0].type, 'fragment', 'the gated sort is the branch body');
  });

  it('params become strategy_param bindings (shown in a ParamForm); non-params are frozen literals', () => {
    const plan = conditionalPlan();
    const r = translatePlan(plan, resolvedFor(plan), { params: ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY'], paramDefaults: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android' } });
    const search = r.fragmentSteps[0];
    assert.equal(search.paramBindings.SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY.kind, 'strategy_param', 'the keyword is a launch param');
    assert.equal(search.paramBindings.EDIT_LOCATION.kind, 'literal', 'the default location is frozen');
    assert.equal(search.paramBindings.EDIT_LOCATION.value, 'remote');
    assert.deepEqual(r.params.map((p) => p.name), ['SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY']);
    assert.equal(r.params[0].default, 'android', 'the sample becomes the param default');
  });

  it('NO analyze and NO sieve node is ever emitted (the predicate is a condition, not a node)', () => {
    const plan = conditionalPlan();
    const r = translatePlan(plan, resolvedFor(plan), { params: [] });
    const flatten = (nodes) => nodes.flatMap((n) => [n.type, ...(n.branches ? n.branches.flatMap((b) => flatten(b.body || [])) : []), ...flatten(n.body || []), ...flatten(n.default || [])]);
    const allTypes = flatten(r.fragmentSteps);
    assert.ok(!allTypes.includes('analyze') && !allTypes.includes('sieve'), 'R1: never emit a SIEVE/analysis referencing a predicate');
    // every fragment paramBinding kind is literal or strategy_param — never a leaked sub-strategy strategy_param mismatch (R6)
    const checkBindings = (nodes) => { for (const n of nodes) { if (n.type === 'fragment') for (const b of Object.values(n.paramBindings || {})) assert.ok(['literal', 'strategy_param', 'iteration_variable'].includes(b.kind)); if (n.branches) for (const br of n.branches) checkBindings(br.body || []); checkBindings(n.body || []); checkBindings(n.default || []); } };
    checkBindings(r.fragmentSteps);
  });

  it('an unresolved leaf, or a foreach/loop/clickItem, → errors (validate-at-promote refuses; cache fallback) ', () => {
    const plan = conditionalPlan();
    // drop the search resolution → unresolved fragment
    const res = resolvedFor(plan); delete res[plan.steps[0].id];
    assert.ok(translatePlan(plan, res, {}).errors.some((e) => /did not resolve/.test(e)));
    // a foreach composite is rejected in the first cut
    const fe = { steps: [{ kind: 'observe', id: 'o', capabilityId: 'c' }, { kind: 'foreach', id: 'e', over: 'o', body: [{ kind: 'fragment', id: 'b', capabilityId: 'c2' }] }] };
    assert.ok(translatePlan(fe, { o: { kind: 'observation', observationId: 'x' } }, {}).errors.some((e) => /not in the first cut/.test(e)));
    // a clickItem fragment is rejected
    const ci = { steps: [{ kind: 'fragment', id: 'c', clickItem: true }] };
    assert.ok(translatePlan(ci, {}, {}).errors.some((e) => /clickItem/.test(e)));
  });
});
