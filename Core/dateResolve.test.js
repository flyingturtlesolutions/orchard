// Core/dateResolve.test.js — RC-validate slice B (DATE), v2.74.2063 (node --test).
// The connectorRecipes.test.js file is NOT owned by this slice, so the hop-seal + coerceParams-date-branch +
// dateFilterViolations + catalog-declaration integration asserts are FOLDED here (the scout's fallback home).
//
// All relative assertions use a FIXED injected nowIso to prove determinism. Anchor: 2026-08-06 is a THURSDAY (UTC),
// so dow=4; Monday of that ISO week is 2026-08-03.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveDatePhrase } from './dateResolve.js';
import { coerceParams, dateFilterViolations, CONNECTOR_RECIPES } from './connectorRecipes.js';
import { recipeToLeg } from './connectorLeg.js';

const NOW = '2026-08-06T12:00:00Z';   // Thursday

describe('resolveDatePhrase — pure, clock-injected (v2062)', () => {
  it('a bare ISO date passes through (resolvable WITHOUT the clock)', () => {
    assert.deepEqual(resolveDatePhrase('2026-07-01', NOW), { iso: '2026-07-01', grain: 'date' });
    assert.deepEqual(resolveDatePhrase('2026-07-01', null), { iso: '2026-07-01', grain: 'date' });   // no clock needed
    assert.deepEqual(resolveDatePhrase('2026-07-01T09:30:00Z', NOW), { iso: '2026-07-01', grain: 'date' });   // time part discarded
  });
  it('an out-of-calendar ISO is unknown, not echoed as a bogus bound', () => {
    assert.deepEqual(resolveDatePhrase('2026-13-45', NOW), { unknown: true });
  });
  it('today / yesterday / tomorrow → a single day against the injected now', () => {
    assert.deepEqual(resolveDatePhrase('today', NOW), { iso: '2026-08-06', grain: 'date' });
    assert.deepEqual(resolveDatePhrase('yesterday', NOW), { iso: '2026-08-05', grain: 'date' });
    assert.deepEqual(resolveDatePhrase('Tomorrow', NOW), { iso: '2026-08-07', grain: 'date' });
  });
  it("'this week' / 'last week' are Monday-start ranges", () => {
    assert.deepEqual(resolveDatePhrase('this week', NOW), { from: '2026-08-03', to: '2026-08-09', grain: 'week' });
    assert.deepEqual(resolveDatePhrase('last week', NOW), { from: '2026-07-27', to: '2026-08-02', grain: 'week' });
  });
  it("'this month' / 'last month' span the calendar month", () => {
    assert.deepEqual(resolveDatePhrase('this month', NOW), { from: '2026-08-01', to: '2026-08-31', grain: 'month' });
    assert.deepEqual(resolveDatePhrase('last month', NOW), { from: '2026-07-01', to: '2026-07-31', grain: 'month' });
  });
  it("'this year' / 'last year' span the calendar year", () => {
    assert.deepEqual(resolveDatePhrase('this year', NOW), { from: '2026-01-01', to: '2026-12-31', grain: 'year' });
    assert.deepEqual(resolveDatePhrase('last year', NOW), { from: '2025-01-01', to: '2025-12-31', grain: 'year' });
  });
  it("'last N days' / 'past N days' → [now-N, now]", () => {
    assert.deepEqual(resolveDatePhrase('last 7 days', NOW), { from: '2026-07-30', to: '2026-08-06', grain: 'date' });
    assert.deepEqual(resolveDatePhrase('past 30 days', NOW), { from: '2026-07-07', to: '2026-08-06', grain: 'date' });
  });
  it("'since Tuesday' → an OPEN lower bound at the most recent Tuesday on/before now", () => {
    assert.deepEqual(resolveDatePhrase('since Tuesday', NOW), { from: '2026-08-04', grain: 'date' });   // 2026-08-04 is a Tuesday
    assert.deepEqual(resolveDatePhrase('since 2026-07-01', NOW), { from: '2026-07-01', grain: 'date' });
    assert.deepEqual(resolveDatePhrase('since last month', NOW), { from: '2026-07-01', grain: 'month' });
  });
  it('a bare weekday → the most recent occurrence on/before now (single day)', () => {
    assert.deepEqual(resolveDatePhrase('tuesday', NOW), { iso: '2026-08-04', grain: 'date' });
    assert.deepEqual(resolveDatePhrase('Thursday', NOW), { iso: '2026-08-06', grain: 'date' });   // today IS Thursday
  });
  it('a bare month name (optional year) → that month range', () => {
    assert.deepEqual(resolveDatePhrase('july', NOW), { from: '2026-07-01', to: '2026-07-31', grain: 'month' });
    assert.deepEqual(resolveDatePhrase('February 2024', NOW), { from: '2024-02-01', to: '2024-02-29', grain: 'month' });   // leap
  });
  it('garbage / empty / a relative phrase with no clock → unknown', () => {
    assert.deepEqual(resolveDatePhrase('asdf', NOW), { unknown: true });
    assert.deepEqual(resolveDatePhrase('', NOW), { unknown: true });
    assert.deepEqual(resolveDatePhrase('last week', null), { unknown: true });   // relative, no clock → never guess
  });
  it('is deterministic: two calls with the same nowIso are identical', () => {
    assert.deepEqual(resolveDatePhrase('this week', NOW), resolveDatePhrase('this week', NOW));
  });
});

