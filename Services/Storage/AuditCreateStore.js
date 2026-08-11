/**
 * @file Services/Storage/AuditCreateStore.js
 * @description AU-1 (DESIGN_audit.md §11) — the I/O around Core/audit.js's pure core: a durable record of every
 * entity Orchard creates. A SINGLE GLOBAL append book keyed `audit:creates` (creates are cross-system AND rare, so
 * one book answers "what have I created — customers, orders, tickets?"), with a serialized read-modify-write
 * (mirrors WorkflowRunStore / ActionLedgerStore) and a lifetime `total` so eviction stays VISIBLE (never the action
 * ledger's silent slice(-500) — §4/§8.4). The entry SHAPE lives in Core/audit.js (pure, tested); this is just the
 * per-key RMW + the visible-total.
 *
 * Local-only, never sync-registered (§5): the book holds real identity (#D-numbers, ids, a minimal customer label)
 * so it can answer the question, and must never cross the device boundary. It is NOT in SYNCABLE_KINDS.
 */

import { auditEntry, appendCreate, truncationNotice, AUDIT_CAP } from '../../Core/audit.js';

const KEY = 'audit:creates';

// Serialized read-modify-write so concurrent creates can't clobber each other's append (the WorkflowRunStore idiom,
// single-key variant — one global book, so one chain).
let _chain = Promise.resolve();
function _chained(fn) {
  const next = _chain.then(() => fn());
  _chain = next.catch(() => {});
  return next;
}

async function _read() {
  try { const got = await chrome.storage.local.get(KEY); return got?.[KEY] ?? null; } catch { return null; }
}

/**
 * The retained creates (oldest first) + the lifetime total + a visible truncation notice.
 * @returns {Promise<{items:Array, total:number, notice:string}>}
 */
export async function loadCreates() {
  const rec = await _read();
  const items = (rec && Array.isArray(rec.items)) ? rec.items : [];
  const total = (rec && Number.isFinite(rec.total)) ? rec.total : items.length;
  return { items, total, notice: truncationNotice(items.length, total) };
}

/**
 * Bank one create event. Normalizes through Core/audit.auditEntry, evicts oldest past the global cap, and bumps the
 * lifetime `total` (so eviction stays visible). The caller (recordCreate) passes `at` (Date.now() at the seam) — the
 * store stays honest about when, and the pure core stays clock-free. @returns {Promise<{items,total,notice}>}
 */
export async function appendCreateEntry(fields, { cap = AUDIT_CAP } = {}) {
  return _chained(async () => {
    const rec = await _read();
    const prev = (rec && Array.isArray(rec.items)) ? rec.items : [];
    const prevTotal = (rec && Number.isFinite(rec.total)) ? rec.total : prev.length;
    const entry = auditEntry(fields);
    const items = appendCreate(prev, entry, { cap });
    const total = prevTotal + 1;
    const updatedAt = (fields && Number.isFinite(fields.at) && fields.at > 0) ? fields.at : entry.at;
    await chrome.storage.local.set({ [KEY]: { items, total, updatedAt } });
    return { items, total, notice: truncationNotice(items.length, total) };
  });
}

/**
 * v2.74.2203 — remove ONE banked create. TESTING AFFORDANCE, and the constraint is written here because this is
 * the function that would have to be deleted to enforce it: a real creates-audit ledger is APPEND-ONLY, and a
 * production Records surface must not offer this at all (user direction 2026-08-11: "for testing only, live
 * version of records will be permanent"). It exists so a build loop can clear the rows it just made.
 *
 * Identity is `at` + `id` together, never `id` alone: the same record can legitimately be created twice (a draft
 * order has no identity to dedupe on — the whole reason the per-item act is not an upsert), and removing "the row
 * with this id" would then delete an arbitrary one of them.
 *
 * `total` decrements with it so the truncation notice ("showing the last 500 of 812") keeps describing the book
 * that exists rather than a history this row has been taken out of. Floored at the retained count, which is the
 * only value that cannot lie.
 * @returns {Promise<{items,total,notice,removed:boolean}>}
 */
export async function removeCreate({ at = 0, id = '' } = {}) {
  return _chained(async () => {
    const rec = await _read();
    const prev = (rec && Array.isArray(rec.items)) ? rec.items : [];
    const prevTotal = (rec && Number.isFinite(rec.total)) ? rec.total : prev.length;
    const _at = Number(at) || 0;
    const _id = String(id || '');
    let hit = -1;
    for (let i = prev.length - 1; i >= 0; i--) {
      const e = prev[i];
      if (e && Number(e.at) === _at && String(e.id || '') === _id) { hit = i; break; }
    }
    if (hit < 0) return { items: prev, total: prevTotal, notice: truncationNotice(prev.length, prevTotal), removed: false };
    const items = prev.slice(0, hit).concat(prev.slice(hit + 1));
    const total = Math.max(items.length, prevTotal - 1);
    await chrome.storage.local.set({ [KEY]: { items, total, updatedAt: Date.now() } });
    return { items, total, notice: truncationNotice(items.length, total), removed: true };
  });
}

/** Forget the whole creates book (local reset). */
export async function clearCreates() {
  return _chained(async () => { await chrome.storage.local.remove(KEY); });
}
