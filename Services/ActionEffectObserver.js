/**
 * @file Services/ActionEffectObserver.js
 * @description Phase 6.5 of the landmark substrate spec. Brackets an
 * engine-dispatched action with before/after page-state snapshots so
 * the substrate can observe what an action ACTUALLY did, vs the
 * heuristic `proposedEffect` declared at landmark authoring time.
 *
 * ── DEVIATION FROM SPEC (deliberate, surfaced for review) ─────────────
 *
 * The substrate spec calls for "runtime observation" of every action
 * execution. As implemented here, observation is INVOKED, NOT
 * AUTOMATIC. The engine decides per step whether to bracket an action
 * with observation. Default = no observation. Triggers per spec
 * deviation discussion (preserved verbatim for future reviewers):
 *
 *   (a) Terminal steps   — last action in a chain has no downstream
 *                          step to validate it. Without observation
 *                          we'd be blind to terminal success/failure.
 *   (b) Navigation-likely — landmark's `proposedEffect ===
 *                          'triggers-navigation'`. Downstream step
 *                          would race against the new document.
 *   (c) Authoring/learning — AI proposing next steps in a frontier
 *                          strategy needs grounded feedback.
 *   (d) Self-correction  — observed vs proposed effect mismatch
 *                          emits landmark-effect-drift for human
 *                          review (does not auto-update the landmark).
 *
 * Spec-as-written wrapped EVERY action: +1.5s × every CLICK adds
 * ~15s to a 10-step chain. Observation overhead duplicates downstream
 * pre-condition validation that already exists. Mutation noise on
 * production pages (analytics, polling, lazy-load) needs filtering
 * the spec didn't specify. This module ships the selective version;
 * the engine call site decides which actions to observe.
 *
 * ── API ──────────────────────────────────────────────────────────────
 *
 *   begin(tabId, frameId)
 *     Installs a MutationObserver in the target frame and captures a
 *     before-snapshot. Returns { success, startTs }.
 *
 *   end(tabId, frameId, settleMs = 800)
 *     Waits settleMs (so post-action mutations have time to land),
 *     then asks the content script to disconnect the observer and
 *     compute a before-vs-after diff. Returns the report:
 *       {
 *         success, observedEffect, urlChanged, titleChanged,
 *         topLevelDelta, dialogDelta, h1Changed, mutations,
 *         firstMutationLatencyMs, durationMs
 *       }
 *
 *   bracket(tabId, frameId, actionFn, opts)
 *     Convenience wrapper. begin → await actionFn(); → end. Returns
 *     { actionResult, observation }. actionFn's value is forwarded
 *     unchanged so the caller can inspect step success/error.
 *
 * ── OBSERVATION TIMING ───────────────────────────────────────────────
 *
 *   settleMs default = 800ms. Rationale: most SPA route changes
 *   complete within 300-500ms; full-page nav typically 200-1500ms.
 *   800ms balances responsiveness vs catching slow async commits.
 *   Caller can override per call (terminal steps may want longer).
 *
 * @module Services/ActionEffectObserver
 */

import { Logger } from '../Core/Logger.js';

const TOP_FRAME_ID = 0;
const DEFAULT_SETTLE_MS = 800;

function _send(tabId, message, frameId = TOP_FRAME_ID) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId }, response => {
        if (chrome.runtime.lastError) {
          Logger.debug('ActionEffectObserver', `send to frame ${frameId} failed: ${chrome.runtime.lastError.message}`);
          return resolve(null);
        }
        resolve(response);
      });
    } catch (e) {
      Logger.debug('ActionEffectObserver', `send threw: ${e.message}`);
      resolve(null);
    }
  });
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Begin observation in the target frame. Returns the begin response
 * (carrying startTs for downstream duration calculation) or null on
 * failure. Caller treats null as "couldn't observe; proceed without."
 *
 * @param {number} tabId
 * @param {number} [frameId=0]
 * @returns {Promise<{success: boolean, startTs?: number}|null>}
 */
export async function begin(tabId, frameId = TOP_FRAME_ID) {
  if (typeof tabId !== 'number') return null;
  const res = await _send(tabId, { type: 'OBSERVE_ACTION_BEGIN' }, frameId);
  if (!res?.success) {
    Logger.debug('ActionEffectObserver', `begin failed: ${res?.error ?? 'no response'}`);
    return null;
  }
  return res;
}

/**
 * End observation in the target frame after waiting `settleMs` so
 * post-action mutations have time to land. Returns the report or
 * null on failure.
 *
 * @param {number} tabId
 * @param {number} [frameId=0]
 * @param {number} [settleMs=800]
 * @param {number} [beginStartTs]  startTs from begin() for durationMs
 * @returns {Promise<object|null>}
 */
export async function end(tabId, frameId = TOP_FRAME_ID, settleMs = DEFAULT_SETTLE_MS, beginStartTs = null) {
  if (typeof tabId !== 'number') return null;
  if (settleMs > 0) await _sleep(settleMs);
  const res = await _send(tabId, { type: 'OBSERVE_ACTION_END' }, frameId);
  if (!res?.success) {
    Logger.debug('ActionEffectObserver', `end failed: ${res?.error ?? 'no response'}`);
    return null;
  }
  const report = res.report ?? {};
  if (typeof beginStartTs === 'number') {
    report.durationMs = Date.now() - beginStartTs;
  }
  return report;
}

