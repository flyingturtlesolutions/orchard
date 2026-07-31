// Core/logShipping.js — CW-3 (DESIGN_cloud_logs.md §3): the PURE half of the CloudWatch log shipper.
// Level filtering, middle-out eviction (ruling 9: the onset survives, the trace records its own gaps),
// batching inside PutLogEvents limits, and backoff. Services/Cloud/CloudLogShipper.js wires chrome
// (storage, alarms, the Logger tap) around these. No DOM, no chrome — Core-testable.

/** Levels an event may carry (mirrors Core/Logger.js). */
const LEVEL_RANK = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * Which events ship at a given cloudLogs level (ruling 2).
 * 'off' → none · 'decisions' → manifest-matching lines only · 'full' → EVERYTHING, DEBUG included
 * (user ruling: the dispatch layer is where diagnoses live; cost is what quotas are for).
 * @param {Array<{lvl:string,msg:string}>} events
 * @param {'off'|'decisions'|'full'} level
 * @param {RegExp} decisionRe  buildDecisionRegExp() from Core/decisionMarkers.js
 */
export function filterForLevel(events, level, decisionRe) {
  if (level === 'full') return events.slice();
  if (level === 'decisions') return events.filter((e) => e && typeof e.msg === 'string' && decisionRe.test(e.msg));
  return [];
}

/**
 * Ruling 9 — MIDDLE-OUT eviction: keep the head (the ONSET — where causes live) and the newest tail, drop
 * between, and return the gap so the caller can enqueue the synthetic SHIPPER ▸ gap event. Never silent.
 * @param {Array<{t:number}>} events  oldest-first
 * @param {number} cap               max events to keep (gap event NOT included in cap accounting)
 * @param {number} keepHead          events preserved at the head
 * @returns {{ events: Array, dropped: null | { n: number, from: number, to: number } }}
 */
export function evictMiddleOut(events, cap, keepHead = 250) {
  if (!Array.isArray(events) || events.length <= cap) return { events: Array.isArray(events) ? events : [], dropped: null };
  const head = events.slice(0, Math.min(keepHead, Math.max(0, cap - 1)));
  const tailN = Math.max(1, cap - head.length);
  const tail = events.slice(events.length - tailN);
  const droppedSlice = events.slice(head.length, events.length - tailN);
  const dropped = { n: droppedSlice.length, from: droppedSlice[0]?.t ?? 0, to: droppedSlice[droppedSlice.length - 1]?.t ?? 0 };
  return { events: [...head, ...tail], dropped };
}

/** The synthetic honesty event (ruling 9) — a fleet trace must never read complete when it is not. */
export function gapEvent(dropped, reason = 'quota', now = Date.now()) {
  const f = (t) => { try { return new Date(t).toISOString().slice(11, 19); } catch { return String(t); } };
  return { t: now, lvl: 'WARN', tag: 'shipper', msg: `SHIPPER ▸ gap — dropped ${dropped.n} events (${f(dropped.from)}–${f(dropped.to)}, ${reason})` };
}

/**
 * Split events into batches inside PutLogEvents limits with headroom (§3: ≤500 events, ≤800KB per call).
 * @param {Array<object>} events oldest-first
 */
export function buildBatches(events, { maxEvents = 500, maxBytes = 800 * 1024 } = {}) {
  const batches = [];
  let cur = [], bytes = 0;
  for (const e of events) {
    const sz = JSON.stringify(e).length + 26;   // CloudWatch's per-event overhead constant
    if (cur.length && (cur.length >= maxEvents || bytes + sz > maxBytes)) { batches.push(cur); cur = []; bytes = 0; }
    cur.push(e); bytes += sz;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** Exponential backoff, capped at 15min (§3/§6). attempt 0 → 30s, 1 → 60s, … */
export function backoffDelay(attempt) {
  return Math.min(15 * 60 * 1000, 30 * 1000 * Math.pow(2, Math.max(0, attempt | 0)));
}

/**
 * v1910 (live: empty log group) — normalize a RING entry to the wire shape. The Logger's real fields are
 * { level, source, message, timestamp:ISO }; the shipper's first cut read { lvl, tag, msg, t } and therefore
 * shipped vacuum — every msg normalized to '' and the decisions filter matched nothing. The contract now
 * lives HERE, tested, instead of implicitly in the Services wiring.
 * @param {{level?:string, source?:string, message?:string, timestamp?:string}} entry
 * @param {string} version
 */
export function normalizeRingEntry(entry, version) {
  const t = entry && entry.timestamp ? (Date.parse(entry.timestamp) || Date.now()) : Date.now();
  return {
    t,
    lvl: (entry && entry.level) || 'INFO',
    tag: (entry && entry.source) || '',
    msg: String((entry && entry.message) || ''),
    v: String(version || ''),
  };
}

/** True when this event should trigger an immediate flush (§3: errors are what the fleet view is FOR). */
export function urgentEvent(e) {
  return !!e && (LEVEL_RANK[e.lvl] ?? 0) >= LEVEL_RANK.WARN;
}
