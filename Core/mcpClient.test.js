// Core/mcpClient.test.js — MP-1 (v2.74.1307): the pure MCP client core (JSON-RPC envelopes + parsers + HTTP
// descriptor + OAuth-discovery seed). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MCP_PROTOCOL_VERSION, rpcRequest, rpcNotification, initializeRequest, initializedNotification,
  toolsListRequest, toolsCallRequest, parseRpcResponse, parseToolsList, parseToolCall,
  httpRequestDescriptor, parseAuthChallenge, wellKnownUrls,
} from './mcpClient.js';

describe('mcpClient — JSON-RPC envelopes', () => {
  it('rpcRequest has jsonrpc, id, method, optional params', () => {
    assert.deepEqual(rpcRequest('ping', undefined, 7), { jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepEqual(rpcRequest('m', { a: 1 }, 8), { jsonrpc: '2.0', id: 8, method: 'm', params: { a: 1 } });
  });
  it('rpcNotification has NO id', () => {
    const n = rpcNotification('notifications/initialized');
    assert.equal(n.method, 'notifications/initialized');
    assert.ok(!('id' in n));
  });
  it('initializeRequest carries protocolVersion + clientInfo + capabilities', () => {
    const r = initializeRequest({ clientName: 'orchard', clientVersion: '2.0' }, 1);
    assert.equal(r.method, 'initialize');
    assert.equal(r.params.protocolVersion, MCP_PROTOCOL_VERSION);
    assert.deepEqual(r.params.clientInfo, { name: 'orchard', version: '2.0' });
    assert.deepEqual(r.params.capabilities, {});
  });
  it('initializedNotification is a bare notification', () => {
    assert.deepEqual(initializedNotification(), { jsonrpc: '2.0', method: 'notifications/initialized' });
  });
  it('toolsListRequest omits cursor when absent, includes it when present', () => {
    assert.deepEqual(toolsListRequest({}, 2).params, {});
    assert.deepEqual(toolsListRequest({ cursor: 'abc' }, 3).params, { cursor: 'abc' });
  });
  it('toolsCallRequest uses `arguments` (MCP field) + defaults to {}', () => {
    const r = toolsCallRequest({ name: 'create_event', args: { summary: 'x' } }, 4);
    assert.equal(r.method, 'tools/call');
    assert.deepEqual(r.params, { name: 'create_event', arguments: { summary: 'x' } });
    assert.deepEqual(toolsCallRequest({ name: 'list_events' }, 5).params.arguments, {});
  });
});

describe('mcpClient — parseRpcResponse (json + SSE + errors)', () => {
  it('parses a plain JSON object or string result', () => {
    assert.deepEqual(parseRpcResponse({ jsonrpc: '2.0', id: 1, result: { ok: 1 } }), { ok: true, id: 1, result: { ok: 1 } });
    assert.deepEqual(parseRpcResponse('{"jsonrpc":"2.0","id":2,"result":{"v":9}}'), { ok: true, id: 2, result: { v: 9 } });
  });
  it('parses an SSE `data:` framed response, preferring the response frame over progress notifications', () => {
    const sse = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"p":0.5}}\n\n'
              + 'data: {"jsonrpc":"2.0","id":3,"result":{"done":true}}\n\n';
    assert.deepEqual(parseRpcResponse(sse), { ok: true, id: 3, result: { done: true } });
  });
  it('surfaces a JSON-RPC protocol error', () => {
    const r = parseRpcResponse({ jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'Method not found' } });
    assert.equal(r.ok, false);
    assert.equal(r.error.code, -32601);
    assert.match(r.error.message, /not found/i);
  });
  it('unparseable input → a parse-error envelope, never a throw', () => {
    assert.equal(parseRpcResponse('not json at all').ok, false);
    assert.equal(parseRpcResponse('').error.code, -32700);
  });
});

describe('mcpClient — tools/list + tools/call parsing', () => {
  it('parseToolsList extracts named tools + nextCursor, drops junk', () => {
    const { tools, nextCursor } = parseToolsList({
      tools: [{ name: 'list_events', inputSchema: {} }, { description: 'no name' }, null],
      nextCursor: 'pg2',
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'list_events');
    assert.equal(nextCursor, 'pg2');
  });
  it('parseToolsList → tools feed straight into leg projection (raw MCP descriptor shape preserved)', () => {
    const { tools } = parseToolsList({ tools: [{ name: 'create_event', description: 'Create', inputSchema: { type: 'object', properties: { summary: {} } }, annotations: {} }] });
    assert.ok(tools[0].name && tools[0].inputSchema && ('annotations' in tools[0]));   // the exact shape mcpToolToLeg consumes
  });
  it('parseToolCall flattens text content + reports success', () => {
    const r = parseToolCall({ content: [{ type: 'text', text: 'created event 42' }] });
    assert.equal(r.isError, false);
    assert.equal(r.text, 'created event 42');
  });
  it('parseToolCall reports a TOOL error via isError (not a protocol error)', () => {
    const r = parseToolCall({ isError: true, content: [{ type: 'text', text: 'invalid time' }] });
    assert.equal(r.isError, true);
    assert.equal(r.text, 'invalid time');
  });
  it('parseToolCall carries structuredContent when present', () => {
    assert.deepEqual(parseToolCall({ structuredContent: { id: 42 } }).structured, { id: 42 });
  });
});

describe('mcpClient — httpRequestDescriptor', () => {
  it('advertises json+SSE, POSTs the message, threads session/version/token', () => {
    const d = httpRequestDescriptor({
      endpoint: 'https://calendarmcp.googleapis.com/mcp/v1',
      message: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      sessionId: 'sess-1', protocolVersion: '2025-06-18', accessToken: 'tok',
    });
    assert.equal(d.method, 'POST');
    assert.equal(d.url, 'https://calendarmcp.googleapis.com/mcp/v1');
    assert.match(d.headers.accept, /application\/json/);
    assert.match(d.headers.accept, /text\/event-stream/);
    assert.equal(d.headers['mcp-session-id'], 'sess-1');
    assert.equal(d.headers['mcp-protocol-version'], '2025-06-18');
    assert.equal(d.headers.authorization, 'Bearer tok');
    assert.equal(JSON.parse(d.body).method, 'tools/list');
  });
  it('omits session/version/auth headers when not provided', () => {
    const d = httpRequestDescriptor({ endpoint: 'https://x.test/mcp', message: {} });
    assert.ok(!('mcp-session-id' in d.headers));
    assert.ok(!('authorization' in d.headers));
  });
});

describe('mcpClient — OAuth discovery seed', () => {
  it('parses a Bearer challenge with a resource_metadata pointer (RFC 9728)', () => {
    const c = parseAuthChallenge('Bearer realm="mcp", error="invalid_token", resource_metadata="https://x.test/.well-known/oauth-protected-resource"');
    assert.equal(c.scheme, 'Bearer');
    assert.equal(c.error, 'invalid_token');
    assert.equal(c.resourceMetadata, 'https://x.test/.well-known/oauth-protected-resource');
  });
  it('empty challenge → null', () => {
    assert.equal(parseAuthChallenge(''), null);
  });
  it('wellKnownUrls builds RFC 9728/8414 URLs from the origin; bad URL → null', () => {
    const w = wellKnownUrls('https://mcp.notion.com/mcp');
    assert.equal(w.protectedResource, 'https://mcp.notion.com/.well-known/oauth-protected-resource');
    assert.equal(w.authorizationServer, 'https://mcp.notion.com/.well-known/oauth-authorization-server');
    assert.equal(wellKnownUrls('not-a-url'), null);
  });
});
