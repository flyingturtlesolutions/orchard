// Core/orchChain.test.js — ORCH-X front-end unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decomposeAsk, isCompoundAsk, assembleSequentialPlan, looksComplex, buildCompositeCapability, liftControlFlow } from './orchChain.js';
import { validatePlan } from './orchPlan.js';

describe('orchChain — decompose a compound ask + assemble a sequential plan (ORCH-X)', () => {
  it('decomposeAsk: a single intent stays one clause', () => {
    const c = decomposeAsk('search for music');
    assert.equal(c.length, 1);
    assert.equal(c[0].text, 'search for music');
    assert.equal(c[0].connective, null);
  });

  it('decomposeAsk: "search for x and filter by y" → two clauses (the bug)', () => {
    const c = decomposeAsk('search for music and filter by date');
    assert.deepEqual(c.map((x) => x.text), ['search for music', 'filter by date']);
    assert.equal(c[1].connective, 'and');
  });

  it('decomposeAsk: a value-joining "and" does NOT split ("cats and dogs")', () => {
    assert.deepEqual(decomposeAsk('search for cats and dogs').map((x) => x.text), ['search for cats and dogs']);
    assert.deepEqual(decomposeAsk('add milk and eggs to the cart').map((x) => x.text), ['add milk and eggs to the cart']);
  });

  it('decomposeAsk: "then" and commas are boundaries when a verb follows', () => {
    assert.deepEqual(decomposeAsk('open settings then enable dark mode').map((x) => x.text), ['open settings', 'enable dark mode']);
    assert.deepEqual(
      decomposeAsk('search for music, filter by date and sort by price').map((x) => x.text),
      ['search for music', 'filter by date', 'sort by price'],
    );
  });

  it('decomposeAsk: a connective left by a comma split is stripped from the clause text', () => {
    // "…, then sort" — the comma is the delimiter, so "then" leads the segment; the clause text must be bare.
    assert.deepEqual(decomposeAsk('find music, then sort by date').map((x) => x.text), ['find music', 'sort by date']);
  });

  it('decomposeAsk: a read clause can be chained after a do clause (observations live in chains)', () => {
    const c = decomposeAsk('search for gifs and how many results are there');
    assert.deepEqual(c.map((x) => x.text), ['search for gifs', 'how many results are there']);
  });

  it('isCompoundAsk: reflects clause count', () => {
    assert.equal(isCompoundAsk('search for music'), false);
    assert.equal(isCompoundAsk('search for music and filter by date'), true);
  });

  it('looksComplex: a long single sentence with a constraint signal → worth an LLM plan; short asks aren’t', () => {
    assert.equal(looksComplex('search for jobs'), false, 'short → single match');
    assert.equal(looksComplex('search for software engineers'), false, 'short → single match');
    assert.equal(looksComplex('search for software engineering jobs in minneapolis posted in the last 7 days'), true);
    assert.equal(looksComplex('find remote python developer roles sorted by newest'), true);
    assert.equal(looksComplex('search for remote software jobs $90000+'), true, 'short but a salary + work-type constraint');
    assert.equal(looksComplex('show me cheap flights under $200'), true, 'short but a price constraint');
  });

  it('assembleSequentialPlan: matched clauses → ordered fragment steps, validated', () => {
    const { plan, valid, gaps } = assembleSequentialPlan([
      { text: 'search for music', capabilityId: 'cap_search', bindings: { CATEGORY: 'Music' } },
      { text: 'filter by date', capabilityId: 'cap_filter', bindings: { WHEN: 'Last 3 days' } },
    ], { goal: 'search + filter' });
    assert.equal(valid, true, plan && JSON.stringify(plan));
    assert.equal(plan.steps.length, 2);
    assert.deepEqual(plan.steps.map((s) => s.kind), ['fragment', 'fragment']);
    assert.equal(plan.steps[0].capabilityId, 'cap_search');
    assert.deepEqual(plan.steps[1].bindings, { WHEN: 'Last 3 days' });
    assert.equal(gaps.length, 0);
  });

  it('assembleSequentialPlan: an unmatched clause becomes a GAP (record just that one), not a failure', () => {
    const { plan, gaps } = assembleSequentialPlan([
      { text: 'search for music', capabilityId: 'cap_search' },
      { text: 'filter by date', capabilityId: null },
    ]);
    assert.equal(plan.steps.length, 1, 'only the matched clause is a step');
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].text, 'filter by date');
    assert.equal(gaps[0].index, 1);
  });

  it('buildCompositeCapability: a verified compound → a durable T2 artifact riding the matcher rails', () => {
    const cap = buildCompositeCapability({
      id: 'cmp1', ask: 'search support jobs in minneapolis and tell me the first title', groundId: 'gnd_x',
      steps: [
        { capabilityId: 'cap_search', bindings: { KEYWORD: 'support', LOCATION: 'minneapolis' }, kind: null, clause: 'search support jobs in minneapolis', intent: 'Search jobs' },
        { capabilityId: 'obs_title', bindings: {}, kind: 'observation', clause: 'tell me the first title', intent: "what's the first title" },
      ],
    });
    assert.equal(cap.kind, 'composite');
    assert.equal(cap.effect, 'composite');
    assert.equal(cap.reversible, false, 'may contain an irreversible action → confirm-first');
    assert.equal(cap.groundId, 'gnd_x');
    assert.equal(cap.steps.length, 2);
    assert.equal(cap.steps[0].capabilityId, 'cap_search');
    assert.deepEqual(cap.steps[0].bindings, { KEYWORD: 'support', LOCATION: 'minneapolis' });
    assert.equal(cap.steps[1].kind, 'observation', 'the read step keeps its kind for the runner');
  });

  it('buildCompositeCapability: steps without a capabilityId are dropped', () => {
    const cap = buildCompositeCapability({ ask: 'x and y', groundId: 'g', steps: [{ capabilityId: 'a' }, { clause: 'gap' }, { capabilityId: 'b' }] });
    assert.deepEqual(cap.steps.map((s) => s.capabilityId), ['a', 'b']);
  });

  it('liftControlFlow: "the salaries of EACH job" → a foreach over the list, body = the trailing read; it validates', () => {
    const flat = [
      { capabilityId: 'cap-search', intent: 'search jobs', kind: null, clause: 'search recent jobs in japan' },
      { capabilityId: 'obs-jobs', intent: 'the job list', kind: 'observation', outputType: 'list', clause: 'each job' },
      { capabilityId: 'obs-salary', intent: 'the salary', kind: 'observation', outputType: 'scalar', clause: 'the salaries of each' },
    ];
    const { steps, lifted, collect } = liftControlFlow(flat, 'search recent jobs in japan, the salaries of each job');
    assert.equal(lifted, true);
    assert.equal(steps.length, 3);                                  // search(fragment) · jobs(observe list) · foreach
    assert.equal(steps[0].kind, 'fragment');
    assert.equal(steps[1].kind, 'observe');
    assert.equal(steps[2].kind, 'foreach');
    assert.equal(steps[2].over, steps[1].id, 'the foreach iterates the list observe');
    assert.equal(steps[2].body.length, 1);
    assert.equal(steps[2].body[0].kind, 'observe', 'the per-item salary read is the body');
    assert.equal(collect, 'THE_SALARY');
    assert.deepEqual(validatePlan({ steps }).errors, [], 'the lifted plan is well-formed');
  });

  it('liftControlFlow: no quantifier, or no list step → returned FLAT (unchanged)', () => {
    const flat = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'list', clause: 'the jobs' },
      { capabilityId: 'c', kind: 'observation', outputType: 'scalar', clause: 'the first salary' },
    ];
    assert.equal(liftControlFlow(flat, 'search jobs and the first salary').lifted, false, 'no quantifier → flat');
    const noList = [
      { capabilityId: 'a', kind: null, clause: 'search' },
      { capabilityId: 'b', kind: 'observation', outputType: 'scalar', clause: 'the title of each' },
    ];
    assert.equal(liftControlFlow(noList, 'search and the title of each').lifted, false, 'no list-output step → flat');
  });
});