describe('coerceParams — the DATE normalize branch is improve-or-noop and DORMANT without now (v2062)', () => {
  const SCHEMA = { type: 'object', properties: { query: { type: 'string', dateFilter: { fields: ['processed_at'], grain: 'date' } } } };
  it('rewrites a relative operand inside the query to a concrete ISO bound (range picks its end by comparator)', () => {
    assert.equal(coerceParams({ query: 'processed_at:>"last month"' }, SCHEMA, { now: NOW }).query, 'processed_at:>2026-07-01');
    assert.equal(coerceParams({ query: 'processed_at:<"last month"' }, SCHEMA, { now: NOW }).query, 'processed_at:<2026-07-31');
    assert.equal(coerceParams({ query: 'processed_at:>yesterday' }, SCHEMA, { now: NOW }).query, 'processed_at:>2026-08-05');
  });
  it('an already-ISO operand and an unresolved operand ride unchanged (noop)', () => {
    assert.equal(coerceParams({ query: 'processed_at:>2026-07-01' }, SCHEMA, { now: NOW }).query, 'processed_at:>2026-07-01');
    assert.equal(coerceParams({ query: 'processed_at:>"banana"' }, SCHEMA, { now: NOW }).query, 'processed_at:>"banana"');
  });
  it('a range under equality/no comparator is left untouched (no guessed end — silent-mis-filter guard)', () => {
    assert.equal(coerceParams({ query: 'processed_at:"last month"' }, SCHEMA, { now: NOW }).query, 'processed_at:"last month"');
  });
  it('DORMANT: without an injected now the value is byte-identical (this slice ships zero now-callers)', () => {
    assert.equal(coerceParams({ query: 'processed_at:>"last month"' }, SCHEMA).query, 'processed_at:>"last month"');
  });
  it('a non-dateFilter param is untouched by the branch', () => {
    const S2 = { type: 'object', properties: { name: { type: 'string' } } };
    assert.equal(coerceParams({ name: 'last month' }, S2, { now: NOW }).name, 'last month');
  });
});

describe('dateFilterViolations — refuse-before-wire primitive, callerless + dormant (v2062)', () => {
  const SCHEMA = { type: 'object', properties: { query: { type: 'string', dateFilter: { fields: ['processed_at'] } } } };
  it('flags an operand that cannot resolve; a resolvable / ISO one is not a violation', () => {
    assert.deepEqual(dateFilterViolations({ query: 'processed_at:>"banana"' }, SCHEMA, { now: NOW }), [{ param: 'query', value: 'banana', field: 'processed_at' }]);
    assert.deepEqual(dateFilterViolations({ query: 'processed_at:>"last month"' }, SCHEMA, { now: NOW }), []);
    assert.deepEqual(dateFilterViolations({ query: 'processed_at:>2026-07-01' }, SCHEMA, { now: NOW }), []);
  });
  it('DORMANT: no clock → never judges (returns [])', () => {
    assert.deepEqual(dateFilterViolations({ query: 'processed_at:>"banana"' }, SCHEMA), []);
  });
});

describe('DATE belt — catalog declaration + hop-3 seal (v2062)', () => {
  it('the dateFilter marker is declared on shopify_orders_search.query', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_orders_search');
    const qp = rec.params.find((p) => p.name === 'query');
    assert.ok(qp.dateFilter && Array.isArray(qp.dateFilter.fields) && qp.dateFilter.fields.includes('processed_at'), 'the date field must be declared on the param');
  });
  it('dateFilter rides hop 3 onto the projected leg schema (a drop would be the seeded-path bug class)', () => {
    const rec = CONNECTOR_RECIPES.find((r) => r.id === 'shopify_orders_search');
    const leg = recipeToLeg({ ...rec, app: 'shopify', origin: 'admin.shopify.com', groundId: 'g' }, { trusted: true });
    assert.ok(leg.paramSchema.properties.query.dateFilter && leg.paramSchema.properties.query.dateFilter.fields.includes('processed_at'), 'a dropped dateFilter would silently disarm the seeded path');
  });
});
