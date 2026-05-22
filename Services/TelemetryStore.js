/**
 * @file Services/TelemetryStore.js
 * @description Persistent rolling buffer of page-classification events,
 *              with on-demand aggregation for inspection.
 *
 * Stores the last N classification events in chrome.storage.local under
 * a versioned key. Provides three operations:
 *
 *   record(event)     — append an event, evict oldest if buffer is full.
 *   aggregate()       — compute summary statistics from stored events.
 *   clear()           — drop all stored events.
 *
 * Designed so that:
 *   - Failures to persist NEVER break the caller. Every storage operation
 *     is wrapped in try/catch with a Logger.warn fallback. PageClassifier
 *     can call record() and ignore any failure.
 *   - The schema is versioned via the storage key. v1 events live at
 *     'telemetry:classifications:v1'. A future schema change bumps to v2;
 *     v1 data is dropped (no migration). Acceptable for telemetry data
 *     where loss of history is preferable to migration complexity.
 *   - Aggregation is computed on demand by walking stored events. With
 *     N=500 events, a full walk is microseconds. Pre-aggregated counters
 *     would be cheaper but commit to specific summaries; on-demand keeps
 *     us flexible for adding new aggregations.
 *
 * v2.58.0 — initial implementation. Console-only inspection via the
 * exported PageClassifier.dumpTelemetry() method (which delegates here).
 *
 * @module Services/TelemetryStore
 */

import { Logger } from '../Core/Logger.js';

/** Storage key for v1 event records. Bump to v2 if event shape changes. */
const STORAGE_KEY = 'telemetry:classifications:v1';

/** Maximum number of raw events retained. Older events are dropped. */
const MAX_EVENTS = 500;

/**
 * Classification event shape.
 *
 * @typedef {Object} ClassificationEvent
 * @property {number} timestamp - Date.now() at classify() call.
 * @property {string|null} fragmentId - id of the fragment whose preconditions failed.
 * @property {string|null} origin - URL origin (scheme://host) — no path or query.
 * @property {string} classification - category name, or 'unknown'.
 * @property {number} confidence - 0.0 to 1.0.
 * @property {Object[]} recognizers - per-recognizer evaluation records.
 * @property {number} totalElapsedMs - end-to-end classify() duration.
 */

// ─── Persistence ──────────────────────────────────────────────────────────

/**
 * Read the current event buffer from storage. Returns [] if missing or
 * unreadable. Never throws.
 *
 * @returns {Promise<Array>}
 */
async function readEvents() {
  try {
    const data = await new Promise(resolve =>
      chrome.storage.local.get(STORAGE_KEY, resolve));
    const events = data?.[STORAGE_KEY];
    return Array.isArray(events) ? events : [];
  } catch (err) {
    Logger.warn('TelemetryStore', `readEvents failed: ${err.message}`);
    return [];
  }
}

/**
 * Write the event buffer to storage. Never throws.
 *
 * @param {Array} events
 */
