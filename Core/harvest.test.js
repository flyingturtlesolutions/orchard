// Core/harvest.test.js — CX-9 slice 2 pure core (v2.74.1159): network-harvest correlation + extraction.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { jsonPath, callMatchesLeg, matchHarvest } from './harvest.js';

describe('harvest — jsonPath', () => {
  it('reads a top-level key, nested dots, and array indices', () => {
    assert.deepEqual(jsonPath({ results: [1, 2] }, 'results'), [1, 2]);
    assert.deepEqual(jsonPath({ data: { tickets: [{ id: 9 }] } }, 'data.tickets'), [{ id: 9 }]);
    assert.equal(jsonPath({ hits: { hits: [{ x: 7 }] } }, 'hits.hits.0.x'), 7);
    assert.equal(jsonPath({ hits: [{ x: 7 }] }, 'hits[0].x'), 7);                 // bracket → dot
  });
  it('empty/missing path returns the body itself; missing segment → undefined', () => {
    assert.deepEqual(jsonPath([1, 2, 3], ''), [1, 2, 3]);
    assert.deepEqual(jsonPath([1, 2, 3], null), [1, 2, 3]);
    assert.equal(jsonPath({ a: 1 }, 'a.b.c'), undefined);
    assert.equal(jsonPath(null, 'a'), undefined);
  });
});

describe('harvest — callMatchesLeg', () => {
  const leg = { kind: 'network-harvest', match: '/api/search', method: 'GET', result: 'results' };
  it('matches on url-contains + method + 2xx + json', () => {
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/search?q=a', method: 'GET', status: 200, json: {} }, leg), true);
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/search', method: 'GET', status: 200, contentType: 'application/json' }, leg), true);
  });
  it('rejects a different endpoint, wrong method, non-2xx, or non-JSON', () => {
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/autocomplete', status: 200, json: {} }, leg), false);
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/search', method: 'POST', status: 200, json: {} }, leg), false);
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/search', method: 'GET', status: 404, json: {} }, leg), false);
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/search', method: 'GET', status: 200, contentType: 'text/html' }, leg), false);
  });
  it('tolerates an unknown status/method (the tee may omit them)', () => {
    const open = { kind: 'network-harvest', match: '/api/search', result: 'results' };   // no method pin
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/search', json: {} }, open), true);
    assert.equal(callMatchesLeg(null, leg), false);
    assert.equal(callMatchesLeg({ url: 'https://x.com/api/search', json: {} }, null), false);
  });
});

describe('harvest — matchHarvest (correlation §15)', () => {
  const leg = { kind: 'network-harvest', match: '/api/search', method: 'GET', result: 'results' };

  it('picks the only matching call out of the XHR noise and extracts rows', () => {
    const calls = [
      { url: 'https://x.com/api/analytics', status: 204, json: {} },
      { url: 'https://x.com/api/autocomplete?q=wid', status: 200, json: { suggestions: ['widget'] } },
      { url: 'https://x.com/api/search?q=widget', method: 'GET', status: 200, json: { results: [{ id: 1 }, { id: 2 }] }, at: 5 },
    ];
    const r = matchHarvest(calls, leg, { query: 'widget' });
    assert.equal(r.call.url, 'https://x.com/api/search?q=widget');
    assert.deepEqual(r.rows, [{ id: 1 }, { id: 2 }]);
  });

  it('prefers the call whose request carried the query (over a stale same-endpoint call)', () => {
    const calls = [
      { url: 'https://x.com/api/search?q=old', method: 'GET', status: 200, json: { results: [{ id: 1 }, { id: 2 }, { id: 3 }] }, at: 1 },
      { url: 'https://x.com/api/search?q=widget', method: 'GET', status: 200, json: { results: [{ id: 9 }] }, at: 2 },
    ];
    const r = matchHarvest(calls, leg, { query: 'widget' });
    assert.deepEqual(r.rows, [{ id: 9 }]);                                        // query-carrying wins over row-count
    assert.match(r.reason, /query\+/);
  });

  it('with no query hint, tie-breaks by row-count then recency', () => {
    const calls = [
      { url: 'https://x.com/api/search?p=1', method: 'GET', status: 200, json: { results: [{ id: 1 }] }, at: 9 },
      { url: 'https://x.com/api/search?p=2', method: 'GET', status: 200, json: { results: [{ id: 1 }, { id: 2 }] }, at: 1 },
    ];
    const r = matchHarvest(calls, leg, {});
    assert.equal(r.rows.length, 2);                                              // more rows wins
  });

  it('extracts a bare-array body when result path is empty', () => {
    const bare = { kind: 'network-harvest', match: '/api/search', result: null };
    const calls = [{ url: 'https://x.com/api/search', status: 200, json: [{ id: 1 }] }];
    assert.deepEqual(matchHarvest(calls, bare, {}).rows, [{ id: 1 }]);
  });

  it('no matching call → {call:null, rows:null, reason:no-match}', () => {
    const r = matchHarvest([{ url: 'https://x.com/api/other', status: 200, json: {} }], leg, {});
    assert.deepEqual(r, { call: null, rows: null, reason: 'no-match' });
    assert.equal(matchHarvest(null, leg, {}).call, null);
  });
});
