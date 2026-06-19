// Core/execPlan.test.js — IL-2 the runTool dispatch table (node --test).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planExec, toObservation } from './execPlan.js';

const pageLeg = (key) => ({ key, domain: 'page', source: 'learned', mode: 'act' });
const browserLeg = (key, mode = 'act') => ({ key, domain: 'browser', source: 'builtin', mode });

describe('planExec — leg → dispatch plan (pure §4.2)', () => {
  it('page learned capability → REPLAY_SG_CAPABILITY, busy-marked, with ground+tab in the payload', () => {
    const plan = planExec(pageLeg('cap_x'), { q: 'cats' }, { tabId: 7, groundId: 'g1' });
    assert.equal(plan.ok, true);
    assert.equal(plan.channel, 'REPLAY_SG_CAPABILITY');
    assert.equal(plan.busyMark, true);                 // Invariant #2 — page legs busy-mark
    assert.equal(plan.payload.capabilityId, 'cap_x');
    assert.equal(plan.payload.groundId, 'g1');
    assert.equal(plan.payload.tabId, 7);
    assert.equal(plan.payload.paramValues.q, 'cats');
  });

  it('page leg WITHOUT a ground/tab → not dispatchable (needs-ground-tab)', () => {
    assert.equal(planExec(pageLeg('cap_x'), {}, {}).ok, false);
    assert.equal(planExec(pageLeg('cap_x'), {}, { tabId: 7 }).reason, 'needs-ground-tab');   // ground missing
  });

  it('OPEN_URL → OPEN_URL_NEW_TAB, NOT busy-marked (chrome.tabs, not synthetic DOM)', () => {
    const plan = planExec(browserLeg('OPEN_URL'), { url: 'https://pixabay.com' }, {});
    assert.equal(plan.ok, true);
    assert.equal(plan.channel, 'OPEN_URL_NEW_TAB');
    assert.equal(plan.busyMark, false);
    assert.equal(plan.payload.url, 'https://pixabay.com');
  });

  it('OPEN_URL with no/invalid url → not dispatchable', () => {
    assert.equal(planExec(browserLeg('OPEN_URL'), { url: 'not-a-url' }, {}).ok, false);
    assert.equal(planExec(browserLeg('OPEN_URL'), {}, {}).reason, 'open-url-needs-url');
  });

  it('FOCUS_TAB falls back to ctx.tabId; fails with no tab anywhere', () => {
    assert.equal(planExec(browserLeg('FOCUS_TAB'), {}, { tabId: 4 }).payload.tabId, 4);
    assert.equal(planExec(browserLeg('FOCUS_TAB'), { tabId: 9 }, { tabId: 4 }).payload.tabId, 9);  // explicit wins
    assert.equal(planExec(browserLeg('FOCUS_TAB'), {}, {}).ok, false);
  });

  it('LIST_TABS → ask mode, not busy-marked', () => {
    const plan = planExec(browserLeg('LIST_TABS', 'ask'), {}, {});
    assert.equal(plan.ok, true); assert.equal(plan.mode, 'ask'); assert.equal(plan.busyMark, false);
  });

  it('self leg → introspection channel, not busy-marked, ask mode', () => {
    const plan = planExec({ key: 'RUN_STATUS', domain: 'self', mode: 'ask' }, {}, {});
    assert.equal(plan.ok, true); assert.equal(plan.busyMark, false); assert.equal(plan.mode, 'ask');
  });

  it('connector → not dispatchable (greenfield); unknown ops fail gracefully', () => {
    assert.equal(planExec({ key: 'X', domain: 'connector' }, {}, {}).reason, 'connector-greenfield');
    assert.equal(planExec({ key: 'NOPE', domain: 'browser' }, {}, {}).reason, 'unknown-browser-op');
    assert.equal(planExec(null, {}, {}).ok, false);
  });
});

describe('toObservation — executor reply → uniform Observation (pure)', () => {
  it('success reply → ok with value (value|result|extracted)', () => {
    assert.equal(toObservation({ success: true, value: 42 }).value, 42);
    assert.equal(toObservation({ result: 'r' }).value, 'r');
    assert.equal(toObservation({ extracted: ['a'] }).value[0], 'a');
  });
  it('carries a scope delta + verdict through', () => {
    const o = toObservation({ success: true, scope: { foo: 'bar' }, verdict: { pass: true } });
    assert.equal(o.scope.foo, 'bar'); assert.equal(o.verdict.pass, true);
  });
  it('failure → ok:false with a structuredFailure envelope (#1, lets the brain re-engage)', () => {
    const o = toObservation({ success: false, error: 'selector drift' }, { channel: 'REPLAY_SG_CAPABILITY' });
    assert.equal(o.ok, false);
    assert.equal(o.structuredFailure.where, 'REPLAY_SG_CAPABILITY');
    assert.equal(o.structuredFailure.reason, 'selector drift');
  });
  it('no reply → ok:false, never throws', () => {
    assert.equal(toObservation(null).ok, false);
    assert.equal(toObservation(undefined, { channel: 'X' }).structuredFailure.where, 'X');
  });
});
