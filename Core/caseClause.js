/**
 * Core/caseClause.js — PP-3 (v2.74.1686): the per-item CASE clause, pure half.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §0 (the shape: list → fieldRead → branch → map → upsert → CASE → gate) ·
 * §5.7 (what a case contains, and what a re-run does).
 *
 * ── WHY THIS EXISTS: THE CLAUSE WAS BUILT AND UNREACHABLE ───────────────────────────────────────────────────
 * `Core/pipelineCase.js` has been built, tested (19) and specified since v1665, and the BRANCH clause already
 * opens one case per row as a side effect. What did not exist was any way for a person to ASK for it. `INTENTS`
 * named ten kinds and `case` was not among them.
 *
 * That is not a missing feature, it is a misrouting one. Live (gl 2026-07-22, trace 070307), the ask
 *
 *     "create a new case listing the number and type of replacement"
 *
 * found no `case` kind, so the router picked the closest thing it COULD express: `act` on
 * `me.zendesk.create_ticket@deako.zendesk.com` — a different ground, a real CS queue, an outward write, dispatched
 * twice. The front door must always choose something; when the vocabulary cannot say what the user asked for, it
 * chooses the nearest wrong thing CONFIDENTLY. A built clause that no intent names is not shipped — it is a
 * silent redirect.
 *
 * ── WHAT THE MODEL MAY SAY, AND THE MUCH LONGER LIST OF WHAT IT MAY NOT ─────────────────────────────────────
 * Same rule as `write` (§7.1): a required slot the caller cannot always fill generates confident garbage. Here
 * almost everything is already known without asking —
 *
 *   · WHICH items get a case      → the prior step's results. Never a collection the model names.
 *   · WHAT each case is labelled  → `_rowLabel` off the row, the same label the run and the tally already use.
 *   · WHAT each case RECORDS      → the run's own stage record. **This is the load-bearing one.**
 *   · WHETHER an item is re-cased → §5.7's already-open rule, from the store.
 *
 * So the model supplies two things: `scope` (per item, or one case for the set — "for each … create a case"
 * versus "create a case listing them all" is a real distinction only the ask carries) and `title` (the user's own
 * words). Both are inert: neither can name a system, a record, or a field.
 *
 * ── AND IT MUST NOT INVENT THE CONTENTS ─────────────────────────────────────────────────────────────────────
 * The live ask asked for a case "listing the number and type of replacement" — and nothing in that run had ever
 * extracted a number or a type. A case can only record what some stage actually produced; asked for more, the
 * honest output names the gap. A `note` slot the model could fill would have produced a case confidently listing
 * quantities nobody read, which is the one failure a case exists to prevent: it is the artifact a human reviews
 * INSTEAD of re-reading the source.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** Per-run case cap. Matches the write/map window — the candidates are the same prior set. */
export const CASE_WINDOW = 24;

/** `item` = one case per row (the §0 shape's default). `run` = one case covering the set. */
export const CASE_SCOPES = Object.freeze(['item', 'run']);

/**
 * Normalize a case verdict. PURE.
 *
 * Returns a verdict for ANY object (including `{}`) — nothing here can be underspecified, so there is no
 * "clarify" path out of this shape. Returns null only for a non-object, so a caller can tell "dropped in
 * transit" from "thin answer".
 */
export function normalizeCaseVerdict(v) {
  if (v == null || typeof v !== 'object' || Array.isArray(v)) return null;
  const cap = Number(v.cap);
  const scope = _str(v.scope).toLowerCase();
  return {
    kind: 'case',
    // Default `item`, because §0's shape is "CASE per item" and because the per-item reading is the recoverable
    // mistake: N cases when one was wanted is noise a person can close, while one case when N were wanted loses
    // the per-row review surface the whole pipeline exists to produce.
    scope: CASE_SCOPES.includes(scope) ? scope : 'item',
    // The user's own words for what this case is about. Clamped, never rendered as a fact about a record.
    title: _str(v.title || v.label).slice(0, 120),
    cap: (Number.isFinite(cap) && cap > 0) ? Math.min(Math.floor(cap), CASE_WINDOW) : 0,
    why: _str(v.why).slice(0, 160),
  };
}

/**
 * Is this verdict actionable against what the prior step left behind? PURE.
 *
 * The `no-candidates` reason is the one that matters: it is what makes "the branch narrowed to 0, so there is
 * nothing to open a case about" a clean, named stop rather than a step that runs on an empty set and resolves
 * whatever leg looks closest. That fall-through is exactly how the live trace reached an outward Zendesk write.
 */
export function casePreflight(spec) {
  // `= {}` covers `undefined` only; a null spec would throw on the path whose job is to STOP work. Same shape as
  // `emptyPriorStop` — degrade to "no candidates", which is the safe answer.
  const { items = [], scope = 'item' } = (spec && typeof spec === 'object') ? spec : {};
  const rows = Array.isArray(items) ? items : [];
  if (!rows.length) return { ok: false, reason: 'no-candidates' };
  const n = scope === 'run' ? 1 : rows.length;
  return { ok: true, count: n, subjects: rows.length, capped: scope !== 'run' && rows.length > CASE_WINDOW };
}

/**
 * What a case can honestly RECORD about one item, derived from the run — never from the model. PURE.
 *
 * Returns the stage lines that actually ran. `asked` is the user's phrasing; when it requests detail no stage
 * produced, the gap is NAMED rather than left to look like an omission. A reviewer must be able to tell "no
 * replacements were counted" from "nobody counted".
 */
export function caseRecord(item, opts) {
  const { asked = '', stages = [] } = (opts && typeof opts === 'object') ? opts : {};
  const st = (Array.isArray(stages) ? stages : []).filter((s) => s && _str(s.name));
  const lines = st.map((s) => `${_str(s.name)} → ${_str(s.verdict)}${_str(s.detail) ? ` (${_str(s.detail)})` : ''}`);
  const known = new Set(st.map((s) => _str(s.name).toLowerCase()));
  // Only a stage that READ something can support a claim about quantities or kinds. `branch` sorts; it does not
  // count. This is a deliberately dumb check — it asks whether a reading stage ran at all, not whether it found
  // the specific thing, because the alternative is parsing the ask for nouns and guessing.
  const wantsDetail = /\b(number|how many|count|quantity|type|kind|which items?)\b/i.test(_str(asked));
  const read = known.has('fieldread') || known.has('map') || known.has('upsert');
  return {
    lines,
    gap: (wantsDetail && !read)
      ? 'asked for detail no step read — recorded what the run produced'
      : '',
  };
}

/** The honest tally, every class named including the zeroes (§5.5). */
export function caseTally({ opened = 0, updated = 0, alreadyOpen = 0, failed = 0, capped = false, total = 0 } = {}) {
  const n = opened + updated + alreadyOpen + failed;
  const head = `${n} case${n === 1 ? '' : 's'}${capped && total > n ? ` (first ${n} of ${total})` : ''}`;
  return `${head} — ${opened} opened · ${updated} updated · ${alreadyOpen} already open · ${failed} couldn’t save`;
}
