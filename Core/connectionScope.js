// Core/connectionScope.js — CS-1 (v2.74.1996): CONNECTION SCOPE — where a bound connection LIVES.
// PURE: no chrome / DOM / storage / clock (the caller passes `at`).
//
// THE INCIDENT (findings 2026-08-04; INCIDENT[class=connection-scoped-per-conversation-silently-drops-legs],
// FOURTH occurrence, opened v1941). `conv.config.connections` was a connection's ONLY home, so a ground the user
// spent multiple turns binding was invisible to the NEXT thread. Live 11:45:16 — the palette carried 120 legs
// (`ride[conn:73]`, two grounds' worth) while www.ups.com's 2 armed legs were absent, and the router substituted a
// Shopify order lookup for `track 1Z…`. Six prior attempts fixed the WARNING (`PALETTE ▸ UNCONNECTED`,
// `ROUTE ▸ navigate WITHHELD`); the legs stayed dropped. An incident closed on the visibility of its symptom is
// still open.
//
// THE FIX IS A SCOPE CHANGE (user directive): a connection binds at the DESK and PRESET level and is INHERITED by
// new conversations, instead of being per-thread. Three tiers, resolved as a UNION, most specific first:
//   1. own                — `conv.config.connections`: the conversation's explicit set (still authoritative + editable)
//   2. desk:<instanceId>  — this DESK's bound set; survives new threads, `clear chat`, and re-creation (AP-0 restores instanceId)
//   3. preset:<presetId>  — the PRESET's bound set; a sibling or brand-new instance starts with the preset's reach
//
// A UNION, not a create-time fallback. The live failure had a NON-EMPTY own set that was merely missing the third
// ground — "seed only when the new conversation declares none" would have left it broken, which is exactly the
// under-scoped shape the prior six attempts kept landing on. Inheritance is a DEFAULT, not a lock: `own` is never
// overwritten, and `unbindScopes` removes an origin from the tiers that grant it.
//
// NOT GLOBAL, deliberately. The TRT-5 membrane (DESIGN_target_routing.md §5 — visitor fence + adopt-on-2nd) scopes
// a desk's role on purpose; one global connection pool would dissolve it. Desk + preset is the scope the user named.
//
// NOT Core/presetMemory.js: it does seed instances from a preset, but its unit is a learned memory ITEM
// (isPromotableToPreset / distillCandidates), not a connection. Bending it would be the wrong reuse.

const _str = (v) => (typeof v === 'string' ? v.trim() : '');
const _HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export const SCOPE_KEY = 'conn:scope';   // chrome.storage.local — a binding must survive a browser restart
// A runaway adopt loop can't grow a tier without bound. Kept low on purpose: INTERPRET_ASK walks the connection set
// once per turn (ground lookup + merged recipe read PER connection, sg.js), so the ceiling is a latency ceiling too.
export const MAX_PER_SCOPE = 16;

/**
 * The DEDUP identity of a connection — scheme, path and trailing dot stripped, lowercased. PURE.
 * Setup banks a full origin (`https://www.ups.com`); the TRT-5 adopt banks a bare HOST (`www.ups.com`). Both are
 * the same connection and both are tolerated downstream, so the union must not carry two entries for it — that
 * would project every one of its ride legs twice into the palette.
 */
