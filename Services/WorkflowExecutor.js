/**
 * @file Services/WorkflowExecutor.js
 * @module WorkflowExecutor
 *
 * Top-level Workflow execution dispatcher (storage kind=`workflow`, UI label
 * "Workflow" since the v2.74.142 relabel — labels now match storage kinds
 * 1:1). A Workflow composes Strategy invocations (per-Ground fragment
 * trees), Analysis invocations, and control-flow primitives (FOREACH /
 * WAIT / DETECT / LOOP / TRY / PAUSE). This module walks the Workflow's
 * `steps` array and dispatches each step type to the appropriate runtime.
 *
 * Shipped step types:
 *
 *   ✓ `workflow`  — step kind retained for backward storage compatibility;
 *                   under the new vocabulary this dispatches the
 *                   per-Ground Strategy via ExecutionEngine.executeStrategy
 *                   with resolved paramBindings
 *   ✓ `analysis`  — dispatches to ExecutionEngine.executeAnalysisStep with
 *                   a pre-loaded Scope; merges outputs into workflowScope
 *   ✓ `foreach`   — iterates a list binding, runs nested body per item;
 *                   the iteration variable is visible to body steps via
 *                   the `iteration_variable` binding kind
 *   ✓ `wait`      — pauses execution for `durationMs` before continuing
 *                   to the next step. Condition mode is a future pass
 *                   (needs scope-condition evaluator + polling)
 *   ✓ `detect`    — evaluates each branch's scope condition in order;
 *                   the first matching branch's body runs. If no branch
 *                   matches, the `default` body runs.
 *   ✓ `loop`      — test-first while-loop: evaluates `condition` against
 *                   the live Workflow scope; if true, runs body; repeats
 *                   until the condition flips or `maxIterations` is
 *                   hit (which fails the Workflow).
 *   ✓ `try`       — runs `body`; on any error from a nested step, runs
 *                   `recovery`. The TRY succeeds if either body or
 *                   recovery succeeds.
 *   ✓ `pause`     — halts execution when a debug envelope is attached
 *                   (ctx.debug.requestPause + isPaused). Without a
 *                   debug envelope, falls back to the historical
 *                   skip-with-warning so non-debug invocations still
 *                   complete.
 *
 * Debug envelope (optional):
 *
 *   options.debug = {
 *     isPaused        : () => boolean,
 *     requestPause    : () => void,        // called by PAUSE steps
 *     onPauseStateChange? : (state) => void,
 *   }
 *
 * When attached, the executor:
 *   • Polls isPaused() between every step (yield point for external pause).
 *   • PAUSE steps call requestPause() then await until isPaused()→false.
 *   • Honors ctx.isAborted() alongside isPaused — a cancel while paused
 *     short-circuits the wait.
 *
 * Scope model:
 *   - workflowScope: { name → TaggedValue } map accumulated across the
 *     top-level step sequence. After each Strategy / Analysis step
 *     succeeds, the inner runtime's `extractedValues` merge in.
 *     (Renamed from `strategyScope` in v2.74.142 to match the new label.)
 *   - iterStack: array of {name, value} frames pushed by FOREACH. Resolved
 *     most-recent-first when a binding has kind='iteration_variable'.
 *     Frames pop when the body finishes; iter-only values do not leak
 *     into workflowScope.
 *
 * Binding kinds resolved here (literal strings persisted in storage —
 * note that `strategy_param` is the storage-kind name and stays unchanged
 * for back-compat; under new vocabulary it refers to a Workflow input):
 *   - literal            → b.value, passed through unchanged
 *   - strategy_param     → looked up in the Workflow's paramValues map
 *   - scope_binding      → looked up in the Workflow-tier scope (populated
 *                          by upstream step results); unwrapped from
 *                          tagged form for handoff to inner runtime
 *   - iteration_variable → looked up in the iteration stack
 */

import { StorageManager } from './StorageManager.js';
import { waitForTabComplete } from './TabUtils.js';   // v2.74.944 (CR-D5)
import { wrapFragmentAsStrategy } from '../Core/capabilitySynth.js';   // v2.74.786 — wrap a bare T1 Fragment cross-Ground step into a synthetic Strategy at run time
import { ExecutionEngine } from './ExecutionEngine.js';
import { parseFileValue, isFileValue } from './FileParsers.js';
import { Scope, scalar, list, isKind } from './Scope.js';
import { normalizeStrategyParams } from './StrategyTree.js';
import { evaluateDataCondition, describeDataCondition } from './DataAssertion.js';
import { Logger } from '../Core/Logger.js';
import { planCompensation } from '../Core/tier3.js';   // Q5 — saga compensation plan for a failed cross-Ground Workflow

/**
 * Unwrap a tagged Scope value into a form suitable for handing to
 * ExecutionEngine's seeding loop. The inner engine wraps incoming
 * paramValues with scalar() / list() again based on the target's declared
 * param kind, so we want to pass the *unwrapped primitive* form:
 *
 *   scalar  → .value (a string)
 *   list    → items.map(unwrap)  (an array of strings, suitable for kind:'list')
 *   record  → .fields (a plain object; passes through scalar() which will
 *             JSON.stringify it — useful as a debug fallback even if not
 *             ideal)
 *   image / section / document → return the tagged value as-is. The inner
 *             seeding loop's scalar() will stringify these via asString(),
 *             which produces the label / markdown / content respectively.
 *             Not great for chaining vision pipelines yet — that lands when
 *             the engine learns to seed already-tagged values directly.
 *
 * Untagged values (plain strings / numbers / booleans / arrays) pass
 * through unchanged so cross-step refs work alongside literal binding kinds.
 *
 * @param {*} v
 * @returns {*}
 */
/**
 * v2.74.91 — Park the executor while the debug envelope reports paused.
 * Polls every 100 ms so an external resume / cancel takes effect quickly.
 * No-op when no debug envelope is attached. Returns when either:
 *   - isPaused() returns false (resumed normally), OR
 *   - isAborted() returns true (cancelled while paused)
 */
async function _yieldIfPaused(ctx) {
  if (!ctx?.debug?.isPaused) return;
  let firstIter = true;
  while (ctx.debug.isPaused()) {
    if (ctx.isAborted?.()) return;
    // First iteration: emit a paused state-change so listeners can flip
    // their UI. Subsequent iterations stay quiet — the 100 ms cadence
    // would otherwise spam.
    if (firstIter) {
      try { ctx.debug.onPauseStateChange?.({ paused: true }); } catch (_) { /* swallow */ }
      firstIter = false;
    }
    await new Promise(res => setTimeout(res, 100));
  }
  // Resumed cleanly — let listeners know.
  if (!firstIter) {
    try { ctx.debug.onPauseStateChange?.({ paused: false }); } catch (_) { /* swallow */ }
  }
}

function unwrapTagged(v) {
  if (v == null) return v;
  if (typeof v !== 'object') return v;
  if (isKind(v, 'scalar'))  return v.value ?? '';
  if (isKind(v, 'list'))    return (v.items ?? []).map(unwrapTagged);
  if (isKind(v, 'record'))  return v.fields ?? {};
  return v;
}

/**
 * Resolve a single binding against the Strategy's parameter values, the
 * Strategy-tier scope built up across earlier steps, and (for
 * iteration_variable) the iteration-frame stack.
 *
 * Returns the value to hand to the Workflow runtime, or undefined when the
 * binding can't be resolved (unknown kind, missing reference). Callers
 * decide whether undefined is fatal — for required params on a Workflow,
 * substitution will fail loudly inside ExecutionEngine if the binding was
 * supposed to produce a value.
 *
 * @param {Object} binding       - {kind, value?, name?}
 * @param {Object} paramValues   - typed inputs collected at invocation
 * @param {Object} workflowScope - { [name]: TaggedValue } accumulated across steps
 * @param {Object} [ctx]         - { iterStack? } — FOREACH iteration frames
 * @returns {*}
 */
