// Core/rideParamResolve.test.js — declarative param resolution + drill row filter (CX-9b). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getPath, resolveRideParam, filterRowsByText } from './rideParamResolve.js';

// A miniature of the VendorSuite/State shape (structure from the HAR scrub; values fabricated).
const STATE = {
  access: {
    DefaultDivision: { Id: 83, Name: 'Atlanta West', Code: '210' },
    Hubs: [
      { HubName: 'East', Divisions: [{ Id: 83, Name: 'Atlanta West', Code: '210' }, { Id: 62, Name: 'Greensboro', Code: '350' }] },
      { HubName: 'West', Divisions: [{ Id: 10, Name: 'Seattle', Code: '750' }, { Id: 210, Name: 'Boise', Code: '445' }] },
    ],
  },
  currentHub: { Divisions: [{ Id: 83, Name: 'Atlanta West', Code: '210' }, { Id: 11, Name: 'Charleston', Code: '160' }] },
};
const SPEC = {
  via: '/api/VendorSuite/State',
  defaultPath: 'access.DefaultDivision.Id',
  lists: ['currentHub.Divisions', 'access.Hubs[].Divisions'],
  match: ['Code', 'Name'],
  id: 'Id', label: 'Name',
};

describe('rideParamResolve — getPath (dotted + [] flatten)', () => {
  it('walks plain segments and flattens [] arrays', () => {
    assert.equal(getPath(STATE, 'access.DefaultDivision.Id'), 83);
    const divs = getPath(STATE, 'access.Hubs[].Divisions');
    assert.equal(Array.isArray(divs), true);
    assert.equal(divs.flat(2).length, 4);                       // both hubs' divisions
    assert.equal(getPath(STATE, 'access.Nope.Id'), undefined);  // missing → undefined, never throws
  });
});

describe('rideParamResolve — resolveRideParam (the ID layer)', () => {
  it('missing value → the DEFAULT division (the user’s current context), labeled + marked defaulted', () => {
    const r = resolveRideParam(SPEC, undefined, STATE);
    assert.deepEqual(r, { value: 83, label: 'Atlanta West', defaulted: true });
  });
  it('a market NUMBER (Code) resolves — "210" → 83, even though division Id 210 (Boise) also exists (Code wins the field order… )', () => {
    // …no: a cross-row Code/Id collision must be AMBIGUOUS, never a silent pick (the wrong-division trap).
    const r = resolveRideParam(SPEC, '210', STATE);
    assert.equal(r.ambiguous, true);
    const labels = r.candidates.map((c) => c.label).sort();
    assert.deepEqual(labels, ['Atlanta West', 'Boise']);        // market 210 vs internal id 210 — the caller asks
  });
  it('a NAME resolves case-insensitively — "atlanta west" → 83', () => {
    assert.deepEqual(resolveRideParam(SPEC, 'atlanta west', STATE), { value: 83, label: 'Atlanta West' });
  });
  it('a collision-free Code resolves cleanly — "750" → Seattle 10', () => {
    assert.deepEqual(resolveRideParam(SPEC, '750', STATE), { value: 10, label: 'Seattle' });
  });
  it('the canonical Id passes through (with its honest label) — 83 → 83 Atlanta West, 11 → Charleston', () => {
    assert.deepEqual(resolveRideParam(SPEC, 83, STATE), { value: 83, label: 'Atlanta West' });
    assert.deepEqual(resolveRideParam(SPEC, '11', STATE), { value: 11, label: 'Charleston' });
  });
  it('an unknown value → unknown + closest-name candidates (an ask-back, not a dead 400)', () => {
    const r = resolveRideParam(SPEC, 'greensbor', STATE);       // typo'd prefix
    assert.equal(r.unknown, true);
    assert.deepEqual(r.candidates.map((c) => c.label), ['Greensboro']);
  });
  it('degrades to null on no spec / no state (caller proceeds unresolved, never blocks)', () => {
    assert.equal(resolveRideParam(null, '210', STATE), null);
    assert.equal(resolveRideParam(SPEC, '210', null), null);
  });

  it('CX-9e (v1438) — the MIS-BIND REPAIR semantics: a division name resolves EXACTLY (migrates), a street address does not (stays a filter)', () => {
    // the chat-side repair migrates a drill-filter value into the resolve param ONLY on a clean {value} — these two
    // are the live pair: "greensboro" (a division mis-bound as address) vs "cumming" (a real street/city filter).
    assert.deepEqual(resolveRideParam(SPEC, 'greensboro', STATE), { value: 62, label: 'Greensboro' });   // → migrate
    const cum = resolveRideParam(SPEC, 'cumming', STATE);
    assert.equal(cum.unknown, true);                                                                     // → stays an address
    assert.equal(cum.value, undefined);
  });
});

