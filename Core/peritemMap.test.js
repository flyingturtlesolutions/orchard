// Core/peritemMap.test.js — PM-0 (v2.74.1625): the per-item cross-system map's pure core.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeMapVerdict, pickFieldPath, extractValue, buildJoinRows, mapTally, tallyResults, valueShapeMismatch, resolveJoinField, normalizeRungs, ladderValues,
  isMapJoinEnvelope, unwrapMapPrior, resolveIdentityField,
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
    assert.equal(normalizeMapVerdict({ target: { system: 's', readAsk: 'r' } }).itemField, '', 'itemField is OPTIONAL (v1636) — absent means "use the declared ladder"');
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

describe('peritemMap — v1626: ambiguity is HONEST, containers are not keys, shapes are checked', () => {
  const BOTH = [
    { TaskNumber: '01', HomeownerEmail: 'a@b.com', HomeownerPhone: '219-798-9326' },
    { TaskNumber: '02', HomeownerEmail: 'c@d.com', HomeownerPhone: '336-555-1212' },
  ];
  it('a tie between equally-named fields ASKS instead of taking whichever key came first', () => {
    const r = pickFieldPath(BOTH, 'homeowner');
    assert.equal(r.ambiguous, true);
    assert.deepEqual(r.candidates.map((c) => c.path).sort(), ['HomeownerEmail', 'HomeownerPhone']);
  });
  it('naming the contact method resolves cleanly (no ambiguity)', () => {
    assert.deepEqual(pickFieldPath(BOTH, "its homeowner's email"), { path: 'HomeownerEmail', matchedBy: 'name' });
    assert.deepEqual(pickFieldPath(BOTH, 'homeowner phone'), { path: 'HomeownerPhone', matchedBy: 'name' });
  });
  it('a CONTAINER path is never a lookup key (it would extract nothing on every row)', () => {
    const nested = [{ TaskNumber: '01', Contacts: [{ Name: 'Erick', Email: 'e@x.com', Phone: '219-555-0100' }] }];
    const r = pickFieldPath(nested, 'contact');
    assert.notEqual(r && r.path, 'Contacts', 'the array container must not win');
    assert.deepEqual(pickFieldPath(nested, 'contact email'), { path: 'Contacts.Email', matchedBy: 'name' });
  });
  it('valueShapeMismatch catches a typed target fed the wrong column', () => {
    assert.equal(valueShapeMismatch(['219-798-9326', '336-555-1212'], 'email Find a Shopify customer by email'), 'phone-for-email');
    assert.equal(valueShapeMismatch(['a@b.com', 'c@d.com'], 'phone shopify_customer_by_phone'), 'email-for-phone');
    assert.equal(valueShapeMismatch(['a@b.com'], 'email shopify_customer_by_email'), null, 'consistent → no complaint');
    assert.equal(valueShapeMismatch(['anything'], 'query Search Shopify customers by name'), null, 'an untyped search accepts anything');
    assert.equal(valueShapeMismatch([], 'email by email'), null, 'no values → nothing to judge');
  });
});

