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

module.exports = { PROTO_V, RUN_SCOPED, isRunScoped, tagFrame, frameRunId, poolSnapshot };
