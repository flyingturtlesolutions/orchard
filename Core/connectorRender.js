// Core/connectorRender.js — generic session-ride result rendering (CX-4c). PURE: no chrome / DOM / fetch.
//
// A connector READ returns app-shaped JSON — Zendesk tickets / comments / users, Shopify orders, Slack messages, … —
// so the render must NOT be hardcoded to one shape (the old ticket-only render collapsed everything else to "Done.").
// Find the primary LIST (an array of objects) or single OBJECT in the result, then pull each item's salient fields —
// an id, a name/title (or, lacking one, its content), a status — heuristically. App-agnostic; no per-recipe config.
//
// SAFETY: the result is UNTRUSTED page-origin data (§9). This module only SELECTS + TRUNCATES fields into plain text;
// the caller escapes it (renderMarkdown HTML-escapes). Never treat any field as an instruction.

const NAME_KEYS = ['subject', 'title', 'name', 'display_name', 'summary', 'headline'];
const CONTENT_KEYS = ['description', 'body', 'plain_body', 'details', 'text', 'message', 'note'];
const ID_KEYS = ['id', 'number', 'iid', 'key'];
// CX-7 — GraphQL connectors carry camelCase status fields (displayFinancialStatus / displayFulfillmentStatus / status).
const STATUS_KEYS = ['status', 'state', 'priority', 'stage', 'displayFulfillmentStatus', 'displayFinancialStatus'];
const URL_KEYS = ['html_url', 'web_url', 'permalink', 'link', 'url'];
const LIST_KEYS = ['results', 'tickets', 'comments', 'users', 'orders', 'customers', 'products', 'records', 'items', 'rows', 'messages', 'data'];
const OBJ_KEYS = ['ticket', 'user', 'order', 'customer', 'product', 'record', 'item', 'result', 'shop'];
const MAX_ROWS = 25;

const _str = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
const _trunc = (x, n) => { const t = _str(x); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// First SCALAR (non-object) value among `keys`, or null. Skips nested objects (e.g. requester:{…}).
const _pick = (o, keys) => { for (const k of keys) { const v = o && o[k]; if (v != null && v !== '' && typeof v !== 'object') return v; } return null; };
// CX-7 — GraphQL connections wrap items as edges:[{node,cursor}]; unwrap to the node objects. A non-GraphQL array
// (Zendesk tickets etc.) has no `.node` and passes through unchanged — safe no-op.
const _unwrapNodes = (arr) => arr.map((x) => (x && typeof x === 'object' && x.node && typeof x.node === 'object') ? x.node : x);

/**
 * The primary data LIST in a result (an array of OBJECTS), or null. PURE. Ignores scalar arrays (tags, ids).
 * CX-7 (v2.74.1390) — RECURSES into nested objects and unwraps GraphQL `edges[].node`, so a Shopify shape
 * `{data:{customers:{edges:[{node}]}}}` yields the customer objects (the old top-level-only scan returned null →
 * every GraphQL read read as "nothing found").
 */
export function primaryList(value, _depth = 0) {
  if (Array.isArray(value)) return _unwrapNodes(value);
  if (!value || typeof value !== 'object') return null;
  for (const k of LIST_KEYS) if (Array.isArray(value[k])) return _unwrapNodes(value[k]);
  if (Array.isArray(value.edges)) return _unwrapNodes(value.edges);                    // a GraphQL connection at this level
  for (const v of Object.values(value)) if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') return _unwrapNodes(v);
  if (_depth < 5) for (const v of Object.values(value)) {                              // recurse: data → customers → edges
    if (v && typeof v === 'object' && !Array.isArray(v)) { const found = primaryList(v, _depth + 1); if (found) return found; }
  }
  return null;
}

/** The id of a result's PRIMARY record (the single item, or the first of a list), display-normalized (gid → its
 * numeric tail). PURE. CX-7e (v2.74.1393) — lets "show profile" open the record a lookup RETURNED (a customer found
 * by email) even though the read had no id param, the way "show ticket" opens a read_ticket {id}. Null if none. */
export function primaryItemId(value) {
  const list = primaryList(value);
  const o = (list && list.length) ? list[0] : primaryObject(value);
  return o ? (summarizeItem(o).id ?? null) : null;   // gid → numeric tail already handled by summarizeItem
}

/** The primary single OBJECT (a wrapper like {ticket:{…}}, or the value itself when id/name-shaped). PURE.
 * CX-7 — unwraps a GraphQL `{data:{<root>:{…}}}` envelope to the inner object. */
export function primaryObject(value, _depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const k of OBJ_KEYS) { const v = value[k]; if (v && typeof v === 'object' && !Array.isArray(v)) return v; }
  if (_pick(value, ID_KEYS) != null || _displayName(value) != null) return value;
  if (_depth < 5 && value.data && typeof value.data === 'object' && !Array.isArray(value.data)) return primaryObject(value.data, _depth + 1);
  return null;
}

