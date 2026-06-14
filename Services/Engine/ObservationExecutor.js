// Services/Engine/ObservationExecutor.js — CR-X2 (v2.74.949): the OBSERVATION node executor, moved
// whole out of ExecutionEngine (~1,300 lines: the node executor, the vision-tier frontier executor,
// and the blob/tab-url helpers only this path uses). Bodies are byte-identical to the engine versions
// except member refs retarget to this class, params resolve via #resolveObservationBindings (same Core
// resolver + fragment policy the engine uses — see the method note), and {{NAME}} substitution shares
// SieveExecutor.substituteAnalysisParams (the one implementation).
//
// Registered via ExecutionEngine.#NODE_EXEC (see Services/Engine/nodeRegistry.js for the add-a-type
// recipe). Logger tags stay 'ExecutionEngine' DELIBERATELY: the decisions-log tooling and `gl` trace
// analysis key on the tag, and the observation is still engine behavior to a trace reader.

import { Logger }                 from '../../Core/Logger.js';
import { resolveBindings, scopeLookup } from '../../Core/bindingResolve.js';
import { condList }               from '../../Core/postcondition.js';   // the conditions shape-normalizer (array | {match,conditions})
import { StorageManager }         from '../StorageManager.js';
import { TemplateWalker }         from '../TemplateWalker.js';
import { Scope, scalar, list, record, image, section } from '../Scope.js';
import { evaluateDataAssertionEnvelope, flattenScopeAssertionRefs, describeDataCondition } from '../DataAssertion.js';
import { AnthropicService }       from '../AnthropicService.js';
import { SieveExecutor }          from './SieveExecutor.js';

export class ObservationExecutor {
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
  static async executeObservationNode(node, ctx, { topLevelIndex, iterationLabel = null, iteration = null }) {
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
      return await ObservationExecutor.#executeObservationFrontier(
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
    const bindings = ObservationExecutor.#resolveObservationBindings(paramBindings, scope);
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
      : (val) => SieveExecutor.substituteAnalysisParams(val, bindings);
    const obsForConds = {
      ...observation,
      preconditions : sub(observation.preconditions),
      postconditions: sub(observation.postconditions),
    };

    // Preconditions (page-level).
    const preconds = condList(obsForConds.preconditions);
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
          isAborted,   // v2.74.920 (CR-S4) — a cancel exits a long extract-gate wait (up to 30s) at the next tick
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
    const sourceUrlForBindings = await ObservationExecutor.#getTabUrl(tabId);
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

      // v2.74.1008 — Surface a selector heal. The OBSERVE_RAW_TEXT handler
      // returns `healedSelector` (non-null) when the exact, capture-time
      // selector matched 0 elements and a progressively-relaxed variant
      // resolved the read instead (a read demonstrated over a dynamic list
      // whose item-specific classes drifted). Logging it makes the recovery
      // visible in a `gl` trace rather than a silent save.
      if (result.healedSelector) {
        Logger.info('ExecutionEngine', `OBSERVATION${label} — selector healed: exact "${ex.target}" missed → relaxed "${result.healedSelector}" matched`);
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
    const postconds = condList(obsForConds.postconditions);
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
    const bindings = ObservationExecutor.#resolveObservationBindings(paramBindings, scope);

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
    const sub = (val) => declaredParams.length === 0 ? val : SieveExecutor.substituteAnalysisParams(val, bindings);
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
    const preconds = condList(obs.preconditions);
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
        screenshotBase64 = await ObservationExecutor.#blobToBase64(blob);
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
    const postArr = condList(obs.postconditions);
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
    const sourceUrl = await ObservationExecutor.#getTabUrl(tabId);
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
        const base64 = await ObservationExecutor.#blobToBase64(blob);
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
   * v2.74.949 (CR-X2) — the observation node's param resolution. Same Core resolver, same FRAGMENT
   * policy as ExecutionEngine.#resolveFragmentBindings (missing -> UNSET so {{TOKEN}} stays visible,
   * list -> joined ', ', record -> String legacy, v2.50 iteration-record `field` path) — restated here
   * per CR-D4's design: ONE resolver in Core/bindingResolve, per-site POLICY explicit at the call site.
   * @private
   */
  static #resolveObservationBindings(paramBindings, source) {
    return resolveBindings(paramBindings, scopeLookup(source), { onMissing: 'unset', list: 'join', record: 'string' }).values;
  }
}
