/**
 * @file Services/ExecutionEngine.js
 * @description Strategy executor — opens a walker tab, runs each Fragment
 * step in sequence via TemplateWalker.executeFragment, and aggregates the
 * results into a final StrategyResult. The only entry point is the static
 * method `executeStrategy`.
 *
 * v2.28.3 (Pass Q) — Path-era job queue, drain loop, per-step executor,
 * content-script bridge, and walker-tree scaffolding (#walkNode, #walkLeaf,
 * #walkForEach, #walkDetect, #evaluateCondition) removed. ~1241 lines of
 * dead code. Reference material for reusing the walker-tree methods in
 * Pass E2 is preserved in docs/e2-scaffolding-notes.md.
 *
 * @module Services/ExecutionEngine
 * @author Agent HUB
 * @version 2.28.3
 */

import { Logger }                 from '../Core/Logger.js';
import { StorageManager }         from './StorageManager.js';
import { TemplateWalker }         from './TemplateWalker.js';
import { Scope, scalar, list, record, image, section, document, asString } from './Scope.js';
import { parseFileValue, isFileValue } from './FileParsers.js';
import { isBuiltinAnalysisId, getBuiltinAnalysis } from './BuiltinAnalyses.js';
import { evaluateDataConditionList, evaluateDataAssertionEnvelope, flattenScopeAssertionRefs, describeDataCondition } from './DataAssertion.js';
import { describeOperations, describeContract, describePreconditions } from './AnalysisDescribe.js';
import { AnthropicService }       from './AnthropicService.js';
import { normalizeStrategyBody, normalizeStrategyParams }  from './StrategyTree.js';
import { PreconditionGate }       from './PreconditionGate.js';
import { UniversalGate }          from './UniversalGate.js';
import { parseTemplate, evalTemplate } from './TemplateEngine.js';
import { runTransformBody }            from './TransformOps.js';
// v2.74.145 / v2.74.146 — image_snap / image_full / image_read share a
// helper module. ExecutionEngine runs inside the background SW; it used
// to reach these by self-sending `OBSERVE_IMAGE_*_BG`, which closes the
// response port in MV3 module SWs (read hit this every time because of
// the slow Claude call; snap/full hit it less often but the antipattern
// is the same). Calling the helpers directly side-steps both the
// self-message issue and the 5s sendMessage timeout.
import { performImageSnap, performImageFull, performImageRead }
  from './ImageReadCapture.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** How long (ms) to wait for a new tab to reach "complete" load status. @constant {number} */
const TAB_LOAD_TIMEOUT_MS = 30_000;

// ─── ExecutionEngine class ────────────────────────────────────────────────────

/**
 * @class ExecutionEngine
 * @classdesc Thin wrapper around executeStrategy; maintained as a class for
 * future extension (invocation tracking, multi-tab concurrency, etc.) and
 * because the instance is imported by background.js as a singleton.
 */
export class ExecutionEngine {

  constructor() {
    Logger.info('ExecutionEngine', 'Initialised');
  }





  // ── Pass C — Strategy execution ──────────────────────────────────────────
  //
  // Strategies are named, linear sequences of Fragment invocations with
  // per-invocation param bindings. Execution:
  //   1. Resolve strategy-level params into per-Fragment bindings
  //   2. Open a tab on the Ground URL
  //   3. For each fragment step in order:
  //      a. Invoke TemplateWalker.executeFragment (which handles antecedent replay + own rawJson)
  //      b. Check postconditions; fail the whole Strategy if any fragment's postconditions fail
  //   4. Return { success, stepResults, error }
  //
  // Pass C is LINEAR only. Iterate/detect/conditional nodes come in Pass E.

  /**
   * Execute a Strategy end-to-end.
   *
   * @param {Object} opts
   * @param {string} opts.strategyId
   * @param {Object} [opts.strategyParamValues]  - { PARAM_NAME: value } from the invoker
   * @param {string} [opts.invocationId]          - key for progress broadcasts (defaults to uuid)
   * @param {() => boolean} [opts.isAborted]      - abort-flag poller
   * @param {(event: Object) => void} [opts.onProgress]  - optional progress callback
   *
   * v2.38.0 (Pass K1) — debug controls
   * @param {Object} [opts.debug]                 - optional debug-mode controls
   * @param {'off'|'after-node'|'after-fragment'} [opts.debug.pauseMode='off']
   *        Where the engine yields:
   *          'off'             — never yields (current behavior)
   *          'after-node'      — yields after each top-level tree node
   *          'after-fragment'  — yields after every fragment invocation
   *                              (including those inside FOREACH/DETECT/LOOP/TRY/IN_NEW_TAB bodies)
   * @param {() => boolean} [opts.debug.isPaused]
   *        Polled at each yield point. While true, engine sleeps and checks
   *        again every ~100ms. The side panel mutates this in response to
   *        user clicks (Resume/Step/Abort).
   * @param {() => boolean} [opts.debug.isStepping]
   *        Read at each yield point. If true, engine sets isPaused-equivalent
   *        flag for the *next* yield (single-step then pause). The side panel
   *        manages this flag transition.
   * @param {(state: Object) => void} [opts.debug.onPauseStateChange]
   *        Called whenever the engine enters or leaves a paused state.
   *        Payload includes current node info, scope snapshot, URL, etc.
   *
   * @returns {Promise<{
   *   success: boolean, aborted?: boolean,
   *   strategyId: string, invocationId: string,
   *   stepResults: Array<{ fragmentId: string, fragmentName: string, success: boolean, actionsRun: number, error: string|null, postFailures?: Array<Object> }>,
   *   error: string|null,
   * }>}
   */
  static async executeStrategy({
    strategyId,
    strategyParamValues = {},
    invocationId = null,
    isAborted = () => false,
    onProgress = null,
    debug = null,
  }) {
    const invId = invocationId || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `inv-${Date.now()}`);

    const emit = (ev) => {
      try { onProgress?.(ev); } catch (_) { /* ignore */ }
      // v2.74.190 — Surface the failure reason in the log line + use
      // ERROR level for failure events. Previously this only read
      // ev.message, but failure events (fragment_failed, error,
      // aborted) carry their reason in ev.error — and the rest in
      // structured fields (gateFailures, preconditionFailures,
      // lastActions, scopeSnapshot). The old code printed
      // "fragment_failed:" with an empty trailing string, leaving the
      // user with no clue why anything broke. Now the message includes
      // ev.error || ev.message, the full event ships as the entry's
      // `data` field (preserved in storage for Logs-tab inspection),
      // and failure events are logged at ERROR level so they stand
      // out against the INFO-level lifecycle stream.
      const failureTypes = new Set(['fragment_failed', 'error', 'failed', 'aborted']);
      const isFailure = failureTypes.has(ev.type);
      const summary = ev.error || ev.message || '';
      const line    = `[${invId}] ${ev.type ?? 'progress'}${summary ? ': ' + summary : ''}`;
      if (isFailure) {
        Logger.error('ExecutionEngine', line, ev);
      } else {
        Logger.info('ExecutionEngine', line, ev);
      }
    };

    // 1. Load Strategy
    const strategy = await StorageManager.getStrategy(strategyId);
    if (!strategy) {
      emit({ type: 'error', message: `Strategy ${strategyId} not found` });
      return { success: false, strategyId, invocationId: invId, stepResults: [], error: `Strategy ${strategyId} not found` };
    }

    const ground = await StorageManager.getGround(strategy.groundId);
    if (!ground) {
      return { success: false, strategyId, invocationId: invId, stepResults: [], error: `Ground ${strategy.groundId} not found` };
    }

    // v2.72.27 (Pass 15) — Tier dispatch. Strategies grow an implementations
    // envelope mirroring Analyses (Pass 7a) and Observations (Pass 8).
    //   T1 (tier='cache'): body.tree.fragmentSteps is the canonical store.
    //     The top-level fragmentSteps mirror is kept by storage migration
    //     for backward compat; engine reads from body.tree directly with
    //     the mirror as fallback.
    //   T3 (tier='frontier'): no body.tree — the strategy's name + goal +
    //     pre/post serve as the model's compose instruction. Pass 15 plumbs
    //     the shape; Pass 16 implements the composer.
    const impl0 = Array.isArray(strategy.implementations) && strategy.implementations.length > 0
      ? strategy.implementations[0] : null;
    const tier = impl0?.tier ?? 'cache';

    if (tier === 'frontier') {
      // T3 strategy execution. Stub for Pass 15. Pass 16 will:
      //   1. Build the tool catalogue (fragments / observations / analyses
      //      / library assertions / strategies on the Ground)
      //   2. Build a context bundle (current page state, scope, goal, pre/post)
      //   3. Invoke the frontier API to compose a strategy tree
      //   4. Validate against the strategy schema
      //   5. Dispatch to deterministic engine
      const errMsg = `Strategy "${strategy.name}" is T3 (frontier-tier compose) — composer not yet implemented (Pass 16). Author a T1 implementation, or wait for the composer.`;
      Logger.error('ExecutionEngine', `executeStrategy "${strategy.name}" — T3 not yet implemented`);
      emit({
        type: 'failed',
        message: errMsg,
        tier: 'frontier',
      });
      return { success: false, aborted: false, strategyId, invocationId: invId, stepResults: [], error: errMsg };
    }

    // T1 path: read fragmentSteps from canonical body.tree (with the
    // top-level mirror as fallback — same data either way).
    const cacheBodySteps = (impl0?.tier === 'cache' && Array.isArray(impl0?.body?.tree?.fragmentSteps))
      ? impl0.body.tree.fragmentSteps
      : (Array.isArray(strategy.fragmentSteps) ? strategy.fragmentSteps : []);

    // v2.29.0 (Pass E2-1) — Normalize the Strategy body shape.
    // v2.29.2 (Pass E2-3) — Tree execution: the normalized body is now
    // walked recursively by #executeNodes, which dispatches on node.type
    // to #executeFragmentNode or #executeForEachNode. Non-fragment nodes
    // at any depth are executed when their type is recognised.
    const normalizedBody = normalizeStrategyBody(cacheBodySteps);
    if (normalizedBody.length === 0) {
      return { success: false, strategyId, invocationId: invId, stepResults: [], error: 'Strategy has no steps' };
    }

    Logger.info('ExecutionEngine', `executeStrategy "${strategy.name}" — tier=${tier}, ${normalizedBody.length} top-level node(s) — invocation ${invId}`);
    emit({ type: 'start', message: `Running ${strategy.name}`, strategyName: strategy.name, tier });

    // E1 (v2.26.0) — Construct the Strategy execution scope.
    //
    // Input params (from the chat extraction or Lab modal) populate the bottom
    // frame. EXTRACT actions inside Fragments will write back into the same
    // frame. The final scope is folded into the result so the chat can display
    // extracted values.
    //
    // v2.59.0 — Param values respect their declared kind from strategy.params.
    // Scalar-kind (the default and pre-v2.59 behavior) seed as scalar().
    // List-kind seed as list([scalar(item), ...]) so FOREACH can iterate them.
    // Unknown / undeclared param names default to scalar (forward-compat for
    // values passed without a corresponding param declaration).
    //
    // Forward-compat: only one frame in E1 (linear Strategies). E2's FOREACH
    // pushes additional frames per iteration; the scope abstraction handles
    // that without a follow-up engine change.
    // v2.74.66 — Typed-input scope seeding. Pre-v2.74.66 every param was
    // assumed to be a string (or array of strings for kind='list'). With
    // typed inputs, params now declare {type, kind, parse, ...} via
    // normalizeStrategyParams. The seeding loop dispatches by type:
    //   string/number/boolean → scalar(value)  (existing behavior)
    //   file                  → parseFileValue(value, parse) → tagged value
    //   list-kind             → list of scalars  (existing behavior)
    //
    // File parsing is async (TextDecoder + JSON.parse + custom CSV
    // walker, or future docx/pdf/xlsx libs) so the whole seeding loop
    // became async. Parser errors fail the invocation up-front rather
    // than letting a half-seeded scope reach the body.
    const scope = new Scope();
    const normParams = normalizeStrategyParams(strategy.params);
    const paramDescByName = new Map(normParams.map(p => [p.name, p]));

    for (const [name, value] of Object.entries(strategyParamValues ?? {})) {
      const desc = paramDescByName.get(name);
      const type = desc?.type ?? 'string';
      const kind = desc?.kind === 'list' ? 'list' : 'scalar';

      // File inputs: parse bytes into a tagged value matched to the parser.
      if (type === 'file' && isFileValue(value)) {
        try {
          const tagged = await parseFileValue(value, desc?.parse ?? 'auto');
          scope.set(name, tagged);
        } catch (err) {
          const msg = `Couldn't parse uploaded file "${value.filename}" for param ${name}: ${err.message}`;
          Logger.error('ExecutionEngine', msg);
          emit({ type: 'failed', message: msg });
          return { success: false, strategyId, invocationId: invId, stepResults: [], error: msg };
        }
        continue;
      }

      // Non-file: existing scalar/list seeding. Numbers and booleans flow
      // through scalar() — its String() coercion keeps the .value field a
      // string (Scope's contract) while the value's natural meaning survives
      // for template substitution. Once Scope grows subtype-aware seeding
      // for numbers/booleans, this branch will set subtype too.
      if (kind === 'list') {
        const items = Array.isArray(value) ? value.map(v => scalar(v)) : [];
        scope.set(name, list(items));
      } else {
        scope.set(name, scalar(value));
      }
    }

    // 2. Open tab on Ground URL
    let tabId = null;
    const stepResults = [];
    let overallError = null;

    try {
      tabId = await ExecutionEngine.#openTab(ground.url);
      await ExecutionEngine.#waitForTabReady(tabId);

      // v2.72.24 (Pass 13) — Strategy preconditions. Evaluated after the
      // tab is open and reachable but before any nodes run. Both page-family
      // (URL, selector_present, etc.) and scope-family (binding_is_*,
      // scalar_*, etc.) conditions supported. Page conditions evaluate
      // against the live tab; scope conditions evaluate against the seeded
      // scope (strategy params).
      const preEnvelope = strategy.preconditions;
      const preConds = (preEnvelope && Array.isArray(preEnvelope.conditions))
        ? preEnvelope.conditions : [];
      if (preConds.length > 0) {
        emit({ type: 'strategy_pre_attempting',
               message: `Checking ${preConds.length} preconditions`,
               count: preConds.length });
        const preResult = await TemplateWalker.checkConditions({
          tabId,
          conditions: {
            match: preEnvelope.match ?? 'all',
            conditions: preConds,
            ...(typeof preEnvelope.count === 'number' ? { count: preEnvelope.count } : {}),
          },
          scope,
        });
        if (!preResult.ok) {
          const f = preResult.failures?.[0];
          const reason = f?.reason ?? 'precondition not met';
          const condDesc = f?.condition?.type ?? 'condition';
          overallError = `Strategy precondition failed — ${condDesc}: ${reason}`;
          Logger.error('ExecutionEngine', `executeStrategy "${strategy.name}" — precondition failed: ${overallError}`);
          emit({ type: 'strategy_pre_failed',
                 message: overallError,
                 condition: f?.condition, reason });
          // Skip execution; jump to finally for tab cleanup.
        }
      }

      // v2.25.6 — Within-invocation memoization for antecedent-replay.
      const completedFragmentIds = new Set();

      // v2.29.2 (Pass E2-3) — Build the execution context shared across the
      // recursive walker. All per-invocation mutable state lives here so the
      // walker can inspect / update / emit cleanly without threading a dozen
      // params through every recursive call.
      const ctx = {
        tabId,
        scope,
        stepResults,
        emit,
        isAborted,
        invocationId: invId,
        completedFragmentIds,
        strategyName: strategy.name,
        // Counter of top-level steps — used for human-facing "Step N/M" labels.
        // Nested FOREACH iterations inherit the top-level index of the FOREACH
        // node that contains them; iteration labels are added on top.
        topLevelTotal: normalizedBody.length,
        // v2.38.0 (Pass K1) — debug controls. Normalized to a non-null shape
        // so executors can blindly call yieldIfPaused(ctx) without checking.
        // pauseMode='off' means yieldIfPaused is a no-op.
        debug: {
          pauseMode: debug?.pauseMode ?? 'off',
          isPaused: debug?.isPaused ?? (() => false),
          isStepping: debug?.isStepping ?? (() => false),
          onPauseStateChange: debug?.onPauseStateChange ?? (() => {}),
          // v2.60.3 — forward requestPause so #executePauseNode can flip
          // the invocation into paused state. Defaults to a no-op so the
          // engine doesn't crash if a non-debug invocation somehow reaches
          // a PAUSE node (the guard rejects that case before calling).
          requestPause: debug?.requestPause ?? (() => {}),
        },
      };

      // 3. Execute the body. Returns { status: 'ok' | 'failed' | 'aborted', error?: string }
      // Skip if pre already failed.
      if (overallError === null) {
        const result = await ExecutionEngine.#executeNodes(normalizedBody, ctx, { topLevelStart: 0 });
        if (result.status === 'aborted') {
          overallError = 'Aborted';
        } else if (result.status === 'failed') {
          overallError = result.error ?? 'Execution failed';
        }
      }

      // v2.72.24 (Pass 13) — Strategy postconditions. Evaluated after all
      // nodes complete successfully (skipped if anything failed). Both
      // page-family (final URL/selectors) and scope-family (final scope
      // bindings) conditions supported.
      if (overallError === null) {
        const postEnvelope = strategy.postconditions;
        const postConds = (postEnvelope && Array.isArray(postEnvelope.conditions))
          ? postEnvelope.conditions : [];
        if (postConds.length > 0) {
          emit({ type: 'strategy_post_attempting',
                 message: `Checking ${postConds.length} postconditions`,
                 count: postConds.length });
          const postResult = await TemplateWalker.checkConditions({
            tabId,
            conditions: {
              match: postEnvelope.match ?? 'all',
              conditions: postConds,
              ...(typeof postEnvelope.count === 'number' ? { count: postEnvelope.count } : {}),
            },
            scope,
          });
          if (!postResult.ok) {
            const f = postResult.failures?.[0];
            const reason = f?.reason ?? 'postcondition not met';
            const condDesc = f?.condition?.type ?? 'condition';
            overallError = `Strategy postcondition failed — ${condDesc}: ${reason}`;
            Logger.error('ExecutionEngine', `executeStrategy "${strategy.name}" — postcondition failed: ${overallError}`);
            emit({ type: 'strategy_post_failed',
                   message: overallError,
                   condition: f?.condition, reason });
          }
        }
      }
    } catch (err) {
      overallError = err.message;
      Logger.error('ExecutionEngine', `executeStrategy threw: ${err.message}`);
    } finally {
      // 4. Close tab per user preference
      if (tabId !== null) {
        const closeSetting = await new Promise(r => {
          chrome.storage.local.get(['settings:close_tab_after_run'], (data) => {
            r(data['settings:close_tab_after_run']);
          });
        });
        // Default true if unset
        if (closeSetting !== false) {
          chrome.tabs.remove(tabId).catch(() => { /* tab may already be gone */ });
        }
      }
    }

