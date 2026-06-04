// Core/orchRoute.test.js — ORCH-CB slice 2: the deterministic shape router (node --test). PURE.
// Node 16.15.1 has no node:test runner here; run via the temp-dir ESM harness.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { routeShape, SHAPES } from './orchRoute.js';

const shapeOf = (ask) => routeShape(ask).shape;

describe('orchRoute — the deterministic shape router (ORCH-CB)', () => {
  it('a LEADING conditional gates the rest → conditional (even when the consequent quantifies)', () => {
    assert.equal(shapeOf('if there are any jobs, sort by date'), 'conditional');
    assert.equal(shapeOf('when the results load, sort by date'), 'conditional');
    assert.equal(shapeOf('unless it is taken, apply'), 'conditional');
    assert.equal(shapeOf('if there are jobs, click each one'), 'conditional', 'the consequent foreach recurses later');
  });

  it('a quantifier outranks a TRAILING conditional → foreach', () => {
    assert.equal(shapeOf('click each job and read the salary'), 'foreach');
    assert.equal(shapeOf('the salaries of each job'), 'foreach');
    assert.equal(shapeOf('click each job and if it is remote, save it'), 'foreach', 'the body conditional recurses later');
  });

  it('a trailing / guard conditional (no quantifier, not leading) → conditional', () => {
    assert.equal(shapeOf('apply unless it is taken'), 'conditional');
    assert.equal(shapeOf('search for jobs and if there are any jobs, sort by date'), 'conditional', 'guarded sequence');
  });

  it('a plain compound (no control flow) → sequence', () => {
    assert.equal(shapeOf('search for jobs and filter by date'), 'sequence');
    assert.equal(shapeOf('search jobs then sort by newest'), 'sequence');
  });

  it('a single read → read; a single action → action', () => {
    assert.equal(shapeOf('the salary'), 'read');
    assert.equal(shapeOf('how many results are there?'), 'read');
    assert.equal(shapeOf('sort by date'), 'action');
    assert.equal(shapeOf('search for nurse jobs'), 'action');
  });

  it('surfaces the precomputed signals so a comprehender never re-derives them', () => {
    const r = routeShape('if there are more than 10 jobs, sort by date');
    assert.equal(r.shape, 'conditional');
    assert.equal(r.signals.leadingConditional, true);
    assert.equal(r.signals.isConditional, true);
    assert.equal(Array.isArray(r.signals.clauses), true);
    assert.ok(r.signals.clauses.length >= 2, 'the clause split rides along');
    // a read ask carries its classification (outputType) for the read comprehender
    const rd = routeShape('the salary');
    assert.equal(rd.signals.isRead, true);
    assert.equal(rd.signals.readClass.outputType, 'scalar');
  });

  it('every routed shape is one of the declared SHAPES', () => {
    for (const ask of ['if x, do y', 'each of them', 'a and b', 'the price', 'click it']) {
      assert.ok(SHAPES.includes(shapeOf(ask)), `"${ask}" → a declared shape`);
    }
  });
});
