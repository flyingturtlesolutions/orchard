// Core/orchPromote.test.js — the converge promotion brain (node --test).
// Resolves leaves via MOCK async I/O, translates, validates, assembles a canonical Strategy — and FAILS SAFE
// (→ ok:false, caller keeps the matcher-only cap + walkPlan) on any unresolved leaf or malformed tree (R7).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { promoteComposite, validateTranslatedTree, assembleStrategy } from './orchPromote.js';
import { buildCompositeCapability } from './orchChain.js';
import { liftConditional } from './orchChain.js';

// Build the canonical conditional composite cap the way ACCEPT_COMPOUND would (controlFlow IR + signature).
function conditionalCap() {
  const flat = [
    { capabilityId: 'cap-search', intent: 'Search jobs', kind: null, clause: 'search for android jobs', bindings: { SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY: 'android', EDIT_LOCATION: 'remote' } },
    { capabilityId: 'cap-jobs', intent: 'the list of jobs', kind: 'observation', outputType: 'list', clause: 'if there are any jobs' },
    { capabilityId: 'cap-sort', intent: 'Sort by date', kind: null, clause: 'sort by date' },
  ];
  const plan = { steps: liftConditional(flat, 'search for android jobs and if there are any jobs, sort by date').steps };
  return buildCompositeCapability({ id: 'comp-1', ask: 'search for android jobs and if there are any jobs, sort by date', groundId: 'g1', plan });
}

// Mock resolvers: every fragment cap → a 1-node strategy; every observe cap → a materialized observation.
const okFragment = (capabilityId) => Promise.resolve({ fragmentSteps: [{ type: 'fragment', fragmentId: `frag-${capabilityId}`, paramBindings: {} }] });
const okObserve = (capabilityId) => Promise.resolve({ observationId: `obs-${capabilityId}` });

describe('orchPromote — composite → canonical Strategy', () => {
  it('a conditional composite promotes to a Strategy whose tree is fragment·wait·observation·detect', async () => {
    const cap = conditionalCap();
    const r = await promoteComposite(cap, { resolveFragmentCap: okFragment, resolveObserveCap: okObserve, strategyId: 'strat-1' });
    assert.deepEqual(r.errors, []);
    assert.equal(r.ok, true);
    assert.equal(r.strategy.id, 'strat-1');
    assert.equal(r.strategy.groundId, 'g1');
    assert.equal(r.strategy.fromComposite, 'comp-1');
    const kinds = r.strategy.fragmentSteps.map((n) => n.type);
    assert.deepEqual(kinds, ['fragment', 'wait', 'observation', 'detect']);
    // the gated sort lives in the detect branch body
    assert.equal(r.strategy.fragmentSteps[3].branches[0].body[0].type, 'fragment');
  });

  it('the composite\'s param becomes a strategy param with its demonstrated sample as the default', async () => {
    const cap = conditionalCap();
    const r = await promoteComposite(cap, { resolveFragmentCap: okFragment, resolveObserveCap: okObserve, strategyId: 'strat-1' });
    const kw = r.strategy.params.find((p) => p.name === 'SEARCH_JOB_TITLE_KEYWORDS_OR_COMPANY');
    assert.ok(kw, 'the keyword is a launch param');
    assert.equal(kw.kind, 'scalar');
    assert.equal(kw.required, false);
    assert.equal(kw.default, 'android', 'the demonstrated value becomes the default');
  });

  it('FAILS SAFE — a VISUAL condition (observe cap unresolvable) → ok:false, no Strategy (cache-only fallback)', async () => {
    const cap = conditionalCap();
    const r = await promoteComposite(cap, { resolveFragmentCap: okFragment, resolveObserveCap: () => Promise.resolve(null), strategyId: 'strat-1' });
    assert.equal(r.ok, false);
    assert.ok(!r.strategy);
    assert.ok(r.errors.some((e) => /did not resolve to a materialized Observation/.test(e)));
  });

  it('FAILS SAFE — an unresolved fragment leaf → ok:false', async () => {
    const cap = conditionalCap();
    const r = await promoteComposite(cap, { resolveFragmentCap: () => Promise.resolve(null), resolveObserveCap: okObserve, strategyId: 'strat-1' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /did not resolve to a Strategy/.test(e)));
  });

  it('a non-control-flow (flat) composite does NOT promote (only quantified/conditional converge)', async () => {
    const flatCap = { id: 'c', controlFlow: false, steps: [{ capabilityId: 'a' }, { capabilityId: 'b' }] };
    const r = await promoteComposite(flatCap, { resolveFragmentCap: okFragment, resolveObserveCap: okObserve, strategyId: 's' });
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /not a control-flow composite/.test(e)));
  });

  it('validateTranslatedTree rejects a malformed tree (orphan binding kind, missing observationId, bad detect)', () => {
    assert.equal(validateTranslatedTree([]).ok, false);
    assert.equal(validateTranslatedTree([{ type: 'observation' }]).ok, false, 'observation needs an id');
    assert.equal(validateTranslatedTree([{ type: 'fragment', fragmentId: 'f', paramBindings: { X: { kind: 'bogus' } } }]).ok, false);
    assert.equal(validateTranslatedTree([{ type: 'detect', branches: [{ condition: { conditions: [{ type: 'selector_present' }] }, body: [] }], default: [] }]).ok, false, 'detect must use orch_predicate');
    assert.equal(validateTranslatedTree([{ type: 'detect', branches: [{ condition: { conditions: [{ type: 'orch_predicate', binding: 'b', specJson: '{bad' }] }, body: [] }], default: [] }]).ok, false, 'specJson must parse');
    // a well-formed tree passes
    assert.equal(validateTranslatedTree([{ type: 'fragment', fragmentId: 'f', paramBindings: { X: { kind: 'literal', value: 'v' } } }]).ok, true);
  });

  it('assembleStrategy mirrors the canonical Tier-2 strategy shape (scalar params, fragmentSteps, synthesized)', () => {
    const s = assembleStrategy({ id: 'c', groundId: 'g', intent: 'My composite', aliases: ['x'] },
      { fragmentSteps: [{ type: 'fragment', fragmentId: 'f', paramBindings: {} }], params: [{ name: 'K', kind: 'scalar', type: 'string', required: false, label: 'K', default: 'd' }] },
      { strategyId: 's', now: 123 });
    assert.equal(s.id, 's'); assert.equal(s.groundId, 'g'); assert.equal(s.name, 'My composite');
    assert.equal(s.synthesized, true); assert.equal(s.fromComposite, 'c');
    assert.equal(s.fragmentSteps.length, 1); assert.equal(s.params[0].kind, 'scalar');
  });
});
