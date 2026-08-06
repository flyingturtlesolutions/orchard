// Core/rideEach.test.js — v2.74.2047: the SW-side EACH sweep (the panel chain fan's headless twin). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runEachSweep, eachSweptParam, hasEachSentinel, isEachSentinel, fetchEachState, EACH_CONCURRENCY, EACH_ROW_CAP } from './rideEach.js';
import { rowsOf } from './headlessClause.js';

// The VS_DIVISION shape (Core/connectorRecipes.js) — the flagship spec this sweep exists for.
const SPEC = Object.freeze({
  via: '/api/VendorSuite/State',
  defaultPath: 'access.DefaultDivision.Id',
  lists: ['currentHub.Divisions', 'access.Hubs[].Divisions'],
  match: ['Code', 'Name'],
  id: 'Id', label: 'Name',
  each: true,
});

// Enumeration order (lists order, deduped by Id): 7 Raleigh · 83 Atlanta West · 10 Seattle.
const STATE = Object.freeze({
  access: { DefaultDivision: { Id: 83 }, Hubs: [{ Divisions: [{ Id: 83, Name: 'Atlanta West', Code: '210' }, { Id: 10, Name: 'Seattle', Code: '750' }] }] },
  currentHub: { Divisions: [{ Id: 7, Name: 'Raleigh', Code: '111' }] },
});

const mkLeg = (over = {}) => ({
  key: 'me.vendorsuite.vs_tasks@vendorsuite.example.com', domain: 'connector', mode: 'ask', source: 'connector',
  ...over,
  tool: {
    impl: 'session', origin: 'https://vendorsuite.example.com', appHost: 'vendorsuite.example.com',
    endpoint: '/api/Tasks/{divisionId}/{status}', method: 'GET', recipeId: 'vs_tasks', groundId: 'g-1',
    resolve: { divisionId: SPEC },
    ...(over.tool || {}),
  },
});

// A fake invoke: the via read answers with STATE; per-item calls answer per-division.
const mkInvoke = ({ perItem, onVia = null } = {}) => {
  const calls = { via: [], items: [] };
  const invoke = async (payload) => {
    if (payload.endpoint === SPEC.via) {
      calls.via.push(payload);
      return onVia ? onVia(payload) : { success: true, value: STATE };
    }
    calls.items.push(payload);
    return perItem(payload);
  };
  return { invoke, calls };
};

describe('rideEach — sentinel + axis detection', () => {
  const leg = mkLeg();
  it('isEachSentinel: each/every/all whole-value, strings only', () => {
    for (const v of ['each', 'EVERY', ' all ']) assert.equal(isEachSentinel(v), true, v);
    for (const v of ['open', 'each division', 1, null, undefined, ['each']]) assert.equal(isEachSentinel(v), false, String(v));
  });
  it('eachSweptParam finds the FIRST sweepable axis (spec.each + via) for any sentinel word', () => {
    for (const s of ['each', 'every', 'all']) {
      const hit = eachSweptParam(leg, { divisionId: s, status: 'open' });
      assert.deepEqual({ name: hit.name, sweepable: hit.sweepable }, { name: 'divisionId', sweepable: true }, s);
      assert.equal(hit.spec, SPEC);
    }
  });
  it("the exact token 'each' on a spec-less param is UNSWEEPABLE (the honest-refusal shape), but 'all'/'every' there are plain literals", () => {
    const bare = eachSweptParam(leg, { status: 'each' });
    assert.deepEqual({ name: bare.name, sweepable: bare.sweepable }, { name: 'status', sweepable: false });
    assert.equal(eachSweptParam(leg, { status: 'all' }), null, "'all' is a legitimate literal value off-axis");
    assert.equal(eachSweptParam(leg, { status: 'open' }), null);
  });
  it('a spec without each:true never sweeps (tighten by default — the DK-7 opt-in)', () => {
    const noEach = mkLeg({ tool: { resolve: { divisionId: { ...SPEC, each: false } } } });
    const hit = eachSweptParam(noEach, { divisionId: 'each' });
    assert.equal(hit.sweepable, false);
  });
  it('hasEachSentinel is the cheap superset pre-check', () => {
    assert.equal(hasEachSentinel({ divisionId: 'each' }), true);
    assert.equal(hasEachSentinel({ status: 'all' }), true, 'superset by design — eachSweptParam decides');
    assert.equal(hasEachSentinel({ status: 'open' }), false);
    assert.equal(hasEachSentinel(null), false);
  });
});