export function connKey(origin) {
  return _str(origin).replace(_HAS_SCHEME, '').replace(/[/?#].*$/, '').replace(/\.$/, '').toLowerCase();
}

/** One connection `{origin,label}` — origin REQUIRED (it IS the connection). PURE. Null when unusable. */
export function normalizeConnection(value) {
  const v = (value && typeof value === 'object') ? value : null;
  const origin = _str(v && v.origin);
  if (!origin || !connKey(origin)) return null;
  return { origin, label: _str(v && v.label) || origin };
}

/**
 * Normalize + dedup any number of connection lists into one set, by connKey. PURE — inputs are never mutated.
 * First occurrence wins the ORDER, but a later duplicate UPGRADES the kept entry twice over: an explicit scheme
 * beats a bare host (`www.ups.com` → `https://www.ups.com`), and a real label beats an origin-as-label placeholder.
 * So an adopt-shaped record can never degrade the setup-shaped one it merges with, whichever arrives first.
 */
export function mergeConnections(...lists) {
  const out = [];
  const at = new Map();
  for (const list of lists) {
    for (const raw of (Array.isArray(list) ? list : [])) {
      const c = normalizeConnection(raw);
      if (!c) continue;
      const k = connKey(c.origin);
      if (!at.has(k)) { at.set(k, out.length); out.push(c); continue; }
      const kept = out[at.get(k)];
      const keptPlaceholderLabel = connKey(kept.label) === k;   // the label is just the origin/host echoed back
      if (!_HAS_SCHEME.test(kept.origin) && _HAS_SCHEME.test(c.origin)) kept.origin = c.origin;
      if (keptPlaceholderLabel && connKey(c.label) !== k) kept.label = c.label;
    }
  }
  return out;
}

/**
 * The scope ids a conversation reads and writes, MOST SPECIFIC FIRST. PURE.
 *   desk:<instanceId>  — the durable per-desk identity (AP-0). Restored on re-create, kept by `clear chat`.
 *   preset:<presetId>  — the preset. A CASE (sub-task) carries no presetId of its own but does carry its desk's
 *                        `appId`, which IS the preset id for every conversation `_createAppConversation` mints —
 *                        so a case inherits its desk's reach through this tier with no parent lookup.
 * [] for a scope-less surface (the Front desk, a blank thread): those keep own-only reach, by design.
 */
export function scopeIdsFor(conv) {
  const c = (conv && typeof conv === 'object') ? conv : {};
  const ids = [];
  const instanceId = _str(c.instanceId);
  if (instanceId) ids.push(`desk:${instanceId}`);
  const presetId = _str(c.presetId) || _str(c.appId);
  if (presetId) ids.push(`preset:${presetId}`);
  return ids;
}

/** One tier's stored connections (normalized). PURE. */
export function scopeConnections(book, scopeId) {
  const entry = (book && typeof book === 'object') ? book[_str(scopeId)] : null;
  return mergeConnections(entry && entry.connections);
}

/** The INHERITED set for a conversation: the union across its tiers, most specific first. PURE. */
export function inheritedConnections(book, ids) {
  return mergeConnections(...(Array.isArray(ids) ? ids : []).map((id) => scopeConnections(book, id)));
}

/**
 * The EFFECTIVE connection set for a conversation: its OWN set ∪ everything its desk and preset have bound,
 * minus anything this desk has explicitly EXCLUDED. PURE. Own entries lead — their labels and origin forms are the
 * curated ones setup banked, and an origin in `own` is reachable even if the exclusion list is stale.
 *
 * `excluded` is what keeps inheritance a DEFAULT rather than a lock: de-selecting a site at re-setup must actually
 * drop it, and without this the preset tier would silently hand it straight back on the next turn.
 */
export function resolveConnections(own, book, ids, excluded = null) {
  const deny = new Set((Array.isArray(excluded) ? excluded : []).map(connKey).filter(Boolean));
  const inherited = inheritedConnections(book, ids).filter((c) => !deny.has(connKey(c.origin)));
  return mergeConnections(own, inherited);
}

/**
 * The exclusion list a desk should carry after an authoritative re-selection: the connKeys its tiers WOULD grant
 * that the user did not choose. PURE. Recomputed whole at every Confirm, so re-selecting a site clears it.
 */
export function excludedOrigins(inherited, chosen) {
  const keep = new Set(mergeConnections(chosen).map((c) => connKey(c.origin)));
  const out = [];
  for (const c of mergeConnections(inherited)) {
    const k = connKey(c.origin);
    if (!keep.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

const _sameSet = (a, b) => a.length === b.length && a.every((x, i) => x.origin === b[i].origin && x.label === b[i].label);

/** Bind connections into ONE tier — copy-on-write. Returns the SAME book when nothing changed (no pointless write). PURE. */
export function bindScope(book, scopeId, conns, at = 0) {
  const b = (book && typeof book === 'object') ? book : {};
  const id = _str(scopeId);
  const add = mergeConnections(conns);
  if (!id || !add.length) return b;
  const prev = scopeConnections(b, id);
  const merged = mergeConnections(prev, add).slice(0, MAX_PER_SCOPE);
  if (_sameSet(prev, merged)) return b;
  return { ...b, [id]: { connections: merged, updatedAt: Number.isFinite(at) ? at : 0 } };
}

/**
 * REPLACE a tier's set outright — the authoritative write. PURE, copy-on-write; an empty set drops the tier.
 * Setup's Confirm is authoritative for the DESK tier (the picker's selection IS the desk's set, de-selections
 * included). The PRESET tier only ever accretes via bindScope — it is a shared pool, so one desk's de-selection
 * must not strip a sibling; that desk records the drop in its own exclusion list instead.
 */
export function setScope(book, scopeId, conns, at = 0) {
  const b = (book && typeof book === 'object') ? book : {};
  const id = _str(scopeId);
  if (!id) return b;
  const next = mergeConnections(conns).slice(0, MAX_PER_SCOPE);
  if (!next.length) return forgetScope(b, id);
  if (_sameSet(scopeConnections(b, id), next)) return b;
  return { ...b, [id]: { connections: next, updatedAt: Number.isFinite(at) ? at : 0 } };
}

/** Bind into EVERY tier of a scope (desk + preset) at once — the setup / adopt write. PURE. */
export function bindScopes(book, ids, conns, at = 0) {
  let b = (book && typeof book === 'object') ? book : {};
  for (const id of (Array.isArray(ids) ? ids : [])) b = bindScope(b, id, conns, at);
  return b;
}

/** Drop an ORIGIN from every tier of a scope — the disconnect twin, so inheritance stays a default and not a lock. PURE. */
export function unbindScopes(book, ids, origin) {
  let b = (book && typeof book === 'object') ? book : {};
  const key = connKey(origin);
  if (!key) return b;
  for (const id of (Array.isArray(ids) ? ids : [])) {
    const sid = _str(id);
    const prev = scopeConnections(b, sid);
    if (!prev.some((c) => connKey(c.origin) === key)) continue;
    const next = prev.filter((c) => connKey(c.origin) !== key);
    b = next.length ? { ...b, [sid]: { ...(b[sid] || {}), connections: next } } : forgetScope(b, sid);
  }
  return b;
}

/** Drop a whole tier — a deleted desk shouldn't leave its reach behind. PURE, copy-on-write. */
export function forgetScope(book, scopeId) {
  const b = (book && typeof book === 'object') ? book : {};
  const id = _str(scopeId);
  if (!id || !(id in b)) return b;
  const next = { ...b };
  delete next[id];
  return next;
}