    const success = overallError === null;
    // v2.36.0 (J1) — Strategy-end events carry the final scope + URL.
    // Useful both for success (authors see accumulated EMIT output in the
    // log) and for failure (they see where the tab ended up and what was
    // captured before things broke).
    let endUrl = null;
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      endUrl = tabInfo?.url ?? null;
    } catch { /* tab closed */ }
    emit({
      type: success ? 'complete' : 'failed',
      message: success ? `Strategy completed (${stepResults.length} steps)` : overallError,
      scopeSnapshot: scope.asResultObject(),
      url: endUrl,
    });

    // v2.74.155 — Apply the Strategy's declared-outputs filter (the
    // "Results" section in the Strategy form). When `strategy.outputs`
    // is a non-empty array, the returned extractedValues is restricted
    // to those binding names so only the author-promoted bindings flow
    // up to the parent Workflow's scope. When the field is absent or
    // empty, the historical "promote the entire final scope" behavior
    // is preserved (back-compat with strategies authored before this
    // feature).
    const fullScope = scope.asResultObject();
    const declaredOutputs = Array.isArray(strategy.outputs) ? strategy.outputs : [];
    const declaredNames = declaredOutputs
      .map(o => String(o?.name ?? '').trim())
      .filter(Boolean);
    let extractedValues;
    if (declaredNames.length === 0) {
      extractedValues = fullScope;   // legacy: no filter declared → expose all
    } else {
      extractedValues = {};
      for (const name of declaredNames) {
        if (Object.prototype.hasOwnProperty.call(fullScope, name)) {
          extractedValues[name] = fullScope[name];
        }
        // Names that the body didn't actually bind are silently
        // dropped — the runtime contract is "promote these IF
        // available," not "fail if missing." The author's intent is
        // captured in the declaration; missing bindings usually mean
        // the upstream extract didn't run (FOREACH iter that produced
        // nothing, optional DETECT branch skipped, etc.).
      }
    }

    return {
      success,
      aborted: overallError === 'Aborted',
      strategyId, invocationId: invId,
      stepResults,
      // E1 (v2.26.0) — Final scope state. Includes both input params (echoed
      // back) and any values written by EXTRACT actions during execution.
      // Tagged-value shape preserved so the renderer can format scalars vs
      // lists vs elements distinctly. Empty object when no params at all.
      // v2.74.155 — Filtered by strategy.outputs when declared (see above).
      extractedValues,
      error: overallError,
    };
  }

  /**
   * v2.74.78 — Public entry point for invoking a single Analysis as a step,
   * outside the Workflow tree walker. Used by the Strategy-tier executor
   * (Services/WorkflowExecutor.js): a Strategy's `analysis` step has the
   * same shape as a Workflow's SIEVE node (analysisId / source / output /
   * paramBindings), so it dispatches to the same #executeSieveNode body.
   *
   * The caller supplies a pre-loaded Scope instance — typically populated
   * with the Strategy's typed inputs (as tagged scalar / list values) plus
   * any upstream-step outputs accumulated across earlier steps. After
   * execution, new bindings written by the Analysis (chiefly `output`) are
   * visible via `scope.asResultObject()`.
   *
   * @param {Object}   args
   * @param {Object}   args.node       - { analysisId, source, output, paramBindings }
   * @param {Scope}    args.scope      - pre-loaded Scope (read AND write target)
   * @param {Function} [args.onProgress]
   * @param {number}   [args.stepIndex=0] - used for human-readable step labels
   * @returns {Promise<{status:'ok'|'failed', error?:string}>}
   */
  static async executeAnalysisStep({ node, scope, onProgress, stepIndex = 0 }) {
    // Synthetic ctx mirrors what executeStrategy builds for the Workflow
    // tree walker, minus the page / debug / abort plumbing (analyses are
    // pure data ops — no tab, no DOM probe). #executeSieveNode reads only
    // scope / emit / topLevelTotal from ctx; helpers it delegates to
    // (#executeSieveTemplate, #executeSieveFrontierCompose,
    // #resolveAnalysis) likewise stay within those fields.
    const ctx = {
      scope,
      emit: onProgress ?? (() => {}),
      topLevelTotal: 1,
    };
    // Coerce the analysis-step shape to the legacy sieve-node shape that
    // #executeSieveNode expects. The fields are identical today; this kept
    // in case the two shapes ever diverge.
    const sieveNode = {
      type: 'sieve',
      analysisId    : node.analysisId,
      source        : node.source ?? '',
      output        : node.output ?? '',
      paramBindings : node.paramBindings ?? {},
    };
    return await ExecutionEngine.#executeSieveNode(sieveNode, ctx, { topLevelIndex: stepIndex });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tree walker (Pass E2-3)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // executeStrategy hands the normalized body to #executeNodes, which walks
  // the tree and dispatches each node to its type-specific executor.
  //
  // Return shape is uniform: { status, error? } where status is one of
  //   'ok'      — node (and any children) completed successfully
  //   'failed'  — some node failed; caller should short-circuit
  //   'aborted' — isAborted() was true at some point; bail cleanly
  //
  // The walker never throws for expected failures — they propagate as
  // 'failed'. Genuine exceptions (DOM errors, storage errors) bubble up to
  // executeStrategy's try/catch.

  /**
   * Execute a sequence of nodes, short-circuiting on the first non-ok status.
   *
   * @param {Array<Object>} nodes - Normalized body array (from StrategyTree)
   * @param {Object} ctx - Execution context built by executeStrategy
   * @param {{ topLevelStart: number }} opts - topLevelStart is the step index
   *     of the first top-level node in this call. For recursive FOREACH bodies,
   *     children don't re-number — they piggyback on the enclosing top-level
   *     index, then annotate iteration in their fragmentName.
   * @returns {Promise<{status: 'ok'|'failed'|'aborted', error?: string}>}
   * @private
   */
  static async #executeNodes(nodes, ctx, { topLevelStart = 0 } = {}) {
    for (let i = 0; i < nodes.length; i++) {
      if (ctx.isAborted()) return { status: 'aborted' };

      const node = nodes[i];
      if (!node) continue;

      // For top-level nodes, the step index is visible in progress events.
      // For nested (FOREACH body) nodes, the caller passes their parent's
      // topLevelStart so emits label the enclosing FOREACH's step number.
      const topLevelIndex = topLevelStart + i;

      let nodeResult;
      if (node.type === 'fragment') {
        nodeResult = await ExecutionEngine.#executeFragmentNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'foreach') {
        nodeResult = await ExecutionEngine.#executeForEachNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'wait') {
        nodeResult = await ExecutionEngine.#executeWaitNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'pause') {
        nodeResult = await ExecutionEngine.#executePauseNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'sieve') {
        nodeResult = await ExecutionEngine.#executeSieveNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'detect') {
        nodeResult = await ExecutionEngine.#executeDetectNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'loop') {
        nodeResult = await ExecutionEngine.#executeLoopNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'try') {
        nodeResult = await ExecutionEngine.#executeTryNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'navigate') {
        nodeResult = await ExecutionEngine.#executeNavigateNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'scroll') {
        nodeResult = await ExecutionEngine.#executeScrollNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'observation') {
        nodeResult = await ExecutionEngine.#executeObservationNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'in_new_tab') {
        nodeResult = await ExecutionEngine.#executeInNewTabNode(node, ctx, { topLevelIndex });
      } else {
        Logger.warn('ExecutionEngine', `Unknown node type "${node?.type}" — skipping`);
        continue;
      }

      if (nodeResult.status !== 'ok') return nodeResult;

      // v2.61.1 — emit a lightweight `node_complete` progress event after
      // each successful top-level node, carrying current scope + url. Lets
      // the debugger's Scope tab refresh during running, not just on pause.
      // Cheap: one shallow scope object per top-level node.
      let _completedUrl = null;
      try {
        const _t = await chrome.tabs.get(ctx.tabId);
        _completedUrl = _t?.url ?? null;
      } catch { /* tab gone */ }
      ctx.emit({
        type: 'node_complete',
        stepIdx: topLevelIndex,
        totalSteps: ctx.topLevelTotal,
        nodeType: node.type,
        nodeLabel: ExecutionEngine.#describeNodeForPause(node),
        scopeSnapshot: ctx.scope.asResultObject(),
        url: _completedUrl,
        message: `Step ${topLevelIndex + 1}/${ctx.topLevelTotal}: ${ExecutionEngine.#describeNodeForPause(node)} complete`,
      });

      // v2.38.0 (Pass K1) — top-level node yield point. Fires after each
      // top-level node completes successfully. Lets the side panel pause
      // between strategy steps for stepwise debugging.
      await ExecutionEngine.#yieldIfPaused(ctx, 'after-node', {
        nodeIdx: topLevelIndex,
        totalNodes: ctx.topLevelTotal,
        nodeType: node.type,
        nodeLabel: ExecutionEngine.#describeNodeForPause(node),
      });
    }
    return { status: 'ok' };
  }

  /** @private Cheap human-readable label for a node, used in pause-state events. */
  static #describeNodeForPause(node) {
    if (!node) return '?';
    if (node.type === 'fragment') return `Fragment ${node.fragmentId ?? ''}`.trim();
    if (node.type === 'foreach')  return `FOREACH ${node.over ?? ''} as ${node.as ?? ''}`.trim();
    if (node.type === 'wait')     return 'WAIT';
    if (node.type === 'pause')    return 'PAUSE';
    if (node.type === 'sieve')    return `SIEVE ${node.source ?? '?'} → ${node.output ?? '?'}`;
    if (node.type === 'detect')   return `DETECT (${node.branches?.length ?? 0} branch(es))`;
    if (node.type === 'loop')     return 'LOOP while …';
    if (node.type === 'try')      return 'TRY';
    if (node.type === 'navigate') return `NAVIGATE ${node.mode ?? '?'}`;
    if (node.type === 'scroll') {
      const d = node.distance;
      let dStr = '?';
      if (d?.kind === 'literal') dStr = d.value;
      else if (d?.kind === 'strategy_param') dStr = `{{${d.name}}}`;
      else if (d?.kind === 'iteration_variable') dStr = `{{${d.name}}}`;
      return `SCROLL by ${dStr} viewport(s)`;
    }
    if (node.type === 'observation') return `OBSERVATION ${node.observationId ?? '?'}`;
    if (node.type === 'in_new_tab') return 'IN_NEW_TAB';
    return node.type;
  }

  /**
   * Execute a single fragment node. Mirrors the E1 per-step logic: resolve
   * bindings, skip-check postconditions, invoke TemplateWalker.executeFragment,
   * check postconditions, record result.
   *
   * The `opts.iterationLabel` (when called from inside FOREACH) is appended
   * to emitted fragmentName and to the skipped/running log lines so the user
   * can see per-iteration progress in the chat bubble.
   *
   * @private
   */
  static async #executeFragmentNode(step, ctx, { topLevelIndex, iterationLabel = null, iteration = null } = {}) {
    const { tabId, scope, stepResults, emit, isAborted, invocationId, completedFragmentIds, topLevelTotal } = ctx;

    const fragment = await StorageManager.getFragment(step.fragmentId);
    if (!fragment) {
      const err = `Step ${topLevelIndex + 1}: Fragment ${step.fragmentId} not found`;
      stepResults.push({
        fragmentId: step.fragmentId,
        fragmentName: iterationLabel ? `? ${iterationLabel}` : '?',
        success: false, actionsRun: 0, error: err,
        ...(iteration ? { iteration } : {}),
      });
      return { status: 'failed', error: err };
    }

    // Name shown in progress + results — includes iteration marker when
    // nested inside a FOREACH (e.g. "apply-to-job (iteration 2/3)").
    const displayName = iterationLabel ? `${fragment.name} ${iterationLabel}` : fragment.name;

    // Resolve per-fragment bindings against the Strategy scope. In E2, scope
    // is a stack — `iteration_variable` bindings consult the top frames where
    // FOREACH iteration variables live.
    const fragmentParamValues = ExecutionEngine.#resolveFragmentBindings(step.paramBindings ?? {}, scope);

    // v2.29.8 — Log resolved binding values. Surfaces the most common
    // authoring bug: a Strategy-step binding saved with an empty name
    // produces an empty paramValues entry, template placeholders then
    // survive substitution, and runtime selectors contain literal `{{X}}`.
    // Logging here pinpoints the problem at the right layer.
    if (Object.keys(fragmentParamValues).length > 0 || Object.keys(step.paramBindings ?? {}).length > 0) {
      const summary = Object.entries(step.paramBindings ?? {})
        .map(([p, b]) => {
          const resolved = fragmentParamValues[p];
          if (resolved === undefined) return `${p}=UNRESOLVED(kind=${b?.kind},name="${b?.name ?? ''}")`;
          const short = String(resolved).length > 60 ? String(resolved).slice(0, 57) + '...' : String(resolved);
          return `${p}="${short}"`;
        })
        .join(', ');
      Logger.info('ExecutionEngine', `${displayName} — bindings: ${summary || '(none)'}`);
    }

    // v2.29.4 (Pass E2-5) — Skip-when-already-done is DISABLED inside
    // FOREACH bodies. Reasoning:
    //
    // Postconditions typically describe page-level state ("`.job-submitted`
    // visible"). Iteration 1 of a FOREACH body achieves that state; now
    // iteration 2's pre-check sees the state present → wrongly concludes
    // "already done" and skips the iteration. That silently drops work.
    //
    // Inside a FOREACH each iteration is semantically different (different
    // target item), so re-running is the right default. Users who want
    // idempotent skip behavior can still rely on the post-check catching
    // legitimate "nothing happened" failures after execution.
    //
    // The `iteration` param being non-null is the signal that we're inside
    // a FOREACH body. Top-level calls (iteration === null) keep the
    // original skip-check for their backward-compat benefit.
    const insideForeach = iteration !== null;
    if (!insideForeach && Array.isArray(fragment.postconditions) && fragment.postconditions.length > 0) {
      const preProbe = await TemplateWalker.checkConditions({ tabId, conditions: fragment.postconditions });
      if (preProbe.ok) {
        Logger.info('ExecutionEngine', `${displayName} — postconditions already hold; skipping`);
        stepResults.push({
          fragmentId: step.fragmentId, fragmentName: displayName,
          skipped: true, success: true, actionsRun: 0, error: null,
          skipReason: 'postconditions already satisfied',
        });
        emit({
          type: 'fragment_skipped', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
          fragmentId: step.fragmentId, fragmentName: displayName,
          message: `${displayName} — skipped (already done)`,
        });
        completedFragmentIds.add(step.fragmentId);
        return { status: 'ok' };
      }
    }

    emit({
      type: 'fragment_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      fragmentId: step.fragmentId, fragmentName: displayName,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: ${displayName}`,
    });

    // v2.72.69 — Universal pre-gate. Verifies engine-level invariants
    // that must hold for ANY fragment to run: document.readyState=complete,
    // body present with children, navigator.onLine. Distinct from the
    // per-fragment PreconditionGate below, which evaluates THIS
    // fragment's specific declared preconditions. Universal gates fire
    // at outer-fragment boundaries only — antecedent replays nested
    // inside this execution don't re-gate.
    const universalPre = await UniversalGate.evaluate({
      tabId, kind: 'pre', fragmentLabel: displayName,
    });
    if (!universalPre.ok) {
      stepResults.push({
        fragmentId: step.fragmentId, fragmentName: displayName,
        success: false, actionsRun: 0, error: universalPre.errorMessage,
        ...(iteration ? { iteration } : {}),
      });
      emit({
        type: 'fragment_failed', stepIdx: topLevelIndex,
        fragmentId: step.fragmentId, fragmentName: displayName,
        error: universalPre.errorMessage,
        scopeSnapshot: scope.asResultObject(),
        url: universalPre.url,
        lastActions: null,
        gateFailures: universalPre.failures,
        gateKind: 'pre',
      });
      return { status: 'failed', error: `${displayName} failed (pre-gate): ${universalPre.errorMessage}` };
    }

    // Precondition gate. The gate evaluates each declared precondition,
    // captures the failed-page diagnostics, and runs a classifier to label
    // the failure with a recovery-typed category (Cloudflare, CAPTCHA,
    // over-strict precondition, etc.). All of that lives in
    // Services/PreconditionGate.js so this method stays focused on
    // strategy-execution orchestration.
    //
    // The gate runs for FOREACH iterations too — if anything an iteration
    // is *more* likely than a top-level fragment to encounter an unexpected
    // page state, since the previous iteration may have left things in a
    // weird spot.
    const preOutcome = await PreconditionGate.evaluate({ tabId, fragment });
    if (!preOutcome.ok) {
      stepResults.push({
        fragmentId: step.fragmentId, fragmentName: displayName,
        success: false, actionsRun: 0, error: preOutcome.errorMessage,
        ...(iteration ? { iteration } : {}),
      });
      emit({
        type: 'fragment_failed', stepIdx: topLevelIndex,
        fragmentId: step.fragmentId, fragmentName: displayName,
        error: preOutcome.errorMessage,
        scopeSnapshot: scope.asResultObject(),
        url: preOutcome.url,
        lastActions: null,
        preconditionFailures: preOutcome.failures,
        preconditionsPassed: preOutcome.passed,
        classification: preOutcome.classification,
      });
      return { status: 'failed', error: `${displayName} failed: ${preOutcome.errorMessage}` };
    }

    const execResult = await TemplateWalker.executeFragment({
      tabId,
      fragmentId: step.fragmentId,
      paramBindings: fragmentParamValues,
      broadcastKey: invocationId,
      isAborted,
      completedFragmentIds,
      scope,
    });

    if (execResult.aborted) {
      stepResults.push({
        fragmentId: step.fragmentId, fragmentName: displayName,
        success: false, actionsRun: execResult.actionsRun ?? 0, error: 'Aborted',
        ...(iteration ? { iteration } : {}),
      });
      return { status: 'aborted' };
    }

    if (!execResult.success) {
      stepResults.push({
        fragmentId: step.fragmentId, fragmentName: displayName,
        success: false, actionsRun: execResult.actionsRun ?? 0, error: execResult.error,
        ...(iteration ? { iteration } : {}),
      });
      // v2.36.0 (J1) — Richer failure event: scope snapshot + URL at
      // failure time. The scope snapshot tells the user what bindings
      // were populated when things broke (e.g. "TITLE was captured but
      // SALARY wasn't — failure is in the second EXTRACT"). The URL
      // tells them where the tab actually is, which is the #1 surprise
      // source in foreach-over-cards patterns.
      let failureUrl = null;
      try {
        const tabInfo = await chrome.tabs.get(tabId);
        failureUrl = tabInfo?.url ?? null;
      } catch { /* tab closed */ }
      emit({
        type: 'fragment_failed', stepIdx: topLevelIndex,
        fragmentId: step.fragmentId, fragmentName: displayName, error: execResult.error,
        scopeSnapshot: scope.asResultObject(),
        url: failureUrl,
        lastActions: execResult.lastActions ?? null,
      });
      // v2.36.0 (J1) — Augment the error string shown in the log + returned
      // to the caller. Before: "Open job detail failed: In ..., step CLICK
      // ... failed". After: adds "[url=<current URL>]" and if there were
      // successful actions before the failure, "[after: CLICK a, TYPE b]".
      // Gives the author immediate context without needing to open events.
      const urlTag = failureUrl ? ` [url=${new URL(failureUrl).pathname}]` : '';
      const actionTag = Array.isArray(execResult.lastActions) && execResult.lastActions.length > 0
        ? ` [after ${execResult.lastActions.length} step(s): ${execResult.lastActions.map(a => a.action + (a.target ? ` ${a.target}` : '')).join(' → ')}]`
        : '';
      return { status: 'failed', error: `${displayName} failed: ${execResult.error}${urlTag}${actionTag}` };
    }

    // v2.72.69 — Universal post-gate. After successful action execution,
    // verify the page is still in a runnable state (readyState=complete,
    // body present, online). The fragment-specific postconditions check
    // below handles THIS fragment's contractual end-state predicates;
    // this gate handles the universal "page is still alive and ready
    // for the next fragment" invariants.
    const universalPost = await UniversalGate.evaluate({
      tabId, kind: 'post', fragmentLabel: displayName,
    });
    if (!universalPost.ok) {
      stepResults.push({
        fragmentId: step.fragmentId, fragmentName: displayName,
        success: false, actionsRun: execResult.actionsRun ?? 0,
        error: universalPost.errorMessage,
        ...(iteration ? { iteration } : {}),
      });
      emit({
        type: 'fragment_post_failed', stepIdx: topLevelIndex,
        fragmentId: step.fragmentId, fragmentName: displayName,
        error: universalPost.errorMessage,
        scopeSnapshot: scope.asResultObject(),
        url: universalPost.url,
        gateFailures: universalPost.failures,
        gateKind: 'post',
      });
      return { status: 'failed', error: `${displayName} ran but post-gate failed: ${universalPost.errorMessage}` };
    }

    // Probe postconditions AFTER execution.
    //
    // v2.29.12 (Pass F4) — Poll with a timeout rather than checking once.
    // SPA frameworks (React, Vue, etc.) often complete a CLICK's internal
    // event but then finish URL/state/aria updates asynchronously. Polling
    // for up to 5s lets the postconditions stabilize before we score the
    // iteration as failed. Passes immediately when conditions already hold,
    // only waits as long as needed.
    let postFailures = [];
    if (Array.isArray(fragment.postconditions) && fragment.postconditions.length > 0) {
      const probe = await TemplateWalker.checkConditions({
        tabId, conditions: fragment.postconditions,
        timeoutMs: 5000, pollIntervalMs: 100,
      });
      postFailures = probe.failures;
      if (!probe.ok) {
        const reasonSummary = probe.failures.map(f => ExecutionEngine.#formatConditionFailure(f)).join('; ');
        Logger.info('ExecutionEngine',
          `${displayName} — postconditions failed after ${probe.elapsedMs}ms, ${probe.attempts} attempt(s): ${reasonSummary}`);
        stepResults.push({
          fragmentId: step.fragmentId, fragmentName: displayName,
          success: false, actionsRun: execResult.actionsRun,
          error: `Postconditions failed: ${reasonSummary}`,
          postFailures,
          ...(iteration ? { iteration } : {}),
        });
        // v2.36.0 (J1) — Richer fragment_post_failed event. Scope +
        // URL snapshots help the author see "the clicks ran but the
        // page didn't end up where we expected" with concrete evidence.
        let failureUrl = null;
        try {
          const tabInfo = await chrome.tabs.get(tabId);
          failureUrl = tabInfo?.url ?? null;
        } catch { /* tab closed */ }
        emit({
          type: 'fragment_post_failed', stepIdx: topLevelIndex,
          fragmentId: step.fragmentId, fragmentName: displayName, failures: probe.failures,
          scopeSnapshot: scope.asResultObject(),
          url: failureUrl,
        });
        return { status: 'failed', error: `${displayName} ran but postconditions failed: ${reasonSummary}` };
      }
      if (probe.attempts > 1) {
        Logger.info('ExecutionEngine',
          `${displayName} — postconditions passed after ${probe.elapsedMs}ms (${probe.attempts} attempts)`);
      }
    }

    stepResults.push({
      fragmentId: step.fragmentId, fragmentName: displayName,
      success: true, actionsRun: execResult.actionsRun, error: null,
      postFailures,
      ...(iteration ? { iteration } : {}),
    });
    emit({
      type: 'fragment_complete', stepIdx: topLevelIndex,
      fragmentId: step.fragmentId, fragmentName: displayName, actionsRun: execResult.actionsRun,
    });
    completedFragmentIds.add(step.fragmentId);
    return { status: 'ok' };
  }

  /**
   * Execute a FOREACH node. Reads the list binding from scope, iterates once
   * per item, pushing a scope frame per iteration with the iteration variable
   * bound to the item. Body executes recursively via #executeNodes.
   *
   * Failure semantics: first iteration failure short-circuits the whole
   * FOREACH and aborts the Strategy. ("Continue on error" is a possible
   * future opt-in but not in E2-3 — matches existing top-level short-circuit.)
   *
   * Memoization set: snapshotted before entry; each iteration starts from the
   * snapshot (so iteration 2 re-runs body fragments that iteration 1 completed).
   * Antecedent-replay memoization from OUTSIDE the FOREACH still applies
   * (common ancestor of all iterations isn't replayed per-iteration).
   * After all iterations: restored to snapshot (per-iteration completions
   * don't leak to later sibling steps outside the FOREACH).
   *
   * @private
   */
  static async #executeForEachNode(node, ctx, { topLevelIndex }) {
    const { scope, emit, isAborted, completedFragmentIds, topLevelTotal } = ctx;

    // Validate the node shape (already done at save time, defensive here)
    if (!node.over) {
      return { status: 'failed', error: `Step ${topLevelIndex + 1}: FOREACH missing "over" binding name` };
    }
    if (!node.as) {
      return { status: 'failed', error: `Step ${topLevelIndex + 1}: FOREACH missing "as" iteration variable name` };
    }

    // Read the source list from scope
    const source = scope.get(node.over);
    if (source === undefined) {
      return {
        status: 'failed',
        error: `Step ${topLevelIndex + 1}: FOREACH "over" binding "${node.over}" is not in scope. ` +
               `Ensure an earlier step ran an ENUMERATE that writes to "${node.over}".`,
      };
    }
    if (source?.kind !== 'list') {
      return {
        status: 'failed',
        error: `Step ${topLevelIndex + 1}: FOREACH "over" binding "${node.over}" is not a list (got kind="${source?.kind ?? typeof source}").`,
      };
    }

    const items = Array.isArray(source.items) ? source.items : [];
    Logger.info('ExecutionEngine',
      `FOREACH over ${node.over} as ${node.as} — ${items.length} iteration(s)`);

    emit({
      type: 'foreach_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      over: node.over, as: node.as, iterationCount: items.length,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: iterating ${items.length} × ${node.over}`,
    });

    // Empty list is a success, not a failure. Zero iterations is fine.
    if (items.length === 0) {
      emit({
        type: 'foreach_complete', stepIdx: topLevelIndex,
        over: node.over, iterationsRun: 0,
        message: `${node.over} was empty — 0 iterations`,
      });
      return { status: 'ok' };
    }

    // Snapshot the memoization set. See doc comment above.
    const memoBefore = new Set(completedFragmentIds);

    for (let i = 0; i < items.length; i++) {
      if (isAborted()) return { status: 'aborted' };

      // Each iteration: fresh memo set derived from pre-FOREACH snapshot.
      // Clear and repopulate in-place so ctx.completedFragmentIds (passed by
      // reference to nested walks) refers to the right set.
      completedFragmentIds.clear();
      for (const id of memoBefore) completedFragmentIds.add(id);

      // Push iteration frame + bind iteration variable
      scope.pushFrame();
      scope.bindIteration(node.as, items[i]);

      emit({
        type: 'foreach_iteration_start', stepIdx: topLevelIndex,
        over: node.over, as: node.as, iteration: i + 1, iterationCount: items.length,
        message: `  ↳ iteration ${i + 1}/${items.length}`,
      });

      const iterationLabel = `(iteration ${i + 1}/${items.length})`;
      // v2.29.4 (Pass E2-5) — Structural iteration tag. Attached to each
      // stepResults entry emitted from within this iteration. Chat renderer
      // uses this to group iteration rows under a FOREACH summary row.
      const iteration = {
        index: i + 1,
        count: items.length,
        variable: node.as,
        over: node.over,
        topLevelIndex,        // so renderer can tell which FOREACH a row belongs to
      };

      // Execute body. Important: nested fragment nodes inherit our
      // topLevelIndex (they ARE this FOREACH's step in the top-level list,
      // their display gets the iteration label via opts.iterationLabel).
      let bodyResult;
      try {
        bodyResult = await ExecutionEngine.#executeBodyWithIterationLabel(
          node.body ?? [], ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } finally {
        scope.popFrame();
      }

      if (bodyResult.status === 'aborted') {
        // Restore memo set so the outer execution sees pre-FOREACH state
        completedFragmentIds.clear();
        for (const id of memoBefore) completedFragmentIds.add(id);
        return { status: 'aborted' };
      }
      if (bodyResult.status === 'failed') {
        completedFragmentIds.clear();
        for (const id of memoBefore) completedFragmentIds.add(id);
        emit({
          type: 'foreach_failed', stepIdx: topLevelIndex,
          over: node.over, iteration: i + 1, error: bodyResult.error,
          message: `Iteration ${i + 1}/${items.length} failed: ${bodyResult.error}`,
        });
        return { status: 'failed', error: `FOREACH ${node.over}[${i + 1}] failed: ${bodyResult.error}` };
      }
    }

    // Restore memo set post-FOREACH so later sibling steps don't see
    // per-iteration completions.
    completedFragmentIds.clear();
    for (const id of memoBefore) completedFragmentIds.add(id);

    emit({
      type: 'foreach_complete', stepIdx: topLevelIndex,
      over: node.over, iterationsRun: items.length,
      message: `${node.over}: ${items.length} iteration(s) completed`,
    });

    return { status: 'ok' };
  }

  /**
   * G1 (v2.29.14) — Execute a WAIT node.
   *
   * Two modes:
   *   - duration: sleep for `durationMs` milliseconds, then continue.
   *     Always succeeds (short of an abort).
   *   - condition: poll a condition every `pollIntervalMs` until it holds
   *     or `timeoutMs` elapses. Fails the Strategy on timeout — the caller
   *     can read the reason from the returned status/error.
   *
   * WAIT nodes don't participate in param bindings or scope. They're pure
   * timing adapters between steps.
   *
   * @private
   */
  static async #executeWaitNode(node, ctx, { topLevelIndex, iterationLabel = null }) {
    const { tabId, scope, isAborted, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    if (node.mode === 'duration') {
      const ms = Number(node.durationMs) || 0;
      Logger.info('ExecutionEngine', `WAIT${label} — sleeping ${ms}ms`);
      emit({
        type: 'wait_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
        mode: 'duration', durationMs: ms,
        message: `Step ${topLevelIndex + 1}/${topLevelTotal}: WAIT ${ms}ms`,
      });
      // Abort-aware sleep — check every 100ms (or less if the duration is shorter).
      const slice = Math.min(100, ms);
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (isAborted()) return { status: 'aborted' };
        await new Promise(r => setTimeout(r, Math.min(slice, deadline - Date.now())));
      }
      emit({
        type: 'wait_complete', stepIdx: topLevelIndex,
        mode: 'duration', elapsedMs: ms,
      });
      return { status: 'ok' };
    }

    if (node.mode === 'condition') {
      // v2.41.0 — node.condition is now a Assertion. cond.type doesn't exist;
      // describe via condition count and match mode instead.
      const cond = node.condition ?? { match: 'all', conditions: [] };
      const timeoutMs = Number(node.timeoutMs) || 5000;
      const pollIntervalMs = Number(node.pollIntervalMs) || 100;
      const condDesc = cond.conditions?.length === 1
        ? cond.conditions[0].type
        : `${cond.conditions?.length ?? 0} conditions ${cond.match === 'any' ? 'OR' : 'AND'}`;
      Logger.info('ExecutionEngine',
        `WAIT${label} — assertion (${condDesc}) timeout=${timeoutMs}ms poll=${pollIntervalMs}ms`);
      emit({
        type: 'wait_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
        mode: 'condition', condition: cond, timeoutMs,
        message: `Step ${topLevelIndex + 1}/${topLevelTotal}: WAIT until ${condDesc}`,
      });
      const probe = await TemplateWalker.checkConditions({
        tabId, conditions: cond, scope, timeoutMs, pollIntervalMs,
      });
      if (!probe.ok) {
        const reason = probe.failures[0]?.reason ?? 'condition not met';
        Logger.info('ExecutionEngine',
          `WAIT${label} — assertion (${condDesc}) failed after ${probe.elapsedMs}ms, ${probe.attempts} attempt(s)`);
        return {
          status: 'failed',
          error: `Step ${topLevelIndex + 1}: WAIT condition (${condDesc}) not met within ${timeoutMs}ms — ${reason}`,
        };
      }
      Logger.info('ExecutionEngine',
        `WAIT${label} — assertion (${condDesc}) met after ${probe.elapsedMs}ms, ${probe.attempts} attempt(s)`);
      emit({
        type: 'wait_complete', stepIdx: topLevelIndex,
        mode: 'condition', elapsedMs: probe.elapsedMs, attempts: probe.attempts,
      });
      return { status: 'ok' };
    }

    return {
      status: 'failed',
      error: `Step ${topLevelIndex + 1}: WAIT has unknown mode "${node.mode}"`,
    };
  }

  /**
   * v2.60.0 — Execute a PAUSE node. Halts strategy execution at this point
   * until the user clicks Resume in the debugger. Distinct from WAIT —
   * WAIT eventually completes (timeout or condition met); PAUSE waits
   * indefinitely for explicit user action.
   *
   * Requires the invocation to be in debug mode. Non-debug invocations
   * (e.g. chat invocations without debug opt-in) fail loudly when execution
   * reaches a PAUSE — the strategy author opted in to "needs human
   * intervention" by including this node, and silently auto-resuming would
   * mask their intent.
   *
   * Implementation: requests the debug controller to enter paused state via
   * `ctx.debug.requestPause()`, emits the same `paused` event the existing
   * yield-point uses (so the side panel UI updates identically), then polls
   * `ctx.debug.isPaused()` until the user clicks Resume (which sets
   * `debugPaused = false` through the existing CapabilityAPI.debugResume
   * channel). Honors abort during the poll.
   *
   * @private
   */
  static async #executePauseNode(node, ctx, { topLevelIndex, iterationLabel = null }) {
    const { isAborted, emit, topLevelTotal, tabId, scope } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    if (!ctx.debug || ctx.debug.pauseMode === 'off' || typeof ctx.debug.requestPause !== 'function') {
      const errMsg = `Step ${topLevelIndex + 1}: PAUSE node requires debug mode. ` +
                     `Invoke this strategy from the Studio test panel or with debug enabled.`;
      Logger.error('ExecutionEngine', `PAUSE${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    Logger.info('ExecutionEngine', `PAUSE${label} — entering pause`);
    emit({
      type: 'pause_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: PAUSE — waiting for Resume`,
    });

    // Flip the invocation's pause flag so isPaused() returns true.
    ctx.debug.requestPause();

    // Build the same pause-state snapshot #yieldIfPaused emits, so the
    // side panel renders identically to a user-initiated pause.
    let url = null;
    try {
      const tabInfo = await chrome.tabs.get(tabId);
      url = tabInfo?.url ?? null;
    } catch { /* tab gone */ }
    const stateOnEnter = {
      paused: true,
      granularity: 'pause-node',
      nodeIdx: topLevelIndex,
      totalNodes: topLevelTotal,
      nodeType: 'pause',
      nodeLabel: 'PAUSE',
      iterationLabel,
      scopeSnapshot: scope.asResultObject(),
      url,
      tabId,
    };
    try { ctx.debug.onPauseStateChange(stateOnEnter); } catch (_) { /* swallow */ }
    emit({ type: 'paused', ...stateOnEnter });

    // Poll until Resume (debugPaused → false) or abort.
    while (ctx.debug.isPaused()) {
      if (isAborted()) {
        Logger.info('ExecutionEngine', `PAUSE${label} — aborted while paused`);
        return { status: 'aborted' };
      }
      await new Promise(r => setTimeout(r, 100));
    }

    const stateOnExit = { paused: false, granularity: 'pause-node' };
    try { ctx.debug.onPauseStateChange(stateOnExit); } catch (_) { /* swallow */ }
    emit({ type: 'resumed' });
    emit({
      type: 'pause_complete', stepIdx: topLevelIndex,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: PAUSE — resumed`,
    });
    Logger.info('ExecutionEngine', `PAUSE${label} — resumed`);
    return { status: 'ok' };
  }

  /**
   * v2.61.0 — Execute a SIEVE node.
   *
   * Reads `node.source` from scope (must be `kind: 'list'`), applies each
   * operation in `node.operations` in order, writes the resulting list to
   * scope under `node.output`. Items keep their identity across operations
   * (filter only removes; sort only reorders; take only truncates), so
   * downstream FOREACH iterates with the same iteration-variable semantics
   * the source ENUMERATE established.
   *
   * Failure modes:
   *  - source binding doesn't exist or isn't a list → fail loudly
   *  - sort key references a field that no record has → that record sorts
   *    last (NaN/null sort-after semantics)
   *  - empty result is not a failure — downstream FOREACH iterates zero times
   *
   * @private
   */
  static async #executeSieveNode(node, ctx, { topLevelIndex, iterationLabel = null }) {
    const { scope, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    const sourceName = node.source ?? '';
    const outputName = node.output ?? '';

    // v2.74.138 — `node.output` validation moved BELOW the body-kind
    // dispatch. Pre-fix, the check rejected transform-body sieves
    // before dispatch could route them to #executeSieveTransform — but
    // transform-body wiring uses declared output NAMES (set on the
    // Analysis body) rather than `node.output`, so the field is
    // intentionally empty. Template body still uses `node.output` for
    // its document destination, so the dispatch passes outputName
    // through and #executeSieveTemplate validates it on its own path.
    // Operations / frontier paths re-check outputName after the
    // dispatch falls through (below).

    // v2.72.17 (Pass 7b) — Resolve Analysis up front so we can detect the
    // body kind. Template-kind bodies don't consume a source list (multi-
    // input fan-in from declared inputs); they have a separate execution
    // path. Operations-kind bodies (the existing path) require a source
    // list and reduce it.
    let analysis = null;
    if (node.analysisId) {
      analysis = await ExecutionEngine.#resolveAnalysis(node.analysisId);
      if (!analysis) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE references Analysis "${node.analysisId}" which does not exist`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }
    }

    // Detect template-kind body and delegate. This branch runs before any
    // source-list validation because templates don't consume a source list.
    // v2.74.132 — `transform` body kind dispatches alongside template here.
    // Same rationale: transform bodies consume declared named inputs from
    // scope and produce declared named outputs; there's no implicit
    // single-source list to validate against.
    if (analysis) {
      const impl0 = Array.isArray(analysis.implementations) && analysis.implementations.length > 0
        ? analysis.implementations[0] : null;
      if (impl0?.body?.kind === 'template') {
        // Template body still requires node.output (the document
        // destination). Re-check here, gated on the body kind, so the
        // error message is body-specific instead of the generic one.
        if (!outputName) {
          const errMsg = `Step ${topLevelIndex + 1}: SIEVE (template body) requires an output binding name`;
          Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
          return { status: 'failed', error: errMsg };
        }
        return await ExecutionEngine.#executeSieveTemplate(
          node, ctx, analysis, impl0, { topLevelIndex, iterationLabel, label, outputName }
        );
      }
      if (impl0?.body?.kind === 'transform') {
        // Transform body wires by declared name — `node.output` is
        // unused at this layer. The handler reads declared inputs from
        // scope and writes declared outputs back; no check on
        // outputName needed here.
        return await ExecutionEngine.#executeSieveTransform(
          node, ctx, analysis, impl0, { topLevelIndex, iterationLabel, label }
        );
      }
    }

    // ── Operations/frontier path: source binding semantics ──
    //
    // v2.72.22 (Pass: frontier compose) — Source binding is OPTIONAL for
    // frontier Analyses when the pre conditions reference scope bindings
    // by name. In that case the engine fans those bindings in to the
    // model (compose pattern). Operations bodies still require source
    // (the reducer needs a list). The compose detection happens here
    // because we need analysis + impl info to know if this case applies.
    const tierForCheck = (() => {
      if (!analysis) return null;
      const i0 = Array.isArray(analysis.implementations) && analysis.implementations.length > 0
        ? analysis.implementations[0] : null;
      return i0?.tier ?? 'cache';
    })();
    const preCondsForCheck = analysis?.preconditions?.conditions
      ?? (Array.isArray(analysis?.preconditions) ? analysis.preconditions : []);
    const preBindingNames = preCondsForCheck
      .map(c => (c && typeof c === 'object' && typeof c.binding === 'string') ? c.binding : null)
      .filter(b => b && b !== 'INPUT');  // INPUT is the synth-scope sentinel; not a real binding
    const isComposeMode = tierForCheck === 'frontier' && !sourceName && preBindingNames.length > 0;

    if (!sourceName && !isComposeMode) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE requires a source binding name (or use a template-kind Analysis, or a frontier Analysis with pre conditions referencing scope bindings)`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    // v2.74.138 — Output binding required for the fall-through paths
    // (operations / frontier-single / frontier-compose). Transform and
    // template handlers above have already returned with their own
    // body-specific validations.
    if (!outputName) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE requires an output binding name`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    // Source value lookup. In compose mode (no sourceName), there's no
    // single source; bindings come from pre conditions. We still set
    // sourceValue to null in that case so downstream code can branch.
    const sourceValue = sourceName ? scope.get(sourceName) : null;
    if (sourceName && sourceValue == null) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE source "${sourceName}" is unbound`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    // v2.72.22 (Pass: frontier compose) — Branch to compose helper. Keeps
    // the existing single-source frontier and cache paths free of
    // multi-input branching. The helper handles bindings collection,
    // payload construction, API invocation, document wrapping if
    // post conditions assert it, and pre/post evaluation against
    // appropriate scopes (real scope for pre, synth-OUTPUT for post —
    // matching template body's evaluation semantics).
    if (isComposeMode) {
      const impl0 = Array.isArray(analysis.implementations) && analysis.implementations.length > 0
        ? analysis.implementations[0] : null;
      return await ExecutionEngine.#executeSieveFrontierCompose(
        node, ctx, analysis, impl0,
        { topLevelIndex, iterationLabel, label, outputName, preBindingNames }
      );
    }

    // v2.63.0 (Iteration B) — resolve operations. Three sources, in priority:
    //   1. node.analysisId — load Analysis (built-in or user), substitute
    //      paramBindings into operation values, run those.
    //   2. node.operations — legacy inline shape; run as-is. Strategies saved
    //      before Iteration B still have this; load-time migration converts
    //      them to analysisId form on next save, but until then we honor it.
    //   3. Neither — fail loudly.
    //
    // v2.64.0 (Pass 1) — when an Analysis is referenced, evaluate its pre/post
    // conditions around the operations execution. Pre runs against a synthetic
    // scope where INPUT = the source list; post runs with INPUT and OUTPUT
    // both bound. Param bindings are substituted into pre/post conditions
    // (e.g. `{{COUNT}}` in a length_max condition) the same way they're
    // substituted into operations. Inline-operations sieves (legacy) skip
    // pre/post entirely — they have no Analysis to source them from.
    let operations;
    let bindings = {};
    let tier = 'cache';  // default for inline-operations sieves and safety fallback
    if (node.analysisId) {
      bindings = ExecutionEngine.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
      // v2.66.0 (Pass 3a) — operations come from the first implementation.
      // Storage migration in StorageManager ensures every loaded Analysis
      // has an `implementations` array. Defensive fallback to legacy
      // top-level `operations` covers paths that bypass the migration
      // (built-ins are already in new shape; user Analyses migrate on
      // read; this fallback is for safety only).
      // v2.68.0 (Pass 3c) — read tier from implementations[0]. cache tier
      // runs operations as before; frontier tier runs frontier-primary
      // (no operations to substitute). Default to cache for safety if
      // tier is missing.
      // v2.72.16 (Pass 7a) — operations now live under impl.body.operations
      // (body envelope). Defensive multi-level fallback covers legacy paths.
      const impl = Array.isArray(analysis.implementations) && analysis.implementations.length > 0
        ? analysis.implementations[0]
        : null;
      tier = impl?.tier ?? 'cache';
      if (tier === 'cache') {
        // Body envelope: prefer impl.body.operations; fall back to legacy
        // impl.operations (pre-7a records that bypassed migration); fall
        // back to analysis.operations (pre-3a records that bypassed
        // implementations migration). Pass 7b adds template body kind here.
        const body = impl?.body;
        if (body && typeof body === 'object') {
          if (body.kind === 'operations') {
            const rawOps = Array.isArray(body.operations) ? body.operations : [];
            operations = ExecutionEngine.#substituteAnalysisParams(rawOps, bindings);
          } else {
            const errMsg = `Step ${topLevelIndex + 1}: SIEVE references Analysis "${node.analysisId}" with unsupported body kind "${body.kind}"`;
            Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
            return { status: 'failed', error: errMsg };
          }
        } else {
          // Legacy fallback path — impl with operations directly, or no impl.
          const rawOps = impl?.operations ?? analysis.operations ?? [];
          operations = ExecutionEngine.#substituteAnalysisParams(rawOps, bindings);
        }
      } else if (tier === 'frontier') {
        // No operations for frontier-primary; the body IS the model
        // invocation. Skip operations resolution.
        operations = [];
      } else {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE references Analysis "${node.analysisId}" with unknown tier "${tier}"`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }
    } else if (Array.isArray(node.operations)) {
      operations = node.operations;
    } else {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE has no analysisId and no inline operations`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    // v2.64.0 — Preconditions. Build a synthetic scope where INPUT maps to
    // the source list; param bindings are substituted into the conditions
    // before evaluation. Failure fails the strategy step with a descriptive
    // error naming the violated condition.
    // v2.70.0 — Pre/post are now assertion envelopes ({match, conditions}).
    // Storage migration in StorageManager.#migrateAnalysisShape ensures
    // every loaded Analysis has envelope-shaped pre/post; defensive fallback
    // here for paths that bypass migration.
    const preEnvelope = analysis?.preconditions;
    const preConditionsRaw = (preEnvelope && Array.isArray(preEnvelope.conditions))
      ? preEnvelope.conditions
      : (Array.isArray(preEnvelope) ? preEnvelope : []);
    if (analysis && preConditionsRaw.length > 0) {
      const preScope = new Scope();
      preScope.set('INPUT', sourceValue);
      const preConds = ExecutionEngine.#substituteAnalysisParams(preConditionsRaw, bindings);
      const preEnvelopeForEval = {
        match: preEnvelope?.match ?? 'all',
        conditions: preConds,
        ...(typeof preEnvelope?.count === 'number' ? { count: preEnvelope.count } : {}),
      };
      // v2.70.3 — Resolve any assertion_ref entries in pre against library
      // assertions on this Ground. Cycles / depth violations surface as
      // precondition failures with descriptive errors.
      let preEnvelopeFlat;
      try {
        preEnvelopeFlat = await flattenScopeAssertionRefs(
          preEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE precondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_precondition_failed', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          reason: err.message,
          message: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      const preResult = evaluateDataAssertionEnvelope(preEnvelopeFlat, preScope);
      if (!preResult.ok) {
        const f = preResult.failures[0];
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE precondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_precondition_failed', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          condition: f.cond,
          reason: f.reason,
          message: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    let items = Array.isArray(sourceValue.items) ? [...sourceValue.items] : [];
    const startCount = items.length;
    let outputValue = null;
    let outputSet = false;  // tracks whether outputValue has been set by the tier-specific path

    // v2.68.0 (Pass 3c) — Frontier-primary execution. When the Analysis's
    // primary tier is 'frontier', the body is a model invocation rather
    // than a rule-based operations run. Skip the operations loop; invoke
    // the frontier model with the description, contract, and input;
    // wrap the result; let the existing post-check evaluate it.
    //
    // Output shaping: model returns any JSON via the open tool schema.
    // Array outputs become list values; non-array outputs become scalar
    // values (with stringification). The contract catches shape mismatches
    // via the existing data-assertion vocabulary (binding_is_list, etc.).
    if (analysis && tier === 'frontier') {
      // Build per-call signal descriptions from the Analysis's artifacts.
      // v2.70.0 — Pre/post are envelopes; extract conditions array.
      // v2.70.4 — Flatten assertion_refs before describing. The contract
      // description is what the frontier model sees as the spec of what
      // to produce; assertion_ref is meaningless to the model and
      // describeDataCondition would render it as "invalid condition",
      // leaving the model with no contract guidance.
      const preCondsRaw = analysis.preconditions?.conditions ?? (Array.isArray(analysis.preconditions) ? analysis.preconditions : []);
      const postCondsRaw = analysis.postconditions?.conditions ?? (Array.isArray(analysis.postconditions) ? analysis.postconditions : []);

      let preCondsForDesc, postCondsForDesc;
      try {
        const preFlat = await flattenScopeAssertionRefs(
          {
            match: analysis.preconditions?.match ?? 'all',
            conditions: preCondsRaw,
            ...(typeof analysis.preconditions?.count === 'number' ? { count: analysis.preconditions.count } : {}),
          },
          (id) => StorageManager.getAssertion(id)
        );
        const postFlat = await flattenScopeAssertionRefs(
          {
            match: analysis.postconditions?.match ?? 'all',
            conditions: postCondsRaw,
            ...(typeof analysis.postconditions?.count === 'number' ? { count: analysis.postconditions.count } : {}),
          },
          (id) => StorageManager.getAssertion(id)
        );
        preCondsForDesc  = preFlat.conditions;
        postCondsForDesc = postFlat.conditions;
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE frontier-primary contract resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_frontier_primary_failed', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          frontierError: err.message,
          message: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }

      const preDesc = describePreconditions(
        ExecutionEngine.#substituteAnalysisParams(preCondsForDesc, bindings)
      );
      const postDesc = describeContract(
        ExecutionEngine.#substituteAnalysisParams(postCondsForDesc, bindings)
      );

      // v2.72.21 (Pass 11) — Source-kind aware input building. Frontier
      // Analyses can take any source kind, not just lists. The contract
      // (preconditions like binding_is_image) carries the kind requirement;
      // here we just shape the input according to what's actually bound.
      //
      //   list     → items array (existing path)
      //   image    → multimodal content (image bytes + text instruction)
      //   section  → markdown text
      //   document → content text
      //   record   → fields object
      //   scalar   → value string
      //   element  → selector string
      //
      // For image kind, imageInput parameter carries the base64+mime; the
      // text spec describes intent without inlining the image. For all
      // other kinds, inputValue is the unwrapped data and inputForPrompt
      // serializes it as JSON in the text spec.
      let inputValueForApi = null;
      let imageInputForApi = null;
      const sk = sourceValue?.kind;
      if (sk === 'list') {
        inputValueForApi = Array.isArray(sourceValue.items) ? sourceValue.items : [];
      } else if (sk === 'image') {
        if (!sourceValue.base64) {
          const errMsg = `Step ${topLevelIndex + 1}: SIEVE source "${sourceName}" is an image with no base64 data`;
          Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
          emit({
            type: 'sieve_frontier_primary_failed', stepIdx: topLevelIndex,
            analysisId: node.analysisId,
            frontierError: 'image binding has empty base64',
            message: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }
        imageInputForApi = {
          base64: sourceValue.base64,
          mime: sourceValue.mime || 'image/png',
          label: sourceValue.label || '',
        };
        inputValueForApi = null;  // image carries the input; text spec doesn't repeat it
      } else if (sk === 'section') {
        inputValueForApi = sourceValue.markdown ?? sourceValue.text ?? '';
      } else if (sk === 'document') {
        inputValueForApi = sourceValue.content ?? '';
      } else if (sk === 'record') {
        inputValueForApi = sourceValue.fields ?? {};
      } else if (sk === 'scalar') {
        inputValueForApi = sourceValue.value ?? '';
      } else if (sk === 'element') {
        inputValueForApi = sourceValue.selector ?? '';
      } else {
        // Defensive fallback — pass the whole tagged value through as JSON.
        // The model will see it but pre conditions should catch this.
        inputValueForApi = sourceValue;
      }

      Logger.info('ExecutionEngine',
        `SIEVE${label} — Analysis tier is 'frontier'; source kind=${sk ?? '?'}; invoking frontier-primary execution`);
      emit({
        type: 'sieve_frontier_primary_attempting', stepIdx: topLevelIndex,
        analysisId: node.analysisId,
        sourceKind: sk,
        message: `Step ${topLevelIndex + 1}: invoking frontier model (primary tier)`,
      });

      const result = await AnthropicService.invokeAnalysisFrontierPrimary({
        analysisName: analysis.name ?? node.analysisId,
        analysisDescription: analysis.description ?? '',
        preconditionsDescription: preDesc,
        postconditionsDescription: postDesc,
        params: bindings,
        inputValue: inputValueForApi,
        imageInput: imageInputForApi,
      });

      if (!result.success) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE frontier-primary failed — ${result.error}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_frontier_primary_failed', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          frontierError: result.error,
          confidence: result.confidence,
          rationale: result.rationale,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          message: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }

      // v2.69.0 — Kind-aware wrapping. Replaces the v2.68.0 stringify-as-
      // scalar fallback that lost field structure. Now:
      //   array              → list(items)
      //   plain object       → record(obj)
      //   string/num/bool    → scalar with subtype
      //   null/undefined     → fail (unbindable)
      // The contract validates the resulting shape via the data-assertion
      // vocabulary (binding_is_record, binding_is_list, scalar_is_number,
      // etc.). Engine doesn't second-guess shape; contract is the spec.
      const out = result.output;
      if (Array.isArray(out)) {
        items = out;
        outputValue = list(items);
      } else if (out !== null && typeof out === 'object') {
        outputValue = record(out);
        items = [];
      } else if (typeof out === 'string') {
        outputValue = scalar(out, 'string');
        items = [];
      } else if (typeof out === 'number') {
        outputValue = scalar(String(out), 'number');
        items = [];
      } else if (typeof out === 'boolean') {
        outputValue = scalar(String(out), 'boolean');
        items = [];
      } else {
        // null / undefined / something exotic — refuse to bind and fail
        // the strategy step immediately. The model returning null/undefined
        // for an Analysis output is itself a contract violation; we don't
        // bind a missing value to scope and then check the contract,
        // because there's no shape to check. Hard fail with a descriptive
        // error.
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE frontier-primary returned ${out === null ? 'null' : typeof out}, which cannot be bound to scope`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_frontier_primary_failed', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          frontierError: errMsg,
          confidence: result.confidence,
          rationale: result.rationale,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          latencyMs: result.latencyMs,
          message: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      outputSet = true;

      // Compose a human-readable description for the log line.
      const shapeDesc = Array.isArray(out)
        ? `${out.length} items (list)`
        : (out !== null && typeof out === 'object' ? 'record' : `scalar (${typeof out})`);
      Logger.info('ExecutionEngine',
        `SIEVE${label} — frontier-primary returned ${shapeDesc}, confidence=${result.confidence ?? 'null'}`);
    }

    if (!outputSet) {
      // Cache-tier path: run operations. v2.72.21 (Pass 11) — operations
      // require a list source; check here (not at SIEVE entry) because
      // frontier-tier paths accept any source kind and would otherwise
      // be blocked by an entry-level list-check.
      if (sourceValue.kind !== 'list') {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE source "${sourceName}" is kind=${sourceValue.kind}, expected list (operations bodies require list input)`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }
      for (const op of operations) {
        if (op.op === 'filter') {
          items = items.filter(item => ExecutionEngine.#evalSieveAssertion(op.assertion, item));
        } else if (op.op === 'sort') {
          const cmp = ExecutionEngine.#buildSieveComparator(op.key, op.direction, op.coerceAs);
          items.sort(cmp);
        } else if (op.op === 'take') {
          // Coerce count from string (param-substituted) to number
          const n = typeof op.count === 'number' ? op.count : parseInt(op.count, 10);
          items = items.slice(0, Number.isFinite(n) ? n : 0);
        }
        // Unknown op silently no-op (normalizeSieveOp filtered them out, but
        // defensive in case of schema drift).
      }
      outputValue = list(items);
    }
    scope.set(outputName, outputValue);

    // v2.64.0 — Postconditions. Synthetic scope binds both INPUT and OUTPUT
    // so post-conditions can reference either. Same param substitution as
    // pre. Failure fails the strategy step but the output is already bound
    // to the real scope — this is intentional: the user can inspect the
    // output in the debugger to see why the postcondition rejected it.
    //
    // v2.67.0 (Pass 3b) — autoRecover. When postconditions fail AND the
    // Analysis has autoRecover: true, attempt frontier-tier recovery.
    // The runtime constructs a recovery prompt from the Analysis's own
    // artifacts (operations + contract + input + cache output) — no
    // author-written prompt needed. If frontier produces output that
    // satisfies the contract, it replaces cache's output in scope. If
    // frontier also fails (or the API errors), the strategy step fails.
    // v2.70.0 — Pre/post are assertion envelopes. Defensive fallback
    // for paths bypassing migration.
    const postEnvelope = analysis?.postconditions;
    const postConditionsRaw = (postEnvelope && Array.isArray(postEnvelope.conditions))
      ? postEnvelope.conditions
      : (Array.isArray(postEnvelope) ? postEnvelope : []);
    if (analysis && postConditionsRaw.length > 0) {
      const postScope = new Scope();
      postScope.set('INPUT', sourceValue);
      postScope.set('OUTPUT', outputValue);
      const postConds = ExecutionEngine.#substituteAnalysisParams(postConditionsRaw, bindings);
      const postEnvelopeForEval = {
        match: postEnvelope?.match ?? 'all',
        conditions: postConds,
        ...(typeof postEnvelope?.count === 'number' ? { count: postEnvelope.count } : {}),
      };
      // v2.70.3 — Resolve any assertion_ref entries against library assertions.
      let postEnvelopeFlat;
      try {
        postEnvelopeFlat = await flattenScopeAssertionRefs(
          postEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE postcondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_postcondition_failed', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          reason: err.message,
          message: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      const postResult = evaluateDataAssertionEnvelope(postEnvelopeFlat, postScope);
      if (!postResult.ok) {
        const f = postResult.failures[0];

        // If autoRecover is off, OR the Analysis is frontier-primary
        // (no further tier to escalate to in v1), hard-fail.
        if (!analysis.autoRecover || tier !== 'cache') {
          const errMsg = `Step ${topLevelIndex + 1}: SIEVE postcondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
          Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
          emit({
            type: 'sieve_postcondition_failed', stepIdx: topLevelIndex,
            analysisId: node.analysisId,
            condition: f.cond,
            reason: f.reason,
            message: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }

        // autoRecover on — attempt frontier recovery. We construct the
        // prompt from the Analysis's own artifacts: operations (with
        // params already substituted earlier), contract (postconditions),
        // INPUT (the source list), and cache's output (for context).
        Logger.info('ExecutionEngine',
          `SIEVE${label} — postcondition failed, attempting frontier recovery (${describeDataCondition(f.cond)}: ${f.reason})`);
        emit({
          type: 'sieve_recovery_attempting', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          condition: f.cond,
          reason: f.reason,
          message: `Step ${topLevelIndex + 1}: cache failed contract; trying frontier recovery`,
        });

        const opsDescription = describeOperations(operations);
        // v2.70.4 — Use the already-flattened envelope's conditions for the
        // contract description. postConds still contains assertion_ref
        // entries; describeDataCondition would render them as "invalid
        // condition", leaving the recovery model with no contract guidance.
        const contractDescription = describeContract(postEnvelopeFlat.conditions);
        const inputItemsRaw = Array.isArray(sourceValue.items) ? sourceValue.items : [];
        const cacheItemsRaw = items;

        const recoveryResult = await AnthropicService.invokeAnalysisRecovery({
          analysisName: analysis.name ?? node.analysisId,
          // v2.67.4 — Description is the author's stated intent and the
          // primary signal for recovery under Framing B.
          analysisDescription: analysis.description ?? '',
          operationsDescription: opsDescription,
          contractDescription,
          inputItems: inputItemsRaw,
          cacheOutputItems: cacheItemsRaw,
        });

        if (!recoveryResult.success) {
          const errMsg = `Step ${topLevelIndex + 1}: SIEVE recovery failed — ${recoveryResult.error}`;
          Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
          emit({
            type: 'sieve_recovery_failed', stepIdx: topLevelIndex,
            analysisId: node.analysisId,
            cacheCondition: f.cond,
            cacheReason: f.reason,
            recoveryError: recoveryResult.error,
            tokensIn: recoveryResult.tokensIn,
            tokensOut: recoveryResult.tokensOut,
            latencyMs: recoveryResult.latencyMs,
            message: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }

        // Frontier returned indices into the input list. Map them back
        // to the original sourceValue items — preserving element-tagging,
        // selectors, and any other upstream identity. This is the v1
        // recovery shape: the implementation's operations (filter, sort,
        // take) are uniformly identity-preserving, so recovery output is
        // a sub-arrangement of input items, not new records. Downstream
        // code (FOREACH, Fragment param substitution) sees the same
        // shape regardless of whether cache or recovery filled the binding.
        //
        // Future op types that produce new records (classify, summarize)
        // will need a record-based recovery schema as a separate branch;
        // when that branch lands, the runtime picks the schema from the
        // op set in the implementation.
        const originalItems = Array.isArray(sourceValue.items) ? sourceValue.items : [];
        const recoveredItems = recoveryResult.indices
          .filter(i => Number.isInteger(i) && i >= 0 && i < originalItems.length)
          .map(i => originalItems[i]);
        const recoveredOutput = list(recoveredItems);
        const postScope2 = new Scope();
        postScope2.set('INPUT', sourceValue);
        postScope2.set('OUTPUT', recoveredOutput);
        // v2.70.3 — Reuse the already-flattened envelope from the post-eval
        // path. postConds still contains assertion_ref entries; postEnvelopeFlat
        // has them resolved.
        const postResult2 = evaluateDataAssertionEnvelope(postEnvelopeFlat, postScope2);

        if (!postResult2.ok) {
          const f2 = postResult2.failures[0];
          const errMsg = `Step ${topLevelIndex + 1}: SIEVE recovery output also failed contract — ${describeDataCondition(f2.cond)}: ${f2.reason}`;
          Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
          emit({
            type: 'sieve_recovery_failed', stepIdx: topLevelIndex,
            analysisId: node.analysisId,
            cacheCondition: f.cond,
            cacheReason: f.reason,
            recoveryCondition: f2.cond,
            recoveryReason: f2.reason,
            tokensIn: recoveryResult.tokensIn,
            tokensOut: recoveryResult.tokensOut,
            latencyMs: recoveryResult.latencyMs,
            message: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }

        // Recovery succeeded. Replace the cache output in scope with the
        // recovered output. Continue as if the original step succeeded,
        // but emit a recovered-via-frontier event so the debugger can
        // surface that recovery fired.
        scope.set(outputName, recoveredOutput);
        items = recoveredItems;
        Logger.info('ExecutionEngine',
          `SIEVE${label} — frontier recovery succeeded: ${recoveredItems.length} items, ${recoveryResult.latencyMs}ms`);
        emit({
          type: 'sieve_recovered_via_frontier', stepIdx: topLevelIndex,
          analysisId: node.analysisId,
          cacheCondition: f.cond,
          cacheReason: f.reason,
          recoveredCount: recoveredItems.length,
          tokensIn: recoveryResult.tokensIn,
          tokensOut: recoveryResult.tokensOut,
          latencyMs: recoveryResult.latencyMs,
          message: `Step ${topLevelIndex + 1}: cache failed; frontier recovered (${recoveredItems.length} items)`,
        });
      }
    }

    Logger.info('ExecutionEngine',
      `SIEVE${label} — ${sourceName} (${startCount}) → ${outputName} (${items.length})`);
    emit({
      type: 'sieve_complete', stepIdx: topLevelIndex,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SIEVE ${sourceName}(${startCount}) → ${outputName}(${items.length})`,
    });
    return { status: 'ok' };
  }

  /**
   * v2.72.17 (Pass 7b) — Execute a SIEVE node referencing a template-kind
   * Analysis. Distinct from operations-kind because:
   *
   *   - No source-list reduction. Inputs are declared on the template body
   *     and looked up by name from scope.
   *   - Output is a document tagged value (not a list).
   *   - Pre/post evaluate against real scope (not synth INPUT/OUTPUT) —
   *     templates fan in from scope by name; evaluating against real scope
   *     means existing condition vocabulary works on the bindings directly.
   *
   * Flow:
   *   1. Parse template (cached parse would be nice; not done in 7b).
   *   2. Resolve each declared input from scope; check expects/itemKind.
   *   3. Evaluate preconditions against real scope.
   *   4. Render template to content string.
   *   5. Wrap as document tagged value.
   *   6. Bind to scope at node.output.
   *   7. Evaluate postconditions against real scope.
   *   8. Emit success.
   *
   * Failure modes are explicit:
   *   - parse_error:           template syntax invalid
   *   - input_missing:         declared input not present in scope
   *   - input_type_mismatch:   declared expects/itemKind doesn't match
   *   - precondition:          pre-eval failed
   *   - render_error:          template engine threw (missing reference,
   *                            wrong-typed sub-field access, etc.)
   *   - postcondition:         post-eval failed
   *
   * @private
   */
  static async #executeSieveTemplate(node, ctx, analysis, impl0, info) {
    const { scope, emit, topLevelTotal } = ctx;
    const { topLevelIndex, label, outputName } = info;

    const body = impl0.body;
    const tmplSource = String(body.template ?? '');
    const declaredInputs = Array.isArray(body.inputs) ? body.inputs : [];

    Logger.info('ExecutionEngine',
      `SIEVE${label} — ${analysis.name ?? analysis.id} (template, ${declaredInputs.length} input${declaredInputs.length === 1 ? '' : 's'})`);
    emit({
      type: 'sieve_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      analysisId: analysis.id,
      analysisName: analysis.name ?? analysis.id,
      bodyKind: 'template',
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SIEVE ${analysis.name ?? analysis.id} (template)`,
    });

    // ── 1. Parse template ────────────────────────────────────────────
    const parsed = parseTemplate(tmplSource);
    if (!parsed.ok) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE "${analysis.name ?? analysis.id}" template parse error: ${parsed.error}`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      emit({
        type: 'sieve_failed', stepIdx: topLevelIndex,
        analysisId: analysis.id, phase: 'parse_error',
        error: errMsg, reason: parsed.error,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 2. Validate declared inputs against scope ────────────────────
    // Each input must (a) be present in scope, (b) match expects kind,
    // (c) match itemKind for list inputs.
    for (const inp of declaredInputs) {
      const name = inp?.name;
      const expects = inp?.expects;
      if (!name || !expects) continue;  // malformed declarations skipped (validator catches at save)
      const v = scope.get(name);
      if (v === undefined) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE "${analysis.name ?? analysis.id}" template input "${name}" is not bound in scope`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'input_missing',
          input: name, expected: expects,
          error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      // Kind check. Strings can satisfy 'scalar' (legacy bare-string params).
      const actualKind = (typeof v === 'string') ? 'scalar' : (v?.kind ?? 'unknown');
      if (actualKind !== expects) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE "${analysis.name ?? analysis.id}" template input "${name}": expected kind "${expects}", got "${actualKind}"`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'input_type_mismatch',
          input: name, expected: expects, actual: actualKind,
          error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      // Item kind check (list inputs only).
      if (expects === 'list' && inp.itemKind) {
        const items = Array.isArray(v.items) ? v.items : [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          const itKind = (typeof it === 'string') ? 'scalar' : (it?.kind ?? 'unknown');
          if (itKind !== inp.itemKind) {
            const errMsg = `Step ${topLevelIndex + 1}: SIEVE "${analysis.name ?? analysis.id}" template input "${name}": list item ${i} expected kind "${inp.itemKind}", got "${itKind}"`;
            Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
            emit({
              type: 'sieve_failed', stepIdx: topLevelIndex,
              analysisId: analysis.id, phase: 'input_type_mismatch',
              input: name, expected: `list of ${inp.itemKind}`, actual: `list of ${itKind} (item ${i})`,
              error: errMsg,
            });
            return { status: 'failed', error: errMsg };
          }
        }
      }
    }

    // ── 3. Preconditions against real scope ──────────────────────────
    // Different from operations-kind: pre evaluates against the live scope
    // (not synth INPUT). Conditions reference declared inputs by name.
    // Param substitution applies to condition values that contain {{NAME}}.
    const bindings = ExecutionEngine.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
    const preEnvelope = analysis?.preconditions;
    const preConditionsRaw = (preEnvelope && Array.isArray(preEnvelope.conditions))
      ? preEnvelope.conditions
      : (Array.isArray(preEnvelope) ? preEnvelope : []);
    if (preConditionsRaw.length > 0) {
      const preConds = ExecutionEngine.#substituteAnalysisParams(preConditionsRaw, bindings);
      const preEnvelopeForEval = {
        match: preEnvelope?.match ?? 'all',
        conditions: preConds,
        ...(typeof preEnvelope?.count === 'number' ? { count: preEnvelope.count } : {}),
      };
      let preEnvelopeFlat;
      try {
        preEnvelopeFlat = await flattenScopeAssertionRefs(
          preEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE template precondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'precondition',
          error: errMsg, reason: err.message,
        });
        return { status: 'failed', error: errMsg };
      }
      const preResult = evaluateDataAssertionEnvelope(preEnvelopeFlat, scope);
      if (!preResult.ok) {
        const f = preResult.failures[0];
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE template precondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'precondition',
          condition: f.cond, reason: f.reason, error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // ── 4. Render template ────────────────────────────────────────────
    const renderResult = evalTemplate(parsed.ast, scope);
    if (!renderResult.ok) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE "${analysis.name ?? analysis.id}" template render failed: ${renderResult.error}`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      emit({
        type: 'sieve_failed', stepIdx: topLevelIndex,
        analysisId: analysis.id, phase: 'render_error',
        error: errMsg, reason: renderResult.error,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 5. Wrap as document tagged value ─────────────────────────────
    const docValue = document({
      format: 'markdown',
      content: renderResult.content,
      sourceBindings: declaredInputs.map(i => i?.name).filter(Boolean),
    });

    // ── 6. Bind to scope ──────────────────────────────────────────────
    scope.set(outputName, docValue);

    // ── 7. Postconditions ─────────────────────────────────────────────
    // v2.72.20 (Pass 7c) — Synth scope with OUTPUT bound to the document.
    // Authors write postconditions referencing binding=OUTPUT (sentinel)
    // because they don't know the SIEVE node's output name at Analysis
    // authoring time. Mirrors how operations-body Analyses synth INPUT/
    // OUTPUT for their postconditions.
    const postEnvelope = analysis?.postconditions;
    const postConditionsRaw = (postEnvelope && Array.isArray(postEnvelope.conditions))
      ? postEnvelope.conditions
      : (Array.isArray(postEnvelope) ? postEnvelope : []);
    if (postConditionsRaw.length > 0) {
      const postScope = new Scope();
      postScope.set('OUTPUT', docValue);
      const postConds = ExecutionEngine.#substituteAnalysisParams(postConditionsRaw, bindings);
      const postEnvelopeForEval = {
        match: postEnvelope?.match ?? 'all',
        conditions: postConds,
        ...(typeof postEnvelope?.count === 'number' ? { count: postEnvelope.count } : {}),
      };
      let postEnvelopeFlat;
      try {
        postEnvelopeFlat = await flattenScopeAssertionRefs(
          postEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE template postcondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'postcondition',
          error: errMsg, reason: err.message,
        });
        return { status: 'failed', error: errMsg };
      }
      const postResult = evaluateDataAssertionEnvelope(postEnvelopeFlat, postScope);
      if (!postResult.ok) {
        const f = postResult.failures[0];
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE template postcondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'postcondition',
          condition: f.cond, reason: f.reason, error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // ── 8. Emit success ───────────────────────────────────────────────
    Logger.info('ExecutionEngine',
      `SIEVE${label} — template "${analysis.name ?? analysis.id}" → ${outputName} (${docValue.byteSize} chars)`);
    emit({
      type: 'sieve_complete', stepIdx: topLevelIndex,
      analysisId: analysis.id,
      bodyKind: 'template',
      output: outputName,
      byteSize: docValue.byteSize,
      sourceBindings: docValue.sourceBindings,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SIEVE ${analysis.name ?? analysis.id} (template) → ${outputName} (${docValue.byteSize} chars)`,
    });
    return { status: 'ok' };
  }

  /**
   * v2.74.132 — Execute a SIEVE node referencing a transform-body Analysis.
   *
   * Transform-body bridges the operations-body's "list pipeline" and the
   * template-body's "named-inputs compose" patterns. It takes declared
   * named inputs from scope (typed contracts; same validation as template),
   * runs a chain of named ops over named intermediate bindings, and
   * exposes a declared set of named outputs.
   *
   * Wiring (same convention as template body):
   *   - Declared input names must already be bound in the strategy's
   *     scope when the SIEVE step runs. No `source` field on the SIEVE.
   *   - Declared output names are written back into the strategy's scope
   *     after the chain completes. No `output` field on the SIEVE.
   *   - Pre-conditions reference declared inputs by name (evaluated
   *     against the real scope, like template body).
   *   - Post-conditions reference declared outputs by name (evaluated
   *     against a synth scope where each declared output is bound).
   *     Declared inputs are also re-bound into the post scope so
   *     conditions can compare in/out.
   *
   * Failure phases emitted:
   *   input_missing | input_type_mismatch | precondition |
   *   transform_runtime | postcondition | assertion_resolution
   *
   * @private
   */
  static async #executeSieveTransform(node, ctx, analysis, impl0, info) {
    const { scope, emit, topLevelTotal } = ctx;
    const { topLevelIndex, label } = info;

    const body = impl0.body;
    const declaredInputs  = Array.isArray(body.inputs)  ? body.inputs  : [];
    const declaredOutputs = Array.isArray(body.outputs) ? body.outputs : [];

    Logger.info('ExecutionEngine',
      `SIEVE${label} — ${analysis.name ?? analysis.id} (transform, ${declaredInputs.length} input${declaredInputs.length === 1 ? '' : 's'} → ${declaredOutputs.length} output${declaredOutputs.length === 1 ? '' : 's'})`);
    emit({
      type: 'sieve_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      analysisId: analysis.id,
      analysisName: analysis.name ?? analysis.id,
      bodyKind: 'transform',
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SIEVE ${analysis.name ?? analysis.id} (transform)`,
    });

    // ── 1. Resolve declared inputs from scope (with kind checks) ─────
    const inputBindings = {};
    for (const inp of declaredInputs) {
      const name = inp?.name;
      const expects = inp?.expects;
      if (!name || !expects) continue;   // validator catches malformed declarations at save
      const v = scope.get(name);
      if (v === undefined) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE "${analysis.name ?? analysis.id}" transform input "${name}" is not bound in scope`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'input_missing',
          input: name, expected: expects,
          error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      // Strings (legacy bare-string params) satisfy 'scalar'; wrap them
      // so the kernel sees a uniform tagged value.
      const actualKind = (typeof v === 'string') ? 'scalar' : (v?.kind ?? 'unknown');
      if (actualKind !== expects) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE "${analysis.name ?? analysis.id}" transform input "${name}": expected kind "${expects}", got "${actualKind}"`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'input_type_mismatch',
          input: name, expected: expects, actual: actualKind,
          error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      inputBindings[name] = (typeof v === 'string') ? scalar(v) : v;
    }

    // ── 2. Preconditions against live scope ──────────────────────────
    const bindings = ExecutionEngine.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
    const preEnvelope = analysis?.preconditions;
    const preConditionsRaw = (preEnvelope && Array.isArray(preEnvelope.conditions))
      ? preEnvelope.conditions
      : (Array.isArray(preEnvelope) ? preEnvelope : []);
    if (preConditionsRaw.length > 0) {
      const preConds = ExecutionEngine.#substituteAnalysisParams(preConditionsRaw, bindings);
      const preEnvelopeForEval = {
        match: preEnvelope?.match ?? 'all',
        conditions: preConds,
        ...(typeof preEnvelope?.count === 'number' ? { count: preEnvelope.count } : {}),
      };
      let preEnvelopeFlat;
      try {
        preEnvelopeFlat = await flattenScopeAssertionRefs(
          preEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE transform precondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'precondition',
          error: errMsg, reason: err.message,
        });
        return { status: 'failed', error: errMsg };
      }
      const preResult = evaluateDataAssertionEnvelope(preEnvelopeFlat, scope);
      if (!preResult.ok) {
        const f = preResult.failures[0];
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE transform precondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'precondition',
          condition: f.cond, reason: f.reason, error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // ── 3. Substitute {{PARAM}} placeholders in op fields ────────────
    // Same mechanism the operations-body uses. Walks the ops array;
    // string-typed values containing {{NAME}} get substituted against
    // the resolved paramBindings.
    const opsResolved = ExecutionEngine.#substituteAnalysisParams(body.ops ?? [], bindings);

    // ── 4. Run the transform body ────────────────────────────────────
    const result = runTransformBody(
      { inputs: declaredInputs, ops: opsResolved, outputs: declaredOutputs },
      inputBindings,
    );
    if (!result.ok) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE transform runtime error — ${result.error}`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      emit({
        type: 'sieve_failed', stepIdx: topLevelIndex,
        analysisId: analysis.id, phase: 'transform_runtime',
        error: errMsg, reason: result.error,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 5. Write declared outputs into the live scope ────────────────
    for (const dec of declaredOutputs) {
      const v = result.outputs[dec.name];
      if (v !== undefined) scope.set(dec.name, v);
    }

    // ── 6. Postconditions against synth scope (declared outputs +
    //      declared inputs re-bound for in/out comparisons) ─────────
    const postEnvelope = analysis?.postconditions;
    const postConditionsRaw = (postEnvelope && Array.isArray(postEnvelope.conditions))
      ? postEnvelope.conditions
      : (Array.isArray(postEnvelope) ? postEnvelope : []);
    if (postConditionsRaw.length > 0) {
      const postScope = new Scope();
      for (const [name, value] of Object.entries(inputBindings))  postScope.set(name, value);
      for (const [name, value] of Object.entries(result.outputs)) postScope.set(name, value);
      const postConds = ExecutionEngine.#substituteAnalysisParams(postConditionsRaw, bindings);
      const postEnvelopeForEval = {
        match: postEnvelope?.match ?? 'all',
        conditions: postConds,
        ...(typeof postEnvelope?.count === 'number' ? { count: postEnvelope.count } : {}),
      };
      let postEnvelopeFlat;
      try {
        postEnvelopeFlat = await flattenScopeAssertionRefs(
          postEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE transform postcondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'postcondition',
          error: errMsg, reason: err.message,
        });
        return { status: 'failed', error: errMsg };
      }
      const postResult = evaluateDataAssertionEnvelope(postEnvelopeFlat, postScope);
      if (!postResult.ok) {
        const f = postResult.failures[0];
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE transform postcondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'postcondition',
          condition: f.cond, reason: f.reason, error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // ── 7. Emit success ──────────────────────────────────────────────
    const outNames = declaredOutputs.map(o => o.name).join(', ') || '(no outputs)';
    Logger.info('ExecutionEngine',
      `SIEVE${label} — transform "${analysis.name ?? analysis.id}" → {${outNames}}`);
    emit({
      type: 'sieve_complete', stepIdx: topLevelIndex,
      analysisId: analysis.id,
      bodyKind: 'transform',
      outputs: declaredOutputs.map(o => o.name),
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SIEVE ${analysis.name ?? analysis.id} (transform) → ${outNames}`,
    });
    return { status: 'ok' };
  }

  /**
   * v2.72.22 — Execute a SIEVE node referencing a frontier-tier Analysis
   * in compose mode. Compose mode = no source binding, pre conditions
   * reference scope bindings by name, the model fans those bindings in
   * to produce a synthesized output (typically a document).
   *
   * Distinct from the existing single-source frontier path because:
   *   - No source-list; multi-input fan-in from pre condition bindings
   *   - Pre evaluates against real scope (matches template kind)
   *   - Post evaluates against synth scope with OUTPUT bound (matches template)
   *   - Output wrapped as document iff a post condition asserts binding_is_document
   *
   * Flow:
   *   1. Collect input bindings from pre conditions; resolve each from scope
   *   2. Evaluate pre conditions against real scope
   *   3. Build payload: text spec includes named-binding serializations;
   *      one image input allowed (Pass 11 limit)
   *   4. Invoke frontier-primary API
   *   5. Wrap output: document if post asserts; else use existing
   *      array/object/string/scalar dispatch
   *   6. Bind to scope at outputName
   *   7. Evaluate post conditions against synth scope with OUTPUT
   *   8. Emit success
   *
   * Failure phases:
   *   binding_missing | precondition | api_failure | output_invalid |
   *   postcondition | assertion_resolution
   *
   * @private
   */
  static async #executeSieveFrontierCompose(node, ctx, analysis, impl0, info) {
    const { scope, emit, topLevelTotal } = ctx;
    const { topLevelIndex, label, outputName, preBindingNames } = info;
    const analysisName = analysis.name ?? analysis.id;

    Logger.info('ExecutionEngine',
      `SIEVE${label} — ${analysisName} (frontier compose, ${preBindingNames.length} input${preBindingNames.length === 1 ? '' : 's'})`);
    emit({
      type: 'sieve_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      analysisId: analysis.id,
      analysisName,
      bodyKind: 'frontier-compose',
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SIEVE ${analysisName} (compose)`,
    });

    // ── 1. Collect input bindings ─────────────────────────────────────
    // De-duplicate preBindingNames; lookup each in scope.
    const uniqueNames = [...new Set(preBindingNames)];
    const namedInputs = []; // [{name, value}]
    for (const name of uniqueNames) {
      const v = scope.get(name);
      if (v === undefined) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose "${analysisName}" references binding "${name}" in pre conditions but it is not bound in scope`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'binding_missing',
          binding: name,
          error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      namedInputs.push({ name, value: v });
    }

    // ── 2. Evaluate pre conditions against real scope ────────────────
    const bindings = ExecutionEngine.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
    const preEnvelope = analysis?.preconditions;
    const preCondsRaw = (preEnvelope && Array.isArray(preEnvelope.conditions))
      ? preEnvelope.conditions
      : (Array.isArray(preEnvelope) ? preEnvelope : []);
    if (preCondsRaw.length > 0) {
      const preConds = ExecutionEngine.#substituteAnalysisParams(preCondsRaw, bindings);
      const preEnvelopeForEval = {
        match: preEnvelope?.match ?? 'all',
        conditions: preConds,
        ...(typeof preEnvelope?.count === 'number' ? { count: preEnvelope.count } : {}),
      };
      let preEnvelopeFlat;
      try {
        preEnvelopeFlat = await flattenScopeAssertionRefs(
          preEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose precondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'assertion_resolution',
          error: errMsg, reason: err.message,
        });
        return { status: 'failed', error: errMsg };
      }
      const preResult = evaluateDataAssertionEnvelope(preEnvelopeFlat, scope);
      if (!preResult.ok) {
        const f = preResult.failures[0];
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose precondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'precondition',
          condition: f.cond, reason: f.reason, error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // ── 3. Build payload ──────────────────────────────────────────────
    // Each named input becomes a serialized text section; at most one
    // image input becomes the multimodal image block. Pass 11's existing
    // single-image API limit applies.
    const imageInputs = namedInputs.filter(i => i.value?.kind === 'image');
    if (imageInputs.length > 1) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose "${analysisName}" has ${imageInputs.length} image inputs; only 1 image input is supported per call in this build`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      emit({
        type: 'sieve_failed', stepIdx: topLevelIndex,
        analysisId: analysis.id, phase: 'binding_missing',
        error: errMsg,
        reason: 'multiple image inputs not supported',
      });
      return { status: 'failed', error: errMsg };
    }
    let imageInputForApi = null;
    if (imageInputs.length === 1) {
      const img = imageInputs[0].value;
      if (!img.base64) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose "${analysisName}" image input "${imageInputs[0].name}" has no base64 data`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'binding_missing',
          error: errMsg, reason: 'image binding has empty base64',
        });
        return { status: 'failed', error: errMsg };
      }
      imageInputForApi = {
        base64: img.base64,
        mime: img.mime || 'image/png',
        label: imageInputs[0].name,
      };
    }
    // Build named-input map for the text spec. Image inputs are referenced
    // by name with a "(image, see attached)" placeholder; non-image inputs
    // are serialized to their text form.
    const namedInputsForText = {};
    for (const { name, value } of namedInputs) {
      const k = value?.kind;
      if (k === 'image') {
        namedInputsForText[name] = '(image — see attached image above)';
      } else if (k === 'list') {
        namedInputsForText[name] = Array.isArray(value.items) ? value.items : [];
      } else if (k === 'section') {
        namedInputsForText[name] = value.markdown ?? value.text ?? '';
      } else if (k === 'document') {
        namedInputsForText[name] = value.content ?? '';
      } else if (k === 'record') {
        namedInputsForText[name] = value.fields ?? {};
      } else if (k === 'scalar') {
        namedInputsForText[name] = value.value ?? '';
      } else if (k === 'element') {
        namedInputsForText[name] = value.selector ?? '';
      } else {
        namedInputsForText[name] = value;
      }
    }

    // Build pre/post descriptions for the model. Reuses existing flatten
    // + describe pipeline.
    const postEnvelope = analysis?.postconditions;
    const postCondsRaw = (postEnvelope && Array.isArray(postEnvelope.conditions))
      ? postEnvelope.conditions
      : (Array.isArray(postEnvelope) ? postEnvelope : []);
    let preDesc, postDesc;
    try {
      const preFlat = await flattenScopeAssertionRefs(
        {
          match: preEnvelope?.match ?? 'all',
          conditions: preCondsRaw,
          ...(typeof preEnvelope?.count === 'number' ? { count: preEnvelope.count } : {}),
        },
        (id) => StorageManager.getAssertion(id)
      );
      const postFlat = await flattenScopeAssertionRefs(
        {
          match: postEnvelope?.match ?? 'all',
          conditions: postCondsRaw,
          ...(typeof postEnvelope?.count === 'number' ? { count: postEnvelope.count } : {}),
        },
        (id) => StorageManager.getAssertion(id)
      );
      preDesc = describePreconditions(
        ExecutionEngine.#substituteAnalysisParams(preFlat.conditions, bindings)
      );
      postDesc = describeContract(
        ExecutionEngine.#substituteAnalysisParams(postFlat.conditions, bindings)
      );
    } catch (err) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose contract resolution failed — ${err.message}`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      emit({
        type: 'sieve_failed', stepIdx: topLevelIndex,
        analysisId: analysis.id, phase: 'assertion_resolution',
        error: errMsg, reason: err.message,
      });
      return { status: 'failed', error: errMsg };
    }

    // Detect document-output requirement from post conditions.
    const wantsDocument = postCondsRaw.some(c => c?.type === 'binding_is_document' && c?.binding === 'OUTPUT');

    // ── 4. Invoke frontier API ────────────────────────────────────────
    emit({
      type: 'sieve_frontier_primary_attempting', stepIdx: topLevelIndex,
      analysisId: analysis.id,
      bodyKind: 'frontier-compose',
      inputCount: namedInputs.length,
      hasImage: !!imageInputForApi,
      wantsDocument,
      message: `Step ${topLevelIndex + 1}: invoking frontier model (compose, ${namedInputs.length} input${namedInputs.length === 1 ? '' : 's'})`,
    });

    const result = await AnthropicService.invokeAnalysisFrontierPrimary({
      analysisName,
      analysisDescription: analysis.description ?? '',
      preconditionsDescription: preDesc,
      postconditionsDescription: postDesc,
      params: bindings,
      // Pass named inputs as the inputValue object — non-image inputs
      // serialize as JSON; the image (if any) goes via imageInput.
      inputValue: namedInputsForText,
      imageInput: imageInputForApi,
    });

    if (!result.success) {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose frontier-primary failed — ${result.error}`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      emit({
        type: 'sieve_failed', stepIdx: topLevelIndex,
        analysisId: analysis.id, phase: 'api_failure',
        frontierError: result.error,
        confidence: result.confidence,
        rationale: result.rationale,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
        error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 5. Wrap output ────────────────────────────────────────────────
    // Document path: post asserts binding_is_document → wrap as document
    // tagged value with the model's output as content. Otherwise use the
    // existing array/object/string/number/boolean dispatch.
    const out = result.output;
    let outputValue = null;
    if (wantsDocument) {
      // The model's output is the document content. Accept string directly,
      // or stringify objects/arrays defensively (unlikely if contract clear).
      let content;
      if (typeof out === 'string') content = out;
      else if (out == null)         content = '';
      else                          content = JSON.stringify(out);
      outputValue = document({
        format: 'markdown',
        content,
        sourceBindings: uniqueNames,
      });
    } else if (Array.isArray(out)) {
      outputValue = list(out);
    } else if (out !== null && typeof out === 'object') {
      outputValue = record(out);
    } else if (typeof out === 'string') {
      outputValue = scalar(out, 'string');
    } else if (typeof out === 'number') {
      outputValue = scalar(String(out), 'number');
    } else if (typeof out === 'boolean') {
      outputValue = scalar(String(out), 'boolean');
    } else {
      const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose returned ${out === null ? 'null' : typeof out}, which cannot be bound to scope`;
      Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
      emit({
        type: 'sieve_failed', stepIdx: topLevelIndex,
        analysisId: analysis.id, phase: 'output_invalid',
        frontierError: errMsg,
        confidence: result.confidence,
        rationale: result.rationale,
        error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 6. Bind to scope ──────────────────────────────────────────────
    scope.set(outputName, outputValue);

    // ── 7. Postconditions against synth scope with OUTPUT ────────────
    if (postCondsRaw.length > 0) {
      const postScope = new Scope();
      postScope.set('OUTPUT', outputValue);
      const postConds = ExecutionEngine.#substituteAnalysisParams(postCondsRaw, bindings);
      const postEnvelopeForEval = {
        match: postEnvelope?.match ?? 'all',
        conditions: postConds,
        ...(typeof postEnvelope?.count === 'number' ? { count: postEnvelope.count } : {}),
      };
      let postEnvelopeFlat;
      try {
        postEnvelopeFlat = await flattenScopeAssertionRefs(
          postEnvelopeForEval,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose postcondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'assertion_resolution',
          error: errMsg, reason: err.message,
        });
        return { status: 'failed', error: errMsg };
      }
      const postResult = evaluateDataAssertionEnvelope(postEnvelopeFlat, postScope);
      if (!postResult.ok) {
        const f = postResult.failures[0];
        const errMsg = `Step ${topLevelIndex + 1}: SIEVE compose postcondition failed — ${describeDataCondition(f.cond)}: ${f.reason}`;
        Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
        emit({
          type: 'sieve_failed', stepIdx: topLevelIndex,
          analysisId: analysis.id, phase: 'postcondition',
          condition: f.cond, reason: f.reason, error: errMsg,
          confidence: result.confidence,
          rationale: result.rationale,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // ── 8. Emit success ───────────────────────────────────────────────
    const outShape = outputValue.kind === 'document'
      ? `document (${outputValue.byteSize} chars)`
      : (outputValue.kind === 'list' ? `list (${outputValue.items?.length ?? 0} items)` : outputValue.kind);
    Logger.info('ExecutionEngine',
      `SIEVE${label} — compose "${analysisName}" → ${outputName} (${outShape})`);
    emit({
      type: 'sieve_complete', stepIdx: topLevelIndex,
      analysisId: analysis.id,
      bodyKind: 'frontier-compose',
      output: outputName,
      outputKind: outputValue.kind,
      ...(outputValue.kind === 'document' ? { byteSize: outputValue.byteSize } : {}),
      sourceBindings: uniqueNames,
      confidence: result.confidence,
      rationale: result.rationale,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      latencyMs: result.latencyMs,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SIEVE ${analysisName} (compose) → ${outputName} (${outShape})`,
    });
    return { status: 'ok' };
  }

  /**
   * v2.63.0 (Iteration B) — Resolve an Analysis by id. Built-ins come from
   * the registry; user analyses from storage. Returns null if not found.
   */
  static async #resolveAnalysis(analysisId) {
    if (isBuiltinAnalysisId(analysisId)) {
      return getBuiltinAnalysis(analysisId);
    }
    return StorageManager.getAnalysis(analysisId);
  }

  /**
   * v2.63.0 (Iteration B) — Resolve sieve param bindings into a flat
   * { NAME: value } map for substitution.
   *
   * Each binding has a kind:
   *   - 'literal'              — value used directly
   *   - 'iteration_variable'   — resolved from scope by name; for scalar
   *                              items the .value is used, for elements
   *                              the .selector, for records the JSON
   *   - 'strategy_param'       — resolved from scope (strategy params live
   *                              there as scalar bindings)
   *
   * Mirrors the binding kinds the strategy editor presents for fragment
   * params, so users have the same mental model across both.
   */
  static #resolveSieveParamBindings(paramBindings, scope) {
    const out = {};
    for (const [name, binding] of Object.entries(paramBindings ?? {})) {
      if (!binding || typeof binding !== 'object') {
        // Backward-compat: a plain string binding is treated as literal.
        out[name] = String(binding ?? '');
        continue;
      }
      const kind = binding.kind ?? 'literal';
      if (kind === 'literal') {
        out[name] = String(binding.value ?? '');
      } else if (kind === 'iteration_variable' || kind === 'strategy_param') {
        const v = scope.get(binding.name ?? '');
        if (v == null) {
          out[name] = '';
        } else if (v.kind === 'scalar') {
          out[name] = String(v.value ?? '');
        } else if (v.kind === 'element') {
          out[name] = String(v.selector ?? '');
        } else if (v.kind === 'record') {
          out[name] = JSON.stringify(v.fields ?? {});
        } else {
          out[name] = '';
        }
      } else {
        out[name] = '';
      }
    }
    return out;
  }

  /**
   * v2.63.0 (Iteration B) — Substitute {{NAME}} placeholders in operation
   * values. Recursively walks the operations array; for any string value,
   * replaces every {{NAME}} occurrence with bindings[NAME]. Non-string
   * values pass through. Returns a new structure; does not mutate input.
   */
  static #substituteAnalysisParams(operations, bindings) {
    const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
    const visit = (val) => {
      if (val == null) return val;
      if (typeof val === 'string') {
        return val.replace(PLACEHOLDER_RE, (_, name) => {
          return Object.prototype.hasOwnProperty.call(bindings, name)
            ? String(bindings[name])
            : '';
        });
      }
      if (Array.isArray(val)) return val.map(visit);
      if (typeof val === 'object') {
        const o = {};
        for (const [k, v] of Object.entries(val)) o[k] = visit(v);
        return o;
      }
      return val;
    };
    return visit(operations);
  }

  /**
   * v2.61.0 — Evaluate a sieve assertion against a single item.
   *
   * Items are typically `kind: 'element'` with a `record` sub-object holding
   * the field values. Assertions reference fields by name and read from
   * `item.record[fieldName]`. If the item has no `record` (raw scalar /
   * pre-O1 ENUMERATE output / hand-built lists), all field-* assertions
   * are false — nothing to read.
   *
   * Compound assertions recurse: all_of (AND), any_of (OR), not (NOT).
   *
   * @private
   */
  static #evalSieveAssertion(assertion, item) {
    if (!assertion || typeof assertion !== 'object') return true;
    const record = (item?.record && typeof item.record === 'object') ? item.record : null;
    const getField = (name) => record ? record[name] : undefined;

    switch (assertion.type) {
      case 'always_true': return true;
      case 'field_equals': {
        const v = getField(assertion.field);
        return v !== undefined && String(v) === String(assertion.value);
      }
      case 'field_starts_with': {
        const v = getField(assertion.field);
        return v !== undefined && String(v).startsWith(String(assertion.value));
      }
      case 'field_contains': {
        const v = getField(assertion.field);
        return v !== undefined && String(v).includes(String(assertion.value));
      }
      case 'field_present': {
        const v = getField(assertion.field);
        return v !== undefined && v !== null && String(v).trim().length > 0;
      }
      case 'all_of':
        return (assertion.assertions ?? []).every(p => ExecutionEngine.#evalSieveAssertion(p, item));
      case 'any_of':
        return (assertion.assertions ?? []).some(p => ExecutionEngine.#evalSieveAssertion(p, item));
      case 'not':
        return !ExecutionEngine.#evalSieveAssertion(assertion.assertion, item);
      default:
        return true;
    }
  }

  /**
   * v2.61.0 — Build a sort comparator for a sieve sort op.
   *
   * coerceAs determines how field values get compared:
   *   'string' (default) — perspective-aware string compare
   *   'number'           — parseFloat both sides; NaN sorts last
   *   'date'             — Date.parse both sides; invalid dates sort last
   *
   * Stable sort behavior — ties keep original order — is provided by the
   * underlying Array.prototype.sort in modern engines (ES2019+).
   *
   * @private
   */
  static #buildSieveComparator(key, direction, coerceAs) {
    const desc = direction === 'desc';
    const flip = desc ? -1 : 1;
    return (a, b) => {
      const va = a?.record?.[key];
      const vb = b?.record?.[key];
      if (coerceAs === 'number') {
        const na = parseFloat(va), nb = parseFloat(vb);
        const aBad = !Number.isFinite(na), bBad = !Number.isFinite(nb);
        if (aBad && bBad) return 0;
        if (aBad) return 1;            // bad sorts last regardless of direction
        if (bBad) return -1;
        return (na - nb) * flip;
      }
      if (coerceAs === 'date') {
        const ta = Date.parse(va), tb = Date.parse(vb);
        const aBad = Number.isNaN(ta), bBad = Number.isNaN(tb);
        if (aBad && bBad) return 0;
        if (aBad) return 1;
        if (bBad) return -1;
        return (ta - tb) * flip;
      }
      // 'string' default
      const sa = va == null ? '' : String(va);
      const sb = vb == null ? '' : String(vb);
      return sa.localeCompare(sb) * flip;
    };
  }

  /**
   * Pass G2 (v2.31.0) — Execute a DETECT node. Evaluate each branch's
   * condition in order (one-shot, no polling). The first branch whose
   * condition holds has its body executed. If no branch matches, the
   * default body runs. Conditions that are neither met nor broken simply
   * fall through — DETECT doesn't fail a strategy for an unmet branch,
   * it's purely dispatching.
   *
   * DETECT is scope-transparent: iteration variables from enclosing
   * FOREACHes are visible inside every branch body and the default.
   *
   * Branches evaluated in the order authored. Use WAIT beforehand if a
   * condition needs time to stabilize — DETECT doesn't wait.
   *
   * @private
   */
  static async #executeDetectNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    const { tabId, scope, isAborted, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    const branches = Array.isArray(node.branches) ? node.branches : [];
    Logger.info('ExecutionEngine',
      `DETECT${label} — evaluating ${branches.length} branch(es)`);
    emit({
      type: 'detect_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      branchCount: branches.length,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: DETECT (${branches.length} branch(es))`,
    });

    for (let i = 0; i < branches.length; i++) {
      if (isAborted()) return { status: 'aborted' };
      const branch = branches[i];
      // v2.41.0 — branch.condition is now a Assertion. Skip if empty.
      if (!branch?.condition || !Array.isArray(branch.condition.conditions) || branch.condition.conditions.length === 0) continue;
      // One-shot probe — no polling, no timeout.
      // v2.46.0 (Pass O1) — pass scope so field-* conditions can read records.
      const probe = await TemplateWalker.checkConditions({
        tabId, conditions: branch.condition, scope, timeoutMs: 0,
      });
      if (probe.ok) {
        Logger.info('ExecutionEngine',
          `DETECT${label} — branch ${i + 1}/${branches.length} matched, executing body`);
        emit({
          type: 'detect_branch_chosen', stepIdx: topLevelIndex,
          branchIndex: i, condition: branch.condition,
        });
        const bodyResult = await ExecutionEngine.#executeBodyWithIterationLabel(
          branch.body ?? [], ctx, { topLevelIndex, iterationLabel, iteration }
        );
        if (bodyResult.status !== 'ok') return bodyResult;
        emit({ type: 'detect_complete', stepIdx: topLevelIndex, chosenBranch: i });
        return { status: 'ok' };
      }
    }

    // No branch matched — run default.
    const defaultBody = Array.isArray(node.default) ? node.default : [];
    Logger.info('ExecutionEngine',
      `DETECT${label} — no branch matched, executing default body (${defaultBody.length} step(s))`);
    emit({
      type: 'detect_branch_chosen', stepIdx: topLevelIndex,
      branchIndex: -1, condition: null,
    });
    const defaultResult = await ExecutionEngine.#executeBodyWithIterationLabel(
      defaultBody, ctx, { topLevelIndex, iterationLabel, iteration }
    );
    if (defaultResult.status !== 'ok') return defaultResult;
    emit({ type: 'detect_complete', stepIdx: topLevelIndex, chosenBranch: -1 });
    return { status: 'ok' };
  }

  /**
   * Pass H1 (v2.32.0) — Execute a LOOP (while) node. Test-first semantics:
   * evaluate condition, if true run body, repeat. Exits cleanly when the
   * condition goes false.
   *
   * Safety-capped by node.maxIterations. If we hit the cap the strategy
   * FAILS with a loud error rather than silently truncating — hitting the
   * cap means either the condition is broken or the page isn't progressing,
   * both of which are bugs the author should see.
   *
   * LOOP is scope-transparent: iteration variables from enclosing FOREACHes
   * remain visible inside the body. The LOOP itself does NOT introduce an
   * iteration variable — a count-agnostic loop.
   *
   * @private
   */
  static async #executeLoopNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    const { tabId, scope, isAborted, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    const condition = node.condition;
    const maxIterations = Number.isFinite(node.maxIterations) && node.maxIterations > 0
      ? node.maxIterations : 100;

    // v2.41.0 — node.condition is a Assertion. Describe it via condition count.
    const condDesc = condition?.conditions?.length === 1
      ? condition.conditions[0].type
      : `${condition?.conditions?.length ?? 0} conditions ${condition?.match === 'any' ? 'OR' : 'AND'}`;
    Logger.info('ExecutionEngine',
      `LOOP${label} — while (${condDesc}) max=${maxIterations}`);
    emit({
      type: 'loop_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      condition, maxIterations,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: LOOP while (${condDesc})`,
    });

    let iterationCount = 0;
    while (true) {
      if (isAborted()) return { status: 'aborted' };

      // Test-first: evaluate condition BEFORE running body.
      // One-shot probe (timeoutMs: 0). Use a WAIT inside the body if
      // the author needs to give the page time to settle.
      // v2.46.0 (Pass O1) — pass scope for field-* conditions.
      const probe = await TemplateWalker.checkConditions({
        tabId, conditions: condition, scope, timeoutMs: 0,
      });
      if (!probe.ok) {
        Logger.info('ExecutionEngine',
          `LOOP${label} — condition false after ${iterationCount} iteration(s), exiting`);
        emit({
          type: 'loop_complete', stepIdx: topLevelIndex,
          iterationsRun: iterationCount, reason: 'condition_false',
        });
        return { status: 'ok' };
      }

      // Condition is true — check safety cap before running another iteration.
      if (iterationCount >= maxIterations) {
        const errMsg = `Step ${topLevelIndex + 1}: LOOP exceeded maxIterations (${maxIterations}). ` +
          `Condition is still true after ${iterationCount} iteration(s) — check the exit condition or raise the cap.`;
        Logger.error('ExecutionEngine', `LOOP${label} — ${errMsg}`);
        emit({
          type: 'loop_complete', stepIdx: topLevelIndex,
          iterationsRun: iterationCount, reason: 'max_exceeded',
        });
        return { status: 'failed', error: errMsg };
      }

      iterationCount++;
      Logger.info('ExecutionEngine',
        `LOOP${label} — iteration ${iterationCount}/${maxIterations}`);
      emit({
        type: 'loop_iteration', stepIdx: topLevelIndex,
        iteration: iterationCount, maxIterations,
      });

      const bodyResult = await ExecutionEngine.#executeBodyWithIterationLabel(
        node.body ?? [], ctx, { topLevelIndex, iterationLabel, iteration }
      );
      if (bodyResult.status !== 'ok') return bodyResult;
    }
  }

  /**
   * Pass H2 — Execute a TRY node. Expected-failure recovery.
   *
   * Semantics:
   *   1. Execute `body` sequentially. If all nodes succeed → TRY succeeds,
   *      skip recover, return ok.
   *   2. If any body node FAILS → stop body, run `recover`, return
   *      recover's status. An empty recover swallows the failure.
   *   3. If recover itself fails → TRY fails (no recursive recovery,
   *      prevents infinite loops).
   *   4. Abort during body/recover → aborted status propagates out.
   *
   * TRY is scope-transparent. Recover body is opaque about the failure
   * in H2 (no FAILURE binding). Design rationale: adding a FAILURE
   * binding is a backward-compatible future change, but the realistic
   * use cases are all covered by "recover runs a different action."
   *
   * @private
   */
  static async #executeTryNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    const { isAborted, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    Logger.info('ExecutionEngine', `TRY${label} — body then recover-on-fail`);
    emit({
      type: 'try_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: TRY`,
    });

    if (isAborted()) return { status: 'aborted' };

    // Run the body. If it aborts, propagate aborted (do NOT run recover
    // on an abort — aborts are not failures, they're the user stopping).
    const bodyResult = await ExecutionEngine.#executeBodyWithIterationLabel(
      node.body ?? [], ctx, { topLevelIndex, iterationLabel, iteration }
    );

    if (bodyResult.status === 'ok') {
      // Clean body run — skip recover.
      Logger.info('ExecutionEngine', `TRY${label} — body ok, skipping recover`);
      emit({
        type: 'try_complete', stepIdx: topLevelIndex, outcome: 'body_ok',
      });
      return { status: 'ok' };
    }

    if (bodyResult.status === 'aborted') {
      // Abort is not a recoverable failure.
      Logger.info('ExecutionEngine', `TRY${label} — body aborted, not running recover`);
      return bodyResult;
    }

    // Body failed. Run recover.
    const bodyError = bodyResult.error ?? 'body failed';
    Logger.info('ExecutionEngine', `TRY${label} — body failed (${bodyError}), running recover`);
    emit({
      type: 'try_recover', stepIdx: topLevelIndex,
      bodyError,
      message: `Step ${topLevelIndex + 1}: TRY body failed, running recover`,
    });

    if (isAborted()) return { status: 'aborted' };

    const recoverResult = await ExecutionEngine.#executeBodyWithIterationLabel(
      node.recover ?? [], ctx, { topLevelIndex, iterationLabel, iteration }
    );

    if (recoverResult.status === 'ok') {
      Logger.info('ExecutionEngine', `TRY${label} — recover succeeded, swallowing failure`);
      emit({
        type: 'try_complete', stepIdx: topLevelIndex, outcome: 'recovered',
      });
      return { status: 'ok' };
    }

    if (recoverResult.status === 'aborted') return recoverResult;

    // Recover failed — TRY fails. Surface the recover error; include the
    // original body error in the message so the author can see both.
    const recoverError = recoverResult.error ?? 'recover failed';
    Logger.error('ExecutionEngine',
      `TRY${label} — recover failed: ${recoverError} (original body failure: ${bodyError})`);
    emit({
      type: 'try_complete', stepIdx: topLevelIndex, outcome: 'recover_failed',
    });
    return {
      status: 'failed',
      error: `TRY recover failed: ${recoverError}. Original body error: ${bodyError}`,
    };
  }

  /**
   * Pass H3 — Execute a NAVIGATE node. Drives the browser tab.
   *
   * Three modes:
   *   url    — navigate to a URL. URL may be a literal or binding
   *            (strategy_param, iteration_variable). Resolves binding via
   *            the same scope lookup path as fragment bindings so
   *            iteration variables + EXTRACT outputs work identically.
   *   back   — chrome.tabs.goBack(tabId)
   *   reload — chrome.tabs.reload(tabId)
   *
   * Always awaits load completion via #waitForTabReady (internal 30s cap).
   * A URL-mode navigate with an empty resolved URL fails (this catches
   * "binding referred to an undefined strategy_param" at runtime).
   *
   * @private
   */
  static async #executeNavigateNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    const { tabId, scope, isAborted, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    if (isAborted()) return { status: 'aborted' };

    const mode = node.mode;

    // Resolve URL for url-mode. Binding resolution uses the same scope as
    // Fragment param resolution: literal→value, strategy_param→scope.get,
    // iteration_variable→scope.get (FOREACH stack walked top-to-bottom).
    let targetUrl = null;
    if (mode === 'url') {
      const u = node.url ?? {};
      if (u.kind === 'literal') {
        targetUrl = String(u.value ?? '');
      } else if (u.kind === 'strategy_param' || u.kind === 'iteration_variable') {
        const tagged = scope?.get?.(u.name);
        if (tagged === undefined) {
          const errMsg = `Step ${topLevelIndex + 1}: NAVIGATE url binding ${u.kind} "${u.name}" not found in scope`;
          Logger.error('ExecutionEngine', `NAVIGATE${label} — ${errMsg}`);
          return { status: 'failed', error: errMsg };
        }
        if (typeof tagged === 'string') targetUrl = tagged;
        else if (tagged?.kind === 'scalar')  targetUrl = String(tagged.value ?? '');
        else if (tagged?.kind === 'element') targetUrl = String(tagged.selector ?? '');
        else if (tagged?.kind === 'list') {
          const errMsg = `Step ${topLevelIndex + 1}: NAVIGATE cannot use list binding "${u.name}" as a URL`;
          Logger.error('ExecutionEngine', `NAVIGATE${label} — ${errMsg}`);
          return { status: 'failed', error: errMsg };
        }
        else targetUrl = String(tagged);
      } else {
        return { status: 'failed', error: `Step ${topLevelIndex + 1}: NAVIGATE url has unknown binding kind "${u.kind}"` };
      }

      if (!targetUrl || !targetUrl.trim()) {
        const errMsg = `Step ${topLevelIndex + 1}: NAVIGATE resolved URL is empty`;
        Logger.error('ExecutionEngine', `NAVIGATE${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }

      // v2.59.0 — URL template substitution. After binding resolution,
      // substitute any {name} patterns in the URL with values from scope.
      // Works regardless of how targetUrl was resolved (literal, strategy_param,
      // iteration_variable). Most common use: a literal URL like
      // "https://example.com/{ID}/page" inside a FOREACH body, where ID
      // is the iteration variable.
      //
      // Missing variables fail loudly with the unbound name — silent
      // empty-string substitution would produce confusing URLs like
      // "https://example.com//page" that fail later at network time.
      //
      // Syntax: {name} matches identifier-shaped names (letters, digits,
      // underscore). Literal { in URLs is rare but possible; this matcher
      // requires a closing } and a non-empty name, so it won't trigger on
      // unmatched braces. Future enhancement could support {{ for escaping.
      const TEMPLATE_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
      const missing = [];
      const substituted = targetUrl.replace(TEMPLATE_RE, (_match, name) => {
        const tagged = scope?.get?.(name);
        if (tagged === undefined) { missing.push(name); return ''; }
        // Coerce via asString so any tagged kind has a sensible string form.
        // Lists join their items by comma — likely not what the author
        // intended in a URL, so flag list values as misuse.
        if (tagged?.kind === 'list') { missing.push(name + ' (is a list)'); return ''; }
        return asString(tagged);
      });
      if (missing.length > 0) {
        const errMsg = `Step ${topLevelIndex + 1}: NAVIGATE URL template references unbound variable(s): ${missing.join(', ')}`;
        Logger.error('ExecutionEngine', `NAVIGATE${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }
      targetUrl = substituted;
    }

    const description =
      mode === 'url'  ? `url=${targetUrl}` :
      mode === 'back' ? 'back' :
                        'reload';
    Logger.info('ExecutionEngine', `NAVIGATE${label} — ${description}`);
    emit({
      type: 'navigate_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      mode, url: targetUrl,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: NAVIGATE ${description}`,
    });

    // Issue the browser action.
    try {
      if (mode === 'url') {
        await new Promise((resolve, reject) => {
          chrome.tabs.update(tabId, { url: targetUrl }, () => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve();
          });
        });
      } else if (mode === 'back') {
        await new Promise((resolve, reject) => {
          chrome.tabs.goBack(tabId, () => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve();
          });
        });
      } else if (mode === 'reload') {
        await new Promise((resolve, reject) => {
          chrome.tabs.reload(tabId, {}, () => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            resolve();
          });
        });
      }
    } catch (err) {
      const errMsg = `Step ${topLevelIndex + 1}: NAVIGATE ${mode} failed: ${err.message ?? err}`;
      Logger.error('ExecutionEngine', `NAVIGATE${label} — ${errMsg}`);
      emit({ type: 'navigate_complete', stepIdx: topLevelIndex, outcome: 'failed', error: err.message ?? String(err) });
      return { status: 'failed', error: errMsg };
    }

    // Wait for load completion (30s internal cap). Abort is checked after.
    await ExecutionEngine.#waitForTabReady(tabId);

    if (isAborted()) return { status: 'aborted' };

    Logger.info('ExecutionEngine', `NAVIGATE${label} — complete`);
    emit({ type: 'navigate_complete', stepIdx: topLevelIndex, outcome: 'ok' });
    return { status: 'ok' };
  }

  /**
   * v2.71.0 — Execute a SCROLL node. Selectorless strategy-level scroll.
   *
   * Resolves distance via the same binding pattern as NAVIGATE's URL
   * (literal | strategy_param | iteration_variable). Distance is in
   * signed viewports — +1.0 = one screen down, -0.5 = half screen up.
   *
   * Dispatches to content script which performs the smooth scroll and
   * waits for scrollend. Engine timeout fallback caps wait at 4s.
   *
   * Sanity-cap of ±100 viewports applied at runtime as defense-in-depth
   * (validator catches it for literal values; runtime catches for
   * binding-resolved values).
   *
   * @private
   */
  static async #executeScrollNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    const { tabId, scope, isAborted, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    if (isAborted()) return { status: 'aborted' };

    // Resolve the distance binding to a number.
    const d = node.distance ?? {};
    let rawValue;
    if (d.kind === 'literal') {
      rawValue = String(d.value ?? '');
    } else if (d.kind === 'strategy_param' || d.kind === 'iteration_variable') {
      const tagged = scope?.get?.(d.name);
      if (tagged === undefined) {
        const errMsg = `Step ${topLevelIndex + 1}: SCROLL distance binding ${d.kind} "${d.name}" not found in scope`;
        Logger.error('ExecutionEngine', `SCROLL${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }
      if (typeof tagged === 'string' || typeof tagged === 'number') {
        rawValue = String(tagged);
      } else if (tagged?.kind === 'scalar') {
        rawValue = String(tagged.value ?? '');
      } else {
        const errMsg = `Step ${topLevelIndex + 1}: SCROLL distance binding "${d.name}" is kind=${tagged?.kind ?? typeof tagged}, expected scalar`;
        Logger.error('ExecutionEngine', `SCROLL${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }
    } else {
      return { status: 'failed', error: `Step ${topLevelIndex + 1}: SCROLL distance has unknown binding kind "${d.kind}"` };
    }

    const viewports = Number(rawValue.trim());
    if (!Number.isFinite(viewports)) {
      const errMsg = `Step ${topLevelIndex + 1}: SCROLL resolved distance "${rawValue}" is not a number`;
      Logger.error('ExecutionEngine', `SCROLL${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }
    if (Math.abs(viewports) > 100) {
      const errMsg = `Step ${topLevelIndex + 1}: SCROLL distance ${viewports} exceeds sanity cap (±100 viewports)`;
      Logger.error('ExecutionEngine', `SCROLL${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    Logger.info('ExecutionEngine', `SCROLL${label} — by ${viewports} viewport(s)`);
    emit({
      type: 'scroll_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      viewports,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: SCROLL by ${viewports} viewport(s)`,
    });

    // Content script handler does smooth scroll + scrollend wait. Engine-side
    // timeout = 4s as a safety net (smooth-scroll over ~500ms typical, plus
    // browser scrollend latency, plus any onscroll handlers).
    const SCROLL_TIMEOUT_MS = 4000;
    let result;
    let timeoutHandle = null;
    try {
      const sendPromise = new Promise((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, {
          type: 'agent_hub_scroll',
          viewports,
        }, (response) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve(response);
        });
      });
      const timeoutPromise = new Promise((_resolve, reject) => {
        // v2.71.10 (Bug A fix) — Capture handle so we can clear the timer
        // when sendPromise wins the race. Pre-v2.71.10, the setTimeout fired
        // ~4s after a successful SCROLL, calling reject() on an already-
        // resolved Promise (no-op but pins the service worker idle timer
        // for an extra 4s per SCROLL). In long LOOPs this accumulated.
        timeoutHandle = setTimeout(
          () => reject(new Error(`SCROLL timed out after ${SCROLL_TIMEOUT_MS}ms`)),
          SCROLL_TIMEOUT_MS
        );
      });
      result = await Promise.race([sendPromise, timeoutPromise]);
    } catch (err) {
      if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
      const errMsg = `Step ${topLevelIndex + 1}: SCROLL failed: ${err.message ?? err}`;
      Logger.error('ExecutionEngine', `SCROLL${label} — ${errMsg}`);
      emit({ type: 'scroll_complete', stepIdx: topLevelIndex, outcome: 'failed', error: err.message ?? String(err) });
      return { status: 'failed', error: errMsg };
    }
    // Success path — clear pending timeout to avoid worker idle pinning.
    if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }

    if (isAborted()) return { status: 'aborted' };

    if (!result || !result.success) {
      const errMsg = `Step ${topLevelIndex + 1}: SCROLL failed: ${result?.error ?? 'no response from content script'}`;
      Logger.error('ExecutionEngine', `SCROLL${label} — ${errMsg}`);
      emit({ type: 'scroll_complete', stepIdx: topLevelIndex, outcome: 'failed', error: result?.error ?? 'no response' });
      return { status: 'failed', error: errMsg };
    }

    Logger.info('ExecutionEngine', `SCROLL${label} — complete`);
    emit({ type: 'scroll_complete', stepIdx: topLevelIndex, outcome: 'ok' });
    return { status: 'ok' };
  }

  /**
   * v2.72.3 (Pass 4) — Execute an OBSERVATION node.
   *
   * Flow:
   *   1. Resolve the Observation record from storage by id.
   *   2. (Future) substitute params into target/fields/pre/post selectors.
   *      3a-era observations have no params, so this is a no-op for now.
   *   3. (Future) evaluate page-side preconditions. 3a-era observations
   *      have empty preconditions arrays, so this collapses to ok.
   *   4. Send the shape-appropriate OBSERVE message to the content script.
   *      Content script does the DOM read and returns extracted data.
   *   5. Wrap the extracted data into a tagged scope value (scalar/list/record)
   *      per the Observation's shape.
   *   6. Bind to scope under observation.output.
   *   7. (Future) evaluate data-side postconditions. Same as preconditions —
   *      collapses to ok when empty.
   *
   * Pre/post evaluation is wired in at the right structural points but
   * gated on non-empty arrays. When Pass 3d adds authoring for pre/post,
   * those branches activate without further runtime changes.
   *
   * @private
   */
  static async #executeObservationNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    const { tabId, scope, isAborted, emit: __rawEmit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    // v2.74.151 / v2.74.153 — Debug-mode page overlay. When the workflow
    // is running under a debugger sidepanel (ctx.debug envelope attached),
    // send a picker-style highlight to the content script so whoever's
    // watching the target tab can see which region is being observed.
    // Fire-and-forget; cheap; never blocks runtime.
    //
    // Why the check is just `!!ctx.debug` (with the explicit-off guard):
    //   The two callers that attach a debug envelope structure it
    //   differently:
    //     • CapabilityAPI.#startInvocation (strategy-debug path) sets
    //       `pauseMode: 'after-node'` plus the polling callbacks.
    //     • background.js INVOKE_WORKFLOW (workflow-debug path) attaches
    //       isPaused / requestPause / consumeStepRequest / isBreakpoint
    //       BUT no pauseMode field — the Workflow runtime never uses one.
    //   v2.74.151 gated on `pauseMode !== 'off'`, which silently locked
    //   out the workflow-debug case (pauseMode undefined → check failed).
    //   v2.74.153 mirrors WorkflowExecutor's own debug detection: envelope
    //   present is sufficient. The explicit `pauseMode === 'off'` opt-out
    //   is preserved so callers can attach a no-op envelope without
    //   accidentally turning the overlay on.
    //
    // Wrapping the local `emit` instead of touching every
    // observation_complete site keeps cleanup automatic — success and
    // failure paths all emit observation_complete, so the shadowed emit
    // sends HIDE on all of them.
    const debugActive = !!ctx.debug && ctx.debug.pauseMode !== 'off';
    let overlayShown = false;
    const sendOverlayMsg = (type, payload) => {
      if (!debugActive || tabId == null) return;
      try {
        chrome.tabs.sendMessage(
          tabId,
          { type, payload: payload ?? {} },
          { frameId: 0 },
          () => { void chrome.runtime.lastError; }
        );
      } catch { /* ignore — overlay is best-effort */ }
    };
    const emit = (event) => {
      if (event?.type === 'observation_complete' && overlayShown) {
        overlayShown = false;
        sendOverlayMsg('HIDE_OBSERVATION_OVERLAY', null);
      }
      __rawEmit(event);
    };

    if (isAborted()) return { status: 'aborted' };

    // Resolve Observation record.
    const observationId = node.observationId;
    if (!observationId) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION: observationId missing`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }
    let observation;
    try {
      observation = await StorageManager.getObservation(observationId);
    } catch (err) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION: storage read failed: ${err.message ?? err}`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }
    if (!observation) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observationId} not found`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    // v2.72.11 (Pass 8) — Tier dispatch. Read implementations[0] and
    // dispatch by tier. Cache tier (the existing behavior) hoists
    // target/extract/fields from impl onto the working copy so the
    // downstream extraction code reads from a single shape.
    //
    // Defensive fallback: if implementations is somehow absent (record
    // bypassed migration), treat top-level fields as a cache impl. Storage
    // migration normally guarantees the implementations array exists.
    const impl = (Array.isArray(observation.implementations) && observation.implementations.length > 0)
      ? observation.implementations[0]
      : { tier: 'cache', target: observation.target, extract: observation.extract, fields: observation.fields };
    const tier = impl?.tier ?? 'cache';

    if (tier === 'frontier') {
      // v2.72.12 (Pass 9) — Frontier-tier delegation. The frontier path
      // captures a screenshot, calls the vision LLM for coordinates, crops
      // client-side, and binds image(s) to scope. Distinct enough from the
      // cache path (no querySelector-based extraction; image scope value;
      // different paramBindings substitution targets) to warrant its own
      // method.
      return await ExecutionEngine.#executeObservationFrontier(
        node, ctx, observation, impl,
        { topLevelIndex, iterationLabel, iteration, label, observationId }
      );
    }

    if (tier !== 'cache') {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: unknown tier "${tier}"`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      return { status: 'failed', error: errMsg };
    }

    // v2.72.7 (Pass 3e) — Resolve paramBindings + substitute {{NAME}}
    // placeholders. Observation-level params declare which {{PARAM}} tokens
    // appear in any extract's selector or in pre/post conditions. The
    // substitution closure (`sub`) is captured below and applied lazily
    // per extract.
    const declaredParams = Array.isArray(observation.params) ? observation.params : [];
    const paramBindings = (node.paramBindings && typeof node.paramBindings === 'object') ? node.paramBindings : {};
    const bindings = ExecutionEngine.#resolveFragmentBindings(paramBindings, scope);
    for (const p of declaredParams) {
      if (bindings[p] === undefined) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION param "${p}" is not bound — strategy node missing paramBindings entry, or a referenced strategy_param is unbound`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'param_resolution', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    Logger.info('ExecutionEngine', `OBSERVATION${label} — ${observation.name ?? observationId} (${(impl?.extracts ?? []).length} extract(s))`);
    emit({
      type: 'observation_start',
      stepIdx: topLevelIndex,
      totalSteps: topLevelTotal,
      observationId,
      observationName: observation.name ?? observationId,
      // Single-shape vocabulary kept for upstream UI compatibility — first
      // extract's shape stands in. Multi-extract Observations report the
      // full per-extract list at observation_complete.
      shape: impl?.extracts?.[0]?.shape ?? null,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: OBSERVATION ${observation.name ?? observationId}`,
    });

    // ── v2.74.15 (Ship A) — Multi-extract cache-tier Observation ─────────
    //
    // Schema (post-Ship-A):
    //   implementations: [{
    //     tier: 'cache',
    //     extracts: [
    //       { shape, target, output, extract?, fields? },
    //       ...
    //     ]
    //   }]
    //
    // Flow:
    //   1. Resolve paramBindings + substitute {{PARAM}} into all extract
    //      selectors and pre/post conditions.
    //   2. Run preconditions (page-level, same condition vocab as
    //      Fragments). Empty array no-ops; a failure aborts the
    //      Observation before any extract runs.
    //   3. For each extract: dispatch by shape, send to content script,
    //      wrap result, bind to scope under extract.output. A single
    //      extract failure aborts the Observation. Earlier-bound extract
    //      values stay in scope (the strategy step returns failed and
    //      the run is discarded anyway, so rollback is a non-issue).
    //   4. Run postconditions (page-level, same vocab as preconditions).
    //      Observations don't mutate the page — postconds confirm the
    //      page didn't drift during the read. No data assertion on bound
    //      values; verify is what catches data-shape problems at author
    //      time.
    //
    // Keep `observation` as the parent record (name/preconditions/etc).
    // Each extract's spec is read from `impl.extracts[i]` directly.

    if (!Array.isArray(impl.extracts) || impl.extracts.length === 0) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observationId} has no extracts`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'precheck', error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }

    // Build the substitution function once. Cache-tier observations may
    // reference {{PARAM}} in any extract's target / extract.attr / fields[].
    // The same `obs` working copy is used for the parent's pre/postconditions.
    const sub = (declaredParams.length === 0)
      ? (val) => val
      : (val) => ExecutionEngine.#substituteAnalysisParams(val, bindings);
    const obsForConds = {
      ...observation,
      preconditions : sub(observation.preconditions),
      postconditions: sub(observation.postconditions),
    };

    // Preconditions (page-level).
    const preconds = Array.isArray(obsForConds.preconditions) ? obsForConds.preconditions : [];
    if (preconds.length > 0) {
      const preProbe = await TemplateWalker.checkConditions({
        tabId,
        conditions: preconds,
        scope,
      });
      if (!preProbe.ok) {
        const f = preProbe.failures?.[0] ?? {};
        const condDesc = f.condition?.type ?? 'unknown';
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION precondition failed (${condDesc}): ${f.reason ?? 'no detail'}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'precondition', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // v2.74.151 — Show the debug-mode overlay now (preconditions passed,
    // we're about to actually read the page). The overlay carries the
    // observation name plus a stripped-down per-extract payload so the
    // content script can highlight selectors / rects. Selectors get the
    // {{PARAM}} substitution applied so the highlight matches what the
    // dispatcher will query.
    if (debugActive && tabId != null) {
      const overlayExtracts = impl.extracts.map(ex => ({
        output : ex.output ?? null,
        shape  : ex.shape  ?? null,
        target : typeof ex.target === 'string' ? sub(ex.target) : null,
        rect   : (ex.rect && Number.isFinite(ex.rect.width) && Number.isFinite(ex.rect.height))
                  ? { x: ex.rect.x, y: ex.rect.y, width: ex.rect.width, height: ex.rect.height }
                  : null,
      }));
      sendOverlayMsg('SHOW_OBSERVATION_OVERLAY', {
        name      : observation.name ?? observationId,
        stepLabel : `Step ${topLevelIndex + 1}/${topLevelTotal}${iterationLabel ? ' ' + iterationLabel : ''}`,
        extracts  : overlayExtracts,
      });
      overlayShown = true;
    }

    // v2.74.195 — Extract gate flattening. Mirrors fragment-author's
    // ACTION_GATE evaluation: walk impl.extracts, for each gate
    // evaluate its header condition NOW (against the live page +
    // current scope), and either splice the body[] into the
    // effective extract list (gate ran) or skip it entirely (gate
    // didn't run). Result: a flat extractsToRun array the existing
    // dispatch loop iterates without any per-iteration gate
    // bookkeeping. Conditions support {{PARAM}} substitution from the
    // Observation's declared params — same `sub` helper extracts use.
    const extractsToRun = [];
    for (const exRaw of impl.extracts) {
      if (exRaw?.shape !== 'extract_gate') {
        extractsToRun.push(exRaw);
        continue;
      }
      // Substitute condition fields (selector/text/value/attribute carry
      // params; pattern is a regex literal, untouched). frameUrl is a
      // routing hint — also untouched.
      const condRaw = exRaw.condition ?? {};
      const probedCond = {
        ...condRaw,
        selector : typeof condRaw.selector  === 'string' ? sub(condRaw.selector)  : condRaw.selector,
        text     : typeof condRaw.text      === 'string' ? sub(condRaw.text)      : condRaw.text,
        attribute: typeof condRaw.attribute === 'string' ? sub(condRaw.attribute) : condRaw.attribute,
        value    : typeof condRaw.value     === 'string' ? sub(condRaw.value)     : condRaw.value,
      };
      // v2.74.201 — Optional `waitTimeout` (ms). When > 0, the gate's
      // condition is retried via checkConditions's built-in retry
      // loop until satisfied OR timeout elapsed. The "wait then
      // extract" pattern (the user's chat-extraction case) becomes
      // expressible: gate condition = "Stop generating button gone",
      // waitTimeout = 30000, body = extract the reply. The extract
      // only runs once the bot is settled.
      const gateWaitTimeout = Number.isFinite(exRaw.waitTimeout) && exRaw.waitTimeout > 0
        ? exRaw.waitTimeout : 0;
      let satisfied = false;
      let probe = null;
      const probeStart = Date.now();
      try {
        probe = await TemplateWalker.checkConditions({
          tabId,
          conditions: [probedCond],
          scope,
          timeoutMs: gateWaitTimeout,
        });
        satisfied = !!probe?.ok;
      } catch (err) {
        Logger.error('ExecutionEngine', `OBSERVATION${label} — extract_gate condition check threw: ${err.message ?? err}`);
        satisfied = false;
      }
      const probeElapsed = Date.now() - probeStart;
      const negate    = !!exRaw.negate;
      const shouldRun = negate ? !satisfied : satisfied;
      Logger.info('ExecutionEngine', `OBSERVATION${label} — extract_gate: type=${probedCond.type} satisfied=${satisfied} negate=${negate} elapsed=${probeElapsed}ms → ${shouldRun ? 'RUN body' : 'SKIP body'}`, {
        condition    : probedCond,
        probeFailures: probe?.failures ?? null,
        waitTimeout  : gateWaitTimeout || null,
        elapsedMs    : probeElapsed,
        attempts     : probe?.attempts ?? 1,
      });
      emit({
        type: 'extract_gate_result',
        stepIdx: topLevelIndex,
        observationId,
        observationName: observation.name ?? observationId,
        conditionType: probedCond.type,
        satisfied,
        negate,
        shouldRun,
        probeFailures: probe?.failures ?? null,
        // v2.74.201 — Wait diagnostics for downstream telemetry.
        waitTimeout: gateWaitTimeout || null,
        elapsedMs  : probeElapsed,
        attempts   : probe?.attempts ?? 1,
      });
      if (shouldRun) {
        const body = Array.isArray(exRaw.body) ? exRaw.body : [];
        // v2.74.206 — Inherit the gate condition's frameUrl onto body
        // subs that don't have their own. Body sub authoring has no
        // picker (v1) so hand-typed selectors never get a frame
        // assigned — but the body almost always lives in the same
        // frame as the condition (gate evaluates iframe state →
        // body reads from that same iframe). Without inheritance,
        // the OBSERVE_* dispatch routes to top frame and the
        // iframe-scoped selector fails. Matches the authoring-time
        // verify fix in observation-author.js.
        const condFrameUrl = condRaw?.frameUrl;
        for (const bodySub of body) {
          if (!bodySub.frameUrl && condFrameUrl) {
            extractsToRun.push({ ...bodySub, frameUrl: condFrameUrl });
          } else {
            extractsToRun.push(bodySub);
          }
        }
      }
    }

    // Loop extracts. Each is dispatched by shape; results are wrapped and
    // bound. Earlier extract bindings remain in scope on later failure
    // (acceptable per Ship A design — strategy step fails, run discards).
    const sourceUrlForBindings = await ExecutionEngine.#getTabUrl(tabId);
    const summaries = [];

    for (let exIdx = 0; exIdx < extractsToRun.length; exIdx++) {
      if (isAborted()) return { status: 'aborted' };
      const exRaw = extractsToRun[exIdx];
      // Substitute selectors per extract.
      const ex = {
        ...exRaw,
        target : sub(exRaw.target ?? ''),
        extract: exRaw.extract ? sub(exRaw.extract) : exRaw.extract,
        fields : Array.isArray(exRaw.fields) ? sub(exRaw.fields) : exRaw.fields,
      };

      // Per-extract sanity check.
      if (typeof ex.shape !== 'string' || ex.shape.length === 0) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] missing shape`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'extract_validation', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      // v2.74.19 — image_snap doesn't reference the DOM; it captures by
      // coordinate. Skip the target check; instead require ex.rect.
      // v2.74.51 — image_full skips the target check too; it captures
      // the entire visible viewport with no required sub-fields.
      if (ex.shape === 'image_snap') {
        if (!ex.rect || !(ex.rect.width > 0) || !(ex.rect.height > 0)) {
          const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (image_snap) missing or empty rect`;
          Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
          emit({
            type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
            observationId, observationName: observation.name ?? observationId,
            phase: 'extract_validation', error: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }
      } else if (ex.shape === 'image_full') {
        // No required sub-fields beyond output (checked below).
      } else if (ex.shape === 'image_read') {
        // v2.74.62 — Validate rect + description (same shape Observation
        // validateObservation enforces at save time, repeated here so
        // a malformed record fails fast at execute time).
        if (!ex.rect || !(ex.rect.width > 0) || !(ex.rect.height > 0)) {
          const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (image_read) missing or empty rect`;
          Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
          emit({
            type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
            observationId, observationName: observation.name ?? observationId,
            phase: 'extract_validation', error: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }
        if (typeof ex.description !== 'string' || ex.description.trim() === '') {
          const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (image_read) missing description`;
          Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
          emit({
            type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
            observationId, observationName: observation.name ?? observationId,
            phase: 'extract_validation', error: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }
      } else if (typeof ex.target !== 'string' || ex.target.length === 0) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (${ex.shape}) missing target`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'extract_validation', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      if (typeof ex.output !== 'string' || ex.output.length === 0) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (${ex.shape}) missing output binding name`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'extract_validation', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }

      // Build the content-script message per shape.
      let msg;
      switch (ex.shape) {
        // v2.74.131 — Canonical text-capture shapes. Both route to the
        // same content-script handlers that the legacy predecessors used;
        // only the authoring storage shape changed.
        case 'text':
          msg = { type: 'OBSERVE_RAW_TEXT',   payload: { target: ex.target } };
          break;
        // v2.74.214 — text_last: same handler as text, but a `pickLast`
        // flag tells the content script to read the LAST matching
        // element (querySelectorAll, take .length-1) instead of the
        // first. Built for chat reply / log tail / notification stream
        // extraction where the relevant content is always the most
        // recently rendered match.
        case 'text_last':
          msg = { type: 'OBSERVE_RAW_TEXT',   payload: { target: ex.target, pickLast: true } };
          break;
        // v2.74.219 — click_copy: click a copy-to-clipboard button and
        // return navigator.clipboard.readText(). Format-agnostic chat
        // reply extraction — HubSpot/ChatGPT/Claude/Slack all ship
        // per-message copy buttons that serialize the reply in its
        // canonical form (text → plain text, CSV → CSV, code → code).
        // Requires "clipboardRead" permission (added in v2.74.219).
        case 'click_copy':
          msg = { type: 'OBSERVE_CLICK_COPY', payload: { target: ex.target, waitAfterClick: ex.waitAfterClick ?? 150 } };
          break;
        // v2.74.222 — click_copy_last: same as click_copy but content
        // script picks the LAST querySelectorAll match (latest AI
        // message's copy button).
        case 'click_copy_last':
          msg = { type: 'OBSERVE_CLICK_COPY', payload: { target: ex.target, waitAfterClick: ex.waitAfterClick ?? 150, pickLast: true } };
          break;
        case 'attribute':
          msg = { type: 'OBSERVE_SCALAR',     payload: { target: ex.target, extract: { kind: 'attribute', name: ex.attribute } } };
          break;
        // Legacy shapes — kept for records that haven't yet been
        // migrated through StorageManager.#migrateObservationShape.
        case 'scalar':
          msg = { type: 'OBSERVE_SCALAR',     payload: { target: ex.target, extract: ex.extract ?? { kind: 'text' } } };
          break;
        case 'raw_text':
          msg = { type: 'OBSERVE_RAW_TEXT',   payload: { target: ex.target } };
          break;
        case 'raw_html':
          msg = { type: 'OBSERVE_RAW_HTML',   payload: { target: ex.target } };
          break;
        case 'list_of_records':
          msg = { type: 'OBSERVE_LIST',       payload: { target: ex.target, fields: Array.isArray(ex.fields) ? ex.fields : [] } };
          break;
        case 'section':
          msg = { type: 'OBSERVE_SECTION',    payload: { target: ex.target } };
          break;
        case 'image_refs':
          msg = { type: 'OBSERVE_IMAGE_REFS', payload: { target: ex.target } };
          break;
        case 'image':
          msg = { type: 'OBSERVE_IMAGE_T1',      payload: { target: ex.target } };
          break;
        case 'image_list':
          msg = { type: 'OBSERVE_IMAGE_LIST_T1', payload: { target: ex.target } };
          break;
        case 'image_snap':
          // v2.74.19 — Free-extract / image_snap. Captured via background's
          // OBSERVE_IMAGE_SNAP_BG (chrome.tabs.captureVisibleTab + crop)
          // rather than a content-script OBSERVE_*. msg stays null; the
          // dispatch branch below routes accordingly.
          msg = null;
          break;
        case 'image_full':
          // v2.74.51 — Full-tab screenshot. Routes through background's
          // OBSERVE_IMAGE_FULL_BG. msg stays null; dispatch branch
          // below picks the right channel based on shape.
          msg = null;
          break;
        case 'image_read':
          // v2.74.62 — Cropped screenshot + Claude vision. Routes
          // through OBSERVE_IMAGE_READ_BG. msg null; dispatch below.
          msg = null;
          break;
        default: {
          const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] unknown shape "${ex.shape}"`;
          Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
          emit({
            type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
            observationId, observationName: observation.name ?? observationId,
            phase: 'extract_validation', error: errMsg,
          });
          return { status: 'failed', error: errMsg };
        }
      }

      // Per-shape timeout. Multi-element scans get longer than scalar reads.
      // image_read involves a Claude vision API call which routinely takes
      // 10–15s, so it gets the section-tier allowance.
      const TIMEOUT_MS = ex.shape === 'section' || ex.shape === 'image_read'
        ? 30000
        : (ex.shape === 'list_of_records' || ex.shape === 'image_refs' || ex.shape === 'image_list')
          ? 10000
          : 5000;

      let result;
      let timeoutHandle = null;
      try {
        let sendPromise;
        if (ex.shape === 'image_snap') {
          // v2.74.146 — Call performImageSnap directly. Same SW-self-
          // messaging fix as image_read (see comment below); the snap
          // path is fast enough that the race rarely manifests, but the
          // antipattern is identical and worth removing.
          sendPromise = performImageSnap({
            tabId,
            rect    : ex.rect,
            scrollY : ex.scrollY ?? 0,
            viewport: ex.viewport ?? null,
          });
        } else if (ex.shape === 'image_full') {
          // v2.74.146 — Call performImageFull directly (same reason).
          sendPromise = performImageFull({ tabId });
        } else if (ex.shape === 'image_read') {
          // v2.74.145 — Call the shared image_read helper directly.
          //
          // ExecutionEngine runs INSIDE the background service worker, so
          // the previous `chrome.runtime.sendMessage` self-dispatch was a
          // SW-to-itself message. In MV3 module SWs that pattern is
          // unreliable: the response port frequently closes immediately
          // with "The message port closed before a response was received"
          // because there's no separate receiving context to keep the
          // port alive while Claude's vision call (10–15s) is in flight.
          //
          // Calling performImageRead directly skips chrome.runtime
          // entirely. The helper returns the same { success, items,
          // dataUrl, width, height } shape the old message handler did,
          // so the downstream result wrapping below stays unchanged.
          sendPromise = performImageRead({
            tabId,
            rect        : ex.rect,
            scrollY     : ex.scrollY ?? 0,
            viewport    : ex.viewport ?? null,
            description : ex.description ?? '',
          });
        } else {
          // v2.74.198 — Resolve the iframe frame for this extract.
          // Picker writes ex.frameUrl when the selector was picked
          // inside an iframe; runtime needs to dispatch the OBSERVE
          // message to that frame's content script. Without this,
          // sendMessage with no frameId broadcasts to every frame
          // and the top frame's "not found" response races the
          // iframe's real result — usually the iframe loses.
          // _resolveFrameId returns TOP_FRAME_ID (0) when frameUrl
          // is absent or the iframe is gone, preserving back-compat
          // for legacy records.
          const extractFrameId = await TemplateWalker._resolveFrameId(tabId, ex.frameUrl);
          sendPromise = new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, msg, { frameId: extractFrameId }, (response) => {
              if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
              resolve(response);
            });
          });
        }
        const timeoutPromise = new Promise((_resolve, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error(`OBSERVE timed out after ${TIMEOUT_MS}ms`)),
            TIMEOUT_MS
          );
        });
        result = await Promise.race([sendPromise, timeoutPromise]);
      } catch (err) {
        if (timeoutHandle) { clearTimeout(timeoutHandle); }
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (${ex.shape}) failed: ${err.message ?? err}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'extract_dispatch', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
      if (timeoutHandle) { clearTimeout(timeoutHandle); }

      if (isAborted()) return { status: 'aborted' };
      if (!result || !result.success) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (${ex.shape}) failed: ${result?.error ?? 'no response from content script'}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'extract_dispatch', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }

      // Wrap + bind. Each shape produces its own tagged scope value.
      let taggedValue;
      let summary = '';
      // v2.74.154 — Optional per-extract LLM metadata sidecar (image_read
      // populates it with confidence / rationale / cost / usage / model;
      // other shapes leave it null). Threaded onto summaries below.
      let extractMeta = null;
      try {
        // v2.74.131 — `text` and `attribute` join the single-string cluster.
        // Legacy `scalar`/`raw_text` still match for records that haven't
        // been migrated to the new shape names.
        if (ex.shape === 'text' || ex.shape === 'attribute' ||
            ex.shape === 'scalar' || ex.shape === 'raw_text' || ex.shape === 'raw_html') {
          taggedValue = scalar(result.value ?? '');
          summary = String(result.value ?? '').slice(0, 60);
        } else if (ex.shape === 'list_of_records') {
          const items = Array.isArray(result.items) ? result.items : [];
          taggedValue = list(items.map(item => record(item.record ?? item)));
          summary = `${items.length} record(s)`;
        } else if (ex.shape === 'section') {
          const sec = result.section ?? {};
          const taggedImages = list((Array.isArray(sec.images) ? sec.images : []).map(r => record(r)));
          const taggedLinks  = list((Array.isArray(sec.links)  ? sec.links  : []).map(r => record(r)));
          taggedValue = section({
            markdown: sec.markdown ?? '',
            text    : sec.text ?? '',
            images  : taggedImages,
            links   : taggedLinks,
            sourceUrl: sourceUrlForBindings,
          });
          summary = `section: ${(sec.images ?? []).length} image(s), ${(sec.links ?? []).length} link(s)`;
        } else if (ex.shape === 'image_refs') {
          const items = Array.isArray(result.images) ? result.images : [];
          taggedValue = list(items.map(r => record(r)));
          summary = `${items.length} image ref(s)`;
        } else if (ex.shape === 'image') {
          const im = result.image ?? {};
          taggedValue = image({
            src: im.src ?? '',
            alt: im.alt ?? '',
            width: im.width,
            height: im.height,
            sourceUrl: sourceUrlForBindings,
          });
          summary = im.src ? `<img src="${String(im.src).slice(0, 60)}">` : '<img>';
        } else if (ex.shape === 'image_list') {
          const items = Array.isArray(result.images) ? result.images : [];
          taggedValue = list(items.map(im => image({
            src: im.src ?? '',
            alt: im.alt ?? '',
            width: im.width,
            height: im.height,
            sourceUrl: sourceUrlForBindings,
          })));
          summary = `${items.length} image(s)`;
        } else if (ex.shape === 'image_snap') {
          // v2.74.19 — Free-extract result. Background returns
          // { dataUrl, width, height, cssWidth, cssHeight }. Tag as image
          // with src = the data URL. Width/height are the captured-pixel
          // dimensions (scaled by DPR). cssWidth/cssHeight are the
          // original CSS px from the rect.
          taggedValue = image({
            src       : result.dataUrl ?? '',
            alt       : '',
            width     : result.width  ?? null,
            height    : result.height ?? null,
            sourceUrl : sourceUrlForBindings,
          });
          summary = `snap: ${result.cssWidth ?? '?'}×${result.cssHeight ?? '?'} (captured ${result.width ?? '?'}×${result.height ?? '?'} px)`;
        } else if (ex.shape === 'image_full') {
          // v2.74.51 — Full-viewport screenshot. Background returns
          // { dataUrl, width, height } (no cssWidth/cssHeight — there's
          // no rect to scale back from). Tag the same way as image_snap.
          taggedValue = image({
            src       : result.dataUrl ?? '',
            alt       : '',
            width     : result.width  ?? null,
            height    : result.height ?? null,
            sourceUrl : sourceUrlForBindings,
          });
          summary = `full: ${result.width ?? '?'}×${result.height ?? '?'} px`;
        } else if (ex.shape === 'image_read') {
          // Cropped screenshot + Claude-vision-extracted values.
          //
          // v2.74.148 — Cardinality-aware binding:
          //   0 items → empty scalar  (Claude found nothing)
          //   1 item  → scalar value  (single-value prompts work naturally with {{NAME}})
          //   N items → list of scalars (multi-value prompts; FOREACH still works)
          //
          // v2.74.154 — Metadata sidecar. The LLM call returns confidence,
          // rationale, cost, and token usage alongside the items. The
          // BINDING stays as the curated value (above) — these are
          // recorded only as metadata: appended to the per-extract
          // summary so they show in the Logs tab line, and forwarded on
          // the per-extract record so observation_complete consumers
          // (debugger scope view, future cost dashboards) can read them.
          const items = Array.isArray(result.items) ? result.items : [];
          if (items.length === 0) {
            taggedValue = scalar('');
            summary = 'read: 0 values';
          } else if (items.length === 1) {
            const onlyVal = String(items[0] ?? '');
            taggedValue = scalar(onlyVal);
            summary = `read: "${onlyVal.length > 40 ? onlyVal.slice(0, 37) + '…' : onlyVal}"`;
          } else {
            taggedValue = list(items.map(s => scalar(String(s ?? ''))));
            summary = `read: ${items.length} values`;
          }
          // Append cost / confidence to the summary so the Logs-tab
          // OBSERVATION line carries them inline. Both are optional:
          // confidence is null on legacy / non-conforming responses,
          // cost is null if the model isn't in the pricing table.
          const metaParts = [];
          if (typeof result.confidence === 'number') {
            metaParts.push(`confidence=${result.confidence.toFixed(2)}`);
          }
          if (result.cost && typeof result.cost.total === 'number') {
            metaParts.push(`cost=$${result.cost.total.toFixed(5)}`);
          }
          if (metaParts.length > 0) {
            summary += ` (${metaParts.join(', ')})`;
          }
          // Stash full metadata on the per-extract summary record (read
          // out below when building the observation_complete event).
          extractMeta = {
            confidence: typeof result.confidence === 'number' ? result.confidence : null,
            rationale : typeof result.rationale  === 'string' ? result.rationale  : '',
            cost      : result.cost  ?? null,
            usage     : result.usage ?? null,
            model     : result.model ?? null,
          };
        } else {
          const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] unwrapped shape "${ex.shape}"`;
          Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
          return { status: 'failed', error: errMsg };
        }
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: extract[${exIdx}] (${ex.shape}) wrap failed: ${err.message ?? err}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        return { status: 'failed', error: errMsg };
      }

      scope.set(ex.output, taggedValue);
      // v2.74.154 — meta is non-null only for LLM observation shapes
      // (image_read today; frontier-tier observation could opt in
      // later). Downstream consumers ignore it when absent.
      summaries.push({ output: ex.output, shape: ex.shape, summary, meta: extractMeta });
    }

    // Postconditions (page-level — same condition vocab as preconditions).
    const postconds = Array.isArray(obsForConds.postconditions) ? obsForConds.postconditions : [];
    if (postconds.length > 0) {
      const postProbe = await TemplateWalker.checkConditions({
        tabId,
        conditions: postconds,
        scope,
      });
      if (!postProbe.ok) {
        const f = postProbe.failures?.[0] ?? {};
        const condDesc = f.condition?.type ?? 'unknown';
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION postcondition failed (${condDesc}): ${f.reason ?? 'no detail'}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'postcondition', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // v2.74.150 — Surface per-extract summary text in the log line so an
    // author scanning the Logs tab can see what each binding actually
    // captured (e.g. `read: ""` flags an empty image_read result without
    // forcing them to open the scope view). Previously the line only
    // reported a count.
    const summaryDetail = summaries.length === 0
      ? ''
      : ' — ' + summaries.map(s => `${s.output}: ${s.summary}`).join(' | ');
    Logger.info('ExecutionEngine', `OBSERVATION${label} — bound ${summaries.length} extract(s)${summaryDetail}`);
    emit({
      type: 'observation_complete',
      stepIdx: topLevelIndex,
      outcome: 'ok',
      observationId,
      observationName: observation.name ?? observationId,
      // Multi-extract summary: list each output + shape + brief value.
      // The single-extract `output` and `shape` keys remain for backward
      // compatibility with any consumer that expects them — populated
      // from the first extract.
      output: summaries[0]?.output,
      shape : summaries[0]?.shape,
      summary: summaries.length === 1
        ? summaries[0].summary
        : `${summaries.length} extracts: ${summaries.map(s => s.output).join(', ')}`,
      extracts: summaries,
    });
    return { status: 'ok' };
  }

  /**
   * v2.72.12 (Pass 9) — Frontier-tier Observation execution.
   *
   * Flow:
   *   1. Resolve paramBindings → bindings dict.
   *   2. Substitute {{NAME}} into name, description, target hint, pre/post.
   *   3. Pre-flight: every declared param must resolve.
   *   4. Evaluate preconditions against the live page (page-state assertions).
   *   5. Capture screenshot via chrome.tabs.captureVisibleTab.
   *   6. If target hint is set: get target's bounding rect via content
   *      script, crop screenshot to that rect (in device pixels).
   *   7. Send (cropped) screenshot + spec to Anthropic Opus 4.7 with the
   *      OBSERVATION_FRONTIER_VISION_SYSTEM_PROMPT and locate_regions tool.
   *   8. For each returned region: crop the (cropped) screenshot to the
   *      region's normalized coordinates. Wrap as image scope value.
   *   9. Bind:
   *      - shape='image'      → bind a single image value (the first
   *        region; if zero returned, error).
   *      - shape='image_list' → bind a list of image values (zero or more).
   *  10. Evaluate postconditions against bound output.
   *  11. Emit observation_complete with frontier metadata (confidence,
   *      partial_visibility, suggestion).
   *
   * Failure modes surface clearly:
   *   - param_resolution: missing paramBinding
   *   - precondition: page-state check failed
   *   - capture: screenshot or rect-resolution failed
   *   - vision_call: API call returned error or invalid shape
   *   - no_regions: shape='image' but model returned zero regions
   *   - crop: client-side canvas crop threw
   *   - postcondition: post-extraction check failed
   *
   * @private
   */
  static async #executeObservationFrontier(node, ctx, observation, impl, info) {
    const { tabId, scope, isAborted, emit, topLevelTotal } = ctx;
    const { topLevelIndex, label, observationId } = info;

    if (isAborted()) return { status: 'aborted' };

    Logger.info('ExecutionEngine',
      `OBSERVATION${label} — ${observation.name ?? observationId} (frontier, ${observation.shape})`);
    emit({
      type: 'observation_start',
      stepIdx: topLevelIndex,
      totalSteps: topLevelTotal,
      observationId,
      observationName: observation.name ?? observationId,
      shape: observation.shape,
      tier: 'frontier',
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: OBSERVATION ${observation.name ?? observationId} (vision T3)`,
    });

    // Shape sanity. Frontier supports only image / image_list; other shapes
    // are authoring errors caught by the form, but defend at runtime too.
    if (observation.shape !== 'image' && observation.shape !== 'image_list') {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observationId}: frontier-tier requires shape 'image' or 'image_list', got '${observation.shape}'`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'shape_invalid', error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }
    if (!observation.output || typeof observation.output !== 'string') {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observationId}: no output binding name`;
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'output_missing', error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 1+2+3. Resolve paramBindings, substitute, pre-flight ───────────
    const declaredParams = Array.isArray(observation.params) ? observation.params : [];
    const paramBindings = (node.paramBindings && typeof node.paramBindings === 'object') ? node.paramBindings : {};
    const bindings = ExecutionEngine.#resolveFragmentBindings(paramBindings, scope);

    for (const p of declaredParams) {
      if (bindings[p] === undefined) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION param "${p}" is not bound`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'param_resolution', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    // Substituted view of the Observation. Skip substitution entirely if
    // no params declared — same pattern as cache path (avoids stripping
    // literal {{NAME}} text in conditions).
    const sub = (val) => declaredParams.length === 0 ? val : ExecutionEngine.#substituteAnalysisParams(val, bindings);
    const obs = {
      ...observation,
      // Frontier description / name are sent to the LLM as authoring
      // intent. Substitute so {{PARAM}} values appear as live values.
      name           : sub(observation.name),
      description    : sub(observation.description),
      target         : sub(impl.target),  // optional target hint (selector)
      preconditions  : sub(observation.preconditions),
      postconditions : sub(observation.postconditions),
    };

    // ── 4. Preconditions against the live page ────────────────────────
    const preconds = Array.isArray(obs.preconditions) ? obs.preconditions : [];
    if (preconds.length > 0) {
      const preProbe = await TemplateWalker.checkConditions({
        tabId, conditions: preconds, scope,
      });
      if (!preProbe.ok) {
        const f = preProbe.failures?.[0] ?? {};
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION precondition failed (${f.condition?.type ?? 'unknown'}): ${f.reason ?? 'no detail'}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'precondition', error: errMsg,
        });
        return { status: 'failed', error: errMsg };
      }
    }

    if (isAborted()) return { status: 'aborted' };

    // ── 5+6. Capture screenshot, optionally crop to target ────────────
    // v2.72.15 (review fix) — Removed unused cropOffset/cropDims tracking
    // (declared and assigned but never read in the original Pass 9 code).
    // Bitmap dimensions are available via screenshotBitmap.width/height
    // when needed for region coordinate math below.
    let screenshotBitmap;
    let didCropToTarget = false;
    let originalDataUrl = null;   // PNG dataUrl from captureVisibleTab; reused when no crop happens
    let fullBitmap = null;        // Kept across blocks so cleanup at function end can close it

    // v2.72.15 (review fix) — Outer try/finally ensures ImageBitmap.close()
    // is called regardless of how this function exits (success, any of the
    // many failure returns, or an uncaught throw). ImageBitmaps hold backing
    // memory that GC won't reclaim immediately. For long-running strategies
    // with frequent T3 captures, this matters. .close?.() is defensive
    // against older runtimes that lack the method.
    try {
      // Inner try below is the existing capture-block try (returns 'failed'
      // on capture errors via its catch). Outer try (this) wraps everything
      // through the success return; its finally closes ImageBitmaps.
      try {
      // captureVisibleTab requires the tab be in the active window. The
      // tab being inactive is the most common cause of failure here; the
      // engine tab activation logic for SCROLL/CLICK already brings it
      // forward, so by the time an Observation runs the tab is usually
      // active. If not, the chrome.tabs.captureVisibleTab call rejects
      // and we surface a clear error.
      originalDataUrl = await new Promise((resolve, reject) => {
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(`Cannot get tab ${tabId}: ${chrome.runtime.lastError.message}`));
          }
          chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' }, (dataUrl) => {
            if (chrome.runtime.lastError) {
              return reject(new Error(chrome.runtime.lastError.message));
            }
            if (!dataUrl) return reject(new Error('captureVisibleTab returned no data'));
            resolve(dataUrl);
          });
        });
      });

      // Convert data URL to ImageBitmap for canvas operations.
      const fullBlob = await (await fetch(originalDataUrl)).blob();
      fullBitmap = await createImageBitmap(fullBlob);

      // If target hint is set, crop screenshot to that element's rect.
      // Falls back to full screenshot on failure (rect resolution errors
      // shouldn't kill the Observation if the page is otherwise readable).
      if (obs.target && obs.target.trim()) {
        try {
          const rectRes = await new Promise((resolve, reject) => {
            chrome.tabs.sendMessage(tabId, {
              type: 'GET_ELEMENT_RECT',
              payload: { target: obs.target },
            }, (r) => {
              if (chrome.runtime.lastError) {
                return reject(new Error(chrome.runtime.lastError.message));
              }
              resolve(r);
            });
          });
          if (rectRes?.success && rectRes.rect && rectRes.rect.width > 0 && rectRes.rect.height > 0) {
            const dpr = rectRes.devicePixelRatio || 1;
            // CSS pixels → device pixels for crop coordinates. Clamp to
            // bitmap dimensions so we don't crop past the edge.
            const px = Math.max(0, Math.floor(rectRes.rect.x * dpr));
            const py = Math.max(0, Math.floor(rectRes.rect.y * dpr));
            const pw = Math.min(fullBitmap.width  - px, Math.ceil(rectRes.rect.width  * dpr));
            const ph = Math.min(fullBitmap.height - py, Math.ceil(rectRes.rect.height * dpr));
            if (pw > 0 && ph > 0) {
              const canvas = new OffscreenCanvas(pw, ph);
              const cctx = canvas.getContext('2d');
              cctx.drawImage(fullBitmap, px, py, pw, ph, 0, 0, pw, ph);
              screenshotBitmap = await createImageBitmap(canvas);
              didCropToTarget = true;
              Logger.info('ExecutionEngine',
                `OBSERVATION${label} — cropped screenshot to target "${obs.target}": ${pw}x${ph} at (${px},${py})`);
            } else {
              Logger.warn('ExecutionEngine',
                `OBSERVATION${label} — target rect for "${obs.target}" produced 0x0 crop (offscreen?); using full screenshot`);
              screenshotBitmap = fullBitmap;
            }
          } else {
            Logger.warn('ExecutionEngine',
              `OBSERVATION${label} — could not get rect for target "${obs.target}": ${rectRes?.error ?? 'unknown'}; using full screenshot`);
            screenshotBitmap = fullBitmap;
          }
        } catch (rectErr) {
          Logger.warn('ExecutionEngine',
            `OBSERVATION${label} — rect resolution threw for "${obs.target}": ${rectErr.message}; using full screenshot`);
          screenshotBitmap = fullBitmap;
        }
      } else {
        screenshotBitmap = fullBitmap;
      }
    } catch (err) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: screenshot capture failed: ${err.message}`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'capture', error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }

    if (isAborted()) return { status: 'aborted' };

    // Convert the bitmap to base64 PNG for the API call.
    // v2.72.15 (review fix) — When no crop was performed, the original
    // captureVisibleTab dataUrl IS already a PNG base64 — slice off the
    // "data:image/png;base64," prefix instead of re-encoding through the
    // canvas. Saves the cost of drawImage + convertToBlob + FileReader
    // round-trip (~100-300ms) and avoids an unnecessary OffscreenCanvas
    // allocation.
    let screenshotBase64;
    try {
      if (!didCropToTarget && originalDataUrl) {
        // Strip the "data:<mime>;base64," prefix.
        const idx = originalDataUrl.indexOf(',');
        screenshotBase64 = idx >= 0 ? originalDataUrl.slice(idx + 1) : originalDataUrl;
      } else {
        const canvas = new OffscreenCanvas(screenshotBitmap.width, screenshotBitmap.height);
        const cctx = canvas.getContext('2d');
        cctx.drawImage(screenshotBitmap, 0, 0);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        screenshotBase64 = await ExecutionEngine.#blobToBase64(blob);
      }
    } catch (err) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observationId}: screenshot encode failed: ${err.message}`;
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'capture', error: errMsg,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 7. Vision API call ────────────────────────────────────────────
    // Substituted condition descriptions for prompt context. Cheap human
    // formatting — the model uses these as informative context, not as
    // structural constraints (those are checked client-side).
    const preDescr = preconds.length > 0
      ? preconds.map(c => `- ${c.type}${c.selector ? ` "${c.selector}"` : ''}${c.value !== undefined ? ` (value: ${JSON.stringify(c.value)})` : ''}`).join('\n')
      : '';
    const postArr = Array.isArray(obs.postconditions) ? obs.postconditions : [];
    const postDescr = postArr.length > 0
      ? postArr.map(c => `- ${c.type}${c.value !== undefined ? ` (value: ${JSON.stringify(c.value)})` : ''}`).join('\n')
      : '';

    const apiResult = await AnthropicService.invokeObservationFrontier({
      observationName       : obs.name ?? observationId,
      observationDescription: obs.description ?? '',
      shape                 : obs.shape,
      preconditionsDescription : preDescr,
      postconditionsDescription: postDescr,
      targetHint            : obs.target ?? '',
      params                : bindings,
      screenshotBase64,
    });

    if (!apiResult.success) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: vision call failed: ${apiResult.error ?? 'unknown'}`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'vision_call', error: errMsg,
        latencyMs: apiResult.latencyMs, tokensIn: apiResult.tokensIn, tokensOut: apiResult.tokensOut,
      });
      return { status: 'failed', error: errMsg };
    }

    // For shape='image', zero regions is failure (model said the content
    // wasn't present). For shape='image_list', zero is acceptable (empty
    // list of matches).
    if (obs.shape === 'image' && apiResult.regions.length === 0) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: model returned no regions${apiResult.rationale ? ` — ${apiResult.rationale}` : ''}`;
      Logger.warn('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'no_regions', error: errMsg,
        confidence: apiResult.confidence,
        rationale: apiResult.rationale,
        partialVisibility: apiResult.partialVisibility,
        latencyMs: apiResult.latencyMs, tokensIn: apiResult.tokensIn, tokensOut: apiResult.tokensOut,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 8. Crop screenshot per region, build image tagged values ──────
    const sourceUrl = await ExecutionEngine.#getTabUrl(tabId);
    const imageValues = [];
    try {
      for (const r of apiResult.regions) {
        // Convert normalized [0,1] coords to pixel coords within the
        // (cropped) screenshot.
        const sx = Math.floor(r.x1 * screenshotBitmap.width);
        const sy = Math.floor(r.y1 * screenshotBitmap.height);
        const sw = Math.max(1, Math.floor((r.x2 - r.x1) * screenshotBitmap.width));
        const sh = Math.max(1, Math.floor((r.y2 - r.y1) * screenshotBitmap.height));
        const canvas = new OffscreenCanvas(sw, sh);
        const cctx = canvas.getContext('2d');
        cctx.drawImage(screenshotBitmap, sx, sy, sw, sh, 0, 0, sw, sh);
        const blob = await canvas.convertToBlob({ type: 'image/png' });
        const base64 = await ExecutionEngine.#blobToBase64(blob);
        imageValues.push(image({
          base64,
          mime  : 'image/png',
          width : sw,
          height: sh,
          label : r.label,
          sourceUrl,
        }));
      }
    } catch (err) {
      const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION ${observation.name ?? observationId}: crop failed: ${err.message}`;
      Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
        observationId, observationName: observation.name ?? observationId,
        phase: 'crop', error: errMsg,
        latencyMs: apiResult.latencyMs, tokensIn: apiResult.tokensIn, tokensOut: apiResult.tokensOut,
      });
      return { status: 'failed', error: errMsg };
    }

    // ── 9. Bind to scope ──────────────────────────────────────────────
    const taggedValue = obs.shape === 'image'
      ? imageValues[0]                              // single image
      : list(imageValues);                          // image_list
    scope.set(observation.output, taggedValue);

    // ── 10. Postconditions ────────────────────────────────────────────
    if (postArr.length > 0) {
      const postScope = new Scope();
      postScope.set('OUTPUT', taggedValue);
      const postEnvelope = { match: 'all', conditions: postArr };
      let postEnvelopeFlat;
      try {
        postEnvelopeFlat = await flattenScopeAssertionRefs(
          postEnvelope,
          (id) => StorageManager.getAssertion(id)
        );
      } catch (err) {
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION postcondition reference resolution failed — ${err.message}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'postcondition', error: errMsg,
          confidence: apiResult.confidence,
          rationale: apiResult.rationale,
          partialVisibility: apiResult.partialVisibility,
          latencyMs: apiResult.latencyMs, tokensIn: apiResult.tokensIn, tokensOut: apiResult.tokensOut,
        });
        return { status: 'failed', error: errMsg };
      }
      const postResult = evaluateDataAssertionEnvelope(postEnvelopeFlat, postScope);
      if (!postResult.ok) {
        const f = postResult.failures?.[0] ?? {};
        const condDesc = f.cond ? describeDataCondition(f.cond) : 'unknown condition';
        const errMsg = `Step ${topLevelIndex + 1}: OBSERVATION postcondition failed (${condDesc}): ${f.reason ?? 'no detail'}`;
        Logger.error('ExecutionEngine', `OBSERVATION${label} — ${errMsg}`);
        emit({
          type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'failed',
          observationId, observationName: observation.name ?? observationId,
          phase: 'postcondition', condition: f.cond, reason: f.reason, error: errMsg,
          confidence: apiResult.confidence,
          rationale: apiResult.rationale,
          partialVisibility: apiResult.partialVisibility,
          latencyMs: apiResult.latencyMs, tokensIn: apiResult.tokensIn, tokensOut: apiResult.tokensOut,
        });
        return { status: 'failed', error: errMsg };
      }
    }

      // ── 11. Emit success ──────────────────────────────────────────────
      Logger.info('ExecutionEngine',
        `OBSERVATION${label} — bound ${observation.output} (frontier ${obs.shape}, ${imageValues.length} image${imageValues.length === 1 ? '' : 's'})`);
      emit({
        type: 'observation_complete', stepIdx: topLevelIndex, outcome: 'ok',
        observationId, observationName: observation.name ?? observationId,
        output: observation.output,
        shape: obs.shape,
        tier: 'frontier',
        summary: `${imageValues.length} image${imageValues.length === 1 ? '' : 's'} captured (${obs.shape})`,
        confidence: apiResult.confidence,
        rationale: apiResult.rationale,
        partialVisibility: apiResult.partialVisibility,
        latencyMs: apiResult.latencyMs,
        tokensIn: apiResult.tokensIn,
        tokensOut: apiResult.tokensOut,
      });
      return { status: 'ok' };
    } finally {
      // v2.72.15 (review fix) — Release ImageBitmap backing memory.
      // screenshotBitmap may be the same reference as fullBitmap (no-crop
      // path) or a separate cropped bitmap; close each unique reference once.
      try {
        if (fullBitmap) fullBitmap.close?.();
        if (screenshotBitmap && screenshotBitmap !== fullBitmap) screenshotBitmap.close?.();
      } catch (_) { /* defensive — close shouldn't throw, but never let cleanup break the return */ }
    }
  }

  /**
   * v2.72.12 (Pass 9) — Convert a Blob to base64 string (no data: prefix).
   * Used by frontier Observation for screenshot encoding and per-region
   * image bytes. FileReader is available in MV3 service workers.
   * @private
   */
  static #blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const result = reader.result;
        if (typeof result !== 'string') return reject(new Error('FileReader returned non-string'));
        // result is "data:image/png;base64,..." — strip the prefix.
        const idx = result.indexOf(',');
        resolve(idx >= 0 ? result.slice(idx + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('FileReader error'));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * v2.72.12 (Pass 9) — Get the URL of a tab. Used to attach sourceUrl
   * metadata to captured image values. Returns null on failure (sourceUrl
   * is informational, not required).
   * @private
   */
  static async #getTabUrl(tabId) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(t?.url ?? null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  /**
   * Pass J2 (v2.37.0) — Execute an IN_NEW_TAB node.
   *
   * Flow:
   *   1. Install chrome.tabs.onCreated listener, filtered by openerTabId
   *   2. Execute `trigger` on the outer tab (ctx.tabId stays unchanged)
   *   3. Wait for the new tab to appear (5s timeout)
   *   4. Wait for the new tab to finish loading
   *   5. Swap ctx.tabId to newTabId, run `body`
   *   6. Restore ctx.tabId to outerTab
   *   7. Close newTab if closeOnExit
   *
   * Strict failure semantics: if no new tab opens within the timeout, the
   * node fails. Authors who want graceful degradation wrap in TRY.
   *
   * Scope is unchanged across the tab switch — scope is tab-agnostic, so
   * EXTRACTs / EMITs in the body land in the strategy's scope as usual
   * and are visible to subsequent nodes on the outer tab.
   *
   * @private
   */
  static async #executeInNewTabNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    const { tabId: outerTab, isAborted, emit, topLevelTotal } = ctx;
    const label = iterationLabel ? ` ${iterationLabel}` : '';

    if (isAborted()) return { status: 'aborted' };
    if (!node.trigger) {
      return { status: 'failed', error: `Step ${topLevelIndex + 1}: IN_NEW_TAB missing trigger` };
    }

    Logger.info('ExecutionEngine', `IN_NEW_TAB${label} — start (outer tab ${outerTab})`);
    emit({
      type: 'in_new_tab_start', stepIdx: topLevelIndex, totalSteps: topLevelTotal,
      outerTabId: outerTab,
      message: `Step ${topLevelIndex + 1}/${topLevelTotal}: IN_NEW_TAB`,
    });

    // Promise that resolves when a new tab is created with our outer tab as
    // opener. Install BEFORE triggering so we don't race the click's
    // synchronous onCreated fire. Filter: openerTabId match. Some sites
    // open tabs via `window.open` without opener relationship — if that
    // comes up in practice we'll relax the filter. Strict for now.
    const NEW_TAB_TIMEOUT_MS = 5000;
    let onCreatedListener = null;
    const newTabPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (onCreatedListener) chrome.tabs.onCreated.removeListener(onCreatedListener);
        reject(new Error(`IN_NEW_TAB: trigger did not open a new tab within ${NEW_TAB_TIMEOUT_MS}ms`));
      }, NEW_TAB_TIMEOUT_MS);

      onCreatedListener = (tab) => {
        if (tab.openerTabId === outerTab) {
          clearTimeout(timer);
          chrome.tabs.onCreated.removeListener(onCreatedListener);
          onCreatedListener = null;
          resolve(tab.id);
        }
        // Tabs with other openers (or no opener) are ignored — could be
        // a background tab, analytics popup, etc.
      };
      chrome.tabs.onCreated.addListener(onCreatedListener);
    });

    // Execute the trigger on the outer tab. The trigger can be any single
    // node — typically a fragment with a CLICK, but NAVIGATE or even a
    // nested IN_NEW_TAB is legal shape-wise.
    let triggerResult;
    try {
      triggerResult = await ExecutionEngine.#executeSingleNode(node.trigger, ctx, {
        topLevelIndex, iterationLabel, iteration,
      });
    } catch (err) {
      // Clean up listener if trigger threw before it could fire
      if (onCreatedListener) chrome.tabs.onCreated.removeListener(onCreatedListener);
      return { status: 'failed', error: `IN_NEW_TAB trigger threw: ${err.message ?? err}` };
    }

    if (triggerResult.status === 'aborted') {
      if (onCreatedListener) chrome.tabs.onCreated.removeListener(onCreatedListener);
      return triggerResult;
    }
    if (triggerResult.status === 'failed') {
      if (onCreatedListener) chrome.tabs.onCreated.removeListener(onCreatedListener);
      return { status: 'failed', error: `IN_NEW_TAB trigger failed: ${triggerResult.error}` };
    }

    // Wait for the new tab to appear
    let newTabId;
    try {
      newTabId = await newTabPromise;
    } catch (err) {
      emit({ type: 'in_new_tab_complete', stepIdx: topLevelIndex, outcome: 'no_tab_opened', error: err.message });
      return { status: 'failed', error: err.message };
    }

    Logger.info('ExecutionEngine', `IN_NEW_TAB${label} — new tab ${newTabId} opened`);
    emit({
      type: 'in_new_tab_opened', stepIdx: topLevelIndex,
      outerTabId: outerTab, newTabId,
    });

    // Wait for the new tab to finish loading
    try {
      await ExecutionEngine.#waitForTabReady(newTabId);
    } catch (err) {
      // If the tab closed or failed to load, try to clean up and fail
      Logger.warn('ExecutionEngine', `IN_NEW_TAB${label} — new tab never became ready: ${err.message ?? err}`);
      if (node.closeOnExit) {
        try { await chrome.tabs.remove(newTabId); } catch { /* already closed */ }
      }
      return { status: 'failed', error: `IN_NEW_TAB: new tab failed to load: ${err.message ?? err}` };
    }

    if (isAborted()) {
      if (node.closeOnExit) {
        try { await chrome.tabs.remove(newTabId); } catch { /* already closed */ }
      }
      return { status: 'aborted' };
    }

    // Swap tab and run body. Build a shallow-cloned ctx with the new tab
    // so the swap doesn't leak outward if body throws.
    const innerCtx = { ...ctx, tabId: newTabId };
    let bodyResult;
    try {
      bodyResult = await ExecutionEngine.#executeBodyWithIterationLabel(node.body, innerCtx, {
        topLevelIndex, iterationLabel, iteration,
      });
    } catch (err) {
      bodyResult = { status: 'failed', error: err.message ?? String(err) };
    }

    // Clean up: close the new tab regardless of outcome (if configured),
    // then return the body's result. ctx.tabId was never mutated on our
    // copy — outer execution continues on outerTab naturally.
    if (node.closeOnExit) {
      try {
        await chrome.tabs.remove(newTabId);
        Logger.info('ExecutionEngine', `IN_NEW_TAB${label} — closed new tab ${newTabId}`);
      } catch (err) {
        Logger.warn('ExecutionEngine', `IN_NEW_TAB${label} — failed to close new tab ${newTabId}: ${err.message ?? err}`);
      }
    }

    emit({
      type: 'in_new_tab_complete', stepIdx: topLevelIndex,
      outcome: bodyResult.status, newTabId,
    });

    return bodyResult;
  }

  /**
   * Helper — dispatch a single node by type. Mirrors the body-dispatch
   * switch but runs exactly one node instead of iterating a list. Used
   * by IN_NEW_TAB to execute its `trigger` field.
   *
   * @private
   */
  static async #executeSingleNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    if (!node) return { status: 'failed', error: 'executeSingleNode: node is null' };
    if (node.type === 'fragment') {
      return ExecutionEngine.#executeFragmentNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'foreach') {
      return ExecutionEngine.#executeForEachNode(node, ctx, { topLevelIndex });
    }
    if (node.type === 'wait') {
      return ExecutionEngine.#executeWaitNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'pause') {
      return ExecutionEngine.#executePauseNode(node, ctx, { topLevelIndex, iterationLabel });
    }
    if (node.type === 'sieve') {
      return ExecutionEngine.#executeSieveNode(node, ctx, { topLevelIndex, iterationLabel });
    }
    if (node.type === 'detect') {
      return ExecutionEngine.#executeDetectNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'loop') {
      return ExecutionEngine.#executeLoopNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'try') {
      return ExecutionEngine.#executeTryNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'navigate') {
      return ExecutionEngine.#executeNavigateNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'scroll') {
      return ExecutionEngine.#executeScrollNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'observation') {
      return ExecutionEngine.#executeObservationNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    if (node.type === 'in_new_tab') {
      return ExecutionEngine.#executeInNewTabNode(node, ctx, { topLevelIndex, iterationLabel, iteration });
    }
    return { status: 'failed', error: `executeSingleNode: unknown node type "${node.type}"` };
  }

  /**
   * Helper — execute a list of body nodes, passing iterationLabel down only
   * to direct fragment children. Nested FOREACH inside a FOREACH body gets
   * its OWN iteration label (it computes its own during its own loop), so
   * we don't propagate ours into nested foreach nodes.
   *
   * The only reason this exists as a separate function from #executeNodes
   * is to inject the iterationLabel into the fragment-node dispatch without
   * changing #executeNodes' signature (which is also called from the top
   * level without any iteration context).
   *
   * @private
   */
  static async #executeBodyWithIterationLabel(nodes, ctx, { topLevelIndex, iterationLabel, iteration = null }) {
    for (let i = 0; i < nodes.length; i++) {
      if (ctx.isAborted()) return { status: 'aborted' };

      const node = nodes[i];
      if (!node) continue;

      let nodeResult;
      if (node.type === 'fragment') {
        nodeResult = await ExecutionEngine.#executeFragmentNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else if (node.type === 'foreach') {
        // Nested FOREACH — no iterationLabel passthrough (it makes its own).
        // topLevelIndex stays the same; nested foreach shows under the
        // same top-level step number in progress events.
        nodeResult = await ExecutionEngine.#executeForEachNode(node, ctx, { topLevelIndex });
      } else if (node.type === 'wait') {
        nodeResult = await ExecutionEngine.#executeWaitNode(
          node, ctx, { topLevelIndex, iterationLabel }
        );
      } else if (node.type === 'pause') {
        nodeResult = await ExecutionEngine.#executePauseNode(
          node, ctx, { topLevelIndex, iterationLabel }
        );
      } else if (node.type === 'sieve') {
        nodeResult = await ExecutionEngine.#executeSieveNode(
          node, ctx, { topLevelIndex, iterationLabel }
        );
      } else if (node.type === 'detect') {
        // Pass G2 — DETECT nodes pass iterationLabel down so their branch
        // bodies' fragments show with per-iteration labeling.
        nodeResult = await ExecutionEngine.#executeDetectNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else if (node.type === 'loop') {
        // Pass H1 — LOOP nodes pass iterationLabel down; their body runs
        // multiple times but inherits the outer FOREACH's iteration label
        // (the LOOP itself is count-agnostic — no per-LOOP-iteration label).
        nodeResult = await ExecutionEngine.#executeLoopNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else if (node.type === 'try') {
        // Pass H2 — TRY nodes pass iterationLabel down so body/recover
        // fragments show with the enclosing iteration's labeling.
        nodeResult = await ExecutionEngine.#executeTryNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else if (node.type === 'navigate') {
        // Pass H3 — NAVIGATE passes iterationLabel for per-iteration labeling
        // AND iteration itself (needed to resolve iteration_variable URL).
        nodeResult = await ExecutionEngine.#executeNavigateNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else if (node.type === 'scroll') {
        // v2.71.0 — SCROLL inside FOREACH; iteration is needed to resolve
        // iteration_variable distance bindings.
        nodeResult = await ExecutionEngine.#executeScrollNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else if (node.type === 'observation') {
        // v2.72.3 (Pass 4) — OBSERVATION inside FOREACH. iteration is
        // forwarded so future iteration_variable param bindings can resolve.
        nodeResult = await ExecutionEngine.#executeObservationNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else if (node.type === 'in_new_tab') {
        // Pass J2 — IN_NEW_TAB passes iterationLabel so the new-tab body
        // fragments show with the enclosing iteration's labeling.
        nodeResult = await ExecutionEngine.#executeInNewTabNode(
          node, ctx, { topLevelIndex, iterationLabel, iteration }
        );
      } else {
        Logger.warn('ExecutionEngine', `Unknown node type "${node?.type}" in FOREACH body — skipping`);
        continue;
      }

      if (nodeResult.status !== 'ok') return nodeResult;

      // v2.59.1 — yield after EVERY body node, with after-node granularity.
      //
      // Previously this site (a) gated on `node.type === 'fragment'` (so
      // WAIT/NAVIGATE/etc. inside a body silently bypassed pause) and
      // (b) used 'after-fragment' granularity (which the gate logic in
      // #yieldIfPaused skips when pauseMode is 'after-node' — the studio
      // default). The combined effect: pause never fired inside FOREACH/
      // DETECT/LOOP/TRY/IN_NEW_TAB bodies in the studio test-run path.
      //
      // Symptom: user clicks Pause during a body's WAIT, strategy continues
      // past the WAIT to the next node without honoring the pause request.
      //
      // Fix: emit after-node granularity for every body node, matching
      // #executeNodes' top-level behavior at the equivalent yield site.
      // Pause now behaves consistently regardless of nesting depth.
      await ExecutionEngine.#yieldIfPaused(ctx, 'after-node', {
        nodeIdx: topLevelIndex,
        totalNodes: ctx.topLevelTotal,
        nodeType: node.type,
        nodeLabel: ExecutionEngine.#describeNodeForPause(node),
        iterationLabel,
      });
    }
    return { status: 'ok' };
  }

  /**
   * Pass C — Resolve a Fragment's per-step paramBindings object into a flat
   * { PARAM_NAME: value } map, consulting strategy-level param values for
   * `strategy_param` bindings.
   *
   * Binding shapes:
   *   { kind: 'literal', value: 'alice@example.com' }
   *   { kind: 'strategy_param', name: 'QUERY' }   → looks up scope.get(QUERY)
   *
   * E1 (v2.26.0) — `source` is now either a Scope (preferred) OR a flat
   * { name: string } dict (legacy). Scope lookups go through asString to
   * coerce tagged values back to strings for action substitution. This means
   * EXTRACT outputs from earlier steps appear here for later steps —
   * Strategies become information-flowing, not just side-effecting.
   *
   * If a binding references a missing strategy param, the slot is left empty;
   * the caller (or InjectionService.injectParams) will leave the {{TOKEN}} in
   * the action value. This is a silent failure mode — authoring UI should
   * validate against this at save time.
   *
   * @private
   */
  static #resolveFragmentBindings(paramBindings, source) {
    const out = {};
    // Detect Scope vs plain dict — Scope has a `get` method.
    const isScope = source && typeof source.get === 'function';
    const lookup = (name) => {
      if (isScope) {
        const tagged = source.get(name);
        if (tagged === undefined) return undefined;
        // Inline import-free coercion to avoid circular load surprises:
        if (typeof tagged === 'string') return tagged;
        if (tagged?.kind === 'scalar') return tagged.value;
        if (tagged?.kind === 'list')   return tagged.items.map(x => x?.value ?? '').join(', ');
        if (tagged?.kind === 'element') return tagged.selector ?? '';
        return String(tagged);
      }
      return source?.[name];
    };

    for (const [paramName, binding] of Object.entries(paramBindings)) {
      if (!binding || typeof binding !== 'object') continue;
      if (binding.kind === 'literal') {
        out[paramName] = String(binding.value ?? '');
      } else if (binding.kind === 'strategy_param') {
        const src = binding.name;
        const v = src ? lookup(src) : undefined;
        if (v !== undefined) {
          out[paramName] = String(v);
        }
        // else leave unset — caller handles missing value
      } else if (binding.kind === 'iteration_variable') {
        // v2.29.2 (Pass E2-3) — FOREACH iteration binding. Resolves through
        // the same Scope.get() path as strategy_param (Scope walks frames
        // top-to-bottom, so the nearest enclosing FOREACH's binding wins).
        // Element-typed values coerce to their selector string — which is
        // exactly what a nested Fragment's action selectors need when they
        // interpolate {{JOB}} into something like "{{JOB}} .apply-btn".
        //
        // v2.50.0 — optional `field` property. When set, the binding resolves
        // to the iteration record's named field instead of the selector.
        // Authored as: { kind: 'iteration_variable', name: 'JOB', field: 'jobKey' }
        // Required because Pass O1 records carry per-item structured fields,
        // but the existing string-coercion path in `lookup` only exposes the
        // selector. Without this branch, paramBindings can't reach record fields.
        // Backward compat: bindings WITHOUT `field` keep current behavior.
        const src = binding.name;
        if (binding.field && typeof binding.field === 'string' && isScope) {
          // Bypass lookup's coercion — go to the raw tagged value to access
          // the iteration record. ENUMERATE+fields produces items shaped as
          // { kind: 'element', selector, ..., record: { field: value, ... } }
          const raw = src ? source.get(src) : undefined;
          if (raw && typeof raw === 'object') {
            const record = (raw.record && typeof raw.record === 'object') ? raw.record : null;
            if (record && record[binding.field] !== undefined && record[binding.field] !== null) {
              out[paramName] = String(record[binding.field]);
            }
            // else leave unset — field doesn't exist on the record
          }
        } else {
          const v = src ? lookup(src) : undefined;
          if (v !== undefined) {
            out[paramName] = String(v);
          }
        }
      }
    }
    return out;
  }

  /**
   * Pass Cα — Format a single condition failure into a human-readable line.
   * `failure` has shape { condition: {type, selector|pattern|text}, reason }.
   * Output examples:
   *   selector_present("[data-testid='apply-btn']") — not found
   *   url_matches("/jobs/view/") — current URL does not match
   *   text_present("Submitted") — text not found in body
   *
   * @private
   */
  static #formatConditionFailure(failure) {
    const c = failure?.condition ?? {};
    const reason = failure?.reason && failure.reason !== 'condition not met'
      ? ` — ${failure.reason}`
      : '';
    switch (c.type) {
      case 'selector_present':
        return `selector_present("${(c.selector ?? '').slice(0, 80)}") — not found${reason}`;
      case 'selector_absent':
        return `selector_absent("${(c.selector ?? '').slice(0, 80)}") — still present${reason}`;
      case 'url_matches':
        return `url_matches("${(c.pattern ?? '').slice(0, 80)}") — URL does not match${reason}`;
      case 'text_present': {
        // v2.74.170 — Mention the scoping selector when present so the
        // failure log distinguishes "text not in this section" from
        // "text not anywhere on the page."
        const sel = (c.selector ?? '').toString().trim();
        const where = sel ? ` in ${sel.slice(0, 60)}` : ' in page text';
        return `text_present("${(c.text ?? '').slice(0, 80)}") — not found${where}${reason}`;
      }
      default:
        return `${c.type ?? 'unknown'}${reason}`;
    }
  }

  /** @private Open a new tab at the given URL. Returns tab id. */
  static async #openTab(url) {
    return new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        resolve(tab.id);
      });
    });
  }

  /** @private Wait for tab to finish loading. */
  static async #waitForTabReady(tabId) {
    return new Promise((resolve) => {
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1000);   // small grace period for JS init
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Also poll once — tab may already be complete
      chrome.tabs.get(tabId, (tab) => {
        if (!chrome.runtime.lastError && tab?.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 1000);
        }
      });
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, TAB_LOAD_TIMEOUT_MS);
    });
  }

  /**
   * v2.38.0 (Pass K1) — Yield to the debug controller at a yield point.
   *
   * Called by executors at well-defined granularities:
   *   - after each top-level node (pauseMode 'after-node' or 'after-fragment')
   *   - after each fragment-in-body invocation (pauseMode 'after-fragment')
   *
   * Behavior:
   *   1. If pauseMode is 'off', returns immediately (zero-cost no-op).
   *   2. If pauseMode matches the granularity, emit `paused` event with
   *      current context, then poll isPaused() every 100ms until it
   *      returns false. Also returns immediately if isAborted() flips true.
   *   3. While paused, the side panel can mutate isPaused via the control
   *      channel. When user clicks Resume → isPaused returns false, engine
   *      continues. When user clicks Step → isPaused stays true after the
   *      next yield (handled by the side panel, not the engine).
   *
   * The pauseInfo arg lets the side panel show "Paused at step 3/5: Open
   * job detail" or similar — current node, scope, URL.
   *
   * @param {Object} ctx - the strategy execution context
   * @param {'after-node'|'after-fragment'} granularity - which yield site is firing
   * @param {Object} pauseInfo - { stepIdx, totalSteps, label, ... } for the side panel
   * @private
   */
  static async #yieldIfPaused(ctx, granularity, pauseInfo) {
    if (!ctx.debug || ctx.debug.pauseMode === 'off') return;

    // Granularity gating:
    //   pauseMode 'after-node'      → only yield at after-node sites
    //   pauseMode 'after-fragment'  → yield at both after-node AND after-fragment sites
    //                                 (fragment is the finer grain; node-level is a superset boundary)
    if (ctx.debug.pauseMode === 'after-node' && granularity !== 'after-node') return;
    // 'after-fragment' accepts both granularities, no extra check needed

    if (!ctx.debug.isPaused()) return;

    // Build a snapshot for the UI. Cheap — just current scope + URL.
    let url = null;
    try {
      const tabInfo = await chrome.tabs.get(ctx.tabId);
      url = tabInfo?.url ?? null;
    } catch { /* tab gone */ }

    const stateOnEnter = {
      paused: true,
      granularity,
      ...pauseInfo,
      scopeSnapshot: ctx.scope.asResultObject(),
      url,
      tabId: ctx.tabId,
    };
    try { ctx.debug.onPauseStateChange(stateOnEnter); } catch (_) { /* swallow */ }
    ctx.emit({ type: 'paused', ...stateOnEnter });

    // Poll. Sleep 100ms between checks. Bail on abort.
    while (ctx.debug.isPaused()) {
      if (ctx.isAborted()) break;
      await new Promise(r => setTimeout(r, 100));
    }

    const stateOnExit = { paused: false, granularity };
    try { ctx.debug.onPauseStateChange(stateOnExit); } catch (_) { /* swallow */ }
    ctx.emit({ type: 'resumed' });
  }
}
