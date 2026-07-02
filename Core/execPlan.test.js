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

  it('stamps the capability NAME on the plan (so the HITL confirm names it, not a uuid) — v2.74.1115', () => {
    const plan = planExec({ key: 'cap_x', name: 'Search for media content', domain: 'page', source: 'learned', mode: 'act' }, { q: 'x' }, { tabId: 7, groundId: 'g' });
    assert.equal(plan.name, 'Search for media content');
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

  it('connector with no binding → not dispatchable; unknown ops fail gracefully', () => {
    assert.equal(planExec({ key: 'X', domain: 'connector' }, {}, {}).reason, 'connector-no-binding');
    assert.equal(planExec({ key: 'NOPE', domain: 'browser' }, {}, {}).reason, 'unknown-browser-op');
    assert.equal(planExec(null, {}, {}).ok, false);
  });

  it('session-ride connector → INVOKE_SESSION, not busy-marked, carries origin+endpoint+args (CX-2 §7)', () => {
    const leg = { key: 'acme.zendesk.read_ticket', domain: 'connector', source: 'builtin', mode: 'ask',
                  tool: { impl: 'session', account: 'acme', origin: 'acme.zendesk.com', endpoint: '/api/v2/tickets/{id}.json', method: 'GET' } };
    const plan = planExec(leg, { id: 12345 }, {});
    assert.equal(plan.ok, true);
    assert.equal(plan.channel, 'INVOKE_SESSION');
    assert.equal(plan.busyMark, false);                 // drives no tab → Invariant #2 N/A
    assert.equal(plan.payload.origin, 'acme.zendesk.com');
    assert.equal(plan.payload.endpoint, '/api/v2/tickets/{id}.json');
    assert.equal(plan.payload.method, 'GET');
    assert.equal(plan.payload.account, 'acme');         // CX-7 — threads the expected account for the wrong-account guard
    assert.equal(plan.payload.args.id, 12345);
  });

  it('session-ride WRITE → INVOKE_SESSION carries the body TEMPLATE + non-GET method (CX-6a; reads send body:null)', () => {
    const write = { key: 'me.zendesk.update_ticket_status', domain: 'connector', source: 'builtin', mode: 'act',
                    tool: { impl: 'session', appHost: 'zendesk.com', endpoint: '/api/v2/tickets/{id}.json', method: 'PUT',
                            body: { ticket: { status: '{status}' } } } };
    const plan = planExec(write, { id: 7, status: 'solved' }, {});
    assert.equal(plan.channel, 'INVOKE_SESSION');
    assert.equal(plan.busyMark, false);                                 // a connector drives no tab (Invariant #2 N/A)
    assert.equal(plan.payload.method, 'PUT');
    assert.deepEqual(plan.payload.body, { ticket: { status: '{status}' } });   // template passed through; the executor fillBody()s it
    // a GET read carries no body
    const read = { key: 'me.zendesk.read_ticket', domain: 'connector', source: 'builtin', mode: 'ask',
                   tool: { impl: 'session', appHost: 'zendesk.com', endpoint: '/api/v2/tickets/{id}.json', method: 'GET' } };
    assert.equal(planExec(read, { id: 7 }, {}).payload.body, null);
  });

  it('session-ride with no recipe binding → not dispatchable', () => {
    assert.equal(planExec({ key: 'x', domain: 'connector', tool: { impl: 'session' } }, {}, {}).reason, 'session-no-recipe');
  });

  it('oauth/MCP connector → INVOKE_CONNECTOR, not busy-marked, carries server+tool+args (CX-2 §7)', () => {
    const leg = { key: 'acme.zendesk.get_ticket', domain: 'connector', source: 'builtin', mode: 'ask',
                  tool: { impl: 'oauth', server: 'zendesk', name: 'get_ticket' } };
    const plan = planExec(leg, { ticket_id: 12345 }, {});
    assert.equal(plan.ok, true);
    assert.equal(plan.channel, 'INVOKE_CONNECTOR');
    assert.equal(plan.busyMark, false);
    assert.equal(plan.payload.server, 'zendesk');
    assert.equal(plan.payload.tool, 'get_ticket');
    assert.equal(plan.payload.args.ticket_id, 12345);
    assert.equal(plan.payload.write, false);   // CX-5b — a read (mode 'ask') carries write:false
  });

  it('CX-5b: an oauth WRITE (mode act) carries write:true so the handler can fail-close', () => {
    const leg = { key: 'me.google-calendar.create_event', domain: 'connector', source: 'builtin', mode: 'act',
                  tool: { impl: 'oauth', server: 'google-calendar', name: 'create_event' } };
    const plan = planExec(leg, { summary: 'Lunch' }, {});
    assert.equal(plan.channel, 'INVOKE_CONNECTOR');
    assert.equal(plan.payload.write, true);
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
  it('failure → ok:false with a structuredFailure envelope (#1, lets Orchard re-engage)', () => {
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
