// Core/connectorRecipes.js — curated session-ride recipe catalog + endpoint templating (DESIGN_connectors.md §4, §12–14). CX-3/CX-4a.
//
// PURE: no chrome / DOM / fetch. A recipe binds a read OR write intent to one of an app's OWN frontend endpoints —
// the SAME request the app's own UI button fires — called by RIDING the user's existing browser login (session-ride).
// It is the full-CRUD equivalent of the grounded DOM driver, not a read-only side channel: a write recipe carries a
// `body` template alongside the endpoint. This module is the curated catalog + the `fillEndpoint`/`fillBody` templaters.
//
// §13/§14 (CS Tools reframe): identity lives at the CONNECTION, not the ask. So recipes use `appHost` (the origin is
// auto-derived from the open `*.appHost` tab — the tab you're logged into IS the connection), and "my X" reads need
// no params: `verifyIdentity` triggers an identity probe whose user id fills `{me}` (e.g. `assignee:{me}`). The probe
// also closes the CS Tools trap — a logged-out session returns HTTP 200 + an anonymous sentinel, so a list read would
// look like "0 results"; verify the returned identity, never the status.

import { recipeToLeg } from './connectorLeg.js';
import { armable } from './rideRecipe.js';

/**
 * Substitute `{name}` placeholders in a template from `args`, URL-encoding each value. PURE.
 * An unfilled placeholder is left visible. Used for the origin, the endpoint path, and `{me}` (filled from the probe).
 */
export function fillEndpoint(template, args = {}) {
  const a = (args && typeof args === 'object') ? args : {};
  return String(template ?? '').replace(/\{([a-zA-Z_][\w-]*)\}/g, (m, name) =>
    Object.prototype.hasOwnProperty.call(a, name) ? encodeURIComponent(String(a[name])) : m);
}

const _SOLE_PLACEHOLDER = /^\{([a-zA-Z_][\w-]*)\}$/;
const _has = (a, name) => a && Object.prototype.hasOwnProperty.call(a, name);

// Recursively fill one body-template node. Returns {drop} when the node resolves to nothing (so an optional field /
// emptied object falls out of its parent), else {value}. A SOLE placeholder takes the arg's NATIVE value (number /
// boolean / string — so `status:'{status}'`→"solved", `assignee_id:'{me}'`→42, `public:'{public}'`→false); a mixed
// string interpolates to a string (unfilled placeholders left visible, mirroring fillEndpoint); literals pass through.
function _fillBodyNode(node, a) {
  if (typeof node === 'string') {
    const sole = node.match(_SOLE_PLACEHOLDER);
    if (sole) return _has(a, sole[1]) ? { value: a[sole[1]] } : { drop: true };   // unfilled → drop the field
    return { value: node.replace(/\{([a-zA-Z_][\w-]*)\}/g, (m, n) => (_has(a, n) ? String(a[n]) : m)) };
  }
  if (Array.isArray(node)) {
    const arr = [];
    for (const item of node) { const r = _fillBodyNode(item, a); if (!r.drop) arr.push(r.value); }
    return { value: arr };
  }
  if (node && typeof node === 'object') {
    const obj = {};
    let kept = 0;
    for (const [k, v] of Object.entries(node)) { const r = _fillBodyNode(v, a); if (!r.drop) { obj[k] = r.value; kept++; } }
    return kept === 0 ? { drop: true } : { value: obj };          // an object that fully empties drops from its parent
  }
  return { value: node };                                          // number / boolean / null literal
}

/**
 * Build a write request body from a recipe's body TEMPLATE + args. PURE. (§6 write flow / §12 binding.)
 * Optional fields whose placeholder is unfilled are OMITTED (not sent as the literal "{x}"); a GET (null template)
 * has no body → null. The required fields are enforced upstream by `paramSchema.required`, so a dropped field here is
 * always an intentionally-absent optional. `{me}` resolves from the identity probe just like an endpoint's `{me}`.
 */
