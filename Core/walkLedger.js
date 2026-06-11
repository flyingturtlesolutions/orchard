// Core/walkLedger.js — CR-D7 (v2.74.946): the walk's OUTCOME LEDGER, extracted PURE from chat.js.
// The recap (per-step outcome counts + the ring-buffer line), the step-boundary decision (whose
// done-BEFORE-abort ordering IS the .919 stop-at-end fix — a "stop" typed while the LAST step runs is a
// finish, not "Stopped at step N+1 of N"), and the end-of-walk message composition all lived untested in
// the DOM file; the stop-at-end bug is what that cost. chat.js keeps the impure shell (flags, appendMessage,
// the ring logger) and consumes these.
//
// The ledger state `st`: { total, results: [{clause, outcome}], preSkipped } — results is SPARSE (a step
// the walk never reached has no entry → counted "unreached").
//
// PURE. @module Core/walkLedger

/**
 * v2.74.914 — fold the ledger: chat gets the counts, the ring gets the per-step detail.
 * @param {{total:number, results?:Array, preSkipped?:number}} st
 * @returns {{chat:string, ring:string}}
 */
export function walkRecap(st) {
  const rs = Array.isArray(st.results) ? st.results : [];
  const counts = new Map();
  for (let i = 0; i < st.total; i++) { const o = (rs[i] && rs[i].outcome) || 'unreached'; counts.set(o, (counts.get(o) || 0) + 1); }
  const chat = [...counts.entries()].map(([o, n]) => `${o} ${n}`).join(' · ') + (st.preSkipped ? ` · not walkable ${st.preSkipped}` : '');
  const ring = Array.from({ length: st.total }, (_, i) => `${i + 1}:${(rs[i] && rs[i].outcome) || 'unreached'}`).join(' ');
  return { chat, ring };
}

/**
 * The step-boundary decision. ORDER MATTERS: done is checked BEFORE abort (v2.74.919 / CR-S3) so a stop
 * requested during the final step still ends as 'done' — the work all happened.
 * @param {{index:number, total:number, abortRequested:boolean}} args
 * @returns {'done'|'stopped by user'|null} the end reason, or null = keep walking
 */
export function walkBoundary({ index, total, abortRequested }) {
  if (index >= total) return 'done';
  if (abortRequested) return 'stopped by user';   // v2.74.907 — the "stop" keyword halts at the step boundary
  return null;
}

/**
 * Compose the end-of-walk lines (v2.74.919 — ONE exit for every way a walk ends renders these).
 * `log` is the ring-buffer line (caller prefixes its channel tag, e.g. "WALK ▸ "); `chat` is the
 * user-facing recap. `i` is the step index the walk ended ON (clamped into 1..total for display).
 * @param {{total:number, results?:Array, preSkipped?:number}} st
 * @param {number} i
 * @param {string} reason  'done' | 'errored' | 'stopped' | 'stopped by user' | …
 * @returns {{done:boolean, log:string, chat:string}}
 */
export function walkEndLines(st, i, reason) {
  const rec = walkRecap(st);
  const done = reason === 'done';
  const where = done ? '' : ` at step ${Math.min(i + 1, st.total)} of ${st.total}`;
  const log = `${done ? 'done' : reason}${where} — ${st.total} step(s) [${rec.ring}]${st.preSkipped ? ` +${st.preSkipped} not-walkable` : ''}`;
  const chat = done
    ? `✓ Walk finished — ${st.total} step${st.total === 1 ? '' : 's'}: ${rec.chat}.`
    : `⏹ ${reason === 'errored' ? 'Walk stopped on an error' : 'Stopped the walk'}${where} — ${rec.chat}. Steps already completed stay done.`;
  return { done, log, chat };
}
