/**
 * Core/pipelineRun.js — the RUN OBJECT (v2.74.1665). Pure half.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §5.6 (execution policy) · §5.7 (case + re-run) · §9.2 (the owner) ·
 * §9.7 (run verdict) · §10.3 (check before building).
 *
 * ── WHY THIS EXISTS AT ALL: PP-0e CAME BACK "NO" ─────────────────────────────────────────────────────────────
 * §10.3 said to check whether the fleet sweep's `runId` + ledger already IS a run identity before building one —
 * six times in that session, reading an existing contract collapsed a planned build into wiring. This was the
 * seventh candidate and the first that came back negative. What the read found:
 *
 *   · `runId` is a copy-pasted template literal in TWO files that have already diverged (one stamps an in-flight
 *     marker, one does not), and it is never returned from the function that mints it.
 *   · `Core/actionLedger.js` is capped at 500 entries and SILENTLY EVICTS, shared across all kinds for the
 *     instance — a per-item run writing ~3 entries per item starts evicting its OWN earliest entries near N≈150.
 *   · `ledgerEntry` is a strict field whitelist; an `itemId` or an outcome enum would be dropped with no error.
 *   · The run verdict is COMPUTED AND THROWN AWAY — the `sweep` entry is written BEFORE the execution loop, so
 *     its counts predate every outcome it appears to summarize.
 *   · Run-openness lives outside the ledger entirely, as a 5-minute wall-clock guess only one sweep twin writes.
 *
 * The ledger is a NARRATION substrate. It is genuinely append-only, runId-stamped and read back — and it still
 * cannot answer "is this run done", "which items failed stage 2", or "was this item already handled". So: a run
 * object, and the ledger keeps doing what it is good at.
 *
 * ── PURE, AND INJECTED ───────────────────────────────────────────────────────────────────────────────────────
 * No storage, no chrome, no clock. `mintRunId` takes its entropy as arguments so a test can pin it, and the
 * caller supplies `now`. Same discipline as branchClause/branchScope/upsert — the seams are where the bugs live,
 * so the decision logic is kept where it can be tested exhaustively.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));
const _arr = (v) => (Array.isArray(v) ? v : []);

/** Per-item terminal states. `already-open` is §5.7's re-run rule, not an error. */
export const ITEM_OUTCOMES = Object.freeze(['done', 'failed', 'blocked', 'skipped', 'already-open', 'not-run']);

/** Run-level verdicts (§9.7). A run that processed 3 of 22 and stopped needs one of these, not just counts. */
export const RUN_VERDICTS = Object.freeze(['complete', 'partial', 'failed', 'empty', 'running']);

/**
 * Mint a run id. The FORMAT matches the fleet sweep's existing convention deliberately — that convention is
 * fine, it was only ever the copy-paste that was wrong. Entropy is injected so this stays pure.
 */
export function mintRunId({ now = 0, rand = 0 } = {}) {
  const t = Number(now) || 0;
  const r = Math.floor(Math.abs(Number(rand) || 0) * 1e6).toString(36).slice(0, 4).padStart(4, '0');
  return `run_${t.toString(36)}_${r}`;
}

/**
 * Open a run.
 *
 * `cap` is DECLARED here and reported in the tally, which is §5.6's rule: the three existing caps
 * (`_MAP_WINDOW` 24, `WRITE_BATCH_CAP` 25, the dossier fan-out 20) disagree precisely because there was nowhere
 * for a shared policy to live. Truncation is recorded on the run, so a capped run cannot read as a full one.
 */
export function openRun({ pipeline = 'per-item', items = [], cap = 0, runId = '', now = 0, stages = [] } = {}) {
  const all = _arr(items);
  const n = Math.max(0, Number(cap) || 0);
  const use = n > 0 ? all.slice(0, n) : all;
  return {
    runId: _str(runId) || mintRunId({ now }),
    pipeline: _str(pipeline) || 'per-item',
    stages: _arr(stages).map(_str).filter(Boolean),
    startedAt: Number(now) || 0,
    endedAt: 0,
    cap: n,
    offered: all.length,
    accepted: use.length,
    truncated: all.length > use.length,
    items: use.map((it, i) => ({
      id: _str(it && it.id) || String(i),
      label: _str(it && it.label),
      outcome: 'not-run',
      why: '',
      stages: [],
      actions: [],
    })),
    aborted: false,
  };
}

const _find = (run, itemId) => (run && _arr(run.items).find((x) => x.id === _str(itemId))) || null;

/**
 * Record one STAGE result for one item. Appends — a stage that ran twice shows twice, because collapsing them
 * would hide a retry.
 *
 * §5.7: a failed stage and a stage that NEVER RAN must not look identical. That is the whole value of the record
 * to a reviewer, so `verdict` is required and an absent stage simply has no entry.
 */
