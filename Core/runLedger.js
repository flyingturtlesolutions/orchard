// Core/runLedger.js — OB-1 (v2.74.1831): the two observability primitives this arc kept needing. PURE: no
// chrome / DOM / LLM / clock (the caller measures elapsed time and passes it in — same injection style as
// evalBranch taking its evaluator, and it keeps this file trivially testable).
//
// WHY (three mysteries in one session, all the same shape):
//   • `WORKFLOW ▸ step 1 PINNED → …` then 15 hours of nothing.
//   • `RIDE_DRILL ▸ … × 2 (fan-out spawn)` then 16 seconds of nothing — a step that did 4 API reads, created
//     nothing, and returned SUCCESS (all-already-open is idempotent, so `ok` was true).
//   • `DISPATCH ▸ branch → chain` then 53 seconds of nothing.
// Every one ended a turn having touched no artifact and raised no error, and every one was invisible. That is
// ONE checkable condition, not three bugs — which is the whole point of this file. Instrumenting paths one at
// a time only ever catches the paths you thought of.
//
// TWO PRIMITIVES:
//   1. renderSpan  — a paired exit. Entry lines already exist everywhere; it is the EXIT that goes missing on
//      an early return, so callers emit this from a `finally` (the discipline `markEngineBusy` already proves
//      works in this codebase). An unskippable exit turns a hole into a duration plus a cause.
//   2. RunLedger   — the turn-level backstop. Counts EFFECTS (artifacts touched), not words: "Couldn't read the
//      list to fan out over" is text, and it is exactly the outcome we want flagged, so text must not count as
//      having done something.

const _s = (v) => (v == null ? '' : String(v).trim());
const _ms = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : null);

/** Outcomes a span may report. `no-effect` is the one that used to masquerade as success. */
export const SPAN_OUTCOMES = Object.freeze(['ok', 'no-effect', 'failed', 'stopped', 'skipped']);

/**
 * Render a paired EXIT line. PURE — the caller measures `ms`.
 * `cause` is the short machine code that makes a message diagnosable: "Couldn't read the list to fan out over"
 * covers a failed read, an empty result, no prior list, and a step that never started. Four situations, one
 * sentence. The code is what tells them apart next time.
 */
export function renderSpan({ name, ms, outcome = 'ok', cause = '', detail = '' } = {}) {
  const n = _s(name);
  if (!n) return '';
  const o = SPAN_OUTCOMES.includes(outcome) ? outcome : 'failed';
  const bits = [n, o === 'ok' ? 'ok' : o.toUpperCase()];
  const t = _ms(ms);
  if (t != null) bits.push(`${t}ms`);
  const c = _s(cause);
  if (c) bits.push(`cause=${c}`);
  const d = _s(detail);
  if (d) bits.push(d);
  return `SPAN ▸ ${bits.join(' · ')}`;
}

/**
 * The per-turn effect ledger. Deterministic and clock-free; the caller owns its lifetime (one per turn).
 *
 * `effect` = an ARTIFACT was touched — a case opened or updated, a record written, a value persisted. Reading,
 * rendering and explaining are NOT effects. That distinction is the entire value of this thing: a turn that
 * reads 4 records, renders a sentence and changes nothing is precisely the failure that has been invisible.
 */
export function createRunLedger() {
  const effects = new Map();   // kind → count
  let errors = 0;
  let rowsRead = 0;
  let lastDecision = '';
  return {
    /**
     * Rows a READ returned. NOT an effect — it never counts toward `touched`, because a turn that reads four
     * records and then does nothing is the failure this whole file exists to catch (live 07-25).
     *
     * It is tracked separately so the backstop can tell apart two cases that look identical in artifact terms
     * (live 07-26 18:38, my own false positive): a step whose JOB was to read and did it, versus a step that
     * got nowhere. The discriminator is whether an artifact stage was ATTEMPTED at all — see renderNoEffect.
     */
    read(n = 0) { const c = Number(n); if (Number.isFinite(c) && c > 0) rowsRead += c; return this; },
    /** An artifact was touched. `n` may be 0 — recording a ZERO is how "I tried and nothing happened" survives. */
    effect(kind, n = 1) {
      const k = _s(kind) || 'artifact';
      const c = Number(n);
      effects.set(k, (effects.get(k) || 0) + (Number.isFinite(c) ? c : 0));
      return this;
    },
    /** An error surfaced. A turn that errored is NOT silent — it is already diagnosable, so the backstop skips it. */
    error() { errors++; return this; },
    /** The furthest decision the turn reached. This is what makes a no-effect line actionable rather than merely true. */
    decision(text) { const t = _s(text); if (t) lastDecision = t.slice(0, 160); return this; },
    snapshot() {
      const touched = [...effects.values()].reduce((a, b) => a + b, 0);
      return { effects: Object.fromEntries(effects), touched, errors, rowsRead, lastDecision, kinds: [...effects.keys()] };
    },
  };
}

/**
 * The BACKSTOP line, or '' when the turn is already accounted for. PURE.
 *
 * Fires only when a turn touched NOTHING and raised NO error — the exact signature of all three silent
 * failures above. A turn that errored is already diagnosable; a turn that opened a case did something. Returning
 * '' in those cases is what keeps this from becoming noise on every ordinary read.
 */
