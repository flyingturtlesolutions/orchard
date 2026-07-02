// Core/mcpLambdaTransport.test.js — MP-2b (v2.74.1309): the proxy's CJS MCP transport (infra/…/lambda/api/mcp.cjs),
// driven headless with a scripted fake server, PLUS the PARITY lock against the canonical ESM core (Core/mcpClient.js
// envelopes, Core/mcpServers.js endpoints). The lambda file is a deliberate CJS mirror (no build step to share ESM
// into the Lambda asset) — this test is what keeps the mirror honest: drift turns npm test red. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import lambdaMcp from '../infra/orchard-dev/lambda/api/mcp.cjs';
import { MCP_PROTOCOL_VERSION, initializeRequest, initializedNotification, toolsCallRequest, toolsListRequest } from './mcpClient.js';
import { MCP_SERVERS } from './mcpServers.js';

const { invokeMcpTool, MCP_ENDPOINTS, parseRpcBody } = lambdaMcp;

// A scripted fake MCP server: each expected call pops one reply; every request is recorded for assertions.
function fakeFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script.shift();
    if (!step) throw new Error('fake-fetch: no more scripted replies');
    const headers = new Map(Object.entries(step.headers || {}));
    return { status: step.status ?? 200, headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null }, text: async () => step.body ?? '' };
  };
  fn.calls = calls;
  return fn;
}

describe('mcp.cjs — invokeMcpTool (full handshake, scripted server)', () => {
  it('initialize → initialized → tools/call: threads session id + negotiated version + bearer; normalizes the result', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, headers: { 'mcp-session-id': 'sess-9' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'cal' } } }) },
      { status: 202, body: '' },   // notifications/initialized — no response body
      { status: 200, body: 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"p":1}}\n\ndata: {"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"created"}],"structuredContent":{"eventId":"e42"}}}\n\n' },
    ]);
    const r = await invokeMcpTool({ server: 'google-calendar', tool: 'create_event', args: { summary: 'Lunch' }, accessToken: 'tok-1', fetchImpl });
    assert.deepEqual(r, { success: true, value: { eventId: 'e42' } });   // structuredContent preferred over text

    assert.equal(fetchImpl.calls.length, 3);
    const [init, inited, call] = fetchImpl.calls;
    assert.equal(init.url, 'https://calendarmcp.googleapis.com/mcp/v1');           // endpoint from the SERVER-SIDE map
    assert.equal(init.init.headers.authorization, 'Bearer tok-1');
    assert.match(init.init.headers.accept, /text\/event-stream/);
    assert.equal(JSON.parse(init.init.body).method, 'initialize');
    assert.equal(JSON.parse(inited.init.body).method, 'notifications/initialized');
    assert.equal(inited.init.headers['mcp-session-id'], 'sess-9');                  // session threaded after initialize
    assert.equal(call.init.headers['mcp-session-id'], 'sess-9');
    assert.equal(call.init.headers['mcp-protocol-version'], '2025-03-26');          // NEGOTIATED version, not ours
    assert.deepEqual(JSON.parse(call.init.body).params, { name: 'create_event', arguments: { summary: 'Lunch' } });
  });

  it('a TOOL failure (result.isError) → success:false tool-error with the text as hint', async () => {
    const fetchImpl = fakeFetch([
      { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: MCP_PROTOCOL_VERSION } }) },
      { status: 202, body: '' },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [{ type: 'text', text: 'invalid start time' }] } }) },
    ]);
    const r = await invokeMcpTool({ server: 'notion', tool: 'create_page', fetchImpl });
    assert.equal(r.success, false);
    assert.equal(r.error, 'tool-error');
    assert.match(r.hint, /invalid start time/);
  });

  it('401 from the server → broker-unauthorized (re-link), at initialize AND at call', async () => {
    const r1 = await invokeMcpTool({ server: 'github', tool: 'x', fetchImpl: fakeFetch([{ status: 401, body: '' }]) });
    assert.equal(r1.error, 'broker-unauthorized');
    const r2 = await invokeMcpTool({ server: 'github', tool: 'x', fetchImpl: fakeFetch([
      { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }, { status: 202, body: '' }, { status: 403, body: '' },
    ]) });
    assert.equal(r2.error, 'broker-unauthorized');
  });

  it('a JSON-RPC protocol error at call → mcp-rpc-error with the message', async () => {
    const r = await invokeMcpTool({ server: 'hubspot', tool: 'nope', fetchImpl: fakeFetch([
      { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }, { status: 202, body: '' },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'Unknown tool' } }) },
    ]) });
    assert.equal(r.error, 'mcp-rpc-error');
    assert.match(r.hint, /Unknown tool/);
  });

  it('an unknown server id → unknown-mcp-server and NO network call (the anti-SSRF map is authoritative)', async () => {
    const fetchImpl = fakeFetch([]);
    const r = await invokeMcpTool({ server: 'evil', tool: 'x', fetchImpl });
    assert.equal(r.error, 'unknown-mcp-server');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('deadline abort → mcp-timeout (a hung server cannot eat the Lambda)', async () => {
    const hang = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const r = await invokeMcpTool({ server: 'notion', tool: 'x', fetchImpl: hang, deadlineMs: 1000 });
    assert.equal(r.error, 'mcp-timeout');
  });

  it('network throw → mcp-network-error (never an unhandled rejection)', async () => {
    const r = await invokeMcpTool({ server: 'notion', tool: 'x', fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(r.error, 'mcp-network-error');
    assert.match(r.hint, /ECONNREFUSED/);
  });
});

describe('mcp.cjs — listMcpTools (MP-2c live discovery)', () => {
  it('initialize → initialized → tools/list, returns the RAW descriptors mcpToolToLeg consumes', async () => {
    const fetchImpl = fakeFetch([
      { status: 200, headers: { 'mcp-session-id': 'sess-2' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-03-26' } }) },
      { status: 202, body: '' },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [
        { name: 'create_page', description: 'Create a page', inputSchema: { type: 'object', properties: { title: { type: 'string' } } }, annotations: {} },
        { description: 'junk — no name' },
      ] } }) },
    ]);
    const r = await lambdaMcp.listMcpTools({ server: 'notion', accessToken: 'tok', fetchImpl });
    assert.equal(r.success, true);
    assert.equal(r.tools.length, 1);                                          // junk dropped
    assert.ok(r.tools[0].name && r.tools[0].inputSchema && ('annotations' in r.tools[0]));
    assert.equal(JSON.parse(fetchImpl.calls[2].init.body).method, 'tools/list');
    assert.equal(fetchImpl.calls[2].init.headers['mcp-session-id'], 'sess-2');   // session threaded
  });
  it('401 → broker-unauthorized; rpc error → mcp-rpc-error; unknown server → no fetch', async () => {
    assert.equal((await lambdaMcp.listMcpTools({ server: 'github', fetchImpl: fakeFetch([{ status: 401, body: '' }]) })).error, 'broker-unauthorized');
    assert.equal((await lambdaMcp.listMcpTools({ server: 'hubspot', fetchImpl: fakeFetch([
      { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) }, { status: 202, body: '' },
      { body: JSON.stringify({ jsonrpc: '2.0', id: 2, error: { code: -32601, message: 'nope' } }) },
    ]) })).error, 'mcp-rpc-error');
    const f = fakeFetch([]);
    assert.equal((await lambdaMcp.listMcpTools({ server: 'evil', fetchImpl: f })).error, 'unknown-mcp-server');
    assert.equal(f.calls.length, 0);
  });
});

