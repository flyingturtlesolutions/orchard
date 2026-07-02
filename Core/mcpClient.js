// Core/mcpClient.js — MP-1 (v2.74.1307). The PURE, model-agnostic MCP client core: JSON-RPC 2.0 envelopes + response
// parsers for the Streamable-HTTP transport (initialize · tools/list · tools/call), the request DESCRIPTOR the impure
// caller fetches, and the 401 OAuth-discovery seed. No network / chrome / storage — the backend Lambda (or any caller)
// does the actual fetch and threads what this returns. DESIGN_connectors.md §5, §5.2.
//
// This is the ONE code path for EVERY remote MCP server (Google Calendar, Notion, GitHub, Slack, …): they all speak
// the same protocol, so a tool from any of them projects through connectorLeg.mcpToolToLeg into the same OfferedLeg.
// Curated-MCP (§5.2) needs this directly; per the 2026-07-01 coverage research, official remote MCP spans the API-first
// SaaS (Google `calendarmcp.googleapis.com/mcp/v1`, `mcp.notion.com/mcp`, GitHub, Slack, Stripe, HubSpot, Linear, …),
// while the tail with no hosted server (Zendesk/Deako) stays on session-ride.
//
// @module Core/mcpClient

// The protocol version this client PROPOSES at initialize. The server may negotiate a DIFFERENT one in its response
// (result.protocolVersion) — the caller threads THAT back on later requests. Date-versioned per the MCP spec.
export const MCP_PROTOCOL_VERSION = '2025-06-18';

let _autoId = 0;
const _nextId = () => (++_autoId);

// ── JSON-RPC 2.0 envelopes (pure builders) ───────────────────────────────────────────────
/** A JSON-RPC request (has an id → expects a response). */
export function rpcRequest(method, params = undefined, id = _nextId()) {
  const msg = { jsonrpc: '2.0', id, method };
  if (params !== undefined) msg.params = params;
  return msg;
}
/** A JSON-RPC notification (NO id → no response; e.g. notifications/initialized). */
export function rpcNotification(method, params = undefined) {
  const msg = { jsonrpc: '2.0', method };
  if (params !== undefined) msg.params = params;
  return msg;
}

/** initialize — the handshake: negotiate protocol version + advertise client capabilities. */
export function initializeRequest({ clientName = 'orchard', clientVersion = '1.0.0', protocolVersion = MCP_PROTOCOL_VERSION, capabilities = {} } = {}, id = _nextId()) {
  return rpcRequest('initialize', {
    protocolVersion,
    capabilities: (capabilities && typeof capabilities === 'object') ? capabilities : {},
    clientInfo: { name: clientName, version: clientVersion },
  }, id);
}
/** The notification the client MUST send after a successful initialize, before any other request. */
export function initializedNotification() {
  return rpcNotification('notifications/initialized');
}
/** tools/list — discover the server's tools (paginated via cursor). */
export function toolsListRequest({ cursor = undefined } = {}, id = _nextId()) {
  return rpcRequest('tools/list', cursor ? { cursor } : {}, id);
}
/** tools/call — invoke one tool with arguments. */
export function toolsCallRequest({ name, args = {} } = {}, id = _nextId()) {
  return rpcRequest('tools/call', { name: String(name || ''), arguments: (args && typeof args === 'object') ? args : {} }, id);
}

// ── Response parsing (Streamable HTTP: a plain JSON body OR an SSE `data:` frame) ──────────
function _extractJsonMessage(raw) {
  if (raw && typeof raw === 'object') return raw;
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* not plain JSON → maybe SSE-framed */ }
  const frames = [];
  for (const line of s.split(/\r?\n/)) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (!m) continue;
    try { frames.push(JSON.parse(m[1])); } catch { /* skip a non-JSON keepalive */ }
  }
  if (!frames.length) return null;
  // SSE may interleave progress notifications before the response — prefer the frame that IS the response.
  const responses = frames.filter((f) => f && (('result' in f) || ('error' in f)));
  return responses.length ? responses[responses.length - 1] : frames[frames.length - 1];
}

