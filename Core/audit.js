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
/**
 * v2.74.2195 (§12.8.1) — the INCITING record: what CAUSED this create. PURE, capped, and deliberately shaped
 * like a record rather than like VendorSuite.
 *
 * An inciting object IS a record, so it reuses this entry's own vocabulary — `system · kind · id · label`. The
 * first draft of this field carried `division`, which is a VendorSuite noun: a draft order incited by a Zendesk
 * ticket has no division, and a field that only fits one source is a field that has to be widened the first time
 * a second source appears. Anything an OPENER needs beyond the identity goes in `args`, exactly as `urlArgs`
 * already carries the fill ingredients for `itemUrl` — same capping helper, same reason.
 *
 * `system` + `id` are REQUIRED and the whole thing is dropped without them: a provenance that cannot be opened is
 * the "valid-looking but wrong" shape §12.8.1 exists to prevent (a card offering to show you something it cannot
 * reach). `kind` stays a capped free string and is NEVER dispatched on — AUDIT_KINDS is the domain of what
 * Orchard CREATES and feeds classifyCreate; a warranty task is not one, and widening it to fit a display label
 * would blur what that classifier is allowed to return. The load-bearing field is `system`: the surface asks
 * "how do I open a record on this system?", not "is this VendorSuite?".
 */
