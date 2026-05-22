/**
 * @file CapabilityAPI.js
 * @module Services/CapabilityAPI
 * @version 2.19.0
 *
 * Stable contract between the Grounding Lab (capability provider) and any
 * interface that consumes capabilities (chat UI, future web app, CLI, etc).
 *
 * Capabilities = Grounds + their Profile + their Procedure metadata, projected
 * into a portable Capability Descriptor format that makes no assumption about
 * how it was built.
 *
 * Invocations are first-class addressable resources: every invoke() returns
 * an invocationId that becomes the handle for observation, cancellation, and
 * status queries. Multiple invocations can run concurrently — events are
 * tagged by invocationId so consumers can demultiplex correctly.
 *
 * The API is provider-internal: this module is called by background.js
 * message handlers, which expose the surface to the extension via
 * chrome.runtime messages. External transports (WebSocket bridge, etc) can
 * later wrap the same API.
 *
 * Concurrency policies:
 *   MAX_CONCURRENT_INVOCATIONS  — global cap across all invocations
 *   MAX_CONCURRENT_PER_CAPABILITY — only one invocation of the same capability at once
 *   MAX_CONCURRENT_PER_DOMAIN   — cap per target domain (avoid site-side conflicts)
 *
 * Invocations exceeding caps enter `queued` status; transition to `running`
 * when capacity is available. Consumers see the queued state via events and
 * via getInvocation().
 */

import { Logger }          from '../Core/Logger.js';
import { StorageManager }  from './StorageManager.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import { SchemaValidator } from './SchemaValidator.js';
import { InjectionService } from './InjectionService.js';
import { AnthropicService } from './AnthropicService.js';
import { normalizeStrategyBody, countExecutableNodes, normalizeStrategyParams } from './StrategyTree.js';
// v2.74.82 — Top-level Strategy entity (storage kind: 'workflow') dispatches
// through its own runtime. CapabilityAPI now exposes BOTH Workflows
// (Ground-scoped, the historical "Strategy") and Strategies (top-level
// orchestrations) as capabilities; invoke() routes by entityKind.
import { executeWorkflow } from './WorkflowExecutor.js';

/**
 * Event types emitted by the CapabilityAPI.
 * Consumers subscribe to these via chrome.runtime.onMessage in the extension
 * environment, or via the WebSocket protocol externally.
 */
export const EVENT = Object.freeze({
  REGISTRY_CHANGED      : 'capability.registry_changed',
  INVOCATION_QUEUED     : 'invocation.queued',
  INVOCATION_STARTED    : 'invocation.started',
  INVOCATION_PROGRESS   : 'invocation.progress',
  INVOCATION_COMPLETED  : 'invocation.completed',
  INVOCATION_FAILED     : 'invocation.failed',
  INVOCATION_CANCELLED  : 'invocation.cancelled',
});

/**
 * Invocation status values.
 */
export const STATUS = Object.freeze({
  QUEUED   : 'queued',
  RUNNING  : 'running',
  COMPLETED: 'completed',
  FAILED   : 'failed',
  CANCELLED: 'cancelled',
});

export class CapabilityAPI {
  // ── Concurrency configuration ─────────────────────────────────────────────
  static MAX_CONCURRENT_INVOCATIONS  = 5;
  static MAX_CONCURRENT_PER_CAPABILITY = 1;
  static MAX_CONCURRENT_PER_DOMAIN   = 2;

  // ── Internal state ────────────────────────────────────────────────────────
  /** @private — Map<invocationId, InvocationRecord> */
  static #invocations = new Map();
  // v2.74.115 — `#queue` sidecar array removed. It was pushed on every
  // invoke but never spliced on QUEUED→RUNNING transition (only on
  // queued-cancel), so it grew unboundedly and `getCapacityStatus.queued`
  // reported an inflated count forever. The queued count is now derived
  // by filtering `#invocations.values()` for `status === QUEUED`, which is
  // O(n) but n stays tiny (a few hundred at most before the SW is killed
  // for idle). #tryStartNext was already iterating the Map, not the queue,
  // so removing the array has no semantic effect on the scheduler.
  /** @private — Set of subscribers receiving all events */
  static #subscribers = new Set();
  /** @private — ExecutionEngine instance (set via setEngine by background.js) */
  static #engine = null;

