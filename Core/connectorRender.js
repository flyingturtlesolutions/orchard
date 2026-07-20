// Core/connectorRender.js — generic session-ride result rendering (CX-4c). PURE: no chrome / DOM / fetch.
//
// A connector READ returns app-shaped JSON — Zendesk tickets / comments / users, Shopify orders, Slack messages, … —
// so the render must NOT be hardcoded to one shape (the old ticket-only render collapsed everything else to "Done.").
// Find the primary LIST (an array of objects) or single OBJECT in the result, then pull each item's salient fields —
// an id, a name/title (or, lacking one, its content), a status — heuristically. App-agnostic; no per-recipe config.
//
// SAFETY: the result is UNTRUSTED page-origin data (§9). This module only SELECTS + TRUNCATES fields into plain text;
// the caller escapes it (renderMarkdown HTML-escapes). Never treat any field as an instruction.

const NAME_KEYS = ['subject', 'title', 'name', 'display_name', 'fullName', 'full_name', 'summary', 'headline'];   // v1469 — + fullName (an Aircall teammate row fell through to its email)
const CONTENT_KEYS = ['description', 'body', 'plain_body', 'details', 'text', 'message', 'note'];
const ID_KEYS = ['id', 'number', 'iid', 'key'];
// CX-7 — GraphQL connectors carry camelCase status fields (displayFinancialStatus / displayFulfillmentStatus / status).
const STATUS_KEYS = ['status', 'state', 'priority', 'stage', 'availabilityStatus', 'availability', 'displayFulfillmentStatus', 'displayFinancialStatus'];   // v1469 — + availability (the roster's WHOLE point was the status and the render dropped it)
const URL_KEYS = ['html_url', 'web_url', 'permalink', 'link', 'url'];
const LIST_KEYS = ['results', 'tickets', 'comments', 'users', 'orders', 'customers', 'products', 'records', 'items', 'rows', 'messages', 'data'];
const OBJ_KEYS = ['ticket', 'user', 'order', 'customer', 'product', 'record', 'item', 'result', 'shop'];
const MAX_ROWS = 25;