export function fillBody(template, args = {}) {
  if (template == null) return null;
  const r = _fillBodyNode(template, (args && typeof args === 'object') ? args : {});
  return r.drop ? null : r.value;
}

// The shared Zendesk session-ride identity (the operator's real queue, /api/v2 — same-origin + session-ride proven
// live, §12). `appHost` → origin auto-derived from the open `*.zendesk.com` tab; the probe fills `{me}` + closes the
// anonymous-sentinel trap (§14: a logged-out session returns 200 + an anon user, so verify identity, not status).
// All entries are GET reads (mode 'ask'); a TRUSTED curated read → safety 'auto'. Static query spaces are %20.
const ZD = Object.freeze({ app: 'zendesk', appHost: 'zendesk.com', verifyIdentity: true, identityProbe: '/api/v2/users/me.json', method: 'GET' });

// The curated catalog — full CRUD (CX-3/4a reads + CX-6a writes). `{me}` resolves server-side from the session cookie,
// so "my X" reads are param-free (no LLM binder, §13); by-id / search reads carry one typed param. A WRITE adds
// `write:true`, a non-GET `method`, and a `body` template (fillBody substitutes its `{param}`s). Writes are gated HARD
// (§9, full-session blast radius): the executor refuses a non-GET without an explicit post-HITL `confirmed:true`, so
// every write here is fail-closed until the human approves it — these definitions are the WHAT, not an auto-run grant.
// Excluded on purpose: ticket DELETE + status:closed (irreversible/admin — kept off the session-ride surface); money /
// inventory mutations stay navigate-only human-clicks, never a recipe (§9).
export const CONNECTOR_RECIPES = [
  // ── "my X" queue reads — param-free (identity = the session) ──────────────────────────────────────────────────
  { ...ZD, id: 'my_open_tickets', name: 'My open Zendesk tickets',
    does: 'list your OPEN Zendesk tickets (assigned to you), riding your Zendesk login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open%20assignee:{me}&per_page=25&sort_by=created_at&sort_order=desc',
    params: [] },
  { ...ZD, id: 'my_pending_tickets', name: 'My pending Zendesk tickets',
    does: 'list your PENDING Zendesk tickets (awaiting the customer, assigned to you), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:pending%20assignee:{me}&per_page=25&sort_by=updated_at&sort_order=desc',
    params: [] },
  { ...ZD, id: 'my_solved_tickets', name: 'My recently solved Zendesk tickets',
    does: 'list your recently SOLVED Zendesk tickets (assigned to you), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:solved%20assignee:{me}&per_page=25&sort_by=updated_at&sort_order=desc',
    params: [] },
  // ── by-id / search reads — one typed param ───────────────────────────────────────────────────────────────────
  { ...ZD, id: 'read_ticket', name: 'Read a Zendesk ticket',
    does: 'fetch one Zendesk ticket by its number, riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'ticket_comments', name: 'Read a Zendesk ticket conversation',
    does: 'read the full conversation (all comments, oldest first) on a Zendesk ticket by number, riding your login',
    endpoint: '/api/v2/tickets/{id}/comments.json?sort_order=asc',
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'search_tickets', name: 'Search Zendesk tickets',
    does: 'search your Zendesk tickets by keywords or a query (e.g. a subject, requester, or tag), riding your login',
    endpoint: '/api/v2/search.json?query={query}%20type:ticket&per_page=25&sort_by=updated_at&sort_order=desc',
    params: [{ name: 'query', type: 'string', required: true }] },
  { ...ZD, id: 'view_user', name: 'Look up a Zendesk user',
    does: 'look up a Zendesk user (a requester / customer) by id, riding your login',
    endpoint: '/api/v2/users/{id}.json',
    params: [{ name: 'id', type: 'integer', required: true }] },
  // ── writes — gated HARD; fail-closed until the human confirms (CX-6/§9). Each carries a `body` template. ──────────
  { ...ZD, id: 'create_ticket', name: 'Create a Zendesk ticket', write: true, method: 'POST',
    does: 'open a NEW Zendesk ticket with a subject + first comment (optionally a priority / requester id), riding your login',
    endpoint: '/api/v2/tickets.json',
    body: { ticket: { subject: '{subject}', comment: { body: '{comment}' }, priority: '{priority}', requester_id: '{requester_id}' } },
    params: [
      { name: 'subject', type: 'string', required: true },
      { name: 'comment', type: 'string', required: true },
      { name: 'priority', type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
      { name: 'requester_id', type: 'integer' },
    ] },
  { ...ZD, id: 'add_comment', name: 'Comment on a Zendesk ticket', write: true, method: 'PUT',
    does: 'add a comment to a Zendesk ticket — public=true REPLIES to the customer, public=false adds an INTERNAL note — riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { comment: { body: '{comment}', public: '{public}' } } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'comment', type: 'string', required: true },
      { name: 'public', type: 'boolean', enum: [true, false], required: true },   // force the model to classify visibility — no accidental public reply
    ] },
  { ...ZD, id: 'update_ticket_status', name: 'Set a Zendesk ticket status', write: true, method: 'PUT',
    does: 'change a Zendesk ticket status (open / pending / hold / solved), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { status: '{status}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'status', type: 'string', enum: ['open', 'pending', 'hold', 'solved'], required: true },   // 'closed' excluded — terminal
    ] },
  { ...ZD, id: 'assign_ticket_to_me', name: 'Assign a Zendesk ticket to me', write: true, method: 'PUT',
    does: 'assign a Zendesk ticket to YOURSELF (the logged-in agent), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { assignee_id: '{me}' } },   // {me} fills from the identity probe — the assignee is NOT an ask param
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'update_ticket_priority', name: 'Set a Zendesk ticket priority', write: true, method: 'PUT',
    does: 'change a Zendesk ticket priority (low / normal / high / urgent), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { priority: '{priority}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'priority', type: 'string', enum: ['low', 'normal', 'high', 'urgent'], required: true },
    ] },
  { ...ZD, id: 'add_tags', name: 'Add tags to a Zendesk ticket', write: true, method: 'PUT',
    does: 'add one or more tags to a Zendesk ticket (appends — does not replace), riding your login',
    endpoint: '/api/v2/tickets/{id}/tags.json',
    body: { tags: '{tags}' },                    // {tags} is a sole placeholder → the array passes through natively
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'tags', type: 'array', required: true },
    ] },
  { ...ZD, id: 'reassign_group', name: 'Move a Zendesk ticket to a group', write: true, method: 'PUT',
    does: 'reassign a Zendesk ticket to a different group by group id, riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { group_id: '{group_id}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'group_id', type: 'integer', required: true },
    ] },
  // ── destructive / consolidating — gated (the human approves; still fail-closed until CX-6b). User may also pick DOM. ──
  { ...ZD, id: 'merge_tickets', name: 'Merge Zendesk tickets', write: true, destructive: true, method: 'POST',
    does: 'merge one or more SOURCE tickets INTO a target ticket (the sources are closed) — consolidating, riding your login',
    endpoint: '/api/v2/tickets/{id}/merge.json',
    // NOTE: merge returns a job_status (202 async) — the executor reports "queued"; the job-poll is a follow-up (CX-6c).
    body: { ids: '{source_ids}', target_comment: '{target_comment}', source_comment: '{source_comment}' },
    params: [
      { name: 'id', type: 'integer', required: true },        // the TARGET ticket (survives)
      { name: 'source_ids', type: 'array', required: true },  // tickets merged into the target, then closed
      { name: 'target_comment', type: 'string' },
      { name: 'source_comment', type: 'string' },
    ] },
  { ...ZD, id: 'mark_as_spam', name: 'Mark a Zendesk ticket as spam', write: true, destructive: true, method: 'PUT',
    does: 'mark a Zendesk ticket as spam AND suspend its requester (hard to undo), riding your login',
    endpoint: '/api/v2/tickets/{id}/mark_as_spam.json',     // no body
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'delete_ticket', name: 'Delete a Zendesk ticket', write: true, destructive: true, method: 'DELETE',
    does: 'permanently delete a Zendesk ticket by number (irreversible), riding your login',
    endpoint: '/api/v2/tickets/{id}.json',                  // no body
    params: [{ name: 'id', type: 'integer', required: true }] },
];

