// Core/audit.js — AU-0 (DESIGN_audit.md §11): the PURE core of the creates-audit ledger — "a durable, queryable
// record of everything Orchard makes". The store (Services/Storage/AuditCreateStore.js) wraps these; the seam
// (background/handlers/audit.js `recordCreate`) calls, in order: auditSucceeded → classifyCreate → createRecordFrom
// → auditEntry → the store. PURE: no DOM, no chrome, and NO `Date.now()` — the clock is passed IN (`at`), so this
// module and its tests stay deterministic (the seam supplies `Date.now()`). Mirrors Core/runHistory.js.
//
// v1 is CREATES-ONLY (§10.0): the update/delete writes-expansion is AU-6. The load-bearing piece here is
// `auditSucceeded` — the phantom-row guard (§10.1): a 200-with-nested-`userErrors` reaches the SESSION_REPLAY-ok
// seam as `ok:true` (connector.js:1844 has no nested-userErrors screen, unlike INVOKE_SESSION's :1263-1280), so a
// naive hook would bank a "created" row for a create the vendor REFUSED. This screen, lifted to a pure function
// both seams can call, is what stops a row from being born false.

import { createdRecordId, createdRecordLabel } from './connectorRender.js';

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

export const AUDIT_VERBS = Object.freeze(['create']);                 // v1; update/delete arrive at AU-6
export const AUDIT_KINDS = Object.freeze(['customer', 'order', 'draft', 'ticket', 'user', 'record']);  // unknown → 'record'
export const AUDIT_WHO = Object.freeze(['human', 'gate']);            // clearedBy: a person clicked vs pipelineGate auto
export const AUDIT_CAP = 500;   // GLOBAL book — creates are human-gated + rare, so a generous cap with a VISIBLE
                                // total (truncationNotice) is honest; never the action-ledger's silent slice(-500).

// The reversible/destructive axes do NOT separate create from update (both are write:true) — so `kind`/`verb` come
// from the reply's DATA FIELD KEY (the GraphQL op name), else the recipeId (§10.3). PURE string maps, no invention.
function _kindFromOpKey(opKey) {
  const k = String(opKey || '').toLowerCase();
  if (k.includes('draftorder')) return 'draft';                       // draftOrderCreate → a #D draft
  if (k.includes('customer')) return 'customer';
  if (k.includes('order')) return 'order';                            // orderCreate → a real order
  if (k.includes('ticket')) return 'ticket';
  if (k.includes('user')) return 'user';
  return '';
}
function _kindFromRecipeId(recipeId) {
  const r = String(recipeId || '').toLowerCase();
  if (r.includes('draft') || r.includes('create_order')) return 'draft';   // shopify_create_order makes a DRAFT
  if (r.includes('customer')) return 'customer';
  if (r.includes('order')) return 'order';
  if (r.includes('ticket')) return 'ticket';
  if (r.includes('user')) return 'user';
  return '';
}
function _opKeys(value) {
  const data = (value && typeof value === 'object' && value.data && typeof value.data === 'object') ? value.data : null;
  return data ? Object.keys(data) : [];
}

/**
 * Classify a create reply into {verb, kind}. PURE. `verb` is 'create' in v1 (the seam only hooks creates); `kind`
 * from the reply op key (preferred — the mutation names the entity), else the recipeId, else 'record'. `system`
 * is NOT derivable from the reply body — the caller sets it from the evt origin/apiHost.
 * @param {object} replyValue  the mutation reply value (GraphQL `{data:…}` or a REST `{ticket:{…}}`)
 */
export function classifyCreate(replyValue, recipeId, _method) {
  let kind = '';
  for (const ok of _opKeys(replyValue)) { kind = _kindFromOpKey(ok); if (kind) break; }
  if (!kind) kind = _kindFromRecipeId(recipeId);
  if (!AUDIT_KINDS.includes(kind)) kind = 'record';
  return { verb: 'create', kind };
}

// A human label for a REST-created record that carries no `.data` envelope ({ticket:{id,subject}} / {user:{name}}).
function _restLabel(v) {
  for (const f of ['name', 'title', 'subject', 'number']) {
    const nm = v[f];
    if (typeof nm === 'string' && nm.trim() && nm.trim().length <= 40) return nm.trim();
  }
  return '';
}

/**
 * {id, label} of the record a write just created — GraphQL first (reuses createdRecordId/createdRecordLabel,
 * connectorRender.js:135/:156, which dig `data.<op>.<entity>`), then a non-`.data` REST branch (Zendesk
 * `{ticket:{id,subject}}` / `{user:{id,name}}`). gid → numeric tail. PURE. Null when no id can be extracted.
 */
export function createRecordFrom(value) {
  const gid = createdRecordId(value);                                 // GraphQL {data:…} shape
  if (gid != null) return { id: String(gid), label: createdRecordLabel(value) || String(gid) };
  const o = (value && typeof value === 'object' && !Array.isArray(value)) ? value : null;   // REST {entity:{…}}
  if (o) {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'data' || k === 'errors') continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && v.id != null) {
        let id = v.id;
        if (typeof id === 'string' && /^gid:\/\/shopify\//i.test(id)) id = id.split('/').pop();
        return { id: String(id), label: _restLabel(v) || String(id) };
      }
    }
  }
  return null;
}

