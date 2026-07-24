// Core/headlessClause.test.js — CD-1a phase 2, extraction 1: the headless field-read step. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runFieldReadStep, rowsOf } from './headlessClause.js';

const CLAUSE = (field, term = '') => ({ text: 'read the instructions of each', pinned: { kind: 'fieldRead', field, ...(term ? { term } : {}) } });
const ROWS = [
  { Id: 1, Instructions: '1. Call the homeowner.\n2. DEAKO: replace the switch.\n3. Close the task.' },
  { Id: 2, Instructions: 'Just verify the install.' },
  { Id: 3 },   // no field
];

describe('headlessClause — runFieldReadStep', () => {
  it('reads the banked field off each prior row, resolving the phrase to the record key', () => {
    const r = runFieldReadStep(CLAUSE('the instructions'), { state: { lastValue: ROWS } });
    assert.equal(r.ok, true);
    assert.equal(r.value.field, 'Instructions', 'the phrase resolved to the actual key');
    assert.equal(r.value.items.length, 3);
    assert.equal(r.value.items[2].mode, 'missing');
    assert.match(r.value.tally, /3 rows/);
    assert.match(r.value.tally, /1 with no Instructions/);
  });
  it('a term narrows to the matching unit; enriched rows thread forward as lastValue (the PP-1 composition rule)', () => {
    const r = runFieldReadStep(CLAUSE('instructions', 'DEAKO'), { state: { lastValue: ROWS } });
    assert.equal(r.ok, true);
    assert.match(r.value.items[0].text, /DEAKO: replace the switch/);
    assert.equal(rowsOf(r.state.lastValue).length, 3);
    assert.match(r.state.lastValue[0].Instructions__read, /DEAKO/, 'the extract rides the enriched row');
    assert.equal(r.state.lastFieldRead.field, 'Instructions');
  });
  it('fails HONESTLY — never guesses: no banked field / no prior rows / field gone / ambiguous', () => {
    assert.equal(runFieldReadStep({ text: 'x', pinned: { kind: 'fieldRead' } }, { state: { lastValue: ROWS } }).error, 'field-not-banked');
    assert.equal(runFieldReadStep(CLAUSE('instructions'), { state: {} }).error, 'no-prior-rows');
    assert.equal(runFieldReadStep(CLAUSE('instructions'), { state: { lastValue: [] } }).error, 'no-prior-rows');
    assert.match(runFieldReadStep(CLAUSE('warranty notes'), { state: { lastValue: ROWS } }).error, /^field-gone/);
    const twoVendors = [{ VendorName: 'a', VendorExplanation: 'b' }];
    assert.match(runFieldReadStep(CLAUSE('vendor'), { state: { lastValue: twoVendors } }).error, /^field-ambiguous/);
  });
  it('accepts {rows:[…]} shaped prior values', () => {
    const r = runFieldReadStep(CLAUSE('instructions'), { state: { lastValue: { rows: ROWS } } });
    assert.equal(r.ok, true);
    assert.equal(r.value.items.length, 3);
  });
});