// v2.74.943 (CR-D4) — DELIBERATELY not folded into Core/bindingResolve: this resolver reads a THREE-source
// chain (invocation paramValues -> accumulated workflow scope -> ctx.iterStack innermost-first) rather than
// one Scope, and its unwrapTagged coercion is workflow-specific. The shared module covers the engine's
// fragment/sieve/navigate sites; if a fourth Scope-backed site appears, adopt there — not here.
function resolveBinding(binding, paramValues, workflowScope, ctx) {
  if (!binding || typeof binding !== 'object') return undefined;
  if (binding.kind === 'literal') return binding.value ?? '';
  if (binding.kind === 'strategy_param') return paramValues[binding.name];
  if (binding.kind === 'scope_binding') {
    // v2.74.77 — lookup in the accumulated Strategy scope. Names match
    // exactly with what upstream steps emitted (Workflow EMIT targets,
    // OBSERVATION outputs, EXTRACT bindings). Tagged value gets unwrapped
    // so the inner runtime's seeding loop re-wraps cleanly.
    const tagged = workflowScope[binding.name];
    if (tagged === undefined) {
      Logger.warn('WorkflowExecutor', `scope_binding "${binding.name}" not found in Strategy scope (no upstream step has emitted it yet)`);
      return undefined;
    }
    const _v = unwrapTagged(tagged);
    // v2.74.818 — make the cross-Ground HAND-OFF visible: an upstream output (a read value) flowing into this
    // step's param. This is the data flow that was previously logged only at the read end (RUN_OBSERVATION).
    Logger.info('WorkflowExecutor', `HANDOFF ▸ scope_binding "${binding.name}" = ${JSON.stringify(typeof _v === 'string' ? _v.slice(0, 60) : _v)}`);
    return _v;
  }
  if (binding.kind === 'iteration_variable') {
    // v2.74.79 — Resolve against the iteration stack. Innermost FOREACH
    // wins on name collisions. The stack is part of ctx so it threads
    // through recursive executeSteps calls without an explicit parameter.
    const iterStack = ctx?.iterStack ?? [];
    for (let i = iterStack.length - 1; i >= 0; i--) {
      if (iterStack[i].name === binding.name) {
        return unwrapTagged(iterStack[i].value);
      }
    }
    Logger.warn('WorkflowExecutor', `iteration_variable "${binding.name}" is not in scope (no enclosing FOREACH binds it)`);
    return undefined;
  }
  return undefined;
}

/**
 * Build the paramValues object handed to ExecutionEngine.executeStrategy
 * for a `workflow` step. Walks the step's paramBindings and resolves each
 * against both the invocation paramValues and the accumulated Strategy
 * scope.
 */
function resolveWorkflowStepParams(step, paramValues, workflowScope, ctx) {
  const out = {};
  const bindings = step.paramBindings ?? {};
  for (const [paramName, binding] of Object.entries(bindings)) {
    const v = resolveBinding(binding, paramValues, workflowScope, ctx);
    if (v !== undefined) out[paramName] = v;
  }
  return out;
}

/**
 * Execute one `workflow` step. Returns the ExecutionEngine result envelope.
 *
 * onProgress receives intermediate events from the inner ExecutionEngine
 * with `stepIndex` prepended so the UI can attribute progress to a
 * Strategy step number.
 */
/**
 * v2.74.78 — Build a Scope instance pre-loaded with the Strategy's typed
 * inputs + the accumulated upstream-step scope. The Analysis runtime
 * (ExecutionEngine.executeAnalysisStep) reads from and writes to this
 * Scope; the caller mines the post-execution Scope for new bindings to
 * merge back into workflowScope.
 *
 * Typed-input values are wrapped at this boundary because the Strategy
 * stores them un-wrapped (raw strings / numbers / parsed file taggeds).
 * Already-tagged values pass through (file-typed params land here
 * already-tagged after parseFileValue runs in executeWorkflow).
 */
function buildAnalysisScope(workflow, paramValues, workflowScope, ctx) {
  const scope = new Scope();

  const paramDescs = normalizeStrategyParams(workflow.params);
  for (const desc of paramDescs) {
    const v = paramValues[desc.name];
    if (v == null) continue;
    // Already-tagged values (parsed files) flow through unchanged. We
    // can't `isKind(v, 'scalar')` since the tag could be image / section
    // / list / record; the shape test is "has a non-empty `kind` field
    // and looks like a Scope-style tagged value".
    const taggedShape = typeof v === 'object' && typeof v.kind === 'string';
    if (taggedShape) {
      scope.set(desc.name, v);
    } else if (desc.kind === 'list') {
      const items = Array.isArray(v) ? v.map(x => scalar(x)) : [];
      scope.set(desc.name, list(items));
    } else {
      scope.set(desc.name, scalar(v));
    }
  }

  // Upstream-step outputs are already-tagged (they came out of the inner
  // runtime via `extractedValues`), so set them straight in.
  for (const [name, taggedValue] of Object.entries(workflowScope)) {
    scope.set(name, taggedValue);
  }

  // v2.74.79 — Seed iteration frames so Analyses inside a FOREACH body
  // can reference iter vars via paramBindings (kind=iteration_variable).
  // Innermost frame wins on name collisions, matching resolveBinding's
  // most-recent-first walk.
  for (const frame of (ctx?.iterStack ?? [])) {
    scope.set(frame.name, frame.value);
  }

  return scope;
}

/**
 * v2.74.78 — Rewrite Strategy-tier `scope_binding` bindings to the
 * `strategy_param` shape that ExecutionEngine's Sieve resolver
 * understands. Both shapes name a scope lookup; the scope already carries
 * the upstream value via buildAnalysisScope. Other kinds pass through
 * unchanged (literal handled natively; iteration_variable resolves to
 * empty string via the existing Sieve resolver, which is correct since
 * Strategies have no FOREACH iteration variables today).
 */
function adaptParamBindingsForSieve(bindings) {
  const out = {};
  for (const [paramName, b] of Object.entries(bindings ?? {})) {
    if (b?.kind === 'scope_binding') {
      out[paramName] = { kind: 'strategy_param', name: b.name };
    } else {
      out[paramName] = b;
    }
  }
  return out;
}

/**
 * Execute one `analysis` step. Runs the named Analysis against the
 * Strategy-tier scope and merges the produced output binding back into
 * workflowScope so downstream steps can reference it via `scope_binding`.
 */
async function executeAnalysisStep(step, stepIndex, paramValues, workflowScope, ctx, workflow) {
  if (!step.analysisId) {
    return { status: 'failed', error: 'Analysis step has no analysisId picked yet' };
  }
  if (!step.output) {
    return { status: 'failed', error: 'Analysis step has no output binding name' };
  }

  const scope = buildAnalysisScope(workflow, paramValues, workflowScope, ctx);

  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'analysis',
    analysisId: step.analysisId,
    message: `Step ${stepIndex + 1}: running Analysis`,
  });

  const result = await ExecutionEngine.executeAnalysisStep({
    node: {
      analysisId    : step.analysisId,
      source        : step.source ?? '',
      output        : step.output,
      paramBindings : adaptParamBindingsForSieve(step.paramBindings),
    },
    scope,
    onProgress: (ev) => ctx.emit({ ...ev, stepIndex, fromAnalysis: true }),
    stepIndex,
  });

  ctx.emit({
    type: 'strategy_step_done',
    stepIndex,
    stepType: 'analysis',
    success: result.status === 'ok',
    error: result.error ?? null,
    message: result.status === 'ok'
      ? `Step ${stepIndex + 1}: Analysis finished`
      : `Step ${stepIndex + 1}: Analysis failed — ${result.error ?? 'unknown'}`,
  });

  // Mine the post-execution scope for new bindings (chiefly the `output`)
  // and merge into the Strategy-tier scope so downstream steps see them.
  // The whole bottom frame is captured rather than just the named output,
  // matching how Workflow EMIT writes multiple targets in one go.
  if (result.status === 'ok') {
    const outBindings = scope.asResultObject();
    for (const [name, taggedValue] of Object.entries(outBindings)) {
      workflowScope[name] = taggedValue;
    }
  }

  return result;
}

