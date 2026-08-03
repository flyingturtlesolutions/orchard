// Core/sheetCase.test.js — the pure shaping for the xlsx/csv → case flow (v2.74.1977).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fileListToRows, sheetCaseMeta, sheetGroundedRead, sheetBrief, isSheetDataAsk, sheetMetaAnswer, PERSIST_CAP } from './sheetCase.js';

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

describe('sheetCase — sheetBrief (prose, not a row dump)', () => {
  it('names the size + columns and previews the first row', () => {
    const b = sheetBrief({ name: 'Q3 orders', count: 200, headers: ['id', 'customer', 'total', 'status', 'date'],
      rows: [{ id: '1', customer: 'Alice', total: '10', status: 'open', date: '2026-01-01' }] });
    assert.match(b, /\*\*Q3 orders\*\* — 200 rows across 5 columns\./);
    assert.match(b, /Columns: `id`, `customer`, `total`, `status`, `date`\./);
    assert.match(b, /First row — id: 1 · customer: Alice · total: 10 · status: open …\./);
    assert.match(b, /count, filter, or run something for each row/);
    assert.doesNotMatch(b, /•/);   // NOT a bullet dump
  });
  it('untrusted name/header/value markdown is neutralized', () => {
    const b = sheetBrief({ name: '**PWN**', count: 1, headers: ['*col*'], rows: [{ '*col*': '`code`' }] });
    assert.doesNotMatch(b, /\*\*PWN\*\*/);   // the bold wrapper is ours; the data's ** is a lookalike
    assert.doesNotMatch(b, /<strong>|`code`/);
  });
  it('a header-less / empty sheet still briefs safely', () => {
    assert.match(sheetBrief({ name: 'x', count: 0, headers: [], rows: [] }), /0 rows across 0 columns/);
  });
});

describe('sheetCase — the P2.5 gate: isSheetDataAsk', () => {
  it('fires for data questions about the sheet', () => {
    for (const q of ['list all column names', 'how many are open', 'sum the totals', 'which rows are overdue',
                     'get status for each', 'show the top 5', 'what columns does this have', 'filter to status open']) {
      assert.equal(isSheetDataAsk(q), true, q);
    }
  });
  it('does NOT fire for navigation / action asks (those still route)', () => {
    for (const q of ['open zendesk', 'go to vendorsuite', 'show me the settings', 'close this', 'delete the case']) {
      assert.equal(isSheetDataAsk(q), false, q);
    }
  });
});

describe('sheetCase — the P2.5 gate: sheetMetaAnswer (deterministic, no LLM, no row egress)', () => {
  const ctx = { name: 'Q3 orders', headers: ['id', 'customer', 'total'], count: 36 };
  it('columns question → the column list from STRUCTURE', () => {
    assert.equal(sheetMetaAnswer('list all column names', ctx), '**Q3 orders** has 3 columns: `id`, `customer`, `total`.');
    assert.match(sheetMetaAnswer('what columns does it have', ctx), /3 columns: `id`, `customer`, `total`/);
  });
  it('row-count question → the size', () => {
    assert.match(sheetMetaAnswer('how many rows', ctx), /36 rows across 3 columns/);
    assert.match(sheetMetaAnswer('how many', ctx), /36 rows across 3 columns/);
  });
  it('an ANALYTICAL ask is NOT metadata → null (falls to the interrogator)', () => {
    assert.equal(sheetMetaAnswer('how many are open', ctx), null);
    assert.equal(sheetMetaAnswer('sum the totals', ctx), null);
  });
});
