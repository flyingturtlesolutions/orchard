// Core/capabilitySynth.test.js — SG-T2-ACC unit tests (node --test). PURE: synthetic phases.
// Node 16.15.1 has no `node:test` runner here; run via the temp-dir ESM harness. These document the contract.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildTier2CapabilityRecords, buildCapabilityRecords, wrapFragmentAsStrategy, collectReferencedPrimitiveIds, prepareTier1or2Records } from './capabilitySynth.js';

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
    // the inline landmark survives on the CLICK (a pacing WAIT now precedes it, so it isn't at index 0)
    assert.ok(payActions.find((a) => a.action === 'CLICK' && a.selector === '#update')?.landmark, 'inline landmark kept for probe-or-recover');
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
    assert.ok(Array.isArray(r.fragment.preconditions) && Array.isArray(r.fragment.postconditions), 'conditions are ARRAYS, not envelopes');
  });
});

describe('buildTier2CapabilityRecords — synthesis quality: description as intent + carried postconditions', () => {
  const searchPhase = {
    label: 'Search',
    actions: [
      { action: 'SCROLL_TO', selector: '#what', optional: true },
      { action: 'TYPE', selector: '#what', value: '{{SEARCH_KEYWORDS}}', landmark: { accessibleName: 'Job title' } },
      { action: 'TYPE', selector: '#where', value: '{{EDIT_LOCATION}}' },
      { action: 'CLICK', selector: '#go', landmark: { accessibleName: 'Find jobs' } },
    ],
    postcondition: { match: 'any', conditions: [{ type: 'selector_present', selector: '.results' }], source: 'structural' },
  };
  const filterPhase = { label: 'Filter', actions: [{ action: 'CLICK', selector: '#f' }] };   // no postcondition

  it('the description is an expression of intent (label + action summary), not the bare label', () => {
    const r = buildTier2CapabilityRecords([searchPhase, filterPhase], { groundId: 'g', strategyId: 's', fragmentIds: ['f1', 'f2'], params: [{ name: 'SEARCH_KEYWORDS' }] });
    const desc = r.fragments[0].description;
    assert.match(desc, /^Search — /, 'keeps the label, adds a summary');
    assert.match(desc, /search keywords/, 'a {{PARAM}} TYPE reads as its humanized param, not the bare token');
    assert.match(desc, /edit location/);
    assert.match(desc, /click Find jobs/, 'a CLICK reads its landmark name');
    assert.ok(!/SCROLL_TO/.test(desc), 'normalizer actions are not described');
  });

  it('the node postcondition (envelope) is carried onto the fragment as an ARRAY (runtime reads arrays)', () => {
    const r = buildTier2CapabilityRecords([searchPhase, filterPhase], { groundId: 'g', strategyId: 's', fragmentIds: ['f1', 'f2'] });
    assert.ok(Array.isArray(r.fragments[0].postconditions), 'an ARRAY → Array.isArray true → actually evaluated at runtime');
    assert.deepEqual(r.fragments[0].postconditions, [{ type: 'selector_present', selector: '.results' }]);
    assert.ok(Array.isArray(r.fragments[0].preconditions) && r.fragments[0].preconditions.length === 0);
    assert.deepEqual(r.fragments[1].postconditions, [], 'a phase with no node postcondition → empty array, not an envelope');
  });

  it('anti-bot pacing: a human-cadence WAIT (base+jitter) precedes each interactive action; SCROLL_TO preserved', () => {
    const r = buildTier2CapabilityRecords([searchPhase, filterPhase], { groundId: 'g', strategyId: 's', fragmentIds: ['f1', 'f2'] });
    const acts = JSON.parse(r.fragments[0].rawJson);
    const firstType = acts.findIndex((a) => a.action === 'TYPE');
    assert.ok(firstType > 0 && acts[firstType - 1].action === 'WAIT', 'a WAIT precedes the first TYPE');
    const waits = acts.filter((a) => a.action === 'WAIT');
    assert.equal(waits.length, 3, 'one WAIT per interactive action (2 TYPE + 1 CLICK)');
    assert.ok(waits.every((w) => Number(w.value) > 0 && Number(w.jitter) > 0), 'each WAIT carries base + jitter (runtime randomizes)');
    assert.ok(acts.some((a) => a.action === 'SCROLL_TO'), 'SCROLL_TO reach-normalizers are preserved');
  });

  it('prepareTier1or2Records — ONE phase → a bare Fragment (no Strategy), with name/description override', () => {
    const r = prepareTier1or2Records([searchPhase], { groundId: 'g', strategyId: 's', fragmentIds: ['f1'], name: 'x', goal: 'x', fragmentName: 'Search jobs by title and location', fragmentDescription: 'Find roles by keyword + place' });
    assert.equal(r.ok, true);
    assert.equal(r.isSingleT1, true);
    assert.equal(r.strategy, null, 'no Strategy wrapper for a single T1');
    assert.equal(r.fragments.length, 1);
    assert.equal(r.fragments[0].name, 'Search jobs by title and location', 'the lone Fragment gets the polished name');
    assert.equal(r.fragments[0].description, 'Find roles by keyword + place');
  });

  it('prepareTier1or2Records — TWO phases → a Strategy chaining them, carrying the aliases', () => {
    const r = prepareTier1or2Records([searchPhase, filterPhase], { groundId: 'g', strategyId: 's', fragmentIds: ['f1', 'f2'], name: 'x', goal: 'x', aliases: ['find jobs', 'look for roles'] });
    assert.equal(r.isSingleT1, false);
    assert.ok(r.strategy, 'a Strategy is produced for ≥2 phases');
    assert.deepEqual(r.strategy.aliases, ['find jobs', 'look for roles']);
    assert.equal(r.strategy.fragmentSteps.length, 2);
  });

  it('fragment preconditions stay EMPTY — a perspective_ref gate was backed out (fatal + all-landmarks; see b5)', () => {
    const r = buildTier2CapabilityRecords([searchPhase, filterPhase], { groundId: 'g', strategyId: 's', fragmentIds: ['f1', 'f2'] });
    assert.deepEqual(r.fragments[0].preconditions, []);
    assert.deepEqual(r.fragments[1].preconditions, []);
  });

  it('a CLICK with no landmark name (landmarkRef only) → a readable selector hint, not "the control"', () => {
    const phase = { label: 'Search', actions: [{ action: 'CLICK', selector: 'button.yosegi-InlineWhatWhere-primaryButton', landmarkRef: { uid: 'lmk_x' } }] };
    const r = buildTier2CapabilityRecords([phase, filterPhase], { groundId: 'g', strategyId: 's', fragmentIds: ['f1', 'f2'] });
    assert.match(r.fragments[0].description, /the primary button/, 'recognizes a commit button from the selector');
    assert.ok(!/the control/.test(r.fragments[0].description));
  });
});

