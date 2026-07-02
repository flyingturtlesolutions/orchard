// infra/orchard-dev/lambda/api/mcp.cjs — MP-2b (v2.74.1309). The proxy's MCP TRANSPORT: speak Streamable-HTTP MCP to
// a remote server (initialize → notifications/initialized → tools/call) and normalize the outcome to the §5 proxy
// contract { success, value | error }. CJS because the Lambda handler is CJS; the CANONICAL pure protocol core is
// Core/mcpClient.js (ESM, extension-side) — this file mirrors ONLY the envelope/parse subset the proxy needs, and
// Core/mcpLambdaTransport.test.js holds a PARITY test (envelope-for-envelope vs mcpClient, endpoint-for-endpoint vs
// mcpServers) so any drift turns npm test red instead of rotting silently.
//
// SECURITY: the server→endpoint map lives HERE, server-side. An invoke names a server ID; the client can NEVER supply
// an endpoint URL (that would be an SSRF hole — "please POST my token to attacker.test"). The access token arrives
// from the caller (index.js exchanges the vaulted refresh token) and goes ONLY to the mapped official endpoint.
//
// fetchImpl is injectable so the whole handshake is headless-testable with a scripted fake server. DESIGN §5, §5.2.

'use strict';

const MCP_PROTOCOL_VERSION = '2025-06-18';

// Mirror of Core/mcpServers.js MCP_SERVERS urls (parity-tested). Curated + verified only — no guessed endpoints.
const MCP_ENDPOINTS = {
  'google-calendar': 'https://calendarmcp.googleapis.com/mcp/v1',
  'notion': 'https://mcp.notion.com/mcp',
  'github': 'https://api.githubcopilot.com/mcp/',
  'hubspot': 'https://mcp.hubspot.com',
};

// ── Envelopes (mirrors of Core/mcpClient.js builders — keep in lockstep, the parity test checks) ──
function initializeRequest(id) {
  return { jsonrpc: '2.0', id, method: 'initialize', params: {
    protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'orchard-proxy', version: '1.0.0' } } };
}
function initializedNotification() {
  return { jsonrpc: '2.0', method: 'notifications/initialized' };
}
function toolsCallRequest(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name: String(name || ''), arguments: (args && typeof args === 'object') ? args : {} } };
}
function toolsListRequest(id, cursor) {
  return { jsonrpc: '2.0', id, method: 'tools/list', params: cursor ? { cursor } : {} };
}

// ── Response parse (JSON body OR SSE `data:` frames; prefer the response frame) — mirror of mcpClient ──
function parseRpcBody(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* SSE-framed? */ }
  const frames = [];
  for (const line of s.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m) continue;
    try { frames.push(JSON.parse(m[1])); } catch { /* keepalive */ }
  }
  if (!frames.length) return null;
  const responses = frames.filter((f) => f && (('result' in f) || ('error' in f)));
  return responses.length ? responses[responses.length - 1] : frames[frames.length - 1];
}

// One HTTP round trip. Returns { status, headers:{get}, body } with body already text. Throws only on network error.
async function _post(fetchImpl, endpoint, message, { sessionId, protocolVersion, accessToken, signal }) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
  const res = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(message), signal });
  const body = await res.text();
  return { status: res.status, headers: res.headers, body };
}

/**
 * Invoke ONE tool on a remote MCP server: initialize → initialized → tools/call, normalized to the §5 proxy contract.
 * @param {{ server:string, tool:string, args?:object, accessToken?:string,
 *           fetchImpl?:Function, deadlineMs?:number }} opts
 * @returns {Promise<{ success:true, value:any } | { success:false, error:string, hint?:string }>}
 */
