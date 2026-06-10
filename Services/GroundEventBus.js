/**
 * @file Services/GroundEventBus.js
 * @description Phase 8 of the landmark substrate spec. A per-Ground
 * append-only event log for substrate-level signals — primarily
 * landmark resolution outcomes (degraded recovery, hard failures,
 * lifecycle transitions) so Studio can surface a "drift sidebar" and
 * future automation can react.
 *
 * Why an event bus (vs. just updating lifecycle on the landmark
 * record):
 *
 *   - Lifecycle is the CURRENT state. It loses history. A landmark
 *     that flapped between fresh and stale-suspected five times
 *     today looks identical to one that just flipped once.
 *   - Multiple callers care about the SAME transition (Studio
 *     sidebar, sidepanel toast, future auto-relap scheduler).
 *     Distributing the trigger via lifecycle reads forces every
 *     consumer to diff state changes themselves.
 *   - The substrate spec calls out `landmark-resolution-degraded`
 *     as a named event in § Resolution semantics. This module
 *     provides the physical channel for that event.
 *
 * Storage model:
 *
 *   Key:      `groundEvents:{groundId}`
 *   Value:    Array<Event>  (ring buffer, capped at MAX_EVENTS)
 *   Event:    { id, ts, kind, uid?, details? }
 *
 * Broadcast:
 *
 *   Every emit() writes to chrome.storage.local, which fires
 *   chrome.storage.onChanged across all contexts (background,
 *   sidepanel, content scripts in extension origin). subscribe()
 *   wraps that listener for callers who want push notification of
 *   new events; for snapshot reads, callers use list().
 *
 * Capacity:
 *
 *   200 events per ground (`MAX_EVENTS`). When full, oldest are
 *   dropped on emit. Studio displays "showing last N events; older
 *   discarded" when the buffer is at cap. Callers who need
 *   long-term telemetry should subscribe and persist independently.
 *
 * @module Services/GroundEventBus
 * @version 2.74.249
 */

import { Logger } from '../Core/Logger.js';

const MAX_EVENTS = 200;

function _key(groundId) {
  return `groundEvents:${groundId}`;
}

function _now() { return Date.now(); }

function _newId() {
  // Crypto-grade randomness when available; otherwise Math.random() —
  // event ids only need to be unique within a single ground's buffer.
  try {
    if (globalThis.crypto?.randomUUID) return `evt_${globalThis.crypto.randomUUID().slice(0, 8)}`;
  } catch { /* ignore */ }
  return `evt_${Math.random().toString(36).slice(2, 10)}`;
}

function _get(key) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.get(key, data => resolve(data?.[key] ?? null));
    } catch (e) {
      Logger.warn('GroundEventBus', `storage.get(${key}) threw: ${e.message}`);
      resolve(null);
    }
  });
}

function _set(key, value) {
  return new Promise(resolve => {
    try {
      chrome.storage.local.set({ [key]: value }, () => resolve());
    } catch (e) {
      Logger.warn('GroundEventBus', `storage.set(${key}) threw: ${e.message}`);
      resolve();
    }
  });
}

/**
 * Append an event to the named ground's buffer. Fire-and-forget by
 * convention: callers don't await unless they specifically need
 * write ordering (rare).
 *
 * Event shape required: `{ kind: string, ... }`. `id` and `ts` are
 * filled in automatically; `uid` and `details` are optional but
 * recommended.
 *
 * @param {string} groundId
 * @param {object} event
 * @returns {Promise<object>} the persisted event with id+ts populated
 */
export async function emit(groundId, event) {
  if (!groundId || typeof groundId !== 'string') {
    Logger.warn('GroundEventBus', 'emit() called without groundId — dropped');
    return null;
  }
  if (!event || typeof event !== 'object' || typeof event.kind !== 'string') {
    Logger.warn('GroundEventBus', 'emit() requires { kind: string } — dropped');
    return null;
  }
  const entry = {
    id     : _newId(),
    ts     : _now(),
    kind   : event.kind,
    uid    : event.uid ?? null,
    details: event.details ?? null,
  };
  const key  = _key(groundId);
  // v2.74.932 (CR-ST2) — serialized: emit is fire-and-forget at every call site (TemplateWalker's landmark
  // probes emit on adjacent steps), so two concurrent emits snapshotted the same buffer and the second _set
  // clobbered the first's event — the same lost-update class StorageManager fixed in v2.74.119. One module
  // chain (events are low-volume; per-ground granularity isn't worth a map).
  const run = _emitChain.then(async () => {
    const buf  = (await _get(key)) ?? [];
    const next = Array.isArray(buf) ? buf.slice() : [];
    next.push(entry);
    // Ring buffer: drop oldest beyond MAX_EVENTS.
    while (next.length > MAX_EVENTS) next.shift();
    await _set(key, next);
    Logger.debug('GroundEventBus', `emit ${entry.kind} on ${groundId} uid=${entry.uid ?? '-'}`);
    return entry;
  });
  _emitChain = run.catch(() => {});
  return run;
}
let _emitChain = Promise.resolve();   // v2.74.932 (CR-ST2)