  /**
   * Provide the ExecutionEngine instance for invocation execution.
   * Must be called once at startup before any invoke() calls.
   * @param {ExecutionEngine} engine
   */
  static setEngine(engine) {
    CapabilityAPI.#engine = engine;
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ REGISTRY                                                             ║
  // ╚══════════════════════════════════════════════════════════════════════╝

  /**
   * List all capabilities matching optional filters.
   * @param {{ kinds?: string[], status?: string }} [filter]
   * @returns {Promise<CapabilityDescriptor[]>}
   */
  /**
   * List all capability descriptors. A Capability now corresponds to a
   * Strategy (v2.21.0 Pass A — Fragments are implementation details and
   * are not exposed as capabilities). Filters by kind / status.
   * @param {{ kinds?: string[], status?: string }} [filter]
   * @returns {Promise<CapabilityDescriptor[]>}
   */
  static async listCapabilities(filter = {}) {
    const descriptors = [];

    // Ground-scoped Workflows (the historical "Strategy"; entityKind='workflow').
    const workflows = await StorageManager.getAllStrategies();
    for (const workflow of workflows) {
      const desc = await CapabilityAPI.#buildDescriptor(workflow);
      if (!desc) continue;
      if (filter.kinds?.length && !filter.kinds.includes(desc.kind))   continue;
      if (filter.status && desc.status !== filter.status)              continue;
      descriptors.push(desc);
    }

    // v2.74.82 — Top-level Strategy entities (entityKind='strategy').
    // These don't belong to a Ground; their bodies are composition steps
    // (Workflow / Analysis invocations + control flow). Invocation routes
    // through WorkflowExecutor instead of ExecutionEngine.executeStrategy.
    const strategies = await StorageManager.listWorkflows();
    for (const strategy of strategies) {
      const desc = CapabilityAPI.#buildStrategyEntityDescriptor(strategy);
      if (!desc) continue;
      if (filter.kinds?.length && !filter.kinds.includes(desc.kind))   continue;
      if (filter.status && desc.status !== filter.status)              continue;
      descriptors.push(desc);
    }

    return descriptors;
  }

  /**
   * Get a single capability descriptor by ID (strategyId).
   * @param {string} capabilityId
   * @returns {Promise<CapabilityDescriptor|null>}
   */
  static async getCapability(capabilityId) {
    // v2.74.82 — Try the Workflow store first (historical Strategy), then
    // fall back to the Strategy-entity store. UUID v4 collisions between
    // the two stores are astronomical; if one is ever found, the Workflow
    // wins (matches the old behavior).
    const workflow = await StorageManager.getStrategy(capabilityId);
    if (workflow) return CapabilityAPI.#buildDescriptor(workflow);
    const strategy = await StorageManager.getWorkflow(capabilityId);
    if (strategy) return CapabilityAPI.#buildStrategyEntityDescriptor(strategy);
    return null;
  }

  /**
   * OPTIONAL helper — semantic match of a natural-language query to capabilities.
   *
   * The Lab provides this as a convenience because LLM-based routing is genuinely
   * useful and most interfaces want it. Interfaces are NOT required to use this:
   * they can implement their own routing using descriptor.triggers,
   * descriptor.summary, descriptor.domains, or any other strategy.
   *
   * Returns ranked capability candidates with confidence scores and brief reasons.
   * Filters by status='ready' and (optionally) kind. Below-threshold candidates
   * are dropped. Returns an empty array if no capabilities are eligible or if
   * the LLM call fails — interfaces should handle the empty case (e.g. fall
   * back to showing all capabilities or asking the user to disambiguate).
   *
   * @param {string} query - Natural-language input from the user
   * @param {Object} [options]
   * @param {string[]} [options.kinds]          - Filter to specific kinds (default: all)
   * @param {number}   [options.limit=5]        - Max candidates to return
   * @param {number}   [options.minConfidence=0.2] - Drop candidates below this score
   * @returns {Promise<{capabilityId: string, name: string, confidence: number, reason: string}[]>}
   */
  static async match(query, options = {}) {
    const { kinds, limit = 5, minConfidence = 0.2 } = options;
    if (!query || !query.trim()) return [];

    // Only ready capabilities are routable
    const candidates = await CapabilityAPI.listCapabilities({ status: 'ready' });
    const filtered   = kinds?.length
      ? candidates.filter(c => kinds.includes(c.kind))
      : candidates;
    if (filtered.length === 0) return [];

    // Build profiles in the shape AnthropicService.matchQuestionToGround expects:
    // { groundId, aiName, profile: <descriptor-like object> }
    const groundProfiles = filtered.map(c => ({
      groundId: c.id,
      aiName  : c.name,
      profile : {
        summary     : c.summary,
        description : c.description,
        domains     : c.domains,
        triggers    : c.triggers,
        capabilities: c.capabilities,
        limitations : c.limitations,
        kind        : c.kind,
      },
    }));

    Logger.info('CapabilityAPI', `match: "${query.slice(0, 60)}" against ${groundProfiles.length} capability/ies`);

    let ranked;
    try {
      ranked = await AnthropicService.matchQuestionToGround({ question: query, groundProfiles });
    } catch (err) {
      Logger.warn('CapabilityAPI', `match failed: ${err.message}`);
      return [];
    }

    // Project to the descriptor-shaped result
    return ranked
      .filter(r => r.confidence >= minConfidence)
      .slice(0, limit)
      .map(r => ({
        capabilityId: r.groundId,
        name        : r.aiName,
        confidence  : r.confidence,
        reason      : r.reason ?? '',
      }));
  }

  /**
   * Build a portable Capability Descriptor from a Strategy + its parent
   * Ground. v2.21.0 Pass A: Strategies don't yet have profiles (Pass C
   * will add that) so the descriptor is built from the Strategy's stored
   * fields directly. Params come from the Strategy's declared params.
   *
   * The Strategy owns task metadata (name, goal, aliases, outcomeSignal,
   * params). The Ground contributes the url/domain.
   * @private
   */
  static async #buildDescriptor(strategy) {
    if (!strategy) return null;
    const ground = await StorageManager.getGround(strategy.groundId);

    // Parameters — Strategy declares them directly; Pass C may enrich via
    // per-Fragment parameter profiles.
    //
    // v2.74.65 — Typed strategy inputs. Pre-v2.74.64 strategies stored params
    // as bare-string arrays; the new canonical shape carries type/required/
    // accept/parse/default. Normalize here so the descriptor consumers (chat,
    // Studio invocation) always see the rich shape regardless of when the
    // strategy was last saved. The descriptor still keys by NAME for backward
    // compatibility — typed fields are added as siblings of the existing
    // description/required.
    const normParams = normalizeStrategyParams(strategy.params);
    const parameters = {};
    for (const p of normParams) {
      parameters[p.name] = {
        type        : p.type,                    // 'string' | 'number' | 'boolean' | 'file'
        kind        : p.kind,                    // 'scalar' | 'list'
        description : p.name.replace(/_/g, ' ').toLowerCase(),
        required    : p.required,
        ...(p.type === 'file' && {
          accept: p.accept ?? '',
          parse:  p.parse  ?? 'auto',
          ...(Number.isFinite(p.maxBytes) && { maxBytes: p.maxBytes }),
        }),
        ...(p.default !== undefined && { default: p.default }),
      };
    }

    // Status: a Strategy is 'ready' when it has at least one executable node.
    // v2.29.2 (Pass E2-3) — With FOREACH in the tree, "at least one node"
    // isn't enough — a Strategy that is just a FOREACH with an empty body
    // or only non-fragment nodes has nothing runnable. Use
    // countFragmentInvocations so status reflects executable content.
    // v2.60.1 — widened to countExecutableNodes. Strategies legitimately may
    // contain only non-fragment nodes (NAVIGATE-then-PAUSE-then-NAVIGATE,
    // pure-WAIT smoke tests, etc.). Any non-empty body counts as ready.
    const hasPlan = countExecutableNodes(normalizeStrategyBody(strategy.fragmentSteps)) > 0
      || (!!strategy.plan && (
        Array.isArray(strategy.plan) ? strategy.plan.length > 0 :
        typeof strategy.plan === 'object' && strategy.plan.body?.length > 0
      ));
    const status = hasPlan ? 'ready' : 'draft';

    return {
      id          : strategy.id,
      name        : strategy.name ?? 'Untitled Workflow',
      kind        : 'task',
      // v2.74.82 — entityKind discriminator. Workflows = the Ground-scoped
      // fragment-tree primitive. Strategies (entityKind='strategy') are
      // top-level orchestrations built atop Workflows + Analyses; their
      // descriptor is built by #buildStrategyEntityDescriptor.
      entityKind  : 'workflow',
      version     : strategy.updatedAt ? new Date(strategy.updatedAt).toISOString() : null,
      summary     : strategy.goal ?? '',
      description : strategy.goal ?? '',
      domains     : ground?.url ? [new URL(ground.url).hostname] : [],
      triggers    : Array.isArray(strategy.aliases) ? strategy.aliases : [],
      parameters,
      capabilities: [],
      limitations : [],
      outcomeSignal : strategy.outcomeSignal ?? null,
      resultTemplate: strategy.resultTemplate ?? '',   // E1 (v2.26.0)
      status,
    };
  }

