// Core/groundReadiness.test.js — G1-3 readiness classifier (node --test). PURE.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { groundReadiness, isReadyAtLeast, READINESS_RANK } from './groundReadiness.js';

describe('groundReadiness — G1-3 substrate-count classifier', () => {
  it('empty: nothing explored, nothing authored (a freshly-minted Ground)', () => {
    const r = groundReadiness({ localeCount: 0, capabilityCount: 0, siteMapNodeCount: 0 });
    assert.equal(r.state, 'empty');
    assert.equal(r.rank, 0);
  });
  it('preparing: territory seen (locale OR siteMap node) but no authored capability', () => {
    assert.equal(groundReadiness({ localeCount: 1 }).state, 'preparing');
    assert.equal(groundReadiness({ siteMapNodeCount: 9 }).state, 'preparing');   // crawled, not yet explored
    assert.equal(groundReadiness({ localeCount: 4, capabilityCount: 0 }).state, 'preparing');
  });
  it('capable: ≥1 authored capability — even before "rich" coverage', () => {
    assert.equal(groundReadiness({ localeCount: 1, capabilityCount: 1 }).state, 'capable');
    assert.equal(groundReadiness({ localeCount: 2, capabilityCount: 4 }).state, 'capable');   // caps<5 → not rich
    assert.equal(groundReadiness({ localeCount: 10, capabilityCount: 4 }).state, 'capable');  // caps<5 → not rich
  });
  it('rich: broad coverage (≥5 caps AND ≥3 locales)', () => {
    assert.equal(groundReadiness({ localeCount: 3, capabilityCount: 5 }).state, 'rich');
    assert.equal(groundReadiness({ localeCount: 8, capabilityCount: 20, siteMapNodeCount: 40 }).state, 'rich');
    assert.equal(groundReadiness({ localeCount: 2, capabilityCount: 5 }).state, 'capable');   // locales<3 → not rich
  });
  it('monotonic at the boundaries', () => {
    assert.equal(groundReadiness({ localeCount: 3, capabilityCount: 4 }).state, 'capable');   // one short of rich
    assert.equal(groundReadiness({ localeCount: 3, capabilityCount: 5 }).state, 'rich');      // hits rich
  });
  it('degrades gracefully: missing / malformed / negative counts → coerced to 0', () => {
    assert.equal(groundReadiness().state, 'empty');
    assert.equal(groundReadiness({}).state, 'empty');
    assert.equal(groundReadiness({ localeCount: 'x', capabilityCount: null }).state, 'empty');
    assert.equal(groundReadiness({ localeCount: -5, capabilityCount: -1 }).state, 'empty');
    assert.deepEqual(groundReadiness({ localeCount: 2.9 }).signals.localeCount, 2);   // truncated
  });
});

describe('groundReadiness — isReadyAtLeast', () => {
  it('rank-compares states, unknown → false', () => {
    assert.equal(isReadyAtLeast('capable', 'capable'), true);
    assert.equal(isReadyAtLeast('rich', 'capable'), true);
    assert.equal(isReadyAtLeast('preparing', 'capable'), false);
    assert.equal(isReadyAtLeast('empty', 'preparing'), false);
    assert.equal(isReadyAtLeast('capable', 'nonsense'), false);
    assert.equal(isReadyAtLeast('nonsense', 'empty'), false);
  });
  it('READINESS_RANK orders the ladder', () => {
    assert.ok(READINESS_RANK.empty < READINESS_RANK.preparing);
    assert.ok(READINESS_RANK.preparing < READINESS_RANK.capable);
    assert.ok(READINESS_RANK.capable < READINESS_RANK.rich);
  });
});