describe('rideParamResolve — filterRowsByText (the drill join)', () => {
  const ROWS = [
    { TaskId: 4001, TaskNumber: '4090740', AddressLine1: '123 Main Street NW', CityStateZip: 'Cumming, GA 30040' },
    { TaskId: 4002, TaskNumber: '4090741', AddressLine1: '456 Oak Avenue', CityStateZip: 'Cumming, GA 30041' },
    { TaskId: 4003, TaskNumber: '4090742', AddressLine1: '123 Main Street SE', CityStateZip: 'Atlanta, GA 30301' },
  ];
  const FIELDS = ['AddressLine1', 'CityStateZip', 'TaskNumber'];
  it('every token must hit — "123 main st cumming" matches exactly the NW row (st rides inside street)', () => {
    const hits = filterRowsByText(ROWS, FIELDS, '123 main st cumming');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].TaskId, 4001);
  });
  it('an under-specified address returns BOTH candidates (caller asks, never guesses)', () => {
    assert.equal(filterRowsByText(ROWS, FIELDS, '123 main').length, 2);
  });
  it('a task NUMBER matches its row too (the human number, not the internal id)', () => {
    const hits = filterRowsByText(ROWS, FIELDS, '4090742');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].TaskId, 4003);
  });
  it('no tokens / no rows / no match → empty', () => {
    assert.deepEqual(filterRowsByText(ROWS, FIELDS, '  '), []);
    assert.deepEqual(filterRowsByText([], FIELDS, 'x'), []);
    assert.deepEqual(filterRowsByText(ROWS, FIELDS, 'zzz nowhere'), []);
  });
});

describe('DK-7 (v2.74.1488) — the "each" mode (enumeration, opt-in, capped)', () => {
  const EACH_SPEC = { ...SPEC, each: true };
  it('spec.each + the sentinel → the FULL deduped enumeration in list order, {value,label} pairs', () => {
    const r = resolveRideParam(EACH_SPEC, 'each', STATE);
    assert.equal(r.each, true);
    assert.deepEqual(r.values.map((v) => v.value), [83, 11, 62, 10, 210]);
    assert.deepEqual(r.values.map((v) => v.label), ['Atlanta West', 'Charleston', 'Greensboro', 'Seattle', 'Boise']);
    assert.equal(r.total, 5);
    assert.equal(r.capped, false);
  });
  it('all three sentinels work, case/format-insensitively (EACH / Every / all)', () => {
    for (const s of ['EACH', 'Every', 'all']) assert.equal(resolveRideParam(EACH_SPEC, s, STATE).each, true, s);
  });
  it('OPT-IN only: without spec.each, "each" is an unknown value (honest ask-back, never a silent fan-out)', () => {
    const r = resolveRideParam(SPEC, 'each', STATE);
    assert.equal(r.each, undefined);
    assert.equal(r.unknown, true);
  });
  it('eachCap caps the values and flags capped, total stays the real count', () => {
    const r = resolveRideParam({ ...EACH_SPEC, eachCap: 2 }, 'each', STATE);
    assert.equal(r.values.length, 2);
    assert.equal(r.total, 5);
    assert.equal(r.capped, true);
  });
  it('an enumerable but EMPTY state → honest unknown, never a zero-item fan-out', () => {
    const r = resolveRideParam(EACH_SPEC, 'each', { access: {}, currentHub: {} });
    assert.equal(r.unknown, true);
  });
  it('a real division value still resolves normally on an each-enabled spec', () => {
    assert.deepEqual(resolveRideParam(EACH_SPEC, 'Atlanta West', STATE), { value: 83, label: 'Atlanta West' });
  });
});

describe('DK-7b (v2.74.1489) — eachCap guards ENUMERATION, not execution (windowing is the dispatcher\'s)', () => {
  it('a 30-division state enumerates fully under the 200 default (the live 121-division case fits)', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ Id: i + 1, Name: `Div ${i + 1}`, Code: String(100 + i) }));
    const st = { access: { Hubs: [{ Divisions: rows }] }, currentHub: {} };
    const r = resolveRideParam({ ...SPEC, each: true }, 'each', st);
    assert.equal(r.values.length, 30);
    assert.equal(r.capped, false);
  });
});
