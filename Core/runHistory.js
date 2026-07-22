// Core/runHistory.js — CD-5 (DESIGN_cadence.md §6.3 / §6.4): the run-history ENTRY shape, tally, and per-workflow
// retention with a VISIBLE truncation notice. PURE. The store (Services/Storage/WorkflowRunStore.js) wraps these;
// the SW reporter's done() and the panel's manual runs both write through the same shape.
//
// History is RUN-level (§6.3): one row per fire — "09:00 · auto · 22 items · 6 matched · 2 parked". Per-item
// detail already lives in pipelineRun records and parked cases; a row points at them, never inlines them. The
// `verdict` reuses Core/pipelineRun's run verdict (already computed and thrown away on every scheduled path today)
// plus the cadence-only terminal states a scheduled run can reach.

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** The auto-vs-manual stamp — the discriminator the whole surface exists to show (§6.3). */
export const HISTORY_TRIGGERS = Object.freeze(['auto', 'manual']);

/**
 * A run's terminal verdict: the five pipelineRun verdicts + the two states only a SCHEDULED run reaches —
 * `parked` (a write stopped it for a human, §8) and `disarmed` (auto-disarm on failure/orphan, §7.2). Keeping
 * these in one enum is what lets the surface say "ran and is waiting on you" vs "ran clean" (§8's load-bearing
 * distinction) from a single field.
 */
export const HISTORY_VERDICTS = Object.freeze(['complete', 'partial', 'failed', 'empty', 'running', 'parked', 'disarmed']);

export const HISTORY_CAP = 100;   // per WORKFLOW, never global — the action-ledger's shared cap-500 is the cautionary tale (§6.4)

/**
 * Normalize one run entry. PURE. Everything optional defaults to an honest empty; unknown trigger/verdict fall to
 * the safe value rather than being stored raw.
 *
 * @param {{at?:number, trigger?:string, verdict?:string, counts?:object, parkedRunId?:string, why?:string,
 *          coalesced?:number, ranAt?:number}} f
 */
export function runHistoryEntry(f = {}) {
  const at = Number.isFinite(f.at) && f.at > 0 ? f.at : 0;
  const ranAt = Number.isFinite(f.ranAt) && f.ranAt > 0 ? f.ranAt : 0;
  const coalesced = Number.isFinite(f.coalesced) && f.coalesced > 1 ? Math.floor(f.coalesced) : 0;
  return {
    at,
    trigger: HISTORY_TRIGGERS.includes(f.trigger) ? f.trigger : 'manual',
    verdict: HISTORY_VERDICTS.includes(f.verdict) ? f.verdict : 'failed',
    counts: (f.counts && typeof f.counts === 'object') ? { ...f.counts } : null,
    ...(f.parkedRunId ? { parkedRunId: _str(f.parkedRunId) } : {}),          // §8 — points at the wfp_ case
    ...(f.why ? { why: _str(f.why).slice(0, 200) } : {}),                    // the disarm reason / stop cause
    ...(coalesced ? { coalesced } : {}),                                     // §7.2 — "3 due-times collapsed"
    ...(ranAt && ranAt !== at ? { ranAt } : {}),                             // §7.3 — due 09:00 · ran 14:32
  };
}

/** Append an entry to a workflow's history, evicting oldest past the PER-WORKFLOW cap. PURE — returns a new array. */
export function appendRun(list, entry, { cap = HISTORY_CAP } = {}) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const c = Math.max(1, Number(cap) || HISTORY_CAP);
  return [...arr, entry].slice(-c);
}

/**
 * The truncation notice (§6.4): "auditable" and "silently evicts" cannot both be true — so when the retained list
 * is shorter than the lifetime total, the surface SAYS "showing the last 50 of 214" rather than presenting a
 * truncated list as a complete one. Empty string when nothing was dropped. PURE.
 */
export function truncationNotice(shownCount, total) {
  const s = Math.max(0, Number(shownCount) || 0);
  const t = Math.max(s, Number(total) || 0);
  return t > s ? `showing the last ${s} of ${t}` : '';
}

/** Render a run's counts compactly ("22 items · 6 matched · 2 parked"). Known keys only; PURE. */
export function describeRunCounts(counts) {
  const c = (counts && typeof counts === 'object') ? counts : null;
  if (!c) return '';
  const bits = [];
  if (Number.isFinite(c.items)) bits.push(`${c.items} item${c.items === 1 ? '' : 's'}`);
  if (c.steps) bits.push(`${c.steps} step${c.steps === 1 ? '' : 's'}`);
  if (c.done) bits.push(`${c.done} done`);
  if (c.matched) bits.push(`${c.matched} matched`);
  if (c.parked) bits.push(`${c.parked} parked`);
  if (c.failed) bits.push(`${c.failed} failed`);
  return bits.join(' · ');
}

/** The one-line run row (§6.3). "09:00 · auto · <counts> → verdict". `clock` is the caller's formatted time. PURE. */
export function describeRun(entry, clock = '') {
  const e = (entry && typeof entry === 'object') ? entry : {};
  const bits = [_str(clock), e.trigger || 'manual'];
  const counts = describeRunCounts(e.counts);
  if (counts) bits.push(counts);
  if (e.coalesced) bits.push(`${e.coalesced} due-times collapsed`);
  const tail = e.verdict === 'parked' ? 'parked — waiting on you' : (e.verdict || 'failed');
  return `${bits.filter(Boolean).join(' · ')} → ${tail}`;
}

/** Rolling counts across a workflow's retained history (feeds the overlay header). PURE. */
export function historyTally(list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  const n = Object.create(null);
  for (const v of HISTORY_VERDICTS) n[v] = 0;
  let auto = 0;
  for (const e of arr) { n[e.verdict] = (n[e.verdict] || 0) + 1; if (e.trigger === 'auto') auto++; }
  return { total: arr.length, auto, manual: arr.length - auto, byVerdict: n };
}
