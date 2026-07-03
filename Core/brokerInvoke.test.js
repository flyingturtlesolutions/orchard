// Core/brokerInvoke.test.js — CX-5b (v2.74.1306): the pure broker-invoke gate + cloud-reply normalizer. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { brokerInvokeGate, brokerReplyFromCloud } from './brokerInvoke.js';

describe('brokerInvokeGate — fail-closed write belt (§9)', () => {
  it('rejects a payload with no server/tool binding', () => {
    assert.equal(brokerInvokeGate({}).error, 'connector-no-binding');
    assert.equal(brokerInvokeGate({ server: 'google-calendar' }).error, 'connector-no-binding');
    assert.equal(brokerInvokeGate({ tool: 'list_events' }).error, 'connector-no-binding');
  });

  it('lets a READ through without confirmation', () => {
    const g = brokerInvokeGate({ server: 'google-calendar', tool: 'list_events', args: { calendarId: 'primary' }, write: false });
    assert.equal(g.ok, true);
    assert.equal(g.write, false);
    assert.deepEqual(g.request, { server: 'google-calendar', tool: 'list_events', args: { calendarId: 'primary' }, confirmed: false });
  });

  it('BLOCKS a write with no confirmation → write-needs-confirm', () => {
    const g = brokerInvokeGate({ server: 'google-calendar', tool: 'create_event', args: { summary: 'x' }, write: true });
    assert.equal(g.ok, false);
    assert.equal(g.error, 'write-needs-confirm');
  });

  it('ALLOWS a write only with explicit confirmed:true', () => {
    const g = brokerInvokeGate({ server: 'google-calendar', tool: 'create_event', args: { summary: 'x' }, write: true, confirmed: true });
    assert.equal(g.ok, true);
    assert.equal(g.write, true);
    assert.equal(g.request.confirmed, true);
  });

  it('confirmed must be strictly true (a truthy value does not open the gate)', () => {
    assert.equal(brokerInvokeGate({ server: 's', tool: 't', write: true, confirmed: 'yes' }).error, 'write-needs-confirm');
    assert.equal(brokerInvokeGate({ server: 's', tool: 't', write: true, confirmed: 1 }).error, 'write-needs-confirm');
  });

  it('defaults args to an empty object + trims the binding', () => {
    const g = brokerInvokeGate({ server: '  google-gmail ', tool: ' list_messages ' });
    assert.equal(g.ok, true);
    assert.equal(g.request.server, 'google-gmail');
    assert.equal(g.request.tool, 'list_messages');
    assert.deepEqual(g.request.args, {});
  });
});

describe('brokerReplyFromCloud — normalize the proxy response / error', () => {
  it('404 / 501 → broker-unavailable (proxy not provisioned yet — honest, not "broken")', () => {
    assert.equal(brokerReplyFromCloud({ err: { status: 404, message: 'Not Found' } }).error, 'broker-unavailable');
    assert.equal(brokerReplyFromCloud({ err: { status: 501 } }).error, 'broker-unavailable');
  });

  it('403 thrown-path reads err.body → write-needs-confirm (not broker-unauthorized)', () => {
    const r = brokerReplyFromCloud({ err: { status: 403, message: 'Forbidden', body: { error: 'write-needs-confirm', hint: 'confirm the action first' } } });
    assert.equal(r.error, 'write-needs-confirm');
    assert.equal(r.hint, 'confirm the action first');
  });

  it('409 thrown-path carries err.body hint', () => {
    const r = brokerReplyFromCloud({ err: { status: 409, body: { error: 'connector-not-linked', hint: 'link google first' } } });
    assert.equal(r.error, 'connector-not-linked');
    assert.equal(r.hint, 'link google first');
  });

  it('401 / 403 without err.body → broker-unauthorized (link the connector first)', () => {
    assert.equal(brokerReplyFromCloud({ err: { status: 401 } }).error, 'broker-unauthorized');
    assert.equal(brokerReplyFromCloud({ err: { status: 403 } }).error, 'broker-unauthorized');
  });

  it('a generic error passes its message through', () => {
    assert.equal(brokerReplyFromCloud({ err: { status: 500, message: 'boom' } }).error, 'boom');
    assert.equal(brokerReplyFromCloud({ err: {} }).error, 'broker-failed');
  });

  it('a successful proxy reply passes value through', () => {
    const r = brokerReplyFromCloud({ resp: { success: true, value: { items: [1, 2] } } });
    assert.equal(r.success, true);
    assert.deepEqual(r.value, { items: [1, 2] });
  });

  it('a proxy-level failure ({success:false} or {error}) becomes a structured failure', () => {
    assert.equal(brokerReplyFromCloud({ resp: { success: false, error: 'tool-threw' } }).success, false);
    assert.equal(brokerReplyFromCloud({ resp: { error: 'bad-args' } }).error, 'bad-args');
  });

  it('v1314: the proxy failure HINT survives the hop (the tool names its own error — never strip it)', () => {
    const r = brokerReplyFromCloud({ resp: { success: false, error: 'tool-error', hint: 'PERMISSION_DENIED: Calendar API not enabled' } });
    assert.equal(r.error, 'tool-error');
    assert.equal(r.hint, 'PERMISSION_DENIED: Calendar API not enabled');
    assert.ok(!('hint' in brokerReplyFromCloud({ resp: { error: 'x' } })), 'no hint → no empty key');
  });

  it('a bare value (no envelope) is treated as the value', () => {
    assert.deepEqual(brokerReplyFromCloud({ resp: [1, 2, 3] }).value, [1, 2, 3]);
  });
});
