// Core/feedbackLearn.test.js — ORCH-FB-2 unit tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { feedbackExamples, feedbackAdjustment } from './feedbackLearn.js';

const ev = (capabilityId, phrase, polarity) => ({ detail: { capabilityId, phrase, [polarity]: true } });

describe('feedbackLearn — deterministic relevance shaping from feedback history (ORCH-FB-2)', () => {
  it('feedbackExamples: groups confirmed/rejected phrases per capability', () => {
    const ex = feedbackExamples([
      ev('A', 'search for music', 'confirmed'),
      ev('A', 'search for sound effects', 'rejected'),
      ev('B', 'open settings', 'confirmed'),
      { detail: { capabilityId: 'A' } },   // an unrelated/accept event (no polarity) is ignored
    ]);
    assert.deepEqual(ex.confirmed.A, ['search for music']);
    assert.deepEqual(ex.rejected.A, ['search for sound effects']);
    assert.deepEqual(ex.confirmed.B, ['open settings']);
    assert.equal(ex.rejected.B, undefined);
  });

  it('feedbackExamples: dedupes + keeps most recent per polarity', () => {
    const ex = feedbackExamples([
      ev('A', 'x', 'confirmed'), ev('A', 'y', 'confirmed'), ev('A', 'x', 'confirmed'),
    ], { maxPer: 2 });
    assert.deepEqual(ex.confirmed.A, ['y', 'x'], 'x moved to most-recent; capped at 2');
  });

  it('feedbackAdjustment: a near-CONFIRMED ask gets a boost', () => {
    const ex = feedbackExamples([ev('A', 'search for music', 'confirmed')]);
    const adj = feedbackAdjustment('search for jazz music', 'A', ex);
    assert.ok(adj > 0, 'near a confirmed phrase → positive');
    assert.ok(adj <= 0.15, 'bounded by maxBoost');
  });

  it('feedbackAdjustment: a near-REJECTED ask gets a (heavier) penalty', () => {
    const ex = feedbackExamples([ev('A', 'search for sound effects', 'rejected')]);
    const adj = feedbackAdjustment('find sound effects', 'A', ex);
    assert.ok(adj < 0, 'near a rejected phrase → negative');
    assert.ok(adj >= -0.3, 'bounded by maxPenalty');
  });

  it('feedbackAdjustment: rejection outweighs confirmation when an ask is near BOTH (precision-first)', () => {
    const ex = feedbackExamples([
      ev('A', 'search music', 'confirmed'),
      ev('A', 'search music', 'rejected'),   // contradictory history on the same phrase
    ]);
    assert.ok(feedbackAdjustment('search music', 'A', ex) < 0, 'a "no" weighs more than a "yes"');
  });

  it('feedbackAdjustment: no history / unrelated ask → 0 (the normal path is untouched)', () => {
    const ex = feedbackExamples([ev('A', 'search for music', 'confirmed')]);
    assert.equal(feedbackAdjustment('book a flight', 'A', ex), 0, 'no token overlap → 0');
    assert.equal(feedbackAdjustment('anything', 'B', ex), 0, 'no history for B → 0');
    assert.equal(feedbackAdjustment('x', 'A', null), 0, 'no examples → 0');
  });
});