describe('peritemMap — resolveJoinField (v1633: the declared cross-system join key)', () => {
  // The user's domain rule: email/phone/name can differ on the other system; the warranty SHIPPING ADDRESS is stable.
  const DECL = ['AddressLine1', 'ContactEmail'];
  const ROWS = [
    { TaskNumber: '01', AddressLine1: '1008 Harb Drive', CityStateZip: 'ARCHDALE, NC 27263', HomeownerEmail: 'a@b.com', HomeownerPhone: '336-555-0100' },
  ];
  it('an UNSPECIFIED field uses the recipe’s declared join key (the address), not a guess', () => {
    assert.deepEqual(resolveJoinField(ROWS, '', DECL), { path: 'AddressLine1', matchedBy: 'declared' });
    assert.deepEqual(resolveJoinField(ROWS, null, DECL), { path: 'AddressLine1', matchedBy: 'declared' });
  });
  it('an AMBIGUOUS phrase defers to the declaration instead of asking', () => {
    assert.deepEqual(resolveJoinField(ROWS, 'homeowner', DECL), { path: 'AddressLine1', matchedBy: 'declared' });
  });
  it('an EXPLICIT field always wins over the declaration', () => {
    assert.deepEqual(resolveJoinField(ROWS, "homeowner's email", DECL), { path: 'HomeownerEmail', matchedBy: 'named' });
    assert.deepEqual(resolveJoinField(ROWS, 'homeowner phone', DECL), { path: 'HomeownerPhone', matchedBy: 'named' });
  });
  it('the declaration falls THROUGH to the next key when the first is absent from the rows', () => {
    const noAddr = [{ TaskNumber: '01', ContactEmail: 'c@d.com' }];
    assert.deepEqual(resolveJoinField(noAddr, '', DECL), { path: 'ContactEmail', matchedBy: 'declared' });
  });
  it('with NO declaration the v1626 behavior is unchanged (ambiguous → ask; nothing → null)', () => {
    const both = [{ HomeownerEmail: 'a@b.com', HomeownerPhone: '336-555-0100' }];
    assert.equal(resolveJoinField(both, 'homeowner', null).ambiguous, true);
    assert.equal(resolveJoinField(ROWS, '', null), null);
  });
});

describe('peritemMap — PM-7 the LOOKUP LADDER (v1634)', () => {
  const LADDER = [
    'AddressLine1',
    { contact: 'primary', type: 'email' }, { contact: 'primary', type: 'phone' }, { contact: 'primary', type: 'name' },
    { contact: 'other', type: 'email' }, { contact: 'other', type: 'phone' }, { contact: 'other', type: 'name' },
  ];
  const ROW = {
    AddressLine1: '1008 Harb Drive',
    __contacts: [
      { IsPrimary: true, FullName: 'Erick Acosta', Email: 'erick@x.com', Phone: '219-798-9326' },
      { IsPrimary: false, FullName: 'Selena Ruiz', Email: 'selena@y.com', Phone: '336-555-0100' },
    ],
  };
  it('normalizeRungs keeps field names AND {contact,type} selectors, capped', () => {
    const r = normalizeRungs(LADDER);
    assert.equal(r.length, 7);
    assert.deepEqual(r[0], { field: 'AddressLine1' });
    assert.deepEqual(r[1], { contact: 'primary', type: 'email' });
    assert.deepEqual(r[4], { contact: 'other', type: 'email' });
    assert.equal(normalizeRungs(null).length, 0);
  });
  it('ladderValues yields the rungs IN ORDER: address, then the primary contact, then the other', () => {
    const v = ladderValues(ROW, normalizeRungs(LADDER));
    assert.deepEqual(v.map((x) => x.value), ['1008 Harb Drive', 'erick@x.com', '219-798-9326', 'Erick Acosta', 'selena@y.com', '336-555-0100', 'Selena Ruiz']);
    assert.deepEqual(v.map((x) => x.type), ['text', 'email', 'phone', 'name', 'email', 'phone', 'name']);
    assert.ok(v[1].label.includes('primary'));
    assert.ok(v[4].label.includes('other'));
  });
  it('rungs with no value are SKIPPED, and a duplicate value is one attempt', () => {
    const thin = { AddressLine1: '1 Main St', __contacts: [{ IsPrimary: true, Email: 'a@b.com' }] };
    const v = ladderValues(thin, normalizeRungs(LADDER));
    assert.deepEqual(v.map((x) => x.value), ['1 Main St', 'a@b.com']);
    const dupe = { __contacts: [{ IsPrimary: true, Email: 'same@x.com' }, { Email: 'same@x.com' }] };
    assert.equal(ladderValues(dupe, normalizeRungs(LADDER)).length, 1);
  });
  it('no contacts preserved → only the field rungs resolve (never a crash)', () => {
    assert.deepEqual(ladderValues({ AddressLine1: '5 Oak' }, normalizeRungs(LADDER)).map((x) => x.value), ['5 Oak']);
    assert.deepEqual(ladderValues({}, normalizeRungs(LADDER)), []);
  });
  it('a role STRING (not a boolean flag) also marks the primary contact', () => {
    const rowStr = { __contacts: [{ ContactType: 'Secondary', Email: 's@x.com' }, { ContactType: 'Primary Homeowner', Email: 'p@x.com' }] };
    const v = ladderValues(rowStr, normalizeRungs([{ contact: 'primary', type: 'email' }, { contact: 'other', type: 'email' }]));
    assert.deepEqual(v.map((x) => x.value), ['p@x.com', 's@x.com']);
  });
});

