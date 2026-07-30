// Core/rideCache.test.js — the age-aware read cache (v2.74.1881). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rideCacheKey, hostOfKey, makeRideCache, wireParamNames } from './rideCache.js';

const LEG = { key: 'me.vendorsuite.vs_warranty_tasks@vendorsuite.drhorton.com', tool: { origin: 'vendorsuite.drhorton.com', method: 'GET', recipeId: 'vs_warranty_tasks' } };
// v1887 — the same leg WITH its endpoint template, which is what declares the request's real param surface.
const LEG_EP = { ...LEG, tool: { ...LEG.tool, endpoint: '/api/Vendor/Warranty/Tasks/{divisionId}/{status}' } };

describe('rideCache — the key is the REQUEST', () => {
  it('same request → same key, regardless of param order', () => {
    assert.equal(
      rideCacheKey(LEG, { status: 'open', divisionId: 32 }),
      rideCacheKey(LEG, { divisionId: 32, status: 'open' }),
    );
  });
  it('a different cell is a different key — under-keying would return another division’s rows', () => {
    const a = rideCacheKey(LEG, { divisionId: 32, status: 'open' });
    for (const p of [{ divisionId: 37, status: 'open' }, { divisionId: 32, status: 'closed' }, { divisionId: 32 }])
      assert.notEqual(rideCacheKey(LEG, p), a, JSON.stringify(p));
  });
  it('OVER-keys deliberately: a client-side filter param still splits the key', () => {
    // a missed hit is invisible; serving the wrong cell is a wrong answer. Safe side of the trade.
    assert.notEqual(
      rideCacheKey(LEG, { divisionId: 32, status: 'open', address: 'Misty Creek' }),
      rideCacheKey(LEG, { divisionId: 32, status: 'open' }),
    );
  });
  it('host and method are part of identity', () => {
    const other = { ...LEG, tool: { ...LEG.tool, origin: 'other.example.com' } };
    assert.notEqual(rideCacheKey(other, { a: 1 }), rideCacheKey(LEG, { a: 1 }));
    const post = { ...LEG, tool: { ...LEG.tool, method: 'POST' } };
    assert.notEqual(rideCacheKey(post, { a: 1 }), rideCacheKey(LEG, { a: 1 }));
  });
  it('hostOfKey recovers the host for invalidation', () => {
    assert.equal(hostOfKey(rideCacheKey(LEG, { a: 1 })), 'vendorsuite.drhorton.com');
  });
  it('degenerate legs do not throw', () => {
    assert.equal(typeof rideCacheKey({}, {}), 'string');
    assert.equal(typeof rideCacheKey(null, null), 'string');
  });
});

describe('rideCache — age is not optional', () => {
  it('a fresh entry is NOT served unless the caller states an acceptable age', () => {
    const c = makeRideCache();
    c.set('k', { rows: 1 }, 1000);
    assert.equal(c.get('k', 0, 1000), null, '0 means nothing cached is acceptable — the default everywhere');
    assert.equal(c.get('k', undefined, 1000), null);
    assert.ok(c.get('k', 5000, 1000), 'served once an age is stated');
  });
  it('a hit reports its age, so a receipt or a sentence can say so', () => {
    const c = makeRideCache();
    c.set('k', { rows: 1 }, 1000);
    assert.equal(c.get('k', 60000, 31000).ageMs, 30000);
  });
  it('past the stated age it is a miss, not a stale hit', () => {
    const c = makeRideCache();
    c.set('k', { rows: 1 }, 1000);
    assert.ok(c.get('k', 10000, 10000));
    assert.equal(c.get('k', 10000, 12000), null);
  });
  it('a missing key is simply a miss', () => {
    assert.equal(makeRideCache().get('nope', 60000), null);
  });
});

