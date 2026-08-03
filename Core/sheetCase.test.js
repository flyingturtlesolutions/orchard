// Core/sheetCase.test.js — the pure shaping for the xlsx/csv → case flow (v2.74.1977).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fileListToRows, sheetCaseMeta, sheetGroundedRead, PERSIST_CAP } from './sheetCase.js';

describe('sheetCase — fileListToRows', () => {
  it('a FileParsers list(records) → plain row objects', () => {
    const value = { kind: 'list', items: [
      { kind: 'record', fields: { Name: 'Alice', Status: 'open' } },
      { kind: 'record', fields: { Name: 'Bob', Status: 'closed' } },
    ] };
    assert.deepEqual(fileListToRows(value), [{ Name: 'Alice', Status: 'open' }, { Name: 'Bob', Status: 'closed' }]);
  });
  it('scalars and non-list values degrade safely', () => {
    assert.deepEqual(fileListToRows({ kind: 'list', items: [{ kind: 'scalar', value: 'x' }] }), [{ value: 'x' }]);
    assert.deepEqual(fileListToRows({ kind: 'record', fields: {} }), []);
    assert.deepEqual(fileListToRows(null), []);
  });
});

describe('sheetCase — sheetCaseMeta', () => {
  it('strips the extension, counts rows, reads headers, builds a title', () => {
    const m = sheetCaseMeta({ filename: 'Q3 orders.xlsx', rows: [{ id: '1', total: '10' }, { id: '2', total: '20' }] });
    assert.equal(m.name, 'Q3 orders');
    assert.equal(m.count, 2);
    assert.deepEqual(m.headers, ['id', 'total']);
    assert.equal(m.title, 'Q3 orders · 2 rows');
  });
  it('singular row, empty sheet, and a dotless filename', () => {
    assert.equal(sheetCaseMeta({ filename: 'one.csv', rows: [{ a: '1' }] }).title, 'one · 1 row');
    assert.equal(sheetCaseMeta({ filename: '', rows: [] }).name, 'Sheet');
    assert.equal(sheetCaseMeta({ filename: 'noext', rows: [] }).name, 'noext');
  });
});

describe('sheetCase — sheetGroundedRead', () => {
  it('synthesizes a leg-less grounded read the engine consumes ({rows} — a LIST_KEY)', () => {
    const g = sheetGroundedRead('Q3', [{ a: '1' }]);
    assert.equal(g.leg.domain, 'file');
    assert.equal(g.leg.name, 'Q3');
    assert.deepEqual(g.value, { rows: [{ a: '1' }] });
  });
  it('PERSIST_CAP bounds the durable working set', () => {
    assert.ok(PERSIST_CAP >= 100 && PERSIST_CAP <= 100000);
  });
});
