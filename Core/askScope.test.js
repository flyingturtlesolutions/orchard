// Core/askScope.test.js — existential scope (v2.74.1884). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isExistentialAsk, existentialToken, askedMetric } from './askScope.js';

describe('askScope — the three live phrasings that were narrowed', () => {
  // trace 071412: all three bound divisionId:"" and were answered from one of 121 divisions
  for (const q of ['get one open warranty request', 'get any open warranty request', 'get the first warranty task']) {
    it(`existential: "${q}"`, () => assert.equal(isExistentialAsk(q), true));
  }
  it('names the token that earned it, so the trace line is checkable', () => {
    assert.equal(existentialToken('get any open warranty request'), 'any');
    assert.equal(existentialToken('get one open warranty request'), 'one');
    assert.equal(existentialToken('get the first warranty task'), 'first');
  });
});

describe('askScope — the family', () => {
  for (const q of ['give me some open tasks', 'what is the next warranty task', 'find the latest task', 'the oldest open task', 'get another one'])
    it(`existential: "${q}"`, () => assert.equal(isExistentialAsk(q), true));
});

describe('askScope — what it must NOT claim', () => {
  it('a COLLECTIVE ask wants the whole set, not one of them', () => {
    for (const q of ['get all open warranty tasks', 'every open task', 'for each division get open warranty tasks', 'how many jobs am I sitting on', 'total allowed amount', 'list all tasks'])
      assert.equal(isExistentialAsk(q), false, q);
  });
  it('a plain scoped read is not existential', () => {
    for (const q of ['get open warranty tasks', 'get open warranty tasks in Charlotte North', 'read warranty task 4867009', 'warranty tasks on Misty Creek'])
      assert.equal(isExistentialAsk(q), false, q);
  });
  it('COLLECTIVE beats EXISTENTIAL when both appear', () => {
    assert.equal(isExistentialAsk('get all of any status'), false);
    assert.equal(isExistentialAsk('how many are in a division'), false);
  });
  it('a long compound ask gets its scope elsewhere', () => {
    assert.equal(isExistentialAsk('get any open warranty task and then open a case for the homeowner at that address'), false);
  });
  it('empty and junk are not existential', () => {
    for (const q of ['', '   ', null, undefined]) assert.equal(isExistentialAsk(q), false);
    assert.equal(existentialToken(''), '');
  });
});

describe('askScope — a BARE ARTICLE is not a quantifier', () => {
  // The first draft included `a`/`an` and every one of these came back true. An over-eager widen would have spent 121
  // reads on asks that named no scope because they were not about scope at all.
  for (const q of ['open a case about the leaking dishwasher', 'draft a reply to the homeowner', 'create a sub-task for this', 'get warranty tasks for a homeowner', 'show me a warranty task'])
    it(`NOT existential: "${q}"`, () => assert.equal(isExistentialAsk(q), false));
});

describe('askScope — the honest limit of a word-level rule', () => {
  it('an ask that NAMES its scope is still flagged — the caller must check explicit FIRST', () => {
    // "any task in Raleigh" carries both. This module cannot rank them; the resolver's explicit rung already wins
    // before widening is consulted, and that ordering is the contract. Pinned so the limitation is visible rather
    // than discovered.
    assert.equal(isExistentialAsk('get any task in Raleigh'), true);
  });
});

// v2.74.1889 — the live payload's own measure labels (PAYLOAD ▸ [vs_warranty_stats], gl 09:32/09:48).
const STATS_M = { newwarrantytasks: 0, openwarrantytasks: 0, fixedwarrantytasks: 402 };

describe('askedMetric — a zero COUNT is as empty as zero rows', () => {
  it('THE LIVE CASE: "open" selects the open bucket, which is 0 → the widen may proceed', () => {
    const m = askedMetric('is there anything open right now?', STATS_M);
    assert.deepEqual(m, { label: 'openwarrantytasks', value: 0 });
  });
  it('a token EVERY label carries discriminates nothing — "warranty" must not sum all three', () => {
    // matching on "warranty" would return 402 and conclude "there is something open" from the FIXED ones
    assert.equal(askedMetric('get any warranty request', STATS_M), null);
  });
  it('a non-zero measure is a real hit — the scan stops there', () => {
    assert.deepEqual(askedMetric('anything fixed?', STATS_M), { label: 'fixedwarrantytasks', value: 402 });
  });
  it('two named measures are summed — "is there any" is satisfied by either', () => {
    const m = askedMetric('any open or fixed ones?', STATS_M);
    assert.equal(m.value, 402);
    assert.match(m.label, /openwarrantytasks \+ fixedwarrantytasks|fixedwarrantytasks \+ openwarrantytasks/);
  });
  it('no measures, no metrics object, or no matching word → null, and the caller keeps the row test', () => {
    assert.equal(askedMetric('is there anything open right now?', {}), null);
    assert.equal(askedMetric('is there anything open right now?', null), null);
    assert.equal(askedMetric('is there anything urgent?', STATS_M), null);
    assert.equal(askedMetric('anything open?', { Total: 'x' }), null, 'non-numeric values are not measures');
  });
  it('a SINGLE-measure payload still matches (the all-labels-carry-it rule cannot apply to one)', () => {
    assert.deepEqual(askedMetric('anything open?', { openTasks: 0 }), { label: 'openTasks', value: 0 });
  });
  it('short tokens are ignored — "any" must not match "companyTotals"', () => {
    assert.equal(askedMetric('any?', { companyTotals: 5, other: 1 }), null);
  });
});

describe('askedMetric — a short token must not match mid-word (v1889, its own test caught this)', () => {
  it('"new" still selects a new-bucket — a flat 4-char floor would have dropped a real status word', () => {
    assert.deepEqual(askedMetric('is there anything new anywhere?', STATS_M), { label: 'newwarrantytasks', value: 0 });
  });
  it('a camelCase segment matches exactly', () => {
    assert.deepEqual(askedMetric('anything open?', { TotalOpen: 2, TotalClosed: 9 }), { label: 'TotalOpen', value: 2 });
  });
  it('an underscore segment matches exactly', () => {
    assert.deepEqual(askedMetric('any new ones?', { new_tasks: 0, done_tasks: 4 }), { label: 'new_tasks', value: 0 });
  });
});
