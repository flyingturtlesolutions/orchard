// bridge/mcpProposeSplit.test.js — DBR-P3-3b unit tests for the inert propose_split MCP server's PURE dispatcher.
// ESM (the harness loader force-loads .js as ESM); default-imports the CommonJS module (like gitOps.test.js).
// PURE — no spawning, no stdio. The claude↔server stdio handshake is live-only by nature.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import mcp from './mcpProposeSplit.cjs';
const { handleRpc, TOOL, ACK, PROTOCOL_VERSION } = mcp;

describe('mcpProposeSplit — initialize handshake', () => {
  it('echoes the client protocolVersion + declares the tools capability and serverInfo', () => {
    const r = handleRpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude', version: 'x' } } });
    assert.equal(r.id, 0);                                  // id 0 is a real id, not a notification
    assert.equal(r.result.protocolVersion, '2025-06-18');  // echo what the client asked for
    assert.ok(r.result.capabilities && r.result.capabilities.tools);
    assert.equal(r.result.serverInfo.name, 'devbridge');
  });
  it('falls back to its own protocolVersion when the client omits one', () => {
    const r = handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    assert.equal(r.result.protocolVersion, PROTOCOL_VERSION);
  });
  it('treats the initialized notification as no-reply', () => {
    assert.equal(handleRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });
});

describe('mcpProposeSplit — tools/list', () => {
  it('lists exactly propose_split with concern required', () => {
    const r = handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.equal(r.result.tools.length, 1);
    assert.equal(r.result.tools[0].name, 'propose_split');
    assert.deepEqual(r.result.tools[0].inputSchema.required, ['concern']);
    assert.equal(r.result.tools[0], TOOL);
  });
});

describe('mcpProposeSplit — tools/call is INERT (acknowledge only)', () => {
  it('returns the static ack for propose_split (no mutation, isError false)', () => {
    const r = handleRpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'propose_split', arguments: { concern: 'extract X' } } });
    assert.equal(r.result.isError, false);
    assert.equal(r.result.content[0].type, 'text');
    assert.equal(r.result.content[0].text, ACK);
  });
  it('rejects an unknown tool name', () => {
    const r = handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf', arguments: {} } });
    assert.equal(r.error.code, -32602);
  });
});

describe('mcpProposeSplit — protocol housekeeping', () => {
  it('answers ping (with id) and ignores junk / notifications', () => {
    assert.deepEqual(handleRpc({ jsonrpc: '2.0', id: 5, method: 'ping' }).result, {});
    assert.equal(handleRpc({ jsonrpc: '2.0', method: 'ping' }), null);     // ping as a notification → no reply
    assert.equal(handleRpc(null), null);
    assert.equal(handleRpc('garbage'), null);
  });
  it('errors a request with an unknown method, but stays silent for a notification', () => {
    assert.equal(handleRpc({ jsonrpc: '2.0', id: 6, method: 'resources/list' }).error.code, -32601);
    assert.equal(handleRpc({ jsonrpc: '2.0', method: 'resources/list' }), null);
  });
});