describe('peritemMap — v1757 unwrapMapPrior (gl 133556 map→map seam)', () => {
  const src = [
    { TaskNumber: '01', AddressLine1: '1 Main' },
    { TaskNumber: '02', AddressLine1: '2 Oak' },
  ];
  const results = [
    { value: 'a@b.com', ok: true, match: { id: 'gid://shopify/Customer/1', email: 'a@b.com', displayName: 'Alice' } },
    { value: 'c@d.com', ok: true, match: { id: 'gid://shopify/Customer/2', email: 'c@d.com', displayName: 'Bob' } },
  ];
  const joined = buildJoinRows(src, results, {
    join: 'table',
    identify: (r) => ({ id: r.TaskNumber, label: `task ${r.TaskNumber}` }),
    system: 'shopify',
  });

  it('detects table-join envelopes; plain rows are not envelopes', () => {
    assert.equal(isMapJoinEnvelope(joined[0]), true);
    assert.equal(isMapJoinEnvelope(src[0]), false);
    assert.equal(isMapJoinEnvelope(null), false);
  });

  it('plain prior passes through unchanged', () => {
    const u = unwrapMapPrior(src, { targetSystem: 'shopify' });
    assert.equal(u.mode, 'plain');
    assert.deepEqual(u.rows, src);
  });

  it('same-system follow-up with no itemField → matched records (the gl 133556 fix)', () => {
    const u = unwrapMapPrior(joined, { targetSystem: 'shopify' });
    assert.equal(u.mode, 'match');
    assert.equal(u.priorSystem, 'shopify');
    assert.equal(u.rows.length, 2);
    assert.equal(u.rows[0].email, 'a@b.com');
    assert.equal(u.rows[1].displayName, 'Bob');
    // Envelope top-level must NOT be what resolveJoinField sees — that was the live miss.
    assert.equal(resolveJoinField(joined, '', ['AddressLine1']), null);
    assert.ok(resolveJoinField(u.rows, '', null) === null);   // no declaration on matches
    assert.deepEqual(resolveIdentityField(u.rows), { path: 'email', matchedBy: 'identity' });
  });

  it('cross-system / named itemField → source.row so the origin ladder still works', () => {
    const cross = unwrapMapPrior(joined, { targetSystem: 'hubspot' });
    assert.equal(cross.mode, 'source');
    assert.deepEqual(cross.rows, src);
    assert.deepEqual(resolveJoinField(cross.rows, '', ['AddressLine1']), { path: 'AddressLine1', matchedBy: 'declared' });

    const named = unwrapMapPrior(joined, { targetSystem: 'shopify', itemField: 'AddressLine1' });
    assert.equal(named.mode, 'source');
    assert.deepEqual(named.rows, src);
  });

  it('unmatched envelopes do not invent matches — fall back to source.row', () => {
    const miss = buildJoinRows(src, [
      { value: 'x@y.com', ok: true, match: null },
      { value: null },
    ], { join: 'table', system: 'shopify' });
    const u = unwrapMapPrior(miss, { targetSystem: 'shopify' });
    assert.equal(u.mode, 'source');
    assert.deepEqual(u.rows, src);
  });
});

