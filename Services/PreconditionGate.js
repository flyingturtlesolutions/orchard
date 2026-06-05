/**
 * @file Services/PreconditionGate.js
 * @description Evaluate a fragment's preconditions against the current tab,
 *              classify any failure, and produce a structured outcome the
 *              caller can act on.
 *
 * The gate is a single function that wraps everything precondition-related:
 * per-condition evaluation (so we get all failures, not just the first),
 * URL capture for diagnostics, and PageClassifier invocation to label the
 * failure with a recovery-typed category.
 *
 * The gate does NOT know about strategy execution, FOREACH iterations,
 * stepResults aggregation, or fragment_failed event emission. Those are
 * caller concerns — the gate just answers "did preconditions hold, and
 * if not, what do we know about why."
 *
 * Extracted from ExecutionEngine.js (v2.54.0) when the inline gate logic
 * crossed ~120 lines and started conflating multiple concerns.
 *
 * @module Services/PreconditionGate
 */

import { Logger }          from '../Core/Logger.js';
import { TemplateWalker }  from './TemplateWalker.js';
import { PageClassifier }  from './PageClassifier.js';
import { describeCondition } from './Assertion.js';
import { StorageManager }  from './StorageManager.js';
import { isPerspectiveActive } from './PerspectivePredicates.js';

/**
 * Outcome of evaluating a fragment's preconditions.
 *
 * @typedef {Object} PreconditionOutcome
 * @property {boolean} ok - True if all preconditions held (or none declared).
 * @property {Object[]} failures - [{ condition, reason }, ...] for failed conditions.
 * @property {Object[]} passed - The condition specs that did hold.
 * @property {string|null} url - Tab URL at evaluation time (null if tab gone).
 * @property {Object|null} classification - PageClassifier result on failure; null if ok.
 * @property {string|null} errorMessage - Multi-line user-facing error on failure; null if ok.
 */

/**
 * Evaluate a fragment's preconditions against the live page state in `tabId`.
 *
 * Returns `{ ok: true }` if no preconditions are declared or all hold.
 * On failure, returns a fully-populated PreconditionOutcome with the
 * failure list, what passed, the URL, the classification, and a formatted
 * error message ready to go in a fragment_failed event.
 *
 * Per-condition evaluation strategy: each precondition is checked via its
 * own checkConditions call rather than batched. This costs N round-trips
 * but defeats checkConditions' short-circuit-on-first-failure behavior so
 * the caller learns about every failure at once. The cost only applies on
 * the failure path; the typical-success path of "no preconditions" or
 * "all hold" doesn't pay it.
 *
 * Never throws. Classification errors are caught inside this function
 * and surfaced via classification.category === 'unknown'.
 *
 * @param {Object} args
 * @param {number} args.tabId
 * @param {Object} args.fragment - has .preconditions array
 * @returns {Promise<PreconditionOutcome>}
 */
async function evaluate({ tabId, fragment }) {
  const all = Array.isArray(fragment?.preconditions) ? fragment.preconditions : [];
  // b6a (v2.74.775) — split off NON-FATAL advisory substrate gates (a perspective_ref tagged advisory:true).
  // They are evaluated via isPerspectiveActive (the monitor's own or-over-landmarks predicate, drift-tolerant,
  // fail-closed) and NEVER affect `ok` — they only surface as advisories for the monitor/editor. The FATAL plane
  // below is byte-for-byte the prior behaviour over the non-advisory subset, so existing fragments (no advisory
  // condition) get IDENTICAL handling and zero added work (the advisory pass no-ops on an empty list).
  const advisoryConds = all.filter((c) => c && c.advisory === true);
  const preconditions = all.filter((c) => !(c && c.advisory === true));
  const advisories = await _evaluateAdvisories({ tabId, fragment, conds: advisoryConds });

  if (preconditions.length === 0) {
    return { ok: true, failures: [], passed: [], url: null, classification: null, errorMessage: null, advisories };
  }

  // Per-condition evaluation. checkConditions short-circuits on first
  // failure when match='all' (the default for our case), which loses
  // diagnostic information. Asking each independently gives the full
  // picture: which specifically failed and which actually held.
  const failures = [];
  const passed   = [];
  for (const cond of preconditions) {
    const oneCheck = await TemplateWalker.checkConditions({
      tabId, conditions: [cond],
    });
    if (oneCheck.ok) {
      passed.push(cond);
    } else {
      // checkConditions returns at most one failure per condition, so
      // failures[0] is what we want. Defensive fallback to a synthesized
      // entry if the shape ever drifts.
      const f = oneCheck.failures?.[0] ?? { condition: cond, reason: 'condition not met' };
      failures.push(f);
    }
  }

  if (failures.length === 0) {
    return { ok: true, failures: [], passed, url: null, classification: null, errorMessage: null, advisories };
  }

  // Capture the current tab URL once for diagnostics. The full URL (not
  // just pathname) is what distinguishes a CAPTCHA challenge from a normal
  // page on the same path.
  let url = null;
  try {
    const tabInfo = await chrome.tabs.get(tabId);
    url = tabInfo?.url ?? null;
  } catch { /* tab closed */ }

  // Classify the failure. PageClassifier.classify never throws (it returns
  // an 'unknown' classification on internal error), but we still wrap the
  // call defensively so any future regression in that contract doesn't
  // break the gate.
  let classification;
  try {
    classification = await PageClassifier.classify({
      tabId, fragment, preconditionFailures: failures, actualUrl: url,
    });
  } catch (err) {
    Logger.warn('PreconditionGate', `Classifier threw despite never-throws contract: ${err.message}`);
    classification = PageClassifier.unknownClassification(`Classifier error: ${err.message}`);
  }

  const errorMessage = formatErrorMessage({
    failures, passed, total: preconditions.length, url, classification,
  });

  // Single info log per failure with the classification summary. Caller
  // emits the structured fragment_failed event with full data.
  Logger.info('PreconditionGate',
    `${fragment.name ?? fragment.id} — ${PageClassifier.summarize(classification)}`);

  return { ok: false, failures, passed, url, classification, errorMessage, advisories };
}

