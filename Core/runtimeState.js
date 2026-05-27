/**
 * @file Core/runtimeState.js
 * @description Pure logic for the runtime/ partition (STORAGE_SCHEMA §6) — the parts with real
 *   algorithmic content, kept I/O-free and testable. The runtime partition is ephemeral and
 *   wipeable; this module provides:
 *     • event retention pruning (per-kind windows) + indexed views (by-kind / by-ground)
 *     • long-running execution: checkpoint selection + crash-recovery resume point
 *     • execution aggregation rollups (success rate / mean duration / common failure modes)
 *
 *   It deliberately does NOT touch persistence (no IndexedDB store / DB-version bump) — wiring the
 *   runtime stores is a coordinated step since the IndexedDB schema is shared. It also does not
 *   duplicate Core/outcomes.js (resolve/locate convention histograms + confidence decay); this is
 *   the execution-lifecycle + event-retention layer those streams feed.
 *
 * @see ../schemas/orchard/STORAGE_SCHEMA_REVISED.md §6
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {Object} RuntimeEvent
 * @property {string} kind        event kind (e.g. 'workflow-completed', 'landmark-resolved')
 * @property {number} at          emit timestamp (ms)
 * @property {string} [groundId]
 * @property {unknown} [payload]
 */

/**
 * Prune an append-only event stream by retention window. Default 24h (§6); override per kind.
 * @param {RuntimeEvent[]} events
 * @param {{ now?: number, defaultRetentionMs?: number, retentionByKind?: Record<string, number> }} [opts]
 * @returns {{ kept: RuntimeEvent[], pruned: RuntimeEvent[] }}
 */
export function pruneEvents(events, opts = {}) {
  const now = opts.now ?? Date.now();
  const def = opts.defaultRetentionMs ?? DAY_MS;
  const byKind = opts.retentionByKind || {};
  /** @type {RuntimeEvent[]} */ const kept = [];
  /** @type {RuntimeEvent[]} */ const pruned = [];
  for (const ev of events || []) {
    if (!ev || typeof ev.at !== 'number') { pruned.push(ev); continue; }
    const window = typeof byKind[ev.kind] === 'number' ? byKind[ev.kind] : def;
    if (window < 0 || (now - ev.at) <= window) kept.push(ev);
    else pruned.push(ev);
  }
  return { kept, pruned };
}

/**
 * Group events into indexed views (the §6 by-kind / by-ground projections).
 * @param {RuntimeEvent[]} events
 * @param {'kind'|'groundId'} field
 * @returns {Map<string, RuntimeEvent[]>}
 */
export function groupEventsBy(events, field) {
  /** @type {Map<string, RuntimeEvent[]>} */
  const map = new Map();
  for (const ev of events || []) {
    const key = ev && ev[field] != null ? String(ev[field]) : '';
    if (!key) continue;
    const list = map.get(key) || [];
    list.push(ev);
    map.set(key, list);
  }
  return map;
}

// ── Long-running execution: checkpoints + crash recovery (§6) ────────────────────────

/**
 * @typedef {Object} Checkpoint
 * @property {number} iteration   monotonically increasing iteration index
 * @property {number} at          checkpoint timestamp (ms)
 * @property {unknown} [state]    resumable state snapshot
 */

/**
 * The checkpoint to resume from after a crash: highest iteration, tie-broken by latest timestamp.
 * @param {Checkpoint[]} checkpoints
 * @returns {Checkpoint|null}
 */
export function latestCheckpoint(checkpoints) {
  let best = null;
  for (const cp of checkpoints || []) {
    if (!cp || typeof cp.iteration !== 'number') continue;
    if (!best
      || cp.iteration > best.iteration
      || (cp.iteration === best.iteration && (cp.at || 0) > (best.at || 0))) {
      best = cp;
    }
  }
  return best;
}

/**
 * Compute the resume point for crash recovery: the last checkpoint plus the next iteration to run.
 * @param {{ status?: string, totalIterations?: number }} executionState
 * @param {Checkpoint[]} checkpoints
 * @returns {{ resumable: boolean, fromCheckpoint: Checkpoint|null, nextIteration: number, done: boolean }}
 */
export function resumePoint(executionState, checkpoints) {
  const last = latestCheckpoint(checkpoints);
  const total = Number(executionState?.totalIterations);
  const nextIteration = last ? last.iteration + 1 : 0;
  const done = executionState?.status === 'completed'
    || (Number.isFinite(total) && total >= 0 && nextIteration >= total);
  return {
    resumable: !done && executionState?.status !== 'aborted',
    fromCheckpoint: last,
    nextIteration,
    done,
  };
}

// ── Aggregation rollups (§6 runtime/aggregations) ────────────────────────────────────

/**
 * @typedef {Object} ExecutionRollup
 * @property {string} id
 * @property {number} executionCount
 * @property {number} successRate            0..1
 * @property {number} meanDurationMs
 * @property {Array<{ kind: string, count: number, lastAt: number }>} commonFailureModes
 * @property {number} lastComputedAt
 */

/**
 * Aggregate execution-completion events into per-id rollups (e.g. by workflow / fragment).
 * Each event is expected as { [idKey]: string, at, success?: boolean, durationMs?: number,
 * failureKind?: string }.
 * @param {Array<Record<string, unknown>>} events
 * @param {{ idKey?: string, now?: number }} [opts]
 * @returns {Map<string, ExecutionRollup>}
 */
export function aggregateExecutions(events, opts = {}) {
  const idKey = opts.idKey || 'workflowId';
  const now = opts.now ?? Date.now();
  /** @type {Map<string, { count: number, successes: number, durSum: number, durN: number, fails: Map<string, { count: number, lastAt: number }> }>} */
  const acc = new Map();

  for (const ev of events || []) {
    if (!ev) continue;
    const id = ev[idKey] != null ? String(ev[idKey]) : '';
    if (!id) continue;
    const a = acc.get(id) || { count: 0, successes: 0, durSum: 0, durN: 0, fails: new Map() };
    a.count += 1;
    if (ev.success === true) a.successes += 1;
    if (typeof ev.durationMs === 'number' && Number.isFinite(ev.durationMs)) { a.durSum += ev.durationMs; a.durN += 1; }
    if (ev.success === false && ev.failureKind) {
      const fk = String(ev.failureKind);
      const f = a.fails.get(fk) || { count: 0, lastAt: 0 };
      f.count += 1;
      f.lastAt = Math.max(f.lastAt, Number(ev.at) || 0);
      a.fails.set(fk, f);
    }
    acc.set(id, a);
  }

  /** @type {Map<string, ExecutionRollup>} */
  const out = new Map();
  for (const [id, a] of acc) {
    const commonFailureModes = [...a.fails.entries()]
      .map(([kind, f]) => ({ kind, count: f.count, lastAt: f.lastAt }))
      .sort((x, y) => y.count - x.count || y.lastAt - x.lastAt);
    out.set(id, {
      id,
      executionCount: a.count,
      successRate: a.count ? a.successes / a.count : 0,
      meanDurationMs: a.durN ? Math.round(a.durSum / a.durN) : 0,
      commonFailureModes,
      lastComputedAt: now,
    });
  }
  return out;
}