  /**
   * v2.74.82 — Build a portable Capability Descriptor for a top-level
   * Strategy entity (storage shape: `workflow`). Strategies don't belong
   * to any single Ground — their bodies invoke Workflows that may live on
   * different Grounds. Domains[] is empty; triggers[] is empty until the
   * Strategy entity grows aliases.
   *
   * Status: 'ready' if there's at least one step, 'draft' otherwise.
   * Authors will see the draft pill on the Strategy row in Studio (see
   * `renderWorkflowEntityList`).
   *
   * @private
   */
  static #buildStrategyEntityDescriptor(strategy) {
    if (!strategy) return null;

    const normParams = normalizeStrategyParams(strategy.params);
    const parameters = {};
    for (const p of normParams) {
      parameters[p.name] = {
        type        : p.type,
        kind        : p.kind,
        description : p.name.replace(/_/g, ' ').toLowerCase(),
        required    : p.required,
        ...(p.type === 'file' && {
          accept: p.accept ?? '',
          parse:  p.parse  ?? 'auto',
          ...(Number.isFinite(p.maxBytes) && { maxBytes: p.maxBytes }),
        }),
        ...(p.default !== undefined && { default: p.default }),
      };
    }

    const stepCount = Array.isArray(strategy.steps) ? strategy.steps.length : 0;
    const status = stepCount > 0 ? 'ready' : 'draft';

