// Core/connectAttention.js — v2.74.2043: Connect-tab attention model (DESIGN_vitals.md §8.2).
// PURE: one place for "which cards / what badge count" so the tab, the Front chip, and the tab dot cannot drift.

import { STATUS } from './connection.js';
import { attentionOrigins } from './connectionPresence.js';
import { connKey, mergeConnections, scopeConnections } from './connectionScope.js';

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/**
 * Origins the Connect tab may show: every desk/preset tier in the scope book ∪ the caller's own connections.
 * Spec §8.2 — desk+preset scope, not the entire registry. PURE.
 */
export function connectScopeOrigins(book, ownConnections = null) {
  const ids = Object.keys((book && typeof book === 'object') ? book : {});
  const fromBook = mergeConnections(...ids.map((id) => scopeConnections(book, id)));
  return mergeConnections(ownConnections, fromBook);
}

/**
 * Build the Connect panel model: signed-out / wrong-account cards (scoped) + reconnect cards + badge total.
 * @param {{ registry?:object, incidents?:Array, scopeOrigins?:Array|{origin:string,label?:string}[], checkingOrigin?:string|null }} p
 */
export function connectPanelModel({ registry = {}, incidents = [], scopeOrigins = [], checkingOrigin = null } = {}) {
  const conns = mergeConnections(scopeOrigins);
  const origins = conns.map((c) => c.origin);
  const labelOf = new Map(conns.map((c) => [connKey(c.origin), _str(c.label) || c.origin]));
  const checkKey = connKey(checkingOrigin);
  const cards = [];
  for (const a of attentionOrigins(registry, origins)) {
    const origin = _str(a && a.origin);
    if (!origin) continue;
    const kind = (a.status === STATUS.WRONG_ACCOUNT) ? 'wrongaccount' : 'signedout';
    const entry = (registry && registry[origin]) || null;
    cards.push({
      kind,
      origin,
      label: labelOf.get(connKey(origin)) || origin,
      since: entry && Number(entry.lastVerifiedAt) > 0 ? Number(entry.lastVerifiedAt) : null,
      checking: !!(checkKey && checkKey === connKey(origin)),
    });
  }
  for (const inc of (Array.isArray(incidents) ? incidents : [])) {
    if (!inc || inc.status !== 'open' || inc.cls === 'presence') continue;
    const subject = _str(inc.subject) || 'A connection';
    cards.push({
      kind: 'reconnect',
      origin: subject,
      label: subject.slice(0, 60),
      since: Number(inc.openedAt) > 0 ? Number(inc.openedAt) : null,
      checking: false,
    });
  }
  const signInCount = cards.filter((c) => c.kind === 'signedout' || c.kind === 'wrongaccount').length;
  const reconnectCount = cards.filter((c) => c.kind === 'reconnect').length;
  return { cards, total: cards.length, signInCount, reconnectCount };
}
