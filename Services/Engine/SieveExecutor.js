// Services/Engine/SieveExecutor.js — CR-X2 (v2.74.949): the SIEVE node executor, moved whole out of
// ExecutionEngine (~1,700 lines: the node executor, the template/transform/frontier-compose tier
// executors, and the sieve-only helpers). Bodies are byte-identical to the engine versions except:
// (1) member refs retarget ExecutionEngine.# -> SieveExecutor.#; (2) substituteAnalysisParams is PUBLIC
// (ObservationExecutor shares it); (3) NEW isAborted checks at the node/tier/operation boundaries --
// the sieve span previously had none (the CR-X2 review finding).
//
// Registered via ExecutionEngine.#NODE_EXEC (see Services/Engine/nodeRegistry.js for the add-a-type
// recipe). ctx is the engine's execution context; this module touches it only via
// { scope, emit, isAborted, topLevelTotal } — no tab access in the sieve path.
//
// Logger tags stay 'ExecutionEngine' DELIBERATELY: the decisions-log tooling and `gl` trace analysis
// key on the tag, and the sieve is still engine behavior to a trace reader.

import { Logger }                 from '../../Core/Logger.js';
import { resolveBindings, scopeLookup } from '../../Core/bindingResolve.js';
import { StorageManager }         from '../StorageManager.js';
import { Scope, scalar, list, record, document } from '../Scope.js';
import { isBuiltinAnalysisId, getBuiltinAnalysis } from '../BuiltinAnalyses.js';
import { evaluateDataAssertionEnvelope, flattenScopeAssertionRefs, describeDataCondition } from '../DataAssertion.js';
import { describeOperations, describeContract, describePreconditions } from '../AnalysisDescribe.js';
import { AnthropicService }       from '../AnthropicService.js';
import { parseTemplate, evalTemplate } from '../TemplateEngine.js';
import { runTransformBody }            from '../TransformOps.js';

