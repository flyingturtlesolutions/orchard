// Core/connectorAlias.test.js — CX-9p (v2.74.1461) connector-leg alias store (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { aliasSignature, recordAlias, recallAlias } from './connectorAlias.js';

describe('aliasSignature — stable, order-independent content-word shape', () => {
  it('sorted-unique content words; glue + pure-digit tokens dropped', () => {
    const sig = aliasSignature('pull up the warranty task at 3955 Gallery Chase in Atlanta West, fixed');
    assert.deepEqual(sig, ['atlanta', 'chase', 'fixed', 'gallery', 'pull', 'task', 'warranty', 'west']);
    assert.ok(!sig.includes('3955'), 'a bare number never enters the signature');
    assert.ok(!sig.includes('the') && !sig.includes('at') && !sig.includes('in'), 'glue dropped');
  });
  it('order-independent (recall is set similarity)', () => {
    assert.deepEqual(aliasSignature('warranty task fixed'), aliasSignature('fixed task warranty'));
  });
  it('empty / value-only ask → []', () => {
    assert.deepEqual(aliasSignature('  3955 100  '), []);
    assert.deepEqual(aliasSignature(''), []);
  });
});

describe('recordAlias — bounded LRU, dedup on (signature, ref)', () => {
  it('records a new association', () => {
    const s = recordAlias([], { ask: 'pull up the warranty task', legRef: 'me.vs.warranty@vendorsuite', host: 'vendorsuite.drhorton.com', at: 10 });
    assert.equal(s.length, 1);
    assert.equal(s[0].ref, 'me.vs.warranty@vendorsuite');
    assert.equal(s[0].count, 1);
    assert.equal(s[0].host, 'vendorsuite.drhorton.com');
  });
  it('a repeat of the same shape+ref bumps count + recency, moves to end (no growth)', () => {
    let s = recordAlias([], { ask: 'warranty task details', legRef: 'L', at: 1 });
    s = recordAlias(s, { ask: 'other thing', legRef: 'M', at: 2 });
    s = recordAlias(s, { ask: 'details task warranty', legRef: 'L', at: 3 });   // same signature (reordered) + same ref
    assert.equal(s.length, 2, 'no new row for a known (shape,ref)');
    const l = s.find((e) => e.ref === 'L');
    assert.equal(l.count, 2);
    assert.equal(l.at, 3);
    assert.equal(s[s.length - 1].ref, 'L', 'most-recently-used moved to the end');
  });
  it('blank ask/ref or value-only ask → no-op', () => {
    assert.equal(recordAlias([], { ask: '', legRef: 'L', at: 1 }).length, 0);
    assert.equal(recordAlias([], { ask: 'warranty', legRef: '', at: 1 }).length, 0);
    assert.equal(recordAlias([], { ask: '3955', legRef: 'L', at: 1 }).length, 0);
  });
  it('is pure (input store untouched) and bounded to 200', () => {
    const orig = [];
    const s = recordAlias(orig, { ask: 'warranty task', legRef: 'L', at: 1 });
    assert.equal(orig.length, 0, 'input not mutated');
    let big = [];
    for (let i = 0; i < 210; i++) big = recordAlias(big, { ask: `distinct shape number word${i}`, legRef: `ref${i}`, at: i });
    assert.equal(big.length, 200, 'bounded LRU');
    assert.ok(!big.some((e) => e.ref === 'ref0'), 'oldest dropped');
  });
});

describe('recallAlias — conservative warm-path recall', () => {
  const store = recordAlias([], {
    ask: 'on vendorsuite pull up the warranty task at 3955 Gallery Chase in Atlanta West, fixed and show details',
    legRef: 'me.vendorsuite.warranty@vendorsuite.drhorton.com', host: 'vendorsuite.drhorton.com', at: 100,
  });

  it('the near-identical UNNAMED re-ask recalls the vendorsuite leg (the whole point)', () => {
    const hit = recallAlias(store, 'pull up the warranty task at 3955 Gallery Chase in Atlanta West, fixed and show details');
    assert.ok(hit, 'a warm path exists');
    assert.equal(hit.ref, 'me.vendorsuite.warranty@vendorsuite.drhorton.com');
    assert.equal(hit.host, 'vendorsuite.drhorton.com');
  });

  it('returns null below the shared-token / Jaccard floor (a differing ask is not force-matched)', () => {
    assert.equal(recallAlias(store, 'how many open tickets do I have'), null);
    assert.equal(recallAlias(store, 'warranty'), null, 'one shared word is under minShared');
  });

  it('null on an empty store / too-short ask', () => {
    assert.equal(recallAlias([], 'warranty task details please'), null);
    assert.equal(recallAlias(store, 'hi'), null);
  });

  it('ties break toward the higher-count (more-proven) association', () => {
    let s = recordAlias([], { ask: 'draft the weekly ops report summary', legRef: 'A', at: 1 });
    s = recordAlias(s, { ask: 'draft the weekly ops report summary', legRef: 'A', at: 2 });   // A: count 2
    s = recordAlias(s, { ask: 'draft the weekly ops report summary', legRef: 'B', at: 3 });   // B: count 1, same shape
    const hit = recallAlias(s, 'draft the weekly ops report summary');
    assert.equal(hit.ref, 'A', 'the more-confirmed association wins the tie');
  });
});
