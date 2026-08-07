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

/** Forget the whole creates book (local reset). */
export async function clearCreates() {
  return _chained(async () => { await chrome.storage.local.remove(KEY); });
}
