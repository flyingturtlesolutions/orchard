// Core/walkLedger.test.js — CR-D7 walk-ledger tests (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { walkRecap, walkBoundary, walkEndLines } from './walkLedger.js';

describe('walkLedger — recap / boundary / end lines (CR-D7)', () => {
  it('walkRecap: counts every step — sparse results fill as "unreached"', () => {
    const st = { total: 5, results: [{ clause: 'a', outcome: 'ran' }, { clause: 'b', outcome: 'read' }, undefined, { clause: 'd', outcome: 'skipped' }] };
    const rec = walkRecap(st);
    assert.equal(rec.chat, 'ran 1 · read 1 · unreached 2 · skipped 1');
    assert.equal(rec.ring, '1:ran 2:read 3:unreached 4:skipped 5:unreached');
  });

  it('walkRecap: preSkipped (not-walkable) steps get their own suffix, absent when zero', () => {
    const st = { total: 2, results: [{ outcome: 'ran' }, { outcome: 'ran' }], preSkipped: 3 };
    assert.equal(walkRecap(st).chat, 'ran 2 · not walkable 3');
    assert.equal(walkRecap({ total: 1, results: [{ outcome: 'ran' }] }).chat, 'ran 1');
  });

  it('walkBoundary: done is checked BEFORE abort — the stop-at-end rule (v2.74.919)', () => {
    // a "stop" typed while the LAST step runs is a finish, not "Stopped at step N+1 of N"
    assert.equal(walkBoundary({ index: 3, total: 3, abortRequested: true }), 'done');
    assert.equal(walkBoundary({ index: 3, total: 3, abortRequested: false }), 'done');
  });

  it('walkBoundary: abort mid-walk stops; otherwise keep walking', () => {
    assert.equal(walkBoundary({ index: 1, total: 3, abortRequested: true }), 'stopped by user');
    assert.equal(walkBoundary({ index: 1, total: 3, abortRequested: false }), null);
  });

  it('walkEndLines: done — no "at step" clause, singular/plural step word', () => {
    const st = { total: 1, results: [{ outcome: 'ran' }] };
    const l = walkEndLines(st, 1, 'done');
    assert.equal(l.done, true);
    assert.equal(l.chat, '✓ Walk finished — 1 step: ran 1.');
    assert.equal(l.log, 'done — 1 step(s) [1:ran]');
  });

  it('walkEndLines: stopped — names the step (clamped into 1..total) and reassures completed work', () => {
    const st = { total: 3, results: [{ outcome: 'ran' }, { outcome: 'stopped' }] };
    const l = walkEndLines(st, 1, 'stopped by user');
    assert.equal(l.done, false);
    assert.equal(l.chat, '⏹ Stopped the walk at step 2 of 3 — ran 1 · stopped 1 · unreached 1. Steps already completed stay done.');
    assert.match(l.log, /^stopped by user at step 2 of 3 — 3 step\(s\) \[1:ran 2:stopped 3:unreached\]$/);
    // clamp: an index past the end still renders "at step N of N", never N+1
    assert.match(walkEndLines(st, 9, 'stopped').chat, / at step 3 of 3 /);
  });

  it('walkEndLines: errored gets its own wording + preSkipped rides the log line', () => {
    const st = { total: 2, results: [{ outcome: 'ran' }, { outcome: 'error' }], preSkipped: 1 };
    const l = walkEndLines(st, 1, 'errored');
    assert.match(l.chat, /^⏹ Walk stopped on an error at step 2 of 2 — /);
    assert.match(l.log, / \+1 not-walkable$/);
  });
});
