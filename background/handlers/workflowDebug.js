// background/handlers/workflowDebug.js — CR-X3c (v2.74.953): the WORKFLOW + workflow-debugger domain,
// migrated whole from the background legacy switch: SAVE/DELETE/INVOKE/CANCEL/PAUSE/RESUME/STEP/
// STEP_OVER/SET+CLEAR+TOGGLE_BREAKPOINT/GET_WORKFLOW_BREAKPOINTS (12 case labels, 10 bodies), together with its
// state: the per-invocation cancellation set, the debug-state map (pause/step/step-over/breakpoints),
// the run-seq counter, and the two sidepanel broadcasts.
//
// The case bodies are BYTE-IDENTICAL to the legacy switch — they run inside a domain-local dispatcher
// (the tri-label breakpoint case branches on msg.type, which the registry doesn't pass; the `msg` shim
// preserves that without rewriting the body). The registry sees 12 thin keys. ctx supplies the two
// background-locals: invokeSgHandler (the CR-X3b bridge — the executor's runObservation/runCapability
// handoffs) and ensureContentScript. The keep-alive set is NOT here — invocation lifecycle is tracked
// globally by background's CapabilityAPI subscriber, exactly as before.
//
// Logger tags stay 'background' DELIBERATELY — trace/`gl` continuity.

import { Logger }           from '../../Core/Logger.js';
import { StorageManager }   from '../../Services/StorageManager.js';
import { executeWorkflow }  from '../../Services/WorkflowExecutor.js';
import { markEngineBusy, focusTabPolicy } from './sg.js';   // v2.74.967 (gl 114728) — monitor self-capture suppression; FM-1 (v2.74.968) — terminal courtesy focus
import { CapabilityAPI }    from '../../Services/CapabilityAPI.js';

// v2.74.953 (CR-X3c) — the workflow-debug ctx seam contract, asserted at wiring time.
const REQUIRED_CTX_KEYS = Object.freeze(['invokeSgHandler', 'ensureContentScript']);

/** Throw (at SW startup) if the seam object is missing any contract key. */
export function assertWorkflowDebugCtx(ctx) {
  const missing = REQUIRED_CTX_KEYS.filter((k) => typeof ctx?.[k] !== 'function');
  if (missing.length) throw new Error(`createWorkflowDebugHandlers: ctx is missing [${missing.join(', ')}]`);
  return ctx;
}

// v2.74.84 — Per-invocation cancellation set for Strategy runs dispatched
// through INVOKE_WORKFLOW. Studio populates this via CANCEL_WORKFLOW; the
// executor's isAborted closure polls membership between steps and in WAIT
// slices. Cleared on completion (success / failure / abort alike).
const _workflowCancellations = new Set();

// v2.74.91 — Per-invocation debug control map. Tracks both:
//   - paused: boolean, polled by the executor's isPaused closure between
//             steps and during PAUSE-step yields. Studio toggles via
//             PAUSE_WORKFLOW / RESUME_WORKFLOW; the executor flips it
//             true on its own when a PAUSE step executes.
//   - listenerInvocations: kept for symmetry with future fields (e.g.
//             breakpoints) — currently unused.
//
// Cancellation isn't moved into this map (yet) because the historical
// _workflowCancellations Set is referenced elsewhere; this map is purely
// additive for the debugger pass.
const _workflowDebugStates = new Map();

// v2.74.812 — short per-run id for the gl-trace START/FOOTER frame. A counter (not the scrubbed invocation UUID),
// so it stays legible in a shared trace. Resets on SW restart; timestamps disambiguate across restarts.
let _runSeq = 0;

function _getWorkflowDebugState(invId) {
  let s = _workflowDebugStates.get(invId);
  if (!s) {
    // v2.74.94 — stepRequested flag. STEP_WORKFLOW sets it; the executor
    // consumes it after the next step completes and re-pauses. RESUME
    // clears it so a Resume-after-Step semantically means "continue freely
    // from here" rather than "step once".
    // v2.74.95 — breakpoints: Set<number> of top-level step indices to
    // halt before. SET/CLEAR_BREAKPOINT_WORKFLOW mutate. Executor checks
    // isBreakpoint(stepIndex) before each top-level step runs.
    // v2.74.101 — stepOverPrefix: when set, consumeStepRequest only fires
    // in an executeSteps loop whose pathPrefix matches. Enables Step Over
    // semantics — Step Into has no prefix constraint and consumes at the
    // first step boundary at any depth (which for control-flow steps
    // descends into the body).
    s = { paused: false, stepRequested: false, stepOverPrefix: null, breakpoints: new Set() };
    _workflowDebugStates.set(invId, s);
  }
  return s;
}

