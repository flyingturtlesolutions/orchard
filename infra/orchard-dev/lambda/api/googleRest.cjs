// infra/orchard-dev/lambda/api/googleRest.cjs — v2.74.1318. The GA REST channel for Google connectors: the same
// broker tools (google-calendar.list/create/update/delete_event), served by the Calendar v3 REST API instead of
// Google's MCP server. WHY: the Workspace MCP servers are Developer-Preview-gated and the preview program rejects
// consumer @gmail.com accounts (research 2026-07-01 — the live PERMISSION_DENIED, findings) — while Calendar v3 REST
// is GA, preview-free, and the SAME vaulted token + calendar.events scope authorizes it by contract. Same §5 reply
// shape as mcp.cjs ({ success, value | error, hint }); index.js picks the channel per server (CONNECTOR_CHANNEL).
// Flip a server back to 'mcp' when Google ships its MCP GA — the extension never knows which channel served it.
//
// fetchImpl injectable → headless-tested in Core/googleRestAdapter.test.js. Time handling: create/update accept a
// NAIVE ISO dateTime + an explicit IANA `timeZone` arg (the v3 events contract); a naive LIST bound gets 'Z'
// appended (the API requires an offset on timeMin/timeMax — a UTC read-window approximation, never a write).

'use strict';

const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const DOCS_BASE = 'https://docs.googleapis.com/v1';

// GD-2 — render_document takes PRE-LOWERED batchUpdate requests (Core/canvasLower runs client-side, pure+tested).
// To keep that from being a raw write conduit, the request SHAPES are allowlisted here: exactly the vocabulary the
// lowering emits, nothing else (no replaceAllText, no named-range ops). Belt-and-suspenders with drive.file (the
// token can only touch app-created docs anyway). GD-7b (v2.74.1333): + insertInlineImage — the uri is deep-checked
// https + bounded (the client's refs-not-URLs belt means it came from a banked trusted map, but the conduit
// re-checks; Google fetches the uri itself, so only publicly-readable images render).
const _DOC_REQ_KINDS = ['insertText', 'deleteContentRange', 'updateTextStyle', 'updateParagraphStyle', 'createParagraphBullets', 'insertInlineImage'];
const _DOC_REQ_MAX = 400;
function _validDocRequests(requests) {
  if (!Array.isArray(requests) || !requests.length) return 'render-needs-requests';
  if (requests.length > _DOC_REQ_MAX) return `too many requests (${requests.length} > ${_DOC_REQ_MAX})`;
  for (const r of requests) {
    if (!r || typeof r !== 'object') return 'malformed request';
    const keys = Object.keys(r);
    if (keys.length !== 1 || !_DOC_REQ_KINDS.includes(keys[0])) return `disallowed request kind: ${keys.join(',') || '(empty)'}`;
    if (keys[0] === 'insertInlineImage') {
      const uri = r.insertInlineImage && r.insertInlineImage.uri;
      if (typeof uri !== 'string' || !/^https:\/\/[^\s]+$/i.test(uri) || uri.length > 600) return 'insertInlineImage needs a bounded https uri';
    }
  }
  return null;
}

const _cid = (args) => encodeURIComponent(String((args && args.calendarId) || 'primary'));
const _hasOffset = (s) => /(?:Z|[+-]\d{2}:?\d{2})$/.test(String(s || ''));
const _listBound = (s) => (s && !_hasOffset(s) ? `${s}Z` : s);   // naive list bound → UTC (read-window approximation)

// One event-resource body from tool args (create + update share the mapping). Naive times ride with timeZone.
function _eventBody(args) {
  const a = args || {};
  const body = {};
  if (a.summary != null) body.summary = String(a.summary);
  if (a.description != null) body.description = String(a.description);
  if (a.location != null) body.location = String(a.location);
  const tz = a.timeZone ? String(a.timeZone) : null;
  const _time = (v) => (tz ? { dateTime: v, timeZone: tz } : { dateTime: v });
  if (a.allDay === true) {
    // all-day events use date (YYYY-MM-DD); take the date part of whatever was given.
    if (a.startTime) body.start = { date: String(a.startTime).slice(0, 10) };
    if (a.endTime) body.end = { date: String(a.endTime).slice(0, 10) };
  } else {
    if (a.startTime) body.start = _time(String(a.startTime));
    if (a.endTime) body.end = _time(String(a.endTime));
  }
  if (Array.isArray(a.attendeeEmails) && a.attendeeEmails.length) body.attendees = a.attendeeEmails.map((e) => ({ email: String(e) }));
  return body;
}

// Minimize an event resource for the reply (never echo the whole payload — the §12 shape discipline).
const _slim = (e) => (e && typeof e === 'object')
  ? { id: e.id, status: e.status, summary: e.summary, start: e.start, end: e.end, htmlLink: e.htmlLink }
  : e;

/**
 * Invoke one google-calendar tool via Calendar v3 REST. Same contract as invokeMcpTool.
 * @param {{ server:string, tool:string, args?:object, accessToken?:string, fetchImpl?:Function, deadlineMs?:number }} opts
 * @returns {Promise<{ success:true, value:any } | { success:false, error:string, hint?:string }>}
 */
