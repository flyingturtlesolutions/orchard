// Core/interactionTrace.js — C4 (v2.74.892): the L3 RECORDER — an append-only session ring of
// ClassifiedInteractions. This is the stream the monitoring phase exists to produce: Interpret
// subscribes to THIS (never re-parses DOM). PURE — no chrome/Services/LLM/Date.now; the caller
// stamps timestamps. The state object is owned by the caller and mutated in place on append (a
// per-event hot path must not copy a 500-entry ring); every function degrades on malformed input.
//
// PRIVACY — entries hold ClassifiedInteractions, which are VALUE-FREE by construction (the C2a
// invariant: a RawInteraction never carries a typed value, only inputType + lengthDelta, withheld
// for sensitive fields). The trace therefore inherits the privacy invariant end-to-end.
//
// SCOPE (spec §12, resolved for v1): ONE session-global ring; entries carry tabId + groundId so a
// consumer filters per tab/Ground. In-memory ⇒ cleared on an MV3 service-worker restart (v1 per
// the C4 slice; durable persistence is the C5 outcomes adapter's job).

import { makeEvent } from './outcomes.js';   // C5 — the durable-stream adapter emits OutcomeEvents (Core-pure import)

export const TRACE_CAP = 500;

/** Fresh trace state. `seq` is monotonic across the whole session — it keeps increasing as the
 *  ring trims, so `sinceSeq` incremental pulls stay valid after old entries drop. */
export function makeTrace({ cap = TRACE_CAP } = {}) {
  const n = Number(cap);
  return { cap: Number.isFinite(n) && n > 0 ? Math.floor(n) : TRACE_CAP, seq: 0, entries: [] };
}

/**
 * Append one ClassifiedInteraction. Lifts the cheap filter/stat keys (tier, verb) beside the
 * verbatim `classified` payload; trims the ring to cap from the FRONT (oldest out).
 * @param {{cap:number,seq:number,entries:object[]}} trace  state from makeTrace (mutated in place)
 * @param {object} classified  the C0 output (stored verbatim)
 * @param {{ts?:(number|null), tabId?:(number|null), groundId?:(string|null)}} [meta]
 * @returns {object|null} the appended entry, or null (invalid input → trace unchanged)
 */
export function appendEntry(trace, classified, { ts = null, tabId = null, groundId = null } = {}) {
  if (!trace || !Array.isArray(trace.entries) || !classified || typeof classified !== 'object') return null;
  const verb = (classified.primary && classified.primary.semanticVerb)
    || (Array.isArray(classified.candidates) && classified.candidates[0] && classified.candidates[0].semanticVerb)
    || null;
  const entry = {
    seq: ++trace.seq,
    ts: Number.isFinite(ts) ? ts : null,
    tabId: Number.isFinite(tabId) ? tabId : null,
    groundId: typeof groundId === 'string' && groundId ? groundId : null,
    tier: typeof classified.tier === 'string' && classified.tier ? classified.tier : 'unresolved',
    verb,
    classified,
  };
  trace.entries.push(entry);
  while (trace.entries.length > trace.cap) trace.entries.shift();
  return entry;
}

/**
 * Read the trace, oldest→newest. All filters optional: `tabId`/`groundId` exact-match,
 * `sinceSeq` keeps entries with seq > sinceSeq (incremental pull — pass the last seq you saw),
 * `limit` keeps the most-RECENT n after filtering (the tail). Returns the entry objects
 * themselves (treat as read-only); the classified payloads are not copied.
 */
export function snapshot(trace, { tabId = null, groundId = null, sinceSeq = null, limit = null } = {}) {
  if (!trace || !Array.isArray(trace.entries)) return [];
  let out = trace.entries;
  if (Number.isFinite(tabId)) out = out.filter((e) => e.tabId === tabId);
  if (typeof groundId === 'string' && groundId) out = out.filter((e) => e.groundId === groundId);
  if (Number.isFinite(sinceSeq)) out = out.filter((e) => e.seq > sinceSeq);
  if (Number.isFinite(limit) && limit >= 0 && out.length > limit) out = out.slice(out.length - limit);
  return out === trace.entries ? out.slice() : out;
}

/**
 * C5 (v2.74.893) — the OUTCOMES adapter: trace entries → durable `op:'user-interaction'` events.
 * AGGREGATED, not per-event: groups SUBSTRATE-tier entries by (groundId, landmarkUid, verb) and emits ONE
 * runtime event per group with a count + ts span — the durable usage signal is "this landmark is alive and
 * used", not a keystroke log; aggregation also keeps the per-Ground outcomes stream (cap 1000) from being
 * flooded by one busy session. Browser/unresolved tiers and ground-less entries stay in-memory only (they
 * carry no artifact-health signal). The event lifts the primary's perspectiveId so perspective-usage
 * rollups see real user activity. PURE (the minted event id is the outcomes module's own entropy).
 * @param {object[]} entries  trace entries (from snapshot)
 * @returns {object[]} OutcomeEvent[]
 */
export function eventsFromEntries(entries) {
  const groups = new Map();
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || e.tier !== 'substrate' || !e.groundId) continue;
    const primary = e.classified && e.classified.primary;
    const landmarkUid = primary && primary.landmarkUid;
    if (!landmarkUid) continue;
    const key = `${e.groundId}|${landmarkUid}|${e.verb || ''}`;
    let g = groups.get(key);
    if (!g) { g = { groundId: e.groundId, landmarkUid, verb: e.verb || null, perspectiveId: primary.perspectiveId ?? null, count: 0, firstTs: e.ts, lastTs: e.ts }; groups.set(key, g); }
    g.count++;
    if (Number.isFinite(e.ts)) {
      if (!Number.isFinite(g.firstTs) || e.ts < g.firstTs) g.firstTs = e.ts;
      if (!Number.isFinite(g.lastTs) || e.ts > g.lastTs) g.lastTs = e.ts;
    }
  }
  return [...groups.values()].map((g) => makeEvent({
    phase: 'runtime', op: 'user-interaction',
    groundId: g.groundId, perspectiveId: g.perspectiveId,
    ts: Number.isFinite(g.lastTs) ? g.lastTs : undefined,
    detail: { landmarkUid: g.landmarkUid, verb: g.verb, tier: 'substrate', count: g.count, firstTs: g.firstTs ?? null, lastTs: g.lastTs ?? null },
  }));
}

/** Cheap counters for a viewer/log line: size, cap, seq bounds, per-tier tallies. */
export function traceStats(trace) {
  if (!trace || !Array.isArray(trace.entries)) return { size: 0, cap: 0, firstSeq: null, lastSeq: null, byTier: {} };
  const byTier = {};
  for (const e of trace.entries) byTier[e.tier] = (byTier[e.tier] || 0) + 1;
  return {
    size: trace.entries.length,
    cap: trace.cap,
    firstSeq: trace.entries.length ? trace.entries[0].seq : null,
    lastSeq: trace.entries.length ? trace.entries[trace.entries.length - 1].seq : null,
    byTier,
  };
}