describe('mcp.cjs × Core — the PARITY lock (drift turns this red)', () => {
  it('v1319: tools/list envelope matches the canonical builder', () => {
    assert.deepEqual(lambdaMcp.toolsListRequest(2), toolsListRequest({}, 2));
  });

  it('protocol version matches the canonical core', () => {
    assert.equal(lambdaMcp.MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSION);
  });
  it('envelopes are byte-identical to Core/mcpClient.js builders (same inputs, same ids)', () => {
    assert.deepEqual(lambdaMcp.initializeRequest(1),
      initializeRequest({ clientName: 'orchard-proxy', clientVersion: '1.0.0' }, 1));
    assert.deepEqual(lambdaMcp.initializedNotification(), initializedNotification());
    assert.deepEqual(lambdaMcp.toolsCallRequest(2, 'create_event', { summary: 'x' }),
      toolsCallRequest({ name: 'create_event', args: { summary: 'x' } }, 2));
  });
  it('endpoints are exactly Core/mcpServers.js MCP_SERVERS (same ids, same urls, both directions)', () => {
    assert.deepEqual(Object.keys(MCP_ENDPOINTS).sort(), Object.keys(MCP_SERVERS).sort());
    for (const [id, url] of Object.entries(MCP_ENDPOINTS)) assert.equal(url, MCP_SERVERS[id].url, id);
  });
  it('SSE parsing agrees with the canonical parser shape (response frame preferred over progress)', () => {
    const sse = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":3,"result":{"ok":1}}\n\n';
    assert.deepEqual(parseRpcBody(sse), { jsonrpc: '2.0', id: 3, result: { ok: 1 } });
  });
});
