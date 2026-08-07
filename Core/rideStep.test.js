// Core/rideStep.test.js — CD-1a: the shared pinned-ride/nav step primitive (§9.4). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runRideStep, rideStepResolvable, findRecipeByCapId, stampWriteAuthority } from './rideStep.js';

// a valid session-ride READ recipe: recipeToLeg needs id+app+endpoint+origin; armable needs enabled+accepted.
const READ = { id: 'cap-1', app: 'zendesk', origin: 'https://x.zendesk.com', endpoint: '/api/tickets', method: 'GET', enabled: true, reviewState: 'accepted', safetyClass: 'auto', name: 'read tickets' };
const WRITE = { ...READ, id: 'cap-w', write: true, method: 'POST', safetyClass: 'gated', name: 'create ticket' };

const readClause = { text: 'read tickets', pinned: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1' } };
const writeClause = { text: 'create ticket', pinned: { kind: 'ride', capabilityId: 'cap-w', groundId: 'g-1' } };

const recipesFor = (list) => async () => list;
const okInvoke = (value) => async () => ({ success: true, value });
const parkReporter = { gate: async () => 'park' };
const approveReporter = { gate: async () => true };

describe('rideStep — runRideStep', () => {
  it('a nav step is a no-op success', async () => {
    assert.deepEqual(await runRideStep({ text: 'go to x', pinned: { kind: 'navigate' } }, {}), { ok: true, value: null });
    assert.deepEqual(await runRideStep({ text: 'navigate to x.com' }, {}), { ok: true, value: null });
  });
  it('an unpinned (no ground/cap) step fails cleanly', async () => {
    assert.deepEqual(await runRideStep({ text: 'x', pinned: { kind: 'ride' } }, { readRecipes: recipesFor([]) }), { ok: false, error: 'unpinned-step' });
  });
  it('a pinned recipe that no longer exists → recipe-gone', async () => {
    assert.deepEqual(await runRideStep(readClause, { readRecipes: recipesFor([]) }), { ok: false, error: 'recipe-gone' });
  });
  it('a recipe that is not armable → not-armed', async () => {
    const disabled = { ...READ, enabled: false };
    assert.deepEqual(await runRideStep(readClause, { readRecipes: recipesFor([disabled]) }), { ok: false, error: 'not-armed' });
  });
  it('a pinned READ resolves → leg → invoke → ok+value', async () => {
    let sawPayload = null;
    const invoke = async (payload) => { sawPayload = payload; return { success: true, value: [1, 2, 3] }; };
    const r = await runRideStep(readClause, { readRecipes: recipesFor([READ]), invoke });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, [1, 2, 3]);
    assert.equal(sawPayload.endpoint, '/api/tickets', 'the INVOKE_SESSION payload carried the recipe endpoint');
    assert.equal(sawPayload.confirmed, undefined, 'a read carries no write authority (v2044 — no blanket stamp)');
    assert.equal(sawPayload.gateCleared, undefined);
  });
  it('v2037 — a legacy leg.key pin still resolves on the SW path', async () => {
    const legacy = { text: 'read', pinned: { kind: 'connector', capabilityId: 'me.zendesk.cap-1@x.zendesk.com', groundId: 'g-1' } };
    const r = await runRideStep(legacy, { readRecipes: recipesFor([READ]), invoke: okInvoke([9]) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, [9]);
  });
  it('v1730 — banked bindings reach the headless payload, LITERAL-SAFE: resolve-marked params drop', async () => {
    let sawPayload = null;
    const invoke = async (payload) => { sawPayload = payload; return { success: true, value: [] }; };
    const boundClause = { text: 'read tasks', pinned: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1', bindings: { status: 'open' } } };
    await runRideStep(boundClause, { readRecipes: recipesFor([READ]), invoke });
    assert.equal(sawPayload.args.status, 'open', 'a literal binding rides');
    const RESOLVING = { ...READ, id: 'cap-r', resolve: { marketId: '/State' } };
    const rClause = { text: 'x', pinned: { kind: 'ride', capabilityId: 'cap-r', groundId: 'g-1', bindings: { marketId: 'Greensboro', status: 'new' } } };
    await runRideStep(rClause, { readRecipes: recipesFor([RESOLVING]), invoke });
    assert.equal('marketId' in sawPayload.args, false, 'a resolve-marked param drops');
    assert.equal(sawPayload.args.status, 'new');
  });
  it('an invoke failure surfaces as ok:false + error (+ status when the reply carried one)', async () => {
    const r = await runRideStep(readClause, { readRecipes: recipesFor([READ]), invoke: async () => ({ success: false, error: 'http-500', status: 500 }) });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'http-500');
    assert.equal(r.status, 500);
  });
  it('a WRITE parks when the gate says park (SW), never invoking', async () => {
    let invoked = false;
    const r = await runRideStep(writeClause, { readRecipes: recipesFor([WRITE]), invoke: async () => { invoked = true; return { success: true }; }, reporter: parkReporter, runId: 'run_1' });
    assert.deepEqual(r, { park: true, parkedRunId: 'run_1' });
    assert.equal(invoked, false, 'the write never fired');
  });
  it('a WRITE proceeds when the gate approves (the resume path) — and the payload carries the authority the belt demands (v2044)', async () => {
    let sawPayload = null;
    // a belt-FAITHFUL fake (background/handlers/connector.js INVOKE_SESSION): a non-GET without an authority
    // stamp is refused. The pre-2044 fake accepted anything, which is exactly how the dropped approval hid —
    // live, every approved resume died `write-needs-confirm` and re-parked.
    const beltInvoke = async (payload) => {
      sawPayload = payload;
      const isWrite = payload.method !== 'GET' && payload.method !== 'HEAD';
      if (isWrite && payload.confirmed !== true && payload.gateCleared !== true) return { success: false, error: 'write-needs-confirm' };
      return { success: true, value: 'created' };
    };
    const r = await runRideStep(writeClause, { readRecipes: recipesFor([WRITE]), invoke: beltInvoke, reporter: approveReporter });
    assert.equal(r.ok, true, `the approved write cleared the belt (got ${(r && r.error) || 'ok'})`);
    assert.equal(sawPayload.confirmed, true, "the human's approval rode as confirmed");
    assert.equal(sawPayload.gateCleared, undefined, 'a person approved it — it must not also read machine-cleared');
  });
  it('NO reporter ⇒ a write parks (fail safe — nobody watching)', async () => {
    const r = await runRideStep(writeClause, { readRecipes: recipesFor([WRITE]), invoke: async () => ({ success: true }), runId: 'run_x' });
    assert.deepEqual(r, { park: true, parkedRunId: 'run_x' });
  });
});

// ── v2.74.2047 — the SW-side EACH sweep: an each-swept READ fans out instead of dropping the sentinel ────────────
describe('rideStep — the each-swept READ sweeps headless (v2047)', () => {
  const SPEC = { via: '/api/State', defaultPath: 'access.Default.Id', lists: ['divs'], match: ['Name'], id: 'Id', label: 'Name', each: true };
  const SWEEPABLE = { ...READ, id: 'cap-e', endpoint: '/api/tasks/{divisionId}/{status}', resolve: { divisionId: SPEC }, name: 'tasks by division' };
  const eachClause = { text: 'read every division', pinned: { kind: 'ride', capabilityId: 'cap-e', groundId: 'g-1', bindings: { divisionId: 'each', status: 'open' } } };
  const state = { divs: [{ Id: 1, Name: 'A' }, { Id: 2, Name: 'B' }] };
  const mkSweepInvoke = (items) => async (payload) => {
    if (payload.endpoint === '/api/State') return { success: true, value: state };
    items.push(payload.args);
    return { success: true, value: [{ TaskNumber: `T${payload.args.divisionId}` }] };
  };

  it('sweeps instead of dropping: one invoke per enumerated value, concrete ids + the ride-along binding', async () => {
    const items = [];
    const r = await runRideStep(eachClause, { readRecipes: recipesFor([SWEEPABLE]), invoke: mkSweepInvoke(items) });
    assert.equal(r.ok, true, `swept (got ${(r && r.error) || 'ok'})`);
    assert.deepEqual(items.map((a) => a.divisionId).sort(), [1, 2], 'the sentinel became the enumerated ids (pre-2047 it was DROPPED)');
    assert.equal(items[0].status, 'open', 'the non-each binding rides along');
    assert.deepEqual(r.value.rows, [{ division: 'A', TaskNumber: 'T1' }, { division: 'B', TaskNumber: 'T2' }], 'group-tagged, order-preserved');
    assert.deepEqual({ ok: r.each.ok, failed: r.each.failed, total: r.each.total }, { ok: 2, failed: 0, total: 2 }, 'stats ride out for the host lines');
    assert.equal(Array.isArray(r.value.rows) && r.value.seen === 2, true, 'the map-seam shape: {rows, truncated, seen}');
  });

  it('onEach threads through to the sweep (the cadence marker keep-alive seam)', async () => {
    const beats = [];
    const r = await runRideStep(eachClause, { readRecipes: recipesFor([SWEEPABLE]), invoke: mkSweepInvoke([]), onEach: (done, total) => beats.push([done, total]) });
    assert.equal(r.ok, true);
    assert.equal(beats.length, 2);
    assert.deepEqual(beats[beats.length - 1], [2, 2]);
  });

  it("'each' banked on a param with no resolve+each spec fails honestly — never dropped into a default-scope read", async () => {
    let invoked = 0;
    const bound = { text: 'x', pinned: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1', bindings: { divisionId: 'each', status: 'open' } } };
    const r = await runRideStep(bound, { readRecipes: recipesFor([READ]), invoke: async () => { invoked++; return { success: true, value: [] }; } });
    assert.deepEqual(r, { ok: false, error: 'each-not-sweepable' });
    assert.equal(invoked, 0, 'no call spent on a pin the SW cannot enumerate');
  });

  it("an off-axis literal 'all' is a VALUE, not an axis — it rides through the normal invoke untouched", async () => {
    let sawPayload = null;
    const bound = { text: 'x', pinned: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1', bindings: { status: 'all' } } };
    const r = await runRideStep(bound, { readRecipes: recipesFor([READ]), invoke: async (p) => { sawPayload = p; return { success: true, value: [] }; } });
    assert.equal(r.ok, true);
    assert.equal(sawPayload.args.status, 'all');
  });

  it("a WRITE with an 'each' binding still parks — the sweep never runs an unattended write", async () => {
    let invoked = 0;
    const wClause = { text: 'w', pinned: { kind: 'ride', capabilityId: 'cap-w', groundId: 'g-1', bindings: { divisionId: 'each' } } };
    const r = await runRideStep(wClause, { readRecipes: recipesFor([WRITE]), invoke: async () => { invoked++; return { success: true }; }, runId: 'run_9' });
    assert.deepEqual(r, { park: true, parkedRunId: 'run_9' });
    assert.equal(invoked, 0);
  });

  it('a total sweep failure surfaces the per-item error (transient not-logged-in reaches the disarm logic)', async () => {
    const invoke = async (payload) => (payload.endpoint === '/api/State'
      ? { success: true, value: state }
      : { success: false, error: 'not-logged-in' });
    const r = await runRideStep(eachClause, { readRecipes: recipesFor([SWEEPABLE]), invoke });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not-logged-in');
    assert.deepEqual({ ok: r.each.ok, failed: r.each.failed }, { ok: 0, failed: 2 });
  });

  it('rideStepResolvable agrees with the runner: a sweepable pin resolves, a spec-less sentinel is DRIFT (v2047)', async () => {
    assert.equal(await rideStepResolvable(eachClause, { readRecipes: recipesFor([SWEEPABLE]) }), true);
    const specless = { text: 'x', pinned: { kind: 'ride', capabilityId: 'cap-1', groundId: 'g-1', bindings: { divisionId: 'each' } } };
    assert.equal(await rideStepResolvable(specless, { readRecipes: recipesFor([READ]) }), false,
      'the runner would answer each-not-sweepable — the plan check must stop BEFORE the prefix re-executes');
  });
});

describe('rideStep — findRecipeByCapId (bare id + legacy leg.key)', () => {
  it('matches bare recipe id and me.app.id@host pins', () => {
    assert.equal(findRecipeByCapId([READ], 'cap-1').id, 'cap-1');
    assert.equal(findRecipeByCapId([READ], 'me.zendesk.cap-1@x.zendesk.com').id, 'cap-1');
    assert.equal(findRecipeByCapId([READ], 'missing'), null);
  });
});

describe('rideStep — rideStepResolvable (the drift check)', () => {
  it('a nav / loose step is always resolvable', async () => {
    assert.equal(await rideStepResolvable({ pinned: { kind: 'navigate' } }, {}), true);
    assert.equal(await rideStepResolvable({ text: 'plain step' }, {}), true);
  });
  it('a pinned step resolves only when its recipe reads back armable', async () => {
    assert.equal(await rideStepResolvable(readClause, { readRecipes: recipesFor([READ]) }), true);
    assert.equal(await rideStepResolvable(readClause, { readRecipes: recipesFor([]) }), false);       // gone
    assert.equal(await rideStepResolvable(readClause, { readRecipes: recipesFor([{ ...READ, enabled: false }]) }), false); // disabled
  });
  it('a KIND-ONLY pin (fieldRead/branch/map — no leg) resolves; a leg pin that lost its ground does not (v1717 — mirrors _wfReplayPlan)', async () => {
    assert.equal(await rideStepResolvable({ pinned: { kind: 'fieldRead', field: 'instructions' } }, {}), true);
    assert.equal(await rideStepResolvable({ pinned: { kind: 'ride' } }, { readRecipes: recipesFor([READ]) }), true, 'no capabilityId → nothing to drift');
    assert.equal(await rideStepResolvable({ pinned: { kind: 'ride', capabilityId: 'cap-1' } }, { readRecipes: recipesFor([READ]) }), false, 'a leg pin without its ground IS drift');
  });
});

// ── v2.74.2045 — hop-2 parity: a SEEDED record (recipeFromCatalogEntry stores no `app`) must project. ────────────
describe('rideStep — seeded-record projection (the SW no-leg class)', () => {
  // the exact shape recipeFromCatalogEntry banks: id/origin/endpoint/method + curated provenance — and NO `app`.
  const SEEDED = { id: 'vs_tasks', origin: 'vendorsuite.example.com', endpoint: '/api/tasks', method: 'GET', enabled: true, reviewState: 'accepted', safetyClass: 'auto', provenance: 'curated', name: 'warranty tasks' };
  const seededClause = { text: 'read tasks', pinned: { kind: 'connector', capabilityId: 'vs_tasks', groundId: 'g-9' } };

  it('a seeded record (no app) projects and invokes — the parity the live no-leg broke', async () => {
    let sawPayload = null;
    const r = await runRideStep(seededClause, { readRecipes: recipesFor([SEEDED]), invoke: async (p) => { sawPayload = p; return { success: true, value: [1] }; } });
    assert.equal(r.ok, true, `projected + invoked (got ${(r && r.error) || 'ok'})`);
    assert.equal(sawPayload.endpoint, '/api/tasks');
  });
  it('rideStepResolvable agrees with the runner: projectable → true, unprojectable → false', async () => {
    assert.equal(await rideStepResolvable(seededClause, { readRecipes: recipesFor([SEEDED]) }), true);
    const noEndpoint = { ...SEEDED, endpoint: '' };
    assert.equal(await rideStepResolvable(seededClause, { readRecipes: recipesFor([noEndpoint]) }), false, 'armable but unprojectable IS drift — the runner would fail no-leg');
  });
});

// ── v2.74.2043 — write authority. The ONE place a payload can gain permission to write. ───────────────────────────
describe('stampWriteAuthority — fail closed, one authority, never both', () => {
  const base = { endpoint: '/x.json', method: 'POST' };

  it('stamps NOTHING without an authority — the belt then refuses (the pre-2043 behaviour, preserved)', () => {
    for (const a of [undefined, {}, { gate: null }, { gate: {} }, { humanApproved: false }]) {
      const p = stampWriteAuthority(base, a);
      assert.equal(p.confirmed, undefined, JSON.stringify(a));
      assert.equal(p.gateCleared, undefined, JSON.stringify(a));
    }
  });

  it("stamps gateCleared for the literal verdict 'auto', and for nothing else", () => {
    assert.equal(stampWriteAuthority(base, { gate: { decision: 'auto' } }).gateCleared, true);
    for (const decision of ['queued', 'refused', 'AUTO', 'auto ', '', null, undefined, true, 1]) {
      const p = stampWriteAuthority(base, { gate: { decision } });
      assert.equal(p.gateCleared, undefined, `decision ${JSON.stringify(decision)} must not clear a write`);
    }
  });

  it('a human approval stamps confirmed, never gateCleared — the audit trail keeps them apart', () => {
    const p = stampWriteAuthority(base, { humanApproved: true, gate: { decision: 'auto' } });
    assert.equal(p.confirmed, true);
    assert.equal(p.gateCleared, undefined, 'a person approved it; it must not also read as machine-cleared');
  });

  it('only `true` is a human approval (no truthy coercion)', () => {
    for (const v of ['yes', 1, {}, [], 'true']) {
      assert.equal(stampWriteAuthority(base, { humanApproved: v }).confirmed, undefined, JSON.stringify(v));
    }
  });

  it('STRIPS authority already present on the incoming payload — it cannot be smuggled in', () => {
    const dirty = { ...base, confirmed: true, gateCleared: true };
    const p = stampWriteAuthority(dirty, {});
    assert.equal(p.confirmed, undefined, 'a pre-set confirmed must not survive an unauthorized stamp');
    assert.equal(p.gateCleared, undefined);
  });

  it('never mutates the caller’s payload and carries every other field through', () => {
    const src = { ...base, groundId: 'g1', recipeId: 'r1', body: { a: 1 } };
    const p = stampWriteAuthority(src, { gate: { decision: 'auto' } });
    assert.equal(src.gateCleared, undefined, 'the plan payload is untouched');
    assert.equal(p.groundId, 'g1');
    assert.equal(p.recipeId, 'r1');
    assert.deepEqual(p.body, { a: 1 });
  });
});

// ── v2.74.2055 — required params gate the headless invoke (the approved line-items-less POST class) ──────────────
describe('rideStep — required params gate the invoke (v2055)', () => {
  it('a missing/empty required param refuses `needs-<param>` before any network', async () => {
    const REQ = { ...READ, id: 'cap-q', params: [{ name: 'line_items', type: 'array', required: true }, { name: 'note', type: 'string' }] };
    let invoked = 0;
    const io = { readRecipes: recipesFor([REQ]), invoke: async () => { invoked++; return { success: true, value: [] }; } };
    const clause = (bindings) => ({ text: 'q', pinned: { kind: 'ride', capabilityId: 'cap-q', groundId: 'g-1', bindings } });
    assert.deepEqual(await runRideStep(clause({}), io), { ok: false, error: 'needs-line_items' });
    assert.deepEqual(await runRideStep(clause({ line_items: [] }), io), { ok: false, error: 'needs-line_items' });
    assert.equal(invoked, 0, 'no call spent');
    const r = await runRideStep(clause({ line_items: [{ variantId: 'gid://shopify/ProductVariant/1', quantity: 1 }] }), io);
    assert.equal(r.ok, true, 'a filled required passes');
  });
});