/**
 * Normalize a JSON-RPC response (object, JSON string, or SSE body) → { ok, id, result?, error? }. A JSON-RPC
 * PROTOCOL error (bad method / invalid params) lands in `error`; a TOOL error is NOT here — it rides result.isError
 * (see parseToolCall). PURE.
 */
export function parseRpcResponse(raw) {
  const msg = _extractJsonMessage(raw);
  if (!msg || typeof msg !== 'object') return { ok: false, id: null, error: { code: -32700, message: 'parse-error' } };
  if (msg.error) return { ok: false, id: msg.id ?? null, error: { code: msg.error.code ?? -1, message: String(msg.error.message || 'rpc-error'), data: msg.error.data } };
  return { ok: true, id: msg.id ?? null, result: msg.result ?? null };
}

/** Extract { tools, nextCursor } from a tools/list result. Tools are raw MCP descriptors → feed mcpToolToLeg. PURE. */
export function parseToolsList(result) {
  const r = (result && typeof result === 'object') ? result : {};
  const tools = Array.isArray(r.tools) ? r.tools.filter((t) => t && typeof t === 'object' && t.name) : [];
  return { tools, nextCursor: (typeof r.nextCursor === 'string' && r.nextCursor) ? r.nextCursor : null };
}

/**
 * Interpret a tools/call result. The MCP tool-error convention: result.isError === true means the TOOL failed (the
 * content holds the error text) — distinct from a JSON-RPC protocol error. Flattens text content for the caller.
 * → { isError, content, text, structured }. PURE.
 */
export function parseToolCall(result) {
  const r = (result && typeof result === 'object') ? result : {};
  const content = Array.isArray(r.content) ? r.content : [];
  const text = content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  return {
    isError: r.isError === true,
    content,
    text,
    structured: (r.structuredContent && typeof r.structuredContent === 'object') ? r.structuredContent : null,
  };
}

// ── Streamable HTTP request descriptor (the caller does the fetch) ─────────────────────────
/**
 * Build the HTTP request the caller POSTs to a Streamable-HTTP MCP endpoint. Accept advertises BOTH json + SSE (the
 * server chooses). Threads the session id (server returns `Mcp-Session-Id` on initialize), the negotiated protocol
 * version on post-initialize requests, and the OAuth bearer token when present. PURE → { url, method, headers, body }.
 */
export function httpRequestDescriptor({ endpoint, message, sessionId = null, protocolVersion = null, accessToken = null } = {}) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId) headers['mcp-session-id'] = String(sessionId);
  if (protocolVersion) headers['mcp-protocol-version'] = String(protocolVersion);
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`;
  return { url: String(endpoint || ''), method: 'POST', headers, body: JSON.stringify(message) };
}

// ── OAuth discovery seed (RFC 9728 / 8414) — a 401 challenge → where to authorize ─────────
/**
 * Parse a 401 `WWW-Authenticate: Bearer …` challenge → { scheme, realm, error, resourceMetadata }. The
 * resource_metadata URL (RFC 9728) is the entry point: fetch it → find the authorization server → (RFC 8414) its
 * authorize/token/registration endpoints → dynamic client registration (RFC 7591). Those fetches + the flow are MP-3
 * (impure); THIS is the pure seed. Returns null on an empty header.
 */
export function parseAuthChallenge(wwwAuthenticate) {
  const h = String(wwwAuthenticate || '').trim();
  if (!h) return null;
  const scheme = (/^([A-Za-z]+)/.exec(h) || [])[1] || null;
  const param = (name) => { const m = new RegExp(name + '="([^"]*)"', 'i').exec(h); return m ? m[1] : null; };
  return { scheme, realm: param('realm'), error: param('error'), resourceMetadata: param('resource_metadata') };
}

/** Build the RFC 9728/8414 well-known discovery URLs for a server's origin. PURE URL construction; null on a bad URL. */
export function wellKnownUrls(serverUrl) {
  let origin = '';
  try { origin = new URL(serverUrl).origin; } catch { return null; }
  return {
    protectedResource: `${origin}/.well-known/oauth-protected-resource`,
    authorizationServer: `${origin}/.well-known/oauth-authorization-server`,
    openidConfiguration: `${origin}/.well-known/openid-configuration`,
  };
}