/**
 * Read events for a ground with optional filtering. Returns
 * newest-first by default; pass `order: 'asc'` for chronological.
 *
 * @param {string} groundId
 * @param {object} [opts]
 * @param {number} [opts.sinceTs]  only events with ts > sinceTs
 * @param {Array<string>} [opts.kinds]  whitelist of event kinds
 * @param {string} [opts.uid]      filter to events involving this landmark uid
 * @param {number} [opts.limit]    cap on returned events (after sort)
 * @param {'desc'|'asc'} [opts.order='desc']
 * @returns {Promise<Array<object>>}
 */
export async function list(groundId, opts = {}) {
  if (!groundId) return [];
  const buf = (await _get(_key(groundId))) ?? [];
  if (!Array.isArray(buf) || buf.length === 0) return [];
  let out = buf;
  if (typeof opts.sinceTs === 'number') {
    out = out.filter(e => e?.ts > opts.sinceTs);
  }
  if (Array.isArray(opts.kinds) && opts.kinds.length > 0) {
    const set = new Set(opts.kinds);
    out = out.filter(e => set.has(e?.kind));
  }
  if (typeof opts.uid === 'string' && opts.uid) {
    out = out.filter(e => e?.uid === opts.uid);
  }
  out = out.slice().sort((a, b) => (b?.ts ?? 0) - (a?.ts ?? 0));
  if (opts.order === 'asc') out.reverse();
  if (typeof opts.limit === 'number' && opts.limit >= 0) {
    out = out.slice(0, opts.limit);
  }
  return out;
}

/**
 * Drop all events for a ground. Used by Studio "clear log" and on
 * ground deletion.
 *
 * @param {string} groundId
 */
export async function clear(groundId) {
  if (!groundId) return;
  await _set(_key(groundId), []);
  Logger.info('GroundEventBus', `cleared event log for ${groundId}`);
}

/**
 * Subscribe to new events on a ground. Returns an unsubscribe
 * function. The callback fires once per storage commit with the
 * NEW events (those present in newValue and not in oldValue).
 *
 * Implementation uses chrome.storage.onChanged which fires across
 * all extension contexts that hold a reference — works from
 * sidepanel, background, or extension pages alike.
 *
 * @param {string} groundId
 * @param {(events: Array<object>) => void} callback
 * @returns {() => void} unsubscribe
 */
export function subscribe(groundId, callback) {
  if (!groundId || typeof callback !== 'function') return () => {};
  const target = _key(groundId);
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes[target];
    if (!change) return;
    const oldArr = Array.isArray(change.oldValue) ? change.oldValue : [];
    const newArr = Array.isArray(change.newValue) ? change.newValue : [];
    if (newArr.length === 0) return;
    // Diff by id — most commits append a single event; sometimes the
    // ring buffer also drops an old one, but that's not a "new" event.
    const oldIds = new Set(oldArr.map(e => e?.id).filter(Boolean));
    const added  = newArr.filter(e => e?.id && !oldIds.has(e.id));
    if (added.length > 0) {
      try { callback(added); }
      catch (e) { Logger.warn('GroundEventBus', `subscriber threw: ${e.message}`); }
    }
  };
  try { chrome.storage.onChanged.addListener(listener); }
  catch (e) {
    Logger.warn('GroundEventBus', `subscribe failed to attach: ${e.message}`);
    return () => {};
  }
  return () => {
    try { chrome.storage.onChanged.removeListener(listener); }
    catch { /* ignore */ }
  };
}

// ─── Canonical event kinds (for autocomplete + grep discoverability) ──────

export const EVENT_KIND = Object.freeze({
  /** Heuristic recovery succeeded: cached selector missed, content
   *  script found a replacement via role+name+context. Landmark
   *  lifecycle flips to stale-suspected. */
  LANDMARK_RESOLUTION_DEGRADED: 'landmark-resolution-degraded',
  /** Both cached selector AND heuristic recovery failed. Landmark
   *  lifecycle flips to stale-confirmed; downstream consumers
   *  (fragments, observations) using this landmark will fail. */
  LANDMARK_RESOLUTION_FAILED  : 'landmark-resolution-failed',
  /** Landmark verified successfully via its cached selector — no
   *  recovery needed. Emitted optionally for telemetry. */
  LANDMARK_RESOLUTION_OK      : 'landmark-resolution-ok',
  /** Landmark lifecycle state changed (any transition). Emitted
   *  alongside the more specific resolution events; useful for
   *  consumers that only care about state diffs. */
  LANDMARK_LIFECYCLE_CHANGED  : 'landmark-lifecycle-changed',
  /** Phase 6.5: action effect observation produced a report. Emitted
   *  whenever the engine brackets an action with observation
   *  (terminal steps, navigation-likely clicks, explicit opt-in).
   *  Carries the full observation report so consumers can render
   *  "what happened" without re-running the action. */
  LANDMARK_EFFECT_OBSERVED    : 'landmark-effect-observed',
  /** Phase 6.5: observed effect disagrees with the landmark's
   *  heuristically-proposed effect. Surfaced for human review — the
   *  substrate does NOT auto-update the landmark to avoid silent
   *  self-modification. Studio shows these in the drift sidebar with
   *  a "confirm new effect" affordance. */
  LANDMARK_EFFECT_DRIFT       : 'landmark-effect-drift',
});

export const MAX_EVENTS_PER_GROUND = MAX_EVENTS;
