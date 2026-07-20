// Core/peritemMap.test.js — PM-0 (v2.74.1625): the per-item cross-system map's pure core.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMapVerdict, pickFieldPath, extractValue, buildJoinRows, mapTally, tallyResults,
} from './peritemMap.js';

describe('peritemMap — normalizeMapVerdict (the clause contract, §1)', () => {
  it('accepts a full verdict; defaults join=table and collection=prior', () => {
    const v = normalizeMapVerdict({ itemField: 'homeowner email', target: { system: 'shopify', readAsk: 'search Shopify for {value}' } });
    assert.deepEqual(v, { kind: 'map', collection: 'prior', itemField: 'homeowner email', target: { system: 'shopify', readAsk: 'search Shopify for {value}' }, join: 'table' });
  });
  it('a self-contained collection (readAsk) rides; join=attach honored; cap floored', () => {
    const v = normalizeMapVerdict({ collection: { readAsk: 'get open warranty tasks' }, itemField: 'email', target: { system: 'shopify', readAsk: 'find {value}' }, join: 'attach', cap: 5.9 });
    assert.deepEqual(v.collection, { readAsk: 'get open warranty tasks' });
    assert.equal(v.join, 'attach');
    assert.equal(v.cap, 5);
  });
  it('a bare-string collection ≠ "prior" becomes a self-contained read', () => {
    assert.deepEqual(normalizeMapVerdict({ collection: 'open warranty tasks', itemField: 'x', target: { system: 's', readAsk: 'r {value}' } }).collection, { readAsk: 'open warranty tasks' });
    assert.equal(normalizeMapVerdict({ collection: 'prior', itemField: 'x', target: { system: 's', readAsk: 'r' } }).collection, 'prior');
  });
  it('a missing load-bearing field → null (degrades to decompose, never a half-map)', () => {
    assert.equal(normalizeMapVerdict({ target: { system: 's', readAsk: 'r' } }), null, 'no itemField');
    assert.equal(normalizeMapVerdict({ itemField: 'x', target: { system: 's' } }), null, 'no target.readAsk');
    assert.equal(normalizeMapVerdict({ itemField: 'x', target: { readAsk: 'r' } }), null, 'no target.system');
    assert.equal(normalizeMapVerdict(null), null);
  });
});

describe('peritemMap — pickFieldPath (§3: name-match first, value-shape fallback)', () => {
  const rows = [
    { TaskNumber: '01', HomeownerEmail: 'a@b.com', AddressLine1: '607 Pine Dune Lane', CityStateZip: 'ABERDEEN, NC 28315' },
    { TaskNumber: '02', HomeownerEmail: 'c@d.com', AddressLine1: '600 Pine Dune Lane', CityStateZip: 'SANFORD, NC 27330' },
  ];
  it('matches the key that carries every phrase token (possessives stripped)', () => {
    assert.deepEqual(pickFieldPath(rows, "its homeowner's email"), { path: 'HomeownerEmail', matchedBy: 'name' });
    assert.deepEqual(pickFieldPath(rows, 'homeowner email'), { path: 'HomeownerEmail', matchedBy: 'name' });
  });
  it('a nested contact shape (Contacts[].Email) resolves one hop deep', () => {
    const nested = [{ TaskNumber: '01', Contacts: [{ Name: 'Erick', Email: 'e@x.com' }] }];
    assert.deepEqual(pickFieldPath(nested, 'contact email'), { path: 'Contacts.Email', matchedBy: 'name' });
  });
  it('the TYPE token falls back to VALUE shape when no key names it', () => {
    const noname = [{ TaskNumber: '01', PrimaryContact: 'erick@deako.com' }, { TaskNumber: '02', PrimaryContact: 'nikita@x.com' }];
    assert.deepEqual(pickFieldPath(noname, 'email'), { path: 'PrimaryContact', matchedBy: 'shape' });
  });
  it('no confident match → null (→ the caller asks / one LLM assist)', () => {
    assert.equal(pickFieldPath(rows, 'the vendor explanation'), null);
    assert.equal(pickFieldPath([], 'email'), null);
    assert.equal(pickFieldPath(rows, ''), null);
  });
});

describe('peritemMap — extractValue (§3: per-row pull, arrays → first scalar)', () => {
  it('pulls a top-level and a nested value; arrays descend to [0]', () => {
    assert.equal(extractValue({ HomeownerEmail: 'a@b.com' }, 'HomeownerEmail'), 'a@b.com');
    assert.equal(extractValue({ Contacts: [{ Email: 'e@x.com' }] }, 'Contacts.Email'), 'e@x.com');
    assert.equal(extractValue({ Tags: ['vip', 'x'] }, 'Tags'), 'vip');
  });
  it('a missing / empty / object-only value → null (the no-field bucket, never a guess)', () => {
    assert.equal(extractValue({ HomeownerEmail: '' }, 'HomeownerEmail'), null);
    assert.equal(extractValue({}, 'HomeownerEmail'), null);
    assert.equal(extractValue({ a: { b: {} } }, 'a.b'), null);
    assert.equal(extractValue({ Contacts: [] }, 'Contacts.Email'), null);
  });
});

describe('peritemMap — buildJoinRows + tally (§5/§7)', () => {
  const src = [{ TaskNumber: '01' }, { TaskNumber: '02' }, { TaskNumber: '03' }];
  const ident = (r) => ({ id: r.TaskNumber, label: `task ${r.TaskNumber}` });
  const results = [
    { value: 'a@b.com', ok: true, match: { name: 'Alice' } },   // matched
    { value: 'c@d.com', ok: true, match: null },                 // ran, no match
    { value: null },                                             // no field
  ];
  it('table join pairs each source with its match + identity', () => {
    const rows = buildJoinRows(src, results, { join: 'table', identify: ident, system: 'shopify' });
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[0].source, { id: '01', label: 'task 01', row: src[0] });
    assert.equal(rows[0].matched, true);
    assert.deepEqual(rows[0].match, { name: 'Alice' });
    assert.equal(rows[1].matched, false);   // ran, null match
    assert.equal(rows[2].value, null);      // no field
  });
  it('attach join folds the match into each source row under _match', () => {
    const rows = buildJoinRows(src, results, { join: 'attach' });
    assert.deepEqual(rows[0], { TaskNumber: '01', _match: { name: 'Alice' } });
    assert.equal(rows[1]._match, null);
    assert.equal(rows[2]._match, null);
  });
  it('tallyResults partitions matched / no-match / no-field / failed', () => {
    const t = tallyResults([...results, { value: 'e@f.com', ok: false, error: 'http-403' }]);
    assert.deepEqual(t, { total: 4, matched: 1, noField: 1, noMatch: 1, failed: 1 });
  });
  it('mapTally is honest counts, never silence', () => {
    assert.equal(mapTally({ total: 24, matched: 18, noMatch: 3, noField: 3 }, { system: 'Shopify' }), '24 rows: 18 matched, 3 with no Shopify match, 3 with no value to look up.');
    assert.equal(mapTally({ total: 1, matched: 1 }), '1 row: 1 matched.');
    assert.ok(mapTally({ total: 20, matched: 20, capped: true }).includes('(capped)'));
  });
});
