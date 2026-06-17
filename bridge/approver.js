#!/usr/bin/env node
'use strict';
// bridge/approver.js — minimal MCP stdio server exposing `approval_prompt` for claude's
// --permission-prompt-tool (DB-3 permission relay spike, v2.74.1001). Claude calls this tool whenever
// the agent wants a tool that is NOT pre-allowed; the tool returns an allow/deny decision. For the spike
// the decision is env-driven (APPROVER_MODE=allow|deny); the real relay will instead forward the request
// to the host → panel and block for the user's click.
//
// MCP stdio transport: newline-delimited JSON-RPC 2.0 on stdin/stdout. Diagnostics → stderr only.
const fs = require('fs');
const path = require('path');
const TOOL = 'approval_prompt';
const BRIDGE_DIR = path.resolve(__dirname, '..', 'logs', 'bridge');
const MODE_FILE = path.join(BRIDGE_DIR, '_approver_mode.txt');     // spike control: 'allow' | 'deny'
const LOG_FILE = path.join(BRIDGE_DIR, '_approver.log');
// Mode read at CALL time (not startup) — a file, since claude's mcp-config env did not reach the server.
function readMode() {
  try { return fs.readFileSync(MODE_FILE, 'utf8').trim().toLowerCase() || 'allow'; } catch { return (process.env.APPROVER_MODE || 'allow').toLowerCase(); }
}
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
function err(line) { try { process.stderr.write(`[approver] ${line}\n`); } catch { /* */ } try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`); } catch { /* */ } }

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});

function handle(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    err('initialize');
    send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'orchard-approver', version: '1.0.0' } } });
  } else if (method === 'notifications/initialized') {
    // notification — no response
  } else if (method === 'tools/list') {
    err('tools/list');
    send({ jsonrpc: '2.0', id, result: { tools: [{
      name: TOOL,
      description: 'Approve or deny a tool call (dev-bridge HITL).',
      inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' } }, required: ['tool_name', 'input'] },
    }] } });
  } else if (method === 'tools/call') {
    const args = (params && params.arguments) || {};
    const mode = readMode();
    err(`approval_prompt called: tool=${args.tool_name} mode=${mode}`);
    const decision = mode === 'deny'
      ? { behavior: 'deny', message: 'denied by dev-bridge approver (spike)' }
      : { behavior: 'allow', updatedInput: args.input || {} };
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(decision) }] } });
  } else if (id != null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
}
err('up');