describe('rideEach — fetchEachState (the via read, one channel)', () => {
  it('plans a param-free GET of the via endpoint through INVOKE_SESSION and returns the value', async () => {
    const { invoke, calls } = mkInvoke({ perItem: () => ({ success: true, value: [] }) });
    const st = await fetchEachState(mkLeg(), SPEC.via, { invoke });
    assert.equal(st.ok, true);
    assert.equal(st.value, STATE);
    assert.equal(calls.via.length, 1);
    assert.equal(calls.via[0].method, 'GET');
    assert.equal(calls.via[0].quiet, undefined, 'the single via read is not a quiet per-item call');
  });
  it('a failed/empty via read reports its error (the transient not-logged-in must ride out)', async () => {
    const { invoke } = mkInvoke({ perItem: () => null, onVia: () => ({ success: false, error: 'not-logged-in' }) });
    assert.deepEqual(await fetchEachState(mkLeg(), SPEC.via, { invoke }), { ok: false, error: 'not-logged-in' });
    const { invoke: inv2 } = mkInvoke({ perItem: () => null, onVia: () => ({ success: true, value: null }) });
    assert.equal((await fetchEachState(mkLeg(), SPEC.via, { invoke: inv2 })).error, 'each-state-unavailable');
  });
});

describe('rideEach — runEachSweep (enumerate → fan → aggregate)', () => {
  it('one invoke per enumerated value, concrete ids + ride-along bindings, quiet:true per item', async () => {
    const { invoke, calls } = mkInvoke({ perItem: (p) => ({ success: true, value: [{ TaskNumber: `T${p.args.divisionId}` }] }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each', status: 'open' }, { invoke });
    assert.equal(r.ok, true);
    assert.equal(calls.via.length, 1, 'ONE via read enumerates the whole sweep');
    assert.deepEqual(calls.items.map((p) => p.args.divisionId).sort((a, b) => a - b), [7, 10, 83]);
    for (const p of calls.items) {
      assert.equal(p.args.status, 'open', 'the non-each binding rides every per-item call');
      assert.equal(p.quiet, true, 'per-item calls are quiet (v1670 — the roll-up speaks for successes)');
    }
    assert.equal(r.each.fixed, 'status=open', 'the tally line names the swept bucket (v1548)');
  });

  it('aggregates group-tagged rows in the EXACT map-seam shape: rowsOf(value) reads it', async () => {
    const { invoke } = mkInvoke({ perItem: (p) => ({ success: true, value: [{ TaskNumber: `T${p.args.divisionId}` }] }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each', status: 'open' }, { invoke });
    assert.deepEqual(r.value.rows[0], { division: 'Raleigh', TaskNumber: 'T7' }, 'noun tag first, from the axis label');
    assert.equal(rowsOf(r.value).length, 3, 'headlessClause.rowsOf accepts the sweep value as prior rows');
    assert.deepEqual(r.value, { rows: r.value.rows, truncated: false, seen: 3 });
    assert.deepEqual({ total: r.each.total, ok: r.each.ok, failed: r.each.failed, noun: r.each.noun }, { total: 3, ok: 3, failed: 0, noun: 'division' });
  });

  it('normalizes envelope replies ({tasks:[…]}) into rows — the strict rowsOf seam would reject them raw', async () => {
    const { invoke } = mkInvoke({ perItem: (p) => ({ success: true, value: { tasks: [{ TaskNumber: `T${p.args.divisionId}` }] } }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke });
    assert.equal(r.ok, true);
    assert.equal(r.value.rows.length, 3);
    assert.equal(r.value.rows[0].TaskNumber, 'T7');
  });

  it('ORDER IS PRESERVED under concurrency: a slow first division still leads the aggregate (slots, not pushes)', async () => {
    const delay = { 7: 25 };
    const { invoke } = mkInvoke({ perItem: async (p) => {
      await new Promise((res) => setTimeout(res, delay[p.args.divisionId] || 0));
      return { success: true, value: [{ T: `T${p.args.divisionId}` }] };
    } });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke, concurrency: 2 });
    assert.deepEqual(r.value.rows.map((row) => row.division), ['Raleigh', 'Atlanta West', 'Seattle']);
  });

  it('a per-value failure counts and continues — partial coverage stays honest, never fatal', async () => {
    const { invoke } = mkInvoke({ perItem: (p) => (p.args.divisionId === 83
      ? { success: false, error: 'http-500' }
      : { success: true, value: [{ T: `T${p.args.divisionId}` }] }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke });
    assert.equal(r.ok, true);
    assert.deepEqual({ ok: r.each.ok, failed: r.each.failed, seen: r.each.seen }, { ok: 2, failed: 1, seen: 2 });
    assert.deepEqual(r.value.rows.map((row) => row.division), ['Raleigh', 'Seattle']);
  });

  it('a THROWING per-value read counts as one failure and never aborts the fan', async () => {
    const { invoke } = mkInvoke({ perItem: (p) => {
      if (p.args.divisionId === 7) throw new Error('boom');
      return { success: true, value: [{ T: 1 }] };
    } });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke });
    assert.equal(r.ok, true);
    assert.deepEqual({ ok: r.each.ok, failed: r.each.failed }, { ok: 2, failed: 1 });
  });

  it('TOTAL failure exits ok:false with the first per-item error (so a not-logged-in sweep stays transient upstream)', async () => {
    const { invoke } = mkInvoke({ perItem: () => ({ success: false, error: 'not-logged-in' }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not-logged-in');
    assert.deepEqual({ ok: r.each.ok, failed: r.each.failed }, { ok: 0, failed: 3 }, 'the stats still ride out for the host exit line');
  });

  it('the row cap travels with the data: truncated + seen ride the value AND the stats (v1874)', async () => {
    const { invoke } = mkInvoke({ perItem: (p) => ({ success: true, value: [{ T: `a${p.args.divisionId}` }, { T: `b${p.args.divisionId}` }] }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke, rowCap: 3 });
    assert.deepEqual({ returned: r.value.rows.length, seen: r.value.seen, truncated: r.value.truncated }, { returned: 3, seen: 6, truncated: true });
    assert.deepEqual({ returned: r.each.returned, seen: r.each.seen, truncated: r.each.truncated, rowCap: r.each.rowCap }, { returned: 3, seen: 6, truncated: true, rowCap: 3 });
  });

  it("v1730 discipline on the ride-alongs: other resolve-marked params drop, a second 'each' token drops, literal 'all' RIDES", async () => {
    const leg = mkLeg({ tool: { resolve: { divisionId: SPEC, regionId: { via: SPEC.via, lists: ['currentHub.Divisions'], id: 'Id', label: 'Name' } } } });
    const { invoke, calls } = mkInvoke({ perItem: () => ({ success: true, value: [] }) });
    const r = await runEachSweep(leg, { divisionId: 'each', regionId: 'north', bogus: 'each', status: 'all' }, { invoke });
    assert.equal(r.ok, true);
    const args = calls.items[0].args;
    assert.equal('regionId' in args, false, 'a resolve-marked ride-along drops (no SW name→id resolution)');
    assert.equal('bogus' in args, false, "a second exact 'each' token drops (one axis per run)");
    assert.equal(args.status, 'all', "'all' off-axis is a literal VALUE and rides untouched");
    assert.equal(typeof args.divisionId, 'number', 'the swept key is filled, never dropped (the map-valueParam hazard)');
  });

  it('onEach fires per completion with (done, total, label) — the host keep-alive seam; a throwing callback is swallowed', async () => {
    const seen = [];
    const { invoke } = mkInvoke({ perItem: () => ({ success: true, value: [] }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke, onEach: (done, total, label) => { seen.push([done, total, label]); throw new Error('host hiccup'); } });
    assert.equal(r.ok, true);
    assert.equal(seen.length, 3);
    assert.deepEqual(seen[seen.length - 1].slice(0, 2), [3, 3]);
    assert.equal(typeof seen[0][2], 'string');
  });

  it('refuses a non-read leg (each-write-refused) without a single invoke', async () => {
    const { invoke, calls } = mkInvoke({ perItem: () => ({ success: true, value: [] }) });
    const r = await runEachSweep(mkLeg({ mode: 'act' }), { divisionId: 'each' }, { invoke });
    assert.deepEqual(r, { ok: false, error: 'each-write-refused' });
    assert.equal(calls.via.length + calls.items.length, 0);
  });

  it('an unenumerable via state fails honestly: fetch error propagates; an EMPTY enumeration is each-enumeration-empty', async () => {
    const { invoke } = mkInvoke({ perItem: () => null, onVia: () => ({ success: false, error: 'not-logged-in' }) });
    const r = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke });
    assert.deepEqual({ ok: r.ok, error: r.error }, { ok: false, error: 'not-logged-in' });
    assert.equal(r.each, undefined, 'no fan ran — no stats, so the host narrates no span');
    const { invoke: inv2 } = mkInvoke({ perItem: () => null, onVia: () => ({ success: true, value: { access: {}, currentHub: {} } }) });
    const r2 = await runEachSweep(mkLeg(), { divisionId: 'each' }, { invoke: inv2 });
    assert.deepEqual({ ok: r2.ok, error: r2.error }, { ok: false, error: 'each-enumeration-empty' });
  });

  it("a sentinel with no sweepable spec is refused (each-not-sweepable), never dropped into a wrong-scope read", async () => {
    const { invoke, calls } = mkInvoke({ perItem: () => ({ success: true, value: [] }) });
    const noSpec = mkLeg({ tool: { resolve: null } });
    const r = await runEachSweep(noSpec, { divisionId: 'each' }, { invoke });
    assert.deepEqual(r, { ok: false, error: 'each-not-sweepable' });
    assert.equal(calls.via.length + calls.items.length, 0);
  });

  it('exports mirror the panel constants (lane budget 8, row cap 200)', () => {
    assert.equal(EACH_CONCURRENCY, 8);
    assert.equal(EACH_ROW_CAP, 200);
  });
});