// The "useful subset" render shape (CS Tools normalizeTicket — 10 of ~80 fields). Pure; used by the CX-4a.2 list render.
export function normalizeTicket(t, origin = '') {
  const x = (t && typeof t === 'object') ? t : {};
  return {
    id: x.id, subject: x.subject, status: x.status, priority: x.priority,
    requester_id: x.requester_id, assignee_id: x.assignee_id, tags: x.tags,
    created_at: x.created_at, updated_at: x.updated_at,
    description: typeof x.description === 'string' ? x.description.slice(0, 500) : null,
    url: (origin && x.id != null) ? `https://${origin}/agent/tickets/${x.id}` : null,
  };
}

/** Project the curated catalog into session-ride OfferedLegs. PURE. (CX-4 feeds these into the palette.) */
export function recipeLegs({ account = 'me', trusted = true } = {}) {
  return CONNECTOR_RECIPES.map((r) => recipeToLeg(r, { account, trusted })).filter(Boolean);
}

/**
 * Coerce param VALUES against a leg's paramSchema before a connector call. PURE. An integer/number param given as a
 * STRING (the LLM often includes a "#", e.g. "#64775") → its digits as a Number — so `{id}` fills to `64775`, not the
 * URL-encoded `%2364775` that the server rejects (the read_ticket http-400). Unknown / already-typed params pass through.
 */