function _capIncitedBy(raw) {
  const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : null;
  if (!o) return null;
  const system = _str(o.system).replace(/^https?:\/\//i, '').replace(/\/.*$/, '').slice(0, 80);
  const id = _str(o.id).slice(0, 80);
  if (!system || !id) return null;
  const out = { system, id };
  const kind = _str(o.kind).slice(0, 24); if (kind) out.kind = kind;
  const label = _str(o.label).slice(0, 80); if (label) out.label = label;
  const args = _capUrlArgs(o.args); if (args) out.args = args;
  return out;
}

export function auditEntry(f = {}) {
  const at = Number.isFinite(f.at) && f.at > 0 ? f.at : 0;
  const incitedBy = _capIncitedBy(f.incitedBy);
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
    ...(incitedBy ? { incitedBy } : {}),                                      // §12.8.1 — the record that CAUSED this one
    // AU-6 (v2.74.2204, §12.1) — the LIFECYCLE fields. A create is born WARM with a one-entry timeline; the
    // pointer fields stay absent until a hand-off is observed, which is what keeps `handOff()` a fact about the
    // row rather than a comparison that has to special-case "same as the create".
    //
    // `kind`/`id` above are now explicitly IMMUTABLE — what Orchard created, forever. Everything that moves
    // moves in `currentKind`/`currentId` and `events`. Collapsing the two would make a completed draft report as
    // "you created an order", which is false, and would corrupt the AU-3 count (§12.0).
    watch: 'warm',
    // §13.3 (v2.74.2206) — WHEN SOMETHING LEFT THE BOUNDARY, and absent when nothing has. It is a field of the
    // RECORD rather than a property read off the delete leg, because the declared axes describe the ACT and not
    // the record's history: a ticket is internally deletable and may still have emailed the homeowner. The
    // reversal offer reads this, so a create by an `outward: true` leg is un-undoable from birth.
    ...(Number.isFinite(f.outwardAt) && f.outwardAt > 0 ? { outwardAt: f.outwardAt } : {}),
    ...(Number.isFinite(f.warmUntil) && f.warmUntil > 0 ? { warmUntil: f.warmUntil } : {}),
    lastSeenAt: at,
    events: [{ at, type: 'create', kind: AUDIT_KINDS.includes(f.kind) ? f.kind : 'record', id: _str(f.id).slice(0, 80), label: _str(f.label).slice(0, 80) }],
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
 * AU-2 AT RENDER (v2.74.2147) — the absolute URL of the record on the system that owns it, or '' when none can be
 * built. PURE. This is the resolve half of §7's "durable link"; the eye button on the record card is its surface.
 *
 * RESOLVED AT RENDER, NOT BANKED AT WRITE — deliberately, and it is the reason `urlArgs` exists (see auditEntry).
 * §11 planned to fill once via `fillEndpoint({...urlArgs, id})` and store the string; storing it freezes the row at
 * the template that existed the day it was written. Resolving from the CATALOG each time means a corrected
 * `itemUrl` reaches rows already on disk — the same catalog-upgradeable posture invariant #3 forces on ride
 * recipes. A row that banked a literal `itemUrl` still wins (below): a caller that knew the exact URL beats a
 * template we re-derive.
 *
 * @param entry     a stored auditEntry
 * @param template  the recipe's `itemUrl` (e.g. '/store/{handle}/draft_orders/{id}'); '' when the leg has none
 * @param fill      the `{name}` substituter (fillEndpoint, injected to keep this module dependency-free)
 */
export function recordOpenUrl(entry, template = '', fill = null) {
  const e = (entry && typeof entry === 'object') ? entry : null;
  if (!e) return '';
  const banked = _str(e.itemUrl);
  if (/^https?:\/\//i.test(banked)) return banked;                      // an absolute link the writer already knew
  const host = _str(e.system).replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  if (!host) return '';
  const tpl = _str(banked || template);                                 // a banked RELATIVE path still beats the catalog
  if (!tpl) return '';
  // v2.74.2149 — THE TEMPLATE MUST IDENTIFY THE RECORD. A SECTION route is not a record link, and the
  // unfilled-placeholder guard below does NOT catch it: `vs_warranty_task` declares `itemUrl: '/#warranty'`, which
  // has no `{…}` to leave unfilled, so it fills cleanly, returns a valid-looking URL, and opens the warranty LIST
  // while claiming to open task #4899327. The user lands on a real page and has to NOTICE it is the wrong one —
  // the worst failure shape available, worse than a 404. Every genuine record template carries `{id}`
  // (`/store/{handle}/draft_orders/{id}`, `/agent/tickets/{id}`); a section route does not. No `{id}` ⇒ no link,
  // and the caller offers the DRIVE instead (DESIGN_audit.md §12.8.1).
  if (!/\{id\}/.test(tpl)) return '';
  const args = { ...(e.urlArgs && typeof e.urlArgs === 'object' ? e.urlArgs : {}), id: _str(e.id) };
  const path = typeof fill === 'function' ? fill(tpl, args) : tpl;
  if (/\{[a-zA-Z_][\w-]*\}/.test(path)) return '';                      // an UNFILLED placeholder is a dead link — say nothing rather than open a 404
  return `https://${host}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * v2.74.2195 (§12.8.1) — HOW do I open the record that incited this one? PURE decision, no DOM, no drive.
 *
 * The generalisation this field exists for: the surface must not ask "is this VendorSuite?". It asks what the
 * INCITING SYSTEM affords, and the answer follows the same rule `recordOpenUrl` already enforces for the created
 * record —
 *   · a per-record URL (its itemUrl template carries `{id}`)  → 'link'   — Zendesk, Shopify
 *   · no per-record URL, but a drive can walk to it           → 'drive'  — VendorSuite (§12.8.1)
 *   · neither                                                 → 'none'   — no button; the v2149 rule that no
 *                                                                          link beats a wrong one
 * `canDrive` is injected (the catalogs live outside this module and this file stays pure) — the caller passes a
 * predicate over the inciting system. That is what keeps a second walk-only source from needing a code change
 * here: it becomes true for another host and this function is untouched.
 *
 * OPTIONS OBJECT, not positionals: `fill` is REQUIRED for a link and is easy to forget — the first draft omitted
 * it and every Zendesk row silently fell through to 'drive', because `recordOpenUrl` returns the template
 * UNFILLED without a substituter and its own placeholder guard then rejects it. Named arguments make the missing
 * one visible at the call site instead of turning into a wrong verdict.
 *
 * @param {object} entry                          an audit row
 * @param {object}  o
 * @param {string}  o.template                    the inciting source's itemUrl template, if the caller resolved one
 * @param {(system:string)=>boolean} o.canDrive   can a drive walk to a record on this system?
 * @param {(tpl:string,args:object)=>string} o.fill  the substituter (chat.js injects `fillEndpoint`)
 * @returns {{how:'link'|'drive'|'none', system:string, id:string, label:string, url:string, args:object}}
 */
export function incitedOpener(entry, { template = '', canDrive = null, fill = null } = {}) {
  const inc = (entry && typeof entry === 'object' && entry.incitedBy && typeof entry.incitedBy === 'object')
    ? entry.incitedBy : null;
  const none = { how: 'none', system: '', id: '', label: '', url: '', args: {} };
  if (!inc) return none;
  const system = _str(inc.system); const id = _str(inc.id);
  if (!system || !id) return none;                                   // _capIncitedBy already guarantees both; belt
  const base = { system, id, label: _str(inc.label), args: (inc.args && typeof inc.args === 'object') ? inc.args : {} };
  // A LINK only when the template identifies the RECORD — the same `{id}` test recordOpenUrl applies, and for the
  // same reason: a section route fills cleanly and opens the wrong page while claiming to open the right one.
  const tpl = _str(template);
  if (/\{id\}/.test(tpl)) {
    const url = recordOpenUrl({ system, id, itemUrl: tpl, urlArgs: base.args }, tpl, fill);
    if (url) return { ...base, how: 'link', url };
  }
  if (typeof canDrive === 'function' && canDrive(system)) return { ...base, how: 'drive', url: '' };
  return none;
}

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

/**
 * AU-3 — recognise the "what have I created?" ask (the read-surface shortcut). PURE. Requires an interrogative
 * (what/which/show/list/any/audit) AND a create verb (create/made/added) AND a first-person / Orchard subject, so a
 * real create COMMAND ("create a draft order for …") does NOT match (no interrogative). Returns a scope window.
 * @returns {{matched:boolean, scope?:'all'|'today'|'yesterday'|'week'}}
 */
export function parseCreatesAsk(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return { matched: false };
  const verb = /\b(create[ds]?|creating|made|added)\b/.test(t);
  const interrog = /\b(what|which|show|list|any)\b/.test(t) || /\baudit\b/.test(t);
  const subject = /\b(i|we|orchard|you)\b/.test(t) || /\b(i've|i'?ve)\b/.test(t) || /\bmy\b/.test(t);
  if (!(verb && interrog && subject)) return { matched: false };
  let scope = 'all';
  if (/\btoday\b/.test(t)) scope = 'today';
  else if (/\byesterday\b/.test(t)) scope = 'yesterday';
  else if (/\bthis (week|wk)\b|\bthis week\b/.test(t)) scope = 'week';
  return { matched: true, scope };
}

/** Window bounds [from, to] in ms for a scope, given `now`. PURE (no Date.now — `now` passed in). */
export function createsScopeWindow(scope, now = 0) {
  const n = Number.isFinite(now) && now > 0 ? now : 0;
  const DAY = 86400000;
  if (!n || scope === 'all' || !scope) return { from: 0, to: n || Infinity };
  if (scope === 'today') return { from: n - DAY, to: n };
  if (scope === 'yesterday') return { from: n - 2 * DAY, to: n - DAY };
  if (scope === 'week') return { from: n - 7 * DAY, to: n };
  return { from: 0, to: n };
}

/** Filter creates to a scope window. PURE. Rows with at=0 (legacy/unstamped) are kept only for scope 'all'. */
export function filterCreatesByScope(items, scope, now = 0) {
  const arr = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!scope || scope === 'all') return arr;
  const { from, to } = createsScopeWindow(scope, now);
  return arr.filter((e) => Number.isFinite(e.at) && e.at >= from && e.at <= to);
}

/**
 * AU-3 — render the "what have I created" answer as a markdown block. PURE: `fmtTime(at)->string` is injected so
 * the module stays deterministic (the chat caller passes a real local-time formatter). Newest first. Filters to
 * verb==='create' (v1 stores only creates, but the filter keeps the ask honest the moment writes are added, §6.1).
 */
export function renderCreatesAnswer({ items, total, notice } = {}, { fmtTime = (at) => String(at || ''), scope = 'all' } = {}) {
  const rows = (Array.isArray(items) ? items : []).filter((e) => e && e.verb === 'create');
  const when = scope === 'today' ? ' today' : scope === 'yesterday' ? ' yesterday' : scope === 'week' ? ' this week' : '';
  if (!rows.length) return `You haven't created anything${when} that Orchard has on record.`;
  const lines = rows.slice().reverse().map((e) => `- ${describeCreate(e, fmtTime(e.at))}`);   // newest first
  const n = rows.length;
  const head = `You've created ${n} record${n === 1 ? '' : 's'}${when}${(!when && notice) ? ` (${notice})` : ''}:`;
  return [head, ...lines].join('\n');
}