async function executeWorkflowStep(step, stepIndex, paramValues, workflowScope, ctx) {
  if (!step.workflowId) {
    return { success: false, error: 'Workflow step has no workflowId picked yet' };
  }

  // v2.74.789 — A cross-Ground READ step (capabilityKind='observation') is NOT a Strategy
  // and must NOT be wrapped as one (the prior wrapObservationAsStrategy route mis-dispatched
  // it through #executeObservationNode, which needs a getObservation entity by id and crashed
  // with "OBSERVATION: observationId missing"). It runs the observation-native dispatch
  // instead: open the Ground tab → replay the antecedent Fragment (the prerequisite ACTION,
  // e.g. the search) → run the Observation (the READ, via RUN_OBSERVATION) → emit its value
  // into workflowScope. This preserves the load-bearing act/read split — Fragments ACT,
  // Observations READ — rather than co-opting one to do the other's job.
  if (step.capabilityKind === 'observation') {
    return _runObservationStep(step, stepIndex, paramValues, workflowScope, ctx);
  }

  const innerParams = resolveWorkflowStepParams(step, paramValues, workflowScope, ctx);

  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'workflow',
    workflowId: step.workflowId,
    message: `Step ${stepIndex + 1}: running Workflow`,
  });

  // Dispatch to the existing Strategy runtime. ExecutionEngine's
  // `strategyId` param refers to the per-Ground Strategy entity (storage
  // kind=`strategy` — the renamed-at-v2.74.142 internal identifier kept
  // for back-compat with stored records).
  //
  // v2.74.786 — A cross-Ground step may bind a bare T1 FRAGMENT (the user's library is
  // Fragment-based, not Strategy-based). A Fragment can't be loaded as a Strategy by id, so
  // wrap it at run time into a synthetic single-fragment Strategy (the SAME path REPLAY_SG_CAPABILITY
  // and CapabilityAPI use) and pass it as the inline `strategy`. `capabilityKind` defaults to
  // 'strategy' for older records, so existing Workflows are unaffected.
  let inlineStrategy = null;
  if (step.capabilityKind === 'fragment') {
    let frag = null;
    try { frag = await StorageManager.getFragment(step.workflowId); } catch { /* */ }
    if (!frag) {
      ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'workflow', success: false, error: `Fragment ${step.workflowId} not found`, message: `Step ${stepIndex + 1}: Fragment not found` });
      return { success: false, error: `Fragment ${step.workflowId} not found` };
    }
    inlineStrategy = wrapFragmentAsStrategy(frag, { strategyId: `fragment:${frag.id}` });
  }
  //
  // v2.74.151 — Propagate the Workflow-tier debug envelope so the inner
  // Strategy runtime also runs in debug mode when the outer Workflow is
  // being debugged. The debug envelope is what gates the page overlay
  // around OBSERVATION steps (and the PAUSE/Step-Over machinery); without
  // forwarding, an inner Strategy step inside a workflow-debug session
  // would behave as if debug were off and skip those visual aids.
  const result = await ExecutionEngine.executeStrategy({
    strategyId: inlineStrategy ? inlineStrategy.id : step.workflowId,
    strategy: inlineStrategy,   // null → load the Strategy by id; the synthetic wrap runs a bare T1 Fragment
    strategyParamValues: innerParams,
    invocationId: `${ctx.invocationId}::step${stepIndex}`,
    isAborted: ctx.isAborted,
    onProgress: (ev) => ctx.emit({ ...ev, stepIndex, fromInnerWorkflow: true }),
    debug: ctx.debug ?? null,
  });

  ctx.emit({
    type: 'strategy_step_done',
    stepIndex,
    stepType: 'workflow',
    success: !!result.success,
    error: result.error ?? null,
    message: result.success
      ? `Step ${stepIndex + 1}: Workflow finished`
      : `Step ${stepIndex + 1}: Workflow failed — ${result.error ?? 'unknown'}`,
  });

  return result;
}

/**
 * v2.74.789 — Resolve the antecedent Fragment's param bindings against the live Workflow
 * scope + inputs, mirroring resolveWorkflowStepParams for a Strategy step. The antecedent is
 * the READ's prerequisite ACTION (e.g. a search), so its param (the search term) follows the
 * SAME binding vocabulary as any step param: literal / strategy_param / scope_binding /
 * iteration_variable. Entries that are already raw resolved values (not {kind} bindings) pass
 * through unchanged — older records may store the captured value directly.
 */
function _resolveAntecedentBindings(antecedentParamBindings, paramValues, workflowScope, ctx) {
  const out = {};
  const src = (antecedentParamBindings && typeof antecedentParamBindings === 'object') ? antecedentParamBindings : {};
  for (const [k, b] of Object.entries(src)) {
    if (b && typeof b === 'object' && typeof b.kind === 'string') {
      const v = resolveBinding(b, paramValues, workflowScope, ctx);
      if (v !== undefined) out[k] = v;
    } else if (b !== undefined && b !== null) {
      out[k] = b;   // already a resolved value
    }
  }
  return out;
}

// v2.74.791 — Render-settle delay after the antecedent search dispatches, before the read. Matches the chat
// chain's inter-step settle (~800ms): enough for SPA results to paint / a post-submit list to populate, without
// stalling the workflow. The preceding _waitTabComplete already covers a hard navigation; this covers the render.
const SETTLE_AFTER_ANTECEDENT_MS = 800;

/**
 * v2.74.789 — Resolve once a hop tab finishes loading (status==='complete'), or after a
 * timeout (best-effort — the antecedent Fragment's own WAIT_FOR actions handle finer settling).
 * Checks the current status first (the load may already be done by the time we listen), then
 * subscribes. The listener is always removed exactly once.
 */
async function _waitTabComplete(tabId, timeoutMs = 15000) {
  // v2.74.944 (CR-D5) — via TabUtils (one waiter). This caller's contract: resolve void either way.
  await waitForTabComplete(tabId, { timeoutMs });
}

/**
 * v2.74.789 — Execute a cross-Ground READ step (capabilityKind==='observation').
 *
 * The observation-native dispatch — the load-bearing act/read split made concrete. A read is
 * NOT a Strategy and must NOT be wrapped as one; it composes a Fragment (which ACTS) with an
 * Observation (which READS):
 *   1. HOP   — open a tab on the step's Ground (groundUrl), wait for load, heal its port.
 *   2. ACT   — replay the antecedent CAPABILITY (the prerequisite, e.g. the search) via
 *              ctx.runCapability — the EXACT REPLAY_SG_CAPABILITY path the chat ran it through,
 *              so a multi-fragment Strategy and a bare Fragment search both work, reproducing the
 *              original run. This is an action: it has side effects.
 *   3. READ  — run the Observation via the EXACT RUN_OBSERVATION handler (ctx.runObservation),
 *              reusing its selector/archetype/landmark healing + list/visual modes. No side
 *              effect: it extracts a value.
 *   4. EMIT  — land the value in workflowScope under `outputName` so a downstream step's
 *              scope_binding can consume it (the cross-Ground data flow).
 *   5. CLOSE — best-effort cleanup of the hop tab.
 *
 * Returns the same { success, extractedValues?, error? } envelope a Strategy step returns, so
 * executeSteps merges its outputs into workflowScope identically.
 */