async function invokeMcpTool({ server, tool, args = {}, accessToken = null, fetchImpl = globalThis.fetch, deadlineMs = 20000 } = {}) {
  const endpoint = MCP_ENDPOINTS[String(server || '').trim()];
  if (!endpoint) return { success: false, error: 'unknown-mcp-server', hint: `no curated endpoint for "${server}"` };
  if (!tool) return { success: false, error: 'connector-no-binding' };
  if (typeof fetchImpl !== 'function') return { success: false, error: 'no-fetch' };

  // One shared deadline across the 3 round trips (the Lambda itself has 29s total).
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, deadlineMs));
  const ctx = { sessionId: null, protocolVersion: null, accessToken, signal: ctl.signal };
  try {
    // ① initialize — negotiate; capture the session id header + the server's protocol version.
    const init = await _post(fetchImpl, endpoint, initializeRequest(1), ctx);
    if (init.status === 401 || init.status === 403) return { success: false, error: 'broker-unauthorized', hint: 'token rejected by the MCP server — re-link the connector' };
    const initMsg = parseRpcBody(init.body);
    if (!initMsg || initMsg.error) return { success: false, error: 'mcp-initialize-failed', hint: initMsg && initMsg.error ? String(initMsg.error.message || '') : `http ${init.status}` };
    ctx.sessionId = (init.headers && typeof init.headers.get === 'function' && init.headers.get('mcp-session-id')) || null;
    ctx.protocolVersion = (initMsg.result && initMsg.result.protocolVersion) || MCP_PROTOCOL_VERSION;

    // ② notifications/initialized — required before any request; no response expected.
    await _post(fetchImpl, endpoint, initializedNotification(), ctx);

    // ③ tools/call → normalize. A TOOL failure rides result.isError (still success:false to the caller).
    const call = await _post(fetchImpl, endpoint, toolsCallRequest(2, tool, args), ctx);
    if (call.status === 401 || call.status === 403) return { success: false, error: 'broker-unauthorized', hint: 're-link the connector' };
    const msg = parseRpcBody(call.body);
    if (!msg) return { success: false, error: 'mcp-bad-response', hint: `http ${call.status}` };
    if (msg.error) return { success: false, error: 'mcp-rpc-error', hint: String(msg.error.message || msg.error.code || '') };
    const r = msg.result || {};
    const content = Array.isArray(r.content) ? r.content : [];
    const text = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
    if (r.isError === true) return { success: false, error: 'tool-error', hint: text.slice(0, 500) };
    return { success: true, value: (r.structuredContent && typeof r.structuredContent === 'object') ? r.structuredContent : (text || content) };
  } catch (e) {
    const aborted = ctl.signal.aborted;
    return { success: false, error: aborted ? 'mcp-timeout' : 'mcp-network-error', hint: aborted ? `deadline ${deadlineMs}ms` : String((e && e.message) || '') };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * MP-2c — DISCOVER a server's tools: initialize → initialized → tools/list. Returns the RAW MCP tool descriptors
 * (name · description · inputSchema · annotations) — exactly what Core/connectorLeg.mcpToolToLeg consumes — so the
 * palette can carry the server's OWN schemas instead of a hand-transcribed seed. First page only (a cursor beyond
 * ~page-1 is a pathological server for our curated set; noted, not followed).
 * @param {{ server:string, accessToken?:string, fetchImpl?:Function, deadlineMs?:number }} opts
 * @returns {Promise<{ success:true, tools:Array } | { success:false, error:string, hint?:string }>}
 */
async function listMcpTools({ server, accessToken = null, fetchImpl = globalThis.fetch, deadlineMs = 15000 } = {}) {
  const endpoint = MCP_ENDPOINTS[String(server || '').trim()];
  if (!endpoint) return { success: false, error: 'unknown-mcp-server', hint: `no curated endpoint for "${server}"` };
  if (typeof fetchImpl !== 'function') return { success: false, error: 'no-fetch' };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, deadlineMs));
  const ctx = { sessionId: null, protocolVersion: null, accessToken, signal: ctl.signal };
  try {
    const init = await _post(fetchImpl, endpoint, initializeRequest(1), ctx);
    if (init.status === 401 || init.status === 403) return { success: false, error: 'broker-unauthorized', hint: 're-link the connector' };
    const initMsg = parseRpcBody(init.body);
    if (!initMsg || initMsg.error) return { success: false, error: 'mcp-initialize-failed', hint: initMsg && initMsg.error ? String(initMsg.error.message || '') : `http ${init.status}` };
    ctx.sessionId = (init.headers && typeof init.headers.get === 'function' && init.headers.get('mcp-session-id')) || null;
    ctx.protocolVersion = (initMsg.result && initMsg.result.protocolVersion) || MCP_PROTOCOL_VERSION;
    await _post(fetchImpl, endpoint, initializedNotification(), ctx);
    const list = await _post(fetchImpl, endpoint, toolsListRequest(2), ctx);
    const msg = parseRpcBody(list.body);
    if (!msg) return { success: false, error: 'mcp-bad-response', hint: `http ${list.status}` };
    if (msg.error) return { success: false, error: 'mcp-rpc-error', hint: String(msg.error.message || msg.error.code || '') };
    const tools = (msg.result && Array.isArray(msg.result.tools)) ? msg.result.tools.filter((t) => t && typeof t === 'object' && t.name) : [];
    return { success: true, tools };
  } catch (e) {
    const aborted = ctl.signal.aborted;
    return { success: false, error: aborted ? 'mcp-timeout' : 'mcp-network-error', hint: aborted ? `deadline ${deadlineMs}ms` : String((e && e.message) || '') };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  MCP_ENDPOINTS,
  initializeRequest,
  initializedNotification,
  toolsCallRequest,
  toolsListRequest,
  parseRpcBody,
  invokeMcpTool,
  listMcpTools,
};
