/**
 * @file Core/Logger.js
 * @description Centralised logging service with level filtering, structured
 * console output, and persistent storage via chrome.storage.local.
 *
 * Critical design fix (v1.1.1):
 *   - #persistEnabled now defaults to TRUE so every context (service worker,
 *     side panel, content scripts) persists logs without an explicit opt-in call.
 *   - background.js still calls setPersist(true) + setLevel() for explicitness,
 *     but the side panel no longer needs to mirror that call.
 *   - A broadcast mechanism posts a 'LOG_ENTRY' runtime message after each
 *     persist so the Logs viewer in the UI can update in real time.
 *
 * Log levels (ascending severity):
 *   DEBUG (0) < INFO (1) < WARN (2) < ERROR (3)
 *
 * @module Core/Logger
 * @author Agent HUB
 * @version 1.9.7
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Numeric log level constants.
 * @readonly
 * @enum {number}
 */
export const LOG_LEVEL = Object.freeze({
  DEBUG : 0,
  INFO  : 1,
  WARN  : 2,
  ERROR : 3,
});

/** @type {Record<number,string>} */
const LEVEL_LABELS = { 0: 'DEBUG', 1: 'INFO', 2: 'WARN', 3: 'ERROR' };

/** chrome.storage.local key for persisted log entries. @constant {string} */
const STORAGE_KEY = 'logger:entries';

/** Maximum number of entries kept in storage (ring-buffer behaviour). @constant {number} */
const MAX_STORED  = 500;

// ─── Logger ───────────────────────────────────────────────────────────────────

/**
 * @class Logger
 * @classdesc Stateless static logging service. All methods are class-level;
 * no instantiation is required or meaningful.
 *
 * Usage:
 * ```js
 * import { Logger, LOG_LEVEL } from '../Core/Logger.js';
 * Logger.setLevel(LOG_LEVEL.DEBUG); // optional — defaults to INFO
 * Logger.info('MyModule', 'Something happened', { detail: 42 });
 * Logger.error('MyModule', 'It broke', error);
 * ```
 */
export class Logger {

  /**
   * Minimum severity level. Entries below this level are silently discarded.
   * Defaults to INFO.
   * @type {number}
   */
  static #minLevel = LOG_LEVEL.INFO;

  /**
   * When true, every emitted entry is written to chrome.storage.local and
   * broadcast via chrome.runtime.sendMessage for live UI updates.
   * Defaults to TRUE — explicitly set to false only in test/non-extension envs.
   * @type {boolean}
   */
  static #persistEnabled = true;

  // ── Configuration ──────────────────────────────────────────────────────────

  /**
   * Sets the minimum log level filter.
   * @param {number} level - One of LOG_LEVEL.DEBUG / INFO / WARN / ERROR.
   * @returns {void}
   */
  static setLevel(level) {
    Logger.#minLevel = level;
  }

  /**
   * Enables or disables persistence and live broadcast.
   * Disable only in environments without chrome.storage (e.g. unit tests).
   * @param {boolean} enabled
   * @returns {void}
   */
  static setPersist(enabled) {
    Logger.#persistEnabled = enabled;
  }

  // ── Logging methods ────────────────────────────────────────────────────────

  /**
   * Logs a DEBUG-level entry. Filtered out at default INFO level.
   * @param {string} source  - Emitting class/module name.
   * @param {string} message - Human-readable description.
   * @param {any}    [data]  - Optional structured payload (serialisable).
   * @returns {void}
   */
  static debug(source, message, data) {
    Logger.#emit(LOG_LEVEL.DEBUG, source, message, data);
  }

  /**
   * Logs an INFO-level entry for normal operational events.
   * @param {string} source
   * @param {string} message
   * @param {any}    [data]
   * @returns {void}
   */
  static info(source, message, data) {
    Logger.#emit(LOG_LEVEL.INFO, source, message, data);
  }

  /**
   * Logs a WARN-level entry for recoverable anomalies.
   * @param {string} source
   * @param {string} message
   * @param {any}    [data]
   * @returns {void}
   */
  static warn(source, message, data) {
    Logger.#emit(LOG_LEVEL.WARN, source, message, data);
  }

  /**
   * Logs an ERROR-level entry for failures that degraded a user-visible operation.
   * @param {string} source
   * @param {string} message
   * @param {any}    [data]
   * @returns {void}
   */
  static error(source, message, data) {
    Logger.#emit(LOG_LEVEL.ERROR, source, message, data);
  }

  // ── Storage access ─────────────────────────────────────────────────────────