async function _runObservationStep(step, stepIndex, paramValues, workflowScope, ctx) {
  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'workflow',
    workflowId: step.workflowId,
    message: `Step ${stepIndex + 1}: reading${step.label ? ` "${step.label}"` : ''} on the other Ground`,
  });

  const fail = (error) => {
    ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'workflow', success: false, error, message: `Step ${stepIndex + 1}: ${error}` });
    return { success: false, error };
  };

  if (typeof ctx.runObservation !== 'function') {
    return fail('Cross-Ground read needs the in-SW observation runner (runObservation), which isn’t wired into this invocation');
  }
  // No Ground URL AND no antecedent to navigate there → nothing would put a real page in the tab; the read would
  // run against about:blank. Fail with a legible reason instead of a mystifying empty read.
  if (!step.groundUrl && !step.antecedentCapabilityId) {
    return fail('this read has no Ground URL and no prerequisite step to reach its page');
  }

  // 1. HOP — open the Ground tab in the background (not focused, so the user isn't yanked away).
  let tab = null;
  try {
    tab = await new Promise((resolve) => {
      try { chrome.tabs.create({ url: step.groundUrl || undefined, active: false }, (t) => { void chrome.runtime.lastError; resolve(t || null); }); }
      catch (_) { resolve(null); }
    });
  } catch (_) { tab = null; }
  if (!tab || typeof tab.id !== 'number') {
    return fail('Could not open the Ground page to read from');
  }
  const tabId = tab.id;

  try {
    await _waitTabComplete(tabId);
    if (typeof ctx.ensureContentScript === 'function') { try { await ctx.ensureContentScript(tabId); } catch (_) { /* heal best-effort */ } }
    if (ctx.isAborted?.()) return { success: false, error: 'Aborted' };

    // 2. ACT — replay the prerequisite CAPABILITY (the search) the way the chat ran it. An action has side
    //    effects; the antecedent is "logical linkage independent of strategy membership" — the read can't run
    //    until this has. runCapability is REPLAY_SG_CAPABILITY: it dispatches a Strategy (multi-fragment) OR a
    //    bare Fragment uniformly, so a multi-step search works as the prerequisite, not just a single-fragment one.
    if (step.antecedentCapabilityId) {
      if (typeof ctx.runCapability !== 'function') {
        return fail('the read prerequisite needs the in-SW capability runner (runCapability), which isn’t wired into this invocation');
      }
      const antBindings = _resolveAntecedentBindings(step.antecedentParamBindings, paramValues, workflowScope, ctx);
      const ar = await ctx.runCapability({ tabId, groundId: step.groundId, capabilityId: step.antecedentCapabilityId, paramValues: antBindings });
      if (!ar || ar.success === false) return fail(`The read prerequisite didn’t run: ${(ar && ar.error) || 'no response'}`);
      if (ar.ran === false)          return fail(`The read prerequisite couldn’t run here${ar.reason ? ` — ${ar.reason}` : ''}`);
      if (ar.ok === false)           return fail(`The read prerequisite failed${ar.reason ? ` — ${ar.reason}` : ''}`);
      // SETTLE — the search typically NAVIGATED (form submit → results) or updated in place. The capability returns
      // when its actions DISPATCH, not when the results SETTLE, so reading immediately races the render and comes
      // back empty (the chat chain settles between steps for exactly this reason). Re-wait for load (catches a hard
      // nav; returns at once if already complete) + a short render delay. RUN_OBSERVATION re-heals the post-nav
      // content-script port itself, so no ensureContentScript needed here.
      await _waitTabComplete(tabId);
      await new Promise((r) => setTimeout(r, SETTLE_AFTER_ANTECEDENT_MS));
    }
    if (ctx.isAborted?.()) return { success: false, error: 'Aborted' };

    // 3. READ — the Observation. Observations READ (no side effect). Reuses the full RUN_OBSERVATION
    //    machinery (positional/archetype read, landmark self-heal, list + visual modes).
    const obs = await ctx.runObservation({ tabId, groundId: step.groundId, capabilityId: step.workflowId });
    if (!obs || obs.success === false) {
      return fail(`Couldn’t read on the other Ground: ${(obs && obs.error) || 'no response'}`);
    }
    if (obs.ok === false) {
      return fail(obs.reason || 'the value wasn’t found on the page');
    }

    // 4. EMIT — tag the value and surface it under outputName for downstream scope_binding.
    const outName = step.outputName || 'value';
    const tagged = (obs.outputType === 'list' && Array.isArray(obs.items))
      ? list(obs.items.map((it) => scalar(String(it ?? ''))))
      : scalar(String(obs.value ?? ''));
    ctx.emit({
      type: 'strategy_step_done',
      stepIndex,
      stepType: 'workflow',
      success: true,
      message: `Step ${stepIndex + 1}: read "${String(obs.value ?? '').slice(0, 60)}" → ${outName}`,
    });
    return { success: true, extractedValues: { [outName]: tagged } };
  } finally {
    // 5. CLOSE — remove the hop tab (best-effort; a leaked tab is a nuisance, not a failure).
    try { await new Promise((resolve) => { try { chrome.tabs.remove(tabId, () => { void chrome.runtime.lastError; resolve(); }); } catch (_) { resolve(); } }); } catch (_) { /* */ }
  }
}

/**
 * v2.74.781 — Q5 — run the SAGA COMPENSATION plan for a cross-Ground Workflow that failed mid-journey. Best-effort: dispatches
 * each COMMITTED step's declared `compensateWith` Strategy in REVERSE order to undo its effect (saga semantics —
 * the analog, one tier up, of a try/recover Fragment). ADDITIVE + GUARDED: `planCompensation` returns an empty plan
 * unless steps declare `compensateWith`, so this is a pure no-op for every Workflow that opts out (all existing
 * ones — zero behaviour change until compensating Strategies are authored). Runs with ABORT SUPPRESSED: a user
 * cancel is exactly when the already-committed steps most need undoing, so the cleanup must complete. Per-undo
 * failures are logged, not thrown — a partial rollback still beats none. Returns the executed plan (possibly []).
 */
async function runCompensation(steps, stepResults, paramValues, workflowScope, ctx) {
  const committed = (Array.isArray(stepResults) ? stepResults : [])
    .filter((r) => r && r.success && r.stepType === 'workflow')
    .map((r) => r.stepIndex);
  const plan = planCompensation(steps, committed);
  if (!plan.length) return [];   // no step declares compensation → nothing to undo (the common case)

  ctx.emit({ type: 'workflow_compensation_start', message: `Rolling back ${plan.length} committed step(s)`, plan });
  // Abort-suppressed ctx clone — compensation must run to completion even when the failure WAS a user abort.
  const compCtx = { ...ctx, isAborted: () => false };
  const done = [];
  for (const entry of plan) {
    const compStep = { type: 'workflow', workflowId: entry.workflowId, groundId: entry.groundId || null };
    try {
      const r = await executeWorkflowStep(compStep, entry.stepIndex, paramValues, workflowScope, compCtx);
      done.push({ ...entry, success: !!(r && r.success), error: (r && r.error) || null });
    } catch (e) {
      done.push({ ...entry, success: false, error: e.message });
      Logger.warn('WorkflowExecutor', `compensation (undo ${entry.undoes}) threw: ${e.message}`);
    }
  }
  ctx.emit({ type: 'workflow_compensation_done', message: `Rollback finished (${done.filter((d) => d.success).length}/${done.length} undone)`, results: done });
  return done;
}

/**
 * Top-level Strategy execution entry point. Iterates steps and dispatches
 * each to its handler. Returns a summary envelope.
 *
 * @param {Object}   workflow         - the Strategy entity (id, name, params, steps, …)
 * @param {Object}   paramValues      - typed input values collected at invocation
 * @param {Object}   [options]
 * @param {Function} [options.onProgress] - receives event objects throughout
 * @param {Function} [options.isAborted]  - polled between steps; returns boolean
 * @param {string}   [options.invocationId]
 * @returns {Promise<{success, error?, stepResults: Array}>}
 */
