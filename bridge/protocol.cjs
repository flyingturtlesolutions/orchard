'use strict';
// bridge/protocol.cjs — DBR-P4-2 (docs/DESIGN_dev_branches.md §10): the `v:2` run-multiplexed protocol primitives.
//
// §10 turns one native-messaging port into N channels by tagging every RUN-SCOPED frame (both directions) with a
// `runId` — the panel demultiplexes by it. The protocol bumps `v:1`→`v:2`; only ONE new frame type (`pool`) is
// added, the rest just gain `runId`. This module is the PURE toolkit (the host requires it; unit-tested under
// `npm test`). The PANEL keeps its own copy of `PROTO_V` (it's browser ESM and can't `require` a `.cjs`) — the
// version number is duplicated by the browser/Node boundary, exactly like the rest of the bridge split.
//
// CUTOVER (sign-off 2026-06-18): host + panel ship + reload together, so `v:1`→`v:2` is a HARD cutover — a v:1
// frame fails the panel's `m.v === PROTO_V` check and is dropped. No mixed-version runtime; reload both together.

const PROTO_V = 2;

// RUN-SCOPED frame types carry a `runId` (both directions). Non-run frames (git/test/preflight/status/history/
// pool) are connection-scoped, never tagged. `run`/`pause`/`approval-decision` are panel→host; the rest host→panel.
const RUN_SCOPED = new Set(['run', 'event', 'done', 'error', 'started', 'pause', 'approval', 'approval-decision', 'meta']);
function isRunScoped(type) { return RUN_SCOPED.has(String(type)); }

// tagFrame — stamp a run-scoped frame with its `runId` (idempotent; never tags a non-run frame). PURE.
function tagFrame(frame, runId) {
  if (!frame || typeof frame !== 'object') return frame;
  if (!isRunScoped(frame.type) || runId == null) return frame;
  return { ...frame, runId: String(runId) };
}

// frameRunId — the `runId` a frame belongs to, or null for a connection-scoped frame / a missing tag. PURE.
function frameRunId(frame) {
  return (frame && typeof frame === 'object' && typeof frame.runId === 'string' && frame.runId) ? frame.runId : null;
}

// poolSnapshot — the `pool` frame's payload from the run-pool's live runs + the cap. Each entry is the minimal
// public shape `{ runId, conv?, pid? }`. PURE (a `runs` Map or an array of {runId,…} both work). At cap=1 it's a
// 0-or-1 element list — trivial, but the same shape concurrency uses.
function poolSnapshot(runs, cap) {
  const iter = runs instanceof Map ? runs.values() : (Array.isArray(runs) ? runs : []);
  const running = [];
  for (const r of iter) {
    if (!r) continue;
    const runId = String(r.runId || r.id || '');
    if (!runId) continue;
    const e = { runId };
    if (r.conv != null || r.conversationId != null) e.conv = String(r.conv != null ? r.conv : r.conversationId);
    if (r.pid != null) e.pid = r.pid;
    running.push(e);
  }
  return { running, cap: Number.isFinite(cap) ? cap : (running.length || 1) };
}

// ── DBR-P4-3 (§10) — the run-pool SCHEDULING core. PURE. The host owns the `runs` Map + the FIFO `queue`; these
// decide when a queued run may START and where it sits IN LINE. `cap` = MAX_CONCURRENT (the compute-slot ration);
// a SEPARATE hard `ceiling` stops runaway pile-ups (reject, not queue — §10/U10).
const DEFAULT_CAP = 4;       // MAX_CONCURRENT default; the cost/rate governor (N concurrent Claude ≈ N× burn)
const QUEUE_CEILING = 32;    // hard FIFO depth cap — beyond this, REJECT a new run (runaway guard), never silently grow

// canStart — is a compute slot free (running below the cap)? PURE.
function canStart(runningCount, cap) {
  const c = Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_CAP;
  return (Number(runningCount) || 0) < c;
}

// nextQueued — the FIFO head to auto-start when a slot frees (null if the queue is empty). PURE.
function nextQueued(queue) {
  const q = Array.isArray(queue) ? queue : [];
  return q.length ? q[0] : null;
}

// queuePosition — 1-based "Nth in line" for a runId (0 = not in the queue). Accepts entries as {runId}|{id}|string. PURE.
function queuePosition(queue, runId) {
  const i = (Array.isArray(queue) ? queue : []).findIndex((q) => q === runId || (q && (q.runId === runId || q.id === runId)));
  return i < 0 ? 0 : i + 1;
}

// queueAccepts — may a new run JOIN the queue, or is the hard ceiling hit (→ reject the runaway)? PURE.
function queueAccepts(queueDepth, ceiling) {
  const cap = Number.isFinite(ceiling) && ceiling > 0 ? ceiling : QUEUE_CEILING;
  return (Number(queueDepth) || 0) < cap;
}

module.exports = { PROTO_V, RUN_SCOPED, isRunScoped, tagFrame, frameRunId, poolSnapshot,
  DEFAULT_CAP, QUEUE_CEILING, canStart, nextQueued, queuePosition, queueAccepts };
