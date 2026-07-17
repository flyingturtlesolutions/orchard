// Core/routeHeal.test.js — RH-1a: route-miss detect + the drift-suspect state machine. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isRouteMiss, isProven, tickOk, tickRouteMiss, applyHeal, dismissHeal, DRIFT_MISS_N, OK_STAMP_MIN_MS, ROUTE_MISS_STATUSES } from './routeHeal.js';
import { mergeRecipes } from './rideRecipe.js';

const NOW = 1750000000000;

describe('routeHeal — isRouteMiss (the RH-0a failure signature)', () => {
  it('404/405/410 with an empty or non-JSON body IS a miss; the house http-NNN error string parses too', () => {
    for (const s of ROUTE_MISS_STATUSES) assert.equal(isRouteMiss({ status: s }), true, `status ${s}`);
    assert.equal(isRouteMiss({ error: 'http-404' }), true);
    assert.equal(isRouteMiss({ error: 'http-410', jsonBody: false }), true);
  });
  it('a structured JSON error body is the APP answering (record-not-found, validation) — NOT a route miss', () => {
    assert.equal(isRouteMiss({ status: 404, jsonBody: true }), false);
    assert.equal(isRouteMiss({ error: 'http-404', jsonBody: true }), false);
  });
  it('auth (401/403), params (400/422), server faults (5xx), and non-http errors are NOT misses', () => {
    for (const s of [400, 401, 403, 422, 500, 502]) assert.equal(isRouteMiss({ status: s }), false, `status ${s}`);
    assert.equal(isRouteMiss({ error: 'session-expired' }), false);
    assert.equal(isRouteMiss({ error: 'graphql-error' }), false);
    assert.equal(isRouteMiss({ error: 'op-hash-stale' }), false);   // the persisted-op 404 has its OWN heal (op re-capture) — never double-counted
    assert.equal(isRouteMiss({}), false);
  });
});

describe('routeHeal — isProven (heal PROVEN shapes only)', () => {
  it('curated is proven by authorship; harvested is proven only after a success stamp', () => {
    assert.equal(isProven({ provenance: 'curated' }), true);
    assert.equal(isProven({ provenance: 'harvested', lastOkAt: NOW }), true);
    assert.equal(isProven({ provenance: 'harvested', reviewState: 'pending' }), false);
    assert.equal(isProven(null), false);
  });
});

describe('routeHeal — tickOk (stamp + verify-ratchet clear)', () => {
  it('first success stamps lastOkAt; a re-stamp within the 6h window is a no-op (no storage churn per read)', () => {
    const t1 = tickOk({ id: 'r', provenance: 'harvested' }, NOW);
    assert.equal(t1.record.lastOkAt, NOW);
    assert.equal(t1.cleared, false);
    assert.equal(tickOk(t1.record, NOW + 60000), null, 'fresh stamp + no drift state → nothing to persist');
    assert.ok(tickOk(t1.record, NOW + OK_STAMP_MIN_MS + 1), 'stale stamp refreshes');
  });
  it('success CLEARS a drift streak/suspect even within the stamp window (the ratchet)', () => {
    const t = tickOk({ id: 'r', lastOkAt: NOW - 1000, missStreak: 2, driftSuspect: true }, NOW);
    assert.equal(t.record.missStreak, 0);
    assert.equal(t.record.driftSuspect, false);
    assert.equal(t.cleared, true);
    assert.equal(t.record.lastOkAt, NOW);
  });
});

describe('routeHeal — tickRouteMiss (N consecutive → driftSuspect)', () => {
  it('an UNPROVEN recipe never ticks (it was never right — nothing to heal)', () => {
    assert.equal(tickRouteMiss({ id: 'r', provenance: 'harvested' }, NOW), null);
  });
  it(`a proven recipe: miss 1 counts, miss ${DRIFT_MISS_N} flips driftSuspect exactly once`, () => {
    const r0 = { id: 'sh', provenance: 'curated' };
    const t1 = tickRouteMiss(r0, NOW);
    assert.equal(t1.streak, 1);
    assert.equal(t1.record.driftSuspect, undefined, 'one miss is not drift');
    assert.equal(t1.becameSuspect, false);
    const t2 = tickRouteMiss(t1.record, NOW + 1000);
    assert.equal(t2.streak, 2);
    assert.equal(t2.record.driftSuspect, true);
    assert.equal(t2.becameSuspect, true);
    assert.equal(t2.record.driftAt, NOW + 1000, 'the suspect moment is stamped (the RH-1b proposal names it)');
    const t3 = tickRouteMiss(t2.record, NOW + 2000);
    assert.equal(t3.becameSuspect, false, 'already suspect — no re-announcement');
    assert.equal(t3.record.driftAt, NOW + 1000, 'the first suspect moment sticks');
  });
});

describe('routeHeal — the state survives a curated re-seed (rideRecipe._USER_FIELDS)', () => {
  it('mergeRecipes preserves lastOkAt / missStreak / driftSuspect when the catalog refreshes the record', () => {
    const prior = [{ id: 'sh_x', provenance: 'curated', endpoint: '/old', lastOkAt: NOW, missStreak: 2, driftSuspect: true, enabled: true, reviewState: 'accepted' }];
    const incoming = [{ id: 'sh_x', provenance: 'curated', endpoint: '/new', enabled: true, reviewState: 'accepted' }];
    const out = mergeRecipes(prior, incoming);
    assert.equal(out[0].endpoint, '/new', 'mechanical fields refresh from the catalog');
    assert.equal(out[0].lastOkAt, NOW, 'the proof-of-life stamp survives');
    assert.equal(out[0].missStreak, 2, 'the drift evidence survives');
    assert.equal(out[0].driftSuspect, true, 'the suspect flag survives');
  });
});

