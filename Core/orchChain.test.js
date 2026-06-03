// Core/orchChain.test.js — ORCH-X front-end unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { decomposeAsk, isCompoundAsk, assembleSequentialPlan } from './orchChain.js';

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
});