/**
 * THE SUCCESS PREDICATE (§10.1) — the phantom-row guard as a PURE function. A row is banked ONLY when this
 * returns true. Rejects: a top-level GraphQL `errors[]`, a nested `data.<op>.userErrors[]` (mirrors
 * connector.js:1274-1278 — the screen SESSION_REPLAY-ok lacks), and a reply from which no created id extracts.
 * A vendor-REFUSED mutation `{data:{draftOrderCreate:{draftOrder:null,userErrors:[…]}}}` → false → banks nothing.
 */
export function auditSucceeded(value) {
  const v = (value && typeof value === 'object') ? value : null;
  if (!v) return false;
  if (Array.isArray(v.errors) && v.errors.length) return false;       // top-level GraphQL errors
  if (v.data && typeof v.data === 'object') {                         // nested userErrors on any op
    for (const node of Object.values(v.data)) {
      if (node && typeof node === 'object' && Array.isArray(node.userErrors) && node.userErrors.length) return false;
    }
  }
  const rec = createRecordFrom(v);                                    // must have produced a real id
  return !!(rec && rec.id);
}

/**
 * The §10.5 minimal human customer label, from the create INPUT (not the reply — a customer reply carries no
 * name/title). First name, else email-local-part, else name; truncated ≤24. Same full-fidelity-at-rest posture as
 * the #D-number (§5, local-only). PURE. Null when the input carries no human handle. Only used when kind==='customer'.
 */
export function customerLabelFrom(params) {
  const p = (params && typeof params === 'object') ? params : null;
  if (!p) return null;
  const first = _str(p.firstName || p.first_name);
  if (first) return first.slice(0, 24);
  const email = _str(p.email);
  if (email.includes('@')) return email.split('@')[0].slice(0, 24);
  const name = _str(p.name);
  if (name) return name.slice(0, 24);
  return null;
}

/**
 * Normalize one audit event into the stored entry. PURE, field-whitelist (the runHistory.js:148 idiom): drops
 * unknown keys, coerces types, falls unknown verb/kind/who to the safe value rather than storing raw. `at` is
 * passed IN (never Date.now() here). `system` is the origin/apiHost (the human system name).
 * @returns {{at:number, system:string, verb:string, kind:string, id:string, label:string, who:string,
 *           itemUrl?:string, recipeId?:string, groundId?:string}}
 */
export function auditEntry(f = {}) {
  const at = Number.isFinite(f.at) && f.at > 0 ? f.at : 0;
  return {
    at,
    system: _str(f.system || f.origin).slice(0, 80),
    verb: AUDIT_VERBS.includes(f.verb) ? f.verb : 'create',
    kind: AUDIT_KINDS.includes(f.kind) ? f.kind : 'record',
    id: _str(f.id).slice(0, 80),
    label: _str(f.label).slice(0, 80),
    who: AUDIT_WHO.includes(f.who) ? f.who : 'gate',
    ...(f.itemUrl ? { itemUrl: _str(f.itemUrl).slice(0, 400) } : {}),     // AU-2 — a pre-filled durable link, if the caller had one
    ...(f.recipeId ? { recipeId: _str(f.recipeId).slice(0, 60) } : {}),   // join key to the catalog (+ the leg's itemUrl template at render)
    ...(f.groundId ? { groundId: _str(f.groundId).slice(0, 60) } : {}),
    ...(_capUrlArgs(f.urlArgs) ? { urlArgs: _capUrlArgs(f.urlArgs) } : {}),   // AU-2 — the fill ingredients ({handle}…) to resolve itemUrl at render
  };
}

// A small, string-valued snapshot of the endpoint args ({handle}, …) so the surface can fill the leg's itemUrl at
// render — durable across reload AND catalog-upgradeable (a new itemUrl template reaches old rows). Caps the object
// so a stray large bag can't bloat the book; string values only (no nested objects). PURE. Null when nothing usable.
function _capUrlArgs(raw) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  if (!o) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(o)) {
    if (n >= 8) break;
    if (typeof v === 'string' || typeof v === 'number') { out[String(k).slice(0, 32)] = String(v).slice(0, 120); n++; }
  }
  return n ? out : null;
}

/** Append one entry to the GLOBAL creates book, evicting oldest past the cap. PURE — returns a new array. */
export function appendCreate(list, entry, { cap = AUDIT_CAP } = {}) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const c = Math.max(1, Number(cap) || AUDIT_CAP);
  return [...arr, entry].slice(-c);
}

/** The visible-eviction notice (§4) — "showing the last 500 of 812"; empty when nothing dropped. Reused verbatim. */
export { truncationNotice } from './runHistory.js';

/**
 * The one-line audit row (AU-3 surface / the "what have I created" answer). "admin.shopify.com · draft · #D29685 ·
 * created 16:11 · you". PURE — `clock` is the caller's formatted time. `who`: 'human' → "you", 'gate' → "auto".
 */
export function describeCreate(entry, clock = '') {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const bits = [_str(e.system), _str(e.kind), _str(e.label) || _str(e.id)];
  if (_str(clock)) bits.push(`created ${_str(clock)}`);
  bits.push(e.who === 'human' ? 'you' : 'auto');
  return bits.filter(Boolean).join(' · ');
}
