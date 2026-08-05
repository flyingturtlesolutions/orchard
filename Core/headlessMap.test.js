// Core/headlessMap.test.js — pinned headless map (v2.74.2036).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMapStep } from './headlessMap.js';

describe('runMapStep — pin discipline', () => {
  it('fails closed without a banked target pin', async () => {
    const r = await runMapStep({ pinned: { kind: 'map' } }, { state: { lastValue: [{ Email: 'a@b.co' }] } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'map-not-banked');
  });
  it('fails without prior rows', async () => {
    const r = await runMapStep({
      pinned: { kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g1', valueParam: 'query', system: 'shopify' },
    }, { state: { lastValue: [] } });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no-prior-rows');
  });
  it('looks up each row and tallies misses when invoke returns empty', async () => {
    const rec = { id: 'shopify_find_customer', name: 'Find', app: 'shopify', method: 'GET', endpoint: '/x', origin: 'admin.shopify.com', enabled: true, reviewState: 'accepted', write: false, safetyClass: 'auto', params: [{ name: 'query', type: 'string' }] };
    const r = await runMapStep({
      pinned: { kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g1', valueParam: 'query', itemField: 'Email', system: 'shopify' },
    }, {
      state: { lastValue: [{ Email: 'a@b.co', Name: 'A' }, { Email: 'c@d.co', Name: 'C' }] },
      readRecipes: async () => [rec],
      invoke: async () => ({ success: true, value: { rows: [] } }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.state.lastMapCounts.noMatch, 2);
    assert.equal(r.state.lastMisses.length, 2);
    assert.equal(r.state.lastMapRan, true);
  });
});
