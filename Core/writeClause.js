/**
 * Core/writeClause.js — PP-2 (v2.74.1681): the per-item WRITE clause, pure half.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §3 (UPSERT) · §4 (the gate) · §1.2's rule about required slots.
 *
 * ── THE SHAPE IS DELIBERATELY EMPTY, AND THAT IS THE POINT ──────────────────────────────────────────────────
 * `map` needs a target system. `fieldRead` needs a field. `branch` needs arms. This needs NOTHING from the model,
 * and the absence IS the design:
 *
 *   · WHICH create runs comes from the source leg's `writeMap` DECLARATION ("a row of mine fills this create").
 *   · WHICH fields fill it comes from that same declaration, resolved per row.
 *   · WHICH rows are candidates comes from the prior step's misses.
 *   · WHETHER it may run unattended comes from the leg's declared `reversible`/`outward` axes.
 *
 * So there is no slot here a model could fill with an invention — which matters more for a write than anywhere
 * else in the pipeline. §7.1's rule is that a required slot the caller cannot always fill generates confident
 * garbage; it cost three versions on reads (`itemField` v1636, the bulk-write shape v1638, `target.system`
 * v1643-48). The same mistake on a CREATE does not render a wrong table, it leaves wrong records behind.
 *
 * `cap` is the only thing a caller may say, because a person can reasonably want fewer than all of them.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** The default per-run write cap. Deliberately the map's window: the candidates ARE that map's misses. */
export const WRITE_WINDOW = 24;

/**
 * Normalize a write verdict. PURE.
 *
 * Returns a verdict for ANY object (including `{}`) — there is nothing that can be underspecified. It returns
 * null only for a non-object, so a caller that receives null knows the payload was dropped in transit rather
 * than that the model gave a thin answer.
 */
export function normalizeWriteVerdict(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const cap = Number(v.cap);
  return {
    kind: 'write',
    // `collection` is accepted and ignored for symmetry with its siblings: the candidates are the prior step's
    // MISSES, which is a stricter source than any collection the model could name. Recorded so a reader of the
    // banked clause can see what was asked, even though it does not steer anything.
    collection: (v.collection && typeof v.collection === 'object') ? v.collection : 'prior',
    cap: (Number.isFinite(cap) && cap > 0) ? Math.min(Math.floor(cap), WRITE_WINDOW) : 0,
    // Free text the model may have supplied about WHY. Never a target, never a field, never a value.
    why: _str(v.why).slice(0, 160),
  };
}

/**
 * The honest tally. Every class named INCLUDING the zeroes (§5.5) — and `unfillable` is first-class rather than
 * folded into a failure count, because "I could not fill a required field from this row" is a DECLARATION gap
 * the user can fix, while a blocked write is a transient one they cannot.
 */
export function writeTally({ created = 0, queued = 0, blocked = 0, unfillable = 0, capped = false, total = 0 } = {}) {
  const n = created + queued + blocked + unfillable;
  const head = `${n} row${n === 1 ? '' : 's'}${capped && total > n ? ` (first ${n} of ${total})` : ''}`;
  return `${head} — ${created} created · ${queued} queued for approval · ${blocked} not created · ${unfillable} can’t fill`;
}

/**
 * Is this verdict actionable given what the prior step left behind? PURE.
 *
 * Separated from the run so the caller fails EARLY and with a specific reason, rather than opening a run and a
 * set of cases for work that was never possible. The three reasons are distinct on purpose: no candidates is a
 * clean "nothing to do", a missing declaration is a catalog gap, and an unavailable target is a connection gap.
 */
export function writePreflight({ misses = [], sourceLeg = null } = {}) {
  const rows = Array.isArray(misses) ? misses : [];
  if (!rows.length) return { ok: false, reason: 'no-candidates' };
  const wmap = (sourceLeg && sourceLeg.tool && sourceLeg.tool.writeMap) || null;
  const targetId = (wmap && typeof wmap === 'object') ? Object.keys(wmap)[0] : '';
  if (!targetId) return { ok: false, reason: 'no-declaration' };
  return { ok: true, targetId, declared: wmap[targetId] || null, count: rows.length };
}
