// Core/googleRestAdapter.test.js — v2.74.1318: the GA REST channel for google-calendar (infra/…/googleRest.cjs),
// driven headless with injected fetch — the same pattern as mcpLambdaTransport/lambdaOauth. Google's MCP servers are
// Developer-Preview-gated (consumer accounts can't enroll — findings 2026-07-01); Calendar v3 REST is the GA channel
// the SAME vaulted token authorizes. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import googleRest from '../infra/orchard-dev/lambda/api/googleRest.cjs';

const { invokeGoogleRestTool } = googleRest;

function fakeFetch(reply) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return { status: reply.status ?? 200, ok: (reply.status ?? 200) < 300, text: async () => (reply.body != null ? JSON.stringify(reply.body) : '') };
  };
  fn.calls = calls;
  return fn;
}

describe('googleRest — create_event (the thesis write, via GA REST)', () => {
  it('maps args to the v3 event resource: naive dateTime rides WITH timeZone; attendees map to {email}', async () => {
    const fetchImpl = fakeFetch({ body: { id: 'e42', status: 'confirmed', summary: 'Test', htmlLink: 'https://cal/x', start: {}, end: {}, attendees: [{}], extraNoise: 'dropped' } });
    const r = await invokeGoogleRestTool({
      server: 'google-calendar', tool: 'create_event', accessToken: 'tok',
      args: { summary: 'Test', startTime: '2026-07-03T15:00:00', endTime: '2026-07-03T16:00:00', timeZone: 'America/Chicago', attendeeEmails: ['a@b.c'] },
      fetchImpl,
    });
    assert.equal(r.success, true);
    assert.equal(r.value.id, 'e42');
    assert.ok(!('extraNoise' in r.value), 'reply is minimized, never the raw resource');
    const call = fetchImpl.calls[0];
    assert.match(call.url, /\/calendars\/primary\/events$/);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.authorization, 'Bearer tok');
    const body = JSON.parse(call.init.body);
    assert.deepEqual(body.start, { dateTime: '2026-07-03T15:00:00', timeZone: 'America/Chicago' });
    assert.deepEqual(body.end, { dateTime: '2026-07-03T16:00:00', timeZone: 'America/Chicago' });
    assert.deepEqual(body.attendees, [{ email: 'a@b.c' }]);
  });
  it('allDay → date (YYYY-MM-DD) resource, not dateTime', async () => {
    const fetchImpl = fakeFetch({ body: { id: 'e1' } });
    await invokeGoogleRestTool({ server: 'google-calendar', tool: 'create_event', args: { summary: 'x', startTime: '2026-07-03T00:00:00', endTime: '2026-07-04T00:00:00', allDay: true }, fetchImpl });
    const body = JSON.parse(fetchImpl.calls[0].init.body);
    assert.deepEqual(body.start, { date: '2026-07-03' });
    assert.deepEqual(body.end, { date: '2026-07-04' });
  });
});

describe('googleRest — list_events (the read)', () => {
  it('maps startTime/endTime→timeMin/timeMax (naive gets Z), pageSize→maxResults, fullText→q; minimizes items', async () => {
    const fetchImpl = fakeFetch({ body: { items: [{ id: 'a', summary: 's', start: {}, end: {}, htmlLink: 'h', status: 'confirmed', creator: { email: 'dropped' } }] } });
    const r = await invokeGoogleRestTool({
      server: 'google-calendar', tool: 'list_events', accessToken: 'tok',
      args: { startTime: '2026-07-03T00:00:00', endTime: '2026-07-04T00:00:00Z', pageSize: 10, fullText: 'standup' },
      fetchImpl,
    });
    assert.equal(r.success, true);
    assert.equal(r.value.count, 1);
    assert.ok(!('creator' in r.value.events[0]), 'items minimized');
    const u = new URL(fetchImpl.calls[0].url);
    assert.equal(u.searchParams.get('timeMin'), '2026-07-03T00:00:00Z');   // naive → Z appended
    assert.equal(u.searchParams.get('timeMax'), '2026-07-04T00:00:00Z');   // offset kept as-is
    assert.equal(u.searchParams.get('maxResults'), '10');
    assert.equal(u.searchParams.get('q'), 'standup');
    assert.equal(u.searchParams.get('singleEvents'), 'true');
  });
});

describe('googleRest — update/delete + failure shapes', () => {
  it('update PATCHes the event; delete 204 → {deleted:true}; missing eventId is a named tool-error', async () => {
    const fetchImpl = fakeFetch({ body: { id: 'e9' } });
    await invokeGoogleRestTool({ server: 'google-calendar', tool: 'update_event', args: { eventId: 'e9', summary: 'new' }, fetchImpl });
    assert.equal(fetchImpl.calls[0].init.method, 'PATCH');
    assert.match(fetchImpl.calls[0].url, /\/events\/e9$/);
    const del = await invokeGoogleRestTool({ server: 'google-calendar', tool: 'delete_event', args: { eventId: 'e9' }, fetchImpl: fakeFetch({ status: 204 }) });
    assert.deepEqual(del, { success: true, value: { deleted: true } });
    assert.equal((await invokeGoogleRestTool({ server: 'google-calendar', tool: 'delete_event', args: {}, fetchImpl })).hint, 'eventId is required');
  });
  it('the API error message SURVIVES as the hint (the hint lesson, enforced here too)', async () => {
    const r = await invokeGoogleRestTool({ server: 'google-calendar', tool: 'create_event', args: { summary: 'x' },
      fetchImpl: fakeFetch({ status: 400, body: { error: { message: 'Missing end time.' } } }) });
    assert.equal(r.error, 'tool-error');
    assert.equal(r.hint, 'Missing end time.');
  });
  it('401/403 → broker-unauthorized; unknown tool/server named honestly; network throw contained', async () => {
    assert.equal((await invokeGoogleRestTool({ server: 'google-calendar', tool: 'list_events', fetchImpl: fakeFetch({ status: 403, body: { error: { message: 'insufficient scope' } } }) })).error, 'broker-unauthorized');
    assert.equal((await invokeGoogleRestTool({ server: 'google-calendar', tool: 'nope', fetchImpl: fakeFetch({}) })).error, 'unknown-tool');
    assert.equal((await invokeGoogleRestTool({ server: 'google-gmail', tool: 'x', fetchImpl: fakeFetch({}) })).error, 'unknown-rest-server');
    assert.equal((await invokeGoogleRestTool({ server: 'google-calendar', tool: 'list_events', fetchImpl: async () => { throw new Error('net'); } })).error, 'rest-network-error');
  });
});
