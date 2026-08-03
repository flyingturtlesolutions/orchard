/**
 * @file ChatAPI.js
 * @module Services/ChatAPI
 *
 * Client-side wrapper around the CapabilityAPI message contract.
 * The chat UI calls these methods instead of touching StorageManager
 * or sending raw chrome.runtime messages directly. This is the thin
 * boundary that lets the chat UI evolve independently from the Lab.
 *
 * All methods return Promises. Events are delivered to subscribers
 * passed to onEvent().
 *
 * If/when the chat UI is moved to a separate entry point, web app, or
 * external interface, only this file changes — the rest of the chat
 * UI uses the same methods regardless of transport.
 */

// v2.74.112 — `_send` previously called the bare `resolve` as the
// sendMessage callback, which swallowed two real failure modes:
//
//   (a) Channel error / no receiver — chrome.runtime.sendMessage fires the
//       callback with `undefined` AND populates `chrome.runtime.lastError`.
//       Without checking lastError, callers just saw a generic "X failed"
//       (from the `!res?.success` branch) with no insight into what broke.
//
//   (b) Service worker terminated mid-request — in MV3, if the SW returned
//       `true` from onMessage (keeping the channel open for an async
//       response) and then died, the callback NEVER fires. The promise
//       hangs forever; the user sees a stuck "Routing…" / "Working on it…"
//       with no way to recover except a panel reload.
//
// Fix: surface lastError as a rejection, and bound the wait with a generous
// timeout. 60s is long enough for any reasonable transport round-trip —
// invoke() returns immediately with invocationId (execution is async via
// events), so the round-trip itself is always short.
const _MSG_TIMEOUT_MS = 60_000;
const _send = (type, payload) => new Promise((resolve, reject) => {
  let settled = false;
  const _t0 = Date.now();   // PERF ▸ v2.74.1981 (temp) — for the first cold-SW round-trip stamp below
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    reject(new Error(`${type}: message timed out after ${_MSG_TIMEOUT_MS / 1000}s`));
  }, _MSG_TIMEOUT_MS);
  chrome.runtime.sendMessage({ type, payload }, (response) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // PERF ▸ v2.74.1981 — TEMPORARY: stamp the FIRST panel→SW round-trip's rtt. On the returning-user reload path
    // this is usually the cold-boot call (CAPABILITY_LIST_INVOCATIONS). Read by chat.js _perfFlush; remove when done.
    try { const P = (typeof globalThis !== 'undefined') && globalThis.__orchPerf; if (P && P.firstRtt == null) { P.firstRtt = Date.now() - _t0; P.firstType = String(type); } } catch { /* */ }
    const err = chrome.runtime.lastError;
    if (err) reject(new Error(`${type}: ${err.message || 'message channel error'}`));
    else resolve(response);
  });
});

const _eventSubscribers = new Set();

// Wire chrome.runtime.onMessage to dispatch CAPABILITY_EVENT to subscribers
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'CAPABILITY_EVENT') {
    for (const sub of _eventSubscribers) {
      try { sub(message.payload); } catch (e) { console.warn('[ChatAPI] subscriber threw', e); }
    }
  }
});

