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
    // Drop the field when the arg reads as ABSENT: unfilled, '' / null / undefined, OR a bare placeholder token the
    // LLM binder ECHOED ("{company}") as the value for a param it couldn't fill (v1405). An empty/echoed optional must
    // NEVER ride the body — Shopify rejects phone:"" as "Phone is invalid" (v1403) and stores "{company}" LITERALLY in
    // an address. `false` / `0` are real values and stay — only ''/null/undefined/placeholder-echo read as absent.
    if (sole) { const val = _has(a, sole[1]) ? a[sole[1]] : undefined; return (val === '' || val == null || (typeof val === 'string' && _SOLE_PLACEHOLDER.test(val))) ? { drop: true } : { value: val }; }
    return { value: node.replace(/\{([a-zA-Z_][\w-]*)\}/g, (m, n) => (_has(a, n) ? String(a[n]) : m)) };
  }
  if (Array.isArray(node)) {
    const arr = [];
    for (const item of node) { const r = _fillBodyNode(item, a); if (!r.drop) arr.push(r.value); }
    return arr.length === 0 ? { drop: true } : { value: arr };     // an emptied array optional drops, symmetric with the object branch (so an all-unfilled addresses:[{…}] falls out clean)
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
// FL-1c (v2.74.1347) — `itemUrl`: the HUMAN page for this recipe's object (the agent-workspace ticket view),
// templated on {id}. GROUND TRUTH: proposal/ledger targets link to the real page, assembled from TRUSTED data only
// (connection origin + this template + a sanitized id) — the model never mints URLs. view_user overrides (users).
const ZD = Object.freeze({ app: 'zendesk', appHost: 'zendesk.com', verifyIdentity: true, identityProbe: '/api/v2/users/me.json', method: 'GET', itemUrl: '/agent/tickets/{id}' });

/**
 * CX-7 (v2.74.1386) — is a GraphQL document READ-ONLY (a query, never a mutation/subscription)? The Shopify ride's
 * reads are POSTs, and a POST normally demands the HITL write gate — this predicate is what lets a curated GraphQL
 * READ run unconfirmed. Enforced at BOTH belts: background validates the template before dispatch, and the content
 * script re-validates the FINAL body at the execution boundary (ContentScripts SESSION_FETCH keeps an inline twin
 * of this exact logic — keep them in lockstep). String literals are stripped before the keyword scan. PURE.
 */
export function isReadOnlyGql(query) {
  const q = String(query || '').trim();
  if (!q || !/^(query\b|\{)/.test(q)) return false;
  const noStrings = q.replace(/"(?:[^"\\]|\\.)*"/g, '');
  return !(/\bmutation\b/i.test(noStrings) || /\bsubscription\b/i.test(noStrings));
}

// ── Shopify (CX-7, v2.74.1386 — from logs/run/ride-legs-spec.md §Shopify, the CS stack's LIVE implementation) ────
// Transport: the admin SPA's own GraphQL endpoint, POST /api/shopify/{handle} with {query, variables} — riding the
// user's real admin.shopify.com tab (no Playwright/Cloudflare problem: the logged-in tab IS the headed browser).
// `{handle}` (the store slug in /store/<handle>/…) fills from the RIDE TAB's URL (`urlParam`), never from the model.
// CSRF: REQUIRED on these POSTs and NOT in a meta tag — `csrf:'sniff'` makes INVOKE_SESSION capture `x-csrf-token`
// off the SPA's own outbound requests (MAIN-world tee) and cache it per origin. READ-ONLY BY POLICY (the spec's
// money=human-click-only rule): no Shopify mutations ship as recipes — their write path is store-captured persisted-op
// hashes that rotate on admin deploys (HASH_STALE), unportable as curated data; refunds/returns are navigate-only.
// Spec traps honored elsewhere: a 200-with-HTML login page = auth failure (SESSION_FETCH 'non-json'), and email/phone
// search returns NEAR-MATCHES — exact-match before binding a customer to anything (recipe `does` says so).
const _GQL_CUSTOMERS = 'query($q: String!, $n: Int!) { customers(first: $n, query: $q) { edges { node { id firstName lastName email phone numberOfOrders tags defaultAddress { city province country } } } } }';
// CX-7c (v2.74.1388) — order read now carries RETURNS (return/exchange status + reverse tracking — the "where's my
// exchange?" question) and the refund AMOUNT (totalRefundedSet), plus the fulfillment event timeline. Spec §3.
const _GQL_ORDERS = 'query($q: String!, $n: Int!) { orders(first: $n, query: $q, sortKey: CREATED_AT, reverse: true) { edges { node { id name createdAt displayFinancialStatus displayFulfillmentStatus totalPriceSet { shopMoney { amount currencyCode } } customer { email } lineItems(first: 10) { edges { node { title quantity } } } fulfillments { status displayStatus estimatedDeliveryAt deliveredAt trackingInfo { number company url } events(first: 10) { edges { node { status happenedAt } } } } returns(first: 10) { edges { node { id status returnLineItems(first: 10) { edges { node { quantity } } } reverseFulfillmentOrders(first: 5) { edges { node { reverseDeliveries(first: 5) { edges { node { deliverable { ... on ReverseDeliveryShippingDeliverable { tracking { carrierName number url } } } } } } } } } } } } refunds { createdAt note totalRefundedSet { shopMoney { amount currencyCode } } } tags note } } } }';
const _GQL_PRODUCTS = 'query($q: String!, $n: Int!) { products(first: $n, query: $q) { edges { node { id title status totalInventory variants(first: 10) { edges { node { id title sku price inventoryQuantity } } } } } } }';
// CX-7c — the LIVENESS probe document: `{ shop { name } }` (spec §2 probeShopify). `shopProbe:true` makes
// INVOKE_SESSION run it once (cached) before the call — a clean signed-out verdict instead of a mid-call surprise.
const SH = Object.freeze({
  app: 'shopify', appHost: 'admin.shopify.com', method: 'POST', gql: true, csrf: 'sniff', contentType: 'application/json',
  endpoint: '/api/shopify/{handle}', urlParam: { name: 'handle', pattern: '\\/store\\/([^\\/]+)' }, shopProbe: true,
});

// ── VendorSuite (D.R. Horton vendor portal, vendorsuite.drhorton.com) — CX-9 (v2.74.1431), authored from HAR captures.
// SAME-ORIGIN COOKIE-RIDE: the SPA's own /api/* reads, riding the vendor's logged-in session — NO Bearer/Authorization
// header (v1430's cookie fallback carries them). {divisionId} = the D.R. Horton MARKET/division (Atlanta West-210 = 83,
// Seattle-750 = 10, …); the VENDOR (e.g. DEAKO) is the session, the DIVISION is the variable. Resolve {divisionId} from
// /api/VendorSuite/State: `access.DefaultDivision.Id` = the current division; `access.Hubs[].Divisions` = the whole list
// the vendor can pick (the #divisionMenu). {status} ∈ new | open | fixed | closed. Reads only here — the warranty-note
// WRITE (POST UpdateCompleteTask, form-urlencoded taskId+note) is a follow-on: it needs the form-urlencoded cookie-ride
// write transport verified AND recipeFromCatalogEntry taught to carry write/body/bodyType (today's lossy projection drops
// them), so it stays out of the curated surface until both land.
const VS = Object.freeze({ app: 'vendorsuite', appHost: 'vendorsuite.drhorton.com', method: 'GET' });

/**
 * CX-7c (v2.74.1388) — coerce a Shopify object id to a gid. Reads return `id` as a full gid
 * (`gid://shopify/Customer/123`); the model usually passes that back, but a bare numeric or a `#`-prefixed value
 * is normalized to the gid the write needs. A value that is already a gid passes through. PURE.
 */
export function toShopifyGid(value, kind) {
  const s = String(value == null ? '' : value).trim();
  if (!s || !kind) return s;
  if (/^gid:\/\/shopify\//i.test(s)) return s;
  const digits = s.replace(/[^0-9]/g, '');
  return digits ? `gid://shopify/${kind}/${digits}` : s;
}

// The curated catalog — full CRUD (CX-3/4a reads + CX-6a writes). `{me}` resolves server-side from the session cookie,
// so "my X" reads are param-free (no LLM binder, §13); by-id / search reads carry one typed param. A WRITE adds
// `write:true`, a non-GET `method`, and a `body` template (fillBody substitutes its `{param}`s). Writes are gated HARD
// (§9, full-session blast radius): the executor refuses a non-GET without an explicit post-HITL `confirmed:true`, so
// every write here is fail-closed until the human approves it — these definitions are the WHAT, not an auto-run grant.
// Excluded on purpose: ticket DELETE + status:closed (irreversible/admin — kept off the session-ride surface); money /
// inventory mutations stay navigate-only human-clicks, never a recipe (§9).
export const CONNECTOR_RECIPES = [
  // ── "my X" queue reads — param-free (identity = the session) ──────────────────────────────────────────────────
  // FL-1d (v2.74.1349) — `listUrl`: the COLLECTION's human page (the itemUrl counterpart for list-shaped reads).
  // These are search reads, so the honest view is the agent search page running the SAME query — "show me" after
  // "how many open tickets" opens the list the count came from, not a random item.
  // FL-10b (v2.74.1383) — `drill: { via }`: rows from this LIST read may be evidence-drilled through the named
  // comments read (fleet triage → per-ticket thread fetch → deterministic extract; Core/ticketEvidence.js).
  // Recipe DATA declares drillability; the fleet harness only follows the marker.
  { ...ZD, id: 'my_open_tickets', name: 'My open Zendesk tickets', pulse: { scope: 'mine', status: 'open' }, drill: { via: 'ticket_comments' },
    does: 'list your OPEN Zendesk tickets (assigned to you), riding your Zendesk login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open%20assignee:{me}&per_page=25&sort_by=created_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Aopen%20assignee%3Ame',
    params: [] },
  { ...ZD, id: 'my_pending_tickets', name: 'My pending Zendesk tickets', pulse: { scope: 'mine', status: 'pending' },
    does: 'list your PENDING Zendesk tickets (awaiting the customer, assigned to you), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:pending%20assignee:{me}&per_page=25&sort_by=updated_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Apending%20assignee%3Ame',
    params: [] },
  { ...ZD, id: 'my_solved_tickets', name: 'My recently solved Zendesk tickets',
    does: 'list your recently SOLVED Zendesk tickets (assigned to you), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:solved%20assignee:{me}&per_page=25&sort_by=updated_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Asolved%20assignee%3Ame',
    params: [] },
  // ── FL-8a (v2.74.1358) — the ADMIN-view reads: the whole queue, not just mine (the fleet sweep's working set).
  // `pulse` (v1359; enriched v1375) — the read's GENERIC digest semantics, as DATA: {kind, scope, status}.
  // kind ('inventory' | 'backlog' | 'inflow') keys the harness's spike/count bookkeeping; scope+status place the
  // read's exact API `count` into the queue-state breakdown ("You: 4 open · 3 pending / Team: 32 open · 3
  // unassigned") — CODE assembles counts, the model never counts. Never keyed on a recipe id — a Gmail fleet app
  // tags its own reads and gets the same digest for free (the portability test). ──
  { ...ZD, id: 'all_open_tickets', name: 'All open Zendesk tickets (whole queue)', pulse: { kind: 'inventory', scope: 'team', status: 'open' }, drill: { via: 'ticket_comments' },
    does: 'list ALL open Zendesk tickets across the whole queue — everyone’s and unassigned, oldest first (the admin/queue-review view, not just yours), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open&per_page=100&sort_by=created_at&sort_order=asc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Aopen',
    params: [] },
  { ...ZD, id: 'unassigned_tickets', name: 'Unassigned Zendesk tickets', pulse: { kind: 'backlog', scope: 'team', status: 'unassigned' }, drill: { via: 'ticket_comments' },
    does: 'list open Zendesk tickets with NO assignee (the assignment backlog), oldest first, riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20status:open%20assignee:none&per_page=100&sort_by=created_at&sort_order=asc',
    listUrl: '/agent/search/1?type=ticket&q=status%3Aopen%20assignee%3Anone',
    params: [] },
  { ...ZD, id: 'tickets_last_day', name: 'Zendesk tickets created in the last 24h', pulse: { kind: 'inflow' }, drill: { via: 'ticket_comments' },
    does: 'list Zendesk tickets CREATED in the last 24 hours (new-volume pulse — the digest / spike-detection feed), riding your login',
    endpoint: '/api/v2/search.json?query=type:ticket%20created>24hours&per_page=100&sort_by=created_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q=created%3E24hours',
    params: [] },
  // ── by-id / search reads — one typed param ───────────────────────────────────────────────────────────────────
  { ...ZD, id: 'read_ticket', name: 'Read a Zendesk ticket',
    does: 'fetch one Zendesk ticket by its number and summarize its DETAILS AS TEXT in the chat (for "what does it say / what’s it about" asks — NOT for showing/opening the page itself)',
    endpoint: '/api/v2/tickets/{id}.json',
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'ticket_comments', name: 'Read a Zendesk ticket conversation',
    does: 'read the full conversation (all comments, oldest first) on a Zendesk ticket by number, riding your login',
    endpoint: '/api/v2/tickets/{id}/comments.json?sort_order=asc',
    params: [{ name: 'id', type: 'integer', required: true }] },
  { ...ZD, id: 'search_tickets', name: 'Search Zendesk tickets',
    does: 'search your Zendesk tickets by keywords or a query (e.g. a subject, requester, or tag), riding your login',
    endpoint: '/api/v2/search.json?query={query}%20type:ticket&per_page=25&sort_by=updated_at&sort_order=desc',
    listUrl: '/agent/search/1?type=ticket&q={query}',
    params: [{ name: 'query', type: 'string', required: true }] },
  { ...ZD, id: 'view_user', name: 'Look up a Zendesk user',
    does: 'look up a Zendesk user (a requester / customer) by id, riding your login',
    endpoint: '/api/v2/users/{id}.json', itemUrl: '/agent/users/{id}',
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
  // FL-10c (v2.74.1383) — `autoRequires: 'evidence'`: UNATTENDED execution of this class needs same-run
  // CODE-verified proof (a drill verdict: POSITIVE sentiment + no open commitment + mine, or an aged empty stub)
  // on top of the autonomy policy. A human approving from a card is never gated by this.
  { ...ZD, id: 'update_ticket_status', name: 'Set a Zendesk ticket status', write: true, method: 'PUT', autoRequires: 'evidence',
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
  // ── FL-8a (v2.74.1358) — the requester-fix pair: create the customer profile, then attach it to the ticket. ──
  { ...ZD, id: 'create_user', name: 'Create a Zendesk user (customer profile)', write: true, method: 'POST',
    does: 'create a Zendesk END-USER (customer) profile with a name + email — e.g. to become the requester on a ticket that has none, riding your login',
    endpoint: '/api/v2/users.json', itemUrl: '/agent/users/{id}',
    body: { user: { name: '{name}', email: '{email}', role: 'end-user' } },   // role is a LITERAL — a sweep can never mint agents/admins
    params: [
      { name: 'name', type: 'string', required: true },
      { name: 'email', type: 'string', required: true },
    ] },
  { ...ZD, id: 'set_ticket_requester', name: 'Set a Zendesk ticket requester', write: true, method: 'PUT',
    does: 'attach a requester (customer profile, by user id) to a Zendesk ticket — for tickets missing one, riding your login',
    endpoint: '/api/v2/tickets/{id}.json',
    body: { ticket: { requester_id: '{requester_id}' } },
    params: [
      { name: 'id', type: 'integer', required: true },
      { name: 'requester_id', type: 'integer', required: true },
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

  // ── Shopify reads (CX-7) — GraphQL query documents are STATIC (params fill only the `variables`), so the
  // read-only belt validates a fixed text. All READ-ONLY by policy — no Shopify write recipes exist on purpose. ──
  // FL-1c/CX-7e (v2.74.1393) — `itemUrl`: the record's HUMAN admin page ("show profile" opens it, like "show ticket"
  // on Zendesk). {handle} fills from the read's tab-derived urlParam (the same /store/<handle>/ the read rode);
  // {id} is the RESULT's record id (a customer lookup by email → the customer gid, tail-stripped to numeric).
  { ...SH, id: 'shopify_customer_by_email', name: 'Find a Shopify customer by email', itemUrl: '/store/{handle}/customers/{id}',
    does: 'look up Shopify customer(s) by EMAIL, riding your admin login — search returns near-matches: confirm the exact email before trusting a hit',
    body: { query: _GQL_CUSTOMERS, variables: { q: 'email:"{email}"', n: 5 } },
    params: [{ name: 'email', type: 'string', required: true }] },
  { ...SH, id: 'shopify_customer_by_phone', name: 'Find a Shopify customer by phone', itemUrl: '/store/{handle}/customers/{id}',
    does: 'look up Shopify customer(s) by PHONE number, riding your admin login — search returns near-matches: confirm the digits match exactly before trusting a hit',
    body: { query: _GQL_CUSTOMERS, variables: { q: 'phone:"{phone}"', n: 5 } },
    params: [{ name: 'phone', type: 'string', required: true }] },
  { ...SH, id: 'shopify_orders_for_customer', name: 'Shopify orders for a customer',
    does: 'list a customer’s recent Shopify orders by their EMAIL (status, totals, line items, fulfillment/tracking, refunds), riding your admin login',
    body: { query: _GQL_ORDERS, variables: { q: 'email:"{email}"', n: 5 } },
    params: [{ name: 'email', type: 'string', required: true }] },
  { ...SH, id: 'shopify_order', name: 'Look up a Shopify order', itemUrl: '/store/{handle}/orders/{id}',
    does: 'fetch one Shopify order by its ORDER NUMBER (digits, e.g. 69872 — not the DEAKO# prefix): status, totals, line items, fulfillment/tracking, refunds — riding your admin login',
    body: { query: _GQL_ORDERS, variables: { q: 'name:{order}', n: 3 } },
    params: [{ name: 'order', type: 'string', required: true }] },
  { ...SH, id: 'shopify_search_products', name: 'Search Shopify products',
    does: 'search Shopify products by title / sku / tag query (with variants, price, inventory), riding your admin login',
    body: { query: _GQL_PRODUCTS, variables: { q: '{query}', n: 5 } },
    params: [{ name: 'query', type: 'string', required: true }] },

  // ── Shopify write (CX-7b, v2.74.1387) — the spec's ALLOWED mutation class (customer create is NOT money; the
  // banned classes stay banned: refunds/returns/inventory never ship as recipes). Shopify admin mutations are
  // PERSISTED OPERATIONS: POST /api/operations/<sha256>/<OpName>/shopify/<handle> — the sha is per-store and
  // rotates on admin deploys, so it is NEVER curated data: `persistedOp` makes INVOKE_SESSION fill {op_sha} from
  // the per-origin op bank the MAIN-world tee captures off the SPA's own traffic (create one customer by hand
  // once with the tab ridden → the op is banked; a stale hash after a deploy re-captures the same way).
  // Fail-closed like every write: confirmed:true at both belts + sniffed CSRF; 200-with-userErrors = failure.
  { ...SH, id: 'shopify_create_customer', name: 'Create a Shopify customer', write: true, gql: false, persistedOp: 'CustomerCreate',
    does: 'create a NEW Shopify customer profile (name + email and/or phone — at least one contact is required; optional mailing address), riding your admin login',
    endpoint: '/api/operations/{op_sha}/CustomerCreate/shopify/{handle}', itemUrl: '/store/{handle}/customers/{id}',   // CX-7f — "show customer" after a create opens the new record (id from the reply, handle from the ride tab)
    // CX-7 — the optional mailing address rides as customerInput.addresses[0]. With NO address field set, the inner
    // object empties → the array empties → `addresses` drops entirely (the array-drop symmetry in _fillBodyNode), so
    // a contact-only create is byte-identical to before. province/country map to the GraphQL CODES (provinceCode
    // "WA", countryCode "US"); if this store's persisted op wants names or a different key, the live userErrors names
    // it (same hand-authored-guess caveat as the op variable shape — CX-8 body-capture forges this exactly later).
    body: { operationName: 'CustomerCreate', variables: { customerInput: {
      firstName: '{first_name}', lastName: '{last_name}', email: '{email}', phone: '{phone}', note: '{note}',
      addresses: [{ address1: '{address1}', address2: '{address2}', city: '{city}', provinceCode: '{province}', countryCode: '{country}', zip: '{zip}', company: '{company}' }],
    } } },
    params: [
      { name: 'first_name', type: 'string', required: true },
      { name: 'last_name', type: 'string', required: true },
      { name: 'email', type: 'string' },      // email OR phone — unfilled optionals drop from the body (fillBody);
      { name: 'phone', type: 'string' },      // Shopify rejects a contactless input with userErrors (surfaced honestly)
      { name: 'note', type: 'string' },
      { name: 'address1', type: 'string' },   // street — the presence of any address field builds addresses[0]
      { name: 'address2', type: 'string' },
      { name: 'city', type: 'string' },
      { name: 'province', type: 'string' },   // → provinceCode, e.g. "WA"
      { name: 'country', type: 'string' },    // → countryCode, e.g. "US"
      { name: 'zip', type: 'string' },
      { name: 'company', type: 'string' },
    ] },
  // CX-7c (v2.74.1388) — EDIT an existing customer (spec's ALLOWED EditCustomer op). Partial: only filled fields
  // ride the body (fillBody drops unfilled optionals). `customer_gid` gid-coerces (bare id → gid) — it's the `id`
  // a customer read returned.
  { ...SH, id: 'shopify_update_customer', name: 'Edit a Shopify customer', write: true, gql: false, persistedOp: 'EditCustomer',
    does: 'update fields on an EXISTING Shopify customer (name, email, phone, note, tags) — only the fields you set change; identify them by the customer id from a lookup',
    endpoint: '/api/operations/{op_sha}/EditCustomer/shopify/{handle}', itemUrl: '/store/{handle}/customers/{id}',   // CX-7f — "show customer" after an edit opens the record
    body: { operationName: 'EditCustomer', variables: { input: { id: '{customer_gid}', firstName: '{first_name}', lastName: '{last_name}', email: '{email}', phone: '{phone}', note: '{note}', tags: '{tags}' } } },
    params: [
      { name: 'customer_gid', type: 'string', required: true, gid: 'Customer' },
      { name: 'first_name', type: 'string' },
      { name: 'last_name', type: 'string' },
      { name: 'email', type: 'string' },
      { name: 'phone', type: 'string' },
      { name: 'note', type: 'string' },
      { name: 'tags', type: 'array' },
    ] },
  // CX-7c (v2.74.1388) — create a DRAFT order (spec: "safe/reversible" — a draft is NOT a charge; completing it is
  // the money step and stays HUMAN-CLICK, never a recipe). The FOC/warranty-replacement path: pass a 100%
  // PERCENTAGE `applied_discount` + a zero `shipping_line`. Nested structures ride as WHOLE object params (sole
  // placeholders → native value; unfilled → dropped), so an ordinary paid draft omits them cleanly.
  { ...SH, id: 'shopify_create_order', name: 'Create a Shopify draft order', write: true, gql: false, persistedOp: 'DraftOrderCreate',
    does: 'create a DRAFT order for a customer (line items by variant id + quantity) — a reversible draft the human reviews and completes; for a free warranty replacement pass a 100% applied_discount and a zero shipping_line',
    endpoint: '/api/operations/{op_sha}/DraftOrderCreate/shopify/{handle}', itemUrl: '/store/{handle}/draft_orders/{id}',   // CX-7f — "show order" after a create opens the draft
    body: { operationName: 'DraftOrderCreate', variables: {
      input: { purchasingEntity: { customerId: '{customer_gid}' }, lineItems: '{line_items}', useCustomerDefaultAddress: true, note: '{note}', poNumber: '{po_number}', tags: '{tags}', appliedDiscount: '{applied_discount}', shippingLine: '{shipping_line}' },
      hasDiscountsPermission: true, hasVaultedPaymentPermissions: true, firstLineItems: 50 } },
    params: [
      { name: 'customer_gid', type: 'string', required: true, gid: 'Customer' },   // purchasingEntity.customerId — the customer's id from a lookup
      { name: 'line_items', type: 'array', required: true },   // [{ variantId: 'gid://shopify/ProductVariant/…', quantity: 1 }] — variant ids from a product search
      { name: 'note', type: 'string' },
      { name: 'po_number', type: 'string' },
      { name: 'tags', type: 'array' },
      { name: 'applied_discount', type: 'object' },   // { value, valueType: 'PERCENTAGE'|'FIXED_AMOUNT', title } — 100% PERCENTAGE for a warranty replacement
      { name: 'shipping_line', type: 'object' },       // { title, price } — { price: '0.00' } for free shipping
    ] },
  // ── VendorSuite (CX-9) — the curated cookie-ride READS. {divisionId}/{status}/{taskId} are explicit params for now;
  // the convivial auto-fill of {divisionId} from VendorSuite/State (access.DefaultDivision.Id) is the next slice.
  // FL-1c/1d (v2.74.1432) — `itemUrl`/`listUrl`: VendorSuite is a hash-route SPA with ONLY 4 sections (#warranty /
  // #dashboard / #settings / #documents — no per-task route), so "show warranty" opens the #warranty SECTION (the
  // honest home of the task), exactly like "show ticket" opens a Zendesk ticket. The section link carries no {id}
  // placeholder — the read's result id has nowhere per-task to go, so it just opens the section the object lives in. ──
  { ...VS, id: 'vs_state', name: 'My VendorSuite state', itemUrl: '/#dashboard',
    does: 'read your VendorSuite state — your current division, the divisions you can access, your permissions, and current announcements — riding your login',
    endpoint: '/api/VendorSuite/State', params: [] },
  { ...VS, id: 'vs_versions', name: 'VendorSuite versions',
    does: 'the VendorSuite app component versions and environment',
    endpoint: '/api/Versions', params: [] },
  { ...VS, id: 'vs_warranty_tasks', name: 'Warranty tasks by status', listUrl: '/#warranty',
    does: 'list a division\'s warranty tasks by status (new / open / fixed / closed) — task number, claim number, address, age, allowed amount; the division id comes from your VendorSuite state',
    endpoint: '/api/Vendor/Warranty/Tasks/{divisionId}/{status}',
    params: [{ name: 'divisionId', type: 'string', required: true }, { name: 'status', type: 'string', required: true }] },
  { ...VS, id: 'vs_warranty_task', name: 'Warranty task details', itemUrl: '/#warranty',
    does: 'read a warranty task\'s full details by its task id — status, project, address, priority, instructions, vendor explanation, appointments',
    endpoint: '/api/Vendor/Warranty/Task/{taskId}',
    params: [{ name: 'taskId', type: 'string', required: true }] },
  { ...VS, id: 'vs_warranty_stats', name: 'Warranty task counts', listUrl: '/#dashboard',
    does: 'warranty task counts (new / open / fixed) for a division — the dashboard statistic',
    endpoint: '/api/Vendor/Dashboard/Statistic/{divisionId}/Warranty',
    params: [{ name: 'divisionId', type: 'string', required: true }] },
  { ...VS, id: 'vs_announcements', name: 'Vendor announcements', listUrl: '/#dashboard',
    does: 'a division\'s vendor announcements — title, message, dates, attachments',
    endpoint: '/api/Vendor/Announcement/{divisionId}',
    params: [{ name: 'divisionId', type: 'string', required: true }] },
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
    if (typeof v === 'string' && _SOLE_PLACEHOLDER.test(v.trim())) continue;   // v1405 — the LLM binder sometimes ECHOES a placeholder token ("{company}") as the value for a param it couldn't fill; drop it here so it's treated as unfilled everywhere (body + endpoint), never stored literally
    const t = props[k] && props[k].type;
    const gidKind = props[k] && props[k].gid;
    if (gidKind && (typeof v === 'string' || typeof v === 'number')) {   // CX-7c — a customer/variant id → its gid form
      out[k] = toShopifyGid(v, gidKind);
    } else if ((t === 'integer' || t === 'number') && typeof v === 'string') {
      const n = Number(v.replace(/[^0-9.\-]/g, ''));   // strip '#', spaces, stray text
      out[k] = Number.isFinite(n) && v.replace(/[^0-9.\-]/g, '') !== '' ? n : v;
    } else if (t === 'boolean') {   // v1342 (review I) — "false" must not serialize as a truthy string
      if (typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') {
        const s = v.trim().toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes') out[k] = true;
        else if (s === 'false' || s === '0' || s === 'no') out[k] = false;
        else out[k] = v;
      } else out[k] = !!v;
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
    const method = String(r.method || 'GET').toUpperCase();
    // A record's OWN `write` wins (a curated gql READ is a POST but write:false); else method-derive (a harvested §17
    // record may carry no `write`, and a non-GET must still class as a write, never silently a read). §9 fail-safe.
    const write = r.write === true || (r.write == null && method !== 'GET');
    // v2.74.1303 (CX-6) — writes ARE now projected (mode:'act' legs): the dispatch confirm-gates them AND the
    // SESSION_REPLAY handler fail-closes on `confirmed:true`, so a demonstrated "Create X" is selectable and can only
    // run through the HITL gate — a write reaching execution un-confirmed is refused at the boundary. (Was: reads-only skip.)
    // v2.74.1432 (Invariant #3) — SPREAD the whole record so recipeToLeg (the SINGLE field-reader) receives EVERY carried
    // marker (itemUrl/listUrl/gql/csrf/urlParam/persistedOp/shopProbe/verifyIdentity/identityProbe/pulse/drill) — not the
    // old hand-picked subset that silently dropped "show X" (itemUrl) + every non-cookie transport marker on the SEEDED
    // path. A new recipe field now flows here for free; only recipeFromCatalogEntry + recipeToLeg still need the field added.
    const leg = recipeToLeg({
      ...r,
      app,                                                             // derived from host — the per-Ground record carries no `app`
      origin: r.origin || host, method, write,
      destructive: r.destructive === true || r.safetyClass === 'destructive',
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
      const enriched = { ...leg, key: leg.key.includes('@') ? leg.key : `${leg.key}@${host}`, tool: { ...leg.tool, origin: host } };
      out.push(enriched);   // ride the SPECIFIC connected instance (host-suffixed key)
    }
  }
  return out;
}
