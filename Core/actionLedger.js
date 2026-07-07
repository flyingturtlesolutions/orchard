// Core/actionLedger.js — FL-4 (v2.74.1346, DESIGN_app_fleet.md). The app ACTION LEDGER's pure half: entry shape +
// aggregation. The ledger is the app's trust instrument — "how many merges today?" (aggregate), "why did you
// propose that?" (provenance), and later the earned-autonomy ratchet's evidence base (approval/reversal counts per
// rule). Provenance is captured AT ACT TIME (unreconstructable later). Storage: Services/Storage/ActionLedgerStore.js.

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

export const LEDGER_KINDS = ['sweep', 'proposal', 'decision', 'execution'];

/**
 * Mint one ledger entry. PURE (timestamp injected for testability).
 * @param {string} kind    sweep | proposal | decision | execution
 * @param {object} fields  {action?, targets?, why?, proposalId?, status?, reason?, ok?, error?, counts?}
 * @param {number} [now]
 */
export function ledgerEntry(kind, fields = {}, now = Date.now()) {
  const k = LEDGER_KINDS.includes(kind) ? kind : 'proposal';
  const e = { id: `led_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`, ts: now, kind: k };
  if (fields && typeof fields === 'object') {
    if (_str(fields.action)) e.action = _str(fields.action);
    if (Array.isArray(fields.targets) && fields.targets.length) e.targets = fields.targets.map(String).slice(0, 12);
    if (_str(fields.why)) e.why = _str(fields.why).slice(0, 300);
    if (_str(fields.proposalId)) e.proposalId = _str(fields.proposalId);
    if (_str(fields.status)) e.status = _str(fields.status);
    if (_str(fields.reason)) e.reason = _str(fields.reason).slice(0, 300);
    if (typeof fields.ok === 'boolean') e.ok = fields.ok;
    if (_str(fields.error)) e.error = _str(fields.error).slice(0, 200);
    if (fields.counts && typeof fields.counts === 'object') e.counts = fields.counts;
  }
  return e;
}

/**
 * Aggregate the ledger for the console: totals by kind + by action within a window. PURE.
 * @param {Array<object>} items
 * @param {{ sinceMs?: number, now?: number }} [opts]   sinceMs: window size (e.g. 3600_000 for "last hour")
 */
export function summarizeLedger(items, { sinceMs = 0, now = Date.now() } = {}) {
  const floor = sinceMs > 0 ? now - sinceMs : 0;
  const inWindow = (Array.isArray(items) ? items : []).filter((e) => e && e.ts >= floor);
  const byKind = {};
  const executedByAction = {};
  for (const e of inWindow) {
    byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    if (e.kind === 'execution' && e.ok !== false && e.action) executedByAction[e.action] = (executedByAction[e.action] || 0) + 1;
  }
  return { total: inWindow.length, byKind, executedByAction };
}

/** Render the most recent N entries as console lines (newest first). PURE — caller escapes for HTML. */
export function renderLedgerLines(items, n = 12) {
  const list = (Array.isArray(items) ? items : []).slice(-n).reverse();
  return list.map((e) => {
    const t = new Date(e.ts).toLocaleTimeString();
    if (e.kind === 'sweep') return `${t} · sweep — ${e.counts ? Object.entries(e.counts).map(([k, v]) => `${v} ${k}`).join(', ') : 'ran'}`;
    if (e.kind === 'decision') return `${t} · ${e.status || 'decided'} — ${e.action || ''}${e.targets ? ` (${e.targets.join(', ')})` : ''}${e.reason ? ` — ${e.reason}` : ''}`;
    if (e.kind === 'execution') return `${t} · ${e.ok === false ? '✗ failed' : '✓ executed'} — ${e.action || ''}${e.targets ? ` (${e.targets.join(', ')})` : ''}${e.error ? ` — ${e.error}` : ''}`;
    return `${t} · proposed — ${e.action || ''}${e.targets ? ` (${e.targets.join(', ')})` : ''}${e.why ? ` — ${e.why}` : ''}`;
  });
}