export async function executeWorkflow(workflow, paramValues = {}, options = {}) {
  const onProgress = options.onProgress ?? (() => {});
  const isAborted  = options.isAborted  ?? (() => false);
  const invocationId = options.invocationId
    ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `winv-${Date.now()}`);

  // v2.74.91 — Debug envelope (optional). When attached, the executor
  // calls isPaused() between steps for external pause; PAUSE steps call
  // requestPause() to halt mid-strategy. Defaults are no-op so existing
  // non-debug callers (chat, Studio without debug mode) behave unchanged.
  const debug = options.debug ?? null;

  // v2.74.789 — Cross-Ground READ steps need two in-SW capabilities the executor can't
  // import directly (they close over the background's storage ctx): `runObservation` (the
  // RUN_OBSERVATION handler, the READ) and `ensureContentScript` (heal a fresh hop tab's
  // port). background.js's INVOKE_WORKFLOW threads both in. A SW→SW chrome.runtime.sendMessage
  // does NOT re-enter the SW's own onMessage, so a self-message would hang — the injected
  // invoker is the correct in-process path. Absent (older callers) → observation steps fail
  // with a clear message rather than hanging.
  const ctx = {
    emit: onProgress, isAborted, invocationId, debug,
    runObservation: options.runObservation ?? null,
    runCapability: options.runCapability ?? null,   // v2.74.792 — replay a cross-Ground READ's antecedent (the search) as the exact capability the chat ran
    ensureContentScript: options.ensureContentScript ?? null,
  };
  ctx.emit({ type: 'strategy_start', strategyId: workflow.id, message: `Running ${workflow.name ?? workflow.id}` });

  // v2.74.76 — Pre-resolve file-typed params. ParamForm hands files in as
  // {filename, mimeType, sizeBytes, dataUrl} bundles. Inner Workflow runs
  // want already-parsed Scope-tagged values. Walking the Strategy's
  // declared params, every file slot is replaced in place with its parsed
  // binding. ExecutionEngine.executeStrategy still re-parses anything left
  // as a fileValue (belt-and-suspenders), so this is idempotent.
  const resolvedParamValues = { ...paramValues };
  for (const p of (workflow.params ?? [])) {
    if (p.type !== 'file') continue;
    const v = resolvedParamValues[p.name];
    if (isFileValue(v)) {
      try {
        resolvedParamValues[p.name] = await parseFileValue(v, p.parse ?? 'auto');
      } catch (err) {
        const msg = `Couldn't parse uploaded file for ${p.name}: ${err.message}`;
        Logger.error('WorkflowExecutor', msg);
        ctx.emit({ type: 'strategy_failed', message: msg });
        return { success: false, error: msg, stepResults: [] };
      }
    }
  }

  const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
  if (steps.length === 0) {
    const msg = 'Strategy has no steps';
    ctx.emit({ type: 'strategy_failed', message: msg });
    return { success: false, error: msg, stepResults: [] };
  }

  // v2.74.77 — Strategy-tier scope. Each successful Workflow step's
  // `extractedValues` (a name → TaggedValue map) merges in here, making
  // upstream outputs visible to downstream `scope_binding` references.
  // Reset / namespacing is intentionally simple: last write wins. The
  // Workflow runtime already warns on name collisions inside a single
  // Workflow; this map collects across Workflows so two steps writing
  // to the same name will overwrite. Authors who need both should rename
  // upstream EMIT / OBSERVATION targets.
  const workflowScope = {};

  // v2.74.79 — Iteration stack lives on ctx so resolveBinding can read it
  // when resolving `iteration_variable` bindings. FOREACH pushes / pops
  // here; the outer Strategy starts with an empty stack.
  ctx.iterStack = [];

  // v2.74.116 — Removed the orphan `const stepResults = []` that lived
  // immediately above this destructure. It was a leftover from the
  // pre-v2.74.79 refactor (when the step loop ran inline in this
  // function); when the loop was extracted to `executeSteps`, the
  // accumulator was supposed to be returned and destructured here — but
  // the original `const` declaration was left in place. The result was a
  // SyntaxError ("Identifier 'stepResults' has already been declared")
  // that prevented the entire module from loading; every Strategy-entity
  // invocation through CapabilityAPI.#startStrategyInvocation failed at
  // import time. Confirmed via `node --input-type=module --check`.
  const { stepResults, error: overallError } = await executeSteps(
    steps, resolvedParamValues, workflowScope, ctx, workflow
  );

  if (overallError) {
    // Q5 — saga compensation: undo the steps that committed before the failure. No-op (empty plan) unless steps
    // declare `compensateWith`, so existing Workflows are unaffected. Runs BEFORE the failure is reported so the
    // event carries the rollback outcome.
    let compensation = [];
    try { compensation = await runCompensation(steps, stepResults, resolvedParamValues, workflowScope, ctx); }
    catch (e) { Logger.warn('WorkflowExecutor', `compensation pass failed: ${e.message}`); }

    // v2.74.93 — Final scope snapshot for the debugger, mirroring the
    // per-step emit above. The strategy_failed event also carries
    // extractedValues for non-debug consumers (chat result rendering).
    if (ctx.debug) {
      ctx.emit({ type: 'strategy_scope_snapshot', stepIndex: -1, snapshot: { ...workflowScope } });
    }
    ctx.emit({ type: 'strategy_failed', message: overallError, stepResults, extractedValues: workflowScope, compensation });
    return { success: false, error: overallError, stepResults, extractedValues: workflowScope, compensation };
  }

  if (ctx.debug) {
    ctx.emit({ type: 'strategy_scope_snapshot', stepIndex: -1, snapshot: { ...workflowScope } });
  }
  ctx.emit({ type: 'strategy_done', message: `${workflow.name ?? workflow.id} completed`, stepResults, extractedValues: workflowScope });
  // v2.74.77 — Final scope is exposed as `extractedValues`, mirroring
  // ExecutionEngine.executeStrategy's envelope. Callers (chat result
  // renderer, future Strategy result templates) can treat both runtimes
  // identically when displaying outputs.
  return { success: true, stepResults, extractedValues: workflowScope };
}

/**
 * v2.74.79 — Reusable step-loop driver. Walks an array of steps applying
 * the same dispatch logic the top-level executeWorkflow used to do inline.
 * Extracted so FOREACH bodies can be executed by recursion: foreach pushes
 * an iter frame, calls executeSteps on its body, then pops.
 *
 * Returns `{ stepResults, error }`. Caller decides whether `error` aborts
 * the enclosing scope (top-level: yes; FOREACH iteration: yes-the-whole-
 * strategy, since we don't have try/recover at this layer yet).
 *
 * Note: stepIndex labels here are local to the surrounding body. Inside
 * FOREACH the user sees per-iteration "Step 1 / 2 …" labels; the top-level
 * sequence numbering applies only to the outer level.
 */