describe('RH-1c (v2.74.1567) — applyHeal / dismissHeal + the RH-1d verify contract', () => {
  const PROPOSED = {
    id: 'sh_cust', method: 'POST', gql: true, provenance: 'curated', driftSuspect: true, missStreak: 3,
    endpoint: '/api/shopify/{handle}', requestHeaders: undefined,
    params: [{ name: 'email', type: 'string', required: true, hint: 'curated hint' }],
    healProposal: { at: NOW, endpoint: '/api/shopify/{handle}?operation=Customers&type=query', requestHeaders: { 'apollographql-client-name': 'core' }, diff: ['path: …'], fields: ['endpoint', 'requestHeaders'] },
  };
  it('apply on a gql READ (gqlReadOk): fields land + shadow into healOverride; streak clears; driftSuspect STAYS for the verify', () => {
    const a = applyHeal(PROPOSED, NOW + 10, { gqlReadOk: true });
    assert.ok(a, 'applies');
    assert.equal(a.record.endpoint, '/api/shopify/{handle}?operation=Customers&type=query');
    assert.deepEqual(a.record.requestHeaders, { 'apollographql-client-name': 'core' });
    assert.deepEqual(a.record.healOverride, { endpoint: '/api/shopify/{handle}?operation=Customers&type=query', requestHeaders: { 'apollographql-client-name': 'core' } });
    assert.equal(a.record.healProposal, undefined, 'proposal consumed');
    assert.equal(a.record.missStreak, 0);
    assert.equal(a.record.driftSuspect, true, 'RH-1d: the NEXT invoke is the trial — apply never claims the fix works');
    assert.equal(a.record.healedAt, NOW + 10);
    assert.deepEqual(a.fields.sort(), ['endpoint', 'requestHeaders']);
  });
  it('the RH-1d ratchet closes: success after apply clears driftSuspect (HEAL ▸ cleared); a gql write / un-validated document never applies', () => {
    const healed = applyHeal(PROPOSED, NOW, { gqlReadOk: true }).record;
    const t = tickOk(healed, NOW + 1000);
    assert.equal(t.record.driftSuspect, false, 'the verify clears the suspicion');
    assert.equal(t.cleared, true);
    assert.equal(applyHeal(PROPOSED, NOW, { gqlReadOk: false }), null, 'a POST without a validated read document never heals');
    assert.equal(applyHeal({ ...PROPOSED, gql: false, method: 'POST' }, NOW, { gqlReadOk: true }), null, 'a plain write never heals (§4 hard line)');
  });
  it('addParams are ADDITIVE only — an existing curated spec is never replaced', () => {
    const r = { id: 'g', method: 'GET', provenance: 'curated', driftSuspect: true, endpoint: '/a/{id}', params: [{ name: 'id', type: 'integer', hint: 'keep me' }], healProposal: { endpoint: '/a/{id}?q={q}', addParams: [{ name: 'q', type: 'string' }, { name: 'id', type: 'string' }], diff: ['x'] } };
    const a = applyHeal(r, NOW);
    assert.deepEqual(a.record.params, [{ name: 'id', type: 'integer', hint: 'keep me' }, { name: 'q', type: 'string' }]);
  });
  it('dismissHeal drops the proposal and nothing else; no proposal → null', () => {
    const d = dismissHeal(PROPOSED);
    assert.equal(d.healProposal, undefined);
    assert.equal(d.driftSuspect, true, 'suspicion stays honest');
    assert.equal(dismissHeal({ id: 'x' }), null);
  });
  it('the healOverride SHADOW survives the curated-refresh merge, then drops when the catalog catches up', () => {
    const healed = applyHeal(PROPOSED, NOW, { gqlReadOk: true }).record;
    // catalog still ships the OLD shape → the override re-asserts the healed fields over the refresh
    const stale = mergeRecipes([healed], [{ id: 'sh_cust', method: 'POST', gql: true, provenance: 'curated', endpoint: '/api/shopify/{handle}', enabled: true, reviewState: 'accepted' }]);
    assert.equal(stale[0].endpoint, '/api/shopify/{handle}?operation=Customers&type=query', 'the local heal shadows the stale catalog');
    assert.deepEqual(stale[0].requestHeaders, { 'apollographql-client-name': 'core' });
    // the catalog lands the fix → the override drops and the shipped shape (richer curated specs) takes over
    const caught = mergeRecipes(stale, [{ id: 'sh_cust', method: 'POST', gql: true, provenance: 'curated', endpoint: '/api/shopify/{handle}?operation=Customers&type=query', requestHeaders: { 'apollographql-client-name': 'core' }, enabled: true, reviewState: 'accepted' }]);
    assert.equal(caught[0].healOverride, undefined, 'catalog caught up → the shadow retires');
    assert.equal(caught[0].endpoint, '/api/shopify/{handle}?operation=Customers&type=query');
  });
});