function _broadcastWorkflowPauseState(invId, paused) {
  try {
    chrome.runtime.sendMessage({
      type: 'WORKFLOW_PAUSE_STATE',
      payload: { invocationId: invId, paused: !!paused },
    }, () => { void chrome.runtime.lastError; /* ignore "no receiver" */ });
  } catch (_) { /* ignore */ }
}

function _broadcastWorkflowBreakpoints(invId, set, workflowId) {
  try {
    chrome.runtime.sendMessage({
      type: 'WORKFLOW_BREAKPOINTS',
      // v2.74.99 — Carry BOTH ids so the sidepanel can filter on either.
      // Pre-invocation toggles broadcast with invocationId=null, only
      // workflowId set. Post-invocation toggles set both.
      payload: { invocationId: invId ?? null, workflowId: workflowId ?? null, breakpoints: [...set] },
    }, () => { void chrome.runtime.lastError; /* ignore */ });
  } catch (_) { /* ignore */ }
}

/**
 * @param {object} ctx  background-local helpers: { invokeSgHandler, ensureContentScript }
 * @returns {Record<string, (payload:object, sender:object, sendResponse:Function) => void>}
 */
export function createWorkflowDebugHandlers(ctx) {
  assertWorkflowDebugCtx(ctx);

  // The legacy case bodies, verbatim. `msg` is the shim the tri-label breakpoint case reads
  // (msg.type); `payload`/`sendResponse` close over the dispatch args exactly as they closed over
  // the onMessage listener's. Every case ends `return true` (async sendResponse) — meaningless
  // here but harmless, so the bodies stay byte-identical.
  function dispatch(type, payload, _sender, sendResponse) {
    const msg = { type, payload };
    void msg;   // (referenced only by the breakpoint case)
    switch (type) {
    // ╔══════════════════════════════════════════════════════════════════════╗
    // ║ v2.74.70 — WORKFLOW AUTHORING                                        ║
    // ╚══════════════════════════════════════════════════════════════════════╝
    //
    // Workflows are a new top-level entity (no parent Ground). Same broadcast
    // pattern as Strategies — saves emit STORAGE_CHANGED so any Studio tab
    // currently rendering a workflow list re-renders. CapabilityAPI is NOT
    // notified yet: Workflows aren't capability-eligible until the
    // composition layer lands (a Workflow's invocation surface is undefined
    // until steps[] is populated, which the form doesn't yet do).

    case 'SAVE_WORKFLOW': {
      (async () => {
        try {
          const { workflow } = payload;
          if (!workflow?.id) {
            sendResponse({ success: false, error: 'Workflow requires { id }' });
            return;
          }
          const saved = await StorageManager.saveWorkflow(workflow);
          broadcastStorageChanged('workflow', saved.id, 'saved');
          // v2.74.82 — Strategy entities are capabilities now; notify the
          // CapabilityAPI registry so chat suggestion cards refresh. Match
          // the pattern SAVE_STRATEGY uses for Workflow entities.
          CapabilityAPI.notifyRegistryChange('updated', saved.id);
          sendResponse({ success: true, workflow: saved });
        } catch (err) {
          Logger.error('background', `SAVE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    case 'DELETE_WORKFLOW': {
      (async () => {
        try {
          const { workflowId } = payload;
          await deleteRecordWithSync('workflow', workflowId, () => StorageManager.deleteWorkflow(workflowId));
          CapabilityAPI.notifyRegistryChange('removed', workflowId);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `DELETE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.76 — Top-level Strategy invocation. Loads the Strategy record,
    // resolves typed-input file params, walks its `steps` array through
    // the WorkflowExecutor. Progress events stream back through a per-tab
    // runtime message channel keyed by invocationId so the calling Studio
    // tab can render toasts as steps complete. The handler acks once with
    // the final summary; intermediate events are fire-and-forget broadcasts.
    //
    // v2.74.84 — Mid-run cancellation: each invocation's id is tracked in
    // a module-level Set when cancelled; the executor's isAborted closure
    // polls membership. Cleared on completion regardless of outcome.
    case 'INVOKE_WORKFLOW': {
      (async () => {
        try {
          // v2.74.158 — `debug` payload flag distinguishes Studio's
          // Debug (◐) invocation from the plain Run (▶) / chat-routed
          // invocation. The constructed envelope below sets `pauseMode`
          // accordingly so downstream runtime gates (the OBSERVATION
          // overlay in ExecutionEngine, the PAUSE-node guard, etc.)
          // can tell whether they're in a debug session. Defaults to
          // false (non-debug) to preserve old callers' behavior.
          const { workflowId, workflow: inlineWorkflow, paramValues, invocationId, debug: debugRun = false } = payload;
          // v2.74.810 — accept an INLINE workflow (run it WITHOUT persisting). The chat's preview Run passes the
          // workflow object directly so a one-off run doesn't leave a duplicate library record (only "Save for later"
          // persists). A saved workflowId still loads from storage (Studio ▶/Debug, breakpoints). Either way the
          // executor runs the workflow OBJECT; its steps dispatch already-saved capabilities, so the workflow record
          // itself needn't be stored to run.
          let workflow = (inlineWorkflow && typeof inlineWorkflow === 'object') ? inlineWorkflow : null;
          if (!workflow) {
            if (!workflowId) {
              sendResponse({ success: false, error: 'INVOKE_WORKFLOW requires workflowId or workflow' });
              return;
            }
            workflow = await StorageManager.getWorkflow(workflowId);
            if (!workflow) {
              sendResponse({ success: false, error: `Workflow not found: ${workflowId}` });
              return;
            }
          }
          const invId = invocationId
            ?? (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `winv-${Date.now()}`);

          // Stream progress via broadcast — the Studio listener filters by
          // invocationId. We don't await each send; it's a fire-and-forget
          // channel that the receiver is free to ignore.
          const onProgress = (event) => {
            try {
              chrome.runtime.sendMessage({
                type: 'WORKFLOW_PROGRESS',
                payload: { invocationId: invId, event },
              }, () => { void chrome.runtime.lastError; /* ignore "no receiver" */ });
            } catch (_) { /* ignore */ }
          };

          // v2.74.91 — Debug envelope. `paused` lives in
          // _workflowDebugStates; PAUSE_WORKFLOW / RESUME_WORKFLOW
          // toggle it; the executor polls isPaused() between every step.
          // requestPause is invoked by PAUSE step nodes to halt the run
          // without external action — flips paused true AND broadcasts so
          // Studio's UI reacts immediately.
          const debugState = _getWorkflowDebugState(invId);
          // v2.74.98 — Remember the Strategy id so SET/CLEAR/TOGGLE
          // breakpoint handlers can persist their changes against the
          // Strategy record (not the per-invocation throwaway state).
          debugState.workflowId = workflowId ?? null;

          // v2.74.98 — Load persisted breakpoints into the live set
          // BEFORE executor starts. Broadcast once after load so the
          // workflow-debug sidepanel (which mounts before this point)
          // sees the gutter dots immediately.
          // v2.74.810 — only for a SAVED workflowId; an inline (unsaved) Run has no persisted breakpoints.
          if (workflowId) {
            try {
              const saved = await StorageManager.getStrategyBreakpoints(workflowId);
              for (const idx of saved) debugState.breakpoints.add(idx);
              if (saved.length > 0) _broadcastWorkflowBreakpoints(invId, debugState.breakpoints, workflowId);
            } catch (e) {
              Logger.warn('background', `breakpoint load failed: ${e.message}`);
            }
          }

          const debug = {
            // v2.74.158 — pauseMode signal. `'off'` for non-debug runs
            // (plain Studio ▶ / chat invocations) so downstream gates
            // — notably the OBSERVATION overlay in ExecutionEngine —
            // can suppress debug-only side effects. `'after-node'`
            // when the caller marked the run as a debug session.
            pauseMode: debugRun ? 'after-node' : 'off',
            isPaused: () => debugState.paused,
            requestPause: () => {
              debugState.paused = true;
              _broadcastWorkflowPauseState(invId, true);
            },
            onPauseStateChange: (state) => {
              _broadcastWorkflowPauseState(invId, !!state.paused);
            },
            // v2.74.94 — Step-through. The executor calls this after every
            // step completes; if true, the executor immediately re-pauses
            // (via requestPause above) so the next step waits for another
            // Step / Resume click. Single-shot consumption — STEP_*_WORKFLOW
            // re-arms the flag each time the user clicks.
            //
            // v2.74.101 — Depth-aware. The executor passes its current
            // pathPrefix; if stepOverPrefix is set, consume only when
            // they match (Step Over semantics — runs control-flow steps
            // as a single unit). If stepOverPrefix is null, consume at
            // any depth (Step Into — first step boundary wins).
            consumeStepRequest: (pathPrefix) => {
              if (!debugState.stepRequested) return false;
              if (debugState.stepOverPrefix != null && debugState.stepOverPrefix !== (pathPrefix ?? '')) {
                return false;
              }
              debugState.stepRequested = false;
              debugState.stepOverPrefix = null;
              return true;
            },
            // v2.74.95 — Breakpoints. Executor calls before each step;
            // if true, the step pauses before running.
            // v2.74.100 — Path-keyed: argument is a dot-notation step
            // path (e.g. "2", "2.body.1", "3.branches.0.body.0"). Numeric
            // top-level indices coerce to strings naturally so legacy
            // top-level breakpoints work unchanged.
            isBreakpoint: (stepPath) => debugState.breakpoints.has(String(stepPath)),
          };

          // v2.74.812 — per-run START/FOOTER frame so a downloaded trace reads as a story: a short run-id brackets the
          // run; the resolve/bind/action/read lines in between belong to it. (run-id is a counter, not the scrubbed
          // invocation UUID, so it survives PII-scrub legibly.)
          const _runId = `r_${(++_runSeq).toString(36)}`;
          const _runT0 = Date.now();
          const _wfSteps = Array.isArray(workflow.steps) ? workflow.steps.length : 0;
          const _wfGrounds = Array.isArray(workflow.groundIds) ? workflow.groundIds.length : 0;
          Logger.info('background', `▶ RUN ${_runId} "${String(workflow.name || workflow.intent || 'workflow').slice(0, 60)}" (${_wfSteps} step${_wfSteps === 1 ? '' : 's'}${_wfGrounds ? `, ${_wfGrounds} ground${_wfGrounds === 1 ? '' : 's'}` : ''}${inlineWorkflow ? ', ephemeral' : ''})`);

          // v2.74.967 (gl 114728) — the .908 family's 4th emitter: REPLAY/.908, EXPLORE/.911 and
          // RUN_SG_TRIAL/.912 are busy-marked, but the workflow runner dispatches ExecutionEngine
          // DIRECTLY and the engine self-resolves its tab — so nothing marked it, and run 1's own
          // focus/type logged as INTERACTION hits while run 2 (via REPLAY) logged none, an A/B inside
          // one trace. The engine reports every tab it drives via onTabResolved; each stays marked
          // (refcounted, CR-M1 — overlap with a nested REPLAY/RUN_OBSERVATION mark is safe) until the
          // run settles in the finally below.
          const _busyTabs = new Set();
          const _markResolved = (tid) => { if (typeof tid === 'number' && !_busyTabs.has(tid)) { _busyTabs.add(tid); markEngineBusy(tid, true); } };
          try {
            const result = await executeWorkflow(workflow, paramValues ?? {}, {
              onProgress,
              invocationId: invId,
              isAborted: () => _workflowCancellations.has(invId),
              debug,
              onTabResolved: _markResolved,
              // v2.74.789 — In-SW capabilities a cross-Ground READ step needs but the executor
              // can't import (they close over the background storage ctx). RUN_OBSERVATION is the
              // observation-native READ; a SW→SW sendMessage wouldn't re-enter our own onMessage,
              // so we hand the handler in directly and bridge its sendResponse to a Promise (with
              // the same reject-safety net the registry dispatch uses).
              runObservation: (obsPayload) => ctx.invokeSgHandler('RUN_OBSERVATION', obsPayload),   // v2.74.950 (CR-X3b) — the one bridge
              // v2.74.792 — replay a cross-Ground READ's ANTECEDENT (the search) as the exact capability the chat ran
              // it through (REPLAY_SG_CAPABILITY), so a multi-fragment Strategy search works as the prerequisite, not
              // only a single-fragment one. Same in-SW handoff + reject-safety net as runObservation.
              runCapability: (capPayload) => ctx.invokeSgHandler('REPLAY_SG_CAPABILITY', capPayload),   // v2.74.950 (CR-X3b) — the one bridge
              ensureContentScript: ctx.ensureContentScript,   // heal a freshly-opened hop tab's content-script port before the read
              // v2.74.969 (gl 175931) — REPLAY-parity param seeding needs the sgCapability record's
              // demonstrated defaults; bridge the read like runObservation (same triple-id lookup
              // REPLAY itself uses since .833: own id OR dispatch strategyId/fragmentId).
              readCapability: async (groundId, dispatchId) => {
                const r = await ctx.invokeSgHandler('GET_SG_CAPABILITIES', { groundId });
                const caps = Array.isArray(r?.capabilities) ? r.capabilities : [];
                return caps.find((c) => c && (c.id === dispatchId || c.strategyId === dispatchId || c.fragmentId === dispatchId)) || null;
              },
            });
            // v2.74.812 — run FOOTER: outcome + step/error/duration. stepResults shape varies, so read defensively.
            const _sr = Array.isArray(result.results) ? result.results : (Array.isArray(result.stepResults) ? result.stepResults : null);
            const _ran = _sr ? _sr.length : _wfSteps;
            const _errs = _sr ? _sr.filter((r) => r && r.success === false).length : (result.success ? 0 : 1);
            Logger.info('background', `${result.success ? '✓' : '✗'} RUN ${_runId} — ${result.success ? 'ok' : (result.error ? String(result.error).slice(0, 80) : 'failed')} · ${_ran}/${_wfSteps} step(s) · ${_errs} error(s) · ${Date.now() - _runT0}ms`);
            // FM-1 (v2.74.968) — COURTESY focus at the run terminal: surface the last driven tab so the
            // user sees the result/failure state (no-op when they're already on it; the 'autoFocus'
            // setting governs — focusTabPolicy logs the FOCUS ▸ verdict either way).
            const _lastTab = [..._busyTabs].pop();
            if (typeof _lastTab === 'number') { try { await focusTabPolicy({ tabId: _lastTab, reason: result.success ? 'run-done' : 'run-failed' }); } catch { /* */ } }
            sendResponse({ success: !!result.success, invocationId: invId, ...result });
          } finally {
            // Always cleanup — leaving stale ids in either map would
            // silently poison the next invocation that recycles the id.
            for (const tid of _busyTabs) markEngineBusy(tid, false);   // v2.74.967 — release every driven tab (refcounted)
            _workflowCancellations.delete(invId);
            _workflowDebugStates.delete(invId);
          }
        } catch (err) {
          Logger.error('background', `INVOKE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.84 — Cancel an in-flight Strategy invocation. The id is added
    // to _workflowCancellations; the executor's next isAborted poll picks
    // it up (between steps and in WAIT slices). The original INVOKE_WORKFLOW
    // handler resolves with `{error: 'Aborted'}` shortly after and cleans
    // the set in its finally block.
    //
    // No-op (and success-true response) if the id isn't an active invocation:
    // it's possible the run completed before the cancel reached us, which
    // is fine — caller doesn't need to know the difference.
    case 'CANCEL_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'CANCEL_WORKFLOW requires invocationId' });
            return;
          }
          _workflowCancellations.add(invocationId);
          // v2.74.91 — Cancel-while-paused: also flip the pause flag off
          // so the executor's _yieldIfPaused loop wakes up immediately and
          // sees the abort, instead of waiting for the next 100ms poll
          // tick. (The yield loop checks isAborted on every iteration so
          // this is belt-and-suspenders.)
          const state = _workflowDebugStates.get(invocationId);
          if (state) {
            // v2.74.101 — Clear pending step requests so a cancel can't
            // accidentally re-pause the executor on its way out.
            state.stepRequested = false;
            state.stepOverPrefix = null;
            if (state.paused) {
              state.paused = false;
              _broadcastWorkflowPauseState(invocationId, false);
            }
          }
          Logger.info('background', `CANCEL_WORKFLOW queued for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `CANCEL_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.91 — Pause / resume control for in-flight Strategy invocations.
    // The executor's debug.isPaused() closure polls _workflowDebugStates;
    // these two handlers flip the flag and broadcast WORKFLOW_PAUSE_STATE
    // so Studio's UI swaps its ▶ / ■ / ⏸ buttons in real time.
    case 'PAUSE_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'PAUSE_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.paused = true;
          _broadcastWorkflowPauseState(invocationId, true);
          Logger.info('background', `PAUSE_WORKFLOW for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `PAUSE_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
    case 'RESUME_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'RESUME_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.paused = false;
          // v2.74.94 — Resume-after-Step semantically means "continue
          // freely from here". Clearing the flag prevents an immediate
          // re-pause after the next step completes.
          // v2.74.101 — Also clear Step Over's depth pin.
          state.stepRequested = false;
          state.stepOverPrefix = null;
          _broadcastWorkflowPauseState(invocationId, false);
          Logger.info('background', `RESUME_WORKFLOW for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `RESUME_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.94 — Step (advance one step, then re-pause). Sets the flag the
    // executor consumes after every step completes, unpauses so the
    // current yield loop exits, and broadcasts so the sidepanel UI flips
    // out of paused state until the next step boundary.
    case 'STEP_WORKFLOW': {
      (async () => {
        try {
          const { invocationId } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'STEP_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.stepRequested = true;
          // v2.74.101 — Step Into: no prefix constraint, so the first
          // step-boundary at any depth consumes the request.
          state.stepOverPrefix = null;
          state.paused = false;
          _broadcastWorkflowPauseState(invocationId, false);
          Logger.info('background', `STEP_WORKFLOW (into) for invocation ${invocationId}`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `STEP_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.101 — Step Over: run the current step as a single unit
    // (including all body iterations of a control-flow step) and pause
    // at the next sibling step at the same depth. Implementation pins
    // consumeStepRequest's matching pathPrefix to the parent of the
    // currently-paused step's path.
    case 'STEP_OVER_WORKFLOW': {
      (async () => {
        try {
          const { invocationId, stepPath } = payload;
          if (!invocationId) {
            sendResponse({ success: false, error: 'STEP_OVER_WORKFLOW requires invocationId' });
            return;
          }
          const state = _getWorkflowDebugState(invocationId);
          state.stepRequested = true;
          // Derive parent prefix from the paused step's path. For "2",
          // parent prefix is "" (top-level loop). For "2.body.1", parent
          // prefix is "2.body".
          const lastDot = typeof stepPath === 'string' ? stepPath.lastIndexOf('.') : -1;
          state.stepOverPrefix = lastDot >= 0 ? stepPath.slice(0, lastDot) : '';
          state.paused = false;
          _broadcastWorkflowPauseState(invocationId, false);
          Logger.info('background', `STEP_OVER_WORKFLOW for invocation ${invocationId} (prefix="${state.stepOverPrefix}")`);
          sendResponse({ success: true });
        } catch (err) {
          Logger.error('background', `STEP_OVER_WORKFLOW failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.95 — Breakpoint management. SET adds; CLEAR removes; TOGGLE
    // flips. Top-level step indices only in this pass (path-based
    // breakpoints for nested steps come later). All three broadcast
    // WORKFLOW_BREAKPOINTS so the sidepanel UI re-renders its indicators.
    case 'SET_BREAKPOINT_WORKFLOW':
    case 'CLEAR_BREAKPOINT_WORKFLOW':
    case 'TOGGLE_BREAKPOINT_WORKFLOW': {
      (async () => {
        try {
          // v2.74.100 — Path-based addressing. Accept `stepPath` (the
          // canonical form) or `stepIndex` (legacy top-level). Both
          // coerce to a string path that matches the executor's
          // isBreakpoint argument.
          const { invocationId, workflowId } = payload;
          let stepPath = payload?.stepPath;
          if (!stepPath && Number.isFinite(payload?.stepIndex)) {
            stepPath = String(payload.stepIndex);
          }
          if (typeof stepPath !== 'string' || !stepPath) {
            sendResponse({ success: false, error: 'breakpoint message requires stepPath' });
            return;
          }

          // v2.74.99 — Two paths:
          //   1. invocationId present → mutate the live debug state for
          //      the in-flight run; persist on the side so the next run
          //      starts with the same breakpoints.
          //   2. workflowId only → pre-invocation toggle. Mutates the
          //      persisted set directly without an active debug state.
          //
          // Both paths broadcast WORKFLOW_BREAKPOINTS so any open
          // workflow-debug sidepanel re-renders.

          if (invocationId) {
            const state = _getWorkflowDebugState(invocationId);
            if (msg.type === 'SET_BREAKPOINT_WORKFLOW')   state.breakpoints.add(stepPath);
            if (msg.type === 'CLEAR_BREAKPOINT_WORKFLOW') state.breakpoints.delete(stepPath);
            if (msg.type === 'TOGGLE_BREAKPOINT_WORKFLOW') {
              if (state.breakpoints.has(stepPath)) state.breakpoints.delete(stepPath);
              else                                 state.breakpoints.add(stepPath);
            }
            _broadcastWorkflowBreakpoints(invocationId, state.breakpoints, state.workflowId);
            if (state.workflowId) {
              try { await StorageManager.saveStrategyBreakpoints(state.workflowId, [...state.breakpoints]); }
              catch (e) { Logger.warn('background', `breakpoint persist failed: ${e.message}`); }
            }
            sendResponse({ success: true, breakpoints: [...state.breakpoints] });
            return;
          }

          if (workflowId) {
            // Pre-invocation path — load → mutate → save.
            const current = await StorageManager.getStrategyBreakpoints(workflowId);
            const set = new Set(current);
            if (msg.type === 'SET_BREAKPOINT_WORKFLOW')   set.add(stepPath);
            if (msg.type === 'CLEAR_BREAKPOINT_WORKFLOW') set.delete(stepPath);
            if (msg.type === 'TOGGLE_BREAKPOINT_WORKFLOW') {
              if (set.has(stepPath)) set.delete(stepPath);
              else                   set.add(stepPath);
            }
            await StorageManager.saveStrategyBreakpoints(workflowId, [...set]);
            _broadcastWorkflowBreakpoints(null, set, workflowId);
            sendResponse({ success: true, breakpoints: [...set] });
            return;
          }

          sendResponse({ success: false, error: 'breakpoint message requires { invocationId } OR { workflowId }' });
        } catch (err) {
          Logger.error('background', `${msg.type} failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }

    // v2.74.99 — Fetch persisted breakpoints for a Strategy. The
    // workflow-debug sidepanel calls this on mount so gutter dots paint
    // the saved breakpoints before any invocation runs.
    case 'GET_WORKFLOW_BREAKPOINTS': {
      (async () => {
        try {
          const { workflowId } = payload;
          if (!workflowId) {
            sendResponse({ success: false, error: 'GET_WORKFLOW_BREAKPOINTS requires workflowId' });
            return;
          }
          const list = await StorageManager.getStrategyBreakpoints(workflowId);
          sendResponse({ success: true, breakpoints: list });
        } catch (err) {
          Logger.error('background', `GET_WORKFLOW_BREAKPOINTS failed: ${err.message}`);
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
    }
      default:
        sendResponse({ success: false, error: `workflowDebug: unknown type ${type}` });
        return false;
    }
  }

  const h = (t) => (payload, sender, sendResponse) => { dispatch(t, payload, sender, sendResponse); };
  return {
    SAVE_WORKFLOW             : h('SAVE_WORKFLOW'),
    DELETE_WORKFLOW           : h('DELETE_WORKFLOW'),
    INVOKE_WORKFLOW           : h('INVOKE_WORKFLOW'),
    CANCEL_WORKFLOW           : h('CANCEL_WORKFLOW'),
    PAUSE_WORKFLOW            : h('PAUSE_WORKFLOW'),
    RESUME_WORKFLOW           : h('RESUME_WORKFLOW'),
    STEP_WORKFLOW             : h('STEP_WORKFLOW'),
    STEP_OVER_WORKFLOW        : h('STEP_OVER_WORKFLOW'),
    SET_BREAKPOINT_WORKFLOW   : h('SET_BREAKPOINT_WORKFLOW'),
    CLEAR_BREAKPOINT_WORKFLOW : h('CLEAR_BREAKPOINT_WORKFLOW'),
    TOGGLE_BREAKPOINT_WORKFLOW: h('TOGGLE_BREAKPOINT_WORKFLOW'),
    GET_WORKFLOW_BREAKPOINTS  : h('GET_WORKFLOW_BREAKPOINTS'),
  };
}