async function executeSteps(steps, paramValues, workflowScope, ctx, workflow, pathPrefix = '') {
  const stepResults = [];
  for (let i = 0; i < steps.length; i++) {
    if (ctx.isAborted()) return { stepResults, error: 'Aborted' };

    // v2.74.100 — Compute the full dot-notation path for this step
    // (e.g. "2", "2.body.1", "3.branches.0.body.0"). Used for breakpoint
    // matching, scope-snapshot stepPath, and event emission.
    const stepPath = pathPrefix ? `${pathPrefix}.${i}` : String(i);

    // v2.74.95 — Breakpoint check: hit BEFORE the yield poll so a
    // breakpoint takes effect at this iteration's boundary even if the
    // executor wasn't already paused. Once requestPause flips paused
    // true, _yieldIfPaused below halts until the user resumes / steps.
    // v2.74.100 — Path-keyed.
    if (ctx.debug?.isBreakpoint?.(stepPath)) {
      ctx.emit({
        type: 'strategy_breakpoint_hit',
        stepIndex: i,
        stepPath,
        message: `Step ${stepPath}: breakpoint hit`,
      });
      try { ctx.debug.requestPause(); } catch (_) { /* swallow */ }
    }

    // v2.74.91 — Pause yield-point. Polls every 100 ms while paused; aborts
    // through the same check so cancel-while-paused works. No-op when no
    // debug envelope is attached (the historical fast path).
    await _yieldIfPaused(ctx);
    if (ctx.isAborted()) return { stepResults, error: 'Aborted' };
    const step = steps[i];

    if (step.type === 'workflow') {
      const r = await executeWorkflowStep(step, i, paramValues, workflowScope, ctx);
      stepResults.push({ stepIndex: i, stepType: 'workflow', success: !!r.success, error: r.error ?? null });
      if (!r.success) return { stepResults, error: r.error ?? `Step ${i + 1} failed` };

      if (r.extractedValues && typeof r.extractedValues === 'object') {
        for (const [name, taggedValue] of Object.entries(r.extractedValues)) {
          workflowScope[name] = taggedValue;
        }
      }
    }
    else if (step.type === 'analysis') {
      const r = await executeAnalysisStep(step, i, paramValues, workflowScope, ctx, workflow);
      stepResults.push({ stepIndex: i, stepType: 'analysis', success: r.status === 'ok', error: r.error ?? null });
      if (r.status !== 'ok') return { stepResults, error: r.error ?? `Step ${i + 1} failed` };
    }
    else if (step.type === 'foreach') {
      const r = await executeForeachStep(step, i, paramValues, workflowScope, ctx, workflow, stepPath);
      stepResults.push({ stepIndex: i, stepType: 'foreach', success: !r.error, error: r.error ?? null, iterations: r.iterations ?? 0 });
      if (r.error) return { stepResults, error: r.error };
    }
    else if (step.type === 'wait') {
      // v2.74.80 — Duration-mode WAIT only. Condition mode fails loudly
      // until the scope-condition evaluator lands. Abort during the sleep
      // returns to the caller via the same error channel.
      const r = await executeWaitStep(step, i, ctx);
      stepResults.push({ stepIndex: i, stepType: 'wait', success: !r.error && !r.aborted, error: r.error ?? null });
      if (r.error)   return { stepResults, error: r.error };
      if (r.aborted) return { stepResults, error: 'Aborted' };
    }
    else if (step.type === 'detect') {
      // v2.74.81 — First-match branch evaluator over scope conditions.
      const r = await executeDetectStep(step, i, paramValues, workflowScope, ctx, workflow, stepPath);
      stepResults.push({ stepIndex: i, stepType: 'detect', success: !r.error, error: r.error ?? null });
      if (r.error) return { stepResults, error: r.error };
    }
    else if (step.type === 'loop') {
      // v2.74.81 — Test-first while-loop on scope conditions, capped by
      // maxIterations. Hitting the cap fails the Strategy.
      const r = await executeLoopStep(step, i, paramValues, workflowScope, ctx, workflow, stepPath);
      stepResults.push({ stepIndex: i, stepType: 'loop', success: !r.error, error: r.error ?? null, iterations: r.iterations ?? 0 });
      if (r.error) return { stepResults, error: r.error };
    }
    else if (step.type === 'try') {
      // v2.74.81 — Body + recovery. Body error → recovery runs. Abort
      // short-circuits and propagates without running recovery.
      const r = await executeTryStep(step, i, paramValues, workflowScope, ctx, workflow, stepPath);
      stepResults.push({ stepIndex: i, stepType: 'try', success: !r.error, error: r.error ?? null });
      if (r.error) return { stepResults, error: r.error };
    }
    else if (step.type === 'pause') {
      // v2.74.91 — Real PAUSE handling. If a debug envelope is attached,
      // flip the invocation into paused state and yield until the user
      // resumes (or cancels). Without an envelope, fall back to the
      // historical skip-with-warning so non-debug invocations still
      // make forward progress.
      if (ctx.debug?.requestPause) {
        ctx.emit({
          type: 'strategy_paused',
          stepIndex: i,
          message: `Step ${i + 1}: PAUSE — waiting for resume`,
        });
        try { ctx.debug.requestPause(); } catch (_) { /* swallow */ }
        await _yieldIfPaused(ctx);
        if (ctx.isAborted()) return { stepResults, error: 'Aborted' };
        ctx.emit({
          type: 'strategy_resumed',
          stepIndex: i,
          message: `Step ${i + 1}: resumed`,
        });
        stepResults.push({ stepIndex: i, stepType: 'pause', success: true });
      } else {
        const msg = `Step ${i + 1} (PAUSE): no debug envelope attached; continuing without halting`;
        Logger.warn('WorkflowExecutor', msg);
        ctx.emit({ type: 'strategy_step_skipped', stepIndex: i, stepType: 'pause', message: msg });
        stepResults.push({ stepIndex: i, stepType: 'pause', success: false, skipped: true, error: 'no debug envelope' });
      }
    }
    else {
      const msg = `Step ${i + 1} (${step.type}): execution not yet implemented in this build; skipping`;
      Logger.warn('WorkflowExecutor', msg);
      ctx.emit({ type: 'strategy_step_skipped', stepIndex: i, stepType: step.type, message: msg });
      stepResults.push({ stepIndex: i, stepType: step.type, success: false, skipped: true, error: 'not implemented' });
    }

    // v2.74.93 — Scope snapshot. Streams the live Strategy scope to
    // subscribers (the workflow-debug sidepanel) after every step so its
    // Scope inspector reflects state evolution. Gated on debug envelope
    // presence — non-debug runs (chat invocations) skip the emit so we
    // don't pay for an unsubscribed broadcast.
    //
    // Shallow clone: tagged value references are shared with the live
    // scope, which is fine because tagged values are treated as immutable
    // by consumers (the renderer never mutates them).
    if (ctx.debug) {
      ctx.emit({
        type: 'strategy_scope_snapshot',
        stepIndex: i,
        snapshot: { ...workflowScope },
      });
    }

    // v2.74.94 — Step-through. If the user clicked Step (consumed once),
    // re-arm pause so the NEXT step waits for another Step / Resume.
    // The next iteration's _yieldIfPaused poll picks up the new paused
    // state immediately.
    // v2.74.101 — Pass pathPrefix so the consumer can honor Step Over's
    // depth pin (only consume in the matching-prefix loop).
    if (ctx.debug?.consumeStepRequest?.(pathPrefix)) {
      try { ctx.debug.requestPause(); } catch (_) { /* swallow */ }
    }
  }
  return { stepResults, error: null };
}

/**
 * v2.74.79 — Execute a FOREACH step at the Strategy tier. Looks up the
 * `over` binding in workflowScope (must be a list), then for each item
 * pushes an iteration frame {name: step.as, value: item} onto ctx.iterStack,
 * runs the body via executeSteps, and pops on the way out.
 *
 * Failure semantics: if any body iteration's error returns, the FOREACH
 * itself fails. Iterations are sequential — no parallelism. Aborts
 * between iterations check ctx.isAborted() (already handled by
 * executeSteps' loop guard).
 *
 * Iter-only writes do not leak: body steps may write into workflowScope
 * (last-write-wins across iterations is the convention here, mirroring the
 * Workflow-tier FOREACH). Authors who need per-iteration outputs should
 * have a downstream Analysis aggregate via the iter var name.
 */
