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
 */

import { Logger }                 from '../Core/Logger.js';
import { relaxNavPostFailures, condList } from '../Core/postcondition.js';   // v2.74.927 (CR-E1) — nav-aware relax, pure + tested
import { resolveBinding, resolveBindings, scopeLookup } from '../Core/bindingResolve.js';   // v2.74.943 (CR-D4) — the one paramBinding resolver
import { NODE_TYPES, describeNode } from './Engine/nodeRegistry.js';
import { SieveExecutor }       from './Engine/SieveExecutor.js';   // v2.74.949 (CR-X2) — the extracted sieve path
import { ObservationExecutor } from './Engine/ObservationExecutor.js';   // v2.74.949 (CR-X2) — the extracted observation path   // v2.74.947 (CR-X1a) — the node-type single source
import { StorageManager }         from './StorageManager.js';
import { TemplateWalker }         from './TemplateWalker.js';
import { Scope, scalar, list, asString } from './Scope.js';   // v2.74.949 (CR-X2) — record/image/section/document moved out with the sieve/observation executors
import { parseFileValue, isFileValue } from './FileParsers.js';
import { normalizeStrategyBody, normalizeStrategyParams }  from './StrategyTree.js';
import { PreconditionGate }       from './PreconditionGate.js';
import { UniversalGate }          from './UniversalGate.js';
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