describe('peritemMap — v1882: the shape fallback must not guess, and a tie must not claim a schema', () => {
  // The REAL vs_warranty_task detail record (PAYLOAD ▸ 210342:69) — note it carries NO phone field at all, which is
  // why the fallback fired live and returned the SearchField index blob as "the homeowner phone".
  const REC = {
    SearchField: '3955 gallery chase|217710000|briarwood|4451622|01|cumming, ga 30028|0051 / - / -|01|295|4451622-01-01',
    TaskId: 10171475, TicketId: 4451622, BusinessUnitId: 3492595, TaskNumber: '01', ClaimNumber: '01',
    Age: '295', IsPaid: true, DateCreated: '2025-10-07T12:59:34.787', IssueDate: '2025-10-07T12:59:34.787',
    VendorId: 217710000, VendorExplanation: 'reached out to schedule 42966', Instructions: 'Deako to call h/owner',
  };
  it('THE LIVE DUMP: "homeowner phone" returns null, not the search index', () => {
    // v1882-b — this now holds through `_looksPhone`'s anchoring ALONE. A qualifier gate was tried and reverted:
    // it deleted the correct answer for the same ask against a record that DOES hold a phone (see below).
    assert.equal(pickFieldPath([REC], 'homeowner phone', 'homeowner phone'), null);
    assert.equal(pickFieldPath([REC], 'phone', 'homeowner phone'), null, 'nor through the ladder rung that drops the qualifier');
  });
  it('and a QUALIFIED ask still resolves when the record really holds the value — the reverted gate broke this', () => {
    assert.deepEqual(pickFieldPath([{ TicketId: 4451622, Cell: '9195550134' }], 'phone', 'homeowner phone'), { path: 'Cell', matchedBy: 'shape' });
    assert.deepEqual(pickFieldPath([{ Id: 1, Contact: 'sam@x.com' }], 'email', 'homeowner email'), { path: 'Contact', matchedBy: 'shape' });
  });
  it('a concatenated index is never a phone, and neither is a timestamp', () => {
    assert.equal(pickFieldPath([{ Blob: 'a|b|c|217710000|d' }], 'phone', 'phone'), null);
    assert.equal(pickFieldPath([{ When: '2025-10-07T12:59:34.787' }], 'phone', 'phone'), null);
    assert.equal(pickFieldPath([{ Id: 4451622 }], 'phone', 'phone'), null, 'a 7-digit id is not a phone');
  });
  it('but a REAL shape fallback still resolves — the guard must not blunt the feature', () => {
    assert.deepEqual(pickFieldPath([{ Id: 5, Mobile: '919-555-0134' }], 'phone', 'phone'), { path: 'Mobile', matchedBy: 'shape' });
    assert.deepEqual(pickFieldPath([{ Id: 5, Contact: 'sam@x.com' }], 'email', 'email'), { path: 'Contact', matchedBy: 'shape' });
  });
  it('THE LIVE TIE: "PO number" reports the orphan token, so the caller need not claim a PO field exists', () => {
    const r = pickFieldPath([REC], 'number', 'PO number');
    assert.equal(r.ambiguous, true);
    assert.deepEqual(r.orphan, ['po']);
    assert.deepEqual(r.candidates.map((c) => c.path), ['TaskNumber', 'ClaimNumber']);
  });
  it('the orphan is computed over ALL candidates — over the tied pair alone it DENIED a present field', () => {
    // "any project number on this?" tied TaskNumber|ClaimNumber and reported orphan ["project"], rendering
    // "nothing matches project" while ProjectName sat on the same record. Truthful now: no orphan, so the caller
    // asks which rather than denying.
    const withProject = { ...REC, ProjectName: 'Briarwood', ProjectCode: 'C1' };
    assert.deepEqual(pickFieldPath([withProject], 'number', 'project number').orphan, []);
    assert.deepEqual(pickFieldPath([withProject], 'number', 'PO number').orphan, ['po'], 'and a token that really is absent still reports');
  });
  it('a bare "number"/"id" ask has NO orphan — it is a genuine ambiguity and must still ask', () => {
    assert.deepEqual(pickFieldPath([REC], 'number', 'number').orphan, []);
    const v = pickFieldPath([REC], 'vendor', 'vendor');
    assert.deepEqual(v.orphan, []);
    assert.deepEqual(v.candidates.map((c) => c.path), ['VendorId', 'VendorExplanation']);
  });
  it('askPhrase DEFAULTS to fieldPhrase, so every pre-v1882 caller is unchanged', () => {
    assert.deepEqual(pickFieldPath([REC], 'instructions'), { path: 'Instructions', matchedBy: 'name' });
    assert.deepEqual(pickFieldPath([REC], 'number').orphan, []);
  });
});