    return {
      id          : strategy.id,
      name        : strategy.name ?? 'Untitled Strategy',
      kind        : 'task',
      entityKind  : 'strategy',
      version     : strategy.updatedAt ? new Date(strategy.updatedAt).toISOString() : null,
      summary     : strategy.description ?? '',
      description : strategy.description ?? '',
      // Strategies span Grounds. The future composition introspector
      // could derive domains by collecting each step's referenced Workflow's
      // Ground hostnames — useful for chat routing — but that's deferred.
      domains     : [],
      // v2.74.83 — Aliases now flow from authoring into the descriptor's
      // triggers field. Empty array if the Strategy doesn't declare any —
      // chat routing falls back to name + description matching.
      triggers    : Array.isArray(strategy.aliases) ? strategy.aliases : [],
      parameters,
      capabilities: [],
      limitations : [],
      outcomeSignal : null,
      // v2.74.85 — Result template (chat-side headline rendering). Chat
      // (chat.js) reads cap.resultTemplate from the descriptor and runs
      // {{NAME}} substitution against extractedValues, mirroring how
      // Workflow results render.
      resultTemplate: typeof strategy.resultTemplate === 'string' ? strategy.resultTemplate : '',
      status,
    };
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ INVOCATION                                                           ║
  // ╚══════════════════════════════════════════════════════════════════════╝