/**
 * Bracket an action with observation. The action function runs
 * between begin and end; its return value is passed through unchanged
 * so the caller can inspect step success/error. The observation
 * report is null when begin or end failed (e.g., content script
 * unreachable) — caller treats null as "couldn't observe."
 *
 * @template T
 * @param {number} tabId
 * @param {number} frameId
 * @param {() => Promise<T>} actionFn
 * @param {{settleMs?: number}} [opts]
 * @returns {Promise<{ actionResult: T, observation: object|null }>}
 */
export async function bracket(tabId, frameId, actionFn, opts = {}) {
  const settleMs = typeof opts.settleMs === 'number' ? opts.settleMs : DEFAULT_SETTLE_MS;
  const beginRes = await begin(tabId, frameId);
  // If begin failed, still run the action — observation is best-effort.
  let actionResult;
  try {
    actionResult = await actionFn();
  } catch (e) {
    // Try to end (cleanup) even though the action threw.
    if (beginRes) await end(tabId, frameId, 0, beginRes.startTs);
    throw e;
  }
  let observation = null;
  if (beginRes) {
    observation = await end(tabId, frameId, settleMs, beginRes.startTs);
  }
  return { actionResult, observation };
}

/**
 * v2.74.305 — Spec-aligned drift classification (ACTION_SPEC § 8).
 *
 * Compares a declared Effect object to an observed Effect object and
 * returns one of four severity codes:
 *
 *   null                 — declared and observed match (no drift)
 *   'expected-missing'   — declared a non-none effect, observed none
 *   'unexpected'         — declared none, observed a non-none effect
 *   'parameter-mismatch' — same kind but different parameter (e.g.
 *                          declared opens-new-thread.form='tab',
 *                          observed opens-new-thread.form='window')
 *
 * Pre-v2.74.305 this returned a boolean (drift / no-drift) over strings.
 * The spec requires structured Effect objects + four-way severity.
 *
 * @param {object|null} declared    Effect { kind, form?, modalKind? }
 * @param {object|null} observed    Effect { kind, form?, modalKind? }
 * @returns {string|null}
 */
export function classifyEffectDrift(declared, observed) {
  const decKind = declared?.kind ?? 'none';
  const obsKind = observed?.kind ?? 'none';
  if (decKind === obsKind) {
    // Same kind — check structured parameters for parameter-mismatch.
    if (decKind === 'opens-new-thread' && declared?.form && observed?.form
        && declared.form !== observed.form) {
      return 'parameter-mismatch';
    }
    if (decKind === 'triggers-modal' && declared?.modalKind && observed?.modalKind
        && declared.modalKind !== observed.modalKind) {
      return 'parameter-mismatch';
    }
    return null;   // match
  }
  if (decKind !== 'none' && obsKind === 'none') return 'expected-missing';
  if (decKind === 'none' && obsKind !== 'none') return 'unexpected';
  // Both non-none but different kinds (e.g. declared triggers-navigation,
  // observed triggers-modal). Treat as parameter-mismatch because the
  // shape changed.
  return 'parameter-mismatch';
}

/**
 * Back-compat wrapper retained for call sites that haven't migrated to
 * `classifyEffectDrift`. Returns a boolean (true = drift exists).
 * Prefer the new function for new code.
 *
 * @deprecated use classifyEffectDrift; this loses severity information.
 */
export function isEffectDrift(proposed, observed) {
  // Accept either spec-aligned Effect objects OR legacy strings.
  const normalize = (v) => {
    if (!v) return { kind: 'none' };
    if (typeof v === 'object') return v;
    if (v === 'unknown') return { kind: 'none' };
    return { kind: v };
  };
  return classifyEffectDrift(normalize(proposed), normalize(observed)) !== null;
}

/**
 * Heuristic: should this step trigger automatic observation?
 *
 * Engine call sites pass step + resolvedFromLandmark + isTerminal and
 * this function returns true when one of the substrate's documented
 * triggers fires (terminal step, navigation-likely click). Explicit
 * opt-in via `step.observeEffect === true` always wins.
 *
 * Engine call sites stay simple: just call shouldObserveStep and pass
 * its boolean to the bracket decision.
 *
 * @param {object} step
 * @param {object|null} desc  step._resolvedFromLandmark
 * @param {boolean} [isTerminal=false]
 * @returns {boolean}
 */
export function shouldObserveStep(step, desc, isTerminal = false) {
  if (!step || typeof step !== 'object') return false;
  // ACTION_SPEC § 8 — per-Action observeEffect override.
  // Accept both the spec field name (options.observeEffect: 'always' |
  // 'on-mismatch-prior' | 'never') and the legacy boolean form.
  const obsOpt = step.options?.observeEffect ?? step.observeEffect;
  if (obsOpt === 'always' || obsOpt === true) return true;
  if (obsOpt === 'never'  || obsOpt === false) return false;   // explicit opt-out
  if (isTerminal === true) return true;
  // v2.74.306 — Observe whenever a non-none substrate effect is DECLARED
  // (on the action OR inherited from the landmark). A declared effect
  // that doesn't fire is exactly the drift § 8 wants to catch, and a
  // declared effect that DOES fire often needs orchestration handling
  // (navigation completion, new-thread capture). Generalizes the
  // v2.74.250 "navigation-likely" trigger to all five effect kinds.
  const declaredKind = (step.effect && step.effect.kind)
    ? step.effect.kind
    : (desc?.effect?.kind
        ?? (typeof desc?.proposedEffect === 'string' && desc.proposedEffect !== 'unknown'
            ? desc.proposedEffect
            : null));
  if (declaredKind && declaredKind !== 'none') return true;
  return false;
}

export const DEFAULT_OBSERVATION_SETTLE_MS = DEFAULT_SETTLE_MS;