// (the _condList shape-normalizer lived here until v2.74.949 — CR-X2 exported it from Core/postcondition.js as condList, shared with ObservationExecutor.)

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
    // v2.74.752 — optional INLINE strategy object. When provided, it is used AS-IS instead of loading by id from
    // storage. Lets a bare T1 (a Fragment) run via a synthetic one-step wrapper that is NEVER persisted (so it
    // never appears in the library as a phantom Strategy). Default null → load by strategyId, exactly as before.
    strategy: inlineStrategy = null,
    strategyParamValues = {},
    invocationId = null,
    isAborted = () => false,
    onProgress = null,
    debug = null,
    // v2.74.587 — optional: run against an EXISTING tab instead of opening a fresh
    // one on ground.url. Used by the SG/perspective trial, whose entry point is THIS
    // Locale (the tab the user is already standing on), not the Ground's base URL.
    // When set, the tab is reused as-is and NOT closed at the end (it's the user's).
    targetTabId = null,
    // v2.74.967 — optional observer: reports the tabId this run will DRIVE (the reused targetTabId or
    // the self-resolved/opened one) so the HANDLER layer can busy-mark it for monitor self-capture
    // suppression (gl 114728: an INVOKE_WORKFLOW strategy step let the engine self-resolve, nothing
    // marked the tab, and the run's own focus/type logged as INTERACTION hits). Layering stays clean
    // (no background import here); the observer must never break the run.
    onTabResolved = null,
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
        // v2.74.1898 — a FAILURE logs as ONE LINE, because there is one log store and every reader of it is
        // line-oriented. Passing `ev` whole meant the export pretty-printed scopeSnapshot/lastActions as ~25 lines
        // of JSON, and one failed walk EVICTED two turns from the decisions ring (gl 18:36: a clarify and a
        // wrong-scope count both became undiagnosable — the eviction cost MORE diagnosis than the dump ever gave).
        // The one-line digest carries what a trace reader actually uses: the scope VALUES, the last action, the
        // fragment. What is deliberately dropped is scopeSnapshot's type/subtype scaffolding and the full
        // lastActions array — structure about structure, and the price of keeping it was other turns' existence.
        let flat = '';
        try {
          const scope = ev.scopeSnapshot && typeof ev.scopeSnapshot === 'object'
            ? Object.entries(ev.scopeSnapshot).map(([k, v]) => `${k}=${JSON.stringify(String((v && v.value) ?? '')).slice(0, 24)}`).join(' ')
            : '';
          const last = Array.isArray(ev.lastActions) && ev.lastActions.length
            ? String(ev.lastActions[ev.lastActions.length - 1].action || '') : '';
          flat = [scope && `scope{${scope}}`, last && `lastAction=${last}`, ev.fragmentName && `fragment="${String(ev.fragmentName).slice(0, 40)}"`].filter(Boolean).join(' · ');
        } catch (_) { flat = ''; }
        Logger.error('ExecutionEngine', flat ? `${line} · ${flat}` : line);
      } else {
        Logger.info('ExecutionEngine', line, ev);
      }
    };

    // 1. Load Strategy — or use the inline synthetic one (a bare-Fragment run-time wrapper, never persisted).
    const strategy = inlineStrategy || await StorageManager.getStrategy(strategyId);
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

    // 2. Open tab on Ground URL — OR reuse the caller's existing tab.
    let tabId = null;
    let openedTab = false;   // only tabs WE open get closed in finally
    const stepResults = [];
    let overallError = null;

    try {
      if (targetTabId !== null && targetTabId !== undefined) {
        // Reuse the live tab as-is. The page is already loaded (the user is on it);
        // do NOT navigate to ground.url and do NOT close it afterwards.
        tabId = targetTabId;
      } else {
        tabId = await ExecutionEngine.#openTab(ground.url);
        openedTab = true;
        await ExecutionEngine.#waitForTabReady(tabId);
      }
      try { onTabResolved?.(tabId); } catch (_) { /* v2.74.967 — observer must never break the run */ }

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
      // 4. Close tab per user preference — but ONLY if we opened it. A reused
      // (caller-supplied) tab belongs to the user and must be left untouched.
      if (tabId !== null && openedTab) {
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
      isAborted: () => false,   // v2.74.949 (CR-X2) — the sieve path abort-checks now; a one-shot direct run has no abort source
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
    return await SieveExecutor.executeSieveNode(sieveNode, ctx, { topLevelIndex: stepIndex });
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

  // v2.74.947 (CR-X1a) — the type -> executor wiring, keyed 1:1 to nodeRegistry.NODE_TYPES (the
  // startup alarm below logs on drift). Arrows (not bare method refs) so the receiver is always the
  // class. Opts are forwarded UNIFORMLY ({ topLevelIndex, iterationLabel, iteration }) — each
  // executor's signature destructures what it uses (foreach takes only topLevelIndex: a nested
  // FOREACH makes its OWN iteration label; wait/pause/sieve ignore `iteration`), which is where the
  // old three dispatch chains' per-type forwarding differences actually lived all along.
  static #NODE_EXEC = {
    fragment   : (n, c, o) => ExecutionEngine.#executeFragmentNode(n, c, o),
    foreach    : (n, c, o) => ExecutionEngine.#executeForEachNode(n, c, o),
    wait       : (n, c, o) => ExecutionEngine.#executeWaitNode(n, c, o),
    pause      : (n, c, o) => ExecutionEngine.#executePauseNode(n, c, o),
    sieve      : (n, c, o) => SieveExecutor.executeSieveNode(n, c, o),
    detect     : (n, c, o) => ExecutionEngine.#executeDetectNode(n, c, o),
    loop       : (n, c, o) => ExecutionEngine.#executeLoopNode(n, c, o),
    try        : (n, c, o) => ExecutionEngine.#executeTryNode(n, c, o),
    navigate   : (n, c, o) => ExecutionEngine.#executeNavigateNode(n, c, o),
    scroll     : (n, c, o) => ExecutionEngine.#executeScrollNode(n, c, o),
    observation: (n, c, o) => ObservationExecutor.executeObservationNode(n, c, o),
    in_new_tab : (n, c, o) => ExecutionEngine.#executeInNewTabNode(n, c, o),
  };

  static {
    // CR-X1a — wiring drift alarm: the registry's type list and this map must stay 1:1. Per-node
    // dispatch fails loud anyway; this names the drift once at startup instead of per run.
    const wired = Object.keys(ExecutionEngine.#NODE_EXEC).sort().join(',');
    const listed = [...NODE_TYPES].sort().join(',');
    if (wired !== listed) {
      Logger.error('ExecutionEngine', `nodeRegistry/#NODE_EXEC drift — registry [${listed}] vs wired [${wired}]`);
    }
  }

  /**
   * Execute a sequence of nodes, short-circuiting on the first non-ok status.
   *
   * v2.74.947 (CR-X1a/b) — THE node walker. Dispatch goes through #NODE_EXEC (wired 1:1 to
   * nodeRegistry.NODE_TYPES), and the old #executeBodyWithIterationLabel collapsed into here:
   * a BODY walk passes `fixedIndex` (the enclosing top-level step) + iterationLabel/iteration --
   * body nodes share the parent's step number (no renumbering), skip the node_complete emit, and
   * carry the iteration label in the pause payload. Unknown node types FAIL LOUD (the X1 unified
   * policy: normalize nulls them with a warning long before execution, and null entries are
   * skipped here — so reaching one means a non-normalized body, an invariant break).
   *
   * @param {Array<Object>} nodes - Normalized body array (from StrategyTree)
   * @param {Object} ctx - Execution context built by executeStrategy
   * @param {Object} [opts]
   * @param {number} [opts.topLevelStart=0] - step index of the first node (top-level walk)
   * @param {number|null} [opts.fixedIndex=null] - non-null = body walk: every node reports THIS
   *     enclosing top-level step index (bodies don't renumber)
   * @param {string|null} [opts.iterationLabel=null] - body walk: the enclosing iteration's label
   * @param {Object|null} [opts.iteration=null] - body walk: the enclosing iteration record
   * @returns {Promise<{status: 'ok'|'failed'|'aborted', error?: string}>}
   * @private
   */
  static async #executeNodes(nodes, ctx, { topLevelStart = 0, fixedIndex = null, iterationLabel = null, iteration = null } = {}) {
    const isBody = fixedIndex !== null;
    for (let i = 0; i < nodes.length; i++) {
      if (ctx.isAborted()) return { status: 'aborted' };

      const node = nodes[i];
      if (!node) continue;

      // For top-level nodes, the step index is visible in progress events. For nested (body)
      // nodes, the caller passes the enclosing node's index so emits label the parent step.
      const topLevelIndex = isBody ? fixedIndex : topLevelStart + i;

      const run = ExecutionEngine.#NODE_EXEC[node.type];
      if (!run) {
        Logger.warn('ExecutionEngine', `Unknown node type "${node?.type}"${isBody ? ' in body' : ''} — failing (normalize drops unknowns; this body was never normalized)`);
        return { status: 'failed', error: `unknown node type "${node?.type}"` };
      }
      const nodeResult = await run(node, ctx, { topLevelIndex, iterationLabel, iteration });

      if (nodeResult.status !== 'ok') return nodeResult;

      if (!isBody) {
        // v2.61.1 — emit a lightweight `node_complete` progress event after each successful
        // top-level node, carrying current scope + url. Lets the debugger's Scope tab refresh
        // during running, not just on pause. Cheap: one shallow scope object per top-level node.
        // (Body nodes don't emit this — matching the pre-X1b body walker.)
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
          nodeLabel: describeNode(node),
          scopeSnapshot: ctx.scope.asResultObject(),
          url: _completedUrl,
          message: `Step ${topLevelIndex + 1}/${ctx.topLevelTotal}: ${describeNode(node)} complete`,
        });
      }

      // v2.38.0 (Pass K1) — top-level node yield point; v2.59.1 — body walks yield after EVERY
      // node too (WAIT/NAVIGATE inside a body used to bypass pause), with the iteration label in
      // the payload. Pause behaves consistently regardless of nesting depth.
      await ExecutionEngine.#yieldIfPaused(ctx, 'after-node', {
        nodeIdx: topLevelIndex,
        totalNodes: ctx.topLevelTotal,
        nodeType: node.type,
        nodeLabel: describeNode(node),
        ...(isBody ? { iterationLabel } : {}),
      });
    }
    return { status: 'ok' };
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
      // v2.74.884 — a missing backing fragment means the capability is BROKEN: its step was deleted, or a
      // partial/conflicted sync left the strategy without its fragment (the live "Fragment <uuid> not found" run
      // from this session's delete/re-create churn). Surface an ACTIONABLE message (the chat + run summary show
      // this) instead of a raw internal id, so the user knows to RE-TEACH it rather than seeing a cryptic failure.
      // The short id stays for log/gl diagnosis; `missingFragmentId` carries the full id for any caller repair.
      const err = `Step ${topLevelIndex + 1}: this capability is missing a step (fragment ${String(step.fragmentId).slice(0, 8)}…) — re-teach it to fix`;
      stepResults.push({
        fragmentId: step.fragmentId,
        fragmentName: iterationLabel ? `? ${iterationLabel}` : '?',
        success: false, actionsRun: 0, error: err, missingFragmentId: step.fragmentId,
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

    // v2.74.785 — A DIRECT INVOCATION never skips on its EFFECT. A Fragment runs iff it was CALLED and its
    // PRECONDITIONS hold (gated below); POSTCONDITIONS are the END signal — verified AFTER it runs — never a
    // start-time gate. The retired "postconditions already hold → skip" pre-probe conflated "the effect is present"
    // with "there is nothing to do", which made a parameterized action (a re-search) un-repeatable: its results /
    // input are present from a PRIOR run, so it wrongly concluded "already done". Idempotency now lives where it
    // belongs:
    //   • resume within THIS invocation → `completedFragmentIds` (a step that already RAN this run is skipped in
    //     TemplateWalker.executeFragment) — orthogonal to postconditions;
    //   • prerequisite satisfaction ("don't re-login if already logged in") → the ANTECEDENT path
    //     (TemplateWalker, Pass Cα), which legitimately checks "is this prereq met"; a DIRECT call does not;
    //   • "nothing to act on" for a direct call → express it as a PRECONDITION (the target affordance is absent),
    //     not as a postcondition.
    // See specs/DESIGN_division_of_labor.md §6 (Observability / idempotency-is-a-precondition).

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
    // v2.74.888 — substitute {{PARAM}} into the fragment's postconditions from its resolved param values BEFORE
    // checking. Tier-2 url postconditions are now parameterized at authoring (capabilitySynth) as e.g.
    // url_matches("/{{CATEGORY}}/"), so a capability reused with a DIFFERENT bound value verifies against the page
    // it navigated to. Other fragment-exec paths already substitute post-conditions; THIS one (#executeFragmentNode)
    // did not — a templated postcondition would otherwise reach the evaluator as the literal "{{CATEGORY}}".
    const _fragPost = SieveExecutor.substituteAnalysisParams(condList(fragment.postconditions), fragmentParamValues || {});
    if (_fragPost.length > 0) {
      const probe = await TemplateWalker.checkConditions({
        tabId, conditions: _fragPost,
        timeoutMs: 5000, pollIntervalMs: 100,
        isAborted,   // v2.74.920 (CR-S4) — a cancel doesn't ride out the 5s post-probe
      });
      postFailures = probe.failures;
      // v2.74.815 — nav-aware postcondition relaxation. A fragment whose own terminal CLICK NAVIGATES (executeFragment
      // surfaces execResult.navigated) invalidates an auto-derived url_matches that asserted the page it LEFT — the
      // assertion held until the click's own navigation away. Drop ONLY such a failure (pattern matched the pre-nav URL
      // but NOT the post-nav URL), so a "click that opens a page/panel" capability isn't scored failed for doing its job.
      // A url_matches that targets a THIRD page (matched neither) stays a real failure; one targeting the post-nav page
      // already passed (we're there) and was never in failures.
      // v2.74.927 (CR-E1) — the .815 filter read `f.type`, but checkConditions emits {condition, reason}
      // envelopes: `f.type` was always undefined, so the relax NEVER fired (and its .818 explainer log was
      // unreachable) — "click that navigates is failed by its own url_matches" persisted since .815.
      // The rule now lives PURE + tested in Core/postcondition.relaxNavPostFailures; this consumes it.
      const _nav = execResult && execResult.navigated;
      if (postFailures.length && _nav && _nav.from) {
        const { kept, relaxed } = relaxNavPostFailures(postFailures, _nav);
        for (const f of relaxed) {
          const c = (f && f.condition) || f || {};
          Logger.info('ExecutionEngine', `postcond ▸ url_matches("${String(c.pattern).slice(0, 30)}") failed; CLICK navigated "…${String(_nav.from).slice(-28)}" → "…${String(_nav.to).slice(-28)}" → RELAXED (assertion held until the nav)`);
        }
        for (const f of kept) {
          const c = (f && f.condition) || f || {};
          if (c.type === 'url_matches' && c.pattern) Logger.info('ExecutionEngine', `postcond ▸ url_matches("${String(c.pattern).slice(0, 30)}") failed; CLICK navigated "…${String(_nav.from).slice(-28)}" → "…${String(_nav.to).slice(-28)}" → KEPT (pattern matches neither from nor to — a third page)`);
        }
        postFailures = kept;
      }
      if (postFailures.length > 0) {
        const reasonSummary = postFailures.map(f => ExecutionEngine.#formatConditionFailure(f)).join('; ');
        Logger.info('ExecutionEngine',
          `${displayName} — postconditions failed after ${probe.elapsedMs}ms, ${probe.attempts} attempt(s): ${reasonSummary}`);
        stepResults.push({
          fragmentId: step.fragmentId, fragmentName: displayName,
          success: false, actionsRun: execResult.actionsRun,
          error: `Postconditions failed: ${reasonSummary}`,
          postFailures,
          effects: execResult.effects ?? [],
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
          fragmentId: step.fragmentId, fragmentName: displayName, failures: postFailures,
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
      effects: execResult.effects ?? [],   // PB-8 (v2.74.960) — bracketed-action drift verdicts for scoreTrial
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

    // v2.74.930 (CR-E4) — iteration budget. LOOP self-caps at 100 and the chat plan interpreter gained
    // the .915 cap/confirm, but the engine FOREACH was unbounded: a 500-row ENUMERATE meant 500 full
    // fragment chains (clicks, navigations, observations). Authors can raise/lower via node.maxItems;
    // exceeding the bound FAILS LOUDLY (mirroring LOOP's max_exceeded) rather than silently truncating —
    // a strategy that genuinely needs more states its intent in the node.
    const FOREACH_DEFAULT_MAX = 200;
    const maxItems = (Number.isFinite(node.maxItems) && node.maxItems > 0) ? node.maxItems : FOREACH_DEFAULT_MAX;
    if (items.length > maxItems) {
      const errMsg = `Step ${topLevelIndex + 1}: FOREACH over ${node.over} has ${items.length} item(s), exceeding the ${maxItems}-iteration budget` +
        `${Number.isFinite(node.maxItems) ? '' : ` (engine default — set node.maxItems to raise)`}`;
      Logger.error('ExecutionEngine', errMsg);
      return { status: 'failed', error: errMsg };
    }

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
        bodyResult = await ExecutionEngine.#executeNodes(
          node.body ?? [], ctx, { fixedIndex: topLevelIndex, iterationLabel, iteration }
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
        isAborted,   // v2.74.920 (CR-S4) — a cancelled run exits the WAIT-condition poll at the next tick
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

  // (#executeSieveNode + the three sieve tier executors + the sieve-only helpers lived here until
  // v2.74.949 — CR-X2 moved them whole to Services/Engine/SieveExecutor.js.)

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
        const bodyResult = await ExecutionEngine.#executeNodes(
          branch.body ?? [], ctx, { fixedIndex: topLevelIndex, iterationLabel, iteration }
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
    const defaultResult = await ExecutionEngine.#executeNodes(
      defaultBody, ctx, { fixedIndex: topLevelIndex, iterationLabel, iteration }
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

      const bodyResult = await ExecutionEngine.#executeNodes(
        node.body ?? [], ctx, { fixedIndex: topLevelIndex, iterationLabel, iteration }
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
    const bodyResult = await ExecutionEngine.#executeNodes(
      node.body ?? [], ctx, { fixedIndex: topLevelIndex, iterationLabel, iteration }
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

    const recoverResult = await ExecutionEngine.#executeNodes(
      node.recover ?? [], ctx, { fixedIndex: topLevelIndex, iterationLabel, iteration }
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
        // v2.74.943 (CR-D4) — via the one resolver; NAVIGATE policy: missing → ERROR, list → ERROR (a
        // list is not a URL). Same outcomes as the prior inline chain.
        const r = resolveBinding(u, scopeLookup(scope), { onMissing: 'error', list: 'error' });
        if (!r.ok) {
          const errMsg = `Step ${topLevelIndex + 1}: NAVIGATE url ${r.error}`;
          Logger.error('ExecutionEngine', `NAVIGATE${label} — ${errMsg}`);
          return { status: 'failed', error: errMsg };
        }
        targetUrl = r.value ?? '';
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

  // (#executeObservationNode + #executeObservationFrontier + the blob/tab-url helpers lived here
  // until v2.74.949 — CR-X2 moved them whole to Services/Engine/ObservationExecutor.js.)

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
    // v2.74.930 (CR-E4) — the timer is held OUTSIDE the executor and the promise gets a no-op catch:
    // the three early returns below (trigger threw/aborted/failed) used to remove only the listener,
    // leaving the 5s timer live and its rejection unawaited — an unhandled-rejection log in the SW on
    // every trigger failure.
    let _newTabTimer = null;
    const newTabPromise = new Promise((resolve, reject) => {
      _newTabTimer = setTimeout(() => {
        if (onCreatedListener) chrome.tabs.onCreated.removeListener(onCreatedListener);
        reject(new Error(`IN_NEW_TAB: trigger did not open a new tab within ${NEW_TAB_TIMEOUT_MS}ms`));
      }, NEW_TAB_TIMEOUT_MS);

      onCreatedListener = (tab) => {
        if (tab.openerTabId === outerTab) {
          clearTimeout(_newTabTimer);
          chrome.tabs.onCreated.removeListener(onCreatedListener);
          onCreatedListener = null;
          resolve(tab.id);
        }
        // Tabs with other openers (or no opener) are ignored — could be
        // a background tab, analytics popup, etc.
      };
      chrome.tabs.onCreated.addListener(onCreatedListener);
    });
    newTabPromise.catch(() => { /* settled-but-unconsumed on early returns — see above */ });
    const _dropNewTabWait = () => { clearTimeout(_newTabTimer); if (onCreatedListener) { chrome.tabs.onCreated.removeListener(onCreatedListener); onCreatedListener = null; } };

    // Execute the trigger on the outer tab. The trigger can be any single
    // node — typically a fragment with a CLICK, but NAVIGATE or even a
    // nested IN_NEW_TAB is legal shape-wise.
    let triggerResult;
    try {
      triggerResult = await ExecutionEngine.#executeSingleNode(node.trigger, ctx, {
        topLevelIndex, iterationLabel, iteration,
      });
    } catch (err) {
      _dropNewTabWait();   // v2.74.930 (CR-E4) — listener AND timer
      return { status: 'failed', error: `IN_NEW_TAB trigger threw: ${err.message ?? err}` };
    }

    if (triggerResult.status === 'aborted') {
      _dropNewTabWait();   // v2.74.930 (CR-E4)
      return triggerResult;
    }
    if (triggerResult.status === 'failed') {
      _dropNewTabWait();   // v2.74.930 (CR-E4)
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
      bodyResult = await ExecutionEngine.#executeNodes(node.body, innerCtx, {
        fixedIndex: topLevelIndex, iterationLabel, iteration,
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
   * Dispatch ONE node — the IN_NEW_TAB `trigger` slot. Kept as its own 4-liner rather than
   * walking `[node]` through #executeNodes because a trigger has SINGLE-NODE semantics: a null
   * trigger is a hard failure (a list walk would skip it as ok), and no after-node yield fires
   * between the trigger and the new-tab wait. v2.74.947 (CR-X1b) — registry dispatch, fail-loud.
   * @private
   */
  static async #executeSingleNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
    if (!node) return { status: 'failed', error: 'executeSingleNode: node is null' };
    const run = ExecutionEngine.#NODE_EXEC[node.type];
    if (!run) return { status: 'failed', error: `executeSingleNode: unknown node type "${node.type}"` };
    return run(node, ctx, { topLevelIndex, iterationLabel, iteration });
  }

  // (#executeBodyWithIterationLabel lived here until v2.74.947 — CR-X1b collapsed it into
  // #executeNodes' body mode: { fixedIndex, iterationLabel, iteration }.)

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
    // v2.74.943 (CR-D4) — delegates to Core/bindingResolve, the ONE resolver (four divergent copies
    // before). Fragment policy preserved exactly: missing → UNSET ({{TOKEN}} stays for the injector /
    // authoring validation), list → joined ', ', element → selector, record → String (legacy), plus the
    // v2.50 iteration-record `field` path. The Scope-vs-dict duck-typing lives in scopeLookup.
    return resolveBindings(paramBindings, scopeLookup(source), { onMissing: 'unset', list: 'join', record: 'string' }).values;
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