async function executeForeachStep(step, stepIndex, paramValues, workflowScope, ctx, workflow, parentPath = '') {
  const overName = step.over ?? '';
  const asName   = step.as ?? '';
  const body     = Array.isArray(step.body) ? step.body : [];

  if (!overName) return { error: `Step ${stepIndex + 1} (FOREACH): "over" binding name is empty` };
  if (!asName)   return { error: `Step ${stepIndex + 1} (FOREACH): "as" iteration variable name is empty` };

  // Resolve `over` — it must be a list binding. We accept either a tagged
  // list({items: [TaggedValue]}) or a raw array (some upstream sources
  // emit plain JS arrays).
  const overValue = workflowScope[overName];
  let items;
  if (overValue == null) {
    return { error: `Step ${stepIndex + 1} (FOREACH): "${overName}" is not in scope (no upstream step has emitted it)` };
  }
  if (isKind(overValue, 'list')) {
    items = overValue.items ?? [];
  } else if (Array.isArray(overValue)) {
    items = overValue.map(v => (typeof v === 'object' && v.kind) ? v : scalar(String(v ?? '')));
  } else {
    return { error: `Step ${stepIndex + 1} (FOREACH): "${overName}" is not a list (got kind=${overValue.kind ?? typeof overValue})` };
  }

  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'foreach',
    message: `Step ${stepIndex + 1}: FOREACH ${asName} in ${overName} (${items.length} item${items.length === 1 ? '' : 's'})`,
  });

  for (let i = 0; i < items.length; i++) {
    if (ctx.isAborted()) {
      return { error: 'Aborted', iterations: i };
    }
    ctx.iterStack.push({ name: asName, value: items[i] });
    ctx.emit({
      type: 'strategy_foreach_iter',
      stepIndex, iter: i, total: items.length,
      message: `Step ${stepIndex + 1}: iteration ${i + 1}/${items.length}`,
    });

    try {
      // v2.74.100 — Body steps run with `${parentPath}.body` as their
      // path prefix so breakpoints can target any individual body step
      // (e.g. "2.body.0" for the first step inside this FOREACH).
      const r = await executeSteps(body, paramValues, workflowScope, ctx, workflow, `${parentPath}.body`);
      if (r.error) {
        return { error: `${r.error} (iteration ${i + 1}/${items.length})`, iterations: i + 1 };
      }
    } finally {
      // v2.74.117 — Unconditional pop. We pushed exactly one frame at the
      // top of this iteration; we pop exactly one frame on exit (success,
      // error, or exception). Pre-fix, the error path did a manual pop
      // AND the finally also popped (conditionally on name match), which
      // double-popped when an inner FOREACH used the same `as` name as
      // an outer one — silently corrupting the outer's iter frame. Nested
      // FOREACHes inside `body` push/pop their own frames via their own
      // try/finally, so by the time control unwinds back here, the frame
      // on top is unambiguously ours.
      ctx.iterStack.pop();
    }
  }

  ctx.emit({
    type: 'strategy_step_done',
    stepIndex,
    stepType: 'foreach',
    success: true,
    message: `Step ${stepIndex + 1}: FOREACH finished (${items.length} iteration${items.length === 1 ? '' : 's'})`,
  });

  return { iterations: items.length };
}

/**
 * v2.74.80 — Execute a WAIT step at the Strategy tier.
 *
 * Duration mode (the only mode shipped today):
 *   sleeps `step.durationMs` milliseconds, then resolves. Polls
 *   ctx.isAborted() every 100 ms so an abort doesn't have to wait for the
 *   full duration to take effect. A sub-zero or non-finite duration is
 *   treated as 0 (continue immediately) rather than NaN-ing into infinity.
 *
 * Condition mode:
 *   not yet shipped. Strategy-tier conditions are scope-only (no tab to
 *   probe), so condition mode would lean on TemplateWalker.checkConditions
 *   with a Scope built from workflowScope + iterStack. The polling loop
 *   would honor `timeoutMs` and `pollIntervalMs` from the step. Until that
 *   lands, condition-mode WAIT steps fail with a clear message rather than
 *   silently waiting for `durationMs` (which they won't have set).
 *
 * Failure modes returned:
 *   - missing / non-numeric durationMs in duration mode → fail loud
 *   - condition mode encountered → fail with "not yet shipped"
 *   - abort polled true during the sleep → return aborted: true
 */
async function executeWaitStep(step, stepIndex, ctx) {
  const mode = step.mode ?? 'duration';

  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'wait',
    message: `Step ${stepIndex + 1}: WAIT ${mode === 'duration' ? `${step.durationMs ?? 0}ms` : `(condition mode)`}`,
  });

  if (mode === 'condition') {
    return { error: `Step ${stepIndex + 1} (WAIT): condition mode is not yet shipped at the Strategy tier — use a fixed duration for now` };
  }
  if (mode !== 'duration') {
    return { error: `Step ${stepIndex + 1} (WAIT): unknown mode "${mode}"` };
  }

  const ms = Number.isFinite(step.durationMs) ? Math.max(0, step.durationMs) : 0;

  // Sleep in 100ms slices so abort can short-circuit. For sub-100ms total,
  // one slice covers the whole wait.
  const sliceMs = 100;
  let remaining = ms;
  while (remaining > 0) {
    if (ctx.isAborted()) {
      ctx.emit({
        type: 'strategy_step_done',
        stepIndex,
        stepType: 'wait',
        success: false,
        message: `Step ${stepIndex + 1}: WAIT aborted after ${ms - remaining}ms / ${ms}ms`,
      });
      return { aborted: true };
    }
    const chunk = Math.min(sliceMs, remaining);
    await new Promise(res => setTimeout(res, chunk));
    remaining -= chunk;
  }

  ctx.emit({
    type: 'strategy_step_done',
    stepIndex,
    stepType: 'wait',
    success: true,
    message: `Step ${stepIndex + 1}: WAIT ${ms}ms complete`,
  });

  return {};
}

/**
 * v2.74.81 — Execute a DETECT step at the Strategy tier.
 *
 * Evaluates each branch's `condition` in order against a live Scope
 * (strategy params + accumulated step outputs + current iter frames).
 * The first branch whose condition holds runs its `body` via
 * executeSteps. If no branch matches, the `default` body runs (which may
 * be empty — that's a no-op skip).
 *
 * Conditions are scope-family only here (binding_is_*, scalar_*, etc.) —
 * Strategy tier has no tab, so page-family conditions (selector_present
 * etc.) aren't meaningful. Encountering a page-family condition emits a
 * warning and treats it as not-matching.
 *
 * Failure modes:
 *   - empty branches AND empty default → no-op, succeeds
 *   - body / default body returns an error → DETECT fails, propagates up
 */