async function writeEvents(events) {
  try {
    await new Promise(resolve =>
      chrome.storage.local.set({ [STORAGE_KEY]: events }, resolve));
  } catch (err) {
    Logger.warn('TelemetryStore', `writeEvents failed: ${err.message}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Record a classification event. Appends to the rolling buffer, evicting
 * the oldest if the buffer is full. Never throws — telemetry failures must
 * not affect classification.
 *
 * @param {ClassificationEvent} event
 */
async function record(event) {
  try {
    const events = await readEvents();
    events.push(event);
    // Trim oldest when we exceed the cap. Slice rather than splice in
    // case of larger overshoots (shouldn't happen but defensive).
    const trimmed = events.length > MAX_EVENTS
      ? events.slice(events.length - MAX_EVENTS)
      : events;
    await writeEvents(trimmed);
  } catch (err) {
    Logger.warn('TelemetryStore', `record failed: ${err.message}`);
  }
}

/**
 * Return the raw stored events for inspection. Returns [] on storage
 * failure rather than throwing.
 *
 * @returns {Promise<ClassificationEvent[]>}
 */
async function getRawEvents() {
  return await readEvents();
}

/**
 * Compute summary statistics from stored events. Walks the entire buffer
 * once and produces nested counters/rates per recognizer and per layer.
 *
 * Output shape (see /docs or the file header for the full structure):
 *   {
 *     total_classifications: number,
 *     by_result: { <category>: count, ... },
 *     per_recognizer: {
 *       <recognizer_name>: {
 *         kind: string,
 *         total_evaluations: number,
 *         fires: number,
 *         fire_rate: number,
 *         by_layer: {                  // only present for assertion_layered
 *           <layer_name>: {
 *             evaluations, fires, fire_rate, avg_elapsed_ms
 *           },
 *           ...
 *         }
 *       },
 *       ...
 *     },
 *     recent_events: [<last 10 events>]
 *   }
 *
 * @returns {Promise<Object>}
 */
async function aggregate() {
  const events = await readEvents();
  const total = events.length;

  if (total === 0) {
    return {
      total_classifications: 0,
      by_result: {},
      per_recognizer: {},
      recent_events: [],
    };
  }

  const byResult = {};
  const perRecognizer = {}; // accumulator: { name: { kind, totalEvals, fires, layerStats } }

  for (const event of events) {
    // Result tally
    const cat = event.classification ?? 'unknown';
    byResult[cat] = (byResult[cat] ?? 0) + 1;

    // Per-recognizer accumulation
    for (const rec of (event.recognizers ?? [])) {
      const name = rec.name;
      if (!name) continue;

      let entry = perRecognizer[name];
      if (!entry) {
        entry = {
          kind: rec.kind ?? 'unknown',
          totalEvals: 0,
          fires: 0,
          layerStats: {}, // { layerName: { evals, fires, totalElapsedMs } }
        };
        perRecognizer[name] = entry;
      }
      entry.totalEvals += 1;
      if (rec.fired) entry.fires += 1;

      // Per-layer accumulation (assertion_layered only)
      for (const layer of (rec.layers ?? [])) {
        const lname = layer.name;
        if (!lname) continue;
        let lstats = entry.layerStats[lname];
        if (!lstats) {
          lstats = { evals: 0, fires: 0, totalElapsedMs: 0, weight: layer.weight };
          entry.layerStats[lname] = lstats;
        }
        lstats.evals += 1;
        if (layer.fired) lstats.fires += 1;
        lstats.totalElapsedMs += (layer.elapsedMs ?? 0);
        // Track weight (should be stable per recognizer-layer; last write wins
        // and is fine since recognizer definitions don't drift mid-session).
        if (layer.weight) lstats.weight = layer.weight;
      }
    }
  }

  // Compute rates and finalize per-recognizer block
  const perRecognizerOut = {};
  for (const [name, entry] of Object.entries(perRecognizer)) {
    const block = {
      kind: entry.kind,
      total_evaluations: entry.totalEvals,
      fires: entry.fires,
      fire_rate: entry.totalEvals > 0 ? entry.fires / entry.totalEvals : 0,
    };
    const layerNames = Object.keys(entry.layerStats);
    if (layerNames.length > 0) {
      block.by_layer = {};
      for (const lname of layerNames) {
        const ls = entry.layerStats[lname];
        block.by_layer[lname] = {
          weight: ls.weight,
          evaluations: ls.evals,
          fires: ls.fires,
          fire_rate: ls.evals > 0 ? ls.fires / ls.evals : 0,
          avg_elapsed_ms: ls.evals > 0 ? ls.totalElapsedMs / ls.evals : 0,
        };
      }
    }
    perRecognizerOut[name] = block;
  }

  // Last 10 events for quick recent inspection
  const recent = events.slice(-10);

  return {
    total_classifications: total,
    by_result: byResult,
    per_recognizer: perRecognizerOut,
    recent_events: recent,
  };
}

/**
 * Drop all stored events. Useful for resetting between observation periods.
 * Never throws.
 */
async function clear() {
  try {
    await new Promise(resolve =>
      chrome.storage.local.remove(STORAGE_KEY, resolve));
    Logger.info('TelemetryStore', 'cleared');
  } catch (err) {
    Logger.warn('TelemetryStore', `clear failed: ${err.message}`);
  }
}

export const TelemetryStore = { record, aggregate, getRawEvents, clear };