describe('rideCache — bounded, and invalidatable', () => {
  it('evicts OLDEST first — staleness and insertion order agree here', () => {
    const c = makeRideCache({ max: 3 });
    for (let i = 0; i < 5; i++) c.set(`h|GET|r|k${i}`, { i }, 1000 + i);
    assert.equal(c.size(), 3);
    assert.equal(c.get('h|GET|r|k0', 60000, 1005), null, 'the two oldest are gone');
    assert.equal(c.get('h|GET|r|k1', 60000, 1005), null);
    assert.ok(c.get('h|GET|r|k4', 60000, 1005));
  });
  it('re-setting a key refreshes its age AND its eviction position', () => {
    const c = makeRideCache({ max: 2 });
    c.set('h|GET|r|a', { v: 1 }, 1000);
    c.set('h|GET|r|b', { v: 2 }, 1001);
    c.set('h|GET|r|a', { v: 3 }, 1002);   // 'a' becomes the newest
    c.set('h|GET|r|c', { v: 4 }, 1003);   // evicts 'b', not 'a'
    assert.ok(c.get('h|GET|r|a', 60000, 1003));
    assert.equal(c.get('h|GET|r|b', 60000, 1003), null);
  });
  it('clearHost drops one host and leaves the others — the invalidation a WRITE needs', () => {
    const c = makeRideCache();
    c.set('vendorsuite.drhorton.com|GET|r|x', { v: 1 }, 1000);
    c.set('vendorsuite.drhorton.com|GET|r|y', { v: 2 }, 1000);
    c.set('admin.shopify.com|GET|r|z', { v: 3 }, 1000);
    assert.equal(c.clearHost('VendorSuite.DRHorton.com'), 2, 'case-insensitive');
    assert.equal(c.size(), 1);
    assert.ok(c.get('admin.shopify.com|GET|r|z', 60000, 1000));
  });
  it('never stores a null value', () => {
    const c = makeRideCache();
    c.set('k', null, 1000);
    c.set('', { v: 1 }, 1000);
    assert.equal(c.size(), 0);
  });
});

describe('rideCache — v1887: only params that reach the WIRE are part of the request', () => {
  it('reads the placeholder set off the endpoint template', () => {
    const w = wireParamNames(LEG_EP);
    assert.deepEqual([...w].sort(), ['divisionId', 'status']);
  });
  it('a client-side-only param does NOT change the key — the live 363-miss', () => {
    // `address` is the drill's row filter, applied AFTER the read; three text searches over the same cell were
    // three identical requests under three keys.
    const base = rideCacheKey(LEG_EP, { divisionId: 83, status: 'open' });
    assert.equal(rideCacheKey(LEG_EP, { divisionId: 83, status: 'open', address: 'leaking dishwasher' }), base);
    assert.equal(rideCacheKey(LEG_EP, { divisionId: 83, status: 'open', address: 'soft switch' }), base);
  });
  it('a param that IS in the template still keys — under-keying would return another cell’s rows', () => {
    const base = rideCacheKey(LEG_EP, { divisionId: 83, status: 'open' });
    assert.notEqual(rideCacheKey(LEG_EP, { divisionId: 129, status: 'open' }), base);
    assert.notEqual(rideCacheKey(LEG_EP, { divisionId: 83, status: 'new' }), base);
  });
  it('body-template placeholders count too (a read-only GQL POST)', () => {
    const gql = { tool: { origin: 'admin.shopify.com', method: 'POST', recipeId: 'shopify_orders', endpoint: '/api/graphql', body: { query: 'q', variables: { first: '{limit}' } } } };
    const w = wireParamNames(gql);
    assert.ok(w.has('limit'));
    assert.notEqual(rideCacheKey(gql, { limit: 10 }), rideCacheKey(gql, { limit: 50 }));
  });
  it('the urlParam is kept — it stands in for WHICH workspace was read', () => {
    const shop = { tool: { origin: 'admin.shopify.com', method: 'GET', recipeId: 'shopify_orders_queue', endpoint: '/store/{handle}/orders', urlParam: { name: 'handle', pattern: '/store/([^/]+)/' } } };
    assert.ok(wireParamNames(shop).has('handle'));
  });
  it('NO template → null, and every param keys exactly as before (broker/oauth legs untouched)', () => {
    assert.equal(wireParamNames(LEG), null);
    assert.equal(wireParamNames({}), null);
    const a = rideCacheKey(LEG, { divisionId: 83, status: 'open', address: 'x' });
    assert.notEqual(rideCacheKey(LEG, { divisionId: 83, status: 'open' }), a);
  });
});
