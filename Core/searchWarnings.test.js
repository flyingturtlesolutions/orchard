// Core/searchWarnings.test.js — v2.74.1927: the search-field contract, pinned on the LIVE response that proved it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { searchWarnings, droppedSearchFields, droppedSearchDetail } from './searchWarnings.js';

// Verbatim from admin.shopify.com HAR #3 (2026-08-01), OrderListData for
// `staff_member:"Kat Owens" has_unbatched_fulfillment_order:true` — the response that carried FIFTY rows.
const LIVE_DROPPED = {
  data: { ordersList: { edges: [{ node: { name: 'DEAKO#71696' } }], pageInfo: { hasNextPage: true } } },
  extensions: {
    cost: { requestedQueryCost: 40, actualQueryCost: 20 },
    search: [{
      path: ['ordersList'],
      query: 'staff_member:"Kat Owens" has_unbatched_fulfillment_order:true',
      parsed: { and: [{ field: 'staff_member', match_phrase: 'Kat Owens' }, { field: 'has_unbatched_fulfillment_order', match_all: 'true' }] },
      warnings: [{ field: 'staff_member', message: 'Invalid search field for this query.', code: 'invalid_field' }],
    }],
  },
};

// A healthy search: the same envelope, no warnings (every field recognized).
const LIVE_CLEAN = {
  data: { ordersList: { edges: [], pageInfo: { hasNextPage: false } } },
  extensions: { cost: { requestedQueryCost: 40 }, search: [{ path: ['ordersList'], query: 'status:open', parsed: { field: 'status', match_all: 'open' }, warnings: [] }] },
};

describe('searchWarnings — the live dropped-field response', () => {
  it('reads the warning the server actually sent', () => {
    const w = searchWarnings(LIVE_DROPPED);
    assert.equal(w.length, 1);
    assert.deepEqual(w[0], { field: 'staff_member', code: 'invalid_field', message: 'Invalid search field for this query.', path: 'ordersList' });
  });
  it('droppedSearchFields names the field whose predicate never ran', () => {
    assert.deepEqual(droppedSearchFields(LIVE_DROPPED), ['staff_member']);
  });
  it('THE POINT: rows are present and plausible — only the warning distinguishes it from a real answer', () => {
    assert.ok(LIVE_DROPPED.data.ordersList.edges.length, 'the response carries rows');
    assert.ok(droppedSearchFields(LIVE_DROPPED).length, 'and they must not be served as the answer');
  });
  it('a clean search warns nothing (an empty result is a real result)', () => {
    assert.deepEqual(searchWarnings(LIVE_CLEAN), []);
    assert.deepEqual(droppedSearchFields(LIVE_CLEAN), []);
  });
});

describe('searchWarnings — scope and safety', () => {
  it('non-fatal warning codes pass through as information, never as failure', () => {
    const v = { extensions: { search: [{ path: ['x'], warnings: [{ field: 'tag', code: 'deprecated_field', message: 'use tags' }] }] } };
    assert.equal(searchWarnings(v).length, 1, 'still reported');
    assert.deepEqual(droppedSearchFields(v), [], 'but the read is not failed for it');
  });
  it('every fatal code is caught, and duplicates collapse in first-seen order', () => {
    const v = { extensions: { search: [
      { path: ['a'], warnings: [{ field: 'staff_member', code: 'invalid_field' }, { field: 'zzz', code: 'unsupported_field' }] },
      { path: ['b'], warnings: [{ field: 'staff_member', code: 'invalid_value' }] },
    ] } };
    assert.deepEqual(droppedSearchFields(v), ['staff_member', 'zzz']);
  });
  it('responses with no search envelope are untouched (every non-search leg)', () => {
    for (const v of [null, undefined, 0, 'x', {}, { extensions: {} }, { extensions: { cost: {} } }, { data: { orders: { edges: [] } } }]) {
      assert.deepEqual(searchWarnings(v), []);
      assert.deepEqual(droppedSearchFields(v), []);
    }
  });
  it('malformed warning entries never throw', () => {
    const v = { extensions: { search: [{ warnings: [null, {}, { code: 'invalid_field' }] }, null, { warnings: 'nope' }] } };
    assert.deepEqual(droppedSearchFields(v), [], 'a warning with no field name cannot be reported as one');
  });
});

describe('droppedSearchDetail — the sentence says the rows are UNFILTERED, not empty', () => {
  it('names the field and the real consequence', () => {
    const d = droppedSearchDetail(['staff_member']);
    assert.match(d, /"staff_member"/);
    assert.match(d, /DROPPED/);
    assert.match(d, /unfiltered/i, 'the danger is extra rows, not missing ones');
  });
  it('lists several fields readably; empty in → empty out', () => {
    assert.match(droppedSearchDetail(['a', 'b']), /"a" and "b"/);
    assert.match(droppedSearchDetail(['a', 'b', 'c']), /"a", "b" and "c"/);
    assert.equal(droppedSearchDetail([]), '');
    assert.equal(droppedSearchDetail(null), '');
  });
});