export function renderNoEffect(ledger, { ms, ask = '' } = {}) {
  const snap = (ledger && typeof ledger.snapshot === 'function') ? ledger.snapshot() : null;
  if (!snap) return '';
  if (snap.errors > 0) return '';     // already visible
  if (snap.touched > 0) return '';    // something actually happened
  // v2.74.1834 — A READ THAT RETURNED DATA DID ITS JOB. snap.kinds is empty only when NO artifact stage was
  // attempted, so an empty kinds + rows read means this turn was a read and succeeded at being one. Firing
  // there was a false positive on a working step (live 07-26 18:38, step 1 of a workflow) — and a backstop
  // that cries wolf on success is the moment people stop reading it.
  //   kinds=[case], case 0, rows 2 → FIRES (tried to spawn, produced nothing — the 07-25 step-4 failure)
  //   kinds=[],     rows 2        → quiet (a pure read)
  //   kinds=[],     rows 0        → FIRES (nothing read, nothing made, nothing failed — the original signature)
  if (!snap.kinds.length && snap.rowsRead > 0) return '';
  const bits = ['no-effect — nothing was created, updated or written, and nothing failed'];
  const t = _ms(ms);
  if (t != null) bits.push(`${t}ms`);
  // The zero-valued kinds matter MORE than the absent ones: "case 0" means it tried and produced nothing,
  // while no case entry at all means it never got that far. Different bugs, and the line must tell them apart.
  if (snap.kinds.length) bits.push(`attempted: ${snap.kinds.map((k) => `${k} ${snap.effects[k]}`).join(', ')}`);
  if (snap.rowsRead > 0) bits.push(`${snap.rowsRead} row(s) read`);   // rows in hand but nothing done with them is the sharpest form of this failure
  if (snap.lastDecision) bits.push(`last decision: ${snap.lastDecision}`);
  const a = _s(ask);
  if (a) bits.push(`ask: "${a.slice(0, 80)}"`);
  return `RUN ▸ ${bits.join(' · ')}`;
}

/**
 * v2.74.1859 — THE RUN-LEVEL TERMINAL, always. PURE.
 *
 * `renderNoEffect` is a BACKSTOP by design: it stays quiet on an errored turn ("already diagnosable") and on a
 * plain successful read. That made it the only run-level line — so the moment v1858 gave `error()` a producer,
 * an errored replay ended with NO run receipt at all (caught by trace-lint on its very next run: the leg line
 * accounts for the LEG, the run still owed its own). A span that opened must close, whatever the outcome.
 *
 * Delegates to the backstop for the no-effect signature (that wording is load-bearing and stays byte-identical),
 * and otherwise states the outcome: failed · partial · ok. This is also the SOURCE OF TRUTH a run's recorded
 * verdict should derive from — outcomes, never step positions (the v1780 card ruling, one layer down).
 */
export function renderRunReceipt(ledger, { ms, ask = '' } = {}) {
  const snap = (ledger && typeof ledger.snapshot === 'function') ? ledger.snapshot() : null;
  if (!snap) return '';
  const backstop = renderNoEffect(ledger, { ms, ask });
  if (backstop) return backstop;                       // the no-effect signature keeps its exact wording
  const bits = [];
  const made = snap.kinds.length ? snap.kinds.map((k) => `${k} ${snap.effects[k]}`).join(', ') : '';
  if (snap.errors > 0 && snap.touched === 0) bits.push('failed — nothing was created, updated or written');
  else if (snap.errors > 0) bits.push(`partial — ${made}`);
  else bits.push(`ok${made ? ` — ${made}` : ''}`);
  if (snap.errors > 0) bits.push(`${snap.errors} step(s) failed`);
  const t = _ms(ms);
  if (t != null) bits.push(`${t}ms`);
  if (snap.rowsRead > 0) bits.push(`${snap.rowsRead} row(s) read`);
  if (snap.lastDecision) bits.push(`last decision: ${snap.lastDecision}`);
  const a = _s(ask);
  if (a) bits.push(`ask: "${a.slice(0, 80)}"`);
  return `RUN ▸ ${bits.join(' · ')}`;
}

/**
 * v2.74.1859 — the recorded VERDICT for a run, derived from what happened. PURE.
 * Replaces the positional `ranSteps.length >= total ? 'complete' : …` (chat.js `_wfRecordPanelRun`), which
 * counted DISPATCHES: a 1-step workflow whose only step failed recorded `complete` on the Rail card, and this
 * run's 2-step replay recorded `partial` having produced nothing. `ranSteps` still supplies the COUNTS.
 */
export function runVerdict(snapshot, { done = 0, total = 0 } = {}) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : null;
  const errors = s && Number.isFinite(s.errors) ? s.errors : 0;
  const touched = s && Number.isFinite(s.touched) ? s.touched : 0;
  const rows = s && Number.isFinite(s.rowsRead) ? s.rowsRead : 0;
  const did = touched > 0 || rows > 0;
  if (errors > 0) return did ? 'partial' : 'failed';   // something failed: only 'complete' is ruled out absolutely
  if (!s) return done >= total && total > 0 ? 'complete' : (done > 0 ? 'partial' : 'failed');   // no ledger → the legacy positional read
  // v2.74.2042 — steps ran, nothing errored, empty result / empty-prior stop: "found nothing" is partial
  // with a why, not failed (Warranty ride ×121 divisions → 0 rows → map stopped — user: not a failure).
  if (!did) return (errors === 0 && done > 0) ? 'partial' : 'failed';
  return done >= total && total > 0 ? 'complete' : 'partial';
}