/**
 * b6a — evaluate NON-FATAL advisory substrate gates. Each `{ type:'perspective_ref', perspectiveId, advisory:true }`
 * is checked via isPerspectiveActive (the SAME predicate the InteractionMonitor reads): the perspective's
 * `and(urlMatches, or(landmarkExists…))` tree — an OR over landmarks that is drift-tolerant and fail-closed.
 * Returns [{ condition, active, reason }] for the caller/monitor; NEVER throws and NEVER affects gate `ok`. A miss
 * is logged at info (so the demoted-but-present substrate is observable) and the run proceeds. No-ops (returns [])
 * on an empty list, so a fragment with no advisory gate pays nothing — not even the chrome.tabs.get below.
 *
 * @param {{tabId:number, fragment:object, conds:object[]}} args
 * @returns {Promise<Array<{condition:object, active:boolean, reason:(string|null)}>>}
 */
async function _evaluateAdvisories({ tabId, fragment, conds }) {
  if (!Array.isArray(conds) || conds.length === 0) return [];
  let tabUrl = null;
  try { const t = await chrome.tabs.get(tabId); tabUrl = t?.url ?? null; } catch { /* tab gone — leave null */ }
  const out = [];
  for (const c of conds) {
    if (!c || c.type !== 'perspective_ref' || !c.perspectiveId) continue;   // only perspective gates are advisory-evaluable today
    let active = null;
    try {
      const persp = await StorageManager.getPerspective(c.perspectiveId);
      if (persp) active = await isPerspectiveActive(persp, { tabUrl, tabId });
    } catch (e) {
      Logger.debug('PreconditionGate', `advisory perspective ${c.perspectiveId} eval failed: ${e.message}`);
    }
    out.push({ condition: c, active: active === true, reason: active === true ? null : (active === false ? 'perspective not active' : 'perspective unverifiable') });
    if (active !== true) {
      Logger.info('PreconditionGate', `${fragment?.name ?? fragment?.id} — advisory substrate gate: perspective ${c.perspectiveId} ${active === false ? 'NOT active' : 'unverifiable'} (non-fatal, continuing)`);
    }
  }
  return out;
}

/**
 * Build the multi-line user-facing error string from a failure outcome.
 * Pure formatting; no I/O.
 *
 * @param {Object} args
 * @returns {string}
 */
function formatErrorMessage({ failures, passed, total, url, classification }) {
  const failureLines = failures.map(f => {
    const spec = describeCondition(f.condition);
    const reason = f.reason && f.reason !== 'condition not met' ? ` — ${f.reason}` : '';
    return `  - ${spec}${reason}`;
  });

  const parts = [`preconditions did not hold (${failures.length}/${total}):`];
  parts.push(failureLines.join('\n'));
  if (url) parts.push(`Actual URL: ${url}`);
  if (passed.length > 0) {
    parts.push(`Preconditions that did hold: ${passed.map(describeCondition).join(', ')}`);
  }

  if (classification) {
    if (classification.category === 'unknown') {
      parts.push(`Classification: unknown — no known failure category matched.`);
    } else {
      parts.push(`Classification: ${PageClassifier.summarize(classification)}`);
      if (classification.rationale) parts.push(`  ${classification.rationale}`);
    }
  }

  return parts.join('\n');
}

export const PreconditionGate = { evaluate };