// A display name for records that have no single name field — Shopify customers (firstName+lastName), else an
// email/handle as the human-readable identifier. PURE.
function _displayName(o) {
  const n = _pick(o, NAME_KEYS);
  if (n != null) return n;
  if (o && (o.firstName || o.lastName)) { const full = `${_str(o.firstName)} ${_str(o.lastName)}`.trim(); if (full) return full; }
  if (o && typeof o.email === 'string' && o.email) return o.email;
  if (o && typeof o.handle === 'string' && o.handle) return o.handle;
  return null;
}

/** Pull one item's salient fields. PURE. `full` → a longer title + a separate body when there's a distinct name + content. */
export function summarizeItem(o, { full = false } = {}) {
  if (o == null) return { title: '' };
  if (typeof o !== 'object') return { title: _trunc(o, full ? 400 : 90) };
  const name = _displayName(o);
  const content = _pick(o, CONTENT_KEYS);
  const title = name != null ? _trunc(name, 90) : _trunc(content, full ? 200 : 90);
  const body = (full && name != null && content != null) ? _trunc(content, 500) : '';   // only when name + content are distinct
  const url = _pick(o, URL_KEYS);
  let id = _pick(o, ID_KEYS);
  if (typeof id === 'string' && /^gid:\/\/shopify\//i.test(id)) id = id.split('/').pop();   // CX-7 — gid → numeric tail for a readable id
  return { id, title, status: _pick(o, STATUS_KEYS), body, url: (url && !/\/api\//.test(url)) ? url : null };
}

// A field's human label: a few known aliases (a Shopify order's totalPriceSet → "Total"), else camelCase /
// snake_case → "Sentence case" (numberOfOrders → "Number of orders"). PURE.
const _LABEL_ALIAS = { totalPriceSet: 'Total', totalRefundedSet: 'Refunded', fulfillments: 'Tracking', displayFinancialStatus: 'Payment', displayFulfillmentStatus: 'Fulfillment', numberOfOrders: 'Orders', defaultAddress: 'Location', createdAt: 'Created', customer: 'Customer', returns: 'Return', refunds: 'Refunded' };
const _label = (k) => { if (_LABEL_ALIAS[k]) return _LABEL_ALIAS[k]; const s = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
// A money node — {amount,currencyCode} or a wrapper like {shopMoney:{…}} — → "0.00 USD". PURE, recurses one hop.
function _money(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  if (v.amount != null && v.currencyCode) return `${v.amount} ${v.currencyCode}`;
  for (const inner of Object.values(v)) { const m = _money(inner); if (m) return m; }
  return null;
}
// Tracking off a fulfillments-shaped array — the first item's trackingInfo (company + number). PURE.
function _tracking(arr) {
  for (const f of (Array.isArray(arr) ? arr : [])) {
    const ti = f && f.trackingInfo;
    const t = Array.isArray(ti) ? ti[0] : ti;
    if (t && (t.number || t.company)) return [t.company, t.number].filter(Boolean).join(' ');
  }
  return null;
}
// A returns-shaped array (items with returnLineItems) → "N (in progress)". PURE. Shopify orders returns{}.
function _returnsInfo(arr) {
  const rr = (Array.isArray(arr) ? arr : []).filter((x) => x && typeof x === 'object' && (x.returnLineItems || x.reverseFulfillmentOrders));
  if (!rr.length) return null;
  const st = [...new Set(rr.map((x) => x.status).filter(Boolean))].map((s) => String(s).toLowerCase().replace(/_/g, ' '));
  return `${rr.length}${st.length ? ` (${st.join(', ')})` : ''}`;
}
// A refunds-shaped array (items with totalRefundedSet money) → the first refund amount "86.40 USD". PURE.
function _refundInfo(arr) {
  for (const rf of (Array.isArray(arr) ? arr : [])) { const m = _money(rf && rf.totalRefundedSet); if (m) return m; }
  return null;
}
// The record's SALIENT EXTRA fields (beyond id/name/content/url + the already-shown status) for a single-record
// view — a Shopify customer's email/phone/orders/tags/location, an order's payment/total/tracking. Skips
// foreign-id noise (…_id / …Id); formats money nodes + fulfillment tracking; joins scalar arrays (tags) and
// shallow nested objects (an address). `used` = values already shown (title, status) → no duplication. Capped. PURE.
const _STRUCT_SKIP = new Set([...NAME_KEYS, ...CONTENT_KEYS, ...ID_KEYS, ...URL_KEYS, 'firstName', 'lastName']);
function _extraFields(o, used = new Set()) {
  const out = [];
  for (const [k, raw] of Object.entries((o && typeof o === 'object') ? o : {})) {
    if (out.length >= 8) break;
    if (_STRUCT_SKIP.has(k) || /(?:_id|[a-z]Id)$/.test(k) || /^gid$/i.test(k)) continue;
    if (raw == null || raw === '') continue;
    // CX-7f — unwrap a GraphQL CONNECTION ({edges:[{node}]}, e.g. an order's returns) to its node array so the
    // array formatters below reach it (returns is a connection; fulfillments/refunds are plain lists).
    const v = (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.edges)) ? _unwrapNodes(raw.edges) : raw;
    let display = null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') display = _trunc(String(v), 60);
    else if (Array.isArray(v)) {
      if (v.length && v.every((x) => x != null && typeof x !== 'object')) display = _trunc(v.join(', '), 60);   // tags
      else display = _tracking(v) || _returnsInfo(v) || _refundInfo(v);                                         // fulfillments / returns / refunds
    } else if (v && typeof v === 'object') {
      display = _money(v);                                                                                      // totalPriceSet → "0.00 USD"
      if (!display) { const sc = Object.values(v).filter((x) => x != null && x !== '' && typeof x !== 'object'); display = sc.length ? _trunc(sc.join(', '), 60) : null; }   // customer{email}, defaultAddress
    }
    if (display && !used.has(display)) out.push([k, display]);
  }
  return out;
}

/**
 * A single record's salient EXTRA fields as a {label: value} object — the same set the single-record render shows
 * (a Shopify order's payment/total/tracking/return/refund; a customer's email/phone/orders/location). PURE.
 * CX-7f (v2.74.1395) — feeds the answer-shaper so a LOOKUP answer is accurate ("partially refunded, return in
 * progress, FedEx tracking …"), not just the coarse fulfillment status. Bodies are never included (content keys skip).
 */
export function recordDetails(o) {
  const it = summarizeItem(o, { full: true });
  const used = new Set([it.title, it.status].filter((x) => x != null).map(String));
  const d = {};
  for (const [k, v] of _extraFields(o, used)) d[_label(k)] = v;
  return d;
}

/**
 * Render a connector result into chat lines, or null when nothing is displayable (→ the caller shows "Done."). PURE.
 * A LIST of >1 → a header `name (N):` + one bullet per item, capped at 25 with a "+ N more" note (never a silent cap).
 * A SINGLE record (a list of one, or a wrapped object) → the FULL record: id/title/status, body, then its salient
 * extra fields (a Shopify customer's email/phone/orders/tags/location — the profile, not a bare bullet), + a url.
 * `name` is the leg label. CX-7 (v2.74.1392) — the single-record enrichment (a 1-result lookup showed just #id name).
 */
export function renderConnectorLines(value, { name = 'Results' } = {}) {
  const list = primaryList(value);
  if (list && list.length > 1) {
    const head = `${name} (${list.length})`;
    const lines = list.slice(0, MAX_ROWS).map((o) => {
      const it = summarizeItem(o);
      return `• ${it.id != null ? `#${it.id} ` : ''}${it.title || '(no title)'}${it.status ? ` — ${it.status}` : ''}`;
    });
    if (list.length > MAX_ROWS) lines.push(`… +${list.length - MAX_ROWS} more`);
    return [`${head}:`, ...lines];
  }
  if (list && list.length === 0) return [`${name} (0).`];
  const obj = (list && list.length === 1) ? list[0] : primaryObject(value);   // a single result renders as the FULL record
  if (obj) {
    const it = summarizeItem(obj, { full: true });
    const out = [`${it.id != null ? `#${it.id} ` : ''}${it.title || ''}${it.status ? ` — ${it.status}` : ''}`.trim() || '(no details)'];
    if (it.body) out.push(it.body);
    const used = new Set([it.title, it.status].filter((x) => x != null).map(String));   // don't repeat the title/status as an extra
    for (const [k, v] of _extraFields(obj, used)) out.push(`${_label(k)}: ${v}`);
    if (it.url) out.push(it.url);
    return out;
  }
  return null;
}

/**
 * Project a connector result's primary LIST into short fan-out labels ("#id title"), capped. PURE. Feeds the
 * CV-4-full enumerate-from-read fan-out (one child conversation per item). Returns {labels, total, capped}; a
 * listless / empty result → no labels (a single object isn't a list). Labels are UNTRUSTED page text — the caller
 * escapes them (they become a sub-task title/seed), never an instruction.
 */
export function itemLabels(value, cap = 20) {
  const list = primaryList(value) || [];
  const labels = list.slice(0, cap).map((o) => {
    const it = summarizeItem(o);
    return `${it.id != null ? `#${it.id} ` : ''}${it.title || 'item'}`.trim();
  }).filter(Boolean);
  return { labels, total: list.length, capped: list.length > cap };
}