export function coerceParams(params, paramSchema) {
  const props = (paramSchema && typeof paramSchema === 'object' && paramSchema.properties) || {};
  const out = {};
  for (const [k, v] of Object.entries((params && typeof params === 'object') ? params : {})) {
    const t = props[k] && props[k].type;
    if ((t === 'integer' || t === 'number') && typeof v === 'string') {
      const n = Number(v.replace(/[^0-9.\-]/g, ''));   // strip '#', spaces, stray text
      out[k] = Number.isFinite(n) && v.replace(/[^0-9.\-]/g, '') !== '' ? n : v;
    } else { out[k] = v; }
  }
  return out;
}

/**
 * The first curated recipe whose `appHost` matches an origin (host === appHost or a subdomain of it). PURE. Lets the
 * setup-time verify (AS-4) pick the STRONG identity probe for a recipe-backed site (e.g. `deako.zendesk.com` →
 * `zendesk.com`); a generic site (no match) falls back to the reach/login heuristic. Recipes share appHost+probe, so
 * any match suffices for the probe.
 */
export function recipeForOrigin(origin) {
  const host = String(origin || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  if (!host) return null;
  return CONNECTOR_RECIPES.find((r) => {
    const ah = String(r.appHost || '').toLowerCase();
    return ah && (host === ah || host.endsWith('.' + ah));
  }) || null;
}

// A short, stable `app` slug for a host's registrable domain (deakoapi.deako.com → 'deako'). Used only to build a
// unique leg.key (`account.app.id`); not semantic. PURE.
function _appFromHost(host) {
  const h = String(host || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  const labels = h.split('.').filter(Boolean);
  if (labels.length >= 2) return labels[labels.length - 2] || 'site';   // the registrable label (deako, zendesk)
  return labels[0] || 'site';
}

/**
 * §17/§18 — project a Ground's HARVESTED ride-recipes into session-ride connector legs for the IL invoke palette. PURE.
 * Gated by the §18 ARM GUARD: only `armable` recipes (enabled ∧ accepted) are projected — a `pending`/`rejected`/disabled
 * one is never a tool. For `mode:'ask'` only READS (GET) are projected (writes await their own confirm path). Adapts the
 * per-Ground record (Core/rideRecipe.js shape: origin · method · safetyClass) to recipeToLeg's recipe shape, deriving
 * `app` from the host + mapping method→write/safetyClass→destructive. `trusted:true` because an ACCEPTED recipe is
 * user-vetted (so its read drops to 'auto'). Dedups against `seenKeys` (so a harvested recipe can't shadow a curated one).
 *   recipes: per-Ground ride-recipes · host: the connected origin's host · seenKeys: keys already in the palette
 */
export function harvestedRecipeLegs(recipes, { host = '', account = 'me', mode = null, seenKeys = null, groundId = '' } = {}) {
  const list = Array.isArray(recipes) ? recipes : [];
  const app = _appFromHost(host);
  const seen = seenKeys instanceof Set ? seenKeys : new Set();
  const out = [];
  for (const r of list) {
    if (!r || !armable(r)) continue;                                   // the §18 gate — accepted ∧ enabled only
    const write = String(r.method || 'GET').toUpperCase() !== 'GET';
    // v2.74.1303 (CX-6) — writes ARE now projected (mode:'act' legs): the dispatch confirm-gates them AND the
    // SESSION_REPLAY handler fail-closes on `confirmed:true`, so a demonstrated "Create X" is selectable and can only
    // run through the HITL gate — a write reaching execution un-confirmed is refused at the boundary. (Was: reads-only skip.)
    const leg = recipeToLeg({
      id: r.id, name: r.name, does: r.does, app,
      origin: r.origin || host, endpoint: r.endpoint, method: r.method,
      write, destructive: r.safetyClass === 'destructive', body: r.body, params: r.params,
    }, { account, trusted: true });                                    // accepted = user-vetted → read drops to 'auto'
    if (!leg) continue;
    if (seen.has(leg.key)) continue; seen.add(leg.key);
    leg.provenance = 'harvested';                                      // mark the source
    // §20 — header-replay routing: the endpoint (leg.tool.origin, e.g. the cross-origin API host) is reached by replaying
    // the page-captured auth HEADERS FROM the app tab (sessionHost = the connected host where the login + token live). The
    // dispatch sees tool.replay==='headers' → SESSION_REPLAY instead of cookie-ride INVOKE_SESSION.
    leg.tool.sessionHost = host;
    leg.tool.replay = 'headers';
    // v2.74.1340 (review A/§18) — carry the recipe's Ground so the SESSION_REPLAY dispatch can hand the arm guard
    // its {groundId, recipeId} pair (the executor re-checks armable at run time, not just at projection time).
    if (groundId) leg.tool.groundId = String(groundId);
    out.push(leg);
  }
  return out;
}

/**
 * The session-ride legs an app can use given its CONNECTED sites (CX-4c). PURE. A recipe matches when its `appHost`
 * equals a connection's host or is its parent domain (`deako.zendesk.com` → `zendesk.com` recipes); each matching leg
 * is **origin-enriched** to ride the SPECIFIC connected instance (so the ride targets `deako.zendesk.com`, not any
 * Zendesk). Feeds the interpret candidate set so the IL can SELECT a connected recipe. Pass `mode:'ask'` for reads only.
 *   connections: [{ origin, label }]   → [OfferedLeg with tool.origin set]
 */
export function connectorLegsForConnections(connections, { account = 'me', trusted = true, mode = null } = {}) {
  const hosts = (Array.isArray(connections) ? connections : [])
    .map((c) => String((c && c.origin) || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '').toLowerCase())
    .filter(Boolean);
  if (!hosts.length) return [];
  const legs = recipeLegs({ account, trusted });
  const out = []; const seen = new Set();
  for (const host of hosts) {
    for (const leg of legs) {
      if (!leg || (mode && leg.mode !== mode)) continue;
      const ah = String((leg.tool && leg.tool.appHost) || '').toLowerCase();
      if (!ah || !(host === ah || host.endsWith('.' + ah))) continue;
      const k = `${host}|${leg.key}`;
      if (seen.has(k)) continue; seen.add(k);
      out.push({ ...leg, tool: { ...leg.tool, origin: host } });   // ride the SPECIFIC connected instance
    }
  }
  return out;
}
