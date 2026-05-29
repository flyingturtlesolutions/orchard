/**
 * @file Services/TemplateWalker.js
 * @description Recursive template discovery service.
 *
 * v1.2.1 — CSP-safe execution via content script messaging.
 *
 * HubSpot and similar enterprise SPAs enforce a strict CSP that blocks
 * chrome.scripting.executeScript with inline functions. This version routes
 * ALL page interactions through chrome.tabs.sendMessage to the persistent
 * content script (ContentScripts/contentScript.js), which was registered at
 * document_start before the page's CSP header was applied.
 *
 * The content script handles:
 *   EXECUTE_STEP   — CLICK, TYPE, EXTRACT, FIND_AI
 *   WAIT_FOR_ELEM  — polls DOM until selector appears
 *   OBSERVE_START  — installs MutationObserver
 *   OBSERVE_READ   — reads + clears mutation flag
 *   DOM_SNAPSHOT   — returns compact interactive-element summary
 *   PAGE_IDLE      — returns network/readyState idle status
 *
 * No inline functions are injected at runtime. Zero CSP conflicts.
 *
 * @module Services/TemplateWalker
 * @author Agent HUB
 * @version 2.19.0
 */

import { Logger }           from '../Core/Logger.js';
import { AnthropicService } from './AnthropicService.js';
import { StorageManager }   from './StorageManager.js';
import { InjectionService } from './InjectionService.js';
import { normalizeAssertion, flattenAssertion, splitConditionsByEvaluator, evaluateFieldCondition } from './Assertion.js';
import { evaluateDataCondition } from './DataAssertion.js';
// v2.74.236 — Wave 3 of the landmark SSOT project. Static import (was
// dynamic in v2.74.236 first cut) — TemplateWalker.#executeStep runs
// hot in every fragment dispatch, and dynamic import per call adds
// cost for no benefit (the module is always needed).
import { applyLandmarkRefToStep, findPerspectiveIframeContext } from './LandmarkResolver.js';
import { emit as emitGroundEvent, EVENT_KIND }            from './GroundEventBus.js';
import { bracket as observeActionBracket, shouldObserveStep, isEffectDrift, classifyEffectDrift } from './ActionEffectObserver.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/** @constant {number} Hard cap on walk iterations. */
const MAX_WALK_STEPS = 20;

/** After a CLICK/FIND_AI that changed DOM, fixed settle before re-capture (ms). @constant {number} */
const POST_CLICK_SETTLE_MS = 2000;

/** After a CLICK/FIND_AI, how long to poll for a new iframe to appear (ms). @constant {number} */
const IFRAME_DISCOVER_TIMEOUT_MS = 6000;

/** How long between iframe discovery poll ticks (ms). @constant {number} */
const IFRAME_POLL_MS = 300;

/** After a CLICK that changed DOM, how long to poll for MutationObserver event (ms). @constant {number} */
const MUTATION_WAIT_MS = 3000;

/** How long between mutation poll ticks (ms). @constant {number} */
const MUTATION_POLL_MS = 150;

/** Network idle threshold in ms for page-ready check. @constant {number} */
const NETWORK_IDLE_MS = 600;

/** Max ms to wait for page idle before proceeding anyway. @constant {number} */
const PAGE_IDLE_TIMEOUT_MS = 12000;

/** Tab navigation load timeout. @constant {number} */
const TAB_LOAD_TIMEOUT_MS = 30_000;

/** How many times to retry sendMessage if the content script hasn't loaded yet. @constant {number} */
const CS_READY_RETRIES = 15;

/** Delay between content-script readiness retries (ms). @constant {number} */
const CS_READY_DELAY_MS = 500;

/** frameId value meaning "top-level frame". @constant {number} */
const TOP_FRAME_ID = 0;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WalkOptions
 * @property {string} groundId
 * @property {string} groundUrl
 * @property {string} aiName
 */

/**
 * @typedef {Object} ConfirmedStep
 * @property {number} step
 * @property {string} action
 * @property {string} selector
 * @property {string} value
 */

/**
 * @typedef {Object} WalkResult
 * @property {boolean}         success
 * @property {ConfirmedStep[]} steps
 * @property {string|null}     rawJson
 * @property {string|null}     error
 * @property {number}          turnsUsed
 */

// ─── TemplateWalker ───────────────────────────────────────────────────────────

export class TemplateWalker {

  // ── Shared helpers ────────────────────────────────────────────────────────

