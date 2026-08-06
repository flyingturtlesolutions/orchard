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
  it('onRow beats once per row — the cadence heartbeat seam (v2.74.2047)', async () => {
    const rec = { id: 'shopify_find_customer', name: 'Find', app: 'shopify', method: 'GET', endpoint: '/x', origin: 'admin.shopify.com', enabled: true, reviewState: 'accepted', write: false, safetyClass: 'auto', params: [{ name: 'query', type: 'string' }] };
    const beats = [];
    await runMapStep({
      pinned: { kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g1', valueParam: 'query', itemField: 'Email', system: 'shopify' },
    }, {
      state: { lastValue: [{ Email: 'a@b.co' }, { Email: 'c@d.co' }] },
      readRecipes: async () => [rec],
      invoke: async () => ({ success: true, value: { rows: [] } }),
      onRow: (done, total) => beats.push([done, total]),
    });
    assert.deepEqual(beats, [[1, 2], [2, 2]]);
  });
});

// ── v2.74.2044 — a FAILED lookup is not a miss. The write step consumes lastMisses verbatim, so a row whose
// lookup DIED (429/500/timeout — invokeRideRecipe returns {ok:false}, never throws) must stay out of the write
// set, or a rate-limited run auto-creates duplicates / inflates the parked preview a human approves. ─────────────
describe('runMapStep — lookup failures (v2.74.2044)', () => {
  const rec = { id: 'shopify_find_customer', name: 'Find', app: 'shopify', method: 'GET', endpoint: '/x', origin: 'admin.shopify.com', enabled: true, reviewState: 'accepted', write: false, safetyClass: 'auto', params: [{ name: 'query', type: 'string' }] };
  const clause = { pinned: { kind: 'map', capabilityId: 'shopify_find_customer', groundId: 'g1', valueParam: 'query', itemField: 'Email', system: 'shopify' } };

  it('a failed lookup tallies failed, NOT noMatch — the row never reaches lastMisses', async () => {
    const r = await runMapStep(clause, {
      state: { lastValue: [{ Email: 'a@b.co', Name: 'A' }, { Email: 'c@d.co', Name: 'C' }] },
      readRecipes: async () => [rec],
      invoke: async (payload) => (payload.args.query === 'a@b.co'
        ? { success: false, error: 'http-429', status: 429 }     // A's lookup DIED — its record may exist
        : { success: true, value: { rows: [] } }),               // C's lookup completed: a VERIFIED no-match
    });
    assert.equal(r.ok, true, 'partial signal — the run stands on the verified rows');
    assert.deepEqual(r.state.lastMapCounts, { total: 2, matched: 0, noMatch: 1, noField: 0, failed: 1 });
    assert.equal(r.state.lastMisses.length, 1, 'only the VERIFIED no-match row may reach the write step');
    assert.equal(r.state.lastMisses[0].value, 'c@d.co');
    assert.equal(r.value.joined[0].lookupFailed, true, 'the failed row is discriminated, not shaped like a miss');
    assert.equal(r.value.joined[0].match, null);
  });

  it('EVERY lookup failed → ok:false lookup-failed + stop (never a silent all-matched noop downstream)', async () => {
    const r = await runMapStep(clause, {
      state: { lastValue: [{ Email: 'a@b.co' }, { Email: 'c@d.co' }] },
      readRecipes: async () => [rec],
      invoke: async () => ({ success: false, error: 'http-500', status: 500 }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'lookup-failed');
    assert.equal(r.stop, true, 'the chain must stop — a following write would read empty misses as all-matched');
    assert.equal(r.state.lastMisses.length, 0, 'no row was verified missing');
    assert.equal(r.state.lastMapCounts.failed, 2);
    assert.equal(r.state.lastMapRan, true);
  });
});