async function executeDetectStep(step, stepIndex, paramValues, workflowScope, ctx, workflow, parentPath = '') {
  const branches = Array.isArray(step.branches) ? step.branches : [];
  const defaultBody = Array.isArray(step.default) ? step.default : [];

  // Build a live Scope view for condition eval. We reuse buildAnalysisScope
  // because the shape it produces is exactly what evaluateDataCondition
  // needs (typed inputs + strategy outputs + iter frames). Re-built per
  // call so it always reflects the latest scope state.
  const scope = buildAnalysisScope(workflow, paramValues, workflowScope, ctx);

  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'detect',
    message: `Step ${stepIndex + 1}: DETECT (${branches.length} branch${branches.length === 1 ? '' : 'es'}${defaultBody.length ? ' + default' : ''})`,
  });

  for (let bi = 0; bi < branches.length; bi++) {
    const branch = branches[bi];
    const cond = branch?.condition;
    if (!cond || typeof cond !== 'object') {
      Logger.warn('WorkflowExecutor', `Step ${stepIndex + 1} (DETECT): branch ${bi + 1} has no condition; skipping branch`);
      continue;
    }
    // Page-family condition types: silently treat as not-matching with a
    // warning. The condition vocabulary is well-known so we can detect
    // these by name. Anything not in the scope family is page-family.
    const pageFamilyTypes = new Set(['selector_present', 'selector_absent', 'url_matches', 'text_present', 'attribute_equals']);
    if (pageFamilyTypes.has(cond.type)) {
      Logger.warn('WorkflowExecutor', `Step ${stepIndex + 1} (DETECT): branch ${bi + 1} uses page condition "${cond.type}" which has no meaning at the Strategy tier; treating as no-match`);
      continue;
    }

    const result = evaluateDataCondition(cond, scope);
    if (result.ok) {
      ctx.emit({
        type: 'strategy_detect_branch',
        stepIndex, branch: bi,
        message: `Step ${stepIndex + 1}: DETECT matched branch ${bi + 1} (${describeDataCondition(cond)})`,
      });
      const body = Array.isArray(branch.body) ? branch.body : [];
      // v2.74.100 — Branch body path: "${parentPath}.branches.${bi}.body".
      const r = await executeSteps(body, paramValues, workflowScope, ctx, workflow, `${parentPath}.branches.${bi}.body`);
      if (r.error) return { error: r.error };
      ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'detect', success: true });
      return {};
    }
  }

  // No branch matched — run default if non-empty.
  if (defaultBody.length > 0) {
    ctx.emit({
      type: 'strategy_detect_default',
      stepIndex,
      message: `Step ${stepIndex + 1}: DETECT no branch matched; running default body`,
    });
    // v2.74.100 — Default body path: "${parentPath}.default".
    const r = await executeSteps(defaultBody, paramValues, workflowScope, ctx, workflow, `${parentPath}.default`);
    if (r.error) return { error: r.error };
  }

  ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'detect', success: true });
  return {};
}

/**
 * v2.74.81 — Execute a LOOP step at the Strategy tier.
 *
 * Test-first while-loop. Evaluates `condition` against the live Scope at
 * the start of each iteration. If true, runs `body`; if false, exits
 * cleanly. Capped by `maxIterations` (default 100) to prevent runaway
 * loops from authoring mistakes — hitting the cap FAILS the Strategy
 * loudly rather than silently exiting (matches the Workflow-tier LOOP
 * semantics from v2.30.x).
 *
 * Scope changes inside the body are reflected in the next iteration's
 * condition check because buildAnalysisScope re-reads workflowScope each
 * call. This is the pagination pattern: body increments a counter or
 * fetches the next page, condition probes a "has more" binding.
 */
async function executeLoopStep(step, stepIndex, paramValues, workflowScope, ctx, workflow, parentPath = '') {
  const cond = step?.condition;
  const body = Array.isArray(step.body) ? step.body : [];
  const cap = Number.isFinite(step.maxIterations) && step.maxIterations > 0 ? step.maxIterations : 100;

  if (!cond || typeof cond !== 'object') {
    return { error: `Step ${stepIndex + 1} (LOOP): condition is empty` };
  }
  const pageFamilyTypes = new Set(['selector_present', 'selector_absent', 'url_matches', 'text_present', 'attribute_equals']);
  if (pageFamilyTypes.has(cond.type)) {
    return { error: `Step ${stepIndex + 1} (LOOP): page condition "${cond.type}" has no meaning at the Strategy tier — use a scope condition (binding_is_list, scalar_equals, etc.)` };
  }

  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'loop',
    message: `Step ${stepIndex + 1}: LOOP while ${describeDataCondition(cond)} (max ${cap} iterations)`,
  });

  let iter = 0;
  while (iter < cap) {
    if (ctx.isAborted()) return { error: 'Aborted' };

    const scope = buildAnalysisScope(workflow, paramValues, workflowScope, ctx);
    const result = evaluateDataCondition(cond, scope);
    if (!result.ok) {
      ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'loop', success: true, message: `Step ${stepIndex + 1}: LOOP exited after ${iter} iteration${iter === 1 ? '' : 's'}` });
      return { iterations: iter };
    }

    iter++;
    ctx.emit({ type: 'strategy_loop_iter', stepIndex, iter, message: `Step ${stepIndex + 1}: LOOP iteration ${iter}` });

    // v2.74.100 — LOOP body path: "${parentPath}.body".
    const r = await executeSteps(body, paramValues, workflowScope, ctx, workflow, `${parentPath}.body`);
    if (r.error) return { error: `${r.error} (LOOP iteration ${iter})` };
  }

  return { error: `Step ${stepIndex + 1} (LOOP): maxIterations (${cap}) exceeded — condition still holds. Likely an authoring mistake: the body isn't changing the binding the condition probes.` };
}

/**
 * v2.74.81 — Execute a TRY step at the Strategy tier.
 *
 * Runs `body` via executeSteps. If a nested step returns an error, runs
 * `recovery` (which may be empty — empty recovery swallows the failure).
 * The TRY succeeds when either:
 *   - body completes without error, OR
 *   - body fails AND recovery completes without error
 *
 * Recovery body has access to the same Strategy scope as body, plus
 * whatever bindings were written before body failed (last-write-wins, no
 * rollback). This matches the Workflow-tier TRY semantics — recovery is
 * for retry / cleanup, not transactional revert.
 *
 * An aborted body short-circuits TRY too — recovery doesn't run on abort.
 */
async function executeTryStep(step, stepIndex, paramValues, workflowScope, ctx, workflow, parentPath = '') {
  const body     = Array.isArray(step.body) ? step.body : [];
  const recovery = Array.isArray(step.recovery) ? step.recovery : [];

  ctx.emit({
    type: 'strategy_step_start',
    stepIndex,
    stepType: 'try',
    message: `Step ${stepIndex + 1}: TRY (body ${body.length}, recovery ${recovery.length})`,
  });

  // v2.74.100 — TRY body path: "${parentPath}.body".
  const bodyResult = await executeSteps(body, paramValues, workflowScope, ctx, workflow, `${parentPath}.body`);
  if (!bodyResult.error) {
    ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'try', success: true, message: `Step ${stepIndex + 1}: TRY body succeeded` });
    return {};
  }
  // v2.74.117 — Prefix match instead of exact equality. FOREACH wraps
  // abort errors with iteration info ("Aborted (iteration 3/5)"); the
  // pre-fix exact-match missed those, so a Cancel mid-FOREACH-inside-TRY
  // would fall through to the recovery branch instead of propagating the
  // cancel — the strategy kept running through recovery against the
  // user's intent. Same shape fixed in chat.js's testRunWorkflow at
  // v2.74.104; this is the executor-side counterpart.
  if (typeof bodyResult.error === 'string' && bodyResult.error.startsWith('Aborted')) {
    // Abort propagates — recovery doesn't run on user-initiated cancel.
    return { error: 'Aborted' };
  }

  ctx.emit({
    type: 'strategy_try_recover',
    stepIndex,
    bodyError: bodyResult.error,
    message: `Step ${stepIndex + 1}: TRY body failed (${bodyResult.error}); running recovery`,
  });

  // Empty recovery → swallow the failure quietly.
  if (recovery.length === 0) {
    ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'try', success: true, message: `Step ${stepIndex + 1}: TRY body failed; recovery is empty → swallowed` });
    return {};
  }

  // v2.74.100 — TRY recovery path: "${parentPath}.recovery".
  const recResult = await executeSteps(recovery, paramValues, workflowScope, ctx, workflow, `${parentPath}.recovery`);
  if (recResult.error) {
    return { error: `Step ${stepIndex + 1} (TRY): body failed (${bodyResult.error}); recovery also failed (${recResult.error})` };
  }

  ctx.emit({ type: 'strategy_step_done', stepIndex, stepType: 'try', success: true, message: `Step ${stepIndex + 1}: TRY recovered` });
  return {};
}
