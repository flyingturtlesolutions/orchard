// Core/outcomes.test.js — CR-H3 (v2.74.955): hashId keys intentContext fingerprints (a silent change
// would orphan every persisted fingerprint), so its output is PINNED, not just shape-checked. PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { hashId, mintEventId } from './outcomes.js';

describe('outcomes — id minting (CR-H3)', () => {
  it('hashId: deterministic djb2/base36 — exact values pinned (fingerprint keys depend on them)', () => {
    assert.equal(hashId('a'), hashId('a'));
    assert.notEqual(hashId('a'), hashId('b'));
    // pin two concrete values: a change here silently orphans persisted intentContext fingerprints
    assert.equal(hashId(''), (5381 >>> 0).toString(36));
    const h = ((((5381 << 5) + 5381 + 'a'.charCodeAt(0)) | 0) >>> 0).toString(36);
    assert.equal(hashId('a'), h);
  });

  it('hashId: coerces non-strings; output is base36 lowercase', () => {
    assert.equal(hashId(123), hashId('123'));
    assert.match(hashId('anything at all'), /^[0-9a-z]+$/);
  });

  it('mintEventId: evt_-prefixed, unique across calls (entropy-seeded)', () => {
    const a = mintEventId('seed');
    const b = mintEventId('seed');
    assert.match(a, /^evt_[0-9a-z]+$/);
    assert.notEqual(a, b);
  });
});