const _str = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();
const _trunc = (x, n) => { const t = _str(x); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
// First SCALAR (non-object) value among `keys`, or null. Skips nested objects (e.g. requester:{…}).
// CX-9g (v2.74.1440) — CASE-INSENSITIVE: app shapes PascalCase their fields (VendorSuite `Priority`/`TaskStatus`),
// and an exact-key vocab silently missed them ("priority" ∈ STATUS_KEYS never matched `Priority`).
const _pick = (o, keys) => {
  if (!o || typeof o !== 'object') return null;
  const lower = new Map(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of keys) { const v = lower.get(k.toLowerCase()); if (v != null && v !== '' && typeof v !== 'object') return v; }
  return null;
};
// CX-7 — GraphQL connections wrap items as edges:[{node,cursor}]; unwrap to the node objects. A non-GraphQL array
// (Zendesk tickets etc.) has no `.node` and passes through unchanged — safe no-op.
const _unwrapNodes = (arr) => arr.map((x) => (x && typeof x === 'object' && x.node && typeof x.node === 'object') ? x.node : x);

/**
 * The primary data LIST in a result (an array of OBJECTS), or null. PURE. Ignores scalar arrays (tags, ids).
 * CX-7 (v2.74.1390) — RECURSES into nested objects and unwraps GraphQL `edges[].node`, so a Shopify shape
 * `{data:{customers:{edges:[{node}]}}}` yields the customer objects (the old top-level-only scan returned null →
 * every GraphQL read read as "nothing found").
 */
// CX-9h (v2.74.1441) — is this object ITSELF a record (an id-shaped / suffix-id-shaped / named thing)? Such a root is a
// SINGLE RECORD whose nested object-arrays are CHILD collections (a warranty task's Appointments, a ticket's
// custom_fields) — never "the data list". Live bug: the generic any-object-array hunt returned the task detail's
// Appointments[1], so the drilled answer rendered the APPOINTMENT (start/end + IsCanceled booleans) and the user got
// "no warranty details" twice — the render never even saw the task object.
const _recordShaped = (o) => !!(o && typeof o === 'object' && !Array.isArray(o) && (_pick(o, ID_KEYS) != null || _suffixId(o) != null || _displayName(o) != null));

export function primaryList(value, _depth = 0) {
  if (Array.isArray(value)) return _unwrapNodes(value);
  if (!value || typeof value !== 'object') return null;
  for (const k of LIST_KEYS) if (Array.isArray(value[k])) return _unwrapNodes(value[k]);
  if (Array.isArray(value.edges)) return _unwrapNodes(value.edges);                    // a GraphQL connection at this level
  if (_recordShaped(value)) return null;                                              // CX-9h — a record root is NOT a list container (its arrays are children)
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

/** CX-7f (v2.74.1404) — the id of the record a WRITE just created, for post-write navigation ("create customer" →
 * "show customer" opens the new record). A Shopify mutation nests it at data.<op>.<entity>.id (e.g.
 * customerCreate.customer.id / draftOrderCreate.draftOrder.id) — which the read-shaped primaryObject doesn't unwrap.
 * Dig data → each op-result → its first nested object that ISN'T `userErrors` → an `id`; gid → numeric tail (the
 * admin URL uses the numeric id). PURE. Null when the reply carries no created record. */
export function createdRecordId(value) {
  const data = (value && typeof value === 'object' && value.data && typeof value.data === 'object') ? value.data : null;
  if (!data) return null;
  for (const op of Object.values(data)) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) continue;
    for (const [k, v] of Object.entries(op)) {
      if (k === 'userErrors') continue;
      let id = (v && typeof v === 'object' && !Array.isArray(v)) ? v.id : (k === 'id' ? v : null);
      if (id == null) continue;
      if (typeof id === 'string' && /^gid:\/\/shopify\//i.test(id)) id = id.split('/').pop();   // gid → numeric tail (matches primaryItemId)
      return id;
    }
  }
  return null;
}

/** The primary single OBJECT (a wrapper like {ticket:{…}}, or the value itself when id/name-shaped). PURE.
 * CX-7 — unwraps a GraphQL `{data:{<root>:{…}}}` envelope to the inner object. */
export function primaryObject(value, _depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  for (const k of OBJ_KEYS) { const v = value[k]; if (v && typeof v === 'object' && !Array.isArray(v)) return v; }
  if (_recordShaped(value)) return value;   // CX-9h (v1441) — suffix-id shapes (TaskId/TaskNumber…) count as record-shaped, same predicate as primaryList's stop
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

// CX-9c (v2.74.1436) — generic id fallback for app-shaped rows carrying NO exact ID_KEYS (a VendorSuite warranty row:
// TaskId/TaskNumber/ClaimNumber…). Prefer a `…Number` key (the HUMAN number the site shows — TaskNumber "4090740")
// over a `…Id` key (the internal join key); first key in record order wins (the entity's own field precedes foreign
// ones in every shape seen). Scalars only. PURE.
function _suffixId(o) {
  for (const suf of [/[a-z]Number$/, /[a-z]Id$/]) {
    for (const [k, v] of Object.entries(o)) { if (suf.test(k) && v != null && v !== '' && typeof v !== 'object') return v; }
  }
  return null;
}

/** Pull one item's salient fields. PURE. `full` → a longer title + a separate body when there's a distinct name +
 *  content. `displayId` (CX-9k, v2.74.1617) — recipe-declared HUMAN id key(s), preference-ordered: tried EXACTLY and
 *  FIRST, because the generic scans below can land on the wrong number (a VS warranty row's first `…Number` field is
 *  the per-home claim sequence — every list bullet read "#01"). Shape knowledge belongs to the recipe, not a heuristic. */
export function summarizeItem(o, { full = false, displayId = null } = {}) {
  if (o == null) return { title: '' };
  if (typeof o !== 'object') return { title: _trunc(o, full ? 400 : 90) };
  const name = _displayName(o);
  const content = _pick(o, CONTENT_KEYS);
  const title = name != null ? _trunc(name, 90) : _trunc(content, full ? 200 : 90);
  const body = (full && name != null && content != null) ? _trunc(content, 500) : '';   // only when name + content are distinct
  const url = _pick(o, URL_KEYS);
  let id = null;
  for (const k of (Array.isArray(displayId) ? displayId : [])) {   // CX-9k — declared keys win; first present scalar
    const v = o[k]; if (v != null && v !== '' && typeof v !== 'object') { id = v; break; }
  }
  if (id == null) id = _pick(o, ID_KEYS);
  if (id == null) id = _suffixId(o);   // CX-9c — …Number/…Id suffix fallback (TaskNumber) when no exact id key exists
  if (typeof id === 'string' && /^gid:\/\/shopify\//i.test(id)) id = id.split('/').pop();   // CX-7 — gid → numeric tail for a readable id
  return { id, title, status: _pick(o, STATUS_KEYS), body, url: (url && !/\/api\//.test(url)) ? url : null };
}

// ── DK-3 (DESIGN_desks.md §6) — the federated WorkItem ────────────────────────────────────────────────────────────
// One row from ANY connected site → { source, id, subject, state, owner, url, corrKeys[] }. summarizeItem already
// yields id/subject/state/url app-agnostically; DK-3 adds `source` (which connection the row came from — passed in,
// not in the row), `owner` (who's WORKING it), and `corrKeys` (email / phone / order-no → the JOIN across sites: a
// call ↔ warranty ↔ ticket ↔ order sharing a key are ONE issue). corrKeys are typed + normalized ("email:a@b.com" /
// "phone:4045551234" / "order:1001") for EXACT grouping (§9 — start exact, no fuzzy merges). The OWNER's own contact
// is deliberately excluded (else every item an agent touches would merge), and free-text BODIES are never mined
// (the §8 privacy lever — corrKeys come only from structured identity fields).
const OWNER_KEYS = ['assignee', 'assignee_name', 'assigneeName', 'agent', 'agent_name', 'agentName', 'owner', 'owner_name', 'ownerName', 'assigned_to', 'assignedTo', 'rep', 'handledBy'];
const _OWNER_KEY = /assign|agent|owner|handled|(^|_)reps?($|_)/i;
const _CONTENT_SET = new Set(CONTENT_KEYS.map((k) => k.toLowerCase()));
const _EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const _ORDERHASH_RE = /^#(\d{3,})$/;
const _PHONE_KEY = /phone|(^|[^a-z])tel($|[^a-z])|msisdn|e164|mobile|caller/i;
const _ORDER_KEY = /order[_\s]?(number|no|id|name)|ordernumber|orderno/i;
const _normPhone = (v) => { const d = String(v).replace(/\D+/g, ''); return (d.length === 11 && d[0] === '1') ? d.slice(1) : d; };   // US: drop the country-code 1 so "+1 404…" ≡ "(404)…"

// The OWNER — who's working the item (agent/assignee/rep), scalar-first then one nested hop (Zendesk assignee:{name}).
// NOT the requester/customer (that's a correlation key). PURE. '' when none.
function _owner(o) {
  if (!o || typeof o !== 'object') return '';
  const v = _pick(o, OWNER_KEYS);
  if (v != null) return _trunc(v, 80);
  const lower = new Map(Object.entries(o).map(([k, val]) => [k.toLowerCase(), val]));
  for (const k of OWNER_KEYS) {
    const nv = lower.get(k.toLowerCase());
    if (nv && typeof nv === 'object' && !Array.isArray(nv)) { const n = _displayName(nv) || (typeof nv.email === 'string' ? nv.email : null); if (n) return _trunc(n, 80); }
  }
  return '';
}

// The correlation keys — email / phone / order-no that JOIN this item to items on OTHER sites. Typed + normalized +
// deduped + sorted (deterministic). Scans the row's scalar leaves (top + one nested hop); SKIPS owner-ish subtrees (an
// agent's own email/line is never a join key) and free-text body fields (privacy). PURE. Capped at 8.
function _corrKeys(o) {
  if (!o || typeof o !== 'object') return [];
  const keys = new Set();
  const scan = (obj, depth, ownerCtx) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || depth > 1) return;
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      const ownerHere = ownerCtx || _OWNER_KEY.test(k);
      if (typeof v === 'object') { scan(v, depth + 1, ownerHere); continue; }
      if (ownerHere || _CONTENT_SET.has(k.toLowerCase())) continue;   // agent's own contact / free-text body → never a join key
      const s = String(v);
      const em = s.match(_EMAIL_RE); if (em) keys.add(`email:${em[0].toLowerCase()}`);
      if (_PHONE_KEY.test(k)) { const p = _normPhone(s); if (p.length >= 7 && p.length <= 15) keys.add(`phone:${p}`); }
      if (_ORDER_KEY.test(k)) { const d = s.replace(/\D+/g, ''); if (d) keys.add(`order:${d}`); }
      const oh = s.match(_ORDERHASH_RE); if (oh) keys.add(`order:${oh[1]}`);
    }
  };
  scan(o, 0, false);
  return [...keys].sort().slice(0, 8);
}

/**
 * DK-3 (DESIGN_desks.md §6) — ONE app-shaped row → a normalized federated WorkItem. `source` is the connection it came
 * from (label/origin; not in the row). PURE. The unit DK-4's federated sweep groups by `corrKeys` into cross-site issues.
 */
export function toWorkItem(row, { source = '', full = false } = {}) {
  const s = summarizeItem(row, { full });
  return {
    source: _str(source),
    id: s.id != null ? _str(s.id) : '',
    subject: s.title || '',
    state: s.status != null ? _str(s.status) : '',
    owner: _owner(row),
    url: s.url || '',
    corrKeys: _corrKeys(row),
  };
}

/**
 * DK-3 — a whole read RESULT (any app shape) → WorkItem[]: find the primary list (or single object) the way the render
 * does, map each row through toWorkItem, capped at MAX_ROWS. PURE. This is what DK-4 calls per connection before grouping.
 */
export function toWorkItems(result, { source = '', full = false } = {}) {
  const list = primaryList(result);
  const rows = (list && list.length) ? list : (primaryObject(result) ? [primaryObject(result)] : []);
  return rows.slice(0, MAX_ROWS).map((r) => toWorkItem(r, { source, full }));
}

/**
 * CX-9c (v2.74.1436) — an item's compact GENERIC field projection: [label, value] pairs from the same `_extraFields`
 * machinery the single-record view uses (scalars + formatted money/tracking; content BODIES never included — the
 * privacy lever holds), capped. The LIST twin of `recordDetails`: a row whose shape matches no known vocabulary
 * (VendorSuite: AddressLine1/ClaimNumber/Age/AllowedAmount…) still renders/answers with its real fields instead of
 * an empty husk — the live "records shown are empty" class. PURE.
 */
export function itemFields(o, { max = 5 } = {}) {
  if (!o || typeof o !== 'object') return [];
  const it = summarizeItem(o);
  const used = new Set([it.title, it.status, it.id].filter((x) => x != null && x !== '').map(String));
  return _extraFields(o, used, { max }).map(([k, v]) => [_label(k), v]);   // CX-9g — _extraFields now ranks internally (rank-then-cap, both paths)
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
const _STRUCT_SKIP = new Set([...NAME_KEYS, ...CONTENT_KEYS, ...ID_KEYS, ...URL_KEYS, 'firstName', 'lastName'].map((k) => k.toLowerCase()));
// CX-9g (v2.74.1440) — rank a DISPLAY value: 0 = human TEXT (multi-word — instructions, an address), 1 = wordish
// (a status token, a date), 2 = bare numbers. Shared by the list + single-record paths.
const _fieldRank = (v) => { const s = String(v); return (/\s/.test(s) && /[a-z]/i.test(s)) ? 0 : (/[a-z]/i.test(s) ? 1 : 2); };
// CX-9g (v2.74.1440) — the cap now runs AFTER ranking, not during the walk. The live miss: a warranty DETAIL carries
// 25+ fields with Priority/Instructions/VendorExplanation at the TAIL, and the old walk-order cap-8 filled up on
// SearchField + booleans before ever REACHING them — the one answer the user asked for was structurally unshowable.
// Now: collect every displayable field (bounded), rank human-text-first, THEN cap; long text keeps 200 chars (an
// instruction truncated at 60 was useless). Bodies (CONTENT_KEYS) still never ride — the privacy lever holds.
function _extraFields(o, used = new Set(), { max = 8 } = {}) {
  const all = [];
  for (const [k, raw] of Object.entries((o && typeof o === 'object') ? o : {})) {
    if (all.length >= 40) break;   // pathological-shape guard only — generous, so tail fields still make the ranking
    if (_STRUCT_SKIP.has(k.toLowerCase()) || /(?:_id|[a-z]Id)$/.test(k) || /^gid$/i.test(k)) continue;
    if (/^search/i.test(k)) continue;   // CX-9i — a Search* field is a search-INDEX blob ("|3955 gallery chase|217710000|…"), never display data (real VS shape)
    if (raw == null || raw === '') continue;
    // CX-7f — unwrap a GraphQL CONNECTION ({edges:[{node}]}, e.g. an order's returns) to its node array so the
    // array formatters below reach it (returns is a connection; fulfillments/refunds are plain lists).
    const v = (raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.edges)) ? _unwrapNodes(raw.edges) : raw;
    let display = null;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      display = _trunc(String(v), (typeof v === 'string' && /\s/.test(v.trim())) ? 400 : 60);   // CX-9g/9i — TEXT keeps a real excerpt (400: a vendor explanation's CONCLUSION lives at the end — 200 cut it)
    } else if (Array.isArray(v)) {
      if (v.length && v.every((x) => x != null && typeof x !== 'object')) display = _trunc(v.join(', '), 60);   // tags
      else {
        display = _tracking(v) || _returnsInfo(v) || _refundInfo(v);                                            // fulfillments / returns / refunds
        // CX-9g — GENERIC array-of-objects fallback (a warranty task's Appointments): the first row's scalars,
        // "+N more" when several — never a silently skipped field.
        if (!display && v.length && v[0] && typeof v[0] === 'object') {
          const sc = Object.values(v[0]).filter((x) => x != null && x !== '' && typeof x !== 'object');
          if (sc.length) display = `${_trunc(sc.join(', '), 90)}${v.length > 1 ? ` (+${v.length - 1} more)` : ''}`;
        }
      }
    } else if (v && typeof v === 'object') {
      display = _money(v);                                                                                      // totalPriceSet → "0.00 USD"
      if (!display) { const sc = Object.values(v).filter((x) => x != null && x !== '' && typeof x !== 'object'); display = sc.length ? _trunc(sc.join(', '), 60) : null; }   // customer{email}, defaultAddress
    }
    if (display && !used.has(display)) all.push([k, display]);
  }
  // CX-9i — a MONEY-ish key (Amount/Total/Price/Cost) ranks as wordish (1), not bare-number (2): the payable amount
  // must survive the cap on a field-heavy record (live: AllowedAmount 214 was cut while three booleans made it).
  const rank = ([k, v]) => { const r = _fieldRank(v); return (r === 2 && /amount|total|price|cost(?!\s*code)/i.test(k)) ? 1 : r; };
  return all
    .map((pair, i) => [rank(pair), i, pair])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .slice(0, Math.max(0, max | 0))
    .map(([, , pair]) => pair);
}

/**
 * A single record's salient EXTRA fields as a {label: value} object — the same set the single-record render shows
 * (a Shopify order's payment/total/tracking/return/refund; a customer's email/phone/orders/location). PURE.
 * CX-7f (v2.74.1395) — feeds the answer-shaper so a LOOKUP answer is accurate ("partially refunded, return in
 * progress, FedEx tracking …"), not just the coarse fulfillment status. Bodies are never included (content keys skip).
 */
export function recordDetails(o) {
  const it = summarizeItem(o, { full: true });
  // CX-9g (v1440) — the id joins `used` (the …Number fallback id would otherwise re-render as an extra field), and a
  // single record gets a BIGGER budget (12): one record's answer deserves its instructions, not just its booleans.
  const used = new Set([it.title, it.status, it.id].filter((x) => x != null && x !== '').map(String));
  const d = {};
  for (const [k, v] of _extraFields(o, used, { max: 12 })) d[_label(k)] = v;
  return d;
}

/**
 * Render a connector result into chat lines, or null when nothing is displayable (→ the caller shows "Done."). PURE.
 * A LIST of >1 → a header `name (N):` + one bullet per item, capped at 25 with a "+ N more" note (never a silent cap).
 * A SINGLE record (a list of one, or a wrapped object) → the FULL record: id/title/status, body, then its salient
 * extra fields (a Shopify customer's email/phone/orders/tags/location — the profile, not a bare bullet), + a url.
 * `name` is the leg label. CX-7 (v2.74.1392) — the single-record enrichment (a 1-result lookup showed just #id name).
 */
export function renderConnectorLines(value, { name = 'Results', displayId = null } = {}) {
  const list = primaryList(value);
  if (list && list.length > 1) {
    const head = `${name} (${list.length})`;
    const lines = list.slice(0, MAX_ROWS).map((o) => {
      const it = summarizeItem(o, { displayId });
      // CX-9c (v2.74.1436) — a row with NO recognized name/status (an app shape outside the key vocabulary, e.g. a
      // VendorSuite warranty row) falls back to its generic fields ("3955 Gallery Chase · Cumming, GA 30028 · …")
      // instead of a dead "(no title)" bullet — the list twin of the single-record enrichment.
      const label = it.title || itemFields(o, { max: 4 }).map(([, v]) => v).join(' · ') || '(no title)';
      return `• ${it.id != null ? `#${it.id} ` : ''}${label}${it.status ? ` — ${it.status}` : ''}`;
    });
    if (list.length > MAX_ROWS) lines.push(`… +${list.length - MAX_ROWS} more`);
    return [`${head}:`, ...lines];
  }
  if (list && list.length === 0) return [`${name} (0).`];
  const obj = (list && list.length === 1) ? list[0] : primaryObject(value);   // a single result renders as the FULL record
  if (obj) {
    const it = summarizeItem(obj, { full: true, displayId });
    const out = [`${it.id != null ? `#${it.id} ` : ''}${it.title || ''}${it.status ? ` — ${it.status}` : ''}`.trim() || '(no details)'];
    if (it.body) out.push(it.body);
    const used = new Set([it.title, it.status, it.id].filter((x) => x != null && x !== '').map(String));   // don't repeat the title/status/id as an extra
    for (const [k, v] of _extraFields(obj, used, { max: 12 })) out.push(`${_label(k)}: ${v}`);   // CX-9g — the single-record budget
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
    const label = it.title || itemFields(o, { max: 2 }).map(([, v]) => v).join(' · ') || 'item';   // CX-9c — generic-fields fallback (fan-out labels for vocabulary-less rows)
    return `${it.id != null ? `#${it.id} ` : ''}${label}`.trim();
  }).filter(Boolean);
  return { labels, total: list.length, capped: list.length > cap };
}

/**
 * DK-8e (v2.74.1496) — the fan-out's STRUCTURED items: a spawned CASE carries its RECORD + identity, never just a
 * display label (live: each case held only "This case handles: #01 Eastern PA · …" — no fields, no ids — so "task
 * details" re-fetched from a mangled label and mis-resolved the division). Per row:
 *   label  — the human title WITHOUT a leading #id (an id/index prefix poisoned division resolution),
 *   detail — bounded "Key: value" lines: the display id + status + the record's salient fields (recordDetails —
 *            bodies never included) + every scalar `…Id` join key (TaskId etc. — the deterministic drill identity).
 * Labels/details are UNTRUSTED page text — callers fence them as data, never instructions.
 */
/**
 * DK-8f (v2.74.1497) — ONE record → dossier lines ("Key: value"), shared by the fan-out's row projection AND the
 * drilled DETAIL record: display id + status + the salient fields (recordDetails — bodies never included) + every
 * scalar `…Id` join key. `max` caps the line count (a drilled full record earns a bigger budget than a list row). PURE.
 */
export function dossierLines(o, { max = 16, displayId = null } = {}) {
  if (!o || typeof o !== 'object') return [];
  const it = summarizeItem(o, { full: true, displayId });   // CX-9k — the case dossier's "Id:" line shows the HUMAN number too (live 194814: every case read "Id: 01")
  const lines = [];
  if (it.id != null && it.id !== '') lines.push(`Id: ${it.id}`);
  if (it.status != null && it.status !== '') lines.push(`Status: ${it.status}`);
  for (const [k, v] of Object.entries(recordDetails(o))) lines.push(`${k}: ${v}`);
  for (const [k, v] of Object.entries(o)) {   // the internal join keys (TaskId …) — recordDetails may rank them out
    if (/[a-z]Id$/.test(k) && v != null && v !== '' && typeof v !== 'object' && !lines.some((l) => l.toLowerCase().startsWith(`${_label(k).toLowerCase()}:`))) lines.push(`${_label(k)}: ${v}`);
  }
  // DK-8g (v2.74.1498) — the record's own NARRATIVE (description / notes / vendor explanation — content-classed
  // fields recordDetails deliberately excludes as the SWEEP-prompt privacy lever). A case's dossier is the item's
  // own working file — its narrative belongs IN it (bounded; the caller fences it as data, never instructions).
  if (it.body) lines.push(`Notes: ${it.body.slice(0, 400)}`);
  for (const [k, v] of Object.entries(o)) {   // long text fields under non-standard names (VendorExplanation …)
    if (typeof v === 'string' && v.length >= 40 && !/^https?:\/\//.test(v) && !lines.some((l) => l.toLowerCase().startsWith(`${_label(k).toLowerCase()}:`)) && /explan|reason|note|comment|instruct|descript/i.test(k)) {
      lines.push(`${_label(k)}: ${v.slice(0, 400)}`);
    }
  }
  return lines.slice(0, max);
}

/**
 * v2.74.1562 — fold a record's TRUTHY boolean role flags into role WORDS ("IsPrimary,IsBuyer,IsDrHorton" →
 * ["Primary", "Buyer", "Dr Horton"]). The contact TYPE lives in these flags on apps that model roles as Is*
 * booleans (VendorSuite contacts: primary homeowner vs the DR Horton CS rep) — deriving the words is pure
 * mechanics, no site knowledge. Status-class info (same privacy tier as `status`). PURE.
 */
export function roleFlags(o, { max = 4 } = {}) {
  const out = [];
  for (const [k, v] of Object.entries((o && typeof o === 'object') ? o : {})) {
    if (v !== true || !/^[Ii]s(?=[_A-Z])/.test(k)) continue;   // IsPrimary / isBuyer / is_primary — never "island" (the flag body must start upper/underscore)
    const w = k.replace(/^is[_-]?/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    if (w) out.push(w.charAt(0).toUpperCase() + w.slice(1));
    if (out.length >= max) break;
  }
  return out;
}

export function fanoutItems(value, cap = 20, { displayId = null } = {}) {
  const list = primaryList(value) || [];
  const items = list.slice(0, cap).map((o) => {
    const it = summarizeItem(o, { displayId });
    const label = (it.title || itemFields(o, { max: 2 }).map(([, v]) => v).join(' · ') || 'item').trim();
    return { label, detail: dossierLines(o, { displayId }).join('\n'), row: o };   // DK-8f — the RAW row rides too (the drill's join key source)
  }).filter((x) => x.label);
  return { items, total: list.length, capped: list.length > cap };
}

/**
 * DK-8i (v2.74.1501) — the desk's META description of a case spawn: the desk transcript is the operator's LEDGER
 * ("what was accomplished"), never the record dump (the rows live in the cases). PURE.
 * "Found 13 items from “Warranty tasks by status” → opened the first as a case: “Magnolia Bay …” — nested under
 * “Warranty desk” in the rail. Open it to work it."
 * @param {{ found?:number, opened?:number, capped?:boolean, source?:string, deskTitle?:string, titles?:string[] }} args
 * @returns {string}
 */
export function fanoutSummary({ found = 0, opened = 0, skipped = 0, capped = false, source = '', deskTitle = '', titles = [] } = {}) {
  const src = source ? ` from “${source}”` : '';
  // DK-8k (v2.74.1504) — the ALREADY-OPEN reasoning: a re-run that finds its case(s) open says so instead of
  // silently duplicating (the live round: run 2 spawned a second identical case) or reading as a failure.
  if (!opened && skipped) {
    return `Found ${found} item${found === 1 ? '' : 's'}${src} — ${skipped === 1 ? 'it’s already open as a case' : `all ${skipped} are already open as cases`} under “${deskTitle}”. Nothing new to open.`;
  }
  if (!opened) return 'Couldn’t open any cases.';
  const few = (Array.isArray(titles) && titles.length === opened && opened <= 3)
    ? titles.map((t) => `“${String(t)}”`).join(', ') : '';
  const openedTxt = opened === 1
    ? `opened ${capped ? 'the first' : (found === 1 ? 'it' : 'one')} as a case${few ? `: ${few}` : ''}`
    : `opened ${capped ? `the first ${opened}` : (opened === found ? 'each' : String(opened))} as cases${few ? ` (${few})` : ''}`;
  const skipTxt = skipped ? ` (${skipped} already open, skipped)` : '';
  return `Found ${found} item${found === 1 ? '' : 's'}${src} → ${openedTxt}${skipTxt} — nested under “${deskTitle}” in the rail. ${opened === 1 ? 'Open it to work it.' : 'Open any to work it.'}`;
}