export class SieveExecutor {
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
  static async executeSieveNode(node, ctx, { topLevelIndex, iterationLabel = null }) {
    const { scope, emit, topLevelTotal } = ctx;
    // v2.74.949 (CR-X2) — the sieve span had ZERO abort checks; a user stop now lands at the node
    // boundary, each tier boundary, and each operation boundary instead of riding out the whole sieve.
    if (ctx.isAborted()) return { status: 'aborted' };
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
      analysis = await SieveExecutor.#resolveAnalysis(node.analysisId);
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
        return await SieveExecutor.#executeSieveTemplate(
          node, ctx, analysis, impl0, { topLevelIndex, iterationLabel, label, outputName }
        );
      }
      if (impl0?.body?.kind === 'transform') {
        // Transform body wires by declared name — `node.output` is
        // unused at this layer. The handler reads declared inputs from
        // scope and writes declared outputs back; no check on
        // outputName needed here.
        return await SieveExecutor.#executeSieveTransform(
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
      return await SieveExecutor.#executeSieveFrontierCompose(
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
      bindings = SieveExecutor.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
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
            operations = SieveExecutor.substituteAnalysisParams(rawOps, bindings);
          } else {
            const errMsg = `Step ${topLevelIndex + 1}: SIEVE references Analysis "${node.analysisId}" with unsupported body kind "${body.kind}"`;
            Logger.error('ExecutionEngine', `SIEVE${label} — ${errMsg}`);
            return { status: 'failed', error: errMsg };
          }
        } else {
          // Legacy fallback path — impl with operations directly, or no impl.
          const rawOps = impl?.operations ?? analysis.operations ?? [];
          operations = SieveExecutor.substituteAnalysisParams(rawOps, bindings);
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
      const preConds = SieveExecutor.substituteAnalysisParams(preConditionsRaw, bindings);
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
        SieveExecutor.substituteAnalysisParams(preCondsForDesc, bindings)
      );
      const postDesc = describeContract(
        SieveExecutor.substituteAnalysisParams(postCondsForDesc, bindings)
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
        if (ctx.isAborted()) return { status: 'aborted' };   // v2.74.949 (CR-X2) — abort between operations
        if (op.op === 'filter') {
          items = items.filter(item => SieveExecutor.#evalSieveAssertion(op.assertion, item));
        } else if (op.op === 'sort') {
          const cmp = SieveExecutor.#buildSieveComparator(op.key, op.direction, op.coerceAs);
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
      const postConds = SieveExecutor.substituteAnalysisParams(postConditionsRaw, bindings);
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
    if (ctx.isAborted()) return { status: 'aborted' };   // v2.74.949 (CR-X2) — abort at the tier boundary
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
    const bindings = SieveExecutor.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
    const preEnvelope = analysis?.preconditions;
    const preConditionsRaw = (preEnvelope && Array.isArray(preEnvelope.conditions))
      ? preEnvelope.conditions
      : (Array.isArray(preEnvelope) ? preEnvelope : []);
    if (preConditionsRaw.length > 0) {
      const preConds = SieveExecutor.substituteAnalysisParams(preConditionsRaw, bindings);
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
      const postConds = SieveExecutor.substituteAnalysisParams(postConditionsRaw, bindings);
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
    if (ctx.isAborted()) return { status: 'aborted' };   // v2.74.949 (CR-X2) — abort at the tier boundary
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
    const bindings = SieveExecutor.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
    const preEnvelope = analysis?.preconditions;
    const preConditionsRaw = (preEnvelope && Array.isArray(preEnvelope.conditions))
      ? preEnvelope.conditions
      : (Array.isArray(preEnvelope) ? preEnvelope : []);
    if (preConditionsRaw.length > 0) {
      const preConds = SieveExecutor.substituteAnalysisParams(preConditionsRaw, bindings);
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
    const opsResolved = SieveExecutor.substituteAnalysisParams(body.ops ?? [], bindings);

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
      const postConds = SieveExecutor.substituteAnalysisParams(postConditionsRaw, bindings);
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
    if (ctx.isAborted()) return { status: 'aborted' };   // v2.74.949 (CR-X2) — abort at the tier boundary
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
    const bindings = SieveExecutor.#resolveSieveParamBindings(node.paramBindings ?? {}, scope);
    const preEnvelope = analysis?.preconditions;
    const preCondsRaw = (preEnvelope && Array.isArray(preEnvelope.conditions))
      ? preEnvelope.conditions
      : (Array.isArray(preEnvelope) ? preEnvelope : []);
    if (preCondsRaw.length > 0) {
      const preConds = SieveExecutor.substituteAnalysisParams(preCondsRaw, bindings);
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
        SieveExecutor.substituteAnalysisParams(preFlat.conditions, bindings)
      );
      postDesc = describeContract(
        SieveExecutor.substituteAnalysisParams(postFlat.conditions, bindings)
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
      const postConds = SieveExecutor.substituteAnalysisParams(postCondsRaw, bindings);
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
    // v2.74.943 (CR-D4) — delegates to Core/bindingResolve. Sieve policy preserved: missing → '' (never
    // unset), list → '' (a sieve param is a scalar criterion), record → JSON.stringify(fields), bare-string
    // bindings are literals (back-compat). Gains the v2.50 `field` path for free. One deliberate upgrade:
    // a bare-STRING scope value now resolves to itself (the old chain blanked anything without a .kind —
    // unreachable via the engine Scope, which always tags, so no live behavior changes).
    const { values } = resolveBindings(paramBindings, scopeLookup(scope), { onMissing: 'empty', list: 'empty', record: 'json', plainStringIsLiteral: true });
    return values;
  }

  /**
   * v2.63.0 (Iteration B) — Substitute {{NAME}} placeholders in operation
   * values. Recursively walks the operations array; for any string value,
   * replaces every {{NAME}} occurrence with bindings[NAME]. Non-string
   * values pass through. Returns a new structure; does not mutate input.
   */
  static substituteAnalysisParams(operations, bindings) {
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
        return (assertion.assertions ?? []).every(p => SieveExecutor.#evalSieveAssertion(p, item));
      case 'any_of':
        return (assertion.assertions ?? []).some(p => SieveExecutor.#evalSieveAssertion(p, item));
      case 'not':
        return !SieveExecutor.#evalSieveAssertion(assertion.assertion, item);
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
}