describe('wrapFragmentAsStrategy — run a bare T1 Fragment without persisting a Strategy (T1-as-first-class)', () => {
  const fragment = {
    id: 'frag-1', groundId: 'g', name: 'Search jobs', description: 'search the job board',
    rawJson: JSON.stringify([{ action: 'TYPE', selector: '#q', value: '{{KEYWORD}}' }, { action: 'CLICK', selector: '#go' }]),
    params: ['KEYWORD'],
    preconditions: { match: 'all', conditions: [] }, postconditions: { match: 'all', conditions: [{ type: 'selector_present', selector: '.results' }] },
  };

  it('wraps a Fragment into a synthetic one-step strategy tree (the shape executeStrategy runs)', () => {
    const s = wrapFragmentAsStrategy(fragment, { now: 5 });
    assert.equal(s.synthetic, true, 'flagged as a run-time wrapper, not a persisted artifact');
    assert.equal(s.id, 'fragment:frag-1', 'synthetic id is never written to storage');
    assert.equal(s.groundId, 'g');
    assert.equal(s.fragmentSteps.length, 1);
    assert.equal(s.fragmentSteps[0].type, 'fragment');
    assert.equal(s.fragmentSteps[0].fragmentId, 'frag-1');
    // the fragment's postconditions ride onto the wrapper so the run still verifies the effect
    assert.deepEqual(s.postconditions.conditions[0], { type: 'selector_present', selector: '.results' });
  });

  it('fragment param NAMES become strategy_param bindings (so {{NAME}} placeholders fill at run time)', () => {
    const s = wrapFragmentAsStrategy(fragment, {});
    assert.deepEqual(s.params.map((p) => p.name), ['KEYWORD']);
    assert.equal(s.params[0].kind, 'scalar');
    assert.deepEqual(s.fragmentSteps[0].paramBindings.KEYWORD, { kind: 'strategy_param', name: 'KEYWORD' });
  });

  it('null / id-less input → null (fail safe)', () => {
    assert.equal(wrapFragmentAsStrategy(null, {}), null);
    assert.equal(wrapFragmentAsStrategy({ name: 'no id' }, {}), null);
  });
});

describe('collectReferencedPrimitiveIds — which fragments/observations are STEPS of a composite (T1-as-first-class)', () => {
  it('collects fragmentIds + observationIds across fragmentSteps, detect branches, and foreach bodies', () => {
    const strat = {
      fragmentSteps: [
        { type: 'fragment', fragmentId: 'f-search' },
        { type: 'observation', observationId: 'o-jobs' },
        { type: 'detect', branches: [{ condition: {}, body: [{ type: 'fragment', fragmentId: 'f-sort' }] }], default: [{ type: 'fragment', fragmentId: 'f-default' }] },
        { type: 'foreach', body: [{ type: 'fragment', fragmentId: 'f-open' }, { type: 'observation', observationId: 'o-salary' }] },
      ],
    };
    const { fragmentIds, observationIds } = collectReferencedPrimitiveIds([strat]);
    assert.deepEqual([...fragmentIds].sort(), ['f-default', 'f-open', 'f-search', 'f-sort']);
    assert.deepEqual([...observationIds].sort(), ['o-jobs', 'o-salary']);
  });

  it('also walks the implementations envelope (body.tree.fragmentSteps) and top-level composition steps', () => {
    const wrapped = { implementations: [{ tier: 'cache', body: { tree: { fragmentSteps: [{ type: 'fragment', fragmentId: 'f-impl' }] } } }] };
    const workflow = { steps: [{ type: 'fragment', fragmentId: 'f-compose' }] };
    const { fragmentIds } = collectReferencedPrimitiveIds([wrapped, workflow]);
    assert.ok(fragmentIds.has('f-impl') && fragmentIds.has('f-compose'));
  });

  it('a STANDALONE fragment (not a step of any tree) is NOT collected → it surfaces as its own capability', () => {
    const strat = { fragmentSteps: [{ type: 'fragment', fragmentId: 'f-step' }] };
    const { fragmentIds } = collectReferencedPrimitiveIds([strat]);
    assert.ok(fragmentIds.has('f-step'));
    assert.ok(!fragmentIds.has('f-standalone'), 'a fragment no tree references stays standalone');
    assert.deepEqual(collectReferencedPrimitiveIds([]), collectReferencedPrimitiveIds(null), 'empty/null → empty sets, no throw');
  });
});
