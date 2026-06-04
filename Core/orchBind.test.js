// Core/orchBind.test.js — ORCH-CB slice 4: the per-slot effect+scope binder (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { bindShape, lexicalScore } from './orchBind.js';
import { comprehend } from './orchComprehend.js';

describe('orchBind — per-slot effect+scope binding (ORCH-CB)', () => {
  it('lexicalScore mirrors the matcher authority: intent-exact 1.0, alias-exact 0.97, else token recall', () => {
    assert.equal(lexicalScore('sort by date', { intent: 'sort by date' }), 1, 'intent-exact');
    assert.equal(lexicalScore('newest first', { intent: 'sort by date', aliases: ['newest first', 'sort newest'] }), 0.97, 'alias-exact');
    const recall = lexicalScore('sort the jobs by date', { intent: 'sort by date' });
    assert.ok(recall > 0 && recall < 0.97, 'partial token overlap is a floor, below the exact bands');
    assert.equal(lexicalScore('totally unrelated', { intent: 'sort by date' }), 0);
  });

  it('binds every slot when the right-effect pools cover the clauses → 0 gaps', () => {
    const shape = comprehend('search for jobs and filter by date');   // 2 act slots
    const pools = { read: [], act: [
      { id: 'cap-search', intent: 'search for jobs' },
      { id: 'cap-filter', intent: 'filter by date' },
    ] };
    const r = bindShape(shape, pools);
    assert.equal(r.bound, true);
    assert.deepEqual(r.gaps, []);
    assert.deepEqual(r.steps.map((s) => s.capabilityId), ['cap-search', 'cap-filter']);
  });

  it('EFFECT picks the pool — a read slot binds against READS, never an act with a better lexical match', () => {
    const shape = comprehend('the salary');   // one read slot
    const pools = {
      read: [{ id: 'obs-salary', intent: 'the salary' }],
      act: [{ id: 'act-salary', intent: 'the salary set' }],   // lexically strong, but WRONG effect
    };
    const r = bindShape(shape, pools);
    assert.equal(r.steps[0].capabilityId, 'obs-salary', 'bound to the READ pool, not the act');
    assert.equal(r.bound, true);
  });

  it('a conditional binds the condition against READS and the consequent against ACTS', () => {
    const shape = comprehend('if there are any jobs, sort by date');   // observe(read) + analyze + gate{fragment(act)}
    const pools = {
      read: [{ id: 'obs-jobs', intent: 'the list of jobs' }],
      act: [{ id: 'cap-sort', intent: 'sort by date' }],
    };
    const r = bindShape(shape, pools, { score: (clause, c) => Math.max(lexicalScore(clause, c), /jobs/.test(clause) && /jobs/.test(c.intent) ? 0.9 : 0) });
    const cond = r.steps.find((s) => s.kind === 'observe');
    const gate = r.steps.find((s) => s.kind === 'gate');
    assert.equal(cond.capabilityId, 'obs-jobs');
    assert.equal(gate.body[0].capabilityId, 'cap-sort');
    assert.equal(r.bound, true);
  });

  it('an EMPTY ground → every leaf is a gap (the shape still stands)', () => {
    const shape = comprehend('search for jobs and if there are any jobs, sort by date');
    const r = bindShape(shape, { read: [], act: [] });
    assert.equal(r.bound, false);
    assert.ok(r.gaps.length >= 2, 'search + sort + condition are all gaps');
    // a gap records its effect, so the learn flow knows whether to record a read or an action
    assert.ok(r.gaps.every((g) => g.effect === 'read' || g.effect === 'act'));
  });

  it('a partial ground → only the missing slots are gaps', () => {
    const shape = comprehend('search for jobs and filter by date');
    const r = bindShape(shape, { read: [], act: [{ id: 'cap-search', intent: 'search for jobs' }] });
    assert.equal(r.bound, false);
    assert.equal(r.gaps.length, 1);
    assert.equal(r.gaps[0].clause, 'filter by date');
    assert.equal(r.steps[0].capabilityId, 'cap-search');
    assert.equal(r.steps[1].capabilityId, null);
  });
});