  /**
   * Retrieves all persisted log entries from chrome.storage.local, ordered
   * oldest-first (insertion order).
   *
   * @returns {Promise<LogEntry[]>}
   */
  static async getPersistedLogs() {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      return result[STORAGE_KEY] ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Removes all persisted log entries from chrome.storage.local.
   * @returns {Promise<void>}
   */
  static async clearLogs() {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch { /* ignore */ }
  }

  // ── Private implementation ─────────────────────────────────────────────────

  /**
   * Core emit pipeline: filter → format → console → persist → broadcast.
   *
   * @private
   * @param {number} level
   * @param {string} source
   * @param {string} message
   * @param {any}    [data]
   * @returns {void}
   */
  static #emit(level, source, message, data) {
    if (level < Logger.#minLevel) return;

    /** @type {LogEntry} */
    const entry = {
      level     : LEVEL_LABELS[level],
      levelNum  : level,
      source,
      message,
      data      : data ?? null,
      timestamp : new Date().toISOString(),
    };

    // ── Console output ──────────────────────────────────────────────────────
    const prefix = `[${entry.timestamp}] [${entry.level}] [${source}]`;
    if      (level === LOG_LEVEL.ERROR) console.error(prefix, message, data ?? '');
    else if (level === LOG_LEVEL.WARN)  console.warn (prefix, message, data ?? '');
    else if (level === LOG_LEVEL.DEBUG) console.debug(prefix, message, data ?? '');
    else                                console.log  (prefix, message, data ?? '');

    // ── Persist + broadcast ─────────────────────────────────────────────────
    if (Logger.#persistEnabled) {
      Logger.#persistAndBroadcast(entry).catch(() => {
        // Swallow — logging must never throw into caller code
      });
    }
  }

  /**
   * Serialization tail for #persistAndBroadcast. Each call chains onto the
   * previous one so the read-modify-write of `chrome.storage.local` runs
   * sequentially. Without this, concurrent Logger calls (very common —
   * `Logger.info` is fire-and-forget) raced on the read snapshot: two
   * persists would both get the same `entries` array, both push their own
   * entry, both call set() — and whichever set() landed last silently
   * overwrote the other's entry. This dropped a LOT of logs in high-volume
   * contexts (per the v2.74.190 investigation: the background install
   * message + many failure reasons were vanishing precisely because they
   * lost their race with concurrent emits).
   *
   * The chain is per-context (each SW / page has its own module instance
   * via ES module isolation), so we serialize within a context but not
   * across contexts. Cross-context races still exist in principle but
   * happen far less often (most logs originate in one context per moment).
   *
   * @private
   * @type {Promise<void>}
   */
  static #persistTail = Promise.resolve();

  /**
   * Writes the entry to chrome.storage.local (ring-buffer, max MAX_STORED),
   * then sends a 'LOG_ENTRY' message to all extension views so the live log
   * viewer can append the row without polling.
   *
   * v2.74.190 — Serialized via #persistTail so concurrent calls don't
   * stomp each other's storage write.
   *
   * @private
   * @param {LogEntry} entry
   * @returns {Promise<void>}
   */
  static #persistAndBroadcast(entry) {
    // ── Scrub PII before storing ────────────────────────────────────────────
    // DOM snapshots and other log data may contain sensitive values from the
    // authenticated page context (emails, phones, UUIDs, record IDs).
    // Scrub the entry before it touches storage so logs are safe to share.
    const safeEntry = Logger.#scrubEntry(entry);

    // Chain onto the previous persist. Each entry waits for the prior one
    // to commit before doing its own get-modify-set, so the snapshot it
    // reads is always current. Errors in one persist don't break the
    // chain — the catch resets it to a resolved promise so future calls
    // can proceed.
    const nextTail = Logger.#persistTail
      .then(async () => {
        // ── Write to storage ────────────────────────────────────────────────
        const result  = await chrome.storage.local.get(STORAGE_KEY);
        const entries = result[STORAGE_KEY] ?? [];
        entries.push(safeEntry);
        if (entries.length > MAX_STORED) {
          entries.splice(0, entries.length - MAX_STORED);
        }
        await chrome.storage.local.set({ [STORAGE_KEY]: entries });

        // ── Broadcast to side panel (best-effort) ─────────────────────────
        try {
          await chrome.runtime.sendMessage({ type: 'LOG_ENTRY', payload: safeEntry });
        } catch {
          // Side panel not open — log still persisted, no action needed
        }
      })
      .catch(() => {
        // Swallow — logging must never throw into caller code, and a
        // failed link mustn't break the chain. The next call starts fresh.
      });
    Logger.#persistTail = nextTail;
    return nextTail;
  }

  /**
   * Returns a copy of the log entry with PII patterns redacted from
   * message and data fields. Applied before any persist or broadcast.
   *
   * Patterns scrubbed:
   *   - Email addresses          → [email]
   *   - Phone numbers (US/intl)  → [phone]
   *   - UUIDs / GUIDs            → [id]
   *   - HubSpot record IDs       → [id]
   *
   * @private
   * @param {LogEntry} entry
   * @returns {LogEntry}
   */
  static #scrubEntry(entry) {
    function scrubString(s) {
      if (typeof s !== 'string') return s;
      return s
        // Email addresses
        .replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '[email]')
        // Phone numbers (various formats)
        .replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, '[phone]')
        // UUIDs
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[id]')
        // HubSpot numeric record IDs (8+ digits standalone)
        .replace(/\b\d{8,}\b/g, '[id]');
    }

    function scrubValue(v) {
      if (v === null || v === undefined) return v;
      if (typeof v === 'string') return scrubString(v);
      if (typeof v === 'object') {
        try {
          return JSON.parse(scrubString(JSON.stringify(v)));
        } catch { return v; }
      }
      return v;
    }

    return {
      ...entry,
      message : scrubString(entry.message ?? ''),
      data    : scrubValue(entry.data),
    };
  }
}

// ─── JSDoc typedef (runtime-free) ────────────────────────────────────────────

/**
 * @typedef {Object} LogEntry
 * @property {'DEBUG'|'INFO'|'WARN'|'ERROR'} level   - Human-readable level label.
 * @property {number}  levelNum  - Numeric level for filtering (0-3).
 * @property {string}  source    - Emitting class or module name.
 * @property {string}  message   - Description of the event.
 * @property {any}     data      - Optional structured payload; null if absent.
 * @property {string}  timestamp - ISO-8601 timestamp string.
 */