  /**
   * v2.29.6 (Pass F1) — Extract {{PARAM_NAME}} references from an action's
   * user-editable fields.
   *
   * Historical bug: param extraction only scanned `value`. A CLICK action's
   * target lives in `selector`, so templating a selector (e.g.
   * `{{JOB}} a.jcs-JobTitle`) never surfaced the param to the Fragment's
   * param list. This helper unifies the scan across all fields that can
   * legitimately hold user-facing templates.
   *
   * Fields checked:
   *   - value    : URL (NAVIGATE), typed text (TYPE), wait duration (WAIT)
   *   - selector : CSS target (CLICK, EXTRACT, ENUMERATE, TYPE-into, etc.)
   *
   * Deliberately NOT scanned:
   *   - target   : ENUMERATE's scope binding name — produces a binding, isn't
   *                referencing one
   *   - action   : fixed verb set, never templated
   *
   * @param {Object} step - one action from a Fragment's actions array
   * @returns {string[]} list of referenced param names (deduplicated)
   * @private
   */
  static #extractStepParams(step) {
    const out = new Set();
    const re = /\{\{([A-Z0-9_]+)\}\}/g;
    for (const field of ['value', 'selector']) {
      const src = String(step?.[field] ?? '');
      for (const m of src.matchAll(re)) out.add(m[1]);
    }
    // v2.74.0 — Action-chain branches carry their own selector/value with
    // their own param tokens. Extract those too so the fragment's params
    // list includes both layer-1 (head) and layer-2 (branch body) names.
    // v2.74.3 — Chain has a chain-level bodyValue (the layer-2 slot).
    // CLICK_BY_LABEL branches no longer carry their own value — they read
    // bodyValue at runtime — so skip branch.value for those.
    if (Array.isArray(step?.branches)) {
      const bv = String(step.bodyValue ?? '');
      for (const m of bv.matchAll(re)) out.add(m[1]);
      for (const branch of step.branches) {
        const sel = String(branch?.selector ?? '');
        for (const m of sel.matchAll(re)) out.add(m[1]);
        // Only WAIT branches' value carries a param; CLICK_BY_LABEL has
        // no own value, WAIT_FOR has no value field.
        if (branch?.action === 'WAIT') {
          const v = String(branch?.value ?? '');
          for (const m of v.matchAll(re)) out.add(m[1]);
        }
      }
    }
    return [...out];
  }

  /**
   * v2.29.6 (Pass F1) — Derive the full set of params referenced across a
   * Fragment's action list. Returns a sorted array.
   */
  static #extractFragmentParams(actions) {
    const set = new Set();
    for (const a of actions ?? []) {
      for (const p of TemplateWalker.#extractStepParams(a)) set.add(p);
    }
    return [...set].sort();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Opens a new focused tab and recursively walks the authenticated page,
   * building a confirmed step template. One API call per turn.
   * All DOM interactions route through the persistent content script to
   * avoid CSP violations on strict enterprise pages.
   *
   * @param {WalkOptions} options
   * @returns {Promise<WalkResult>}
   */
  static async walk(options) {
    const {
      groundId, groundUrl, aiName, aliases = [], uiType = null,
      groundType = 'ai', taskDesc = null, taskSteps = [], getTaskSteps = null,
      mode = 'manual', goal = null,
      fragmentId = null, fragmentName = null, fragmentDescription = null,
      antecedentFragmentId = null, antecedentParamBindings = null,
      continueFromPartial = false, partialTemplate = null,
      isAborted = () => false, awaitApproval = null,
    } = options;
    Logger.info('TemplateWalker', `Walk starting — "${aiName}" (${groundUrl}) type:${groundType} mode:${mode}${continueFromPartial ? ' [CONTINUATION]' : ''}`);

    // Route to appropriate walk strategy
    if (groundType === 'fragment') {
      return TemplateWalker.#walkFragment({
        groundId, groundUrl, fragmentId, fragmentName, fragmentDescription,
        antecedentFragmentId, antecedentParamBindings,
        isAborted, awaitApproval,
      });
    }
    if (groundType === 'task' && mode === 'auto') {
      return TemplateWalker.#walkAuto({ groundId, groundUrl, aiName, goal, continueFromPartial, partialTemplate, isAborted, awaitApproval });
    }
    if (groundType === 'task') {
      return TemplateWalker.#walkTask({ groundId, groundUrl, aiName, taskDesc, taskSteps, getTaskSteps, continueFromPartial, partialTemplate, isAborted, awaitApproval });
    }

    // AI ground walk (Phase 1 + Phase 2)

    let tabId         = null;
    let walkSucceeded = false;

    /** Canonical DOM snapshots — one per frame tier for audit */
    const snapshotTiers = [];

    try {
      tabId = await TemplateWalker.#openFocusedTab(groundUrl);
      Logger.info('TemplateWalker', `Opened focused tab ${tabId}`);

      await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
      await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);

      // Capture initial top-frame DOM — no separate sample question API call.
      // The sample question is now generated by AnthropicService.generateSampleQuestion
      // lazily — inlined into the Phase 2 prompt context rather than pre-fetched.
      const initialCapture = await TemplateWalker.#captureTab(tabId, TOP_FRAME_ID);
      let dom = initialCapture.dom;
      Logger.info('TemplateWalker', `Initial capture — ${dom.length} chars`);

      // Generate sample question — still one call but no longer blocking Phase 1.
      // Runs after initial capture so Phase 1 can start on the next tick.
      const sampleQuestion = await AnthropicService.generateSampleQuestion({ aiName, aliases, groundUrl });
      snapshotTiers.push({ depth: 0, frameUrl: null, frameId: TOP_FRAME_ID, snapshot: dom });

      // ── PHASE 1: Navigate to and confirm the AI access point ──────────────
      Logger.info('TemplateWalker', `Phase 1 — navigating to AI access point`);
      const phase1 = await TemplateWalker.#runPhase1({ tabId, groundId, groundUrl, aiName, aliases, uiType, dom, snapshotTiers, isAborted, awaitApproval });

      if (phase1.aborted) {
        return { success: false, aborted: true, steps: [], rawJson: null, error: 'Aborted by user', turnsUsed: phase1.turnsUsed };
      }

      if (!phase1.success) {
        return { success: false, steps: [], rawJson: null, error: `Phase 1 failed: ${phase1.error}`, turnsUsed: phase1.turnsUsed };
      }

      Logger.info('TemplateWalker', `Phase 1 complete — ${phase1.preamble.length} preamble step(s), handoff frame: ${phase1.handoff.frameUrl ?? 'top'}`);

      // ── PHASE 2: Discover the interaction path ───────────────────────────
      Logger.info('TemplateWalker', `Phase 2 — discovering interaction path`);
      const phase2 = await TemplateWalker.#runPhase2({
        tabId, groundId, groundUrl, aiName, aliases, uiType,
        sampleQuestion, handoff: phase1.handoff, snapshotTiers, isAborted, awaitApproval,
      });

      if (phase2.aborted) {
        return { success: false, aborted: true, steps: [], rawJson: null, error: 'Aborted by user', turnsUsed: phase1.turnsUsed + phase2.turnsUsed };
      }

      if (!phase2.success) {
        return { success: false, steps: [], rawJson: null, error: `Phase 2 failed: ${phase2.error}`, turnsUsed: phase1.turnsUsed + phase2.turnsUsed };
      }

      Logger.info('TemplateWalker', `Phase 2 complete — ${phase2.steps.length} interaction step(s)`);

      // ── Build template ───────────────────────────────────────────────────
      const preambleJson  = JSON.stringify(phase1.preamble, null, 2);
      const templateSteps = phase2.steps.map(s =>
        s.action === 'TYPE' && s.value === sampleQuestion
          ? { ...s, value: '{{USER_QUESTION}}' }
          : s
      );
      const rawJson = JSON.stringify(templateSteps, null, 2);

      const meta = {
        frameSwitches       : phase1.frameSwitches,
        handoff             : phase1.handoff,
        waitForContentScript: true,
        waitForPageIdle     : true,
      };

      const anchors     = phase2.anchors;
      const turnsUsed   = phase1.turnsUsed + phase2.turnsUsed;

      Logger.info('TemplateWalker', `Walk complete — ${phase1.preamble.length} preamble + ${templateSteps.length} steps in ${turnsUsed} total turns`);

      walkSucceeded = true;
      return { success: true, steps: templateSteps, rawJson, preambleJson, meta, anchors, tabId, snapshotTiers, error: null, turnsUsed };

    } catch (err) {
      Logger.error('TemplateWalker', `Unhandled walk error: ${err.message}`, { stack: err.stack });
      return { success: false, steps: [], rawJson: null, error: err.message, turnsUsed: 0 };
    } finally {
      if (tabId !== null && !walkSucceeded) {
        chrome.tabs.remove(tabId).catch(() => {});
        Logger.info('TemplateWalker', `Closed tab ${tabId} (walk failed)`);
      }
    }
  }

  // ── Phase 1: navigate to and confirm the AI access point ─────────────────

  /**
   * Navigates from groundUrl to a focusable AI input. Uses only
   * NAVIGATE, CLICK, FIND_AI, WAIT, WAIT_FOR — no TYPE or EXTRACT.
   * Terminates when FOCUS_CHECK passes on a discovered input.
   *
   * @private
   * @returns {Promise<{ success, preamble, handoff, frameSwitches, turnsUsed, error }>}
   */

  /**
   * v2.72.62 — Public setup for T1 manual fragment authoring.
   *
   * Opens a tab at groundUrl, waits for content script + page idle, and
   * replays the antecedent chain (if any) so the page is in the correct
   * starting state. Returns { success, tabId, error? }. Used by the
   * BEGIN_FRAGMENT_AUTHOR background handler before mounting the
   * fragment-author sidepanel mode.
   *
   * Differs from walk(): no LLM, no approval flow, no DOM capture, no
   * Phase 1/2. Just "get me to the right page state."
   *
   * @param {Object} opts
   * @param {string} opts.groundUrl   Starting URL for the fragment
   * @param {string} opts.fragmentId  ID of the fragment being authored (used as broadcast key)
   * @param {string|null} opts.antecedentFragmentId  Optional antecedent to replay
   * @param {Object} opts.antecedentParamBindings    Optional param bindings for antecedent
   * @param {Function} opts.isAborted  Optional abort check
   * @returns {Promise<{success: boolean, tabId: number|null, error: string|null}>}
   */
  static async prepareTabForAuthoring({
    groundUrl, fragmentId,
    antecedentFragmentId = null, antecedentParamBindings = null,
    isAborted = () => false,
    // v2.74.31 — When provided, reuse this tab instead of opening a fresh
    // one at groundUrl. Lets the Ground sidepanel launch authoring on the
    // user's currently visible tab (preserving navigation state) rather
    // than yanking them to a freshly-opened tab on the ground's stored URL.
    existingTabId = null,
  }) {
    if (!groundUrl && existingTabId == null) {
      return { success: false, tabId: null, error: 'groundUrl or existingTabId required' };
    }
    let tabId = null;
    try {
      if (existingTabId != null) {
        tabId = existingTabId;
        // Focus the tab — the click came from the sidepanel, so the tab
        // may not currently be active even if it's the right one.
        try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {
          Logger.warn('TemplateWalker', `prepareTabForAuthoring: focus existing tab ${tabId} failed: ${e.message}`);
        }
        // v2.74.32 — Re-inject the content script. The manifest's
        // document_start injection only fires on fresh page loads, so a
        // tab that was loaded before this extension session has no live
        // content script — #waitForContentScript would loop until its
        // retry budget runs out and throw "Content script did not become
        // reachable in frameId 0". Mirrors the same fix BEGIN_PERSPECTIVE_
        // CAPTURE uses for reusing an existing tab. Best-effort: failure
        // here just falls through to the wait below, which will surface
        // a clearer error if the script truly can't be injected
        // (chrome:// pages, the web store, etc.).
        // v2.74.164 — Inject into ALL frames, not just the top frame.
        // When the user reuses an existing tab (the common case for
        // authoring against an already-open page), iframes loaded
        // before the extension was last reloaded don't have the
        // content script — Chrome's `content_scripts.all_frames: true`
        // only injects into frames that load AFTER the manifest
        // registration. Without `allFrames: true` here, the picker
        // broadcast to those iframes silently fails with "Receiving
        // end does not exist" and the picker never activates inside
        // them. This is the root cause of why same-origin iframes
        // (e.g. HubSpot's nested apps) didn't receive START_PICK.
        try {
          await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: ['ContentScripts/contentScript.js'],
          });
          Logger.info('TemplateWalker', `prepareTabForAuthoring: re-injected content script into tab ${tabId} (all frames)`);
        } catch (e) {
          Logger.warn('TemplateWalker', `prepareTabForAuthoring: executeScript failed (continuing): ${e.message}`);
        }
        Logger.info('TemplateWalker', `prepareTabForAuthoring: reusing tab ${tabId}`);
      } else {
        tabId = await TemplateWalker.#openFocusedTab(groundUrl);
        Logger.info('TemplateWalker', `prepareTabForAuthoring: opened tab ${tabId}`);
      }
      await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
      await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);

      if (antecedentFragmentId) {
        TemplateWalker.#broadcast(fragmentId, {
          status: 'running', turn: 0, phase: 'antecedent',
          message: 'Replaying antecedent chain…',
        });
        const replay = await TemplateWalker.#replayAntecedentChain({
          tabId,
          antecedentFragmentId,
          paramBindings: antecedentParamBindings ?? {},
          broadcastKey: fragmentId,
          isAborted,
        });
        if (!replay.success) {
          return { success: false, tabId, error: replay.error ?? 'Antecedent chain replay failed' };
        }
        if (replay.aborted) {
          return { success: false, tabId, error: 'Aborted' };
        }
        Logger.info('TemplateWalker',
          `prepareTabForAuthoring: antecedent chain replayed — ${replay.fragmentsRun} fragment(s), ${replay.actionsRun} action(s)`);
      }
      return { success: true, tabId, error: null };
    } catch (err) {
      return { success: false, tabId, error: err.message };
    }
  }

  /**
  /**
   * Pass B+ — Replay an antecedent chain on an already-open tab.
   *
   * Resolves the chain via StorageManager.resolveAntecedentChain, then
   * executes each Fragment's `rawJson` actions in order using #executeStep.
   * Param substitution via InjectionService.injectParams — all fragments in
   * the chain share the same `paramBindings` map for simplicity (Pass B+
   * scope; per-chain-level bindings can be added later if needed).
   *
   * No approval hooks. Aborts on isAborted() or #executeStep failure.
   * Broadcasts progress via #broadcast keyed by broadcastKey (the downstream
   * Fragment's id) so the walk panel shows live antecedent progress.
   *
   * @private
   * @returns {Promise<{
   *   success: boolean, aborted?: boolean,
   *   fragmentsRun: number, actionsRun: number,
   *   error: string|null,
   * }>}
   */
  static async #replayAntecedentChain({
    tabId, antecedentFragmentId, paramBindings = {},
    broadcastKey, isAborted, completedFragmentIds = null,
  }) {
    let chain;
    try {
      // resolveAntecedentChain returns ancestors [root, ..., direct-antecedent-of-antecedentId]
      // but EXCLUDES antecedentFragmentId itself. Since we want to run
      // antecedentFragmentId too (it IS the direct antecedent of the walk),
      // append it.
      chain = await StorageManager.resolveAntecedentChain(antecedentFragmentId);
      const direct = await StorageManager.getFragment(antecedentFragmentId);
      if (!direct) {
        return { success: false, fragmentsRun: 0, actionsRun: 0, error: `Antecedent fragment ${antecedentFragmentId} not found` };
      }
      chain.push(direct);
    } catch (err) {
      return { success: false, fragmentsRun: 0, actionsRun: 0, error: err.message };
    }

    Logger.info('TemplateWalker', `Replaying antecedent chain: ${chain.length} fragment(s) — ${chain.map(f => f.name).join(' → ')}`);

    let fragmentsRun = 0;
    let fragmentsSkipped = 0;
    let actionsRun = 0;

    for (const frag of chain) {
      if (isAborted?.()) {
        return { success: false, aborted: true, fragmentsRun, fragmentsSkipped, actionsRun, error: 'Aborted' };
      }

      // v2.25.6 — Within-invocation memo. If this Fragment has already run as
      // an explicit Strategy step (or skipped because postconditions held),
      // the page is in its end-state. Re-running would be redundant and
      // possibly destructive. This check works regardless of whether the
      // Fragment has postconditions — it's purely about "did the engine just
      // run this in the same invocation?"
      if (completedFragmentIds?.has(frag.id)) {
        Logger.info('TemplateWalker', `Antecedent "${frag.name}" — already run this invocation; skipping replay`);
        TemplateWalker.#broadcast(broadcastKey, {
          status: 'running', phase: 'antecedent',
          message: `Skipping: ${frag.name} (already run)`,
        });
        fragmentsSkipped++;
        continue;
      }

      // Pass Cα — Skip antecedents whose postconditions already hold. Running
      // Login when already logged in, or re-entering a search when results
      // are already displayed, is wasteful and often breaks (login redirects
      // change the URL, re-typing a filtered search may clear results). Same
      // principle as strategy-step skipping: Fragment = state goal, not blind
      // action replay.
      if (Array.isArray(frag.postconditions) && frag.postconditions.length > 0) {
        const preProbe = await TemplateWalker.checkConditions({ tabId, conditions: frag.postconditions });
        if (preProbe.ok) {
          Logger.info('TemplateWalker', `Antecedent "${frag.name}" — postconditions already hold; skipping`);
          TemplateWalker.#broadcast(broadcastKey, {
            status: 'running', phase: 'antecedent',
            message: `Skipping: ${frag.name} (already done)`,
          });
          fragmentsSkipped++;
          continue;
        }
      }

      TemplateWalker.#broadcast(broadcastKey, {
        status: 'running', phase: 'antecedent',
        message: `Replaying: ${frag.name}`,
      });

      let actions;
      try {
        actions = JSON.parse(frag.rawJson ?? '[]');
      } catch {
        return { success: false, fragmentsRun, fragmentsSkipped, actionsRun, error: `Fragment "${frag.name}" has invalid rawJson` };
      }

      const substituted = InjectionService.injectParams(actions, paramBindings);
      const substitutedActions = substituted.steps ?? actions;

      // v2.74.250 — Phase 6.5: pre-compute the index of the last
      // dispatchable action so we can flag the terminal step for
      // action-effect observation. STEP_DONE/DONE/EXTRACT/ENUMERATE/
      // EMIT are skipped in dispatch (see continue clauses below) so
      // "last dispatchable" is what counts, not array length-1.
      let lastDispatchableIdx = -1;
      for (let i = substitutedActions.length - 1; i >= 0; i--) {
        const a = substitutedActions[i];
        if (a?.action === 'STEP_DONE' || a?.action === 'DONE'
            || a?.action === 'EXTRACT' || a?.action === 'ENUMERATE'
            || a?.action === 'EMIT') continue;
        lastDispatchableIdx = i;
        break;
      }

      for (let i = 0; i < substitutedActions.length; i++) {
        const action = substitutedActions[i];
        if (isAborted?.()) {
          return { success: false, aborted: true, fragmentsRun, fragmentsSkipped, actionsRun, error: 'Aborted' };
        }
        if (action.action === 'STEP_DONE' || action.action === 'DONE') continue;

        // E1 (v2.26.0) — EXTRACTs in antecedent replay are no-ops.
        // Antecedents are setup; their captured values would belong to a
        // different invocation context. Silently skip — the page-state
        // effect of EXTRACT is zero anyway (it only reads).
        // v2.29.1 (E2-2) — Same reasoning applies to ENUMERATE.
        // v2.35.0 (I1) — Same for EMIT. It writes to scope but antecedent
        // replay happens in a separate context; the value would be lost or
        // misleading anyway.
        if (action.action === 'EXTRACT' || action.action === 'ENUMERATE' || action.action === 'EMIT') continue;

        // v2.74.250 — Mark terminal step so #executeStep enables
        // action-effect observation (no downstream pre-condition to
        // validate the terminal action). Mutates the action object —
        // safe because substitutedActions is freshly injected per
        // fragment invocation.
        if (i === lastDispatchableIdx) action._isTerminal = true;

        try {
          const execResult = await TemplateWalker.#executeStep(tabId, action, TOP_FRAME_ID);
          if (!execResult?.success) {
            return {
              success: false, fragmentsRun, fragmentsSkipped, actionsRun,
              error: `In "${frag.name}", step ${action.action} ${action.selector ?? ''} failed: ${execResult?.error ?? 'unknown'}`,
            };
          }
          actionsRun++;
          await TemplateWalker.#sleep(200);
        } catch (err) {
          return {
            success: false, fragmentsRun, fragmentsSkipped, actionsRun,
            error: `In "${frag.name}", step ${action.action} threw: ${err.message}`,
          };
        }
      }

      fragmentsRun++;
      await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID).catch(() => {});
    }

    return { success: true, fragmentsRun, fragmentsSkipped, actionsRun, error: null };
  }

  /**
   * Pass C — Public Fragment executor.
   *
   * Runs a Fragment on an already-open tab: replays its antecedent chain (if
   * any), then executes its own rawJson action-by-action with param
   * substitution. Used by:
   *   - Strategy execution (ExecutionEngine.executeStrategy)
   *   - Future ad-hoc Fragment invocation
   *
   * This wraps the Pass B+ replay machinery plus the Fragment's own body. It
   * does NOT verify postconditions — callers decide whether to probe those
   * and what to do on failure (Strategy execution does probe; other callers
   * may not care).
   *
   * Progress broadcast is keyed by `broadcastKey` (caller-supplied — typically
   * an invocationId) so progress UIs can route messages to the right sink.
   *
   * @param {Object} opts
   * @param {number} opts.tabId                     - open tab to execute against
   * @param {string} opts.fragmentId                - Fragment to run
   * @param {Object} [opts.paramBindings]           - { PARAM_NAME: value } for the main fragment's params
   * @param {Object} [opts.antecedentParamBindings] - { PARAM_NAME: value } for the antecedent chain
   *                                                  (defaults to paramBindings if not given)
   * @param {string} opts.broadcastKey              - key for WALK_PROGRESS broadcasts
   * @param {() => boolean} [opts.isAborted]        - abort-flag poller
   * @returns {Promise<{
   *   success: boolean, aborted?: boolean,
   *   actionsRun: number, antecedentActionsRun: number,
   *   error: string|null,
   * }>}
   */
  static async executeFragment({
    tabId, fragmentId, paramBindings = {}, antecedentParamBindings = null,
    broadcastKey, isAborted, completedFragmentIds = null,
    scope = null,
  }) {
    if (!tabId || !fragmentId) {
      return { success: false, actionsRun: 0, antecedentActionsRun: 0, error: 'executeFragment requires tabId and fragmentId' };
    }

    // E1 (v2.26.0) — `scope` is forwarded by the engine. EXTRACT actions
    // (added in message 2) write into it; without scope present they'll
    // become no-ops with a warning. Antecedent replays don't get scope
    // intentionally — antecedent Fragments shouldn't EXTRACT into the
    // dependent Strategy's scope (they're setup, not the main work).

    const frag = await StorageManager.getFragment(fragmentId);
    if (!frag) {
      return { success: false, actionsRun: 0, antecedentActionsRun: 0, error: `Fragment ${fragmentId} not found` };
    }

    let antecedentActionsRun = 0;

    // 1. Replay the antecedent chain, if the Fragment has one
    if (frag.antecedentFragmentId) {
      // Use the Fragment's own stored antecedent bindings as default — the
      // caller can override by passing antecedentParamBindings explicitly.
      const chainBindings = antecedentParamBindings
        ?? frag.antecedentParamBindings
        ?? paramBindings;   // last resort: share with main-fragment bindings

      const replayResult = await TemplateWalker.#replayAntecedentChain({
        tabId,
        antecedentFragmentId: frag.antecedentFragmentId,
        paramBindings: chainBindings,
        broadcastKey,
        isAborted,
        completedFragmentIds,   // v2.25.6: forwarded for within-invocation memo
      });

      if (replayResult.aborted) {
        return { success: false, aborted: true, actionsRun: 0, antecedentActionsRun: replayResult.actionsRun, error: 'Aborted during antecedent replay' };
      }
      if (!replayResult.success) {
        return { success: false, actionsRun: 0, antecedentActionsRun: replayResult.actionsRun, error: `Antecedent replay failed: ${replayResult.error}` };
      }
      antecedentActionsRun = replayResult.actionsRun;
    }

    // 2. Execute the Fragment's own actions with param substitution
    let actions;
    try {
      actions = JSON.parse(frag.rawJson ?? '[]');
    } catch {
      return { success: false, actionsRun: 0, antecedentActionsRun, error: `Fragment "${frag.name}" has invalid rawJson` };
    }

    const substituted = InjectionService.injectParams(actions, paramBindings);
    const substitutedActions = substituted.steps ?? actions;

    let actionsRun = 0;
    // v2.36.0 (J1) — Ring buffer of the last few successful actions. Kept
    // small (cap 3) so failures carry just enough context to see "we were
    // mid-fragment, got past steps A B C, then D failed" without shipping
    // massive payloads. Included in failure returns so the engine can
    // attach to its fragment_failed event.
    const LAST_ACTIONS_CAP = 3;
    const lastActions = [];
    const rememberAction = (act) => {
      lastActions.push({
        action: act.action,
        selector: typeof act.selector === 'string' ? act.selector.slice(0, 120) : undefined,
        target: act.target,
        value: typeof act.value === 'string' ? act.value.slice(0, 60) : undefined,
      });
      if (lastActions.length > LAST_ACTIONS_CAP) lastActions.shift();
    };

    TemplateWalker.#broadcast(broadcastKey, {
      status: 'running', phase: 'fragment',
      message: `Executing: ${frag.name}`,
      fragmentId, fragmentName: frag.name,
    });

    // v2.74.264 — Phase 6.5 coverage extension: pre-compute the last
    // dispatchable index so the action-effect observer fires on the
    // last meaningful CLICK / CLICK_BY_LABEL / FIND_AI in this
    // strategy-tier fragment. Same skip-set as the fragment-runner
    // path (line ~534): control-flow markers and read-only actions
    // (EXTRACT/ENUMERATE/EMIT) don't count toward terminal.
    let lastDispatchableIdx = -1;
    for (let i = substitutedActions.length - 1; i >= 0; i--) {
      const a = substitutedActions[i];
      if (a?.action === 'STEP_DONE' || a?.action === 'DONE'
          || a?.action === 'EXTRACT' || a?.action === 'ENUMERATE'
          || a?.action === 'EMIT') continue;
      lastDispatchableIdx = i;
      break;
    }

    for (let actionIdx = 0; actionIdx < substitutedActions.length; actionIdx++) {
      const action = substitutedActions[actionIdx];
      if (isAborted?.()) {
        return { success: false, aborted: true, actionsRun, antecedentActionsRun, lastActions, error: 'Aborted' };
      }
      // Skip control-flow markers that aren't DOM actions
      if (action.action === 'STEP_DONE' || action.action === 'DONE') continue;
      if (actionIdx === lastDispatchableIdx) action._isTerminal = true;

      // E1 (v2.26.0) — EXTRACT: read a value from the page into Strategy scope.
      // Not a DOM mutation; goes through the EXTRACT_VALUE content-script
      // handler, then writes the result into scope under `action.target`.
      // Append behavior is per-action via `action.append` (forward-compat for
      // E2's FOREACH-body EXTRACTs that accumulate per-iteration values).
      if (action.action === 'EXTRACT') {
        if (!action.target) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", EXTRACT step is missing a target parameter name`,
          };
        }
        if (!scope) {
          // Defensive: executeFragment invoked without a scope (shouldn't
          // happen in practice — Strategy execution always passes one). Log
          // and treat as a no-op rather than crashing.
          Logger.warn('TemplateWalker', `EXTRACT in "${frag.name}" had no scope — value discarded`);
          rememberAction(action);
          actionsRun++;
          continue;
        }
        TemplateWalker.#broadcast(broadcastKey, {
          status: 'running', phase: 'fragment',
          fragmentId, fragmentName: frag.name,
          action: 'EXTRACT', selector: action.selector,
          message: `EXTRACT ${action.selector ?? ''} → ${action.target}`,
        });
        try {
          const res = await TemplateWalker.#msg(tabId, {
            type: 'EXTRACT_VALUE',
            payload: {
              selector: action.selector,
              attribute: action.attribute || 'text',
            },
          }, TOP_FRAME_ID);
          if (!res?.success) {
            return {
              success: false, actionsRun, antecedentActionsRun, lastActions,
              error: `In "${frag.name}", EXTRACT failed: ${res?.error ?? 'unknown'}`,
            };
          }
          // Write into scope. The scalar() helper isn't imported here to keep
          // the walker decoupled from Scope's module — we construct the
          // tagged value inline. (Same shape: { kind: 'scalar', value }.)
          scope.set(action.target, { kind: 'scalar', value: String(res.value ?? '') }, { append: !!action.append });
          Logger.info('TemplateWalker', `EXTRACT ${action.target} ← "${String(res.value).slice(0, 60)}"${action.append ? ' [append]' : ''}`);
          rememberAction(action);
          actionsRun++;
          await TemplateWalker.#sleep(50);   // brief settle, much shorter than DOM mutations
        } catch (err) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", EXTRACT threw: ${err.message}`,
          };
        }
        continue;   // skip the regular #executeStep dispatch below
      }

      // v2.29.1 (Pass E2-2) — ENUMERATE: query the page for a count of
      // matching elements, then write a list binding to Scope where each
      // item is an element-tagged value with a :nth-of-type scoped
      // selector. FOREACH in a later Strategy node iterates this list,
      // binding each item's selector to its iteration variable.
      //
      // Design choice: don't materialize element handles. Each list item
      // carries only the selector string. The FOREACH body recomputes DOM
      // lookups per iteration — DOM mutations inside the body don't
      // invalidate indices captured upfront.
      if (action.action === 'ENUMERATE') {
        if (!action.target) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", ENUMERATE step is missing a target parameter name`,
          };
        }
        if (!action.selector) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", ENUMERATE step is missing a selector`,
          };
        }
        if (!scope) {
          Logger.warn('TemplateWalker', `ENUMERATE in "${frag.name}" had no scope — list discarded`);
          rememberAction(action);
          actionsRun++;
          continue;
        }
        const maxItems = Number.isFinite(action.max) ? action.max : 50;
        TemplateWalker.#broadcast(broadcastKey, {
          status: 'running', phase: 'fragment',
          fragmentId, fragmentName: frag.name,
          action: 'ENUMERATE', selector: action.selector,
          message: `ENUMERATE ${action.selector} → ${action.target} (max ${maxItems})`,
        });
        try {
          // v2.29.11 (Pass F3) — Count matches only. Per-item selectors are
          // NOT captured at ENUMERATE time because auto-generated class
          // hashes / tracking IDs on dynamic sites rotate between enumerate
          // and click, invalidating stringified selectors. Instead, each
          // item is tagged with {baseSelector, index} and resolved live at
          // action time via the `:agent-hub-index(k)` selector sentinel
          // (see contentScript.js resolveElement).
          //
          // v2.46.0 (Pass O1) — when action.fields is provided, the content
          // script also captures per-item values for each declared field.
          // The captured records are merged into the items below so each
          // iteration variable carries its named fields alongside the
          // selector (used by field-* conditions for engine-side eval).
          const fieldDecls = Array.isArray(action.fields) && action.fields.length > 0
            ? action.fields : null;
          const res = await TemplateWalker.#msg(tabId, {
            type: 'COUNT_ELEMENTS',
            payload: {
              selector: action.selector,
              max: maxItems,
              ...(fieldDecls ? { fields: fieldDecls } : {}),
            },
          }, TOP_FRAME_ID);
          if (!res?.success) {
            return {
              success: false, actionsRun, antecedentActionsRun, lastActions,
              error: `In "${frag.name}", ENUMERATE failed: ${res?.error ?? 'unknown'}`,
            };
          }
          // Build the list of element-tagged items. Each carries the base
          // selector and an index into the match set. The `selector` string
          // embeds an `:agent-hub-index(k)` marker that the content script
          // expands to `querySelectorAll(base)[k]` at action time.
          //
          // v2.46.0 — when fields were captured, each item also carries
          // a `record` field with the per-item field values. Iteration
          // bindings and field-* conditions read from this.
          const items = [];
          const records = Array.isArray(res.records) ? res.records : null;
          for (let k = 0; k < res.count; k++) {
            const item = {
              kind: 'element',
              selector: `${action.selector}:agent-hub-index(${k})`,
              baseSelector: action.selector,
              index: k,
              attribute: null,
              snapshot: null,
            };
            if (records && records[k]) {
              item.record = records[k];
            }
            items.push(item);
          }
          scope.set(action.target, { kind: 'list', items }, { append: false });
          Logger.info('TemplateWalker',
            `ENUMERATE ${action.target} ← ${items.length} item(s) matching "${action.selector}"` +
            (res.total > items.length ? ` (${res.total} total, capped at ${maxItems})` : '') +
            (fieldDecls ? ` (with ${fieldDecls.length} field(s) captured)` : ''));
          rememberAction(action);
          actionsRun++;
          await TemplateWalker.#sleep(50);
        } catch (err) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", ENUMERATE threw: ${err.message}`,
          };
        }
        continue;
      }

      // v2.35.0 (Pass I1) — EMIT: package a structured record from
      // already-bound values (scope params + iteration variables + prior
      // EXTRACTs in this fragment) and append it to a target list. Used
      // to accumulate per-iteration results in a FOREACH.
      //
      // Shape: { action: 'EMIT', target: 'JOBS_DATA',
      //          fields: { title: '{{TITLE}}', salary: '{{SALARY}}' } }
      //
      // Interpolation happens at EMIT time (not upfront via
      // InjectionService.injectParams) because same-fragment EXTRACTs
      // write to scope during execution — their values aren't in
      // paramBindings yet. We read the live scope via asBindingMap().
      if (action.action === 'EMIT') {
        if (!action.target) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", EMIT step is missing a target parameter name`,
          };
        }
        if (!scope) {
          Logger.warn('TemplateWalker', `EMIT in "${frag.name}" had no scope — record discarded`);
          rememberAction(action);
          actionsRun++;
          continue;
        }
        const rawFields = (action.fields && typeof action.fields === 'object') ? action.fields : {};
        // Live binding map: strategy-scope EXTRACTs + iteration variables +
        // incoming paramBindings (for input params). asBindingMap includes
        // all frames already; merge paramBindings behind it so initial
        // inputs don't shadow same-fragment EXTRACTs that wrote during
        // this fragment.
        const liveBindings = { ...paramBindings, ...scope.asBindingMap() };
        const resolvedFields = {};
        for (const [fieldName, tmpl] of Object.entries(rawFields)) {
          let val = String(tmpl ?? '');
          for (const [pname, pval] of Object.entries(liveBindings)) {
            const placeholder = `{{${pname}}}`;
            if (val.includes(placeholder)) {
              val = val.split(placeholder).join(String(pval ?? ''));
            }
          }
          resolvedFields[fieldName] = val;
        }
        TemplateWalker.#broadcast(broadcastKey, {
          status: 'running', phase: 'fragment',
          fragmentId, fragmentName: frag.name,
          action: 'EMIT',
          message: `EMIT ${action.target} ← { ${Object.keys(resolvedFields).length} field(s) }`,
        });
        // Append the record to the target list. scope.set with append:true
        // wraps a non-list existing value into a list; for lists it pushes.
        scope.set(
          action.target,
          { kind: 'record', fields: resolvedFields },
          { append: true },
        );
        const fieldPreview = Object.entries(resolvedFields)
          .slice(0, 3)
          .map(([k, v]) => `${k}="${String(v).slice(0, 40)}"`)
          .join(', ');
        Logger.info('TemplateWalker', `EMIT ${action.target} ← { ${fieldPreview}${Object.keys(resolvedFields).length > 3 ? ', ...' : ''} }`);
        rememberAction(action);
        actionsRun++;
        await TemplateWalker.#sleep(20);
        continue;
      }

      // v2.74.156 — ACTION_GATE dispatch. Conditional block: evaluate
      // the header condition against the live page; if `(satisfied)
      // XOR negate` is true, run each action in `body[]` inline (same
      // dispatch model used for top-level actions, just with the body
      // list substituted in). Otherwise skip the body entirely and
      // advance to the next top-level action.
      //
      // Body actions run through #executeStep directly — no recursive
      // entry into this loop, which keeps the dispatch shape flat for
      // v1. EXTRACT / ENUMERATE / EMIT / nested ACTION_GATE inside a
      // gate body are not supported in v1 (the body validator rejects
      // unknown action types; nested gates work because runtime sees
      // the inner gate and falls through to this branch on each pass —
      // but only for body actions that ARE valid step actions, so the
      // execute step path needs to handle them. For v1 the body should
      // be a flat sequence of CLICK / TYPE / WAIT / WAIT_FOR / BLUR.)
      if (action.action === 'ACTION_GATE') {
        const gateCondition = action.condition ?? null;
        if (!gateCondition || typeof gateCondition !== 'object') {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", ACTION_GATE has no condition`,
          };
        }
        // v2.74.193 — Detailed gate-evaluation logging.
        // v2.74.201 — Optional `waitTimeout` (ms). When > 0, the
        // condition is retried via TemplateWalker.checkConditions's
        // built-in retry loop until satisfied OR timeout elapsed.
        // Transforms the gate from "check once" to "wait for the
        // right moment, then act" — same primitive can express both
        // patterns. When 0/unset, behavior is unchanged (one-shot).
        const gateWaitTimeout = Number.isFinite(action.waitTimeout) && action.waitTimeout > 0
          ? action.waitTimeout : 0;
        Logger.info('TemplateWalker', `ACTION_GATE evaluating in "${frag.name}":`, {
          conditionType   : gateCondition.type,
          conditionText   : gateCondition.text   ?? null,
          conditionSelector: gateCondition.selector ?? null,
          conditionPattern: gateCondition.pattern ?? null,
          frameUrl        : gateCondition.frameUrl ?? null,
          negate          : !!action.negate,
          waitTimeout     : gateWaitTimeout || null,
        });
        let gateProbe;
        const gateProbeStart = Date.now();
        try {
          gateProbe = await TemplateWalker.checkConditions({
            tabId,
            conditions: [gateCondition],
            scope,
            timeoutMs: gateWaitTimeout,
          });
        } catch (err) {
          Logger.error('TemplateWalker', `ACTION_GATE condition check threw: ${err.message ?? err}`);
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", ACTION_GATE condition check threw: ${err.message ?? err}`,
          };
        }
        const gateProbeElapsed = Date.now() - gateProbeStart;
        const satisfied = !!gateProbe?.ok;
        const negate    = !!action.negate;
        const shouldRun = negate ? !satisfied : satisfied;
        // v2.74.193 — Log the full probe response so the author can
        // see WHY the gate evaluated the way it did. gateProbe has
        // { ok, failures: [{ condition, reason }], passed: [], ... }.
        // The failures array carries the reason from CHECK_CONDITION
        // (e.g. "element not found", "text not in section", "frame
        // not found") — without this log line, only `satisfied` is
        // visible.
        Logger.info('TemplateWalker', `ACTION_GATE result for "${frag.name}":`, {
          satisfied,
          negate,
          shouldRun,
          probeOk      : gateProbe?.ok,
          probeFailures: gateProbe?.failures ?? null,
          probePassed  : (gateProbe?.passed ?? []).map(c => c?.type),
          elapsedMs    : gateProbeElapsed,
          waitTimeout  : gateWaitTimeout || null,
          attempts     : gateProbe?.attempts ?? 1,
          decision     : shouldRun ? 'RUN body' : 'SKIP body',
        });
        TemplateWalker.#broadcast(broadcastKey, {
          status: 'running', phase: 'fragment',
          fragmentId, fragmentName: frag.name,
          action: 'ACTION_GATE',
          message: `gate: condition ${satisfied ? 'met' : 'not met'}${negate ? ' (negate)' : ''} → ${shouldRun ? 'run body' : 'skip body'}`,
        });
        if (!shouldRun) {
          rememberAction({ ...action, action: 'ACTION_GATE_SKIPPED' });
          actionsRun++;
          continue;
        }
        // Body dispatch — flat sequence of basic actions. Each sub
        // action is dispatched as if it were a top-level CLICK / TYPE /
        // WAIT etc. EXTRACT / ENUMERATE / EMIT / nested gates not
        // supported in v1; the schema validator's body-rule rejects
        // anything outside ACTION_TYPES anyway, so we just hand each
        // entry to #executeStep here.
        const bodyActions = Array.isArray(action.body) ? action.body : [];
        // v2.74.264 — Phase 6.5 coverage extension: terminal-step flag
        // on the last gate-body action so the action-effect observer
        // fires for CLICK / CLICK_BY_LABEL / FIND_AI body steps. Index
        // of the last action is the array length minus 1 — body
        // actions are always dispatchable (no STEP_DONE/DONE/EXTRACT
        // filtering in this iterator).
        const bodyLastIdx = bodyActions.length - 1;
        for (let bi = 0; bi < bodyActions.length; bi++) {
          const bodyAction = bodyActions[bi];
          if (isAborted?.()) {
            return { success: false, aborted: true, actionsRun, antecedentActionsRun, lastActions, error: 'Aborted' };
          }
          if (bi === bodyLastIdx) bodyAction._isTerminal = true;
          TemplateWalker.#broadcast(broadcastKey, {
            status: 'running', phase: 'fragment',
            fragmentId, fragmentName: frag.name,
            action: bodyAction.action, selector: bodyAction.selector,
            message: `gate body: ${bodyAction.action} ${bodyAction.selector ?? ''}`.trim(),
          });
          let bodyResult;
          try {
            // v2.74.163 — Same-origin iframe support for gate body
            // sub-actions. Each sub carries its own optional frameUrl.
            const bodyFrameId = await TemplateWalker._resolveFrameId(tabId, bodyAction.frameUrl);
            bodyResult = await TemplateWalker.#executeStep(tabId, bodyAction, bodyFrameId);
          } catch (err) {
            return {
              success: false, actionsRun, antecedentActionsRun, lastActions,
              error: `In "${frag.name}", gate body action ${bodyAction.action} threw: ${err.message}`,
            };
          }
          if (!bodyResult?.success) {
            return {
              success: false, actionsRun, antecedentActionsRun, lastActions,
              error: `In "${frag.name}", gate body action ${bodyAction.action} failed: ${bodyResult?.error ?? 'unknown'}`,
            };
          }
          rememberAction(bodyAction);
          actionsRun++;
          // Small settle between gate-body actions, mirroring the
          // post-step pause the regular loop has between iterations.
          await TemplateWalker.#sleep(50);
        }
        continue;
      }

      // v2.74.0 — Action chain dispatch. A CLICK_BY_LABEL with branches[]
      // is a head click + per-label dispatch into a body action captured
      // under the conditions the head established. Decompose at runtime:
      //   1. Run the head click via #executeStep (normal CLICK_BY_LABEL).
      //      The head's `value` has already been substituted by injectParams,
      //      so it's the literal layer-1 label resolved from scope.
      //   2. Find the branch whose `label` matches the resolved layer-1
      //      label. If none: hard-fail with available labels in the error.
      //   3. Run that branch's action via #executeStep — its selector and
      //      value have also been pre-substituted.
      //
      // Page settle between head and branch happens implicitly: #executeStep
      // for CLICK_BY_LABEL fires .click() and returns; the engine's normal
      // post-step settle (broadcast, then next iteration of the loop) gives
      // the page time before the branch action runs. If a particular page
      // needs more, the author can interpose a WAIT branch action.
      if (action.action === 'CLICK_BY_LABEL'
          && Array.isArray(action.branches) && action.branches.length > 0) {
        const resolvedLayer1 = action.value;
        TemplateWalker.#broadcast(broadcastKey, {
          status: 'running', phase: 'fragment',
          fragmentId, fragmentName: frag.name,
          action: 'CLICK_BY_LABEL', selector: action.selector,
          message: `chain head: pick "${resolvedLayer1}" from menu`,
        });

        // v2.74.2 — URL-change diagnostic helper. Mirrors the regular
        // dispatch's urlBefore/urlAfter pattern (lines ~1003-1024) so the
        // chain doesn't lose the silent-navigation diagnostic. Click_by_label
        // is a mutating action that can navigate the tab.
        const captureUrl = async () => {
          try {
            const tabInfo = await chrome.tabs.get(tabId);
            return tabInfo?.url ?? null;
          } catch { return null; }
        };
        const reportNavIf = async (urlBefore, label) => {
          if (urlBefore == null) return;
          try {
            await TemplateWalker.#sleep(30);   // synchronous nav may take a tick
            const urlAfter = await captureUrl();
            if (urlAfter && urlAfter !== urlBefore) {
              Logger.warn('TemplateWalker',
                `chain ${label} caused navigation: "${urlBefore.slice(0, 60)}" → "${urlAfter.slice(0, 60)}" ` +
                `— the click succeeded at the DOM level but the tab left the page.`);
            }
          } catch { /* tab closed — fine */ }
        };

        // Run the head as a normal CLICK_BY_LABEL.
        const headStep = {
          action: 'CLICK_BY_LABEL',
          selector: action.selector,
          value: action.value,
        };
        const headUrlBefore = await captureUrl();
        let headResult;
        // v2.74.163 — Chain head shares the row's frameUrl (the head
        // IS the row at the schema level). Branches inherit the same
        // frame by default; an authoring path could later override
        // per-branch but v1 doesn't surface that.
        const chainFrameId = await TemplateWalker._resolveFrameId(tabId, action.frameUrl);
        try {
          headResult = await TemplateWalker.#executeStep(tabId, headStep, chainFrameId);
        } catch (err) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", chain head threw: ${err.message}`,
          };
        }
        if (!headResult?.success) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", chain head failed: ${headResult?.error ?? 'unknown'}`,
          };
        }
        await reportNavIf(headUrlBefore, 'head');
        // Resolve the matching branch.
        // v2.74.2 — Normalize both sides (trim, collapse whitespace, lowercase)
        // to match the runtime CLICK_BY_LABEL matcher's case-insensitive
        // behavior (_normalizeLabelForMatch in contentScript.js). Without
        // this, an author who captures branch.label="Reports" but a
        // strategy passing LAYER1="reports" would hit "no branch matches"
        // even though the head's click succeeded — confusing inconsistency.
        const normLabel = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const targetLabel = normLabel(resolvedLayer1);
        const branch = action.branches.find(b => normLabel(b?.label) === targetLabel);
        if (!branch) {
          const known = action.branches.map(b => `"${b?.label}"`).join(', ');
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", chain has no branch for layer-1 label "${resolvedLayer1}" (defined: ${known})`,
          };
        }
        // Brief settle so the layer-2 menu is in the DOM before we click in it.
        // 80ms matches the EXTRACT-after-action settle pattern; pages that
        // need longer can put a WAIT_FOR branch action.
        await TemplateWalker.#sleep(80);
        TemplateWalker.#broadcast(broadcastKey, {
          status: 'running', phase: 'fragment',
          fragmentId, fragmentName: frag.name,
          action: branch.action, selector: branch.selector,
          message: `chain branch "${resolvedLayer1}": ${branch.action} ${branch.selector ?? ''}`,
        });
        // v2.74.3 — CLICK_BY_LABEL branches read the chain's bodyValue
        // (already substituted by injectParams above) as their click
        // target. WAIT branches use their own value (ms duration).
        // WAIT_FOR has no value at all.
        const branchValue = (branch.action === 'CLICK_BY_LABEL')
          ? (action.bodyValue ?? '')
          : (branch.value ?? '');
        const branchStep = {
          action: branch.action,
          selector: branch.selector ?? '',
          value: branchValue,
          // v2.74.264 — Phase 6.5 coverage extension: chain branch is
          // the terminal step within a chain dispatch. Head is the
          // layer-1 menu click; branch is the actual destination. If
          // the branch navigates / opens a modal, observation surfaces
          // it. Head observation would catch the menu-open mutation
          // which is usually noise; branch is the meaningful effect.
          _isTerminal: true,
        };
        const branchUrlBefore = (branch.action === 'CLICK_BY_LABEL') ? await captureUrl() : null;
        let branchResult;
        try {
          // v2.74.163 — Branch dispatches in the same frame as the
          // head (chainFrameId was resolved above).
          branchResult = await TemplateWalker.#executeStep(tabId, branchStep, chainFrameId);
        } catch (err) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", chain branch "${resolvedLayer1}" threw: ${err.message}`,
          };
        }
        if (!branchResult?.success) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", chain branch "${resolvedLayer1}" failed: ${branchResult?.error ?? 'unknown'}`,
          };
        }
        await reportNavIf(branchUrlBefore, `branch "${resolvedLayer1}"`);
        // v2.74.2 — actionsRun increments by 1 for the whole chain even
        // though it ran 2 #executeStep calls (head + branch). The chain is
        // one authored card / one rawJson entry, so one increment matches
        // the user-facing abstraction. If a future feature needs accurate
        // step accounting, this is the place to revisit.
        rememberAction(action);
        actionsRun++;
        continue;
      }

      TemplateWalker.#broadcast(broadcastKey, {
        status: 'running', phase: 'fragment',
        fragmentId, fragmentName: frag.name,
        action: action.action, selector: action.selector,
        message: `${action.action} ${action.selector ?? ''}`,
      });

      // v2.36.0 (J1) — Capture URL before mutating actions. If the URL
      // changes, that's reportable diagnostic info whether the step
      // succeeded or failed. The "click succeeded but the page navigated
      // away" case is the Indeed-style silent-escape trap that FOREACH
      // hits when a card click unexpectedly navigates instead of opening
      // a side panel. We don't block or fail on navigation here — the
      // engine's job is to report faithfully; DETECT/TRY is the
      // author-chosen response.
      const isMutatingAction = action.action === 'CLICK' || action.action === 'TYPE';
      let urlBefore = null;
      if (isMutatingAction) {
        try {
          const tabInfo = await chrome.tabs.get(tabId);
          urlBefore = tabInfo?.url ?? null;
        } catch { /* tab closing/navigating — best effort */ }
      }

      try {
        // v2.74.163 — Resolve per-action frame. Same-origin iframe
        // actions carry `frameUrl` from authoring time; top-frame
        // actions have no frameUrl and default to TOP_FRAME_ID. The
        // resolver re-matches by URL each time because frame ids
        // aren't stable across reloads.
        const stepFrameId = await TemplateWalker._resolveFrameId(tabId, action.frameUrl);
        const execResult = await TemplateWalker.#executeStep(tabId, action, stepFrameId);
        if (!execResult?.success) {
          return {
            success: false, actionsRun, antecedentActionsRun, lastActions,
            error: `In "${frag.name}", step ${action.action} ${action.selector ?? ''} failed: ${execResult?.error ?? 'unknown'}`,
          };
        }
        // v2.29.13 — Log what CLICK (and other element-targeting actions)
        // actually landed on. Helps diagnose cases where CLICK succeeds but
        // hits the wrong element — subsequent iterations may click the same
        // previously-activated item instead of a new one, and the postcondition
        // checker only notices that some activation occurred.
        if (execResult.clicked) {
          const c = execResult.clicked;
          Logger.info('TemplateWalker',
            `CLICK landed on <${c.tag}${c.id ? ` id="${c.id}"` : ''}> "${c.text}"` +
            (c.href ? ` href="${c.href.slice(0, 60)}"` : '') +
            (c.ariaPressedBefore !== null ? ` aria-pressed(before)=${c.ariaPressedBefore}` : ''));
        }
        // v2.36.0 (J1) — URL-change detection. After a mutating action
        // succeeded, check if the tab ended up somewhere new. If so, emit
        // a diagnostic log AND attach the change to execResult so the
        // caller (and failure surfaces) can see it. This is the piece
        // that would have told us immediately why iteration 11/16
        // failed — iteration 10 silently navigated away.
        if (isMutatingAction && urlBefore != null) {
          try {
            // Brief settle — synchronous navigation may take a tick to
            // register in tabs.get(). 30ms is enough in practice.
            await TemplateWalker.#sleep(30);
            const tabInfo = await chrome.tabs.get(tabId);
            const urlAfter = tabInfo?.url ?? null;
            if (urlAfter && urlAfter !== urlBefore) {
              Logger.warn('TemplateWalker',
                `${action.action} caused navigation: "${urlBefore.slice(0, 60)}" → "${urlAfter.slice(0, 60)}" ` +
                `— the click succeeded at the DOM level but the tab left the page. ` +
                `Subsequent steps will run against the new page.`);
              execResult.navigated = { from: urlBefore, to: urlAfter };
            }
          } catch { /* tab closed — fine */ }
        }
        rememberAction(action);
        actionsRun++;
        await TemplateWalker.#sleep(200);
      } catch (err) {
        return {
          success: false, actionsRun, antecedentActionsRun, lastActions,
          error: `In "${frag.name}", step ${action.action} threw: ${err.message}`,
        };
      }
    }

    // Let the page settle after the fragment finishes
    await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID).catch(() => {});

    return { success: true, actionsRun, antecedentActionsRun, lastActions, error: null };
  }

  /**
   * Pass C — Probe a Fragment's postconditions against the current tab state.
   *
   * Evaluates each condition on the tab. Returns { ok, failures } where
   * `failures` is an array of conditions that did NOT hold.
   *
   * v2.29.12 (Pass F4) — Optionally polls. When `timeoutMs` > 0, retries the
   * full condition set every `pollIntervalMs` until all conditions pass or
   * the deadline elapses, returning the last probe's result either way.
   * This handles SPA timing: a CLICK returns success as soon as the DOM
   * event fires, but the framework needs time to update URL/state/aria
   * before postconditions hold. Previous behavior was one-shot: if the
   * framework hadn't caught up within the ~50ms before the post-check,
   * the iteration was scored as failed even though the click worked.
   *
   * @param {Object} opts
   * @param {number} opts.tabId
   * @param {Array<Object>|Object} opts.conditions  - array of condition objects
   *   (legacy fragment pre/post shape) OR a Assertion { match, conditions }.
   * @param {number} [opts.timeoutMs=0]      - max total wait (0 = one-shot)
   * @param {number} [opts.pollIntervalMs=100] - poll cadence during retry
   * @returns {Promise<{ ok: boolean, failures: Array<Object>, elapsedMs: number, attempts: number }>}
   */
  static async checkConditions({ tabId, conditions, scope = null, timeoutMs = 0, pollIntervalMs = 100 }) {
    // v2.41.0 (Pass M1) — accept either a legacy array OR a Assertion.
    // Both flow through normalizeAssertion to a canonical { match, conditions }.
    let assertion = TemplateWalker.#asAssertion(conditions);
    if (assertion.conditions.length === 0) {
      return { ok: true, failures: [], elapsedMs: 0, attempts: 0 };
    }

    // v2.42.0 (Pass M2) — Resolve any assertion_ref entries into their
    // referenced assertion bodies. This is a no-op for assertions that
    // contain only primitive conditions (the common case), so the cost is
    // tiny — one flatten call that walks N conditions.
    //
    // If flattening throws (cycle, missing ref, mode mismatch), surface
    // the error as a probe failure rather than crashing the engine.
    try {
      assertion = await flattenAssertion(assertion, async (id) => {
        return await StorageManager.getAssertion(id);
      }, {
        // v2.72.29 (Pass 17) — perspective_ref expansion during flatten.
        // v2.74.320 — Hydrate landmarks[] from the registry. The Phase-2
        // migration (v2.74.275) made saved perspectives store ONLY landmarkRefs[]
        // (UIDs) and explicitly drop the embedded landmarks[] (see
        // perspective-capture.js savePerspective). But Assertion.js's perspective_ref
        // expansion reads perspective.landmarks[].selector — so without rehydration
        // every perspective_ref hit the empty-landmarks fail-soft and evaluated
        // false, breaking active-Perspective-set evaluation (fragment-author showed
        // "No perspective matches this page" for every page). Rehydrate here so
        // the registry stays authoritative while the expander still sees
        // selectors. One extra batched read only when landmarks[] is absent.
        getPerspective: async (id) => {
          const loc = await StorageManager.getPerspective(id);
          // v2.74.332 — `landmarks` is now LandmarkNode[] (PERSPECTIVE_SPEC § 3
          // Layer 2), NOT hydrated records. Assertion.js's perspective_ref
          // expansion needs records WITH selectors, so flatten the node tree
          // → UIDs (the landmarkRefs mirror is exactly that) and REPLACE
          // loc.landmarks with the fetched registry records for the
          // expansion. (This perspective object is transient — used only for
          // predicate expansion — so overwriting the canonical nodes is safe.)
          // Always hydrate when refs exist; the old "only if landmarks empty"
          // gate would now skip (nodes are present) and break the expansion.
          if (loc && Array.isArray(loc.landmarkRefs) && loc.landmarkRefs.length > 0) {
            try {
              const map = await StorageManager.getLandmarks(loc.landmarkRefs);
              loc.landmarks = loc.landmarkRefs
                .map(uid => map[uid])
                .filter(lm => lm && typeof lm.selector === 'string' && lm.selector.trim());
            } catch (e) {
              Logger.warn('TemplateWalker', `perspective_ref hydrate failed for ${id}: ${e.message}`);
            }
          }
          return loc;
        },
      });
    } catch (err) {
      Logger.error('TemplateWalker', `checkConditions: assertion flatten failed — ${err.message}`);
      return {
        ok: false,
        failures: [{ condition: { type: 'assertion_ref' }, reason: err.message }],
        elapsedMs: 0,
        attempts: 1,
      };
    }
    if (assertion.conditions.length === 0) {
      return { ok: true, failures: [], elapsedMs: 0, attempts: 0 };
    }
    const matchMode = assertion.match;

    // v2.46.0 (Pass O1) — Split conditions into two evaluators:
    //   - field-*: read iteration record from scope, compare in-memory (no DOM)
    //   - everything else: send to content script via CHECK_CONDITION (DOM)
    //
    // Field conditions need scope to read their record. If scope wasn't
    // passed (legacy callsites or postcondition checks outside iteration),
    // field-* conditions automatically evaluate to false. They're only
    // meaningful when authored inside a FOREACH; this is fail-soft for
    // the case where a assertion references record fields but is invoked
    // out-of-iteration.
    const { fieldConditions, domConditions } = splitConditionsByEvaluator(assertion);
    const totalConds = fieldConditions.length + domConditions.length;
    // v2.47.0 (Pass O2) — k_of_n short-circuit thresholds:
    //   - successThreshold: K passes → satisfy
    //   - failureThreshold: (N - K + 1) failures → can't reach K, give up
    const kCount = (matchMode === 'k_of_n' && Number.isInteger(assertion.count))
      ? assertion.count : 0;
    const failureThresholdK = totalConds - kCount + 1;

    const evalScopeCondition = (cond) => {
      if (!scope) return { matched: false, reason: 'no scope (scope conditions need an execution context)' };

      // v2.46.0 — field_* conditions: read iteration variable's record.
      if (cond.type === 'field_equals' || cond.type === 'field_present' ||
          cond.type === 'field_gt'     || cond.type === 'field_lt' ||
          cond.type === 'field_gte'    || cond.type === 'field_lte') {
        let record = null;
        try { record = scope.get(cond.variable); } catch (_) { record = null; }
        const matched = evaluateFieldCondition(cond, record);
        const reason = matched ? '' :
          record == null ? `variable ${cond.variable} not in scope` :
          `${cond.variable}.${cond.field} did not satisfy condition`;
        return { matched, reason };
      }

      // v2.70.0 — All other scope conditions: binding_is_*, binding_length_*,
      // every_record_*, record_*, scalar_*. Delegated to evaluateDataCondition
      // which handles the full vocabulary defined in ConditionVocabulary.js.
      const result = evaluateDataCondition(cond, scope);
      return { matched: result.ok, reason: result.reason };
    };

    // Centralized short-circuit: returns true if we can stop early.
    const shouldShortCircuit = (passed, failures) => {
      if (matchMode === 'any')    return passed.length > 0;
      if (matchMode === 'all')    return failures.length > 0;
      if (matchMode === 'k_of_n') return passed.length >= kCount || failures.length >= failureThresholdK;
      return false;
    };

    const runOnce = async () => {
      const failures = [];
      const passed   = [];
      // v2.70.0 — Evaluate scope conditions first (cheap, in-memory; no DOM
      // round-trip). Includes both legacy field_* on iteration records and
      // the broader scope-family vocabulary (binding_is_*, every_record_*,
      // scalar_*, etc.). May short-circuit before any DOM work happens.
      for (const cond of fieldConditions) {
        const { matched, reason } = evalScopeCondition(cond);
        if (matched) passed.push(cond);
        else failures.push({ condition: cond, reason });
        if (shouldShortCircuit(passed, failures)) return { failures, passed };
      }
      // DOM conditions — content-script round-trip per condition.
      // v2.74.177 — Per-condition frame routing. Gate conditions
      // picked inside same-origin iframes carry `frameUrl`. Without
      // this, CHECK_CONDITION always lands on the top frame and
      // iframe-scoped selectors silently fail with "not found." The
      // resolver returns TOP_FRAME_ID when frameUrl is absent or the
      // iframe is gone, preserving back-compat for legacy conditions.
      // v2.74.193 — Each per-condition probe now logs frame routing
      // + the response detail so iframe routing issues + text_present
      // false-negatives are visible in the Logs tab.
      for (const cond of domConditions) {
        let matched = false;
        let reason  = '';
        let condFrameId = TOP_FRAME_ID;
        let res = null;
        try {
          condFrameId = await TemplateWalker._resolveFrameId(tabId, cond.frameUrl);
          Logger.info('TemplateWalker', `checkConditions probing "${cond.type}"`, {
            condFrameUrl   : cond.frameUrl ?? null,
            resolvedFrameId: condFrameId,
            selector       : cond.selector ?? null,
            text           : cond.text ?? null,
            pattern        : cond.pattern ?? null,
          });
          res = await TemplateWalker.#msg(tabId, {
            type: 'CHECK_CONDITION',
            payload: { condition: cond },
          }, condFrameId);
          matched = !!(res && res.matched === true);
          if (!matched) reason = res?.error ?? 'condition not met';
          Logger.info('TemplateWalker', `checkConditions result for "${cond.type}" (frameId=${condFrameId}):`, {
            matched,
            reason         : matched ? null : reason,
            elementFound   : res?.elementFound,
            snippet        : res?.snippet,
            snippetSource  : res?.snippetSource,
            pageContainsSearched: res?.pageContainsSearched,
          });
        } catch (err) {
          matched = false;
          reason  = err.message;
          Logger.error('TemplateWalker', `checkConditions threw for "${cond.type}" (frameId=${condFrameId}): ${err.message}`);
        }
        if (matched) passed.push(cond);
        else failures.push({ condition: cond, reason });
        if (shouldShortCircuit(passed, failures)) return { failures, passed };
      }
      return { failures, passed };
    };

    // Final ok determination per match mode.
    const okOf = (res) => {
      if (matchMode === 'all')    return res.failures.length === 0;
      if (matchMode === 'any')    return res.passed.length > 0;
      if (matchMode === 'k_of_n') return res.passed.length >= kCount;
      return false;
    };

    const started = Date.now();
    let attempts = 0;
    let res = await runOnce();
    attempts++;

    let ok = okOf(res);

    // Retry loop — only engaged when timeoutMs > 0
    while (!ok && Date.now() - started < timeoutMs) {
      await TemplateWalker.#sleep(pollIntervalMs);
      res = await runOnce();
      attempts++;
      ok = okOf(res);
    }

    const elapsedMs = Date.now() - started;
    return { ok, failures: res.failures, elapsedMs, attempts };
  }

  /**
   * Assertion normalization helper. Delegates to the canonical
   * normalizeAssertion in Assertion.js.
   *
   * v2.56.0 — was a local reimplementation that predated k_of_n
   * (v2.47.0). It silently coerced { match: 'k_of_n', count: N, ... }
   * to { match: 'all' } and dropped the count field, which broke any
   * caller passing a k_of_n Assertion to checkConditions (notably the
   * PageClassifier's recognizers, which always returned not-ok because
   * "all signals must match" is a stricter requirement than k-of-N).
   *
   * Kept as a thin indirection rather than inlined at the one call site
   * to preserve the local API surface. The deeper cleanup — removing
   * this method and calling normalizeAssertion directly — is a separate
   * follow-up.
   *
   * Accepts:
   *   - Assertion { match, conditions, count? }
   *   - Condition array [{type, ...}]
   *   - Single condition {type, ...}
   *   - null/undefined
   * Returns canonical Assertion.
   * @private
   */
  static #asAssertion(input) {
    return normalizeAssertion(input);
  }

  /**
   * Pass B — Fragment walk.
   *
   * A Fragment is a small deterministic page-state transition. The walk:
   *   1. Opens a tab on groundUrl
   *   2. Captures start DOM + start URL
   *   3. Delegates to #walkTask with a single-item taskSteps list whose text
   *      is the Fragment's description (Claude uses this as the task goal
   *      when proposing DOM actions)
   *   4. Captures end DOM + end URL after the user clicks Done
   *   5. Calls AnthropicService.proposeFragmentConditions to infer pre/post
   *      conditions from start/end state + the action sequence
   *   6. Returns a Fragment-ready payload that background.js will persist
   *
   * Unlike #walkAuto, there's no outer human-readable loop — a Fragment is
   * atomic by design. Unlike #walkTask, there's no retroactive Intent
   * synthesis or Procedure tree building — Fragments are always linear.
   *
   * Pass B+ — If antecedentFragmentId is set, replays the full transitive
   * antecedent chain on the tab before capturing start state, so the user
   * begins their walk in the right page context.
   *
   * @private
   * @returns {Promise<{
   *   success: boolean, aborted?: boolean,
   *   rawJson: string|null,               // linear DOM action JSON
   *   actions: Object[],                  // confirmed DOM actions
   *   params: string[],                   // {{PARAM}} names extracted from TYPE values
   *   startUrl: string, endUrl: string,
   *   startDom: string, endDom: string,   // DOM snapshots for condition inference
   *   preconditions: Object[],            // Claude-proposed
   *   postconditions: Object[],           // Claude-proposed
   *   rationale: string,                  // Claude's explanation of condition choices
   *   turnsUsed: number,
   *   error: string|null,
   * }>}
   */
  static async #walkFragment({
    groundId, groundUrl, fragmentId, fragmentName, fragmentDescription,
    // Pass B+ — antecedent chain replay. If antecedentFragmentId is set,
    // we resolve the full transitive chain and replay each Fragment's
    // actions in order (silently, with param substitution) before handing
    // the tab off to the user for the new Fragment's walk.
    antecedentFragmentId = null,
    antecedentParamBindings = null,
    isAborted, awaitApproval,
  }) {
    if (!fragmentName?.trim() || !fragmentDescription?.trim()) {
      return {
        success: false, rawJson: null, actions: [], params: [],
        startUrl: '', endUrl: '', startDom: '', endDom: '',
        preconditions: [], postconditions: [], rationale: '',
        turnsUsed: 0, error: 'Fragment requires name and description',
      };
    }

    let tabId = null;
    let startDom = '';
    let startUrl = groundUrl;
    let endDom = '';
    let endUrl = groundUrl;

    try {
      // 1. Open the tab ourselves so we can capture start DOM before handing
      //    the tab to #walkTask (which expects to either open its own tab or
      //    reuse an externalTabId we provide).
      tabId = await TemplateWalker.#openFocusedTab(groundUrl);
      Logger.info('TemplateWalker', `Fragment walk: opened tab ${tabId} for "${fragmentName}"`);

      await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
      await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);

      // 1b. Replay the antecedent chain if one is declared. We do this
      //     BEFORE capturing the start DOM — the post-chain state is what
      //     this Fragment considers its starting state.
      if (antecedentFragmentId) {
        TemplateWalker.#broadcast(fragmentId, {
          status: 'running', turn: 0, phase: 'antecedent',
          message: 'Replaying antecedent chain…',
        });

        const replayResult = await TemplateWalker.#replayAntecedentChain({
          tabId,
          antecedentFragmentId,
          paramBindings: antecedentParamBindings ?? {},
          broadcastKey: fragmentId,
          isAborted,
        });

        if (replayResult.aborted) {
          return {
            success: false, aborted: true,
            rawJson: null, actions: [], params: [],
            startUrl, endUrl: startUrl, startDom, endDom: startDom,
            preconditions: [], postconditions: [], rationale: '',
            turnsUsed: 0, error: 'Aborted during antecedent replay',
          };
        }
        if (!replayResult.success) {
          return {
            success: false,
            rawJson: null, actions: [], params: [],
            startUrl, endUrl: startUrl, startDom, endDom: startDom,
            preconditions: [], postconditions: [], rationale: '',
            turnsUsed: 0,
            error: `Antecedent replay failed: ${replayResult.error}`,
          };
        }

        Logger.info('TemplateWalker', `Antecedent chain replayed: ${replayResult.fragmentsRun} fragment(s), ${replayResult.actionsRun} action(s)`);
      }

      // 2. Capture start state (post-antecedent, if any)
      const startSnap = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, []);
      startDom = startSnap.snapshot;
      try {
        const tab = await chrome.tabs.get(tabId);
        startUrl = tab.url ?? groundUrl;
      } catch { /* tab lookup failed — keep groundUrl */ }

      Logger.info('TemplateWalker', `Fragment walk: start captured at ${startUrl} (${startDom.length} chars)`);

      // 3. Delegate to #walkTask with the Fragment description as the task.
      //    We pass `fragmentId` as the walker's internal groundId so that
      //    WALK_PROGRESS and STEP_PENDING broadcasts key on fragmentId —
      //    matching the fragmentWalkPanels map in the sidepanel.
      const innerResult = await TemplateWalker.#walkTask({
        groundId           : fragmentId,      // broadcast key
        groundUrl,
        aiName             : fragmentName,
        taskDesc           : fragmentDescription,
        taskSteps          : [{ id: `frag-step`, text: fragmentDescription, param: '' }],
        getTaskSteps       : null,
        continueFromPartial: false,
        partialTemplate    : null,
        isAborted,
        awaitApproval,
        externalTabId      : tabId,    // reuse the tab we opened
        keepTabOpen        : true,     // we close it in our finally block
      });

      if (innerResult.aborted) {
        return {
          success: false, aborted: true,
          rawJson: null, actions: innerResult.steps ?? [],
          params: [], startUrl, endUrl: startUrl, startDom, endDom: startDom,
          preconditions: [], postconditions: [], rationale: '',
          turnsUsed: innerResult.turnsUsed ?? 0,
          error: innerResult.error ?? 'Aborted',
        };
      }

      if (!innerResult.success) {
        return {
          success: false,
          rawJson: null, actions: innerResult.steps ?? [],
          params: [], startUrl, endUrl: startUrl, startDom, endDom: startDom,
          preconditions: [], postconditions: [], rationale: '',
          turnsUsed: innerResult.turnsUsed ?? 0,
          error: innerResult.error ?? 'Walk failed',
        };
      }

      const actions = Array.isArray(innerResult.steps) ? innerResult.steps : [];

      // 4. Capture end state
      const endSnap = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, []);
      endDom = endSnap.snapshot;
      try {
        const tab = await chrome.tabs.get(tabId);
        endUrl = tab.url ?? startUrl;
      } catch { /* keep startUrl */ }

      Logger.info('TemplateWalker', `Fragment walk: end captured at ${endUrl} (${endDom.length} chars, ${actions.length} actions)`);

      // 5. Extract params from confirmed actions (v2.29.6 — scans selector + value)
      const paramSet = new Set(TemplateWalker.#extractFragmentParams(actions));

      // 6. Infer pre/post conditions via Claude
      const conditionResult = await AnthropicService.proposeFragmentConditions({
        name: fragmentName,
        description: fragmentDescription,
        startDom, endDom, actions,
        startUrl, endUrl,
      });

      return {
        success       : true,
        rawJson       : JSON.stringify(actions),
        actions,
        params        : [...paramSet],
        startUrl, endUrl, startDom, endDom,
        preconditions : conditionResult.preconditions  ?? [],
        postconditions: conditionResult.postconditions ?? [],
        rationale     : conditionResult.rationale      ?? '',
        turnsUsed     : innerResult.turnsUsed ?? 0,
        error         : null,
      };

    } catch (err) {
      Logger.error('TemplateWalker', `Fragment walk failed: ${err.message}`);
      return {
        success: false,
        rawJson: null, actions: [], params: [],
        startUrl, endUrl: startUrl, startDom, endDom: endDom || startDom,
        preconditions: [], postconditions: [], rationale: '',
        turnsUsed: 0,
        error: err.message,
      };
    } finally {
      if (tabId !== null) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }

  /**
   * Single-phase task walk — discovers DOM interaction path for a user-defined
   * task (e.g. "create a support ticket"). No iframe discovery, no AI chat panel.
   * Claude receives the task description and rich DOM each turn, generates steps,
   * and names {{PARAM_NAME}} placeholders for variable values.
   * @private
   */
  static async #walkTask({
    groundId, groundUrl, aiName, taskDesc, taskSteps = [],
    getTaskSteps = null, continueFromPartial = false, partialTemplate = null,
    isAborted, awaitApproval,
    // Pass 5-redo — when called as the inner loop of #walkAuto, we want to
    // reuse an already-open tab and NOT close it on exit. externalTabId
    // bypasses the initial tab open; keepTabOpen bypasses the tab close.
    externalTabId = null, keepTabOpen = false,
  }) {
    const MAX_TASK_TURNS = Math.min(150, Math.max(20, (taskSteps.length || 1) * 4));

    let tabId         = externalTabId;
    let walkSucceeded = false;

    try {
      if (tabId === null) {
        tabId = await TemplateWalker.#openFocusedTab(groundUrl);
        Logger.info('TemplateWalker', `Task walk: opened tab ${tabId}`);
      } else {
        Logger.info('TemplateWalker', `Task walk: reusing tab ${tabId}`);
      }

      await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
      await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);

      const initSnap = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, []);
      let dom        = initSnap.snapshot;
      let prevSigs   = initSnap.sigs;

      const confirmedSteps  = [];
      const completedSteps  = [];
      const walkFillerValues = {};
      let lastStepError     = null;
      let turn              = 0;
      let currentStepIdx    = 0;
      let lastTabUrl        = groundUrl;

      // Pass B fix — Loop detection. If Claude proposes the same action three
      // turns running AND none of those turns changed the DOM, the walker is
      // in a dead loop (classic symptom: compound step where Claude can't
      // tell its last click opened a dropdown because the snapshot doesn't
      // capture that state). Track the last N attempted actions; if the most
      // recent 3 are byte-identical tuples AND all had domChanged=false,
      // abort with a clear error instead of burning tokens indefinitely.
      const recentAttempts = [];   // { signature, domChanged }
      const LOOP_WINDOW    = 3;    // three identical no-change tries = loop

      // ── Pass 5a — Fork state ──────────────────────────────────────────────
      // A Walk produces a branch-annotated Trace. Steps without a branch label
      // belong to the trunk. When the user declares a Fork at step N, step N
      // gets the new branch label AND gets recorded in `forkPoints` with its
      // parent step index (the last trunk step). Subsequent confirmed steps
      // inherit the active label until the Walk completes.
      //
      // Nested Forks: forkPoints is a stack. A new Fork pushes the previous
      // label onto it; declaring Done or unwinding could pop, but Pass 5a only
      // supports the first-level fork.
      let activeBranchLabel = null;     // null = trunk; non-null = branch name
      const forkPoints      = [];       // [{ label, parentStepIdx, stepSnapshot }]
      const branchContext   = [];       // stack of label snapshots for future nested-fork use

      // ── Continuation: re-execute prior confirmed steps with fillers ──────────
      if (continueFromPartial && partialTemplate?.rawJson) {
        Logger.info('TemplateWalker', `Continuation: re-executing ${partialTemplate.confirmedCount} prior steps`);

        // Extra settle time for SPAs that render after readyState complete
        await TemplateWalker.#sleep(1500);

        TemplateWalker.#broadcast(groundId, {
          status: 'running', turn: 0, phase: 1,
          action: 'NAVIGATE', selector: '',
          message: `Re-executing ${partialTemplate.confirmedCount} prior steps…`,
        });

        const priorSteps   = JSON.parse(partialTemplate.rawJson);
        const priorFillers = partialTemplate.fillerValues ?? {};

        for (const priorStep of priorSteps) {
          if (isAborted()) return { success: false, aborted: true, steps: [], rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: 0 };

          const replayStep = (priorStep.action === 'TYPE' || priorStep.action === 'SELECT') && priorStep.value?.includes('{{')
            ? { ...priorStep, value: priorStep.value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, n) => priorFillers[n] ?? TemplateWalker.#fillParam(`{{${n}}}`)) }
            : priorStep;

          // WAIT steps — execute as-is but cap at 2s during replay for speed
          if (replayStep.action === 'WAIT') {
            await TemplateWalker.#sleep(Math.min(2000, parseInt(replayStep.value, 10) || 1000));
            confirmedSteps.push(priorStep);
            continue;
          }

          let execResult = (await TemplateWalker.#executeAndObserve(tabId, replayStep, TOP_FRAME_ID)).execResult;

          // Retry once after a short wait — SPA may still be rendering
          if (!execResult.success) {
            Logger.warn('TemplateWalker', `Continuation step ${priorStep.step} failed (${execResult.error}) — retrying after 2s`);
            await TemplateWalker.#sleep(2000);
            execResult = (await TemplateWalker.#executeAndObserve(tabId, replayStep, TOP_FRAME_ID)).execResult;
          }

          if (!execResult.success) {
            Logger.warn('TemplateWalker', `Continuation re-execution failed at step ${priorStep.step}: ${execResult.error}`);
            return { success: false, steps: [], rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: `Continuation failed at prior step ${priorStep.step}: ${execResult.error}`, turnsUsed: 0 };
          }

          confirmedSteps.push(priorStep);

          // Wait for content script after navigation-triggering CLICKs
          if (replayStep.action === 'CLICK') {
            try {
              const tabInfo = await chrome.tabs.get(tabId);
              const newUrl  = tabInfo?.url ?? '';
              if (newUrl && newUrl !== lastTabUrl) {
                lastTabUrl = newUrl;
                await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
                await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);
                await TemplateWalker.#sleep(1000); // extra settle for SPAs
                prevSigs = [];
              }
            } catch { /* ok */ }
          }
        }

        // Seed completedSteps from prior task steps already done
        const liveStepsNow = getTaskSteps ? getTaskSteps() : taskSteps;
        currentStepIdx = partialTemplate.confirmedCount > 0
          ? Math.min(liveStepsNow.length - 1, partialTemplate.confirmedStepIdx ?? 0)
          : 0;

        // Populate completedSteps summary so Claude knows what was already done
        for (let i = 0; i < currentStepIdx; i++) {
          const s = liveStepsNow[i];
          if (s) completedSteps.push(`${i + 1}. ${s.text} ✓`);
        }

        Logger.info('TemplateWalker', `Continuation: re-execution complete — continuing from step ${currentStepIdx + 1}`);
        TemplateWalker.#broadcast(groundId, {
          status: 'running', turn: 0, phase: 1,
          action: 'NAVIGATE', selector: '',
          message: `Re-execution complete — discovering from step ${currentStepIdx + 1}`,
        });

        // Refresh DOM after replay
        const replaySnap = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, []);
        dom      = replaySnap.snapshot;
        prevSigs = replaySnap.sigs;
      }

      // Pass C fix — Track consecutive STEP_DONE outputs. If Claude emits
      // STEP_DONE N turns in a row without any DOM action landing in between,
      // the walker is in a control-flow loop (Claude thinks we're done, we
      // keep asking, step index marches into infinity). Abort to stop burning
      // tokens. Reset whenever a real action lands.
      let consecutiveStepDones = 0;
      const STEP_DONE_LOOP_LIMIT = 3;

      while (turn < MAX_TASK_TURNS) {
        if (isAborted()) {
          Logger.info('TemplateWalker', `Task walk aborted at turn ${turn + 1}`);
          // Save partial template if we confirmed at least one step
          const partial = confirmedSteps.length > 0 ? {
            rawJson          : JSON.stringify(confirmedSteps),
            confirmedCount   : confirmedSteps.length,
            confirmedStepIdx : currentStepIdx,
            fillerValues     : walkFillerValues,
          } : null;
          return { success: false, aborted: true, steps: confirmedSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: turn, partial };
        }

        turn++;

        // Read live taskSteps each turn — may have been edited mid-walk
        const liveSteps   = getTaskSteps ? getTaskSteps() : taskSteps;
        const currentStep = liveSteps[currentStepIdx] ?? null;
        const isLastStep  = currentStepIdx >= liveSteps.length; // true after last STEP_DONE

        // Pass C fix — Structural stop: if currentStepIdx has advanced past
        // the final task step, we're done. Don't re-prompt Claude for DONE —
        // synthesize the DONE transition directly. This eliminates the spurious
        // STEP_DONE loop class entirely: the only way to leave the loop with
        // tasks remaining is via explicit STEP_DONE + advance, and past-final
        // state is handled here without another LLM round-trip.
        if (currentStepIdx >= liveSteps.length) {
          Logger.info('TemplateWalker', `Task walk: all ${liveSteps.length} step(s) complete — synthesizing DONE at turn ${turn}`);

          // Fragment walks: synthesize DONE immediately (auto-confirmed by the
          // Fragment awaitApproval path in background). Task walks: ask for
          // final approval so user can review before save.
          if (awaitApproval) {
            try {
              TemplateWalker.#broadcast(groundId, {
                status: 'review', turn, phase: 1,
                action: 'DONE', selector: '',
                message: 'All steps complete — review and save',
              });
              await awaitApproval({ action: 'DONE', selector: '', value: '', phase: 1, final: true });
            } catch {
              return { success: false, aborted: true, steps: confirmedSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: turn };
            }
          }

          walkSucceeded = true;
          const rawJson  = JSON.stringify(confirmedSteps);
          const paramSet = new Set(TemplateWalker.#extractFragmentParams(confirmedSteps));
          StorageManager.deleteAuthoringSession(groundId).catch(() => {});

          return {
            success     : true,
            steps       : confirmedSteps,
            rawJson,
            preambleJson: '[]',
            meta        : {
              params     : [...paramSet],
              groundType : 'task',
              taskDesc   : taskDesc ?? null,
              forkPoints : forkPoints.length > 0 ? forkPoints : undefined,
            },
            anchors     : {},
            error       : null,
            turnsUsed   : turn,
          };
        }

        Logger.info('TemplateWalker', `Task turn ${turn}/${MAX_TASK_TURNS} — step ${currentStepIdx + 1}/${liveSteps.length}: "${currentStep?.text ?? 'finalise'}"`);

        const nextStep = await AnthropicService.getNextTaskStep({
          taskDesc, taskSteps: liveSteps, groundUrl, dom,
          currentStepIdx, currentStep, completedSteps,
          confirmedSteps, turn, maxTurns: MAX_TASK_TURNS, lastStepError, isLastStep,
          turnsRemaining: MAX_TASK_TURNS - turn,
        });

        // Parse/API errors are non-fatal — treat like a failed DOM step and retry
        if (!nextStep.success) {
          // Hard failures (no API key, aborted) should still terminate
          if (nextStep.error?.includes('No API key') || nextStep.error?.includes('Aborted')) {
            return { success: false, steps: [], rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: nextStep.error, turnsUsed: turn };
          }
          Logger.warn('TemplateWalker', `Task turn ${turn} — non-fatal error, retrying: ${nextStep.error}`);
          lastStepError = nextStep.error;
          const retrySnap = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, prevSigs);
          dom      = retrySnap.snapshot;
          prevSigs = retrySnap.sigs;
          continue;
        }

        const step        = nextStep.step;
        const stepLabel   = currentStep?.text ?? null;

        Logger.info('TemplateWalker', `Task turn ${turn} — ${step.action} "${(step.selector ?? '').slice(0, 70)}"${stepLabel ? ` [${currentStepIdx + 1}: ${stepLabel.slice(0, 40)}]` : ''}`);

        TemplateWalker.#broadcast(groundId, {
          status: 'running', turn, phase: 1,
          action: step.action, selector: step.selector,
          taskStepIdx: currentStepIdx + 1, taskStepText: stepLabel,
        });

        let approvalDecision = { action: 'confirm' };
        if (awaitApproval) {
          try { approvalDecision = (await awaitApproval({ ...step, phase: 1 })) ?? { action: 'confirm' }; }
          catch { return { success: false, aborted: true, steps: confirmedSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: turn }; }
        }

        // ── Pass 5a Fork handling ────────────────────────────────────────────
        // Fork decision: the user marked this step as a branch point. We
        // record the fork (labels + parent step index) and install the label
        // as active for this and subsequent steps. The step still runs below;
        // Fork doesn't skip execution, it just tags assignment.
        if (approvalDecision?.action === 'fork' && approvalDecision?.label) {
          const parentStepIdx = confirmedSteps.length; // last trunk step index (0-based, exclusive)
          if (activeBranchLabel) {
            branchContext.push(activeBranchLabel);
          }
          activeBranchLabel = String(approvalDecision.label).trim() || 'branch';
          forkPoints.push({
            label         : activeBranchLabel,
            parentStepIdx,
            domObservation: dom?.slice?.(0, 2000) ?? '',
          });
          Logger.info('TemplateWalker', `Fork declared at step ${parentStepIdx} — active branch "${activeBranchLabel}"`);
          TemplateWalker.#broadcast(groundId, {
            status: 'running', turn, phase: 1,
            action: step.action, selector: step.selector,
            message: `Branch "${activeBranchLabel}" — step will be recorded under this branch`,
            branchLabel: activeBranchLabel,
          });
        }

        // Reject decision: a reject is currently modeled by throw-on-reject in
        // the awaitApproval chain; leave that behavior untouched. (Reject-
        // with-reason is Pass 5b UI surface.)

        // Pass B — step_done decision: the user has declared the current
        // semantic step complete. Force STEP_DONE regardless of what Claude
        // proposed, so the walker advances (Fragment walks use this to exit
        // cleanly on "Done" after the user is satisfied with recorded actions).
        // Pass C fix — mark so the STEP_DONE loop guard doesn't count
        // user-initiated skips against Claude's credit.
        let stepDoneSource = 'claude';   // 'claude' | 'user'
        if (approvalDecision?.action === 'step_done') {
          Logger.info('TemplateWalker', `User declared step_done at turn ${turn} (${confirmedSteps.length} actions recorded)`);
          step.action   = 'STEP_DONE';
          step.selector = '';
          step.value    = '';
          stepDoneSource = 'user';
        }

        // ── STEP_DONE — advance to next task step ────────────────────────────
        if (step.action === 'STEP_DONE') {
          // Pass C fix — count consecutive Claude-emitted STEP_DONEs. User-
          // initiated "Done" clicks don't count (user is intentionally skipping).
          if (stepDoneSource === 'claude') {
            consecutiveStepDones++;
            if (consecutiveStepDones >= STEP_DONE_LOOP_LIMIT) {
              const loopErr = `Walker is stuck — Claude emitted STEP_DONE ${STEP_DONE_LOOP_LIMIT} times in a row with no DOM action in between. The walk likely started in a state where the task was already complete, or the task description is too vague. Try re-walking from an earlier starting state, or sharpen the description.`;
              Logger.warn('TemplateWalker', `STEP_DONE loop detected at turn ${turn} (${confirmedSteps.length} actions, ${currentStepIdx} steps advanced)`);
              TemplateWalker.#broadcast(groundId, {
                status: 'running', turn, phase: 1,
                action: 'STEP_DONE', selector: '',
                stepSuccess: false, stepError: 'STEP_DONE loop — walker aborted',
                verdict: 'retry', message: loopErr,
                taskStepIdx: currentStepIdx + 1, taskStepText: stepLabel,
              });
              return {
                success     : false,
                steps       : confirmedSteps,
                rawJson     : JSON.stringify(confirmedSteps),
                preambleJson: '[]',
                meta        : {},
                anchors     : {},
                error       : loopErr,
                turnsUsed   : turn,
              };
            }
          } else {
            // User-initiated skip — reset the counter; this was intentional
            consecutiveStepDones = 0;
          }

          completedSteps.push(`${currentStepIdx + 1}. ${currentStep?.text ?? ''} ✓`);
          currentStepIdx++;
          lastStepError = null;

          Logger.info('TemplateWalker', `Task step ${currentStepIdx} complete — advancing to step ${currentStepIdx + 1}`);
          TemplateWalker.#broadcast(groundId, {
            status: 'running', turn, phase: 1,
            action: 'STEP_DONE', selector: '',
            stepSuccess: true, verdict: 'continue',
            message: `Step ${currentStepIdx} complete ✓`,
            taskStepIdx: currentStepIdx, taskStepText: stepLabel,
          });

          // Refresh DOM for next step
          const snapAfter = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, prevSigs);
          dom      = snapAfter.snapshot;
          prevSigs = snapAfter.sigs;
          continue;
        }

        // Pass C fix — any non-STEP_DONE action resets the loop counter. We
        // only flag the loop when STEP_DONEs come back-to-back with nothing
        // real in between.
        consecutiveStepDones = 0;

        // ── DONE — save template ─────────────────────────────────────────────
        // EXTRACT is optional for task grounds — the user verifies on the actual
        // page. No guardrail here unlike AI grounds.
        if (step.action === 'DONE') {
          walkSucceeded = true;
          Logger.info('TemplateWalker', `Task walk complete — ${confirmedSteps.length} DOM steps in ${turn} turns`);

          // ── Final review pause — focus tab and await user approval ───────────
          // Bring the walk tab to the foreground so the user can inspect the
          // review page before the template is saved. Always fires for task grounds
          // regardless of auto mode — DONE is the one action that always requires
          // explicit approval.
          try { await chrome.tabs.update(tabId, { active: true }); } catch { /* ok */ }

          if (awaitApproval) {
            try {
              // Broadcast a special message so the walk panel shows the final prompt
              TemplateWalker.#broadcast(groundId, {
                status: 'review', turn, phase: 1,
                action: 'DONE', selector: '',
                message: 'Review the page, then click ▶ Play to save the template',
              });
              // Force step mode for final approval — pass final:true so background
              // ignores walkAutoMode for this one approval
              await awaitApproval({ action: 'DONE', selector: '', value: '', phase: 1, final: true });
            } catch {
              return { success: false, aborted: true, steps: confirmedSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: turn };
            }
          }

          const rawJson  = JSON.stringify(confirmedSteps);
          const paramSet = new Set(TemplateWalker.#extractFragmentParams(confirmedSteps));

          // Pass 5b — walk finished successfully; clear the authoring session
          StorageManager.deleteAuthoringSession(groundId).catch(() => {});

          return {
            success     : true,
            steps       : confirmedSteps,
            rawJson,
            preambleJson: '[]',
            meta        : {
              groundType : 'task',
              params     : [...paramSet],
              turnsUsed  : turn,
              // Pass 5a — fork points declared during this walk. Pass 5b will
              // consume this to build a DETECT node in the Procedure.
              forkPoints,
              branches   : forkPoints.map(f => f.label),
            },
            anchors     : {},
            turnsUsed   : turn,
            error       : null,
          };
        }

        // ── Normal action — execute against DOM ──────────────────────────────
        // For TYPE/SELECT steps with {{PARAM_NAME}} placeholders, substitute a
        // plausible filler value so form validation passes during discovery.
        // The original {{PARAM_NAME}} token is preserved in confirmedSteps.
        const execStep = (step.action === 'TYPE' || step.action === 'SELECT') && step.value?.includes('{{')
          ? { ...step, value: TemplateWalker.#fillParam(step.value) }
          : step;

        // Record filler values used — needed for continuation to reproduce same state
        if (execStep !== step && step.value?.includes('{{')) {
          step.value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
            if (!walkFillerValues[name]) {
              walkFillerValues[name] = TemplateWalker.#fillParam(`{{${name}}}`);
            }
          });
        }

        const { execResult, domChanged } = await TemplateWalker.#executeAndObserve(tabId, execStep, TOP_FRAME_ID);
        Logger.debug('TemplateWalker', `Task result — success:${execResult.success} domChanged:${domChanged}`);

        // Pass B fix — Loop detection. Track this attempt; if the last
        // LOOP_WINDOW attempts are identical tuples with no DOM change, abort.
        const attemptSig = `${step.action}|${step.selector ?? ''}|${step.value ?? ''}`;
        recentAttempts.push({ signature: attemptSig, domChanged });
        if (recentAttempts.length > LOOP_WINDOW) recentAttempts.shift();
        const isStuckLoop = recentAttempts.length === LOOP_WINDOW
          && recentAttempts.every(a => a.signature === attemptSig)
          && recentAttempts.every(a => a.domChanged === false);
        if (isStuckLoop) {
          const loopErr = `Walker is stuck — same action repeated ${LOOP_WINDOW} times with no page change:\n  ${step.action} ${step.selector}${step.value ? ` = ${step.value}` : ''}\nThe page isn't responding to this action. Possible causes: the element is hidden, the selector has drifted, or a compound step is needed. Try re-walking with a more specific description, or click Done if you consider this Fragment complete.`;
          Logger.warn('TemplateWalker', `Loop detected at turn ${turn}: ${attemptSig}`);
          TemplateWalker.#broadcast(groundId, {
            status: 'running', turn, phase: 1,
            action: step.action, selector: step.selector,
            stepSuccess: false, stepError: 'Stuck loop — walker aborted',
            verdict: 'retry', message: loopErr,
            taskStepIdx: currentStepIdx + 1, taskStepText: stepLabel,
          });
          return {
            success     : false,
            steps       : confirmedSteps,
            rawJson     : JSON.stringify(confirmedSteps),
            preambleJson: '[]',
            meta        : {},
            anchors     : {},
            error       : loopErr,
            turnsUsed   : turn,
          };
        }

        TemplateWalker.#broadcast(groundId, {
          status    : 'running', turn, phase: 1,
          action    : step.action, selector: step.selector,
          stepSuccess: execResult.success, stepError: execResult.error,
          verdict   : execResult.success ? 'continue' : 'retry',
          message   : execResult.success ? `${step.action} succeeded` : execResult.error,
          taskStepIdx: currentStepIdx + 1, taskStepText: stepLabel,
        });

        if (execResult.success) {
          const confirmedRecord = {
            step     : confirmedSteps.length + 1,
            action   : step.action,
            selector : step.selector,
            value    : step.value ?? '',
          };
          // Pass 5a — tag with active branch label when on a fork branch.
          // Trunk steps (activeBranchLabel=null) carry no _branch field,
          // preserving identical shape to pre-Pass-5 traces.
          if (activeBranchLabel) {
            confirmedRecord._branch = activeBranchLabel;
          }
          confirmedSteps.push(confirmedRecord);
          lastStepError = null;

          // Pass B fix — After resetting lastStepError on success, install a
          // no-change warning if the action executed but didn't change the
          // DOM. This is the signal Claude most often misses: the selector
          // matched something, the click fired, but nothing happened — so
          // DON'T repeat it. The warning flows into the next getNextTaskStep
          // prompt as lastStepError context.
          //
          // v2.61.5 — SCROLL_TO is exempt: it's intentionally non-mutating
          // (visibility only). domChanged=false after SCROLL_TO is the
          // correct outcome and Claude should proceed (typically STEP_DONE),
          // not retry with a different selector.
          if (domChanged === false && step.action !== 'WAIT' && step.action !== 'WAIT_FOR' && step.action !== 'STEP_DONE' && step.action !== 'SCROLL_TO') {
            lastStepError = `PREVIOUS ACTION PRODUCED NO VISIBLE CHANGE. The last ${step.action} on "${step.selector}" executed successfully (selector matched, event fired) but the DOM did NOT change. Do NOT repeat this exact action. Either:\n  (a) pick a DIFFERENT selector (prefer [data-testid], [aria-label], role, or visible text over generated ids like ":r9:" or hashed classes),\n  (b) try a different action type, or\n  (c) output STEP_DONE if the current page state already satisfies the task.`;
          }

          // Pass 5b — flush authoring session per confirmed step so a
          // crashed walk can resume at confirmed-step granularity.
          // Fire-and-forget — a failed flush shouldn't abort the walk.
          StorageManager.saveAuthoringSession(groundId, {
            confirmedSteps,
            activeBranchLabel,
            forkPoints,
            fillerValues: walkFillerValues,
            turn,
            startedAt: Date.now(),  // refreshed each flush; updatedAt set by StorageManager
          }).catch(err => Logger.warn('TemplateWalker', `Session flush failed: ${err.message}`));
        } else {
          lastStepError = execResult.error;
        }

        // After a successful CLICK, detect if the tab navigated to a new page.
        // If so, wait for the content script to be ready — the old one was destroyed.
        // Tell Claude via lastStepError context so it knows to output STEP_DONE.
        if (execResult.success && step.action === 'CLICK') {
          try {
            const tabInfo    = await chrome.tabs.get(tabId);
            const newUrl     = tabInfo?.url ?? '';
            if (newUrl && newUrl !== lastTabUrl) {
              Logger.info('TemplateWalker', `Task walk: navigation detected → ${newUrl.slice(0, 80)}`);
              lastTabUrl = newUrl;
              await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
              await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);
              prevSigs = []; // reset sigs — new page, all elements are new
              // Inform Claude the page navigated — prompt it to output STEP_DONE
              // if this navigation was the expected outcome of the current step
              lastStepError = `PAGE_NAVIGATED: The page navigated to ${newUrl} — if this is the expected result of the current step, output STEP_DONE now.`;
            }
          } catch { /* tab may be closing or navigating */ }
        }

        // ── Unexpected reload detection ──────────────────────────────────────
        // Ping the content script before capture. If it's unreachable and this
        // wasn't a CLICK-triggered navigation, the page reloaded unexpectedly.
        // Wait for it to recover, reset prevSigs, and inform Claude.
        if (step.action !== 'CLICK' && step.action !== 'NAVIGATE') {
          try {
            await TemplateWalker.#msg(tabId, { type: 'PAGE_IDLE', payload: { idleMs: 0 } }, TOP_FRAME_ID);
          } catch {
            Logger.warn('TemplateWalker', `Task walk: unexpected page reload detected at turn ${turn}`);
            await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
            await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);
            prevSigs   = []; // reset sigs — reloaded page, all elements are new
            lastStepError = `PAGE_RELOADED: The page reloaded unexpectedly. Re-orient to the current page state and continue the task from where you left off.`;
          }
        }

        const afterSnap = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, prevSigs);
        dom      = afterSnap.snapshot;
        prevSigs = afterSnap.sigs;
      }

      return { success: false, steps: confirmedSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: `Task walk hit ${MAX_TASK_TURNS}-turn limit`, turnsUsed: turn };

    } finally {
      if (tabId !== null && !keepTabOpen) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }

  /**
   * Pass 5-redo — Auto-mode outer loop.
   *
   * Observe→Propose→Feedback→(inner)→Observe. Given a goal, Claude proposes
   * one human-readable step at a time; the user Confirms / Rejects (with
   * reason) / Forks / Done; on Confirm, the step is passed to the inner loop
   * (#walkTask with one step, awaitApproval=null, shared tab) which executes
   * the DOM actions straight through. The inner loop's DOM trace is recorded
   * as part of the confirmed outer step. On Done, the caller synthesizes
   * Intent retroactively (outer steps become taskSteps; flattened DOM actions
   * become the Trace).
   *
   * @private
   */
  static async #walkAuto({
    groundId, groundUrl, aiName, goal,
    continueFromPartial = false, partialTemplate = null,
    isAborted, awaitApproval,
  }) {
    if (!goal?.trim()) {
      return { success: false, steps: [], rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Auto mode requires a goal', turnsUsed: 0 };
    }

    const MAX_OUTER_TURNS = 40;   // hard ceiling on proposals per walk
    const MAX_REJECTIONS_PER_STATE = 3;

    let tabId = null;
    let walkSucceeded = false;

    try {
      tabId = await TemplateWalker.#openFocusedTab(groundUrl);
      Logger.info('TemplateWalker', `Auto walk: opened tab ${tabId} — goal: "${goal.slice(0, 80)}"`);

      await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
      await TemplateWalker.#waitForPageIdle(tabId, TOP_FRAME_ID);

      // Outer-loop state
      const confirmedOuterSteps = [];   // { idx, text, rationale, domActions, _branch, params }
      const flatDomActions      = [];   // flattened trace for post-walk Procedure build
      const walkFillerValues    = {};
      const rejectedProposals   = [];   // { text, reason, at } — reset each time state changes
      let rejectionCountAtState = 0;
      let activeBranchLabel     = null;
      const forkPoints          = [];
      let outerTurn             = 0;
      let lastDomSignature      = null;

      TemplateWalker.#broadcast(groundId, {
        status: 'running', turn: 0, phase: 'auto',
        message: `Auto mode — goal: "${goal.slice(0, 80)}"`,
      });

      while (outerTurn < MAX_OUTER_TURNS) {
        outerTurn++;
        if (isAborted()) {
          Logger.info('TemplateWalker', 'Auto walk aborted by user');
          return { success: false, aborted: true, steps: confirmedOuterSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: outerTurn };
        }

        // ── OBSERVE ──────────────────────────────────────────────────────────
        const snap = await TemplateWalker.#captureRich(tabId, TOP_FRAME_ID, []);
        const dom  = snap.snapshot;
        const currentSig = snap.sigs?.[0] ?? '';

        // If DOM state changed, rejections are stale — clear them
        if (currentSig !== lastDomSignature) {
          lastDomSignature = currentSig;
          rejectedProposals.length = 0;
          rejectionCountAtState = 0;
        }

        const screenshotDataUrl = await TemplateWalker.#captureScreenshotSafe(tabId);

        TemplateWalker.#broadcast(groundId, {
          status: 'proposing', turn: outerTurn, phase: 'auto',
          message: 'Claude is looking at the page…',
        });

        // ── PROPOSE ──────────────────────────────────────────────────────────
        const proposal = await AnthropicService.proposeNextStep({
          goal,
          groundUrl,
          dom,
          screenshotDataUrl,
          confirmedOuterSteps,
          rejectedProposals,
          activeBranchLabel,
          discoveryHints: [],   // TODO: thread siteMap hints in future
        });

        if (proposal.kind === 'error') {
          Logger.warn('TemplateWalker', `Propose failed: ${proposal.error}`);
          TemplateWalker.#broadcast(groundId, {
            status: 'running', turn: outerTurn, phase: 'auto',
            message: `Propose failed: ${proposal.error}. Retrying…`,
          });
          await TemplateWalker.#sleep(1500);
          continue;
        }

        if (proposal.kind === 'done') {
          Logger.info('TemplateWalker', `Auto walk: Claude declared DONE — ${confirmedOuterSteps.length} confirmed steps`);
          // Still require user confirmation of Done
          if (awaitApproval) {
            TemplateWalker.#broadcast(groundId, {
              status: 'review', turn: outerTurn, phase: 'auto',
              action: 'DONE', selector: '',
              message: 'Claude believes the goal is complete. Click ▶ Play to finalize, or ⑂ Fork / ✕ Reject to continue.',
              proposalText: 'Goal complete.',
              proposalRationale: proposal.rationale ?? '',
            });
            try {
              const decision = (await awaitApproval({ action: 'DONE', phase: 'auto', final: true, proposalText: 'Goal complete.' })) ?? { action: 'confirm' };
              if (decision.action === 'reject') {
                rejectedProposals.push({ text: 'DONE', reason: decision.reason ?? 'User rejected completion', at: Date.now() });
                continue;
              }
            } catch {
              return { success: false, aborted: true, steps: confirmedOuterSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: outerTurn };
            }
          }
          walkSucceeded = true;
          break;
        }

        if (proposal.kind === 'clarify') {
          // Tier 1: not surfaced as a dedicated UI yet — treat like an error
          Logger.info('TemplateWalker', `Clarify requested: "${proposal.question}"`);
          TemplateWalker.#broadcast(groundId, {
            status: 'running', turn: outerTurn, phase: 'auto',
            message: `Claude wants clarification (not yet supported): "${proposal.question}". Treating as a retry.`,
          });
          rejectedProposals.push({ text: proposal.question, reason: 'clarify requested but not implemented', at: Date.now() });
          continue;
        }

        // kind === 'propose'
        const proposedStepText  = proposal.text;
        const proposedRationale = proposal.rationale;
        const proposedParams    = proposal.params ?? [];

        Logger.info('TemplateWalker', `Auto turn ${outerTurn} proposal: "${proposedStepText.slice(0, 80)}"`);

        TemplateWalker.#broadcast(groundId, {
          status: 'pending', turn: outerTurn, phase: 'auto',
          proposalText: proposedStepText,
          proposalRationale: proposedRationale,
          proposalParams: proposedParams,
          branchLabel: activeBranchLabel,
        });

        // ── FEEDBACK ─────────────────────────────────────────────────────────
        let decision;
        try {
          decision = (await awaitApproval({
            action: 'PROPOSE', phase: 'auto',
            proposalText: proposedStepText,
            proposalRationale: proposedRationale,
            proposalParams: proposedParams,
          })) ?? { action: 'confirm' };
        } catch {
          return { success: false, aborted: true, steps: confirmedOuterSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted', turnsUsed: outerTurn };
        }

        if (decision.action === 'reject') {
          rejectedProposals.push({
            text   : proposedStepText,
            reason : decision.reason ?? 'no reason given',
            at     : Date.now(),
          });
          rejectionCountAtState++;
          if (rejectionCountAtState >= MAX_REJECTIONS_PER_STATE) {
            TemplateWalker.#broadcast(groundId, {
              status: 'running', turn: outerTurn, phase: 'auto',
              message: `${MAX_REJECTIONS_PER_STATE} rejections at this state — consider editing the goal or aborting.`,
            });
          }
          continue;
        }

        if (decision.action === 'done') {
          walkSucceeded = true;
          break;
        }

        // confirm OR fork: both execute the step and record it; fork also
        // tags this and subsequent confirmed steps with the new branch label.
        let stepBranch = activeBranchLabel;
        if (decision.action === 'fork' && decision.label) {
          const parentIdx = confirmedOuterSteps.length;
          activeBranchLabel = String(decision.label).trim() || 'branch';
          stepBranch = activeBranchLabel;
          forkPoints.push({
            label         : activeBranchLabel,
            parentStepIdx : parentIdx,
            domObservation: dom?.slice(0, 2000) ?? '',
          });
          Logger.info('TemplateWalker', `Fork at outer step ${parentIdx} → branch "${activeBranchLabel}"`);
        }

        // Possibly edited-by-user step text (the UI may send edited text)
        const finalStepText = (decision.editedText && String(decision.editedText).trim()) || proposedStepText;

        // ── INNER LOOP ───────────────────────────────────────────────────────
        // Run the single confirmed step through #walkTask with the shared tab,
        // awaitApproval=null (straight through), taskSteps = one item.
        TemplateWalker.#broadcast(groundId, {
          status: 'running', turn: outerTurn, phase: 'auto',
          message: `Running step: "${finalStepText.slice(0, 80)}"…`,
          branchLabel: stepBranch,
        });

        const innerStepRecord = { id: `auto-${outerTurn}`, text: finalStepText, param: proposedParams[0] ?? '' };

        const innerResult = await TemplateWalker.#walkTask({
          groundId, groundUrl, aiName,
          taskDesc       : finalStepText,
          taskSteps      : [innerStepRecord],
          getTaskSteps   : null,
          continueFromPartial: false,
          partialTemplate: null,
          isAborted,
          awaitApproval  : null,     // inner runs straight through
          externalTabId  : tabId,
          keepTabOpen    : true,
        });

        if (innerResult.aborted) {
          return { success: false, aborted: true, steps: confirmedOuterSteps, rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: 'Aborted during inner loop', turnsUsed: outerTurn };
        }

        if (!innerResult.success) {
          // Option (a): surface the failure; user picks next action via the
          // normal feedback UI. Record nothing yet; fall back to rejection
          // with the inner error as the reason. User can Retry / Edit-step /
          // Fork / Abort on the next proposal cycle.
          Logger.warn('TemplateWalker', `Inner loop failed: ${innerResult.error}`);
          rejectedProposals.push({
            text: finalStepText,
            reason: `Execution failed: ${innerResult.error ?? 'unknown error'}`,
            at: Date.now(),
          });
          rejectionCountAtState++;
          TemplateWalker.#broadcast(groundId, {
            status: 'running', turn: outerTurn, phase: 'auto',
            message: `Step failed: ${innerResult.error ?? 'unknown'}. Proposing again.`,
          });
          continue;
        }

        // Success — record the confirmed outer step with its DOM trace
        const innerSteps = Array.isArray(innerResult.steps) ? innerResult.steps : [];
        const confirmedRecord = {
          idx       : confirmedOuterSteps.length + 1,
          text      : finalStepText,
          rationale : proposedRationale,
          domActions: innerSteps,
          params    : proposedParams,
          startedAt : Date.now(),
          completedAt: Date.now(),
        };
        if (stepBranch) confirmedRecord._branch = stepBranch;
        confirmedOuterSteps.push(confirmedRecord);

        // Merge DOM actions into the flat trace (branch tags propagated)
        for (const a of innerSteps) {
          const flat = { ...a, step: flatDomActions.length + 1 };
          if (stepBranch) flat._branch = stepBranch;
          flatDomActions.push(flat);
        }

        // Session flush — fire-and-forget
        StorageManager.saveAuthoringSession(groundId, {
          mode: 'auto',
          goal,
          confirmedOuterSteps,
          activeBranchLabel,
          forkPoints,
          fillerValues: walkFillerValues,
          rejectedProposals,
          turn: outerTurn,
          startedAt: Date.now(),
        }).catch(err => Logger.warn('TemplateWalker', `Auto session flush failed: ${err.message}`));

        // Broadcast progress
        TemplateWalker.#broadcast(groundId, {
          status: 'running', turn: outerTurn, phase: 'auto',
          message: `Step ${confirmedOuterSteps.length} confirmed ✓`,
          autoStepCompleted: {
            idx      : confirmedRecord.idx,
            text     : finalStepText,
            rationale: proposedRationale,
            actionCount: innerSteps.length,
            branch   : stepBranch,
          },
        });
      }

      if (!walkSucceeded) {
        // Hit outer turn limit
        return {
          success: false, steps: confirmedOuterSteps,
          rawJson: null, preambleJson: '[]', meta: {}, anchors: {},
          error: `Auto walk hit ${MAX_OUTER_TURNS}-turn limit`,
          turnsUsed: outerTurn,
        };
      }

      // Clear session on success
      StorageManager.deleteAuthoringSession(groundId).catch(() => {});

      // Build the outputs: flatDomActions is the Trace; confirmedOuterSteps
      // become retroactive taskSteps. Params are the union of all step params.
      const paramSet = new Set();
      for (const s of confirmedOuterSteps) (s.params ?? []).forEach(p => paramSet.add(p));
      for (const p of TemplateWalker.#extractFragmentParams(flatDomActions)) paramSet.add(p);

      const retroactiveTaskSteps = confirmedOuterSteps.map(s => ({
        id   : `auto-${s.idx}`,
        text : s.text,
        param: (s.params && s.params[0]) ?? '',
      }));

      return {
        success      : true,
        steps        : flatDomActions,
        rawJson      : JSON.stringify(flatDomActions),
        preambleJson : '[]',
        meta         : {
          groundType : 'task',
          mode       : 'auto',
          goal,
          params     : [...paramSet],
          turnsUsed  : outerTurn,
          forkPoints,
          branches   : forkPoints.map(f => f.label),
          // Retroactive fields — background merges into the Path record
          retroactiveTaskSteps,
          retroactiveTaskDesc  : goal,
          confirmedOuterSteps,
        },
        anchors   : {},
        turnsUsed : outerTurn,
        error     : null,
      };

    } catch (err) {
      Logger.error('TemplateWalker', `Auto walk failed: ${err.message}`);
      return { success: false, steps: [], rawJson: null, preambleJson: '[]', meta: {}, anchors: {}, error: err.message, turnsUsed: 0 };
    } finally {
      if (tabId !== null) {
        chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }

  /**
   * Pass 5-redo — Screenshot capture wrapper. Returns a data URL or null on
   * failure. Uses chrome.tabs.captureVisibleTab which requires the tab's
   * window to be focused (Auto walks open focused tabs, so this holds).
   * @private
   */
  static async #captureScreenshotSafe(tabId) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'jpeg',
        quality: 60,   // lower quality = smaller payload; vision is robust to compression
      });
      return dataUrl ?? null;
    } catch (e) {
      Logger.warn('TemplateWalker', `Screenshot capture failed: ${e.message}`);
      return null;
    }
  }

  static async #runPhase1({ tabId, groundId, groundUrl, aiName, aliases, uiType = null, dom, snapshotTiers, isAborted = () => false, awaitApproval = null }) {
    const MAX_PHASE1_TURNS = 10;
    const confirmedSteps   = [];
    const frameSwitches    = [{ atStep: 0, frameUrl: null }];
    let activeFrameId      = TOP_FRAME_ID;
    let turn               = 0;
    let lastStepError      = null;

    // Max iframe depth derived from uiType — stops frame discovery at the right tier
    const maxIframeDepth = AnthropicService.getIframeDepth(uiType);

    /**
     * Once a panel iframe is found and committed, stop running frame discovery
     * on subsequent CLICKs. Without this gate every turn re-discovers and the
     * panel toggle button closes+reopens the panel.
     */
    let frameCommitted = false;

    while (turn < MAX_PHASE1_TURNS) {
      // Abort check — at start of each turn before any API call
      if (isAborted()) {
        Logger.info('TemplateWalker', `P1 Aborted at turn ${turn + 1}`);
        return { success: false, aborted: true, preamble: confirmedSteps, handoff: null, frameSwitches, turnsUsed: turn, error: 'Aborted' };
      }

      turn++;
      Logger.info('TemplateWalker', `P1 Turn ${turn}/${MAX_PHASE1_TURNS}`);

      const nextStep = await AnthropicService.getNextStep({
        phase: 1, aiName, aliases, groundUrl, dom, uiType,
        confirmedSteps, turn, maxTurns: MAX_PHASE1_TURNS, lastStepError,
      });

      if (!nextStep.success) {
        return { success: false, preamble: [], handoff: null, frameSwitches, turnsUsed: turn, error: nextStep.error };
      }

      const step = nextStep.step;
      Logger.info('TemplateWalker', `P1 Turn ${turn} — ${step.action} "${(step.selector ?? '').slice(0, 70)}"`);

      TemplateWalker.#broadcast(groundId, { status: 'running', turn, phase: 1, action: step.action, selector: step.selector });

      // ── Spot execution gate ───────────────────────────────────────────────
      if (awaitApproval) {
        try {
          await awaitApproval({ ...step, phase: 1 });
        } catch {
          return { success: false, aborted: true, preamble: confirmedSteps, handoff: null, frameSwitches, turnsUsed: turn, error: 'Aborted' };
        }
      }

      const { execResult, domChanged } = await TemplateWalker.#executeAndObserve(tabId, step, activeFrameId);
      Logger.debug('TemplateWalker', `P1 Result — success:${execResult.success} domChanged:${domChanged}`,
        execResult.error ? { error: execResult.error } : undefined);

      // Frame discovery after CLICK/FIND_AI — runs once only (frameCommitted gate)
      if (!frameCommitted && (step.action === 'CLICK' || step.action === 'FIND_AI') && execResult.success) {
        await TemplateWalker.#sleep(POST_CLICK_SETTLE_MS);
        await TemplateWalker.#waitForPageIdle(tabId, activeFrameId);

        const discoveredFrameId = await TemplateWalker.#discoverDeepestFrame(tabId, activeFrameId, 0, maxIframeDepth);
        if (discoveredFrameId !== null) {
          // Commit immediately to the discovered Tier 1 frame — do NOT wait for
          // findFirstInputFrame before committing. An empty snapshot means the
          // frame is still loading, not that it's wrong. Committing here ensures
          // subsequent turns send DOM snapshots from the panel frame, preventing
          // Claude from seeing the toolbar and toggling the panel closed.
          const tierDepth  = snapshotTiers.length;
          const frameUrl   = await TemplateWalker.#getFrameUrl(tabId, discoveredFrameId);
          activeFrameId    = discoveredFrameId;
          frameCommitted   = true;

          frameSwitches.push({ atStep: confirmedSteps.length + 1, frameUrl });
          Logger.info('TemplateWalker', `P1 Frame committed: frameId=${activeFrameId} url="${frameUrl}"`);

          await TemplateWalker.#waitForContentScript(tabId, activeFrameId);

          // Capture snapshot with retries — frame may still be loading
          let tierSnapshot = '';
          for (let attempt = 0; attempt < 8 && !tierSnapshot; attempt++) {
            const cap = await TemplateWalker.#captureTab(tabId, activeFrameId);
            tierSnapshot = cap.dom;
            if (!tierSnapshot) {
              Logger.debug('TemplateWalker', `P1 Frame snapshot empty (attempt ${attempt + 1}/8) — retrying`);
              await TemplateWalker.#sleep(500);
            }
          }
          snapshotTiers.push({ depth: tierDepth, frameUrl, frameId: activeFrameId, snapshot: tierSnapshot });
          Logger.info('TemplateWalker', `P1 Snapshot tier ${tierDepth} recorded (${tierSnapshot.length} chars)`);
        }
      }

      const after = await TemplateWalker.#captureTab(tabId, activeFrameId);
      Logger.debug('TemplateWalker', `P1 Post-step DOM (${after.dom.length} chars, frameId:${activeFrameId})`);

      // ── Phase 1 termination: FOCUS_CHECK on discovered input ─────────────
      // Runs after any successful step once the panel frame is committed —
      // not just after CLICK/FIND_AI/WAIT_FOR. This way if Claude generates
      // a WAIT step while we're already in the panel frame, we still check
      // whether the input has become focusable.
      const shouldCheckInput = execResult.success && (
        frameCommitted ||
        step.action === 'FIND_AI' ||
        step.action === 'CLICK' ||
        step.action === 'WAIT_FOR'
      );

      if (shouldCheckInput) {
        let inputSelector = null;
        for (let attempt = 0; attempt < 6 && !inputSelector; attempt++) {
          inputSelector = await TemplateWalker.#findInputInFrame(tabId, activeFrameId);
          if (!inputSelector) {
            Logger.debug('TemplateWalker', `P1 findInputInFrame: no input yet (attempt ${attempt + 1}/6)`);
            await TemplateWalker.#sleep(500);
          }
        }

        if (inputSelector) {
          const focusResult = await TemplateWalker.#msg(tabId, {
            type: 'FOCUS_CHECK', payload: { selector: inputSelector },
          }, activeFrameId);

          if (focusResult?.focusable) {
            Logger.info('TemplateWalker', `P1 FOCUS_CHECK passed — input "${inputSelector}" is focusable`);
            const frameUrl = await TemplateWalker.#getFrameUrl(tabId, activeFrameId);
            confirmedSteps.push({ step: confirmedSteps.length + 1, action: step.action, selector: step.selector, value: step.value });
            return {
              success      : true,
              preamble     : confirmedSteps,
              handoff      : { inputSelector, frameUrl, frameId: activeFrameId },
              frameSwitches,
              turnsUsed    : turn,
              error        : null,
            };
          } else {
            Logger.debug('TemplateWalker', `P1 FOCUS_CHECK: input found but not focusable yet — continuing`);
          }
        }
      }

      // Standard verdict for non-terminal steps
      if (!execResult.success) {
        lastStepError = execResult.error ?? `${step.action} failed`;
        dom = after.dom;
        continue;
      }

      lastStepError = null;
      confirmedSteps.push({ step: confirmedSteps.length + 1, action: step.action, selector: step.selector, value: step.value });
      dom = after.dom;
    }

    return { success: false, preamble: confirmedSteps, handoff: null, frameSwitches, turnsUsed: turn, error: `Phase 1 hit ${MAX_PHASE1_TURNS}-turn limit without confirming AI input` };
  }

  // ── Phase 2: interaction discovery ───────────────────────────────────────

  /**
   * Starting from the access point confirmed by Phase 1, discovers and
   * confirms the TYPE → send CLICK → EXTRACT interaction path.
   *
   * @private
   * @returns {Promise<{ success, steps, anchors, turnsUsed, error }>}
   */
  static async #runPhase2({ tabId, groundId, groundUrl, aiName, aliases, uiType = null, sampleQuestion, handoff, snapshotTiers, isAborted = () => false, awaitApproval = null }) {
    const MAX_PHASE2_TURNS = 15;
    const confirmedSteps   = [];
    let turn               = 0;
    let lastStepError      = null;
    let activeFrameId      = handoff.frameId ?? TOP_FRAME_ID;
    let anchors            = { sendBusy: null, responseContainer: null };
    let anchorDiscoveryAttempted = false;
    let baselineMessageCount     = 0;

    await TemplateWalker.#waitForContentScript(tabId, activeFrameId);
    // Use rich snapshot for Phase 2 — includes text content and change delta
    const initSnap  = await TemplateWalker.#captureRich(tabId, activeFrameId, []);
    let dom         = initSnap.snapshot;
    let prevSigs    = initSnap.sigs;
    let baselineSigs = []; // element signatures captured before TYPE — used for post-send snapshot

    const alreadyCaptured = snapshotTiers.some(t => t.frameId === activeFrameId);
    if (!alreadyCaptured) {
      const frameUrl = handoff.frameUrl;
      snapshotTiers.push({ depth: snapshotTiers.length, frameUrl, frameId: activeFrameId, snapshot: dom });
    }

    while (turn < MAX_PHASE2_TURNS) {
      // Abort check — at start of each turn before any API call
      if (isAborted()) {
        Logger.info('TemplateWalker', `P2 Aborted at turn ${turn + 1}`);
        return { success: false, aborted: true, steps: confirmedSteps, anchors, turnsUsed: turn, error: 'Aborted' };
      }

      turn++;
      Logger.info('TemplateWalker', `P2 Turn ${turn}/${MAX_PHASE2_TURNS}`);

      const nextStep = await AnthropicService.getNextStep({
        phase: 2, aiName, aliases, groundUrl, dom, uiType,
        sampleQuestion, handoff,
        confirmedSteps, turn, maxTurns: MAX_PHASE2_TURNS, lastStepError,
      });

      if (!nextStep.success) {
        return { success: false, steps: [], anchors, turnsUsed: turn, error: nextStep.error };
      }

      const step = nextStep.step;
      Logger.info('TemplateWalker', `P2 Turn ${turn} — ${step.action} "${(step.selector ?? '').slice(0, 70)}"`);

      TemplateWalker.#broadcast(groundId, { status: 'running', turn, phase: 2, action: step.action, selector: step.selector });

      // ── Spot execution gate ───────────────────────────────────────────────
      if (awaitApproval) {
        try {
          await awaitApproval({ ...step, phase: 2 });
        } catch {
          return { success: false, aborted: true, steps: confirmedSteps, anchors, turnsUsed: turn, error: 'Aborted' };
        }
      }

      // Augment EXTRACT steps with fromIndex before execution
      const execStep = (step.action === 'EXTRACT' && anchors.responseContainer)
        ? { ...step, fromIndex: baselineMessageCount }
        : step;

      const { execResult, domChanged } = await TemplateWalker.#executeAndObserve(tabId, execStep, activeFrameId);
      Logger.debug('TemplateWalker', `P2 Result — success:${execResult.success} domChanged:${domChanged}`,
        execResult.error ? { error: execResult.error } : undefined);

      // Capture baseline element signatures right after TYPE is confirmed —
      // used to mark new elements in the post-send snapshot
      if (execResult.success && step.action === 'TYPE' && !baselineSigs.length) {
        try {
          const res = await TemplateWalker.#msg(tabId, { type: 'GET_BASELINE_SIGS' }, activeFrameId);
          baselineSigs = res?.sigs ?? [];
          Logger.debug('TemplateWalker', `P2 Baseline sigs captured: ${baselineSigs.length} elements`);
        } catch { /* non-fatal */ }
      }

      const afterRich = await TemplateWalker.#captureRich(tabId, activeFrameId, prevSigs);
      const after     = { dom: afterRich.snapshot };
      prevSigs        = afterRich.sigs;
      Logger.debug('TemplateWalker', `P2 Post-step DOM (${after.dom.length} chars)`);
      Logger.debug('TemplateWalker', `P2 Post-step DOM snapshot:\n${after.dom}`);

      // Anchor discovery after send CLICK
      const hasTypeConfirmed = confirmedSteps.some(s => s.action === 'TYPE');
      if (!anchorDiscoveryAttempted && step.action === 'CLICK' && hasTypeConfirmed && execResult.success) {
        anchorDiscoveryAttempted = true;

        // Wait 800ms for generation indicators to appear
        await TemplateWalker.#sleep(800);

        // Use rich snapshot for anchor discovery — includes text content so Claude
        // can identify status text elements like "Just a moment", "Gathering context"
        const busyRich = await TemplateWalker.#captureRich(tabId, activeFrameId, prevSigs);
        prevSigs = busyRich.sigs;

        Logger.info('TemplateWalker', 'P2 Anchor discovery (generation state)');
        const discovered = await AnthropicService.discoverAnchors({ aiName, dom: busyRich.snapshot, expectBusy: true });
        anchors = { ...anchors, ...Object.fromEntries(Object.entries(discovered).filter(([, v]) => v !== null)) };

        // If no generationIndicator found, also check for stop-button or disabled send-button
        // as generation signals before falling back to text stability
        if (!anchors.generationIndicator) {
          // Check for chat-stop-button (Breeze shows this during generation)
          try {
            const stopCount = await TemplateWalker.#countElements(tabId, activeFrameId, "[data-test-id='chat-stop-button']");
            if (stopCount > 0) {
              anchors.generationIndicator = "[data-test-id='chat-stop-button']";
              Logger.info('TemplateWalker', `P2 Found stop-button as generationIndicator`);
            }
          } catch { /* proceed */ }
        }

        if (!anchors.generationIndicator) {
          Logger.debug('TemplateWalker', 'P2 No generationIndicator — retrying with completed-state snapshot');
          const doneRich = await TemplateWalker.#captureRich(tabId, activeFrameId, prevSigs);
          prevSigs = doneRich.sigs;
          const second = await AnthropicService.discoverAnchors({ aiName, dom: doneRich.snapshot, expectBusy: false });
          anchors = { ...anchors, ...Object.fromEntries(Object.entries(second).filter(([, v]) => v !== null)) };
        }

        Logger.info('TemplateWalker', `P2 Anchors`, anchors);

        if (anchors.responseContainer) {
          baselineMessageCount = await TemplateWalker.#countElements(tabId, activeFrameId, anchors.responseContainer);
          Logger.info('TemplateWalker', `P2 Baseline message count: ${baselineMessageCount}`);
        }

        // Layer 2: primary gate is generationIndicator disappearing.
        if (anchors.generationIndicator) {
          Logger.info('TemplateWalker', `P2 Layer 2: waiting for generationIndicator to clear: "${anchors.generationIndicator}"`);
          const indicatorCleared = await TemplateWalker.#waitForElementGone(tabId, activeFrameId, anchors.generationIndicator, 120000);
          if (indicatorCleared) {
            const responseSel = anchors.responseElement ?? anchors.responseContainer ?? null;
            if (responseSel) {
              await TemplateWalker.#waitForNewText(tabId, activeFrameId, responseSel, baselineMessageCount, 10000);
            } else {
              await TemplateWalker.#sleep(800);
            }

            // Second anchor discovery pass — post-response DOM with text-preview.
            // Only updates responseElement and responseContainer — never overwrites
            // generationIndicator (it's gone from DOM now and would return null).
            try {
              const postSnap = await TemplateWalker.#capturePostSend(tabId, activeFrameId, baselineSigs, sampleQuestion);
              Logger.info('TemplateWalker', `P2 Post-response anchor re-discovery`);
              const refined = await AnthropicService.discoverAnchors({ aiName, dom: postSnap, expectBusy: false });
              if (refined.responseElement)   {
                anchors.responseElement   = refined.responseElement;
                Logger.info('TemplateWalker', `P2 Refined responseElement: "${refined.responseElement}"`);
              }
              if (refined.responseContainer) {
                anchors.responseContainer = refined.responseContainer;
                Logger.info('TemplateWalker', `P2 Refined responseContainer: "${refined.responseContainer}"`);
              }
            } catch (e) {
              Logger.warn('TemplateWalker', `P2 Post-response anchor re-discovery failed: ${e.message}`);
            }
          }
          anchors._indicatorUsed = true;
        } else if (anchors.responseContainer) {
          // Before falling back to text stability, check if a disabled send button
          // is visible — waiting for it to re-enable is more reliable than text
          // stability on a container that may include reasoning animation text.
          const disabledSend = await TemplateWalker.#findDisabledSendButton(tabId, activeFrameId);
          if (disabledSend) {
            Logger.info('TemplateWalker', `P2 Layer 2: waiting for send button to re-enable: "${disabledSend}"`);
            await TemplateWalker.#waitForElementGone(tabId, activeFrameId, `${disabledSend}[disabled]`, 120000);
            await TemplateWalker.#sleep(800);
            anchors._indicatorUsed = true; // treat as reliable completion signal
          } else {
            Logger.info('TemplateWalker', `P2 Layer 2 fallback: text stability on responseContainer`);
            await TemplateWalker.#waitForStreamingComplete(tabId, activeFrameId, anchors.responseContainer, baselineMessageCount, 45000);
          }
        } else {
          Logger.warn('TemplateWalker', `P2 Layer 2: no anchors — waiting 4000ms`);
          await TemplateWalker.#sleep(4000);
        }

        // Refresh DOM after wait using rich snapshot — Claude gets text content
        // and change delta to accurately identify the response element
        const postWaitRich = await TemplateWalker.#captureRich(tabId, activeFrameId, prevSigs);
        after.dom = postWaitRich.snapshot;
        prevSigs  = postWaitRich.sigs;
        Logger.info('TemplateWalker', `P2 Post-wait DOM refreshed (${after.dom.length} chars)`);
        Logger.debug('TemplateWalker', `P2 Post-wait DOM snapshot:\n${after.dom}`);
      }

      const verdict = await TemplateWalker.#localVerdict(
        tabId, activeFrameId, step, execResult, domChanged,
        confirmedSteps, anchors, baselineMessageCount
      );
      Logger.info('TemplateWalker', `P2 Turn ${turn} verdict: ${verdict.verdict} — ${verdict.message}`);

      TemplateWalker.#broadcast(groundId, {
        status    : verdict.verdict === 'done' ? 'done' : verdict.verdict === 'failed' ? 'failed' : 'running',
        turn, phase: 2, action: step.action, selector: step.selector,
        stepSuccess: execResult.success, stepError: execResult.error,
        verdict: verdict.verdict, message: verdict.message,
      });

      if (verdict.verdict === 'failed') {
        return { success: false, steps: [], anchors, turnsUsed: turn, error: `Phase 2 failed: ${verdict.message}` };
      }

      if (verdict.verdict === 'retry') {
        lastStepError = execResult.error ?? verdict.message;
        dom = after.dom;
        continue;
      }

      lastStepError = null;
      confirmedSteps.push({ step: confirmedSteps.length + 1, action: step.action, selector: step.selector, value: step.value });
      dom = after.dom;

      if (verdict.verdict === 'done') {
        Logger.info('TemplateWalker', `P2 Complete — ${confirmedSteps.length} steps in ${turn} turns`);
        return { success: true, steps: confirmedSteps, anchors, turnsUsed: turn, error: null };
      }
    }

    return { success: false, steps: confirmedSteps, anchors, turnsUsed: turn, error: `Phase 2 hit ${MAX_PHASE2_TURNS}-turn limit without EXTRACT` };
  }

  // ── Frame ancestry walker ─────────────────────────────────────────────────

  /**
   * Walks up the frame ancestry from candidateFrameId toward topFrameId,
   * returning the first frame that contains recognisable chat input signals.
   * Unlike the old validateInputFrame which only checked one level, this
   * correctly handles 3+ tier iframe hierarchies by trying each ancestor.
   *
   * @private
   * @param {number} tabId
   * @param {number} candidateFrameId  - Deepest discovered frame.
   * @param {number} topFrameId        - Frame to stop at if no valid frame found.
   * @returns {Promise<number>} The frame ID to use.
   */
  static async #findFirstInputFrame(tabId, candidateFrameId, topFrameId) {
    const INPUT_SIGNALS = [
      'textarea', 'input[type', '[role="textbox"]', '[role="combobox"]',
      'contenteditable', 'prose-mirror', 'chat-input', 'message-input',
    ];

    // Build ancestry list: start at candidate, work toward root via getAllFrames
    const allFrames = await new Promise(resolve =>
      chrome.webNavigation.getAllFrames({ tabId }, r => resolve(r ?? []))
    );
    const frameMap = Object.fromEntries(allFrames.map(f => [f.frameId, f]));

    const ancestry = [];
    let current = candidateFrameId;
    while (current !== undefined && current !== null) {
      ancestry.push(current);
      if (current === topFrameId) break;
      current = frameMap[current]?.parentFrameId;
    }
    if (!ancestry.includes(topFrameId)) ancestry.push(topFrameId);

    Logger.debug('TemplateWalker', `findFirstInputFrame ancestry: [${ancestry.join(' → ')}]`);

    for (const frameId of ancestry) {
      // Retry on empty snapshot — the frame may still be loading.
      // Empty ≠ no inputs; retry up to EMPTY_SNAP_RETRIES times before skipping.
      const EMPTY_SNAP_RETRIES  = 6;
      const EMPTY_SNAP_DELAY_MS = 500;
      let snapshot = '';

      for (let attempt = 0; attempt < EMPTY_SNAP_RETRIES; attempt++) {
        try {
          const res = await TemplateWalker.#msg(tabId, { type: 'DOM_SNAPSHOT' }, frameId);
          snapshot  = res?.snapshot ?? '';
          if (snapshot) break;
          Logger.debug('TemplateWalker', `findFirstInputFrame: frameId ${frameId} empty snapshot (attempt ${attempt + 1}/${EMPTY_SNAP_RETRIES}) — retrying`);
          await TemplateWalker.#sleep(EMPTY_SNAP_DELAY_MS);
        } catch {
          Logger.debug('TemplateWalker', `findFirstInputFrame: frameId ${frameId} — content script unreachable`);
          break;
        }
      }

      if (!snapshot) {
        Logger.debug('TemplateWalker', `findFirstInputFrame: frameId ${frameId} — no snapshot after retries, skipping`);
        continue;
      }

      const hasInput = INPUT_SIGNALS.some(sig => snapshot.toLowerCase().includes(sig.toLowerCase()));
      if (hasInput) {
        Logger.info('TemplateWalker', `findFirstInputFrame: frameId ${frameId} has input signals ✓`);
        return frameId;
      }
      Logger.debug('TemplateWalker', `findFirstInputFrame: frameId ${frameId} — no input signals`);
    }

    Logger.warn('TemplateWalker', `findFirstInputFrame: no frame with input signals found — using topFrameId ${topFrameId}`);
    return topFrameId;
  }

  /**
   * Finds the best interactive input element in a frame by querying the live DOM.
   * Replaces the old hardcoded selector candidate list — Claude reads the DOM
   * snapshot and the frame reports back what focusable inputs are present.
   *
   * Strategy: request a DOM_SNAPSHOT from the frame, then use FOCUS_CHECK on
   * a broad input selector. The content script resolves the best match using
   * whatever is actually in the frame, not a predetermined list.
   *
   * @private
   * @param {number} tabId
   * @param {number} frameId
   * @returns {Promise<string|null>} Selector string or null if nothing found.
   */
  static async #findInputInFrame(tabId, frameId) {
    // Broad selector covering all common chat input patterns.
    // Intentionally generic — Claude already knows the specific selector
    // from the DOM snapshot; this just confirms something focusable exists.
    const BROAD = [
      '[contenteditable="true"]',
      'textarea',
      '[role="textbox"]',
      'input[type="text"]',
    ];

    for (const selector of BROAD) {
      try {
        const res = await TemplateWalker.#msg(tabId, {
          type: 'FOCUS_CHECK', payload: { selector },
        }, frameId);
        if (res?.focusable) {
          Logger.debug('TemplateWalker', `findInputInFrame: "${selector}" is focusable in frameId ${frameId}`);
          return selector;
        }
      } catch { /* try next */ }
    }
    return null;
  }

  // ── Private: Content script messaging ────────────────────────────────────

  /**
   * Sends a message to the content script in a specific frame of a tab.
   * Defaults to the top frame (frameId 0) if not specified.
   *
   * @private
   * @param {number} tabId
   * @param {Object} message
   * @param {number} [frameId=0]
   * @returns {Promise<any>}
   * @throws {Error} If content script is unreachable.
   */
  static #msg(tabId, message, frameId = TOP_FRAME_ID) {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, message, { frameId }, (response) => {
        if (chrome.runtime.lastError) {
          return reject(new Error(chrome.runtime.lastError.message));
        }
        resolve(response);
      });
    });
  }

  /**
   * Recursively discovers the deepest reachable same-origin iframe after a
   * panel opens. Handles HubSpot Breeze's three-tier async load:
   *   Tier 1 — Shell iframe appears immediately after CLICK
   *   Tier 2 — Widget iframe (chatspot-widget-ui) loads inside the shell
   *   Tier 3 — ProseMirror input loads inside the widget iframe
   *
   * Algorithm:
   *   1. Poll getAllFrames for direct children of `parentFrameId`
   *      (frames where frame.parentFrameId === parentFrameId)
   *   2. Ping each candidate — first to respond wins this tier
   *   3. Recurse from the winner, looking for its children
   *   4. If recursion finds no deeper frame, return the winner
   *   5. If no candidate responds within IFRAME_DISCOVER_TIMEOUT_MS, return null
   *
   * Returns the deepest reachable leaf frame. If only one tier loads within
   * the timeout, returns that tier's frameId rather than failing.
   *
   * @private
   * @param {number} tabId
   * @param {number} parentFrameId   - Frame whose children we are searching.
   * @param {number} [depth=0]       - Recursion depth for logging.
   * @returns {Promise<number|null>} Deepest reachable frameId, or null if none found.
   */
  static async #discoverDeepestFrame(tabId, parentFrameId, depth = 0, maxDepth = 99) {
    const indent  = '  '.repeat(depth);
    const deadline = Date.now() + IFRAME_DISCOVER_TIMEOUT_MS;

    Logger.debug('TemplateWalker', `${indent}discoverDeepestFrame depth=${depth} parent=${parentFrameId} maxDepth=${maxDepth}`);

    // ── Poll for direct children of parentFrameId ─────────────────────────
    let winnerFrameId = null;

    outer: while (Date.now() < deadline) {
      const allFrames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId }, (results) => {
          resolve(results ?? []);
        });
      });

      const children = allFrames.filter(f =>
        f.parentFrameId === parentFrameId &&
        f.frameId       !== parentFrameId &&
        f.errorOccurred !== true
      );

      Logger.debug('TemplateWalker', `${indent}depth=${depth}: ${allFrames.length} total frames, ${children.length} children of ${parentFrameId}`);

      for (const child of children) {
        try {
          await TemplateWalker.#msg(tabId, { type: 'PAGE_IDLE', payload: { idleMs: 0 } }, child.frameId);
          Logger.info('TemplateWalker', `${indent}Tier ${depth + 1} frame reachable: frameId=${child.frameId} url="${child.url}"`);
          winnerFrameId = child.frameId;
          break outer;
        } catch {
          // Not ready yet — keep polling
        }
      }

      await TemplateWalker.#sleep(IFRAME_POLL_MS);
    }

    if (winnerFrameId === null) {
      Logger.warn('TemplateWalker', `${indent}No child frame found for parent=${parentFrameId} within ${IFRAME_DISCOVER_TIMEOUT_MS}ms`);
      return null;
    }

    // ── Recurse — but stop at maxDepth ────────────────────────────────────
    if (depth + 1 >= maxDepth) {
      Logger.info('TemplateWalker', `${indent}maxDepth ${maxDepth} reached — returning frameId ${winnerFrameId} (depth ${depth + 1})`);
      return winnerFrameId;
    }

    await TemplateWalker.#sleep(IFRAME_POLL_MS);

    const deeperFrameId = await TemplateWalker.#discoverDeepestFrame(tabId, winnerFrameId, depth + 1, maxDepth);

    if (deeperFrameId !== null) {
      Logger.info('TemplateWalker', `${indent}Deeper frame found: ${deeperFrameId} (depth ${depth + 2})`);
      return deeperFrameId;
    }

    Logger.info('TemplateWalker', `${indent}Leaf frame: frameId=${winnerFrameId} (depth ${depth + 1})`);
    return winnerFrameId;
  }

  /**
   * Captures a rich DOM snapshot for Phase 2 — includes text content,
   * interactability state, and change delta vs prevSigs.
   * Returns { snapshot, sigs } — sigs should be passed as prevSigs next turn.
   * @private
   */
  static async #captureRich(tabId, frameId, prevSigs = []) {
    try {
      const res = await TemplateWalker.#msg(tabId, {
        type   : 'DOM_SNAPSHOT_RICH',
        payload: { prevSigs },
      }, frameId);
      return { snapshot: res?.snapshot ?? '<!-- empty -->', sigs: res?.sigs ?? [] };
    } catch (err) {
      Logger.warn('TemplateWalker', `captureRich failed: ${err.message} — falling back`);
      const fallback = await TemplateWalker.#captureTab(tabId, frameId);
      return { snapshot: fallback.dom, sigs: [] };
    }
  }

  /**
   * Captures a post-send DOM snapshot that marks new elements and includes
   * text previews — gives Claude precise information for EXTRACT step generation.
   * Falls back to standard snapshot on error.
   * @private
   */
  static async #capturePostSend(tabId, frameId, baselineSigs = [], typedQuestion = '') {
    try {
      const res = await TemplateWalker.#msg(tabId, {
        type   : 'DOM_SNAPSHOT_POST_SEND',
        payload: { baselineSigs, typedQuestion },
      }, frameId);
      return res?.snapshot ?? '<!-- post-send snapshot empty -->';
    } catch (err) {
      Logger.warn('TemplateWalker', `capturePostSend failed: ${err.message} — falling back`);
      return (await TemplateWalker.#captureTab(tabId, frameId)).dom;
    }
  }

  /**
   * Polls until the content script in the given frame responds.
   *
   * @private
   * @param {number} tabId
   * @param {number} [frameId=0]
   * @returns {Promise<void>}
   * @throws {Error} If content script never responds.
   */
  static async #waitForContentScript(tabId, frameId = TOP_FRAME_ID) {
    for (let i = 0; i < CS_READY_RETRIES; i++) {
      try {
        await TemplateWalker.#msg(tabId, { type: 'PAGE_IDLE', payload: { idleMs: 0 } }, frameId);
        Logger.debug('TemplateWalker', `Content script ready in frameId ${frameId} after ${i} retries`);
        return;
      } catch {
        Logger.debug('TemplateWalker', `Content script not ready in frameId ${frameId}, retry ${i + 1}/${CS_READY_RETRIES}`);
        await TemplateWalker.#sleep(CS_READY_DELAY_MS);
      }
    }
    throw new Error(`Content script did not become reachable in frameId ${frameId}`);
  }

  /**
   * Polls PAGE_IDLE in the given frame until idle or timeout.
   *
   * @private
   * @param {number} tabId
   * @param {number} [frameId=0]
   * @returns {Promise<void>}
   */
  static async #waitForPageIdle(tabId, frameId = TOP_FRAME_ID) {
    const deadline = Date.now() + PAGE_IDLE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await TemplateWalker.#msg(tabId, { type: 'PAGE_IDLE', payload: { idleMs: NETWORK_IDLE_MS } }, frameId);
        if (res?.idle) return;
      } catch {
        return; // Content script unreachable — page may be navigating
      }
      await TemplateWalker.#sleep(300);
    }
    Logger.warn('TemplateWalker', `Page idle timeout in frameId ${frameId} — proceeding`);
  }

  // ── Private: Capture ──────────────────────────────────────────────────────

  /**
   * Captures an interactive DOM summary from the given frame.
   * Screenshots have been removed — the DOM summary provides all the
   * selector information needed and avoids token rate limits entirely.
   *
   * @private
   * @param {number} tabId
   * @param {number} [frameId=0]
   * @returns {Promise<{ dom: string }>}
   */
  static async #captureTab(tabId, frameId = TOP_FRAME_ID, full = false) {
    const snapshotType = full ? 'DOM_SNAPSHOT_FULL' : 'DOM_SNAPSHOT';
    let dom = '';
    try {
      const res = await TemplateWalker.#msg(tabId, { type: snapshotType }, frameId);
      dom = res?.snapshot ?? '<!-- empty snapshot -->';
    } catch (err) {
      Logger.warn('TemplateWalker', `${snapshotType} failed on frameId ${frameId}: ${err.message}`);
      if (frameId !== TOP_FRAME_ID) {
        try {
          const res = await TemplateWalker.#msg(tabId, { type: snapshotType }, TOP_FRAME_ID);
          dom = `<!-- iframe snapshot failed, top frame fallback -->\n${res?.snapshot ?? ''}`;
        } catch {
          dom = '<!-- DOM capture failed -->';
        }
      } else {
        dom = '<!-- DOM capture failed -->';
      }
    }
    return { dom };
  }

  // ── Private: Execution + observation ─────────────────────────────────────

  /**
   * Executes a step in the given frame and observes DOM mutation.
   *
   * @private
   * @param {number}        tabId
   * @param {ConfirmedStep} step
   * @param {number}        [frameId=0]
   * @returns {Promise<{ execResult: Object, domChanged: boolean }>}
   */
  static async #executeAndObserve(tabId, step, frameId = TOP_FRAME_ID) {
    // v2.29.1 — ENUMERATE joins the no-observe set: it reads the DOM to
    // count matches, doesn't mutate anything. No page transition expected.
    const noObserve = new Set(['NAVIGATE', 'WAIT', 'WAIT_FOR', 'EXTRACT', 'ENUMERATE', 'SELECT']);

    if (step.action === 'NAVIGATE') {
      const execResult = await TemplateWalker.#executeStep(tabId, step, TOP_FRAME_ID);
      await TemplateWalker.#waitForContentScript(tabId, TOP_FRAME_ID);
      return { execResult, domChanged: true };
    }

    if (noObserve.has(step.action)) {
      const execResult = await TemplateWalker.#executeStep(tabId, step, frameId);
      return { execResult, domChanged: true };
    }

    // Install observer in the active frame before action
    try {
      await TemplateWalker.#msg(tabId, { type: 'OBSERVE_START' }, frameId);
    } catch (err) {
      Logger.warn('TemplateWalker', `OBSERVE_START failed in frameId ${frameId}: ${err.message} — proceeding without observation`);
      const execResult = await TemplateWalker.#executeStep(tabId, step, frameId);
      return { execResult, domChanged: true };
    }

    const execResult = await TemplateWalker.#executeStep(tabId, step, frameId);

    // Poll for mutation
    const deadline = Date.now() + MUTATION_WAIT_MS;
    let domChanged = false;
    while (Date.now() < deadline) {
      await TemplateWalker.#sleep(MUTATION_POLL_MS);
      try {
        const res = await TemplateWalker.#msg(tabId, { type: 'OBSERVE_READ' }, frameId);
        if (res?.mutated) { domChanged = true; break; }
        await TemplateWalker.#msg(tabId, { type: 'OBSERVE_START' }, frameId).catch(() => {});
      } catch {
        break;
      }
    }

    try {
      const finalRes = await TemplateWalker.#msg(tabId, { type: 'OBSERVE_READ' }, frameId);
      if (finalRes?.mutated) domChanged = true;
    } catch { /* page may have navigated */ }

    return { execResult, domChanged };
  }

  /**
   * Executes a single step in the specified frame.
   *
   * @private
   * @param {number}        tabId
   * @param {ConfirmedStep} step
   * @param {number}        [frameId=0]
   * @returns {Promise<{ success: boolean, extractedValue?: string, error?: string }>}
   */
  /**
   * v2.74.163 — Resolve a frame id within a tab from a stored frame URL.
   *
   * Same-origin iframe support: at pick time the sidepanel writes
   * `step.frameUrl` whenever the picker captured an element inside an
   * iframe. Runtime then needs the current frameId for that iframe in
   * order to route the action via chrome.tabs.sendMessage's frameId
   * option. Frame ids aren't stable across page loads, so we re-resolve
   * each time.
   *
   * Match priority:
   *   1. Exact URL match.
   *   2. Origin match (handles iframes whose URL has session-specific
   *      query params or hash fragments that drifted since authoring).
   *   3. Fallback to top frame, with a warn-level log so the author can
   *      see the resolver missed in the Logs tab. The action will still
   *      run — just against the top document, which usually surfaces a
   *      "selector not found" error and forces a re-pick.
   *
   * @param {number} tabId
   * @param {string} [frameUrl] — null/empty means top frame
   * @returns {Promise<number>}
   * @private
   */
  static async _resolveFrameId(tabId, frameUrl) {
    if (!frameUrl) return TOP_FRAME_ID;
    let frames;
    try {
      frames = await new Promise((resolve) => {
        chrome.webNavigation.getAllFrames({ tabId }, (fs) => resolve(fs ?? []));
      });
    } catch (_) {
      return TOP_FRAME_ID;
    }
    if (!Array.isArray(frames) || frames.length === 0) return TOP_FRAME_ID;
    // Exact URL match.
    const exact = frames.find(f => f && f.url === frameUrl);
    if (exact) return exact.frameId;
    // Origin match — same iframe at a slightly different URL.
    let savedOrigin = null;
    try { savedOrigin = new URL(frameUrl).origin; } catch (_) { /* leave null */ }
    if (savedOrigin) {
      const origMatch = frames.find(f => {
        if (!f?.url) return false;
        try { return new URL(f.url).origin === savedOrigin; } catch { return false; }
      });
      if (origMatch) return origMatch.frameId;
    }
    Logger.warn('TemplateWalker', `frame not found for url="${frameUrl}" — falling back to top frame; action will likely fail with "element not found"`);
    return TOP_FRAME_ID;
  }

  /**
   * v2.74.310 — Phase 7 of ACTION_SPEC compliance. Structured per-action
   * execution trace (§ 6 step 8 / § 8 / § 13 req 8). Emits one trace
   * record per action execution carrying the spec's fields: timestamp,
   * kind, target, parameters, options, declared effect, observed effect,
   * outcome, resolution detail, timing.
   *
   * DEVIATION (documented in SPEC_DEV): traces are emitted to the Logger
   * (Logs tab) as structured INFO records, NOT persisted to a queryable
   * trace store with a Studio history view. The spec envisions Studio
   * history / criterion-evaluation consumers; those need a storage
   * subsystem this codebase doesn't have yet. Logger emission gives
   * observability now; persistent trace storage is future work.
   *
   * @private
   */
  static #emitActionTrace(step, frameId, res, observation, declaredEffect) {
    try {
      const desc = step._resolvedFromLandmark ?? null;
      const trace = {
        ts            : Date.now(),
        kind          : step.action,
        // target: landmark UID when resolved from a ref, else the raw
        // selector. Non-landmark actions (WAIT/NAVIGATE) have neither.
        target        : desc?.uid ?? (step.selector || null),
        targetSource  : step.landmarkRef ? 'landmark-ref' : (step.selector ? 'selector' : 'none'),
        // parameters: kind-specific. value covers TYPE/SELECT/KEY/WAIT;
        // landmark alias for context.
        value         : step.value ?? null,
        landmarkAlias : desc?.alias ?? null,
        frameId,
        // options
        smoothScroll  : step.smoothScroll === true,
        // effects (§ 5): declared (action.effect > landmark default) and
        // observed (when an observation window ran).
        declaredEffect: declaredEffect ?? null,
        observedEffect: observation?.observedEffect ?? null,
        observedInteractionPattern: observation?.observedInteractionPattern ?? null,
        // resolution detail
        resolvedSelector: step.selector || null,
        // timing
        observationMs : observation?.durationMs ?? null,
        // outcome
        outcome       : res?.success === true ? 'success' : 'failure',
        error         : res?.success === true ? null : (res?.error ?? null),
      };
      Logger.info('ActionTrace', `${trace.kind} → ${trace.outcome}`, trace);
    } catch (e) {
      // Trace emission must never break execution.
      Logger.debug?.('TemplateWalker', `action-trace emit failed: ${e.message}`);
    }
  }

  static async #executeStep(tabId, step, frameId = TOP_FRAME_ID) {
    try {
      // v2.74.236 — Wave 3 of the landmark SSOT project. If the step
      // carries a `landmarkRef`, resolve it to a concrete selector +
      // frameUrl before continuing. Mutates the step in place so the
      // rest of #executeStep sees normal step.selector / step.frameUrl.
      // Re-resolves frameId from the landmark's frameUrl when set —
      // a landmark in an iframe overrides whatever frame the caller
      // chose (the landmark IS the source of truth for the frame).
      //
      // v2.74.241 — Phase 3 of substrate spec: heuristic recovery.
      // After applyLandmarkRefToStep loads the cached selector, we
      // probe it against the live DOM. If it doesn't match a unique
      // visible element, the content script runs description-layer
      // recovery (role + accessibleName + hierarchicalContext) to
      // find a candidate, synthesizes a fresh selector, and returns
      // it. The landmark's lifecycle flips to `stale-suspected` on
      // recovery; `stale-confirmed` on full failure.
      if (step && (step.landmarkRef || step.landmark)) {
        if (step.landmarkRef) {
          try {
            await applyLandmarkRefToStep(step);
          } catch (e) {
            return { success: false, error: `Landmark ref resolution failed: ${e.message}` };
          }
        } else if (step.landmark && !step._resolvedFromLandmark) {
          // SG-LM-3 — INLINE proto-landmark (no saved registry uid): the SG trial/replay binds a
          // recoverable identity directly on the step instead of a stored landmarkRef. Stash its
          // description layer so the probe-or-recover block below self-heals a stale selector by
          // role + accessible name. uid is null, so the registry-persist + ground-event branches
          // (all guarded by `desc.uid`) safely no-op.
          const lm = step.landmark;
          step._resolvedFromLandmark = {
            uid: null,
            a11yRole: lm.role ?? null,
            accessibleName: lm.accessibleName ?? null,
            hierarchicalContext: lm.hierarchicalContext ?? null,
          };
          if (!step.selector && lm.selector) step.selector = lm.selector;
        }
        // v2.74.246 — Phase 7b of substrate spec: iframe context
        // routing. If the resolved landmark carries an iframeContext,
        // find its declaring perspective, evaluate the predicate against
        // the live DOM, and route to the matching iframe's frameId.
        // Falls back to the cached frameUrl path when no context is
        // declared or the lookup fails (legacy landmarks unchanged).
        //
        // Cross-origin iframes refuse landmark resolution per spec
        // § 6 with a structured `LandmarkResolutionRefusedError`-shaped
        // failure so calling workflows can catch and route.
        const desc0 = step._resolvedFromLandmark;
        const ctxName = desc0?.iframeContext;
        if (ctxName && desc0.uid) {
          try {
            let groundId;
            try {
              const lmRec = await StorageManager.getLandmark(desc0.uid);
              groundId = lmRec?.groundId;
            } catch { /* fall through */ }
            if (groundId) {
              // v2.74.247 — Phase 7c: pass runtime context (tabUrl)
              // so the context lookup narrows to ACTIVE perspectives per
              // their predicates. The lookup falls back to all
              // perspectives when the runtime context yields no active
              // matches — graceful degradation during the transition.
              let runtimeContext = null;
              try {
                const tabInfo = await chrome.tabs.get(tabId);
                runtimeContext = { tabUrl: tabInfo?.url ?? '', tabId };
              } catch { /* runtimeContext stays null */ }
              const ctxLookup = await findPerspectiveIframeContext(desc0.uid, ctxName, groundId, runtimeContext);
              if (ctxLookup?.context) {
                const predRes = await TemplateWalker.#msg(tabId, {
                  type: 'RESOLVE_IFRAME_BY_PREDICATE',
                  payload: { predicate: ctxLookup.context.predicate },
                }, TOP_FRAME_ID);
                if (predRes?.success) {
                  if (predRes.sameOrigin) {
                    if (predRes.src) {
                      step.frameUrl = predRes.src;
                    }
                  } else {
                    // v2.74.273 — Emit substrate event for cross-origin
                    // refusal so the events panel surfaces it. The
                    // landmark itself isn't broken — it's structurally
                    // unreachable due to browser security. Lifecycle
                    // unchanged. Distinct from cached-selector failure.
                    if (desc0.uid && desc0.groundId) {
                      emitGroundEvent(desc0.groundId, {
                        kind   : EVENT_KIND.LANDMARK_RESOLUTION_FAILED,
                        uid    : desc0.uid,
                        details: {
                          a11yRole      : desc0.a11yRole,
                          accessibleName: desc0.accessibleName,
                          reason        : 'cross-origin-iframe',
                          iframeContext : ctxName,
                          newLifecycle  : null,   // lifecycle NOT changed
                        },
                      }).catch(err => Logger.warn('TemplateWalker', `cross-origin event emit failed: ${err.message}`));
                    }
                    return {
                      success: false,
                      error: `LandmarkResolutionRefusedError: landmark "${desc0.accessibleName ?? desc0.alias ?? desc0.uid}" lives in cross-origin iframe context "${ctxName}"; browser security prevents content-script access`,
                      reason: 'cross-origin-iframe',
                    };
                  }
                } else if (predRes?.reason === 'iframe-absent') {
                  // v2.74.273 — Same emit pattern for absent iframe.
                  if (desc0.uid && desc0.groundId) {
                    emitGroundEvent(desc0.groundId, {
                      kind   : EVENT_KIND.LANDMARK_RESOLUTION_FAILED,
                      uid    : desc0.uid,
                      details: {
                        a11yRole      : desc0.a11yRole,
                        accessibleName: desc0.accessibleName,
                        reason        : 'iframe-absent',
                        iframeContext : ctxName,
                        newLifecycle  : null,
                      },
                    }).catch(err => Logger.warn('TemplateWalker', `iframe-absent event emit failed: ${err.message}`));
                  }
                  return {
                    success: false,
                    error: `IframeAbsentError: iframe predicate for context "${ctxName}" matched no iframes in current page`,
                    reason: 'iframe-absent',
                  };
                }
                // else: predicate evaluator failed in some other way;
                // fall through to legacy frameUrl handling.
              } else {
                Logger.warn('TemplateWalker', `iframeContext "${ctxName}" not declared in any perspective on ground ${groundId}; falling back to frameUrl`);
              }
            }
          } catch (e) {
            Logger.warn('TemplateWalker', `iframe context routing failed: ${e.message} (falling back to frameUrl)`);
          }
        }
        // Existing frameUrl-based frameId resolution. After Phase 7b's
        // iframe context routing, step.frameUrl carries the iframe's
        // CURRENT src (if applicable) — this resolution finds the
        // matching frameId via chrome.webNavigation.
        if (step.frameUrl) {
          frameId = await TemplateWalker._resolveFrameId(tabId, step.frameUrl);
        }
        // v2.74.275 — Legacy ref shape gone; log uid-only.
        Logger.info('TemplateWalker', `Resolved landmarkRef → "${step.selector}" in frame ${frameId} (landmark: ${desc0?.uid ?? step.landmarkRef?.uid ?? '?'}${ctxName ? `, iframeContext=${ctxName}` : ''})`);
        // Phase 3: probe + heuristic recovery. Only runs when there's
        // a description layer to fall back on (Phase 1 landmarks).
        const desc = step._resolvedFromLandmark;
        const hasDescLayer = !!(desc && desc.a11yRole && desc.accessibleName);
        if (hasDescLayer) {
          let probe;
          try {
            probe = await TemplateWalker.#msg(tabId, {
              type    : 'LANDMARK_PROBE_OR_RECOVER',
              payload : {
                selector : step.selector,
                fallback : {
                  role               : desc.a11yRole,
                  accessibleName     : desc.accessibleName,
                  hierarchicalContext: desc.hierarchicalContext,
                },
              },
            }, frameId);
          } catch (e) {
            // Probe dispatch failed — proceed with cached selector;
            // the action's own error path will surface a failure if
            // the selector is genuinely broken.
            Logger.warn('TemplateWalker', `landmark probe dispatch failed: ${e.message} (proceeding with cached selector)`);
          }
          if (probe?.via === 'heuristic') {
            const cached = step.selector;
            step.selector = probe.selector;
            // v2.74.270 — Match-method tracking. Recovery may have
            // used 'exact' / 'substring' / 'fuzzy' name match. Log
            // fuzzy matches at INFO with both names so authors can
            // trace name drift in the engine log too (in addition to
            // the substrate event below).
            const matchMethod = probe.matchMethod ?? 'unknown';
            if (matchMethod === 'fuzzy' || matchMethod === 'substring') {
              Logger.info('TemplateWalker',
                `Landmark heuristic recovery (${matchMethod}): "${cached}" → "${probe.selector}" ` +
                `[name "${probe.authoredName}" → "${probe.matchedName}", similarity ${(probe.nameSimilarity ?? 0).toFixed(2)}] (uid=${desc.uid ?? '?'})`);
            } else {
              Logger.info('TemplateWalker', `Landmark heuristic recovery (${matchMethod}): "${cached}" → "${probe.selector}" (uid=${desc.uid ?? '?'})`);
            }
            // v2.74.253 — Phase 9.1: persist recovered selector to the
            // landmark record so future runs skip the recovery cost.
            // Lifecycle stays stale-suspected (single observation; the
            // Phase 9 verifier provides the second observation that
            // promotes to verified). Spec-aligned per substrate's
            // three-layer model: "realization is replaceable while
            // identity stays stable." Decision recorded 2026-05-21.
            // v2.74.270 — When the match was fuzzy/substring, also
            // persist the new accessibleName so the next recovery
            // attempt finds the element via exact match (faster path,
            // and avoids re-flagging the same drift repeatedly).
            if (desc.uid) {
              const patch = {
                lifecycle      : 'stale-suspected',
                selector       : probe.selector,
                lastRecoveredTs: Date.now(),
              };
              if ((matchMethod === 'fuzzy' || matchMethod === 'substring') && probe.matchedName) {
                patch.accessibleName = probe.matchedName;
              }
              StorageManager.updateLandmark(desc.uid, patch)
                .catch(err => Logger.warn('TemplateWalker', `landmark recovery persist failed: ${err.message}`));
            }
            // v2.74.249 — Phase 8: emit substrate event so Studio (and
            // future drift-reactor) can surface the degraded resolution
            // without polling lifecycle state. Includes both the cached
            // (broken) selector and the heuristic replacement so
            // consumers can build a "before → after" UI without
            // re-deriving anything.
            if (desc.uid && desc.groundId) {
              emitGroundEvent(desc.groundId, {
                kind   : EVENT_KIND.LANDMARK_RESOLUTION_DEGRADED,
                uid    : desc.uid,
                details: {
                  cachedSelector  : cached,
                  recoveredSelector: probe.selector,
                  a11yRole        : desc.a11yRole,
                  accessibleName  : desc.accessibleName,
                  recoveryReason  : probe.reason ?? 'selector-miss',
                  newLifecycle    : 'stale-suspected',
                  // v2.74.270 — Match method + name drift for drift-
                  // tracking consumers. Authors see when fuzzy was
                  // needed (real signal that the page evolved).
                  matchMethod    : matchMethod,
                  authoredName   : probe.authoredName,
                  matchedName    : probe.matchedName,
                  nameSimilarity : probe.nameSimilarity,
                },
              }).catch(err => Logger.warn('TemplateWalker', `event emit failed: ${err.message}`));
            }
          } else if (probe && probe.success === false && probe.via === 'fail') {
            // Both selector + heuristic failed. Mark stale-confirmed
            // and return a structured error rather than letting the
            // action fail with a generic "no element" diagnostic.
            if (desc.uid) {
              StorageManager.updateLandmark(desc.uid, { lifecycle: 'stale-confirmed' })
                .catch(err => Logger.warn('TemplateWalker', `landmark lifecycle update failed: ${err.message}`));
            }
            // v2.74.249 — Phase 8: emit failure event. This is the
            // strongest "this landmark is broken" signal the substrate
            // produces — consumers should treat it as actionable
            // (re-author, replace, or remove).
            if (desc.uid && desc.groundId) {
              emitGroundEvent(desc.groundId, {
                kind   : EVENT_KIND.LANDMARK_RESOLUTION_FAILED,
                uid    : desc.uid,
                details: {
                  cachedSelector: step.selector,
                  a11yRole      : desc.a11yRole,
                  accessibleName: desc.accessibleName,
                  reason        : probe.error ?? probe.reason ?? 'unknown',
                  newLifecycle  : 'stale-confirmed',
                },
              }).catch(err => Logger.warn('TemplateWalker', `event emit failed: ${err.message}`));
            }
            return {
              success: false,
              error: `Landmark "${desc.accessibleName ?? desc.alias ?? desc.uid}" unresolvable: ${probe.error ?? probe.reason} (lifecycle: stale-confirmed)`,
            };
          }
        }
      }

      if (step.action === 'NAVIGATE') {
        await new Promise((resolve, reject) => {
          chrome.tabs.update(tabId, { url: step.value }, () => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            const listener = (tid, info) => {
              if (tid === tabId && info.status === 'complete') {
                chrome.tabs.onUpdated.removeListener(listener);
                setTimeout(resolve, 800);
              }
            };
            chrome.tabs.onUpdated.addListener(listener);
            setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, TAB_LOAD_TIMEOUT_MS);
          });
        });
        return { success: true };
      }

      if (step.action === 'WAIT') {
        await TemplateWalker.#sleep(Math.max(0, parseInt(step.value, 10) || 1000));
        return { success: true };
      }

      if (step.action === 'WAIT_FOR') {
        const timeoutMs = Math.max(1000, parseInt(step.value, 10) || 10000);
        const res = await TemplateWalker.#msg(tabId, {
          type    : 'WAIT_FOR_ELEM',
          payload : { selector: step.selector, timeoutMs },
        }, frameId);
        return res ?? { success: false, error: 'WAIT_FOR_ELEM returned no response' };
      }

      // v2.74.200 — WAIT_FOR_GONE: poll until selector disappears.
      // Reuses #waitForElementGone (the internal helper used by the
      // T2 page-settle gate) but as a first-class authorable action.
      // Maps to the "wait for loading indicator to vanish" pattern
      // critical for chat workflows: send message → wait for
      // streaming-in-progress indicator to disappear → extract reply.
      // Timeout in step.value (ms), default 30000.
      if (step.action === 'WAIT_FOR_GONE') {
        const timeoutMs = Math.max(1000, parseInt(step.value, 10) || 30000);
        const cleared = await TemplateWalker.#waitForElementGone(tabId, frameId, step.selector, timeoutMs);
        if (cleared) {
          return { success: true };
        }
        return {
          success: false,
          error  : `WAIT_FOR_GONE: "${(step.selector ?? '').slice(0, 120)}" still present after ${timeoutMs}ms`,
        };
      }

      // CLICK, TYPE, EXTRACT, FIND_AI, SCROLL_TO
      // v2.72.72 — SCROLL_TO actions can carry an optional smoothScroll
      // bool in rawJson; forwarded to content script for behavior:'smooth'.
      const dispatchAction = () => TemplateWalker.#msg(tabId, {
        type    : 'EXECUTE_STEP',
        payload : {
          action    : step.action,
          selector  : step.selector,
          value     : step.value,
          fromIndex : step.fromIndex ?? 0,
          aliases   : step.aliases ?? [],
          smoothScroll: step.smoothScroll === true,
          // v2.74.316 — KEY repeat count (sends the key N times).
          repeat    : step.repeat,
        },
      }, frameId);

      // v2.74.305 — Spec-aligned per ACTION_SPEC § 5 / § 8.
      // Observation triggers (same as v2.74.250):
      //   - step.observeEffect === true (explicit opt-in)
      //   - step._isTerminal === true (set by iterator on last step)
      //   - desc.effect.kind === 'triggers-navigation' (navigation-likely)
      // Pre-v2.74.305 read desc.proposedEffect (legacy string field);
      // now reads desc.effect (object {kind, form?, modalKind?}).
      const observableActions = new Set(['CLICK', 'CLICK_BY_LABEL', 'FIND_AI']);
      const descForObs = step._resolvedFromLandmark ?? null;
      // v2.74.306 — Phase 2 of ACTION_SPEC compliance. The Action's OWN
      // effect annotation (step.effect) is authoritative per § 5; the
      // landmark's effect is only a default that was copied onto the
      // action at link time. Precedence:
      //   1. step.effect            — the action's declared effect
      //   2. descForObs.effect      — the resolved landmark's default
      //   3. legacy proposedEffect  — transitional string fallback
      // This is what lets the same landmark carry different declared
      // effects in different fragments.
      const declaredEffect = (step.effect && step.effect.kind)
        ? step.effect
        : (descForObs?.effect
            ?? (descForObs?.proposedEffect ? { kind: descForObs.proposedEffect } : null));
      const wantsObs   = observableActions.has(step.action)
                        && shouldObserveStep(step, descForObs, step._isTerminal === true);
      if (!wantsObs) {
        const res = await dispatchAction();
        const out = res ?? { success: false, error: 'EXECUTE_STEP returned no response' };
        TemplateWalker.#emitActionTrace(step, frameId, out, null, declaredEffect);
        return out;
      }
      const { actionResult, observation } = await observeActionBracket(tabId, frameId, dispatchAction);
      const res = actionResult ?? { success: false, error: 'EXECUTE_STEP returned no response' };

      if (observation && descForObs?.uid && descForObs?.groundId) {
        // v2.74.305 — classifyEffectDrift returns severity string per
        // ACTION_SPEC § 8: 'expected-missing' | 'unexpected' |
        // 'parameter-mismatch' | null (match). isEffectDrift still works
        // as boolean back-compat.
        const driftSeverity = classifyEffectDrift(declaredEffect, observation.observedEffect);
        emitGroundEvent(descForObs.groundId, {
          kind   : EVENT_KIND.LANDMARK_EFFECT_OBSERVED,
          uid    : descForObs.uid,
          details: {
            action          : step.action,
            stepSuccess     : res.success === true,
            declaredEffect  : declaredEffect,
            observedEffect  : observation.observedEffect,
            observedInteractionPattern: observation.observedInteractionPattern ?? null,
            urlChanged      : observation.urlChanged,
            titleChanged    : observation.titleChanged,
            topLevelDelta   : observation.topLevelDelta,
            dialogDelta     : observation.dialogDelta,
            mutations       : observation.mutations,
            durationMs      : observation.durationMs ?? null,
            urlBefore       : observation.urlBefore,
            urlAfter        : observation.urlAfter,
            trigger         : step._isTerminal === true ? 'terminal'
                             : declaredEffect?.kind === 'triggers-navigation' ? 'navigation-likely'
                             : 'explicit-opt-in',
          },
        }).catch(err => Logger.warn('TemplateWalker', `effect-observed emit failed: ${err.message}`));

        if (driftSeverity) {
          emitGroundEvent(descForObs.groundId, {
            kind   : EVENT_KIND.LANDMARK_EFFECT_DRIFT,
            uid    : descForObs.uid,
            details: {
              declaredEffect: declaredEffect,
              observedEffect: observation.observedEffect,
              severity      : driftSeverity,
              action        : step.action,
              urlChanged    : observation.urlChanged,
            },
          }).catch(err => Logger.warn('TemplateWalker', `effect-drift emit failed: ${err.message}`));
        }
      }
      // v2.74.310 — Phase 7: structured execution trace (observed path).
      TemplateWalker.#emitActionTrace(step, frameId, res, observation, declaredEffect);
      return res;

    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ── Private: Local verdict ────────────────────────────────────────────────

  /**
   * Determines step verdict locally. Three layers applied for EXTRACT:
   *   Layer 1 — Sequence shape: CLICK → TYPE → CLICK must precede EXTRACT
   *   Layer 2 — Send busy gate: handled in walk loop before this call
   *   Layer 3 — Message count delta: ≥2 new messages since baseline
   *
   * @private
   * @param {number}   tabId
   * @param {number}   frameId
   * @param {ConfirmedStep} step
   * @param {{ success: boolean, extractedValue?: string, error?: string }} execResult
   * @param {boolean}  domChanged
   * @param {ConfirmedStep[]} confirmedSteps
   * @param {{ sendBusy: string|null, responseContainer: string|null }} anchors
   * @param {number}   baselineMessageCount
   * @returns {Promise<{ verdict: 'continue'|'retry'|'done'|'failed', message: string }>}
   */
  static async #localVerdict(tabId, frameId, step, execResult, domChanged, confirmedSteps = [], anchors = {}, baselineMessageCount = 0) {
    const { action } = step;

    if (action === 'EXTRACT') {
      const shape = TemplateWalker.#checkSequenceShape(confirmedSteps);
      if (!shape.valid) {
        Logger.warn('TemplateWalker', `EXTRACT rejected — Layer 1: ${shape.reason}`);
        return { verdict: 'retry', message: `Layer 1: ${shape.reason}` };
      }
      if (!execResult.success) {
        Logger.warn('TemplateWalker', `EXTRACT rejected — step failed: ${execResult.error}`);
        return { verdict: 'retry', message: execResult.error ?? 'EXTRACT failed' };
      }
      if (!execResult.extractedValue?.trim()) {
        Logger.warn('TemplateWalker', `EXTRACT rejected — empty value (selector: "${step.selector}")`);
        return { verdict: 'retry', message: 'EXTRACT matched element but text was empty' };
      }
      // Layer 3: message count delta — skip when generationIndicator was used,
      // since the indicator disappearing is already the completion signal.
      if (anchors.responseContainer && !anchors._indicatorUsed) {
        const currentCount = await TemplateWalker.#countElements(tabId, frameId, anchors.responseContainer);
        const delta        = currentCount - baselineMessageCount;
        Logger.info('TemplateWalker', `Layer 3: delta ${delta} (baseline:${baselineMessageCount} current:${currentCount})`);
        if (delta < 1) {
          Logger.warn('TemplateWalker', `EXTRACT rejected — Layer 3: delta ${delta} < 1, responseContainer="${anchors.responseContainer}"`);
          return { verdict: 'retry', message: `Layer 3: message delta ${delta} < 1 — no new message yet` };
        }
      }
      return { verdict: 'done', message: `Extracted ${execResult.extractedValue.length} chars (all layers passed)` };
    }

    if (action === 'NAVIGATE' || action === 'WAIT' || action === 'WAIT_FOR') {
      if (execResult.success) return { verdict: 'continue', message: `${action} completed` };
      return { verdict: 'retry', message: execResult.error ?? `${action} failed` };
    }

    if (execResult.success && domChanged) {
      return { verdict: 'continue', message: `${action} succeeded and DOM changed` };
    }

    if (execResult.success && !domChanged && action === 'CLICK') {
      // If TYPE was already confirmed, this is the send CLICK. The AI may have
      // started generating before the MutationObserver fired — no DOM change is
      // observed but the CLICK succeeded. Accept it as confirmed.
      const hasType = confirmedSteps.some(s => s.action === 'TYPE');
      if (hasType) {
        return { verdict: 'continue', message: 'CLICK succeeded after TYPE — send accepted even without DOM change' };
      }

      // Otherwise check if the clicked element is a rich-text editor focus
      try {
        const info    = await TemplateWalker.#msg(tabId, { type: 'CHECK_ELEMENT', payload: { selector: step.selector } }, frameId);
        const isEditor =
          info?.isContentEditable === true ||
          info?.role === 'textbox' ||
          info?.tagName === 'input' ||
          info?.tagName === 'textarea' ||
          (info?.dataTestId ?? '').toLowerCase().includes('input') ||
          (info?.dataTestId ?? '').toLowerCase().includes('editor') ||
          (info?.dataTestId ?? '').toLowerCase().includes('prose');
        if (isEditor) {
          return { verdict: 'continue', message: 'CLICK focused a rich-text editor — no DOM mutation expected' };
        }
      } catch (err) {
        Logger.warn('TemplateWalker', `CHECK_ELEMENT failed: ${err.message}`);
      }
      return { verdict: 'retry', message: 'CLICK executed but no DOM change observed — may need a different selector' };
    }

    if (execResult.success && !domChanged) {
      return { verdict: 'retry', message: `${action} executed but no DOM change observed` };
    }
    return { verdict: 'retry', message: execResult.error ?? `${action} failed` };
  }

  /**
   * Layer 1: state machine over confirmedSteps.
   * Required order: CLICK|FIND_AI → TYPE → CLICK → (EXTRACT ready)
   * NAVIGATE/WAIT/WAIT_FOR are transparent — they don't advance or reset state.
   *
   * @private
   * @param {ConfirmedStep[]} steps
   * @returns {{ valid: boolean, reason: string }}
   */
  static #checkSequenceShape(steps) {
    // Phase 2 starts after the panel is already open — the opening CLICK was
    // Phase 1's preamble and is not in confirmedSteps here.
    // Valid Phase 2 sequences:
    //   TYPE → CLICK → EXTRACT              (standard)
    //   CLICK → TYPE → CLICK → EXTRACT      (legacy — panel re-opened in Phase 2)
    // NAVIGATE / WAIT / WAIT_FOR are transparent.

    let state = 'idle';
    for (const s of steps) {
      const a = s.action;
      if (a === 'NAVIGATE' || a === 'WAIT' || a === 'WAIT_FOR') continue;

      if      (state === 'idle'   && a === 'TYPE')                        state = 'typed';
      else if (state === 'idle'   && (a === 'CLICK' || a === 'FIND_AI')) state = 'opened';
      else if (state === 'opened' && a === 'TYPE')                        state = 'typed';
      else if (state === 'typed'  && a === 'CLICK')                       state = 'sent';
    }
    if (state === 'idle')   return { valid: false, reason: 'No TYPE confirmed — question not typed' };
    if (state === 'opened') return { valid: false, reason: 'No TYPE confirmed after CLICK — question not typed' };
    if (state === 'typed')  return { valid: false, reason: 'No send CLICK confirmed after TYPE — question not submitted' };
    return { valid: true, reason: 'ok' };
  }

  // ── Private: Utilities ────────────────────────────────────────────────────

  /**
   * Opens a new focused tab and waits for the initial page load.
   * @private
   * @param {string} url
   * @returns {Promise<number>} tabId
   */
  static #openFocusedTab(url) {
    return new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        const timeout = setTimeout(() => {
          chrome.tabs.onUpdated.removeListener(listener);
          reject(new Error(`Tab load timeout after ${TAB_LOAD_TIMEOUT_MS}ms`));
        }, TAB_LOAD_TIMEOUT_MS);
        const listener = (tabId, changeInfo) => {
          if (tabId === tab.id && changeInfo.status === 'complete') {
            clearTimeout(timeout);
            chrome.tabs.onUpdated.removeListener(listener);
            setTimeout(() => resolve(tab.id), 1000);
          }
        };
        chrome.tabs.onUpdated.addListener(listener);
      });
    });
  }

  /** @private */
  static #broadcast(groundId, data) {
    chrome.runtime.sendMessage({ type: 'WALK_PROGRESS', payload: { groundId, ...data } }).catch(() => {});
  }

  /**
   * Layer 2 fallback: polls Claude to determine when the AI response is complete.
   * Phase 1 waits for count > baseline (new message appeared).
   * Phase 2 asks Claude via isResponseComplete whether generation has stopped.
   *
   * @private
   */
  static async #waitForStreamingComplete(tabId, frameId, selector, baseline, timeoutMs = 45000) {
    const POLL_MS            = 600;
    const STABLE_INTERVAL_MS = 1500;
    const deadline           = Date.now() + timeoutMs;

    // Phase 1: wait for new message — only reliable when starting from 0.
    // When baseline > 0 (existing conversation history), the new response may
    // stream into an existing container rather than creating a new sibling element,
    // making count delta unreliable. Skip Phase 1 and go straight to text stability.
    if (baseline === 0) {
      Logger.debug('TemplateWalker', `waitForStreamingComplete: waiting for new message (baseline: 0)`);
      while (Date.now() < deadline) {
        const count = await TemplateWalker.#countElements(tabId, frameId, selector);
        if (count > 0) break;
        await TemplateWalker.#sleep(POLL_MS);
      }
      if (Date.now() >= deadline) {
        Logger.warn('TemplateWalker', `waitForStreamingComplete: timeout waiting for new message`);
        return;
      }
    } else {
      // With existing history, wait 1.5s for streaming to begin before polling
      Logger.debug('TemplateWalker', `waitForStreamingComplete: existing history (baseline: ${baseline}) — skipping count phase`);
      await TemplateWalker.#sleep(1500);
    }

    // Phase 2: text stability
    let prevText = null;
    let stableAt = null;
    Logger.debug('TemplateWalker', `waitForStreamingComplete: waiting for text to stabilise`);
    while (Date.now() < deadline) {
      const res  = await TemplateWalker.#getLastElementText(tabId, frameId, selector);
      const text = res.text ?? '';
      if (text && text === prevText) {
        if (stableAt === null) stableAt = Date.now();
        if (Date.now() - stableAt >= STABLE_INTERVAL_MS) {
          Logger.debug('TemplateWalker', `waitForStreamingComplete: stable (${text.length} chars)`);
          return;
        }
      } else {
        prevText = text;
        stableAt = null;
      }
      await TemplateWalker.#sleep(POLL_MS);
    }
    Logger.warn('TemplateWalker', `waitForStreamingComplete: timeout`);
  }

  /**
   * Reads the innerText of the last visible element matching selector.
   * @private
   */
  static async #getLastElementText(tabId, frameId, selector) {
    try {
      const res = await TemplateWalker.#msg(tabId, {
        type: 'GET_LAST_ELEMENT_TEXT', payload: { selector },
      }, frameId);
      return { text: res?.text ?? '', count: res?.count ?? 0, found: res?.found ?? false };
    } catch {
      return { text: '', count: 0, found: false };
    }
  }

  /**
   * Layer 2: polls until the given selector is absent from the frame,
   * or until timeoutMs elapses. Used to wait for the AI to finish responding
   * (send button aria-disabled clears, spinner disappears, etc.).
   *
   * @private
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} selector
   * @param {number} [timeoutMs=30000]
   * @returns {Promise<void>}
   */
  /**
   * Checks whether a disabled send/submit button is currently visible in the frame.
   * Returns the selector string if found, null otherwise.
   * Used as a reliable generation-in-progress signal when no generationIndicator exists.
   * @private
   */
  static async #findDisabledSendButton(tabId, frameId) {
    const SEND_SELECTORS = [
      'button[data-test-id="chat-send-button"][disabled]',
      'button[data-testid="chat-send-button"][disabled]',
      'button[name="send"][disabled]',
      'button[aria-label*="send"][disabled]',
      'button[aria-label*="Send"][disabled]',
      'button[type="submit"][disabled]',
    ];
    for (const sel of SEND_SELECTORS) {
      try {
        const res = await TemplateWalker.#msg(tabId, {
          type   : 'COUNT_ELEMENTS',
          payload: { selector: sel },
        }, frameId);
        if ((res?.count ?? 0) > 0) {
          // Return the selector without [disabled] — we'll append it for the wait
          const base = sel.replace('[disabled]', '');
          Logger.debug('TemplateWalker', `findDisabledSendButton: found "${base}"`);
          return base;
        }
      } catch { /* try next */ }
    }
    return null;
  }

  static async #waitForNewText(tabId, frameId, selector, baseline, timeoutMs = 10000) {
    const POLL_MS = 200;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await TemplateWalker.#msg(tabId, {
          type   : 'EXECUTE_STEP',
          payload: { action: 'EXTRACT', selector, value: '', fromIndex: baseline },
        }, frameId);
        if (res?.success && (res.extractedValue?.trim()?.length ?? 0) > 5) {
          Logger.debug('TemplateWalker', `waitForNewText: response ready (${res.extractedValue.length} chars)`);
          return;
        }
      } catch { /* frame not ready */ }
      await TemplateWalker.#sleep(POLL_MS);
    }
    Logger.warn('TemplateWalker', `waitForNewText: timeout after ${timeoutMs}ms — proceeding`);
  }

  static async #waitForElementGone(tabId, frameId, selector, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await TemplateWalker.#msg(tabId, {
          type    : 'CHECK_ELEMENT',
          payload : { selector },
        }, frameId);
        if (!res?.found) {
          Logger.debug('TemplateWalker', `Layer 2: "${selector}" gone — proceeding`);
          return true;
        }
      } catch {
        return true; // Frame gone — treat as cleared
      }
      await TemplateWalker.#sleep(400);
    }
    Logger.warn('TemplateWalker', `Layer 2: "${selector}" still present after ${timeoutMs}ms — proceeding anyway`);
    return false;
  }

  /**
   * Layer 3: counts visible elements matching selector in the given frame,
   * piercing shadow DOM.
   *
   * @private
   * @param {number} tabId
   * @param {number} frameId
   * @param {string} selector
   * @returns {Promise<number>}
   */
  static async #countElements(tabId, frameId, selector) {
    try {
      const res = await TemplateWalker.#msg(tabId, {
        type    : 'COUNT_ELEMENTS',
        payload : { selector },
      }, frameId);
      return res?.count ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Returns the URL of a specific frame, stripping query string and hash
   * so the stored value is a stable prefix for matching at test time.
   *
   * @private
   * @param {number} tabId
   * @param {number} frameId
   * @returns {Promise<string|null>}
   */
  static async #getFrameUrl(tabId, frameId) {
    try {
      const frames = await new Promise(resolve => {
        chrome.webNavigation.getAllFrames({ tabId }, results => resolve(results ?? []));
      });
      const frame = frames.find(f => f.frameId === frameId);
      if (!frame?.url) return null;
      // Strip query string and hash — keep origin + path as stable prefix
      const u = new URL(frame.url);
      return u.origin + u.pathname;
    } catch {
      return null;
    }
  }

  /**
   * Replaces {{PARAM_NAME}} tokens in a TYPE/SELECT value with plausible filler
   * values so form validation passes during walk discovery.
   * The original token is preserved in confirmedSteps — only the executed value changes.
   * @private
   * @param {string} value - Step value potentially containing {{PARAM_NAME}} tokens.
   * @returns {string} Value with tokens replaced by format-valid filler strings.
   */
  static #fillParam(value) {
    return value.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, name) => {
      if (/ADDRESS|STREET|ADDR/.test(name))              return '4201 Roosevelt Way NE';
      if (/CITY/.test(name))                             return 'Seattle';
      if (/STATE|PROVINCE/.test(name))                   return 'WA';
      if (/ZIP|POSTAL/.test(name))                       return '98101';
      if (/EMAIL/.test(name))                            return 'test@example.com';
      if (/PHONE|TEL|FAX/.test(name))                    return '2065550100';
      if (/WEIGHT/.test(name))                           return '1';
      if (/AMOUNT|PRICE|COST|QTY|QUANTITY/.test(name))   return '1';
      if (/COUNTRY/.test(name))                          return 'US';
      if (/DATE/.test(name)) {
        const d = new Date();
        return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
      }
      if (/NAME|COMPANY|CONTACT|PERSON|RECIPIENT|SENDER/.test(name)) return 'Test Company';
      return 'Test Value';
    });
  }

  /** @private */
  static #sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
