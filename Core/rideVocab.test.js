// Core/rideVocab.test.js — CX-9q (v2.74.1462): host-level DOMAIN-MATCH vocabulary. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { vocabTokens, groundVocabIndex } from './rideVocab.js';

describe('rideVocab — tokenization (the v1450 rule)', () => {
  it('keeps ≥5-char words, lowercased; drops short/glue words and non-letters', () => {
    const t = vocabTokens('Warranty tasks by status — new / open / fixed for a division (210)');
    assert.ok(t.has('warranty') && t.has('tasks') && t.has('status') && t.has('division'));
    assert.ok(!t.has('new') && !t.has('open') && !t.has('by') && !t.has('210'));
  });
  it('null/empty → empty set', () => {
    assert.equal(vocabTokens(null).size, 0);
    assert.equal(vocabTokens('').size, 0);
  });
});

describe('rideVocab — groundVocabIndex distinctiveness', () => {
  it('a word shared by two DIFFERENT hosts drops everywhere; unique words survive', () => {
    const idx = groundVocabIndex([
      { gid: 'g1', host: 'a.example.com', texts: ['warranty tasks riding your login'] },
      { gid: 'g2', host: 'b.example.com', texts: ['ticket queue riding your login'] },
    ]);
    assert.ok(!idx[0].vocab.has('riding') && !idx[1].vocab.has('riding'));   // shared → gone
    assert.ok(!idx[0].vocab.has('login') && !idx[1].vocab.has('login'));
    assert.ok(idx[0].vocab.has('warranty'));                                 // unique → kept
    assert.ok(idx[1].vocab.has('ticket'));
  });

  it('v1462 REGRESSION LOCK — a DUPLICATE ground on the SAME host reinforces, never annihilates', () => {
    // The live bug: two vendorsuite grounds, both seeded with the same curated catalog → ground-level counting
    // deleted the whole site vocabulary ("warranty" counted as shared-by-2) → DOMAIN-MATCH could never fire.
    const idx = groundVocabIndex([
      { gid: 'g1', host: 'vendorsuite.drhorton.com', texts: ['Warranty task counts for a division'] },
      { gid: 'g2', host: 'VendorSuite.drhorton.com', texts: ['Warranty task counts for a division'] },   // dup, case-insensitive host
      { gid: 'g3', host: 'deako.zendesk.com', texts: ['search your Zendesk tickets'] },
    ]);
    assert.ok(idx[0].vocab.has('warranty'), 'same-host duplicate must NOT delete the site vocabulary');
    assert.ok(idx[1].vocab.has('warranty'));
    assert.ok(idx[0].vocab.has('division') && idx[0].vocab.has('counts'));
    assert.ok(idx[2].vocab.has('zendesk') && idx[2].vocab.has('tickets'));
    assert.ok(!idx[2].vocab.has('warranty'));
  });

  it('empty/malformed input → empty index; missing texts tolerated', () => {
    assert.deepEqual(groundVocabIndex(null), []);
    const idx = groundVocabIndex([{ gid: 'g1', host: 'x.com' }]);
    assert.equal(idx[0].vocab.size, 0);
  });
});
