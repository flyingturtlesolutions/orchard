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

describe('isSheetDataAsk — SH-1 (v2.74.1985): shape is necessary, not sufficient', () => {
  const sheet = { headers: ['Vendor', 'Notification Date', 'Status', 'Amount', 'Invoice'], name: 'DRH_Vendor_Notification_2026-07-31' };

  it('REFUSES the live hijack — "list open warranty tasks in Raleigh" matched on the word "list" alone', () => {
    // The user got: "the sheet contains 36 open records, but they lack the identifiers and scope needed" — for a
    // VendorSuite question that vs_warranty_tasks had answered minutes earlier.
    assert.equal(isSheetDataAsk('list open warranty tasks in Raleigh', sheet), false);
  });

  it('still claims genuine sheet questions', () => {
    for (const q of ['list all column names', 'how many rows?', 'which records are open',
      'what is the total amount', 'the distinct vendors', 'sum the invoices']) {
      assert.equal(isSheetDataAsk(q, sheet), true, q);
    }
  });

  it('PRE-EXISTING, documented not changed: "show me the …" is read as navigation and never reaches the gate', () => {
    // `/^(open|go to|…|show me the)\b/` refuses first. Surprising for "show me the distinct vendors" — a data
    // question by any reading — but it predates SH-1 and is the sheet lane's call, not this fix's.
    assert.equal(isSheetDataAsk('show me the distinct vendors', sheet), false);
    assert.equal(isSheetDataAsk('show me the distinct vendors'), false, 'same without sheet context');
  });

  it('claims an ask naming one of THIS sheet\'s own headers', () => {
    assert.equal(isSheetDataAsk('list the vendors by status', sheet), true);
    assert.equal(isSheetDataAsk('which notification dates are latest', sheet), true);
  });

  it('refuses asks naming another system entirely', () => {
    for (const q of ['list the open zendesk tickets', 'show shopify orders for this customer',
      'which ups packages are in transit']) {
      assert.equal(isSheetDataAsk(q, sheet), false, q);
    }
  });

  it('"this sheet" is an explicit claim and needs no noun coverage', () => {
    assert.equal(isSheetDataAsk('what is in this sheet', sheet), true);
    assert.equal(isSheetDataAsk('summarize this file', sheet), true);
  });

  it('a bare shape ask with no subject still claims — "how many?" has nothing to disagree with', () => {
    assert.equal(isSheetDataAsk('how many?', sheet), true);
  });

  it('is UNCHANGED when no sheet context is passed — no existing caller shifts', () => {
    assert.equal(isSheetDataAsk('list open warranty tasks in Raleigh'), true, 'shape-only, exactly as before');
    assert.equal(isSheetDataAsk('go to the orders page'), false, 'the navigation gate still fires first');
  });

  it('navigation and action asks are still refused before any of this', () => {
    for (const q of ['open the sheet', 'go to shopify', 'delete this row', 'close the case']) {
      assert.equal(isSheetDataAsk(q, sheet), false, q);
    }
  });

  it('tolerates a header-less sheet and junk without throwing', () => {
    assert.doesNotThrow(() => isSheetDataAsk('how many rows', { headers: [], name: '' }));
    for (const junk of [null, undefined, 42, {}]) assert.doesNotThrow(() => isSheetDataAsk(junk, sheet));
  });
});