  /**
   * Invoke a capability (Strategy). Creates an invocation record, queues it,
   * and returns { invocationId, status }. Completion flows back through event
   * subscribers; callers listen via onEvent() rather than awaiting this call.
   *
   * @param {string} capabilityId - strategyId
   * @param {Object} input        - { question?, params?: { PARAM_NAME: value } }
   * @param {Object} [options]    - { invocationId?, debug? }
   *   v2.38.0 (Pass K1) options.debug:
   *     { pauseMode: 'off'|'after-node'|'after-fragment' }
   *   When set, the invocation runs in debug mode. The record carries the
   *   pause flag (`debugPaused`) which the engine polls; the side panel
   *   mutates it via setDebugPaused / debugStep / etc.
   *
   * @returns {Promise<{ invocationId: string, status: string }>}
   */
  static async invoke(capabilityId, input = {}, options = {}) {
    // v2.74.82 — Resolve the capability across both stores. The historical
    // Workflow store (StorageManager.getStrategy) wins on UUID collision —
    // see getCapability for the same precedence.
    let entity, entityKind, capabilityName, totalSteps;
    const workflow = await StorageManager.getStrategy(capabilityId);
    if (workflow) {
      entity = workflow; entityKind = 'workflow';
      capabilityName = workflow.name ?? 'Unnamed Workflow';
      totalSteps = (workflow.fragmentSteps ?? []).length;
    } else {
      const strategy = await StorageManager.getWorkflow(capabilityId);
      if (!strategy) throw new Error(`Capability not found: ${capabilityId}`);
      entity = strategy; entityKind = 'strategy';
      capabilityName = strategy.name ?? 'Unnamed Strategy';
      totalSteps = (strategy.steps ?? []).length;
    }

    const invocationId = options.invocationId
      ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `inv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

    const debugMode = options.debug?.pauseMode ?? 'off';
    // v2.38.2 (K1.1) — caller can override the initial paused state.
    // Chat opt-in flow: paused-from-start (user explicitly chose debug, they
    // want to step). Studio ▶ flow: run-live-by-default (debug is implicit
    // for studio test-runs; user clicks Pause to break in).
    // Default preserves the chat behavior when caller doesn't specify.
    // v2.74.82 — Strategy-entity invocations ignore debug mode (the
    // Strategy-tier runtime doesn't carry a debug envelope yet); kept on
    // the rec for symmetry.
    const startPaused = options.debug?.startPaused ?? (debugMode !== 'off');
    const rec = {
      invocationId,
      capabilityId,
      capabilityName,
      // v2.74.82 — routing discriminator. #startInvocation reads this to
      // pick between ExecutionEngine.executeStrategy and executeWorkflow.
      entityKind,
      input         : input ?? {},
      status        : STATUS.QUEUED,
      progress      : { step: 0, total: totalSteps },
      createdAt     : Date.now(),
      startedAt     : null,
      completedAt   : null,
      result        : null,
      error         : null,
      // v2.38.0 (Pass K1) — debug state. debugMode:'off' means no pausing.
      // v2.38.2 (K1.1) — initial paused state respects options.debug.startPaused
      // (default: paused-from-start when debug is on, matches chat opt-in flow).
      debugMode,
      debugPaused   : startPaused,
      debugLastPauseInfo: null,    // stored from engine's pause-state callback
      // v2.71.4 — Conversation linkage. Set when chat invokes; lets the
      // background event handler write result messages to the right
      // conversation even when chat panel is closed at completion time.
      // Optional — studio test-runs don't set this.
      conversationId: options.conversationId ?? null,
    };

    CapabilityAPI.#invocations.set(invocationId, rec);
    Logger.info('CapabilityAPI', `Invocation queued: ${invocationId} for ${entityKind} "${capabilityName}"`);

    CapabilityAPI.#tryStartNext();

    // v2.74.115 — Emit INVOCATION_QUEUED if capacity was exhausted and the
    // record actually ended up queued. #tryStartNext flips status to RUNNING
    // synchronously when capacity is available; if it didn't, the consumer
    // benefits from an explicit queued event so any UI showing queue state
    // (chat's running bar, etc.) can render it. Previously the constant was
    // defined but never emitted — chat had no event-driven path to display
    // queued invocations.
    if (rec.status === STATUS.QUEUED) {
      CapabilityAPI.#emit(EVENT.INVOCATION_QUEUED, {
        invocationId,
        capabilityId,
        capabilityName,
      });
    }

    return { invocationId, status: rec.status };
  }

  /**
   * Cancel an in-flight or queued invocation.
   * @param {string} invocationId
   * @returns {Promise<boolean>} true if cancelled, false if not found or already terminal
   */
  static async cancel(invocationId) {
    const rec = CapabilityAPI.#invocations.get(invocationId);
    if (!rec) return false;
    if (rec.status !== STATUS.QUEUED && rec.status !== STATUS.RUNNING) return false;

    if (rec.status === STATUS.QUEUED) {
      // v2.74.115 — Queue array removed; #tryStartNext skips records with
      // status !== QUEUED, so setting status here is the only step needed
      // to keep the cancelled record from being picked up.
      rec.status = STATUS.CANCELLED;
      rec.completedAt = Date.now();
      CapabilityAPI.#emit(EVENT.INVOCATION_CANCELLED, { invocationId });
      return true;
    }

    // Running — cancellation propagates via the `isAborted` polling
    // closures wired in #startInvocation / #startStrategyInvocation
    // (`isAborted: () => rec.status === STATUS.CANCELLED`). The executor
    // sees the flipped status on its next yield-point and unwinds.
    // v2.74.115 — Removed the dead `engine.abortJob(rec.jobId)` path:
    // `rec.jobId` was never set, so abortJob was always called with
    // `undefined` and effectively no-op'd. The polling path covers
    // cancellation correctly.
    rec.status = STATUS.CANCELLED;
    rec.completedAt = Date.now();
    CapabilityAPI.#emit(EVENT.INVOCATION_CANCELLED, { invocationId });
    CapabilityAPI.#tryStartNext();
    return true;
  }

  // ── v2.38.0 (Pass K1) — debug controls ─────────────────────────────────
  //
  // For invocations started with options.debug, the side panel uses these
  // methods to drive stepwise execution. The engine polls rec.debugPaused
  // every 100ms while paused; setting it to false releases the pause.

  /**
   * Resume a paused debug invocation. Sets debugPaused to false so the
   * engine continues running until the next yield point (or completion).
   * The engine will pause again at the next yield because... wait, no it
   * won't — debugResume runs until done. Use debugStep() for "advance one
   * yield then pause again."
   *
   * @returns {boolean} true if a paused invocation was found and released
   */
  static debugResume(invocationId) {
    const rec = CapabilityAPI.#invocations.get(invocationId);
    if (!rec || rec.debugMode === 'off') return false;
    rec.debugPaused = false;
    Logger.info('CapabilityAPI', `[${invocationId}] debug resume`);
    return true;
  }

  /**
   * Step a paused debug invocation. Releases the pause once, then re-arms
   * automatically so the next yield point pauses again. This implements
   * stepwise execution.
   *
   * Implementation: we set debugPaused=false to release. The engine's
   * onPauseStateChange callback fires with paused=false; that callback
   * (set in #startInvocation) checks rec.debugStepPending and re-arms
   * debugPaused if so.
   *
   * @returns {boolean}
   */
  static debugStep(invocationId) {
    const rec = CapabilityAPI.#invocations.get(invocationId);
    if (!rec || rec.debugMode === 'off') return false;
    Logger.info('CapabilityAPI', `[${invocationId}] debug step`);
    rec.debugStepPending = true;   // re-arm flag, consumed by onPauseStateChange
    rec.debugPaused = false;
    return true;
  }

  /**
   * Pause a running debug invocation. Sets debugPaused to true so the next
   * yield point causes a pause. If the invocation is currently between
   * yield points (mid-fragment), the pause takes effect at the next yield.
   *
   * @returns {boolean}
   */
  static debugPause(invocationId) {
    const rec = CapabilityAPI.#invocations.get(invocationId);
    if (!rec || rec.debugMode === 'off') return false;
    rec.debugPaused = true;
    Logger.info('CapabilityAPI', `[${invocationId}] debug pause requested`);
    return true;
  }

  /** Get the most recent pause-state snapshot for a debug invocation. */
  static getDebugPauseInfo(invocationId) {
    const rec = CapabilityAPI.#invocations.get(invocationId);
    return rec?.debugLastPauseInfo ?? null;
  }

  /**
   * Snapshot of an invocation's current state.
   * @param {string} invocationId
   * @returns {InvocationSnapshot|null}
   */
  static getInvocation(invocationId) {
    const rec = CapabilityAPI.#invocations.get(invocationId);
    if (!rec) return null;
    return {
      invocationId   : rec.invocationId,
      capabilityId   : rec.capabilityId,
      capabilityName : rec.capabilityName,
      // v2.74.115 — `entityKind` exposed (was `kind`, which was never set
      // on rec and always undefined). Consumers that route on capability
      // shape can use this to discriminate workflow vs strategy.
      entityKind     : rec.entityKind,
      status         : rec.status,
      progress       : rec.progress,
      // v2.74.115 — `createdAt` matches the rec field (was `queuedAt`,
      // which was never set on rec and always undefined). This broke
      // listInvocations' `since` filter — `(undefined ?? 0) < since` is
      // always true for any positive `since`, so the filter excluded
      // nothing. Renaming fixes the filter via the rec.createdAt check
      // in listInvocations below.
      createdAt      : rec.createdAt,
      startedAt      : rec.startedAt,
      completedAt    : rec.completedAt,
      result         : rec.result,
      error          : rec.error,
      // v2.60.4 — include debugMode so the debugger panel's adoption /
      // boot-poll paths can filter to debug invocations. Without this,
      // GET_ACTIVE_DEBUG_INVOCATION and GET_DEBUG_INVOCATION_BY_ID return
      // snapshots without debugMode; the handlers' debugMode checks fail;
      // the debugger never attaches and shows the idle "ready" screen.
      debugMode      : rec.debugMode,
      // v2.71.4 — Conversation linkage. Background uses this to route
      // terminal events back to ConversationStore even when chat panel
      // is closed.
      conversationId : rec.conversationId,
    };
  }

  /**
   * List invocations, optionally filtered.
   * @param {{ status?: string, capabilityId?: string, since?: number }} [filter]
   * @returns {InvocationSnapshot[]}
   */
  static listInvocations(filter = {}) {
    const out = [];
    for (const rec of CapabilityAPI.#invocations.values()) {
      if (filter.status && rec.status !== filter.status)             continue;
      if (filter.capabilityId && rec.capabilityId !== filter.capabilityId) continue;
      // v2.74.115 — Filter on `createdAt` (was `queuedAt`, never set on
      // rec — so the since filter was a silent no-op for any caller).
      if (filter.since && (rec.createdAt ?? 0) < filter.since)       continue;
      out.push(CapabilityAPI.getInvocation(rec.invocationId));
    }
    return out;
  }

  /**
   * Capacity status — useful for UI to show "running 3 of 5".
   */
  static getCapacityStatus() {
    // v2.74.115 — Both counts derived from the invocations Map. Previously
    // `queued` was `#queue.length`, but #queue was a sidecar array that
    // never drained on QUEUED→RUNNING and reported an inflated count
    // forever. Single source of truth now.
    let running = 0, queued = 0;
    for (const rec of CapabilityAPI.#invocations.values()) {
      if      (rec.status === STATUS.RUNNING) running++;
      else if (rec.status === STATUS.QUEUED)  queued++;
    }
    return {
      running,
      queued,
      maxConcurrent: CapabilityAPI.MAX_CONCURRENT_INVOCATIONS,
      available    : Math.max(0, CapabilityAPI.MAX_CONCURRENT_INVOCATIONS - running),
    };
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ EVENTS / SUBSCRIPTIONS                                               ║
  // ╚══════════════════════════════════════════════════════════════════════╝

  /**
   * Subscribe to all capability events. Returns an unsubscribe function.
   * @param {(event: { type: string, ...payload }) => void} callback
   * @returns {() => void}
   */
  static subscribe(callback) {
    CapabilityAPI.#subscribers.add(callback);
    return () => CapabilityAPI.#subscribers.delete(callback);
  }

  /** @private */
  static #emit(type, payload) {
    const event = { type, timestamp: Date.now(), ...payload };
    for (const sub of CapabilityAPI.#subscribers) {
      try { sub(event); } catch (e) { Logger.warn('CapabilityAPI', `subscriber threw: ${e.message}`); }
    }
  }