export function recordStage(run, itemId, { name, verdict, detail = '', error = null } = {}) {
  const it = _find(run, itemId);
  if (!it) return run;
  it.stages.push({
    name: _str(name) || 'stage',
    verdict: _str(verdict) || 'unknown',
    detail: _str(detail).slice(0, 300),
    ...(error ? { error: _str(error && error.message ? error.message : error).slice(0, 200) } : {}),
  });
  return run;
}

/** Record an ACTION taken (or refused) for an item — §5.7's approval-state slot. */
export function recordAction(run, itemId, { what, state, ref = '' } = {}) {
  const it = _find(run, itemId);
  if (!it) return run;
  it.actions.push({ what: _str(what), state: _str(state) || 'refused', ref: _str(ref) });
  return run;
}

/** Close one item with a terminal outcome. */
export function closeItem(run, itemId, outcome, why = '') {
  const it = _find(run, itemId);
  if (!it) return run;
  it.outcome = ITEM_OUTCOMES.includes(outcome) ? outcome : 'failed';
  it.why = _str(why).slice(0, 200);
  return run;
}

/**
 * §5.7's re-run rule: the pipeline is re-runnable and NOT idempotent by default, EXCEPT that an item which
 * already has an open case for this pipeline is skipped and counted as `already-open`.
 *
 * Two protections, both needed and often confused: UPSERT's inline re-check protects the EXTERNAL system from a
 * duplicate record; this protects the REVIEW QUEUE from duplicate cases. Neither substitutes for the other.
 */
export function markAlreadyOpen(run, openItemIds) {
  const open = new Set(_arr(openItemIds).map(_str));
  for (const it of _arr(run && run.items)) {
    if (it.outcome === 'not-run' && open.has(it.id)) { it.outcome = 'already-open'; it.why = 'an open case for this pipeline already exists'; }
  }
  return run;
}

/** Close the run. `aborted` is the user's stop, which is distinct from a failure. */
export function closeRun(run, { now = 0, aborted = false } = {}) {
  if (!run) return run;
  run.endedAt = Number(now) || 0;
  run.aborted = !!aborted;
  return run;
}

/**
 * The run-level verdict (§9.7). "A run that processed 3 of 22 and stopped needs a verdict, not just counts."
 *
 * `partial` is deliberately broad — anything short of "every accepted item reached a terminal, non-failed state"
 * is partial, INCLUDING a truncated run. A capped run that did 24 of 400 perfectly is not `complete`; reporting
 * it as complete is the silent-truncation failure §5.6 exists to prevent, one layer up.
 */
export function runVerdict(run) {
  if (!run) return 'failed';
  const items = _arr(run.items);
  if (!items.length) return 'empty';
  if (!run.endedAt) return 'running';
  const notRun = items.filter((i) => i.outcome === 'not-run').length;
  const failed = items.filter((i) => i.outcome === 'failed').length;
  const settled = items.length - notRun;
  if (settled === 0) return 'failed';                       // ran, nothing reached a verdict
  if (failed === items.length) return 'failed';             // everything that ran, failed
  if (notRun || run.truncated || run.aborted || failed) return 'partial';
  return 'complete';
}

/**
 * The honest tally (§5.5). Every class named INCLUDING the zeroes, and the cap stated when it truncated —
 * "silent truncation reads as 'covered everything'".
 */
export function runTally(run) {
  if (!run) return '0 items';
  const items = _arr(run.items);
  const n = Object.create(null);
  for (const k of ITEM_OUTCOMES) n[k] = 0;
  for (const it of items) n[it.outcome] = (n[it.outcome] || 0) + 1;
  const parts = [
    `${n.done} done`, `${n.failed} failed`, `${n.blocked} blocked`,
    `${n['already-open']} already open`, `${n.skipped} skipped`, `${n['not-run']} not run`,
  ];
  const head = `${items.length} item${items.length === 1 ? '' : 's'}`;
  const trunc = run.truncated ? ` (capped ${run.accepted}/${run.offered} — ${run.offered - run.accepted} not looked at)` : '';
  return `${head}${trunc} — ${parts.join(' · ')} → ${runVerdict(run)}`;
}

/** The per-run opening line (§5.5). One per run, before anything acts. */
export function runStartLine(run) {
  if (!run) return 'PIPELINE ▸ start (no run)';
  const st = run.stages.length ? run.stages.join('→') : 'per-item';
  return `PIPELINE ▸ start run=${run.runId} items=${run.accepted}${run.truncated ? `/${run.offered}` : ''} stages=${st} cap=${run.cap || 'none'}`;
}

/** The closing line. Carries the verdict, so a reader never has to infer it from counts. */
export function runEndLine(run) {
  return `PIPELINE ▸ end run=${run && run.runId ? run.runId : '?'} → ${runTally(run)}`;
}

/**
 * The §10.1 trial tag. Every trial-created record carries it, and it matters MORE than the created id: it
 * survives a lost response or a service-worker restart, so residue is findable even when nothing was captured —
 * and a human can spot trial residue in the vendor's own UI without Orchard's help.
 */
export function trialTag(run) {
  return `orchard-trial-${(run && run.runId) || 'unknown'}`;
}