export const ChatAPI = {

  // ── Registry ──────────────────────────────────────────────────────────────

  /**
   * List all capabilities, optionally filtered by kind or status.
   * @param {{ kinds?: string[], status?: string }} [filter]
   * @returns {Promise<CapabilityDescriptor[]>}
   */
  async listCapabilities(filter = {}) {
    const res = await _send('CAPABILITY_LIST', filter);
    if (!res?.success) throw new Error(res?.error ?? 'listCapabilities failed');
    return res.capabilities;
  },

  /**
   * Get a single capability descriptor.
   * @param {string} capabilityId
   * @returns {Promise<CapabilityDescriptor|null>}
   */
  async getCapability(capabilityId) {
    const res = await _send('CAPABILITY_GET', { capabilityId });
    if (!res?.success) throw new Error(res?.error ?? 'getCapability failed');
    return res.capability;
  },

  /**
   * Optional helper — semantic match of natural-language query to capabilities.
   * The Lab uses Claude to score capabilities by relevance. Interfaces that
   * want different routing strategies (keyword matching, exact ID, etc.) can
   * skip this and use descriptor.triggers / descriptor.summary directly.
   * @param {string} query
   * @param {{ kinds?: string[], limit?: number, minConfidence?: number }} [options]
   * @returns {Promise<{capabilityId: string, name: string, confidence: number, reason: string}[]>}
   */
  async match(query, options = {}) {
    const res = await _send('CAPABILITY_MATCH', { query, options });
    if (!res?.success) throw new Error(res?.error ?? 'match failed');
    return res.matches;
  },

  /**
   * Generate a short conversation title from the first user message.
   * Used by the chat UI to name persisted conversations. Always returns
   * a usable title — falls back to truncating the message on LLM failure.
   * @param {string} firstMessage
   * @returns {Promise<string>}
   */
  async generateTitle(firstMessage) {
    const res = await _send('CHAT_GENERATE_TITLE', { firstMessage });
    if (!res?.success) throw new Error(res?.error ?? 'generateTitle failed');
    return res.title;
  },

  // ── Invocation ────────────────────────────────────────────────────────────

  /**
   * Pass C — Extract strategy param values from a user message. Used by chat
   * routing just after a Strategy is picked: pulls concrete values out of the
   * user's natural-language request, and returns any still-missing params so
   * the chat can prompt for them before invoking.
   *
   * @param {string} capabilityId
   * @param {string} question
   * @returns {Promise<{ params: Object, missing: string[] }>}
   */
  async extractStrategyParams(capabilityId, question) {
    const res = await _send('EXTRACT_STRATEGY_PARAMS', { capabilityId, question });
    if (!res?.success) throw new Error(res?.error ?? 'extractStrategyParams failed');
    return { params: res.params, missing: res.missing };
  },

  /**
   * Invoke a capability. Returns immediately with invocationId — actual
   * execution may be queued if concurrency limits are hit.
   * @param {string} capabilityId
   * @param {{ params?: Object, question?: string }} input
   * @param {{
   *   invocationId?: string,    // pre-supplied ID for client correlation
   *   debug?: Object|null,      // v2.38.0 — debug-mode flags (Pass K1)
   *   conversationId?: string,  // v2.71.4 — for terminal-event persistence
   * }} [options]
   * @returns {Promise<{ invocationId: string, status: string }>}
   */
  async invoke(capabilityId, input = {}, options = {}) {
    const res = await _send('CAPABILITY_INVOKE', {
      capabilityId, input,
      invocationId: options.invocationId,
      // v2.38.0 (Pass K1) — pass debug option through to background script.
      debug: options.debug ?? null,
      // v2.71.4 — Conversation linkage. Lets background route terminal
      // events to the right conversation when the chat panel is closed.
      conversationId: options.conversationId ?? null,
    });
    if (!res?.success) throw new Error(res?.error ?? 'invoke failed');
    return { invocationId: res.invocationId, status: res.status };
  },

  /**
   * Cancel an in-flight or queued invocation.
   * @param {string} invocationId
   * @returns {Promise<boolean>}
   */
  async cancel(invocationId) {
    const res = await _send('CAPABILITY_CANCEL', { invocationId });
    if (!res?.success) throw new Error(res?.error ?? 'cancel failed');
    return res.cancelled;
  },

  // ── v2.38.0 (Pass K1) — debug controls ─────────────────────────────────
  // Mirror CapabilityAPI.debugResume / debugStep / debugPause via background.
  // v2.74.112 — Throw on failure (was previously returning `false` and
  // losing the error message). Matches every other method in this file —
  // workflow-debug.js callers now get an actionable error instead of a
  // silent no-op.
  async debugResume(invocationId) {
    const res = await _send('CAPABILITY_DEBUG_RESUME', { invocationId });
    if (!res?.success) throw new Error(res?.error ?? 'debugResume failed');
    return true;
  },
  async debugStep(invocationId) {
    const res = await _send('CAPABILITY_DEBUG_STEP', { invocationId });
    if (!res?.success) throw new Error(res?.error ?? 'debugStep failed');
    return true;
  },
  async debugPause(invocationId) {
    const res = await _send('CAPABILITY_DEBUG_PAUSE', { invocationId });
    if (!res?.success) throw new Error(res?.error ?? 'debugPause failed');
    return true;
  },

  /**
   * Get current state snapshot of an invocation.
   * @param {string} invocationId
   * @returns {Promise<InvocationSnapshot|null>}
   */
  async getInvocation(invocationId) {
    const res = await _send('CAPABILITY_GET_INVOCATION', { invocationId });
    if (!res?.success) throw new Error(res?.error ?? 'getInvocation failed');
    return res.invocation;
  },

  /**
   * List invocations, optionally filtered.
   * @param {{ status?: string, capabilityId?: string, since?: number }} [filter]
   * @returns {Promise<InvocationSnapshot[]>}
   */
  async listInvocations(filter = {}) {
    const res = await _send('CAPABILITY_LIST_INVOCATIONS', filter);
    if (!res?.success) throw new Error(res?.error ?? 'listInvocations failed');
    return res.invocations;
  },

  /**
   * Get current concurrency capacity status.
   * @returns {Promise<{ running: number, queued: number, maxConcurrent: number, available: number }>}
   */
  async getCapacity() {
    const res = await _send('CAPABILITY_CAPACITY');
    if (!res?.success) throw new Error(res?.error ?? 'getCapacity failed');
    return res.capacity;
  },

  // ── Events ────────────────────────────────────────────────────────────────

  /**
   * Subscribe to all CapabilityAPI events. Returns an unsubscribe function.
   * Events: invocation.queued, invocation.started, invocation.progress,
   *         invocation.completed, invocation.failed, invocation.cancelled,
   *         capability.registry_changed
   * @param {(event: { type: string, invocationId?: string, ...payload }) => void} callback
   * @returns {() => void}
   */
  onEvent(callback) {
    _eventSubscribers.add(callback);
    return () => _eventSubscribers.delete(callback);
  },
};
