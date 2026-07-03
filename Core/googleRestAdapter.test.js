// Core/googleRestAdapter.test.js — v2.74.1318: the GA REST channel for google-calendar (infra/…/googleRest.cjs),
// driven headless with injected fetch — the same pattern as mcpLambdaTransport/lambdaOauth. Google's MCP servers are
// Developer-Preview-gated (consumer accounts can't enroll — findings 2026-07-01); Calendar v3 REST is the GA channel
// the SAME vaulted token authorizes. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import googleRest from '../infra/orchard-dev/lambda/api/googleRest.cjs';
import { specToDocsRequests } from './canvasLower.js';   // GD-2 — the lowering's output must pass the adapter's allowlist (integration)

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

describe('googleRest — google-docs (GD-2: the presentation backend)', () => {
  it('create_document POSTs the title and minimizes the reply', async () => {
    const fetchImpl = fakeFetch({ body: { documentId: 'doc9', title: 'Ticket #1', revisionId: 'r1', body: { content: [] }, extra: 'dropped' } });
    const r = await invokeGoogleRestTool({ server: 'google-docs', tool: 'create_document', args: { title: 'Ticket #1' }, accessToken: 'tok', fetchImpl });
    assert.deepEqual(r, { success: true, value: { documentId: 'doc9', title: 'Ticket #1', revisionId: 'r1' } });
    assert.match(fetchImpl.calls[0].url, /docs\.googleapis\.com\/v1\/documents$/);
    assert.equal((await invokeGoogleRestTool({ server: 'google-docs', tool: 'create_document', args: {}, fetchImpl })).hint, 'title is required');
  });
  it('get_document computes bodyEndIndex from the last structural element (the replace-body parameter)', async () => {
    const fetchImpl = fakeFetch({ body: { documentId: 'doc9', title: 'T', revisionId: 'r2', body: { content: [{ endIndex: 1 }, { endIndex: 87 }] } } });
    const r = await invokeGoogleRestTool({ server: 'google-docs', tool: 'get_document', args: { documentId: 'doc9' }, fetchImpl });
    assert.equal(r.value.bodyEndIndex, 87);
    const empty = await invokeGoogleRestTool({ server: 'google-docs', tool: 'get_document', args: { documentId: 'doc9' }, fetchImpl: fakeFetch({ body: { documentId: 'doc9', body: { content: [] } } }) });
    assert.equal(empty.value.bodyEndIndex, 1);
  });
  it('render_document: canvasLower output PASSES the allowlist end-to-end; a disallowed kind is named + never sent', async () => {
    const spec = { blocks: [
      { id: 'c', kind: 'markdown', text: '## Context\n\nHub **offline**.' },
      { id: 'i', kind: 'image', src: 'https://cdn.x.com/pinhole.png', alt: 'pinhole' },   // GD-7b — insertInlineImage must clear the allowlist
      { id: 'v', kind: 'video', src: 'https://youtu.be/x', label: 'walkthrough' },
      { id: 'd', kind: 'compose', ref: 'r', text: 'Hi **Jane**,\n\n- restart the hub' },
    ] };
    const { requests } = specToDocsRequests(spec, { bodyEndIndex: 50 });
    assert.ok(requests.some((q) => q.insertInlineImage), 'the lowering emits an inline image');
    const fetchImpl = fakeFetch({ body: { documentId: 'doc9', replies: requests.map(() => ({})) } });
    const r = await invokeGoogleRestTool({ server: 'google-docs', tool: 'render_document', args: { documentId: 'doc9', requests }, accessToken: 'tok', fetchImpl });
    assert.equal(r.success, true);
    assert.equal(r.value.applied, requests.length);
    assert.match(fetchImpl.calls[0].url, /doc9:batchUpdate$/);
    const blocked = fakeFetch({ body: {} });
    const bad = await invokeGoogleRestTool({ server: 'google-docs', tool: 'render_document', args: { documentId: 'doc9', requests: [{ replaceAllText: {} }] }, fetchImpl: blocked });
    assert.equal(bad.error, 'tool-error');
    assert.match(bad.hint, /disallowed request kind: replaceAllText/);
    assert.equal(blocked.calls.length, 0, 'a disallowed request never reaches the API');
    // GD-7b — the conduit re-checks the image uri: non-https (or unbounded) never reaches Google
    const evil = await invokeGoogleRestTool({ server: 'google-docs', tool: 'render_document',
      args: { documentId: 'doc9', requests: [{ insertInlineImage: { location: { index: 1 }, uri: 'http://evil.example/x.png' } }] }, fetchImpl: blocked });
    assert.match(evil.hint, /insertInlineImage needs a bounded https uri/);
    assert.equal(blocked.calls.length, 0);
    assert.match((await invokeGoogleRestTool({ server: 'google-docs', tool: 'render_document', args: { documentId: 'doc9', requests: [] }, fetchImpl: blocked })).hint, /render-needs-requests/);
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