async function invokeGoogleRestTool({ server, tool, args = {}, accessToken = null, fetchImpl = globalThis.fetch, deadlineMs = 15000 } = {}) {
  const srv = String(server);
  if (srv !== 'google-calendar' && srv !== 'google-docs') return { success: false, error: 'unknown-rest-server', hint: `no REST adapter for "${server}"` };
  if (typeof fetchImpl !== 'function') return { success: false, error: 'no-fetch' };
  const a = args || {};

  let req = null;   // { method, url, body? }
  let shape = null; // per-tool reply minimizer override
  if (srv === 'google-docs') {
    // GD-2 (DESIGN_canvas.md §8) — the Docs presentation backend. drive.file scope ⇒ only app-created docs reachable.
    if (tool === 'create_document') {
      if (!a.title) return { success: false, error: 'tool-error', hint: 'title is required' };
      req = { method: 'POST', url: `${DOCS_BASE}/documents`, body: { title: String(a.title) } };
      shape = (d) => ({ documentId: d.documentId, title: d.title, revisionId: d.revisionId });
    } else if (tool === 'get_document') {
      if (!a.documentId) return { success: false, error: 'tool-error', hint: 'documentId is required' };
      req = { method: 'GET', url: `${DOCS_BASE}/documents/${encodeURIComponent(String(a.documentId))}?fields=documentId,title,revisionId,body.content(endIndex)` };
      shape = (d) => {
        const content = (d.body && Array.isArray(d.body.content)) ? d.body.content : [];
        const bodyEndIndex = content.length ? (content[content.length - 1].endIndex || 1) : 1;   // the replace-body parameter (canvasLower)
        return { documentId: d.documentId, title: d.title, revisionId: d.revisionId, bodyEndIndex };
      };
    } else if (tool === 'render_document') {
      if (!a.documentId) return { success: false, error: 'tool-error', hint: 'documentId is required' };
      const bad = _validDocRequests(a.requests);
      if (bad) return { success: false, error: 'tool-error', hint: bad };
      req = { method: 'POST', url: `${DOCS_BASE}/documents/${encodeURIComponent(String(a.documentId))}:batchUpdate`, body: { requests: a.requests } };
      shape = (d) => ({ documentId: d.documentId, applied: Array.isArray(d.replies) ? d.replies.length : 0 });
    } else {
      return { success: false, error: 'unknown-tool', hint: `no REST mapping for "${tool}"` };
    }
  } else if (tool === 'list_events') {
    const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime' });
    if (a.startTime) q.set('timeMin', _listBound(String(a.startTime)));
    if (a.endTime) q.set('timeMax', _listBound(String(a.endTime)));
    if (a.pageSize) q.set('maxResults', String(a.pageSize));
    if (a.fullText) q.set('q', String(a.fullText));
    req = { method: 'GET', url: `${CAL_BASE}/calendars/${_cid(a)}/events?${q}` };
  } else if (tool === 'create_event') {
    req = { method: 'POST', url: `${CAL_BASE}/calendars/${_cid(a)}/events`, body: _eventBody(a) };
  } else if (tool === 'update_event') {
    if (!a.eventId) return { success: false, error: 'tool-error', hint: 'eventId is required' };
    req = { method: 'PATCH', url: `${CAL_BASE}/calendars/${_cid(a)}/events/${encodeURIComponent(String(a.eventId))}`, body: _eventBody(a) };
  } else if (tool === 'delete_event') {
    if (!a.eventId) return { success: false, error: 'tool-error', hint: 'eventId is required' };
    req = { method: 'DELETE', url: `${CAL_BASE}/calendars/${_cid(a)}/events/${encodeURIComponent(String(a.eventId))}` };
  } else {
    return { success: false, error: 'unknown-tool', hint: `no REST mapping for "${tool}"` };
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Math.max(1000, deadlineMs));
  try {
    const headers = { authorization: `Bearer ${accessToken || ''}`, accept: 'application/json' };
    if (req.body) headers['content-type'] = 'application/json';
    const res = await fetchImpl(req.url, { method: req.method, headers, body: req.body ? JSON.stringify(req.body) : undefined, signal: ctl.signal });
    if (res.status === 401 || res.status === 403) {
      let hint = '';
      try { const j = JSON.parse(await res.text()); hint = (j.error && j.error.message) || ''; } catch { /* */ }
      return { success: false, error: 'broker-unauthorized', hint: hint || 're-link the connector' };
    }
    if (res.status === 204) return { success: true, value: { deleted: true } };   // DELETE
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = (data && data.error && data.error.message) || `http ${res.status}`;
      // v2.74.1341 (review P1-5) — carry the HTTP status so the client can tell "doc deleted" (404 → recreate)
      // from "transient/permission failure" (never recreate — that orphans the shared doc).
      return { success: false, error: 'tool-error', status: res.status, hint: String(msg).slice(0, 500) };
    }
    if (tool === 'list_events') {
      const items = (data && Array.isArray(data.items)) ? data.items.map(_slim) : [];
      return { success: true, value: { events: items, count: items.length } };
    }
    if (shape) return { success: true, value: shape(data || {}) };   // GD-2 — per-tool minimizer (docs)
    return { success: true, value: _slim(data) };
  } catch (e) {
    const aborted = ctl.signal.aborted;
    return { success: false, error: aborted ? 'rest-timeout' : 'rest-network-error', hint: aborted ? `deadline ${deadlineMs}ms` : String((e && e.message) || '') };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { invokeGoogleRestTool };
