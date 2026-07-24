// Core/rideStep.test.js — CD-1a: the shared pinned-ride/nav step primitive (§9.4). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runRideStep, rideStepResolvable } from './rideStep.js';

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
  it('a WRITE proceeds when the gate approves (the resume path), invoking', async () => {
    let invoked = false;
    const r = await runRideStep(writeClause, { readRecipes: recipesFor([WRITE]), invoke: async () => { invoked = true; return { success: true, value: 'created' }; }, reporter: approveReporter });
    assert.equal(r.ok, true);
    assert.equal(invoked, true, 'the approved write fired');
  });
  it('NO reporter ⇒ a write parks (fail safe — nobody watching)', async () => {
    const r = await runRideStep(writeClause, { readRecipes: recipesFor([WRITE]), invoke: async () => ({ success: true }), runId: 'run_x' });
    assert.deepEqual(r, { park: true, parkedRunId: 'run_x' });
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
