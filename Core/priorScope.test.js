// Core/priorScope.test.js — PP-4 (v2.74.1686): the empty-prior stop.
//
// The whole point is a NARROW guard. Two ways to get this wrong, and the tests pin both: too loose and it blocks
// steps that never depended on the prior; too tight and an outward write runs on a set that matched nothing —
// which is what happened live (trace 070307, `narrowed prior → 0 of 1` followed by two Zendesk write dispatches).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { refersToPrior, priorIsEmptySet, emptyPriorStop } from './priorScope.js';

describe('priorScope — [] and null are DIFFERENT, and the difference is the whole signal', () => {
  it('an empty array means "we looked and found none"', () => {
    assert.equal(priorIsEmptySet([]), true);
    assert.equal(priorIsEmptySet({ results: [] }), true);
  });

  it('null/undefined mean "nothing has run yet" — no evidence about the next step', () => {
    // Treating these as empty would stop the FIRST step of every workflow, which is the opposite failure.
    for (const v of [null, undefined]) assert.equal(priorIsEmptySet(v), false);
  });

  it('a non-empty set, or a non-collection value, is not an empty set', () => {
    assert.equal(priorIsEmptySet([{}]), false);
    assert.equal(priorIsEmptySet({ results: [{}] }), false);
    for (const v of ['', 0, false, 'text', {}, { results: 'x' }]) assert.equal(priorIsEmptySet(v), false);
  });
});

describe('priorScope — a back-reference is an explicit pointer, not topic overlap', () => {
  it('catches the ways a step points at the prior set', () => {
    for (const t of [
      'create a draft order for each of them', 'look each one up in Shopify', 'create a case for those',
      'send them an email', 'open a case for these', 'create a case for the ones that matched',
      'for every one, add a note', 'summarise the results',
    ]) assert.equal(refersToPrior(t), true, t);
  });

  it('does NOT fire on a step that merely shares vocabulary', () => {
    // This is the false-positive that would block real work: same nouns, no back-reference. Such a step is
    // self-contained and must run even when the previous one matched nothing.
    for (const t of [
      'get all new warranty tasks', 'open shopify.com', 'create a warranty summary case',
      'check the connection vitals', 'show the dashboard', '',
    ]) assert.equal(refersToPrior(t), false, t);
  });
});

describe('priorScope — the stop fires only when BOTH conditions hold', () => {
  it('THE LIVE BUG: empty prior + a back-referencing step → stop', () => {
    const r = emptyPriorStop({ text: 'create a draft order for each of them', priorValue: [], narrowedFrom: 22 });
    assert.equal(r.stop, true);
    assert.equal(r.why, 'empty-prior');
    assert.match(r.message, /0 of 22/);
  });

  it('empty prior + a self-contained step → RUNS, because it never depended on the prior', () => {
    const r = emptyPriorStop({ text: 'open shopify.com', priorValue: [] });
    assert.equal(r.stop, false);
    assert.equal(r.why, 'no-back-reference');
  });

  it('a back-reference with a NON-empty prior → runs, obviously', () => {
    assert.equal(emptyPriorStop({ text: 'create one for each of them', priorValue: [{}, {}] }).stop, false);
  });

  it('nothing has run yet → never stops', () => {
    assert.equal(emptyPriorStop({ text: 'create one for each of them', priorValue: null }).stop, false);
    assert.equal(emptyPriorStop({}).stop, false);
  });

  it('the message states a RESULT, not a failure', () => {
    // A run that correctly found nothing has not gone wrong. Phrasing it as an error is how a person learns to
    // ignore the report — and this is the report standing between an empty set and an outward write.
    const m = emptyPriorStop({ text: 'create a case for each', priorValue: [] }).message;
    assert.match(m, /Nothing to do/);
    assert.match(m, /Nothing was created or sent/);
    assert.ok(!/error|failed|couldn|problem/i.test(m), m);
  });

  it('reports the narrowed-from count only when there is one', () => {
    assert.ok(!/0 of/.test(emptyPriorStop({ text: 'for each', priorValue: [] }).message));
    assert.match(emptyPriorStop({ text: 'for each', priorValue: [], narrowedFrom: 5 }).message, /0 of 5/);
  });

  it('degenerate input does not throw', () => {
    for (const bad of [undefined, null, {}, { text: 42, priorValue: 'x' }]) assert.doesNotThrow(() => emptyPriorStop(bad));
  });
});
