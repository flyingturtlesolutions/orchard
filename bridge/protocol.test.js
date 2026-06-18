// bridge/protocol.test.js — DBR-P4-2 unit tests for the v:2 run-multiplex primitives (DESIGN §10).
// ESM (the harness loader force-loads .js as ESM); default-imports the CommonJS module. PURE — no I/O.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import protocol from './protocol.cjs';
const { PROTO_V, isRunScoped, tagFrame, frameRunId, poolSnapshot } = protocol;

describe('protocol — the v:2 cutover (DBR-P4-2)', () => {
  it('PROTO_V is 2 (the cutover)', () => {
    assert.equal(PROTO_V, 2);
  });

  it('isRunScoped — run frames carry a runId; connection frames never do', () => {
    for (const t of ['run', 'event', 'done', 'error', 'started', 'pause', 'approval', 'approval-decision']) assert.equal(isRunScoped(t), true, `scoped: ${t}`);
    for (const t of ['git', 'test', 'preflight', 'status', 'history', 'pool', 'git-result', 'bogus']) assert.equal(isRunScoped(t), false, `unscoped: ${t}`);
  });

  it('tagFrame stamps a run-scoped frame, leaves connection frames + missing ids alone (idempotent)', () => {
    assert.deepEqual(tagFrame({ v: 2, type: 'event', ev: {} }, 'r1'), { v: 2, type: 'event', ev: {}, runId: 'r1' });
    assert.deepEqual(tagFrame({ v: 2, type: 'git-result', ok: true }, 'r1'), { v: 2, type: 'git-result', ok: true });   // not run-scoped → untouched
    assert.deepEqual(tagFrame({ v: 2, type: 'event' }, null), { v: 2, type: 'event' });                                 // no runId → untouched
    assert.equal(tagFrame({ v: 2, type: 'done' }, 'r1').runId, 'r1');
    assert.equal(tagFrame(null, 'r1'), null);
  });

  it('frameRunId reads the tag back, null otherwise', () => {
    assert.equal(frameRunId({ type: 'event', runId: 'r2' }), 'r2');
    assert.equal(frameRunId({ type: 'event' }), null);
    assert.equal(frameRunId({ type: 'git-result' }), null);
    assert.equal(frameRunId(null), null);
  });

  it('poolSnapshot builds the pool payload from a Map or array, cap defaulted', () => {
    const m = new Map([['r1', { runId: 'r1', conversationId: 'c1', pid: 123 }], ['r2', { runId: 'r2', pid: 456 }]]);
    const snap = poolSnapshot(m, 4);
    assert.equal(snap.cap, 4);
    assert.equal(snap.running.length, 2);
    assert.deepEqual(snap.running[0], { runId: 'r1', conv: 'c1', pid: 123 });
    assert.deepEqual(snap.running[1], { runId: 'r2', pid: 456 });
    // cap=1 single-run shape (today) + the empty case
    assert.deepEqual(poolSnapshot([{ runId: 'r1', pid: 9 }], 1), { running: [{ runId: 'r1', pid: 9 }], cap: 1 });
    assert.deepEqual(poolSnapshot([], 4), { running: [], cap: 4 });
  });
});