  // ╔══════════════════════════════════════════════════════════════════════╗
  // ║ EXECUTION ROUTING                                                    ║
  // ╚══════════════════════════════════════════════════════════════════════╝

  /**
   * Try to start the next queued invocation if capacity allows.
   * Respects MAX_CONCURRENT_INVOCATIONS, MAX_CONCURRENT_PER_CAPABILITY,
   * MAX_CONCURRENT_PER_DOMAIN.
   * @private
   */
  static #tryStartNext() {
    // Find next queued invocation that respects all concurrency policies
    for (const rec of CapabilityAPI.#invocations.values()) {
      if (rec.status !== STATUS.QUEUED) continue;

      const running = [...CapabilityAPI.#invocations.values()].filter(r => r.status === STATUS.RUNNING);
      if (running.length >= CapabilityAPI.MAX_CONCURRENT_INVOCATIONS) return;

      const sameCap = running.filter(r => r.capabilityId === rec.capabilityId).length;
      if (sameCap >= CapabilityAPI.MAX_CONCURRENT_PER_CAPABILITY) continue;

      const sameDomain = rec.domain
        ? running.filter(r => r.domain === rec.domain).length
        : 0;
      if (sameDomain >= CapabilityAPI.MAX_CONCURRENT_PER_DOMAIN) continue;

      // OK to start
      CapabilityAPI.#startInvocation(rec).catch(e => {
        Logger.error('CapabilityAPI', `Invocation ${rec.invocationId} start failed: ${e.message}`);
      });
    }
  }

  /**
   * Pass C — Begin executing an invocation by dispatching to
   * ExecutionEngine.executeStrategy. Wires progress/completion events back to
   * subscribers tagged with invocationId.
   * @private
   */
  static async #startInvocation(rec) {
    rec.status    = STATUS.RUNNING;
    rec.startedAt = Date.now();

    try {
      // v2.74.82 — Route by entityKind. Workflow entities (the historical
      // Ground-scoped Strategy) go through ExecutionEngine.executeStrategy.
      // Top-level Strategy entities go through executeWorkflow.
      if (rec.entityKind === 'strategy') {
        await CapabilityAPI.#startStrategyInvocation(rec);
        return;
      }

      // capabilityId === strategyId (Workflow entity id)
      const strategy = await StorageManager.getStrategy(rec.capabilityId);
      if (!strategy) throw new Error(`Workflow not found: ${rec.capabilityId}`);
      const ground = await StorageManager.getGround(strategy.groundId);
      if (!ground) throw new Error(`Parent ground ${strategy.groundId} not found for workflow ${strategy.id}`);

      // Strategy-level param values come from the caller (chat provides
      // { params: { QUERY: 'software engineer' } } or similar).
      const strategyParamValues = rec.input?.params ?? {};

      CapabilityAPI.#emit(EVENT.INVOCATION_STARTED, {
        invocationId  : rec.invocationId,
        capabilityId  : rec.capabilityId,
        capabilityName: rec.capabilityName,
        totalSteps    : (strategy.fragmentSteps ?? []).length,
        // v2.38.2 (K1.1) — debug mode flag for side-panel auto-render.
        // Side panel checks this on receipt to decide whether to attach
        // debug controls to the chat message it creates for this invocation.
        debugMode     : rec.debugMode,
      });

      // Dispatch — async, but we don't await here. Completion flows through
      // handleStrategyResult via the onProgress callback below (we translate
      // its events into CapabilityAPI events).
      ExecutionEngine.executeStrategy({
        strategyId          : rec.capabilityId,
        strategyParamValues,
        invocationId        : rec.invocationId,
        isAborted           : () => rec.status === STATUS.CANCELLED,
        onProgress          : (ev) => CapabilityAPI.#translateProgressEvent(rec, ev),
        // v2.38.0 (Pass K1) — debug controls. The record holds debugPaused;
        // the engine polls via the closure. Side panel mutates the record
        // through CapabilityAPI.debugResume / debugStep / debugPause.
        debug: rec.debugMode === 'off' ? null : {
          pauseMode: rec.debugMode,
          isPaused: () => rec.debugPaused,
          isStepping: () => false,
          // v2.60.0 — PAUSE node entry channel. The engine calls this when
          // execution reaches a PAUSE node, so the invocation flips into
          // paused state. Resume then proceeds via the existing
          // CapabilityAPI.debugResume → rec.debugPaused = false path.
          requestPause: () => { rec.debugPaused = true; },
          onPauseStateChange: (state) => {
            rec.debugLastPauseInfo = state.paused ? state : null;
            // v2.38.0 (Pass K1) — step semantics. When the engine signals
            // it has just resumed (paused=false), check if we have a step
            // pending. If yes, re-arm debugPaused so the next yield-point
            // pauses again. This implements "single step then pause."
            if (state.paused === false && rec.debugStepPending) {
              rec.debugStepPending = false;
              rec.debugPaused = true;
            }
          },
        },
      }).then((result) => {
        CapabilityAPI.#completeInvocation(rec, result);
      }).catch((err) => {
        Logger.error('CapabilityAPI', `Strategy execution threw: ${err.message}`);
        CapabilityAPI.#completeInvocation(rec, {
          success: false, error: err.message, stepResults: [],
        });
      });
    } catch (err) {
      rec.status      = STATUS.FAILED;
      rec.completedAt = Date.now();
      rec.error       = err.message;
      Logger.error('CapabilityAPI', `Invocation ${rec.invocationId} start failed: ${err.message}`);
      CapabilityAPI.#emit(EVENT.INVOCATION_FAILED, {
        invocationId  : rec.invocationId,
        capabilityId  : rec.capabilityId,
        capabilityName: rec.capabilityName,
        error         : err.message,
        result        : null,
      });
      CapabilityAPI.#tryStartNext();
    }
  }

  /**
   * v2.74.82 — Strategy-entity invocation dispatch. Mirrors #startInvocation's
   * Workflow path but routes through WorkflowExecutor.executeWorkflow instead
   * of ExecutionEngine.executeStrategy. Debug controls are intentionally
   * dropped — the Strategy-tier runtime has no debugger envelope yet (PAUSE
   * steps are skipped per v2.74.80). Cancellation works via the same
   * rec.status check.
   *
   * Events emitted by executeWorkflow (`strategy_start`, `strategy_step_*`,
   * `strategy_done`, etc.) pass through #translateProgressEvent unchanged;
   * the receiver-side renderers ignore unknown phase strings.
   *
   * @private
   */
  static async #startStrategyInvocation(rec) {
    const strategy = await StorageManager.getWorkflow(rec.capabilityId);
    if (!strategy) throw new Error(`Strategy not found: ${rec.capabilityId}`);

    const paramValues = rec.input?.params ?? {};

    CapabilityAPI.#emit(EVENT.INVOCATION_STARTED, {
      invocationId  : rec.invocationId,
      capabilityId  : rec.capabilityId,
      capabilityName: rec.capabilityName,
      totalSteps    : (strategy.steps ?? []).length,
      debugMode     : 'off',
    });

    executeWorkflow(strategy, paramValues, {
      invocationId: rec.invocationId,
      isAborted   : () => rec.status === STATUS.CANCELLED,
      onProgress  : (ev) => CapabilityAPI.#translateProgressEvent(rec, ev),
    }).then((result) => {
      CapabilityAPI.#completeInvocation(rec, result);
    }).catch((err) => {
      Logger.error('CapabilityAPI', `Strategy execution threw: ${err.message}`);
      CapabilityAPI.#completeInvocation(rec, {
        success: false, error: err.message, stepResults: [],
      });
    });
  }

  /**
   * Pass C — Translate an ExecutionEngine progress event into a CapabilityAPI
   * subscriber event. Keeps the two layers decoupled: the engine emits
   * fragment-scoped events, CapabilityAPI emits invocation-scoped events.
   * @private
   */
  static #translateProgressEvent(rec, ev) {
    if (!ev || typeof ev !== 'object') return;
    // Engine events: { type: 'start' | 'fragment_start' | 'fragment_complete' | 'fragment_failed' | 'paused' | 'resumed' | ... }
    const stepNow = (typeof ev.stepIdx === 'number') ? ev.stepIdx + 1 : null;
    rec.progress = { step: stepNow ?? rec.progress?.step ?? 0, total: ev.totalSteps ?? rec.progress?.total ?? 0 };
    const payload = {
      invocationId  : rec.invocationId,
      capabilityId  : rec.capabilityId,
      capabilityName: rec.capabilityName,
      step          : rec.progress.step,
      total         : rec.progress.total,
      phase         : ev.type,
      fragmentName  : ev.fragmentName ?? '',
      action        : ev.action ?? '',
      message       : ev.message ?? '',
      error         : ev.error ?? null,
    };
    // v2.38.0 (Pass K1) — forward debug snapshot fields when present.
    // The side panel needs scope, url, nodeIdx, nodeLabel to render the
    // "Paused at step N: foo" status.
    // v2.61.1 — also forward for node_complete events so the Scope tab
    // updates during running, not just on pause.
    if (ev.type === 'paused' || ev.type === 'resumed' || ev.type === 'node_complete') {
      if (ev.scopeSnapshot) payload.scopeSnapshot = ev.scopeSnapshot;
      if (ev.url != null) payload.url = ev.url;
      if (ev.nodeIdx != null) payload.nodeIdx = ev.nodeIdx;
      if (ev.totalNodes != null) payload.totalNodes = ev.totalNodes;
      if (ev.nodeType) payload.nodeType = ev.nodeType;
      if (ev.nodeLabel) payload.nodeLabel = ev.nodeLabel;
      if (ev.iterationLabel) payload.iterationLabel = ev.iterationLabel;
      if (ev.granularity) payload.granularity = ev.granularity;
    }
    CapabilityAPI.#emit(EVENT.INVOCATION_PROGRESS, payload);
  }

  /**
   * Pass C — Finalize an invocation based on the engine's result. Emits
   * completed or failed events and kicks the queue.
   * @private
   */
  static #completeInvocation(rec, result) {
    rec.completedAt = Date.now();
    rec.result      = result;

    if (result.aborted) {
      // v2.74.115 — Skip re-emitting CANCELLED if `cancel()` already
      // emitted it. The running-cancel flow goes:
      //   1. cancel() flips rec.status to CANCELLED and emits.
      //   2. Engine sees isAborted=true on its next poll, eventually
      //      returns { aborted: true } via #completeInvocation.
      // Without this guard, step 2 fires a second CANCELLED event for the
      // same invocation. Chat's handleInvocationCancelled is idempotent on
      // state but still does an extra _persistMessageUpdate write per
      // duplicate event.
      if (rec.status === STATUS.CANCELLED) {
        CapabilityAPI.#tryStartNext();
        return;
      }
      rec.status = STATUS.CANCELLED;
      CapabilityAPI.#emit(EVENT.INVOCATION_CANCELLED, {
        invocationId  : rec.invocationId,
        capabilityId  : rec.capabilityId,
        capabilityName: rec.capabilityName,
      });
    } else if (result.success) {
      rec.status = STATUS.COMPLETED;
      CapabilityAPI.#emit(EVENT.INVOCATION_COMPLETED, {
        invocationId  : rec.invocationId,
        capabilityId  : rec.capabilityId,
        capabilityName: rec.capabilityName,
        result,
      });
    } else {
      rec.status = STATUS.FAILED;
      rec.error  = result.error ?? 'Execution failed';
      CapabilityAPI.#emit(EVENT.INVOCATION_FAILED, {
        invocationId  : rec.invocationId,
        capabilityId  : rec.capabilityId,
        capabilityName: rec.capabilityName,
        error         : rec.error,
        result,
      });
    }
    CapabilityAPI.#tryStartNext();
  }

  /**
   * Notify the API that the capability registry changed (Ground added, removed,
   * or modified). Emits REGISTRY_CHANGED to subscribers.
   */
  static notifyRegistryChange(changeType, capabilityId) {
    CapabilityAPI.#emit(EVENT.REGISTRY_CHANGED, { changeType, capabilityId });
  }
}
