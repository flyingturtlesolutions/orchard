/**
 * @file Services/UniversalGate.js
 * @description Engine-level invariant gates that fire around every
 * top-level Fragment execution. Distinct from per-Fragment preconditions
 * (which describe what's specific to that fragment): these are the
 * universal "must hold for ANY fragment to run" invariants. Examples:
 * document is loaded, body has children, browser is online.
 *
 * Architectural rationale (v2.72.69):
 *   Per-Fragment pre/post conditions describe THIS fragment's contract.
 *   Universal gates describe what's true for ALL fragment executions.
 *   Baking universal gates into every saved Fragment record would be
 *   redundant and a migration burden. Engine-level enforcement keeps
 *   Fragment artifacts clean: "this fragment specifically requires X;
 *   the runtime guarantees Y, Z, W."
 *
 * Gate set (v1):
 *   ready_state    — document.readyState === 'complete'
 *   body_present   — document.body exists and has at least one child
 *   online         — navigator.onLine
 *
 * Future gates considered but not included in v1:
 *   navigation_idle — no in-flight navigation. Hard to detect generically;
 *                     readyState=complete already implies the document
 *                     has finished loading. Add later if needed.
 *
 * Retry semantics: on failure, poll every 150ms until timeout. The
 * default timeoutMs is 2000 — enough for most page transitions, short
 * enough that genuine failures don't hang the user.
 *
 * Antecedent replays: ExecutionEngine skips universal gates for nested
 * antecedent executions. Outer fragment gates already verified the page
 * was ready; antecedent replays inherit that guarantee. See
 * ExecutionEngine.#executeFragmentNode for the call site.
 *
 * Logging:
 *   - Per-attempt during retries: Logger.debug (quiet in normal logs)
 *   - Final pass: Logger.debug (single line)
 *   - Final fail: Logger.warn with full failure detail
 *
 * @module Services/UniversalGate
 * @author Agent HUB
 */

import { Logger } from '../Core/Logger.js';

const DEFAULT_TIMEOUT_MS = 2000;
const POLL_INTERVAL_MS   = 150;

/**
 * Evaluate universal gates against a tab's current state.
 *
 * Runs each gate via a content-script-free path:
 *   - ready_state, body_present: chrome.scripting.executeScript injection
 *     reading document.readyState and document.body
 *   - online: chrome.scripting.executeScript reading navigator.onLine
 *
 * (We use scripting.executeScript rather than the content script because
 * the gate must work even if the content script hasn't injected yet —
 * e.g. immediately after a navigation in mid-fragment.)
 *
 * Returns { ok, failures, passed }. Failures are
 *   { gate: 'ready_state', expected: 'complete', actual: 'loading' }
 * shaped objects.
 */
async function probeOnce(tabId) {
  let probe;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => ({
        readyState: document.readyState,
        bodyChildCount: document.body ? document.body.children.length : 0,
        bodyExists: !!document.body,
        online: navigator.onLine,
        url: location.href,
      }),
    });
    probe = results?.[0]?.result ?? null;
  } catch (err) {
    // Tab gone, scripting blocked, or about: page (chrome:// etc).
    return {
      ok: false,
      failures: [{ gate: 'tab_reachable', expected: 'reachable', actual: `error: ${err.message}` }],
      passed: [],
    };
  }
  if (!probe) {
    return {
      ok: false,
      failures: [{ gate: 'tab_reachable', expected: 'probe result', actual: 'null' }],
      passed: [],
    };
  }

  const failures = [];
  const passed = [];

  // Gate: ready_state
  if (probe.readyState === 'complete') {
    passed.push({ gate: 'ready_state', actual: probe.readyState });
  } else {
    failures.push({ gate: 'ready_state', expected: 'complete', actual: probe.readyState });
  }

  // Gate: body_present
  if (probe.bodyExists && probe.bodyChildCount >= 1) {
    passed.push({ gate: 'body_present', actual: `${probe.bodyChildCount} children` });
  } else {
    failures.push({
      gate: 'body_present',
      expected: 'body with ≥1 child',
      actual: probe.bodyExists ? `body with ${probe.bodyChildCount} children` : 'no body element',
    });
  }

  // Gate: online
  if (probe.online === true) {
    passed.push({ gate: 'online', actual: 'true' });
  } else {
    failures.push({ gate: 'online', expected: 'true', actual: String(probe.online) });
  }

  return {
    ok: failures.length === 0,
    failures,
    passed,
    url: probe.url,
  };
}

/**
 * Run universal gates with retry-until-timeout semantics.
 *
 * @param {Object} args
 * @param {number} args.tabId
 * @param {string} args.kind  - 'pre' or 'post'; used in logs only
 * @param {number} [args.timeoutMs=2000]
 * @param {string} [args.fragmentLabel] - for logging; "Fragment X" or invocationId
 * @returns {Promise<{ok: boolean, failures: Array, passed: Array, url: string|null,
 *                    attempts: number, elapsedMs: number, errorMessage: string|null}>}
 */
async function evaluate({ tabId, kind = 'pre', timeoutMs = DEFAULT_TIMEOUT_MS, fragmentLabel = '' }) {
  const start = Date.now();
  const deadline = start + Math.max(0, timeoutMs);
  let attempts = 0;
  let lastResult = null;
  while (true) {
    attempts++;
    lastResult = await probeOnce(tabId);
    if (lastResult.ok) {
      const elapsedMs = Date.now() - start;
      Logger.debug('UniversalGate',
        `${kind}-gate passed${fragmentLabel ? ` for ${fragmentLabel}` : ''} (attempt ${attempts}, ${elapsedMs}ms)`);
      return {
        ok: true,
        failures: [],
        passed: lastResult.passed,
        url: lastResult.url ?? null,
        attempts,
        elapsedMs,
        errorMessage: null,
      };
    }
    if (Date.now() >= deadline) break;
    // Mid-retry: debug only.
    Logger.debug('UniversalGate',
      `${kind}-gate attempt ${attempts} failed${fragmentLabel ? ` for ${fragmentLabel}` : ''} — retrying: ${formatFailures(lastResult.failures)}`);
    await sleep(POLL_INTERVAL_MS);
  }
  // Final fail.
  const elapsedMs = Date.now() - start;
  const errorMessage = buildErrorMessage(kind, lastResult.failures, elapsedMs);
  Logger.warn('UniversalGate',
    `${kind}-gate FAILED${fragmentLabel ? ` for ${fragmentLabel}` : ''} after ${attempts} attempts in ${elapsedMs}ms: ${formatFailures(lastResult.failures)}`);
  return {
    ok: false,
    failures: lastResult.failures,
    passed: lastResult.passed,
    url: lastResult.url ?? null,
    attempts,
    elapsedMs,
    errorMessage,
  };
}

/** Compact one-line failure summary for logs. */
function formatFailures(failures) {
  if (!Array.isArray(failures) || failures.length === 0) return '(no failures)';
  return failures
    .map(f => `${f.gate}=${f.actual} (expected ${f.expected})`)
    .join('; ');
}

/** Multi-line user-facing error message. */
function buildErrorMessage(kind, failures, elapsedMs) {
  const header = kind === 'post'
    ? `Page wasn't ready after fragment ran (waited ${elapsedMs}ms)`
    : `Page wasn't ready when fragment ran (waited ${elapsedMs}ms)`;
  const lines = failures.map(f => `  • ${f.gate}: actual ${f.actual} (expected ${f.expected})`);
  return [header, ...lines].join('\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export const UniversalGate = { evaluate };
