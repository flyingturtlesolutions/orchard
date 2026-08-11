// v2.74.2200 — ONE definition of "this declaration reads a branch verdict", imported rather than restated. The
// predicate decides target selection on BOTH sides (arm-act picks these, this file excludes them), so two copies
// would be two rules that agree until one is edited. No cycle: armWrite → writeMap → {peritemMap, connectorLeg,
// geoResolve}, none of which reach back here.
import { declarationReadsOutcome as _readsOutcome } from './armWrite.js';

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
export function writePreflight({ misses = [], sourceLeg = null, want = '' } = {}) {
  const rows = Array.isArray(misses) ? misses : [];
  if (!rows.length) return { ok: false, reason: 'no-candidates' };
  const wmap = (sourceLeg && sourceLeg.tool && sourceLeg.tool.writeMap) || null;
  // v2.74.2200 — EXCLUDE the branch-arm targets. A declaration carrying an `outcome` rung reads the per-item
  // verdict a BRANCH produced (Core/armWrite.js `declarationReadsOutcome`), and this function's candidates are a
  // LOOKUP's unmatched rows, which carry no verdict — so such a target could never be filled from here.
  //
  // It is a correctness fix, not a tidy-up. The moment `vs_warranty_tasks` declared a second target, "create the
  // missing ones in shopify" tokenised to {create, missing, ones, shopify} and BOTH ids contain "create" and
  // "shopify" — so `find(some)` returned whichever was declared first. That is the silent guess between two
  // write kinds the v1683 note above exists to prevent, re-entering through the back door as soon as a source
  // declared more than one write. Filtering by what the input can actually fill removes the tie instead of
  // ranking it.
  const _all = (wmap && typeof wmap === 'object') ? Object.keys(wmap) : [];
  const ids = _all.filter((id) => !_readsOutcome(wmap[id]));
  if (!ids.length) return { ok: false, reason: 'no-declaration' };

  // v2.74.1683 — DISAMBIGUATE, do not take the first.
  //
  // The original took `Object.keys(wmap)[0]`, which is correct only while a source declares exactly one write
  // target. Asked about a DRAFT ORDER against a row that declares `shopify_create_customer`, it returned
  // `ok:true, targetId:'shopify_create_customer'` — a confident answer about a different write. That is worse
  // than an error: the caller would have filled customer fields and created the wrong kind of record.
  //
  // `want` is the user's OWN WORDS ("a draft order"), never a leg id — the role separation holds. Code matches
  // those words against the declared target ids; with several targets and no match it reports AMBIGUOUS rather
  // than guessing, because guessing here writes something nobody asked for.
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const w = norm(want);
  let targetId = '';
  if (ids.length === 1 && !w) targetId = ids[0];
  else if (w) {
    const wt = w.split(/\s+/).filter((t) => t.length > 2);
    targetId = ids.find((id) => { const t = norm(id); return wt.length && wt.every((x) => t.includes(x)); })
      || ids.find((id) => { const t = norm(id); return wt.some((x) => t.includes(x)); })
      || '';
    if (!targetId) return { ok: false, reason: ids.length === 1 ? 'target-mismatch' : 'ambiguous', wanted: String(want), targets: ids };
  } else {
    return { ok: false, reason: 'ambiguous', wanted: '', targets: ids };
  }
  return { ok: true, targetId, declared: wmap[targetId] || null, count: rows.length };
}