describe('peritemMap — v1885: a short token must match a WHOLE WORD', () => {
  // Live 074157 got two different answers from the SAME ask on two records, because `_carried`'s substring test finds
  // "po" inside ap-po-intments. Whether the orphan fired depended on an unrelated field's spelling.
  const BASE = { SearchField: 'x', TaskId: 1, TicketId: 2, TaskNumber: '01', ClaimNumber: '01', JobNumber: '9', AllowedAmount: 214 };
  it('"po" is orphaned whether or not the record carries Appointments', () => {
    assert.deepEqual(pickFieldPath([{ ...BASE, Appointments: [{ Start: 'x' }] }], 'number', 'PO number').orphan, ['po']);
    assert.deepEqual(pickFieldPath([BASE], 'number', 'PO number').orphan, ['po']);
  });
  it('a token of 4+ chars still matches by substring, so no false denial returns', () => {
    assert.deepEqual(pickFieldPath([{ ...BASE, ProjectName: 'Briarwood' }], 'number', 'project number').orphan, []);
    assert.deepEqual(pickFieldPath([{ ...BASE, CostCode: '71020' }], 'number', 'code number').orphan, []);
  });
  it('a short token still matches when it IS a camel WORD of the key — the floor needed word-splitting, not just a length', () => {
    // My first draft of this test asserted `_norm` camel-splits. It does not (`TaskId` -> "taskid"), so a 4-char floor
    // alone made every SHORT REAL token orphaned: "id number" reported "nothing matches id" on a record full of ids.
    // `keyWords` (camel-split, carried per candidate) is what makes the floor correct rather than merely strict.
    assert.deepEqual(pickFieldPath([BASE], 'number', 'id number').orphan, [], 'TaskId/TicketId carry "id" as a word');
    assert.deepEqual(pickFieldPath([{ ...BASE, PoRef: 'X1' }], 'number', 'po number').orphan, [], 'PoRef carries "po" as a word');
  });
  it('the ANCHOR alone rejects every non-phone shape — which is why the delimiter guard was deleted, not repaired', () => {
    // The guard read "same delimiter twice = a joined index" and was corrupt (a raw 0x01 for the backreference) since
    // v1882. Repairing it showed it could never decide anything: `_DIGITS` strips only [\s.()+-], so a joined value
    // keeps its pipes and fails ^\d{10,11}$ regardless. Pinned here so nothing re-adds it as "defence in depth".
    for (const v of ['3955 gallery chase|217710000|briarwood|4451622', '1234567890|1234567890', '2025-10-07T12:59:34.787', '4451622', 'call; 9195550134'])
      assert.equal(pickFieldPath([{ X: v }], 'phone', 'phone'), null, v);
    for (const v of ['919-555-0134', '9195550134', '(919) 555 0134'])
      assert.deepEqual(pickFieldPath([{ X: v }], 'phone', 'phone'), { path: 'X', matchedBy: 'shape' }, v);
  });
});
