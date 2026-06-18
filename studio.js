/**
 * @file studio.js
 * @description Agent HUB — Studio (authoring surface for Grounds, Fragments,
 * Strategies, and the top-level Workflow orchestrator). Manages accordion
 * grounds with inline questions, template generation status badges, runtime
 * question params, Anthropic template generation, and live results.
 *
 * Naming (since v2.74.142 — labels match storage kinds):
 *   - "Workflow"  : storage kind=`workflow`, top-level orchestrator. The
 *                   Studio "Workflows" tab is its authoring surface.
 *   - "Strategy"  : storage kind=`strategy`, per-Ground fragment tree.
 *                   Authored from the Ground card's "+ Strategy" button.
 *
 */

import { installGlobalErrorHandlers } from './Core/ErrorCapture.js';
import { isDerivationStale, effectiveDescription } from './Core/groundDerivation.js';
import { siteMapCapabilities, matchSiteCapabilities } from './Core/siteMap.js';   // v2.74.465/467 — site capability catalog + intent match
import { layoutLocaleGraph } from './Core/graphLayout.js';   // v2.74.478 — pure layered layout for the Locale graph viz
// v2.74.188 — Install global error + unhandledrejection handlers BEFORE
// any other module-init runs, so an error in a downstream import is
// still captured by the Logger and surfaces in the Logs tab.
installGlobalErrorHandlers('studio', window);

import { StorageManager }         from './Services/StorageManager.js';
import { ConversationStore }      from './Services/ConversationStore.js';   // v2.74.1015 — Grab Chat export
import { ChatAPI }                from './Services/ChatAPI.js';
import { normalizeStrategyBody, validateStrategyBody, countExecutableNodes, normalizeStrategyParams, INPUT_TYPES, FILE_PARSERS } from './Services/StrategyTree.js';
import { promptForParams } from './Services/ParamForm.js';
import { CONDITION_FIELDS, emptyCondition, validateAssertion, getFamily, effectiveFamilies } from './Services/Assertion.js';
import {
  DATA_CONDITION_TYPES, DATA_CONDITION_FIELDS,
  emptyDataCondition, describeDataCondition, validateDataConditionList,
} from './Services/DataAssertion.js';
import { BUILTIN_ANALYSES, isBuiltinAnalysisId, getBuiltinAnalysis } from './Services/BuiltinAnalyses.js';
import { parseTemplate, collectTemplateReferences } from './Services/TemplateEngine.js';
import { uid, $, qs, qsa, escHtml, escAttr, relTime, toast, broadcastStorageChanged, openSidepanelHere } from './shared.js';
import { recordMetaFromPath, conflictTierForPath } from './Services/Storage/StoragePaths.js';
import { composeDescriptions } from './Services/FragmentDescription.js';
// v2.72.45 (Pass 17g iter) — Perspective form removed entirely. Perspective authoring
// now happens in the debugger sidepanel. Studio retains: the Ground card's
// "+ Perspective" button (calls launchPerspectiveCapture in this file), the perspective
// row's delete button (deletePerspective from this module), and the
// condition-editor surface (perspective_ref dropdown handling).
import { deletePerspective, setupPerspectiveForm } from './Studio/PerspectiveForm.js';
// v2.72.33 (Pass 17c) — Assertion form extracted. Studio.js retains the
// Ground card's assertion library section rendering and the
// assertion_ref dropdown handling.
import { openAssertionForm, deleteAssertion, setupAssertionForm } from './Studio/AssertionForm.js';
// v2.72.34 (Pass 17d) — Observation form (and live-page picker) extracted.
// Studio.js retains the Ground card's Observation library section,
// renderConditionEditor (which handles 'observation' context), and the
// Fragment → Observation migration tool. detectObservationParams is
// imported so the JSON-modal validator and migration tool can compute
// params on Observation records they construct.
import {
  openObservationForm,
  closeObservationForm,
  setupObservationForm,
  detectObservationParams,
  validateObservationRecord,
} from './Studio/ObservationForm.js';
// v2.72.35 (Pass 17e) — Analysis form extracted. Studio.js retains the
// Ground card's Analysis library section.
import {
  openAnalysisForm,
  deleteAnalysis,
  setupAnalysisForm,
} from './Studio/AnalysisForm.js';
// v2.72.36 (Pass 17f) — Review panel + EXTRACT/ENUMERATE/EMIT inline
// forms live in Studio/FragmentForm.js. The Ground card's Fragment row
// rendering uses editFragment / rewalkFragment / deleteFragment via the
// imports below. The migration tool (still in studio.js) calls
// showFragmentReviewPanel to open the review panel on a built fragment.
// v2.74.22 — Fragment form (and openFragmentForm), AI-walked (T3) path,
// in-Studio walk panel, FRAGMENT_WALK_* runtime dispatcher all removed.
// + Fragment opens the sidepanel author mode directly (mirrors +
// Observation); T1 cache is the only authoring path.
import {
  editFragment,
  rewalkFragment,
  enhanceFragment,
  deleteFragment,
  showFragmentReviewPanel,
  dropFragmentDraft,
  setupFragmentForm,
} from './Studio/FragmentForm.js';
// v2.72.83 (Pass 1) — Strategy-form extraction. Pure helpers and
// reference counters move to Studio/StrategyForm.js. Form lifecycle
// + state caches stay in studio.js until Pass 2. setupStrategyForm
// will accept injected helpers when Pass 2+ moves rendering code.
// v2.73.2 (Pass 4-f Phase 2 — Pass 4 complete) — StrategyForm now fully
// owns its state and handlers. Studio.js's remaining strategy responsibility:
//   - call into form lifecycle (openStrategyForm/editStrategy) when ground
//     accordion buttons fire
//   - call deleteStrategy/testRunStrategy for the Edit/Test/Delete buttons
//   - report ref-counts on Fragment/Observation deletion via
//     countStrategyRefsTo{Fragment,Observation}
//   - run setupStrategyForm({...}) + the three init calls during page init
import {
  countStrategyRefsToFragment,
  countStrategyRefsToObservation,
  deleteStrategy,
  testRunStrategy,
  openStrategyForm,
  editStrategy,
  wireStrategyTopLevelInputs,
  wireStrategySaveHandler,
  setupStrategyForm,
} from './Studio/StrategyForm.js';

// _relTime is the name used throughout this file; alias to the shared relTime
const _relTime = relTime;

// ─── Tab switching ────────────────────────────────────────────────────────────

qsa('.tab-btn').forEach((btn) => {
  // The Chat switch button has no data-tab — handled separately below
  if (!btn.dataset.tab) return;
  btn.addEventListener('click', () => {
    qsa('.tab-btn').forEach((b) => b.classList.remove('active'));
    qsa('.tab-panel').forEach((p) => { p.classList.remove('active'); p.classList.add('hidden'); });
    btn.classList.add('active');
    const panel = $(`tab-${btn.dataset.tab}`);
    panel.classList.remove('hidden');
    panel.classList.add('active');
    if (btn.dataset.tab === 'settings')  refreshSettings();
    if (btn.dataset.tab === 'logs')      { refreshLogs(); btn.removeAttribute('data-has-alert'); btn.dataset.badge = '0'; }
    if (btn.dataset.tab === 'resolveperf') renderResolvePerf();
    if (btn.dataset.tab === 'llm')         renderLlmAudit();
    if (btn.dataset.tab === 'sharing')     refreshSharing();
    _setSharingPoll(btn.dataset.tab === 'sharing');
    // v2.74.69 — Workflows tab is a derived view: every visit re-reads
    // strategies + grounds so newly-authored content shows up without a
    // full Studio reload.
    if (btn.dataset.tab === 'workflows') refreshWorkflows();
  });
});

// 15s team-ground poll boost (DD-04): while the Sharing tab is open, drive faster syncs than the
// 1-minute background alarm (MV3 alarms can't fire sub-minute, so Studio drives it). Cleared the
// moment the user navigates away.
let _sharingPollTimer = null;
function _setSharingPoll(active) {
  if (_sharingPollTimer) { clearInterval(_sharingPollTimer); _sharingPollTimer = null; }
  if (active) {
    _sharingPollTimer = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'RUN_SYNC' }, () => void chrome.runtime.lastError);
    }, 15000);
  }
}

// ─── v2.74.69 — Workflows tab ───────────────────────────────────────────────
//
// Cross-Ground Strategy catalog. The tab is a derived view over
// StorageManager.getAllStrategies() + getAllGrounds(); there's no new entity
// kind to manage. Rows expose the same actions as the Ground card's strategy
// rows (run / edit / json / delete) so authors can act on a Strategy without
// first navigating to its Ground.
//
// State lives in module-local _workflowsState (filter inputs + last-fetched
// caches). Filter changes only re-render — they don't re-query storage. A
// re-query happens on tab activation and on STORAGE_CHANGED.
//
// Filter behavior:
//   - search:    matches name, goal, and aliases (case-insensitive substring)
//   - ground:    exact match on parent Ground id
//   - tier:      'cache' | 'frontier' from implementations[0].tier (default cache)

const _workflowsState = {
  strategies : [],            // last fetched, normalized
  grounds    : new Map(),     // groundId → {name, url}
  workflows  : [],            // v2.74.70 — Workflow entities
  // v2.74.74 — Analysis catalog (user-authored + builtins). Step pickers
  // on the Strategy form consume this. Keyed flat — Ground attribution
  // surfaces in the dropdown label, not in the storage shape.
  analyses   : [],
  filter     : { search: '', groundId: '', tier: '' },
  // v2.74.70 — in-flight Workflow form draft. null when the form is closed.
  // Editing an existing workflow seeds {id, name, description, ...}; creating
  // new starts from a fresh draft with a freshly-minted id.
  workflowDraft : null,
  // v2.74.84 — Strategy → in-flight invocationId map for mid-run cancel.
  // Populated at the start of testRunWorkflow, cleared on completion.
  // The entity-list renderer reads this to decide whether to show ▶ or
  // ■ on each row's run button.
  runningInvocations: new Map(),
  // invocationId → bool. Populated by the WORKFLOW_PAUSE_STATE listener;
  // the renderer reads this to flip the pause / resume buttons on the
  // row. Keyed by invocationId (not workflowId) because the pause-state
  // message arrives with the invocation id.
  pausedInvocations: new Map(),
  wired      : false,         // setupWorkflowsTab idempotency guard
};

function setupWorkflowsTab() {
  if (_workflowsState.wired) return;
  _workflowsState.wired = true;

  const onFilterChange = () => {
    _workflowsState.filter.search   = $('workflows-search').value.trim().toLowerCase();
    _workflowsState.filter.groundId = $('workflows-filter-ground').value;
    _workflowsState.filter.tier     = $('workflows-filter-tier').value;
    renderWorkflows();
  };

  $('workflows-search')?.addEventListener('input', onFilterChange);
  $('workflows-filter-ground')?.addEventListener('change', onFilterChange);
  $('workflows-filter-tier')?.addEventListener('change', onFilterChange);

  // v2.74.70 — Workflow form lifecycle.
  $('btn-add-workflow')?.addEventListener('click', () => openWorkflowForm());
  $('btn-cancel-workflow')?.addEventListener('click', () => closeWorkflowForm());
  $('btn-save-workflow')?.addEventListener('click', () => saveWorkflowDraft());

  // v2.74.72 — Typed inputs editor wiring (moved from the Workflow form).
  // + Add appends an empty file-typed row (the most common reason to open
  // the editor). Per-row changes / remove are delegated on the list so
  // we don't rebuild listeners on every rerender.
  $('btn-add-workflow-input')?.addEventListener('click', () => {
    const draft = _workflowsState.workflowDraft;
    if (!draft) return;
    if (!Array.isArray(draft.declaredInputs)) draft.declaredInputs = [];
    draft.declaredInputs.push({
      name: '', type: 'file', kind: 'scalar', required: true, accept: '', parse: 'auto',
    });
    renderWorkflowInputsEditor();
    const list = $('workflow-inputs-list');
    const inputs = list?.querySelectorAll('.strategy-input-name');
    inputs?.[inputs.length - 1]?.focus();
  });

  // Live-edit handler. Mutates the draft in place but does NOT rerender on
  // every keystroke — that would steal focus mid-typing. The save path
  // re-reads the draft state at submit time.
  $('workflow-inputs-list')?.addEventListener('input', (e) => {
    const t = e.target;
    if (!t.dataset?.field) return;
    const draft = _workflowsState.workflowDraft;
    const idx = parseInt(t.dataset.idx, 10);
    const row = draft?.declaredInputs?.[idx];
    if (!row) return;
    const field = t.dataset.field;

    if (field === 'required') {
      row.required = !!t.checked;
    } else if (field === 'default' && row.type === 'number') {
      row.default = t.value === '' ? undefined : Number(t.value);
    } else if (field === 'default') {
      if (t.value === '') delete row.default; else row.default = t.value;
    } else {
      row[field] = t.value;
    }
  });

  // change fires on blur for text/number inputs and on selection for
  // <select>. Type-switch rerenders the editor to swap file ↔ default
  // sub-rows; name-blur is handled lazily by the save path.
  $('workflow-inputs-list')?.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.dataset?.field) return;
    const draft = _workflowsState.workflowDraft;
    const idx = parseInt(t.dataset.idx, 10);
    const row = draft?.declaredInputs?.[idx];
    if (!row) return;

    if (t.dataset.field === 'type') {
      const newType = t.value;
      row.type = newType;
      if (newType === 'file') {
        delete row.default;
        if (typeof row.accept !== 'string') row.accept = '';
        if (typeof row.parse  !== 'string') row.parse  = 'auto';
      } else {
        delete row.accept;
        delete row.parse;
      }
      renderWorkflowInputsEditor();
    }
  });

  $('workflow-inputs-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.strategy-input-remove');
    if (!btn) return;
    const draft = _workflowsState.workflowDraft;
    const idx = parseInt(btn.dataset.idx, 10);
    if (!draft?.declaredInputs || Number.isNaN(idx)) return;
    draft.declaredInputs.splice(idx, 1);
    renderWorkflowInputsEditor();
  });

  // ── v2.74.73 — Strategy step body wiring ─────────────────────────────────
  //
  // Each + button appends a typed step record to draft.steps and re-renders
  // the cards. v2.74.87 — factory extracted to _makeStrategyStep so the
  // FOREACH-body + buttons (and future DETECT / LOOP / TRY body + buttons)
  // share the same shape constants.
  $('btn-add-strategy-workflow') ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('workflow')));
  $('btn-add-strategy-analysis') ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('analysis')));
  $('btn-add-strategy-foreach2') ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('foreach')));
  $('btn-add-strategy-wait2')    ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('wait')));
  $('btn-add-strategy-detect2')  ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('detect')));
  $('btn-add-strategy-loop2')    ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('loop')));
  $('btn-add-strategy-try2')     ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('try')));
  $('btn-add-strategy-pause2')   ?.addEventListener('click', () => _appendStrategyStep(_makeStrategyStep('pause')));

  // v2.74.87 — All step-body handlers now resolve targets via data-path
  // instead of flat data-idx so nested control-flow bodies (FOREACH today,
  // DETECT / LOOP / TRY in follow-up passes) share the same plumbing.
  // _resolveStep returns {parentArray, idx, step} which covers both
  // "splice me out" (remove) and "mutate fields on me" (edit) cases.

  // Delegated click on the steps list:
  //   remove-strategy-step     → splice this step out of its parent array
  //   add-body-step            → push a fresh step onto a control-flow
  //                              body identified by data-parent-path +
  //                              data-step-kind (v2.74.87)
  $('workflow-steps-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const draft = _workflowsState.workflowDraft;
    if (!draft) return;
    const action = btn.dataset.action;

    if (action === 'remove-strategy-step') {
      const ref = _resolveStep(draft, btn.dataset.path);
      if (!ref?.parentArray) return;
      ref.parentArray.splice(ref.idx, 1);
      renderStrategyStepsList();
    }
    else if (action === 'add-body-step') {
      // v2.74.88 — data-body-path points DIRECTLY at the body array,
      // not the parent step. That uniformly handles every body slot:
      // FOREACH body, TRY body/recovery, DETECT default, DETECT
      // branches[K].body, and arbitrarily nested combinations.
      const bodyPath = btn.dataset.bodyPath;
      const kind = btn.dataset.stepKind;
      const body = _resolveBody(draft, bodyPath);
      if (!body) return;
      const fresh = _makeStrategyStep(kind);
      if (!fresh) return;
      body.push(fresh);
      renderStrategyStepsList();
    }
    // v2.74.89 — DETECT branch operations.
    else if (action === 'add-detect-branch') {
      const ref = _resolveStep(draft, btn.dataset.path);
      const step = ref?.step;
      if (!step || step.type !== 'detect') return;
      if (!Array.isArray(step.branches)) step.branches = [];
      step.branches.push({ condition: { type: 'binding_is_list', binding: '' }, body: [] });
      renderStrategyStepsList();
    }
    else if (action === 'remove-detect-branch') {
      const ref = _resolveStep(draft, btn.dataset.path);
      const step = ref?.step;
      if (!step || step.type !== 'detect') return;
      const bIdx = parseInt(btn.dataset.branchIdx, 10);
      if (!Number.isFinite(bIdx) || !step.branches?.[bIdx]) return;
      step.branches.splice(bIdx, 1);
      renderStrategyStepsList();
    }
  });

  // change on a <select> / blur on inputs. Path-resolves the target step
  // (or condition) lazily so we can handle both data-path (step-targeted)
  // and data-condition-path (condition-editor) controls in one listener.
  $('workflow-steps-list')?.addEventListener('change', (e) => {
    const t = e.target;
    const action = t.dataset?.action;
    if (!action) return;
    const draft = _workflowsState.workflowDraft;
    if (!draft) return;

    // v2.74.90 — Condition editor type-picker. Resolves a condition by
    // its dot-path and rewrites its shape in place.
    if (action === 'set-condition-type') {
      const cond = _resolveCondition(draft, t.dataset.conditionPath);
      if (!cond) return;
      _setConditionType(cond, t.value);
      renderStrategyStepsList();
      return;
    }

    // All remaining change actions target a step by data-path.
    const ref = _resolveStep(draft, t.dataset.path);
    const step = ref?.step;
    if (!step) return;

    if (action === 'set-workflow-id') {
      step.workflowId = t.value;
      step.paramBindings = {};
      renderStrategyStepsList();
    } else if (action === 'set-analysis-id') {
      step.analysisId = t.value;
      step.paramBindings = {};
      // v2.74.134 — When picking an Analysis whose body kind doesn't
      // use `source` / `output` on the SIEVE node (template, transform),
      // clear those fields so the persisted step record doesn't carry
      // orphan values. Runtime ignores them either way, but stale data
      // would surface in the JSON modal and confuse authors.
      const picked = _workflowsState.analyses.find(a => a.id === step.analysisId);
      const pickedBodyKind = picked?.implementations?.[0]?.body?.kind ?? null;
      if (pickedBodyKind === 'transform') {
        delete step.source;
        delete step.output;
      } else if (pickedBodyKind === 'template') {
        delete step.source;
      }
      renderStrategyStepsList();
    }
    else if (action === 'set-binding-kind') {
      const paramName = t.dataset.param;
      if (!paramName) return;
      const newKind = t.value;
      if (!step.paramBindings) step.paramBindings = {};
      step.paramBindings[paramName] = newKind === 'literal'
        ? { kind: 'literal', value: '' }
        : { kind: newKind, name: '' };
      renderStrategyStepsList();
    }
    else if (action === 'set-binding-value' && t.tagName === 'SELECT') {
      const paramName = t.dataset.param;
      if (!paramName) return;
      if (!step.paramBindings) step.paramBindings = {};
      const existing = step.paramBindings[paramName] ?? { kind: 'strategy_param' };
      step.paramBindings[paramName] = { ...existing, name: t.value };
    }
    // v2.74.89 — WAIT mode flip. Reset the orthogonal-shape fields so the
    // saved record doesn't carry a stale durationMs when the user switches
    // to condition mode (and vice versa).
    else if (action === 'set-wait-mode') {
      const newMode = t.value === 'condition' ? 'condition' : 'duration';
      step.mode = newMode;
      if (newMode === 'duration') {
        if (!Number.isFinite(step.durationMs)) step.durationMs = 500;
        delete step.condition;
        delete step.timeoutMs;
        delete step.pollIntervalMs;
      } else {
        // Condition mode — seed with a scope-binding shape since
        // Strategy-tier WAIT only supports scope conditions (no tab).
        if (!step.condition || typeof step.condition !== 'object') {
          step.condition = { type: 'binding_is_list', binding: '' };
        }
        if (!Number.isFinite(step.timeoutMs))      step.timeoutMs = 5000;
        if (!Number.isFinite(step.pollIntervalMs)) step.pollIntervalMs = 200;
        delete step.durationMs;
      }
      renderStrategyStepsList();
    }
  });

  // Live-edit on text inputs — mutates draft without rerender so focus
  // survives keystrokes.
  $('workflow-steps-list')?.addEventListener('input', (e) => {
    const t = e.target;
    const action = t.dataset?.action;
    if (!action) return;
    const draft = _workflowsState.workflowDraft;
    if (!draft) return;

    // v2.74.90 — Condition-field live edit. Walks data-condition-path to
    // the condition object and mutates the named field. No rerender —
    // the input keeps focus across keystrokes.
    if (action === 'set-condition-field') {
      const cond = _resolveCondition(draft, t.dataset.conditionPath);
      if (!cond) return;
      const field = t.dataset.conditionField;
      if (field) cond[field] = t.value;
      return;
    }

    const ref = _resolveStep(draft, t.dataset.path);
    const step = ref?.step;
    if (!step) return;

    if (action === 'set-analysis-source')        step.source = t.value;
    else if (action === 'set-analysis-output')   step.output = t.value;
    // v2.74.87 — FOREACH `over` / `as` inline edits.
    else if (action === 'set-foreach-over')      step.over = t.value;
    else if (action === 'set-foreach-as')        step.as   = t.value;
    // v2.74.88 — LOOP iteration cap. Coerce to a finite positive int;
    // values < 1 or non-numeric fall back to the default 100 at runtime.
    else if (action === 'set-loop-max') {
      const n = parseInt(t.value, 10);
      step.maxIterations = Number.isFinite(n) && n > 0 ? n : 100;
    }
    // v2.74.89 — WAIT duration. Non-negative integer milliseconds; empty
    // input clamps to 0 so the field doesn't disappear into NaN.
    else if (action === 'set-wait-duration') {
      const n = parseInt(t.value, 10);
      step.durationMs = Number.isFinite(n) && n >= 0 ? n : 0;
    }
    // v2.74.75 — text-input binding value. Kind dictates the field:
    // literal → `.value`; iteration_variable → `.name`. We read the kind
    // off the sibling dropdown rather than the binding so a kind-switch-
    // mid-typing doesn't write to the wrong field.
    else if (action === 'set-binding-value' && t.tagName === 'INPUT') {
      const paramName = t.dataset.param;
      if (!paramName) return;
      const row = t.closest('.strategy-step-binding-row');
      const kindSel = row?.querySelector('.strategy-step-binding-kind');
      const kind = kindSel?.value ?? 'literal';
      if (!step.paramBindings) step.paramBindings = {};
      const existing = step.paramBindings[paramName] ?? { kind };
      if (kind === 'literal') {
        step.paramBindings[paramName] = { kind: 'literal', value: t.value };
      } else {
        step.paramBindings[paramName] = { ...existing, kind, name: t.value };
      }
    }
  });
}

// ── v2.74.73 — Strategy step body helpers ────────────────────────────────
//
// Appends a step record onto the draft and triggers a rerender. Used by
// every + Add button on the Strategy form. Each step record is built from
// the shape constants in the button-handler closures so the storage layer
// always sees a consistent shape; the JSON modal can edit the inner fields
// after save.
function _appendStrategyStep(step) {
  const draft = _workflowsState.workflowDraft;
  if (!draft || !step) return;
  if (!Array.isArray(draft.steps)) draft.steps = [];
  draft.steps.push(step);
  renderStrategyStepsList();
}

// v2.74.87 — Single source of truth for the empty-step shape per type.
// Used by both top-level + buttons and the nested FOREACH-body + buttons
// so a future schema bump (e.g. defaulting `loop.maxIterations` to a
// different cap) lands in one place.
function _makeStrategyStep(kind) {
  switch (kind) {
    case 'workflow':  return { type: 'workflow', workflowId: '', paramBindings: {} };
    case 'analysis':  return { type: 'analysis', analysisId: '', source: '', output: '', paramBindings: {} };
    case 'foreach':   return { type: 'foreach', over: '', as: '', body: [] };
    case 'wait':      return { type: 'wait', mode: 'duration', durationMs: 500 };
    case 'detect':    return {
      type: 'detect',
      branches: [{ condition: { type: 'binding_is_list', binding: '' }, body: [] }],
      default : [],
    };
    case 'loop':      return {
      type: 'loop',
      condition: { type: 'binding_is_list', binding: '' },
      body: [],
      maxIterations: 100,
    };
    case 'try':       return { type: 'try', body: [], recovery: [] };
    case 'pause':     return { type: 'pause' };
    default: return null;
  }
}

// ── v2.74.87 — Path-based step addressing ──────────────────────────────────
//
// Strategy step body got recursive: FOREACH (and eventually DETECT / LOOP /
// TRY) now has its own nested body of steps. To address any step in the
// tree from a flat data-* attribute on a DOM control, we use dot-notation
// paths into the draft:
//
//   "2"                  → draft.steps[2]
//   "2.body.0"           → draft.steps[2].body[0]      (FOREACH body)
//   "2.body.0.body.1"    → FOREACH inside FOREACH
//   "2.branches.0.body"  → DETECT branch body (future)
//   "2.recovery"         → TRY recovery body  (future)
//
// _resolveStep returns {parentArray, idx, step}. _resolveBody returns the
// body array at a parent step's "body" / "default" / "recovery" / branches
// slot — used by + buttons inside a control-flow card to know which array
// to push onto. Both tolerate missing intermediate fields by lazily
// creating arrays when needed.

function _resolveStep(draft, path) {
  if (!draft || typeof path !== 'string' || path === '') return null;
  const parts = path.split('.');
  let array = draft.steps;
  let idx = NaN;
  let step = null;
  for (let i = 0; i < parts.length; i++) {
    idx = parseInt(parts[i], 10);
    if (!Array.isArray(array) || !Number.isFinite(idx) || !array[idx]) return null;
    step = array[idx];

    // If there are more parts, they describe a child-body slot of `step`.
    if (i + 1 < parts.length) {
      const field = parts[++i];
      // DETECT branches form: "branches.N.body|condition" — parse the
      // branch idx + sub-field together. (Not exercised in v2.74.87 yet
      // but plumbed for future passes.)
      if (field === 'branches' && i + 1 < parts.length) {
        const bIdx = parseInt(parts[++i], 10);
        if (!Number.isFinite(bIdx) || !step.branches?.[bIdx]) return null;
        // v2.74.104 — Require an explicit 'body' sub-field. Conditions
        // are objects, not step arrays — they're addressed via
        // _resolveCondition, not here. A path that terminates at
        // `branches.K` (no sub) used to return a confusing tuple with
        // a stale outer idx; bail out cleanly instead.
        if (i + 1 >= parts.length) return null;
        const sub = parts[++i];
        if (sub !== 'body') return null;
        if (!Array.isArray(step.branches[bIdx].body)) step.branches[bIdx].body = [];
        array = step.branches[bIdx].body;
      } else {
        // Plain body slot: 'body', 'default', 'recovery'.
        if (!Array.isArray(step[field])) step[field] = [];
        array = step[field];
      }
      step = null;
    }
  }
  return { parentArray: array, idx, step };
}

// v2.74.90 — Walk to a condition object inside the draft. Used by the
// inline condition editor (LOOP / DETECT branch / WAIT-condition); the
// returned object is mutated in place by the field/type handlers.
//
// Examples:
//   "0.condition"               → LOOP / WAIT condition
//   "0.branches.1.condition"    → DETECT branch condition
//   "0.body.1.condition"        → nested LOOP inside a FOREACH body
//
// Doesn't lazy-create — if any intermediate field is missing, returns null
// and the caller drops the edit (the renderer should already have seeded
// a default-shape condition via _makeStrategyStep / the add-branch handler).
function _resolveCondition(draft, condPath) {
  if (!draft || typeof condPath !== 'string' || !condPath) return null;
  const parts = condPath.split('.');
  let cur = draft.steps;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      if (!Number.isFinite(idx) || !cur[idx]) return null;
      cur = cur[idx];
    } else if (cur && typeof cur === 'object') {
      if (cur[part] == null) return null;
      cur = cur[part];
    } else {
      return null;
    }
  }
  return (cur && typeof cur === 'object') ? cur : null;
}

// v2.74.90 — Rewrite a condition's shape to the new type in place. Keeps
// field values that the new type still uses (e.g. swapping
// `binding_is_list` ↔ `binding_is_record` preserves `binding`), drops
// fields the new type doesn't declare, and fills new fields with '' so
// the editor's inputs always have a place to bind.
function _setConditionType(condObj, newType) {
  const newFields = DATA_CONDITION_FIELDS[newType]?.fields ?? [];
  const oldFields = Object.keys(condObj).filter(k => k !== 'type');
  for (const k of oldFields) if (!newFields.includes(k)) delete condObj[k];
  for (const f of newFields) if (condObj[f] === undefined) condObj[f] = '';
  condObj.type = newType;
}

function _resolveBody(draft, bodyPath) {
  // v2.74.88 — bodyPath is a path that walks straight to a body array:
  //
  //   ""                        → draft.steps   (top-level body)
  //   "0.body"                  → FOREACH body
  //   "0.recovery"              → TRY recovery body
  //   "0.default"               → DETECT default body
  //   "0.branches.1.body"       → DETECT branch body
  //   "0.body.1.body"           → FOREACH body inside FOREACH body
  //
  // The walker alternates between integer (array index) and string
  // (object field) segments, lazily creating `body`/`recovery`/`default`
  // arrays when missing so the first + click on an unauthored body
  // works without explicit init.
  if (!bodyPath) return draft.steps;
  const parts = bodyPath.split('.');
  let cur = draft.steps;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (Array.isArray(cur)) {
      const idx = parseInt(part, 10);
      if (!Number.isFinite(idx) || !cur[idx]) return null;
      cur = cur[idx];
    } else if (cur && typeof cur === 'object') {
      if (cur[part] == null) {
        // Lazy-create well-known body slots.
        if (part === 'body' || part === 'recovery' || part === 'default') cur[part] = [];
        else return null;
      }
      cur = cur[part];
    } else {
      return null;
    }
  }
  return Array.isArray(cur) ? cur : null;
}

// Renders read-only summary cards for each step. The summary picks the
// most identifying fields for that step type so authors can see at a glance
// what's there without opening JSON.
function renderStrategyStepsList() {
  const list = $('workflow-steps-list');
  const draft = _workflowsState.workflowDraft;
  if (!list || !draft) return;

  // v2.74.105 — Defensive reset: if a re-render fires mid-drag (e.g. a
  // STORAGE_CHANGED event during a drag), the source card is removed from
  // the DOM before its dragend can fire, leaving _strategyStepDragSourceIdx
  // stuck non-null. Subsequent dragovers/drops would then think a drag is
  // in flight on the new card set. Clearing at the top of every render
  // collapses that window — the next dragstart sets it fresh.
  _strategyStepDragSourceIdx = null;

  const steps = Array.isArray(draft.steps) ? draft.steps : [];

  if (steps.length === 0) {
    list.innerHTML = '<div class="strategy-steps-empty">No steps yet. Use the buttons below to add Workflow or Analysis invocations, plus control flow.</div>';
    return;
  }

  // v2.74.87 — Step cards now address themselves via dot-notation paths
  // ("2", "2.body.0", …) rather than flat indices so nested control-flow
  // bodies share one renderer and one set of handlers.
  list.innerHTML = steps.map((s, idx) => _renderStrategyStepCard(s, String(idx))).join('');
  _wireStrategyStepDrag(list);
}

// v2.74.86 — Drag-to-reorder for Strategy steps. Same pattern the Workflow
// form uses for its body cards: explicit handle (⋮⋮) arms the card on
// mousedown; dragover computes drop-before / drop-after; drop splices the
// draft.steps array and rerenders.
//
// Why not generic on-list dragstart? Because dragging on the picker
// dropdowns or text inputs inside a card would steal the drag; arming via
// the handle makes the rest of the card surface inert to dragging.
let _strategyStepDragSourceIdx = null;

function _wireStrategyStepDrag(listEl) {
  // v2.74.87 — Reordering is top-level only for now. Nested cards inside
  // a FOREACH body don't get drag handlers wired; reorder within a body
  // is a future pass. The :scope > selector restricts to direct children
  // of #workflow-steps-list, skipping cards rendered inside foreach bodies.
  listEl.querySelectorAll(':scope > .strategy-step-card').forEach((card) => {
    const handle = card.querySelector('[data-drag-handle]');
    if (!handle) return;
    // The path on a top-level card is a single-segment string ("0", "1", …);
    // parseInt yields the index directly. Nested cards (multi-segment) are
    // filtered out by the :scope > selector above.
    const pathToIdx = () => parseInt(card.dataset.path, 10);

    handle.addEventListener('mousedown', () => { card.draggable = true; });
    card.addEventListener('mouseup',    () => { setTimeout(() => { card.draggable = false; }, 0); });
    card.addEventListener('mouseleave', () => { if (!card.classList.contains('dragging')) card.draggable = false; });

    card.addEventListener('dragstart', (e) => {
      if (!card.draggable) { e.preventDefault(); return; }
      const idx = pathToIdx();
      if (Number.isNaN(idx)) { e.preventDefault(); return; }
      _strategyStepDragSourceIdx = idx;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', String(idx)); } catch (_) { /* noop */ }
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.draggable = false;
      _strategyStepDragSourceIdx = null;
      listEl.querySelectorAll(':scope > .strategy-step-card').forEach(c => c.classList.remove('drop-before', 'drop-after'));
    });
    card.addEventListener('dragover', (e) => {
      if (_strategyStepDragSourceIdx === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetIdx = pathToIdx();
      if (targetIdx === _strategyStepDragSourceIdx) return;
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isAbove = e.clientY < midY;
      card.classList.toggle('drop-before',  isAbove);
      card.classList.toggle('drop-after', !isAbove);
    });
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('drop-before', 'drop-after');
      }
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (_strategyStepDragSourceIdx === null) return;
      const targetIdx = pathToIdx();
      if (targetIdx === _strategyStepDragSourceIdx) return;
      const dropBefore = card.classList.contains('drop-before');
      let insertAt = dropBefore ? targetIdx : targetIdx + 1;
      if (_strategyStepDragSourceIdx < insertAt) insertAt -= 1;

      const draft = _workflowsState.workflowDraft;
      if (!draft?.steps) return;
      const [moved] = draft.steps.splice(_strategyStepDragSourceIdx, 1);
      draft.steps.splice(insertAt, 0, moved);
      renderStrategyStepsList();
    });
  });
}

function _renderStrategyStepCard(step, path) {
  // Derive a display number from the LAST path segment (top-level: "2" →
  // step 3; body: "2.body.0" → 1; nested-body: "2.body.0.body.1" → 2).
  const lastPart = path.split('.').pop();
  const stepNum = (parseInt(lastPart, 10) || 0) + 1;
  const type = step?.type ?? '(unknown)';

  // Workflow + Analysis + FOREACH + LOOP + TRY get inline editors.
  // DETECT and the rest still rely on the JSON modal until follow-up
  // passes land branch-array editing.
  if (type === 'workflow')  return _renderStrategyWorkflowStepCard(step, path, stepNum);
  if (type === 'analysis')  return _renderStrategyAnalysisStepCard(step, path, stepNum);
  if (type === 'foreach')   return _renderStrategyForeachStepCard(step, path, stepNum);
  if (type === 'loop')      return _renderStrategyLoopStepCard(step, path, stepNum);
  if (type === 'try')       return _renderStrategyTryStepCard(step, path, stepNum);
  if (type === 'wait')      return _renderStrategyWaitStepCard(step, path, stepNum);
  if (type === 'detect')    return _renderStrategyDetectStepCard(step, path, stepNum);

  let summary = '';
  switch (type) {
    // v2.74.88 — `loop` / `try` retired from this read-only switch.
    // v2.74.89 — `wait` / `detect` likewise. PAUSE is the only step type
    // left here; the default branch catches truly unknown shapes.
    case 'pause':
      summary = `<span class="strategy-step-label">PAUSE</span> <span class="strategy-step-meta">halt until user resumes</span>`;
      break;
    default:
      summary = `<span class="strategy-step-label">${escHtml(type)}</span> <span class="strategy-step-meta">unknown step type</span>`;
  }

  return `
    <div class="strategy-step-card" data-path="${escAttr(path)}">
      <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
      <span class="strategy-step-num">${stepNum}</span>
      <div class="strategy-step-body">${summary}</div>
      <div class="strategy-step-actions">
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
    </div>`;
}

// v2.74.74 — Inline-editable Workflow step card.
//
// Renders a picker dropdown grouping all Workflows by parent Ground. On
// pick → step.workflowId is set and the card re-renders, surfacing the
// chosen Workflow's params as read-only binding chips (the binding-kind
// editor is a future pass). Until a Workflow is picked, the chip strip is
// hidden and a small hint nudges the user to pick one.
function _renderStrategyWorkflowStepCard(step, path, stepNum) {
  const wid = step.workflowId ?? '';
  const chosen = wid ? _workflowsState.strategies.find(s => s.id === wid) : null;

  // Group Workflows by Ground for the dropdown — authors usually look up
  // by site context first. Sort grounds by name, workflows by name.
  const byGround = new Map();
  for (const wf of _workflowsState.strategies) {
    const gid = wf.groundId;
    if (!byGround.has(gid)) byGround.set(gid, []);
    byGround.get(gid).push(wf);
  }
  const groundEntries = [..._workflowsState.grounds.values()]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const options = groundEntries.map(g => {
    const wfs = (byGround.get(g.id) ?? []).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    if (wfs.length === 0) return '';
    const opts = wfs.map(w =>
      `<option value="${escAttr(w.id)}"${w.id === wid ? ' selected' : ''}>${escHtml(w.name ?? '(unnamed)')}</option>`
    ).join('');
    return `<optgroup label="${escAttr(g.name ?? g.id)}">${opts}</optgroup>`;
  }).join('');

  // v2.74.75 — Binding rows replace the read-only chip strip. Each row is
  // an inline mini-form (name + kind picker + value control) so authors
  // can wire params without dropping into JSON for the common case.
  const params = chosen?.params ?? [];
  const bindings = step.paramBindings ?? {};
  const bindingHtml = params.length === 0
    ? ''
    : _renderBindingRows(path, params, bindings);

  const hint = chosen
    ? ''
    : '<span class="strategy-step-hint">Pick a Workflow to bind params.</span>';

  // No-workflows case — emit a helpful empty option rather than a silent select.
  const emptyOpt = _workflowsState.strategies.length === 0
    ? '<option value="" disabled selected>No Workflows authored yet</option>'
    : (wid ? '' : '<option value="" disabled selected>— pick a Workflow —</option>');

  return `
    <div class="strategy-step-card strategy-step-card-editable" data-path="${escAttr(path)}" data-step-type="workflow">
      <div class="strategy-step-row-top">
        <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
        <span class="strategy-step-num">${stepNum}</span>
        <span class="strategy-step-label">Workflow</span>
        <select class="strategy-step-picker" data-action="set-workflow-id" data-path="${escAttr(path)}">
          ${emptyOpt}
          ${options}
        </select>
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
      ${bindingHtml || hint ? `<div class="strategy-step-row-sub strategy-step-row-sub-stack">${bindingHtml}${hint}</div>` : ''}
    </div>`;
}

// v2.74.74 — Inline-editable Analysis step card.
//
// Same picker pattern as Workflow steps, plus two text inputs for `source`
// (the upstream list-binding name this analysis consumes) and `output` (the
// scope name to write the analysis result into). Builtin analyses appear
// in their own optgroup at the top of the picker.
function _renderStrategyAnalysisStepCard(step, path, stepNum) {
  const aid = step.analysisId ?? '';
  const chosen = aid ? _workflowsState.analyses.find(a => a.id === aid) : null;

  // Split builtins from user analyses; group user analyses by Ground.
  const builtins = _workflowsState.analyses.filter(a => a._builtin);
  const userByGround = new Map();
  for (const a of _workflowsState.analyses) {
    if (a._builtin) continue;
    const gid = a.groundId;
    if (!userByGround.has(gid)) userByGround.set(gid, []);
    userByGround.get(gid).push(a);
  }

  const builtinOpts = builtins.length === 0 ? '' : `<optgroup label="Builtin">${
    builtins.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '')).map(a =>
      `<option value="${escAttr(a.id)}"${a.id === aid ? ' selected' : ''}>${escHtml(a.name ?? a.id)}</option>`
    ).join('')
  }</optgroup>`;

  const groundEntries = [..._workflowsState.grounds.values()]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  const userOpts = groundEntries.map(g => {
    const list = (userByGround.get(g.id) ?? []).sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    if (list.length === 0) return '';
    const opts = list.map(a =>
      `<option value="${escAttr(a.id)}"${a.id === aid ? ' selected' : ''}>${escHtml(a.name ?? a.id)}</option>`
    ).join('');
    return `<optgroup label="${escAttr(g.name ?? g.id)}">${opts}</optgroup>`;
  }).join('');

  const emptyOpt = !aid ? '<option value="" disabled selected>— pick an Analysis —</option>' : '';

  // v2.74.75 — Binding rows for any params declared by the chosen Analysis.
  // Builtins typically take INPUT (the list to operate on) as their sole
  // formal param, but template-kind analyses (Pass 7b) take whatever the
  // template references. Render rows when at least one is declared.
  const params = chosen?.params ?? [];
  const bindings = step.paramBindings ?? {};
  const bindingHtml = params.length === 0
    ? ''
    : _renderBindingRows(path, params, bindings);

  // v2.74.134 — Body-kind-aware wiring section.
  //
  // The pre-v2.74.134 form unconditionally showed two text inputs
  // (`source` and `output`) regardless of which Analysis was picked.
  // That's wrong for both template-body Analyses (which read declared
  // named inputs from scope, never `node.source`) and transform-body
  // Analyses (which use NEITHER `node.source` NOR `node.output` —
  // everything wires by declared name).
  //
  // Now: branch on the picked Analysis's body kind.
  //   - operations / frontier / unpicked: show source + output (the
  //     existing single-binding wiring the operations-body needs).
  //   - template: hide source (unused by runtime); show output (the
  //     destination binding for the rendered document).
  //   - transform: hide both; surface the Analysis's declared
  //     inputs/outputs as read-only chips so the strategy author can
  //     see what scope bindings the step expects to read / produce.
  const bodyKind = chosen?.implementations?.[0]?.body?.kind ?? null;
  const declaredInputs  = chosen?.implementations?.[0]?.body?.inputs  ?? [];
  const declaredOutputs = chosen?.implementations?.[0]?.body?.outputs ?? [];

  let wiringHtml;
  if (bodyKind === 'transform') {
    // v2.74.135 — Render declared inputs/outputs as READ-ONLY field rows
    // matching the editable-card visual style. The chip-based design from
    // v2.74.134 was too visually distinct; authors prefer seeing the
    // wiring laid out in the same form-row shape as operations-body
    // source/output. Labels say "input" / "output" (not "source") to
    // match the Analysis's declaration vocabulary — the transform body
    // is multi-input by design, so "source" (singular) would mislead.
    //
    // Each row is a disabled text input pre-filled with the declared
    // name, plus a small kind tag (scalar / list / record / …). Hover
    // tooltip points authors at the Analysis form for edits.
    const readOnlyRow = (label, name, expects) => `
      <label class="strategy-step-field strategy-step-field-readonly">
        <span class="strategy-step-field-label">${escHtml(label)}</span>
        <input type="text" class="strategy-step-field-input"
               value="${escAttr(name)}"
               readonly disabled
               title="${escAttr(`Declared ${label} on the Analysis (${expects}). Edit in the Analysis form.`)}" />
        <span class="strategy-step-field-kind">${escHtml(expects)}</span>
      </label>`;
    const inputRows  = declaredInputs.map(i  => readOnlyRow('input',  i.name, i.expects)).join('');
    const outputRows = declaredOutputs.map(o => readOnlyRow('output', o.name, o.expects)).join('');
    const emptyHint = (declaredInputs.length === 0 && declaredOutputs.length === 0)
      ? '<span class="strategy-step-field-hint">This Analysis has no declared inputs or outputs.</span>'
      : '';
    wiringHtml = `
      <div class="strategy-step-row-sub strategy-step-row-sub-stack">
        ${inputRows}
        ${outputRows}
        ${emptyHint}
      </div>`;
  } else if (bodyKind === 'template') {
    wiringHtml = `
      <div class="strategy-step-row-sub">
        <label class="strategy-step-field">
          <span class="strategy-step-field-label">output</span>
          <input type="text" class="strategy-step-field-input"
                 data-action="set-analysis-output" data-path="${escAttr(path)}"
                 value="${escAttr(step.output ?? '')}"
                 placeholder="output binding name (where the document goes)"
                 title="The scope binding the template body writes its rendered document into. Declared inputs are read from scope by their declared names — no source field needed." />
        </label>
      </div>`;
  } else {
    // operations / frontier / unpicked — keep the existing pair.
    wiringHtml = `
      <div class="strategy-step-row-sub">
        <label class="strategy-step-field">
          <span class="strategy-step-field-label">source</span>
          <input type="text" class="strategy-step-field-input"
                 data-action="set-analysis-source" data-path="${escAttr(path)}"
                 value="${escAttr(step.source ?? '')}"
                 placeholder="upstream list binding name"
                 title="The scope binding the analysis consumes (a list output from a Workflow step)." />
        </label>
        <label class="strategy-step-field">
          <span class="strategy-step-field-label">output</span>
          <input type="text" class="strategy-step-field-input"
                 data-action="set-analysis-output" data-path="${escAttr(path)}"
                 value="${escAttr(step.output ?? '')}"
                 placeholder="output binding name"
                 title="The scope binding the analysis writes its result into." />
        </label>
      </div>`;
  }

  return `
    <div class="strategy-step-card strategy-step-card-editable" data-path="${escAttr(path)}" data-step-type="analysis">
      <div class="strategy-step-row-top">
        <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
        <span class="strategy-step-num">${stepNum}</span>
        <span class="strategy-step-label">Analysis</span>
        <select class="strategy-step-picker" data-action="set-analysis-id" data-path="${escAttr(path)}">
          ${emptyOpt}
          ${builtinOpts}
          ${userOpts}
        </select>
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
      ${wiringHtml}
      ${bindingHtml ? `<div class="strategy-step-row-sub strategy-step-row-sub-stack">${bindingHtml}</div>` : ''}
    </div>`;
}

/**
 * v2.74.87 — Inline-editable FOREACH step card with a nested body list.
 *
 * Top row carries the `over` (list binding name) + `as` (iteration var
 * name) text inputs alongside the type label, drag handle, and remove
 * button. Below: a recursive step list rendering each body step (which
 * may itself be a FOREACH — paths nest naturally), followed by a row of
 * + buttons that append into the body via data-parent-path.
 *
 * Empty body shows a small hint. Body cards do NOT yet support drag-to-
 * reorder; remove-and-readd is the workaround until nested drag lands.
 */
function _renderStrategyForeachStepCard(step, path, stepNum) {
  const body = Array.isArray(step.body) ? step.body : [];

  const bodyHtml = body.length === 0
    ? '<div class="strategy-step-foreach-empty">No body steps yet. Use the buttons below.</div>'
    : body.map((s, i) => _renderStrategyStepCard(s, `${path}.body.${i}`)).join('');

  return `
    <div class="strategy-step-card strategy-step-card-editable strategy-step-card-foreach" data-path="${escAttr(path)}" data-step-type="foreach">
      <div class="strategy-step-row-top">
        <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
        <span class="strategy-step-num">${stepNum}</span>
        <span class="strategy-step-label">FOREACH</span>
        <label class="strategy-step-field">
          <span class="strategy-step-field-label">over</span>
          <input type="text" class="strategy-step-field-input"
                 data-action="set-foreach-over" data-path="${escAttr(path)}"
                 value="${escAttr(step.over ?? '')}"
                 placeholder="list binding name"
                 title="Name of an upstream list binding to iterate over." />
        </label>
        <label class="strategy-step-field">
          <span class="strategy-step-field-label">as</span>
          <input type="text" class="strategy-step-field-input"
                 data-action="set-foreach-as" data-path="${escAttr(path)}"
                 value="${escAttr(step.as ?? '')}"
                 placeholder="iter var name"
                 title="Name to bind each item to; body steps reference this via the 'iter var' binding kind." />
        </label>
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
      <div class="strategy-step-foreach-body">
        ${bodyHtml}
        ${_renderControlBodyAddRow(`${path}.body`)}
      </div>
    </div>`;
}

// v2.74.90 — Structured condition editor. Used by LOOP, DETECT branches,
// and WAIT-condition mode. Type picker is scoped to DATA_CONDITION_TYPES
// (the scope-family subset; page conditions don't apply at the Strategy
// tier — no tab). Fields fan out from DATA_CONDITION_FIELDS[type].
//
// `condPath` is a dot-notation path to the condition object inside the
// draft (e.g. "2.condition", "2.branches.1.condition"). The change /
// input handlers walk that path via _resolveCondition to mutate in place.
//
// Field count varies by type (1 for `binding_is_list`, 2 for
// `scalar_equals`, 3 for `binding_length_range`, etc.). They render as
// a horizontal flex row that wraps if cramped; the type dropdown is
// always first so authors see the type-shape relationship at a glance.
function _renderConditionEditor(cond, condPath) {
  const type = (cond && DATA_CONDITION_TYPES.includes(cond.type)) ? cond.type : 'binding_is_list';
  const schema = DATA_CONDITION_FIELDS[type];
  const fields = schema?.fields ?? ['binding'];

  const typeOpts = DATA_CONDITION_TYPES.map(t =>
    `<option value="${escAttr(t)}"${t === type ? ' selected' : ''}>${escHtml(t)}</option>`
  ).join('');

  const fieldInputs = fields.map(f => `
    <label class="strategy-step-cond-field">
      <span class="strategy-step-cond-field-label">${escHtml(f)}</span>
      <input type="text" class="strategy-step-cond-field-input"
             data-action="set-condition-field"
             data-condition-path="${escAttr(condPath)}"
             data-condition-field="${escAttr(f)}"
             value="${escAttr(cond?.[f] ?? '')}"
             placeholder="${escAttr(f)}" />
    </label>`).join('');

  return `<div class="strategy-step-cond-editor">
    <select class="strategy-step-cond-type"
            data-action="set-condition-type"
            data-condition-path="${escAttr(condPath)}"
            title="Pick the scope-condition predicate. Fields adapt to the chosen type.">
      ${typeOpts}
    </select>
    ${fieldInputs}
  </div>`;
}

// v2.74.88 — Shared "+ Workflow / + Analysis / + …" button row used by
// every control-flow body (FOREACH body, TRY body/recovery, future
// DETECT branch/default). The body-path string targets the array to
// push onto; the click delegator on #workflow-steps-list reads it via
// data-body-path. Compact (tiny) buttons keep nested bodies readable.
function _renderControlBodyAddRow(bodyPath) {
  const mk = (kind, label, title) =>
    `<button class="btn-secondary tiny" type="button" data-action="add-body-step" data-step-kind="${escAttr(kind)}" data-body-path="${escAttr(bodyPath)}" title="${escAttr(title)}">${escHtml(label)}</button>`;
  return `<div class="strategy-step-control-add-row">
    ${mk('workflow', '+ Workflow', 'Invoke a Workflow as a step')}
    ${mk('analysis', '+ Analysis', 'Invoke an Analysis as a step')}
    ${mk('foreach',  '+ FOREACH',  'Iterate a list binding')}
    ${mk('wait',     '+ WAIT',     'Pause for a duration')}
    ${mk('detect',   '+ DETECT',   'Branch on scope conditions')}
    ${mk('loop',     '+ LOOP',     'Repeat while condition holds')}
    ${mk('try',      '+ TRY',      'TRY / recovery')}
    ${mk('pause',    '+ PAUSE',    'Halt for user resume')}
  </div>`;
}

/**
 * v2.74.88 — Inline-editable LOOP step card.
 *
 * Top row: drag, num, "LOOP" label, condition summary (read-only — needs
 * its own condition editor; click to edit in JSON for now), max-iter
 * number input, remove.
 * Body: recursive step list + same control-body + buttons FOREACH uses.
 *
 * Iter cap is the only condition-adjacent field editable inline because
 * it's a simple number; scope conditions ({type, binding, value, ...})
 * have too many shape variations to warrant inline editing in this pass.
 */
function _renderStrategyLoopStepCard(step, path, stepNum) {
  const body = Array.isArray(step.body) ? step.body : [];
  const cap = Number.isFinite(step.maxIterations) && step.maxIterations > 0 ? step.maxIterations : 100;
  // v2.74.90 — Seed a default condition shape if none present so the
  // inline editor's type dropdown has something selected on first paint.
  // Mutation persists in the draft because step is a live reference.
  if (!step.condition || typeof step.condition !== 'object') {
    step.condition = { type: 'binding_is_list', binding: '' };
  }

  const bodyHtml = body.length === 0
    ? '<div class="strategy-step-foreach-empty">No body steps yet. Use the buttons below.</div>'
    : body.map((s, i) => _renderStrategyStepCard(s, `${path}.body.${i}`)).join('');

  return `
    <div class="strategy-step-card strategy-step-card-editable strategy-step-card-control" data-path="${escAttr(path)}" data-step-type="loop">
      <div class="strategy-step-row-top">
        <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
        <span class="strategy-step-num">${stepNum}</span>
        <span class="strategy-step-label">LOOP</span>
        <span class="strategy-step-cond-while-label">while</span>
        ${_renderConditionEditor(step.condition, `${path}.condition`)}
        <label class="strategy-step-field strategy-step-field-narrow">
          <span class="strategy-step-field-label">max</span>
          <input type="number" class="strategy-step-field-input"
                 data-action="set-loop-max" data-path="${escAttr(path)}"
                 value="${escAttr(cap)}" min="1"
                 title="Safety cap: hitting this fails the Strategy loudly." />
        </label>
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
      <div class="strategy-step-foreach-body">
        ${bodyHtml}
        ${_renderControlBodyAddRow(`${path}.body`)}
      </div>
    </div>`;
}

/**
 * v2.74.88 — Inline-editable TRY step card.
 *
 * Two stacked body sections — body and recovery — each with its own
 * step list and + button row. Visually differentiated: body uses the
 * default control-body tint, recovery uses a warning-amber tint so the
 * "this only runs on failure" semantics read at a glance.
 *
 * No fields on TRY itself today; the only edit point is "what's in the
 * two bodies". Future: per-error-type filters on recovery (catch_only,
 * etc.) when the runtime grows them.
 */
function _renderStrategyTryStepCard(step, path, stepNum) {
  const body     = Array.isArray(step.body) ? step.body : [];
  const recovery = Array.isArray(step.recovery) ? step.recovery : [];

  const renderSubBody = (steps, subPath, emptyMsg) =>
    steps.length === 0
      ? `<div class="strategy-step-foreach-empty">${escHtml(emptyMsg)}</div>`
      : steps.map((s, i) => _renderStrategyStepCard(s, `${subPath}.${i}`)).join('');

  return `
    <div class="strategy-step-card strategy-step-card-editable strategy-step-card-control" data-path="${escAttr(path)}" data-step-type="try">
      <div class="strategy-step-row-top">
        <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
        <span class="strategy-step-num">${stepNum}</span>
        <span class="strategy-step-label">TRY</span>
        <span class="strategy-step-meta strategy-step-meta-inline">body ${body.length} · recovery ${recovery.length}</span>
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
      <div class="strategy-step-try-section">
        <div class="strategy-step-section-label">body</div>
        <div class="strategy-step-foreach-body">
          ${renderSubBody(body, `${path}.body`, 'No body steps yet. Use the buttons below.')}
          ${_renderControlBodyAddRow(`${path}.body`)}
        </div>
      </div>
      <div class="strategy-step-try-section strategy-step-try-section-recovery">
        <div class="strategy-step-section-label">recovery <span class="strategy-step-section-hint">runs when body fails</span></div>
        <div class="strategy-step-foreach-body strategy-step-foreach-body-recovery">
          ${renderSubBody(recovery, `${path}.recovery`, 'No recovery steps yet. An empty recovery swallows body errors.')}
          ${_renderControlBodyAddRow(`${path}.recovery`)}
        </div>
      </div>
    </div>`;
}

/**
 * v2.74.89 — Inline-editable WAIT step card.
 *
 * Top row: drag, num, "WAIT" label, mode selector (duration | condition),
 * then either:
 *   - duration mode: number input for durationMs
 *   - condition mode: read-only summary + warning that the Strategy-tier
 *     runtime doesn't execute condition mode yet (see v2.74.80)
 *
 * Mode switch resets the relevant shape fields so a flip from duration
 * to condition doesn't leave a stale durationMs in the saved record.
 */
function _renderStrategyWaitStepCard(step, path, stepNum) {
  const mode = step.mode === 'condition' ? 'condition' : 'duration';
  const dur = Number.isFinite(step.durationMs) ? step.durationMs : 0;

  // v2.74.90 — Seed a default condition shape if user toggled to
  // condition mode but no condition is set yet.
  if (mode === 'condition' && (!step.condition || typeof step.condition !== 'object')) {
    step.condition = { type: 'binding_is_list', binding: '' };
  }

  const valueCtrl = mode === 'duration'
    ? `<label class="strategy-step-field strategy-step-field-narrow">
         <span class="strategy-step-field-label">ms</span>
         <input type="number" class="strategy-step-field-input"
                data-action="set-wait-duration" data-path="${escAttr(path)}"
                value="${escAttr(dur)}" min="0"
                title="Sleep this many milliseconds before continuing." />
       </label>`
    : `<span class="strategy-step-cond-while-label" title="Condition-mode WAIT isn't yet executable at the Strategy tier — authoring still works for forward-compat.">until</span>
       ${_renderConditionEditor(step.condition, `${path}.condition`)}`;

  return `
    <div class="strategy-step-card strategy-step-card-editable strategy-step-card-control" data-path="${escAttr(path)}" data-step-type="wait">
      <div class="strategy-step-row-top">
        <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
        <span class="strategy-step-num">${stepNum}</span>
        <span class="strategy-step-label">WAIT</span>
        <select class="strategy-step-mode-picker"
                data-action="set-wait-mode" data-path="${escAttr(path)}"
                title="duration: simple sleep. condition: poll a scope binding until it flips (not yet shipped).">
          <option value="duration" ${mode === 'duration'  ? 'selected' : ''}>duration</option>
          <option value="condition"${mode === 'condition' ? 'selected' : ''}>until condition</option>
        </select>
        ${valueCtrl}
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
    </div>`;
}

/**
 * v2.74.89 — Inline-editable DETECT step card.
 *
 * Layout:
 *   - Top row: drag, num, "DETECT" label, summary meta, remove
 *   - Branches section: one sub-card per branch (condition summary +
 *     remove-branch + nested body) + "+ Add branch" button
 *   - Default section: nested body for the no-match fallback
 *
 * Conditions remain read-only summaries; per-branch condition editing
 * lands when the structured condition editor ships. Branch reordering
 * isn't supported in this pass — remove + re-add to reorder.
 */
function _renderStrategyDetectStepCard(step, path, stepNum) {
  const branches = Array.isArray(step.branches) ? step.branches : [];
  const defaultBody = Array.isArray(step.default) ? step.default : [];

  const branchesHtml = branches.length === 0
    ? '<div class="strategy-step-foreach-empty">No branches yet. Click + Add branch.</div>'
    : branches.map((b, k) => _renderDetectBranchSubCard(b, path, k)).join('');

  const defaultHtml = defaultBody.length === 0
    ? '<div class="strategy-step-foreach-empty">No default steps. The Strategy falls through silently if no branch matches.</div>'
    : defaultBody.map((s, i) => _renderStrategyStepCard(s, `${path}.default.${i}`)).join('');

  return `
    <div class="strategy-step-card strategy-step-card-editable strategy-step-card-control" data-path="${escAttr(path)}" data-step-type="detect">
      <div class="strategy-step-row-top">
        <span class="strat-step-handle" data-drag-handle title="Drag to reorder">⋮⋮</span>
        <span class="strategy-step-num">${stepNum}</span>
        <span class="strategy-step-label">DETECT</span>
        <span class="strategy-step-meta strategy-step-meta-inline">${branches.length} branch${branches.length === 1 ? '' : 'es'} · default ${defaultBody.length}</span>
        <button class="btn-action danger" type="button"
                data-action="remove-strategy-step" data-path="${escAttr(path)}"
                title="Remove this step">✕</button>
      </div>
      <div class="strategy-step-detect-branches">
        ${branchesHtml}
        <button class="btn-secondary tiny strategy-step-detect-add-branch" type="button"
                data-action="add-detect-branch" data-path="${escAttr(path)}"
                title="Add a new branch (first matching branch wins)">+ Add branch</button>
      </div>
      <div class="strategy-step-try-section">
        <div class="strategy-step-section-label">default <span class="strategy-step-section-hint">runs when no branch matches</span></div>
        <div class="strategy-step-foreach-body strategy-step-foreach-body-default">
          ${defaultHtml}
          ${_renderControlBodyAddRow(`${path}.default`)}
        </div>
      </div>
    </div>`;
}

function _renderDetectBranchSubCard(branch, parentPath, branchIdx) {
  const body = Array.isArray(branch?.body) ? branch.body : [];
  // Seed default condition for the editor; same in-place strategy as LOOP.
  if (!branch.condition || typeof branch.condition !== 'object') {
    branch.condition = { type: 'binding_is_list', binding: '' };
  }

  const bodyHtml = body.length === 0
    ? '<div class="strategy-step-foreach-empty">No body steps yet.</div>'
    : body.map((s, i) => _renderStrategyStepCard(s, `${parentPath}.branches.${branchIdx}.body.${i}`)).join('');

  return `
    <div class="strategy-step-detect-branch">
      <div class="strategy-step-detect-branch-head">
        <span class="strategy-step-branch-label">Branch ${branchIdx + 1}</span>
        <span class="strategy-step-cond-while-label">if</span>
        ${_renderConditionEditor(branch.condition, `${parentPath}.branches.${branchIdx}.condition`)}
        <button class="btn-action danger" type="button"
                data-action="remove-detect-branch"
                data-path="${escAttr(parentPath)}"
                data-branch-idx="${branchIdx}"
                title="Remove this branch">✕</button>
      </div>
      <div class="strategy-step-foreach-body">
        ${bodyHtml}
        ${_renderControlBodyAddRow(`${parentPath}.branches.${branchIdx}.body`)}
      </div>
    </div>`;
}

// v2.74.75 — Shared binding-row renderer for Workflow + Analysis steps.
//
// One row per declared param of the chosen target. Each row carries:
//   • the param name (read-only label)
//   • a kind picker — literal / strategy_param / iteration_variable
//   • a value control that adapts to the kind:
//       literal           → text input
//       strategy_param    → dropdown of typed inputs declared on this Strategy
//       iteration_variable → text input (the iter var name authors typed
//                            on an outer FOREACH — no nested-FOREACH
//                            tracking inline yet, so we accept any string)
//
// The handler block (see setupWorkflowsTab) handles change/input on these
// controls. data-action discriminates which field changed; data-idx points
// at the step's slot; data-param is the param name.
// v2.74.77 — `scope_binding` joins the list: bind to an upstream step's
// output by name. The value control is a text input (authors type the
// binding name an earlier Workflow / Analysis step emitted into scope).
// Resolution lives in WorkflowExecutor.resolveBinding.
const BINDING_KINDS = Object.freeze([
  { value: 'literal',            label: 'literal'     },
  { value: 'strategy_param',     label: 'input'       },
  { value: 'scope_binding',      label: 'step output' },
  { value: 'iteration_variable', label: 'iter var'    },
]);

function _renderBindingRows(stepPath, declaredParams, currentBindings) {
  const declaredInputs = Array.isArray(_workflowsState.workflowDraft?.declaredInputs)
    ? _workflowsState.workflowDraft.declaredInputs.filter(p => p?.name?.trim())
    : [];

  return `<div class="strategy-step-bindings-grid">${
    declaredParams.map(p => {
      const name = typeof p === 'string' ? p : p.name;
      const b = currentBindings[name] ?? { kind: 'literal', value: '' };
      const kind = b.kind ?? 'literal';

      const kindOpts = BINDING_KINDS.map(k =>
        `<option value="${k.value}"${k.value === kind ? ' selected' : ''}>${k.label}</option>`
      ).join('');

      // Value control adapts to kind. data-action stays the same per kind
      // because the handler reads the row's kind from the sibling dropdown.
      let valueCtrl;
      if (kind === 'strategy_param') {
        const opts = declaredInputs.length === 0
          ? '<option value="" disabled selected>(no typed inputs declared)</option>'
          : '<option value="" disabled' + (b.name ? '' : ' selected') + '>— pick an input —</option>'
            + declaredInputs.map(di =>
                `<option value="${escAttr(di.name)}"${di.name === b.name ? ' selected' : ''}>${escHtml(di.name)}</option>`
              ).join('');
        valueCtrl = `<select class="strategy-step-binding-value-input"
                            data-action="set-binding-value" data-path="${escAttr(stepPath)}" data-param="${escAttr(name)}">
                      ${opts}
                    </select>`;
      } else if (kind === 'iteration_variable') {
        valueCtrl = `<input type="text" class="strategy-step-binding-value-input"
                            data-action="set-binding-value" data-path="${escAttr(stepPath)}" data-param="${escAttr(name)}"
                            value="${escAttr(b.name ?? '')}"
                            placeholder="iter var (FOREACH 'as' name)"
                            title="Name of an enclosing FOREACH's iteration variable." />`;
      } else if (kind === 'scope_binding') {
        // v2.74.77 — Bind to an upstream step's output by name. Text input
        // because the binding name is author-typed; we can't (yet) enumerate
        // upstream outputs at authoring time without static analysis of
        // the prior steps' targets.
        valueCtrl = `<input type="text" class="strategy-step-binding-value-input"
                            data-action="set-binding-value" data-path="${escAttr(stepPath)}" data-param="${escAttr(name)}"
                            value="${escAttr(b.name ?? '')}"
                            placeholder="upstream step output (binding name)"
                            title="A binding written by an earlier step in this Strategy (e.g. an OBSERVATION output's name)." />`;
      } else {
        // literal (default)
        valueCtrl = `<input type="text" class="strategy-step-binding-value-input"
                            data-action="set-binding-value" data-path="${escAttr(stepPath)}" data-param="${escAttr(name)}"
                            value="${escAttr(b.value ?? '')}"
                            placeholder="literal value"
                            title="A constant value substituted into the target's template." />`;
      }

      return `
        <div class="strategy-step-binding-row" data-param="${escAttr(name)}">
          <code class="strategy-step-binding-name">${escHtml(name)}</code>
          <select class="strategy-step-binding-kind"
                  data-action="set-binding-kind" data-path="${escAttr(stepPath)}" data-param="${escAttr(name)}">
            ${kindOpts}
          </select>
          ${valueCtrl}
        </div>`;
    }).join('')
  }</div>`;
}

// ── Workflow entity form (v2.74.70) ─────────────────────────────────────────
//
// Inline form, opens above the Workflows list section. State lives in
// _workflowsState.workflowDraft so we can later add fields incrementally
// (composition steps, preconditions, etc.) without restructuring this code.

function openWorkflowForm(existing = null) {
  _workflowsState.workflowDraft = existing
    ? {
        id          : existing.id,
        name        : existing.name ?? '',
        description : existing.description ?? '',
        // v2.74.83 — Aliases live on the record as string[]. We surface them
        // in the form as a comma-joined string for editing; the save path
        // splits, trims, and drops empties back into string[].
        aliases     : Array.isArray(existing.aliases) ? existing.aliases.join(', ') : (existing.aliases ?? ''),
        // v2.74.85 — Result template (chat headline). Persisted verbatim.
        resultTemplate: existing.resultTemplate ?? '',
        steps       : Array.isArray(existing.steps) ? existing.steps : [],
        // v2.74.72 — Typed inputs editor state. Strategies own the invocation
        // surface, so this is where authors declare file uploads, numbers,
        // booleans, and string defaults. Same canonical shape as
        // normalizeStrategyParams emits — seed defensively so legacy /
        // hand-edited records reach the editor in canonical form.
        declaredInputs: normalizeStrategyParams(existing.params).map(p => ({ ...p })),
        createdAt   : existing.createdAt,
        isEditing   : true,
      }
    : {
        id          : uid(),
        name        : '',
        description : '',
        aliases     : '',
        resultTemplate: '',
        steps       : [],
        declaredInputs: [],
        isEditing   : false,
      };

  const draft = _workflowsState.workflowDraft;
  $('workflow-form-title').textContent = draft.isEditing ? 'Edit Workflow' : 'New Workflow';
  $('input-workflow-name').value        = draft.name;
  $('input-workflow-description').value = draft.description;
  $('input-workflow-aliases').value     = draft.aliases;
  $('input-workflow-result-template').value = draft.resultTemplate;
  renderWorkflowInputsEditor();
  renderStrategyStepsList();
  $('workflow-form-card').classList.remove('hidden');
  $('input-workflow-name').focus();
}

function closeWorkflowForm() {
  _workflowsState.workflowDraft = null;
  $('workflow-form-card').classList.add('hidden');
  $('input-workflow-name').value = '';
  $('input-workflow-description').value = '';
  $('input-workflow-aliases').value = '';
  $('input-workflow-result-template').value = '';
  // Clear the inputs list so the next open paint doesn't briefly flash
  // the previous draft's rows.
  const list = $('workflow-inputs-list');
  if (list) list.innerHTML = '';
  const stepsList = $('workflow-steps-list');
  if (stepsList) stepsList.innerHTML = '';
}

// v2.74.104 — Walk a steps[] tree and count steps that haven't been fully
// configured by the author. Surfaces as a soft warning at save time so the
// draft semantics still hold (you can save and come back later), but the
// count of unconfigured steps is visible at the moment the author thinks
// they're done. Catches a real class of authoring errors (forgotten
// workflowId picks, dropped-in FOREACH with empty `over`, etc.) before
// they fail at invocation time.
function _countUnconfiguredSteps(steps) {
  if (!Array.isArray(steps)) return 0;
  let count = 0;
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    switch (step.type) {
      case 'workflow':
        if (!step.workflowId) count++;
        break;
      case 'analysis':
        if (!step.analysisId) count++;
        break;
      case 'foreach':
        if (!step.over || !step.as) count++;
        count += _countUnconfiguredSteps(step.body);
        break;
      case 'loop':
        if (!step.condition?.binding && !step.condition?.field) count++;
        count += _countUnconfiguredSteps(step.body);
        break;
      case 'detect':
        if (Array.isArray(step.branches)) {
          for (const br of step.branches) {
            if (!br?.condition?.binding && !br?.condition?.field) count++;
            count += _countUnconfiguredSteps(br?.body);
          }
        }
        count += _countUnconfiguredSteps(step.default);
        break;
      case 'try':
        count += _countUnconfiguredSteps(step.body);
        count += _countUnconfiguredSteps(step.recovery);
        break;
      case 'wait':
        if (step.mode === 'condition' && !step.condition?.binding && !step.condition?.field) count++;
        break;
      default: break;
    }
  }
  return count;
}

async function saveWorkflowDraft() {
  const draft = _workflowsState.workflowDraft;
  if (!draft) return;

  draft.name        = $('input-workflow-name').value.trim();
  draft.description = $('input-workflow-description').value.trim();
  draft.aliases     = $('input-workflow-aliases').value.trim();
  draft.resultTemplate = $('input-workflow-result-template').value.trim();

  if (!draft.name) {
    toast('Workflow name is required', 'err');
    $('input-workflow-name').focus();
    return;
  }

  // v2.74.104 — Soft warning: count steps with unset configuration so the
  // author can catch forgotten picks before invocation. Save proceeds
  // either way (drafts are allowed to be partial).
  const unconfigured = _countUnconfiguredSteps(draft.steps);
  if (unconfigured > 0) {
    toast(`⚠ ${unconfigured} step${unconfigured === 1 ? '' : 's'} not fully configured`, 'warn');
  }

  // v2.74.72 — Persist typed inputs as the canonical `params` array.
  // normalizeStrategyParams drops empty-name rows, fills in defaults, and
  // canonicalizes file fields. Strategies live on the same shape as
  // Workflows do for params so future composition logic can treat them
  // uniformly when routing values from a Strategy invocation to the
  // Workflow steps it orchestrates.
  const declaredRows = Array.isArray(draft.declaredInputs)
    ? draft.declaredInputs.filter(r => r && typeof r.name === 'string' && r.name.trim())
    : [];
  const params = normalizeStrategyParams(declaredRows);

  // v2.74.83 — Split aliases on comma, trim, drop empties. Stored as
  // string[]; surfaced by CapabilityAPI as descriptor.triggers[] which
  // feeds the chat routing LLM.
  const aliases = draft.aliases
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  // Build the record. createdAt is preserved by saveWorkflow when present;
  // we forward our draft's createdAt for editing flows and let it be unset
  // for new ones (StorageManager will stamp Date.now()).
  const workflow = {
    id          : draft.id,
    name        : draft.name,
    description : draft.description,
    aliases,
    resultTemplate: draft.resultTemplate,
    steps       : draft.steps,
    params,
    ...(draft.createdAt ? { createdAt: draft.createdAt } : {}),
  };

  const response = await new Promise(r => chrome.runtime.sendMessage({
    type: 'SAVE_WORKFLOW', payload: { workflow },
  }, r));

  if (!response?.success) {
    toast(`Failed to save Workflow: ${response?.error ?? 'unknown'}`, 'err');
    return;
  }

  toast(draft.isEditing ? 'Workflow updated' : 'Workflow created');
  closeWorkflowForm();
  // STORAGE_CHANGED will re-fire refreshWorkflows; explicit call here covers
  // the case where the listener short-circuits due to _pendingStorageRefresh.
  await refreshWorkflows();
}

// Workflow test-run from Studio. Mirrors testRunStrategy (which runs the
// per-Ground Strategy entity), but dispatches through INVOKE_WORKFLOW
// to the WorkflowExecutor instead of the Strategy-tier ExecutionEngine
// path.
//
// Flow:
//   1. Load the Workflow record
//   2. If it declares typed inputs, open the shared ParamForm modal to
//      collect values (file uploads, numbers, booleans, strings)
//   3. Dispatch INVOKE_WORKFLOW with the collected values
//   4. Toast progress events as steps start / finish; final toast carries
//      success / failure
//
// Progress events arrive via the WORKFLOW_PROGRESS message broadcast from
// background. The listener is wired once at module load (see bottom of
// this section); it filters by invocationId so concurrent runs from
// different tabs don't cross-contaminate.
// Run a Workflow with the dedicated debugger sidepanel open. Mirrors
// testRunWorkflow's invoke flow but ALSO opens the sidepanel + requests
// the `workflow-debug` mode so the user sees step-level progress + can
// pause/resume from the sidepanel instead of just the entity row.
//
// Caller-gesture safety: chrome.sidePanel.open requires a user gesture,
// so we open the panel BEFORE awaiting promptForParams (the click on the
// Debug button is the gesture).
async function testRunWorkflowDebug(workflowId) {
  const workflow = await StorageManager.getWorkflow(workflowId);
  if (!workflow) { toast('Workflow not found', 'err'); return; }

  // Open the sidepanel and request the workflow-debug mode FIRST so the
  // user gesture isn't consumed by the param-form modal. The mode mounts
  // with no invocationId; the first WORKFLOW_PROGRESS event captures it.
  // v2.74.140 — Route through shared openSidepanelHere to displace any
  // prior per-tab override (e.g. popup-Chat's chat.html). Pre-v2.74.140
  // this set only the global path, so an active-tab Chat override kept
  // the panel on chat.html and the workflow-debug mode request landed
  // in the wrong panel.
  try {
    await openSidepanelHere('sidepanel.html');
    await chrome.runtime.sendMessage({
      type: 'REQUEST_SIDEPANEL_MODE',
      payload: {
        mode: 'workflow-debug',
        payload: {
          workflowId,
          workflowName: workflow.name ?? 'Workflow',
          steps: Array.isArray(workflow.steps) ? workflow.steps : [],
        },
      },
    });
  } catch (e) {
    console.warn('[studio] could not open workflow-debug sidepanel:', e?.message);
  }

  // Collect typed inputs if declared. Same shared ParamForm modal the
  // non-debug ▶ path uses.
  const declared = normalizeStrategyParams(workflow.params);
  let paramValues = {};
  if (declared.length > 0) {
    const values = await promptForParams(declared, {
      title: `${workflow.name ?? 'Workflow'} — inputs`,
      hint:  'Fill in values for this run. The debugger sidepanel is open.',
      submitLabel: 'Run',
    });
    if (values === null) return;
    paramValues = values;
  }

  const invocationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `winv-${Date.now()}`;
  _workflowRunStates.set(invocationId, { name: workflow.name ?? workflowId, stepCount: 0 });
  _workflowsState.runningInvocations.set(workflowId, invocationId);
  renderWorkflowEntityList();

  try {
    const response = await new Promise(r => chrome.runtime.sendMessage({
      type: 'INVOKE_WORKFLOW',
      // v2.74.158 — Mark this as a debug run. The background's
      // INVOKE_WORKFLOW handler reads `payload.debug` to decide whether
      // the constructed debug envelope carries `pauseMode: 'after-node'`
      // (debug ON — observation overlay fires, breakpoints respected)
      // or `pauseMode: 'off'` (debug OFF — non-debug runtime flags
      // suppressed). Previously the envelope was always built without
      // pauseMode, which made the overlay flash for every workflow run
      // including non-debug ones from chat / Studio ▶.
      payload: { workflowId, paramValues, invocationId, debug: true },
    }, r));

    _workflowRunStates.delete(invocationId);
    _workflowsState.runningInvocations.delete(workflowId);
    _workflowsState.pausedInvocations.delete(invocationId);
    renderWorkflowEntityList();

    // No toast here — the debugger sidepanel surfaces the outcome.
    // (If the user closed the panel, they'll see no chrome — that's
    // an acceptable trade-off for now.)
    void response;
  } catch (err) {
    _workflowRunStates.delete(invocationId);
    _workflowsState.runningInvocations.delete(workflowId);
    _workflowsState.pausedInvocations.delete(invocationId);
    renderWorkflowEntityList();
    toast(`Run failed: ${err.message}`, 'err');
  }
}

async function testRunWorkflow(workflowId) {
  const workflow = await StorageManager.getWorkflow(workflowId);
  if (!workflow) { toast('Workflow not found', 'err'); return; }

  // Collect typed inputs if declared. Workflows with empty params skip
  // straight to invocation.
  const declared = normalizeStrategyParams(workflow.params);
  let paramValues = {};
  if (declared.length > 0) {
    const values = await promptForParams(declared, {
      title: `${workflow.name ?? 'Workflow'} — inputs`,
      hint:  'Fill in values for this run.',
      submitLabel: 'Run',
    });
    if (values === null) return;        // user cancelled
    paramValues = values;
  }

  const invocationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID() : `winv-${Date.now()}`;
  _workflowRunStates.set(invocationId, { name: workflow.name ?? workflowId, stepCount: 0 });

  // v2.74.84 — Register the in-flight invocation so the row renderer
  // flips its ▶ button to ■ and the cancel handler can resolve the
  // workflowId → invocationId. The renderWorkflowEntityList() call swaps
  // the row UI immediately.
  _workflowsState.runningInvocations.set(workflowId, invocationId);
  renderWorkflowEntityList();

  toast(`Running "${workflow.name ?? 'Workflow'}"…`);

  try {
    const response = await new Promise(r => chrome.runtime.sendMessage({
      type: 'INVOKE_WORKFLOW',
      payload: { workflowId, paramValues, invocationId },
    }, r));

    _workflowRunStates.delete(invocationId);
    _workflowsState.runningInvocations.delete(workflowId);
    _workflowsState.pausedInvocations.delete(invocationId);
    renderWorkflowEntityList();

    // v2.74.84 — Differentiate user-initiated cancel from other failures.
    // The executor returns `{success: false, error: 'Aborted'}` on abort.
    // v2.74.104 — Match prefix instead of exact string so wrapped variants
    // like "Aborted (iteration 3/5)" still surface as the cancel toast.
    if (!response?.success) {
      if (typeof response?.error === 'string' && response.error.startsWith('Aborted')) {
        toast(`◌ ${workflow.name ?? 'Workflow'} cancelled`, 'warn');
      } else {
        toast(`✕ ${workflow.name ?? 'Workflow'}: ${response?.error ?? 'failed'}`, 'err');
      }
      return;
    }
    const stepCount = response.stepResults?.length ?? 0;
    toast(`✓ ${workflow.name ?? 'Workflow'} — ${stepCount} step${stepCount === 1 ? '' : 's'}`, 'ok');
  } catch (err) {
    _workflowRunStates.delete(invocationId);
    _workflowsState.runningInvocations.delete(workflowId);
    _workflowsState.pausedInvocations.delete(invocationId);
    renderWorkflowEntityList();
    toast(`Run failed: ${err.message}`, 'err');
  }
}

// v2.74.84 — Cancel a running Strategy from Studio. Looks up the in-flight
// invocationId for this workflowId and dispatches CANCEL_WORKFLOW. The
// background's executor polls the cancellation set between steps and inside
// WAIT slices; the originating testRunWorkflow's awaited promise then
// resolves with `{error: 'Aborted'}` shortly after, triggering the
// "cancelled" toast.
async function cancelRunningWorkflow(workflowId) {
  const invocationId = _workflowsState.runningInvocations.get(workflowId);
  if (!invocationId) return;        // already completed
  try {
    await new Promise(r => chrome.runtime.sendMessage({
      type: 'CANCEL_WORKFLOW',
      payload: { invocationId },
    }, r));
  } catch (err) {
    toast(`Cancel failed: ${err.message}`, 'err');
  }
}

// v2.74.91 — Pause / resume control for a running Strategy. Sends the
// PAUSE_WORKFLOW or RESUME_WORKFLOW message; the row's button strip
// updates via WORKFLOW_PAUSE_STATE which the listener below maps into
// _workflowsState.pausedInvocations and rerenders.
async function pauseRunningWorkflow(workflowId) {
  const invocationId = _workflowsState.runningInvocations.get(workflowId);
  if (!invocationId) return;
  try {
    await new Promise(r => chrome.runtime.sendMessage({
      type: 'PAUSE_WORKFLOW',
      payload: { invocationId },
    }, r));
  } catch (err) {
    toast(`Pause failed: ${err.message}`, 'err');
  }
}
async function resumeRunningWorkflow(workflowId) {
  const invocationId = _workflowsState.runningInvocations.get(workflowId);
  if (!invocationId) return;
  try {
    await new Promise(r => chrome.runtime.sendMessage({
      type: 'RESUME_WORKFLOW',
      payload: { invocationId },
    }, r));
  } catch (err) {
    toast(`Resume failed: ${err.message}`, 'err');
  }
}

// Pause-state listener. WORKFLOW_PAUSE_STATE broadcasts when the
// background flips the paused flag (PAUSE_WORKFLOW, RESUME_WORKFLOW, or
// PAUSE step execution inside the Workflow runtime). Map updates +
// immediate rerender so the row button strip reacts in real time.
// v2.74.142 — Renamed from STRATEGY_PAUSE_STATE (which dated from the
// pre-relabel UI vocabulary) to match the new "Workflow" terminology.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'WORKFLOW_PAUSE_STATE') return false;
  const { invocationId, paused } = msg.payload ?? {};
  if (!invocationId) return false;
  if (paused) _workflowsState.pausedInvocations.set(invocationId, true);
  else        _workflowsState.pausedInvocations.delete(invocationId);
  renderWorkflowEntityList();
  return false;
});

// v2.74.76 — Per-invocation runtime state. Currently only used to filter
// progress events to the originating Studio tab; future passes can hang
// debug-mode / cancellation state off the same map.
const _workflowRunStates = new Map();

// Progress listener. WORKFLOW_PROGRESS broadcasts from the
// WorkflowExecutor (via background) carry per-step start/done/skipped
// events. We surface step-level results as transient toasts so the user
// can see the Workflow advancing without opening DevTools. Final summary
// (success / failure) comes from the INVOKE_WORKFLOW response itself —
// these are intermediate only.
// v2.74.142 — Renamed from STRATEGY_PROGRESS to match the new "Workflow"
// terminology (the message names had drifted out of sync with the UI).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'WORKFLOW_PROGRESS') return false;
  const { invocationId, event } = msg.payload ?? {};
  if (!invocationId || !_workflowRunStates.has(invocationId)) return false;

  // Only the most meaningful events get toasted. Inner-Workflow progress
  // (fromInnerWorkflow flag) is suppressed — that runtime already toasts
  // through Studio's existing test-run path. Strategy-level events stay.
  if (event?.fromInnerWorkflow) return false;

  if (event?.type === 'strategy_step_start') {
    // No toast — would spam on multi-step Strategies. Reserved for future
    // progress-bar UI.
  } else if (event?.type === 'strategy_step_done') {
    if (event.success === false) toast(`✕ step ${event.stepIndex + 1}: ${event.error ?? 'failed'}`, 'err');
  } else if (event?.type === 'strategy_step_skipped') {
    toast(`⊘ step ${event.stepIndex + 1}: ${event.stepType} not yet runnable`, 'warn');
  }
  return false;
});

async function deleteWorkflow(workflowId) {
  const w = await StorageManager.getWorkflow(workflowId);
  if (!w) return;
  if (!confirm(`Delete Workflow "${w.name ?? workflowId}"? This cannot be undone.`)) return;
  const response = await new Promise(r => chrome.runtime.sendMessage({
    type: 'DELETE_WORKFLOW', payload: { workflowId },
  }, r));
  if (!response?.success) {
    toast(`Failed to delete: ${response?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast('Workflow deleted');
  await refreshWorkflows();
}

// ── v2.74.72 — Typed inputs editor (moved here from the Workflow form) ────
//
// Renders one row per declared input from _workflowsState.workflowDraft.
// Each row: name + type dropdown + required checkbox + remove. For type=file
// the row expands to show `accept` and `parse`; for type=string/number it
// shows an optional `default`. Boolean rows show no sub-row.
//
// Unlike the old Workflow-form editor, there's no body-derived merge here —
// Strategies don't have a fragment body that references {{NAME}} templates.
// Every entry is user-declared.

function renderWorkflowInputsEditor() {
  const list = $('workflow-inputs-list');
  const draft = _workflowsState.workflowDraft;
  if (!list || !draft) return;

  const declared = Array.isArray(draft.declaredInputs) ? draft.declaredInputs : [];

  if (declared.length === 0) {
    list.innerHTML = '<div class="strategy-inputs-empty">No typed inputs declared. Click <em>+ Add typed input</em> to declare a file upload, number, boolean, or string default.</div>';
    return;
  }

  list.innerHTML = declared.map((p, idx) => _renderWorkflowInputRow(p, idx)).join('');
}

function _renderWorkflowInputRow(p, idx) {
  const isFile = p.type === 'file';

  const typeOptions = INPUT_TYPES.map(t =>
    `<option value="${t}"${t === p.type ? ' selected' : ''}>${t}</option>`).join('');

  const fileFields = isFile ? `
    <label class="strategy-input-sublabel">accept
      <input type="text" class="strategy-input-accept"
             data-idx="${idx}" data-field="accept"
             value="${escAttr(p.accept ?? '')}"
             placeholder=".csv,.json,.txt"
             title="Standard <input accept> filter; controls which files the picker shows" />
    </label>
    <label class="strategy-input-sublabel">parse
      <select class="strategy-input-parse" data-idx="${idx}" data-field="parse"
              title="How the uploaded bytes become a scope binding. 'auto' picks from MIME / extension.">
        ${FILE_PARSERS.map(pp => `<option value="${pp}"${pp === (p.parse ?? 'auto') ? ' selected' : ''}>${pp}</option>`).join('')}
      </select>
    </label>` : '';

  const defaultField = (!isFile && (p.type === 'string' || p.type === 'number')) ? `
    <label class="strategy-input-sublabel">default
      <input type="${p.type === 'number' ? 'number' : 'text'}"
             class="strategy-input-default"
             data-idx="${idx}" data-field="default"
             value="${escAttr(p.default ?? '')}"
             placeholder="(optional)" />
    </label>` : '';

  return `
    <div class="strategy-input-row" data-idx="${idx}">
      <div class="strategy-input-main">
        <input type="text" class="strategy-input-name"
               data-idx="${idx}" data-field="name"
               value="${escAttr(p.name)}"
               placeholder="INPUT_NAME" />
        <select class="strategy-input-type" data-idx="${idx}" data-field="type">${typeOptions}</select>
        <label class="strategy-input-required" title="Whether the user must provide a value at invocation time">
          <input type="checkbox" data-idx="${idx}" data-field="required"
                 ${p.required !== false ? 'checked' : ''} />
          required
        </label>
        <button type="button" class="btn-icon strategy-input-remove"
                data-idx="${idx}" title="Remove this typed input">✕</button>
      </div>
      ${(fileFields || defaultField) ? `<div class="strategy-input-sub">${fileFields}${defaultField}</div>` : ''}
    </div>`;
}

async function refreshWorkflows() {
  // Pull all sets in parallel; each touches a different storage index.
  // getAllStrategies / getAllAnalyses walk their per-Ground sub-indexes
  // internally; listWorkflows touches workflows:index.
  const [strategies, grounds, workflows, analyses] = await Promise.all([
    StorageManager.getAllStrategies(),
    StorageManager.getAllGrounds(),
    StorageManager.listWorkflows(),
    StorageManager.getAllAnalyses(),
  ]);

  _workflowsState.strategies = strategies;
  _workflowsState.grounds = new Map(grounds.map(g => [g.id, g]));
  _workflowsState.workflows = workflows;
  // v2.74.74 — User analyses + builtins. Builtins prepend so they appear
  // at the top of every Analysis picker.
  _workflowsState.analyses = [
    ...BUILTIN_ANALYSES.map(a => ({ ...a, _builtin: true })),
    ...analyses,
  ];

  // Populate the Ground filter dropdown — preserve the user's current
  // selection if the Ground still exists, else fall back to "All".
  const sel = $('workflows-filter-ground');
  if (sel) {
    const prev = sel.value;
    const sortedGrounds = [...grounds].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    sel.innerHTML = '<option value="">All Grounds</option>'
      + sortedGrounds.map(g => `<option value="${escAttr(g.id)}">${escHtml(g.name ?? g.id)}</option>`).join('');
    sel.value = _workflowsState.grounds.has(prev) ? prev : '';
    _workflowsState.filter.groundId = sel.value;
  }

  renderWorkflows();
}

function renderWorkflows() {
  // v2.74.70 — Two sections render side-by-side: the Workflow entity list
  // (top) and the Strategy catalog (bottom). The entity list is independent
  // of the catalog's filter controls.
  renderWorkflowEntityList();

  const list = $('workflows-list');
  const countEl = $('workflows-count');
  if (!list) return;

  const { search, groundId, tier } = _workflowsState.filter;

  // Apply filters in order of cheapest predicate first to keep the loop tight
  // when the catalog grows (a user with 200 strategies will feel a slow filter).
  const filtered = _workflowsState.strategies.filter(s => {
    if (groundId && s.groundId !== groundId) return false;
    const sTier = s.implementations?.[0]?.tier ?? 'cache';
    if (tier && sTier !== tier) return false;
    if (search) {
      const aliases = Array.isArray(s.aliases) ? s.aliases.join(' ') : '';
      const hay = `${s.name ?? ''} ${s.goal ?? ''} ${aliases}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  // Stable sort: by Ground name, then Strategy name. Authors scanning the
  // catalog usually think "what's on Ground X" first.
  filtered.sort((a, b) => {
    const ga = _workflowsState.grounds.get(a.groundId)?.name ?? '';
    const gb = _workflowsState.grounds.get(b.groundId)?.name ?? '';
    return ga.localeCompare(gb) || (a.name ?? '').localeCompare(b.name ?? '');
  });

  if (countEl) {
    const total = _workflowsState.strategies.length;
    countEl.textContent = filtered.length === total
      ? `${total} strateg${total === 1 ? 'y' : 'ies'}`
      : `${filtered.length} of ${total}`;
  }

  if (_workflowsState.strategies.length === 0) {
    list.innerHTML = '<div class="workflows-empty">No Strategies authored yet. Open a Ground and click <em>+ Strategy</em> to create one.</div>';
    return;
  }
  if (filtered.length === 0) {
    list.innerHTML = '<div class="workflows-empty">No Strategies match the current filter. <button class="link-button" data-action="clear-filters">Clear filters</button></div>';
    list.querySelector('[data-action="clear-filters"]')?.addEventListener('click', () => {
      $('workflows-search').value = '';
      $('workflows-filter-ground').value = '';
      $('workflows-filter-tier').value = '';
      _workflowsState.filter = { search: '', groundId: '', tier: '' };
      renderWorkflows();
    });
    return;
  }

  list.innerHTML = filtered.map(s => _renderWorkflowRow(s)).join('');

  // Action wiring — delegated would be terser but we'd lose the imported
  // function references' clean call-site. Per-button is fine for typical
  // catalog sizes (< 1000 strategies).
  list.querySelectorAll('[data-action="run-workflow"]').forEach(btn => {
    btn.addEventListener('click', () => testRunStrategy(btn.dataset.sid));
  });
  list.querySelectorAll('[data-action="edit-workflow"]').forEach(btn => {
    btn.addEventListener('click', () => editStrategy(btn.dataset.sid));
  });
  list.querySelectorAll('[data-action="json-workflow"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const s = await StorageManager.getStrategy(btn.dataset.sid);
      if (!s) { toast('Strategy not found', 'err'); return; }
      showJsonModal(`Strategy: ${s.name ?? s.id}`, s, 'strategy');
    });
  });
  list.querySelectorAll('[data-action="delete-workflow"]').forEach(btn => {
    btn.addEventListener('click', () => deleteStrategy(btn.dataset.sid));
  });
}

// v2.74.70 — Workflow entity list renderer. Separate from the Strategy
// catalog. Each row mirrors the catalog's visual grammar but exposes
// Workflow-specific actions (edit / delete). Run isn't wired yet because
// composition (steps[]) isn't implemented — once it is, the runner gates
// on `steps.length > 0` and routes through a Workflow execution engine.
function renderWorkflowEntityList() {
  const list = $('workflows-entity-list');
  if (!list) return;

  const workflows = _workflowsState.workflows;

  if (workflows.length === 0) {
    list.innerHTML = '<div class="workflows-empty">No Workflows yet. Click <em>+</em> in the header to create one.</div>';
    return;
  }

  // Stable sort: name ascending. Updated time is also surfaced per row.
  const sorted = [...workflows].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  list.innerHTML = sorted.map(w => {
    const stepCount = Array.isArray(w.steps) ? w.steps.length : 0;
    const stepLabel = stepCount === 0
      ? '<span class="workflow-entity-status status-draft">draft · no steps</span>'
      : `<span class="workflow-entity-status status-ready">${stepCount} step${stepCount === 1 ? '' : 's'}</span>`;
    // v2.74.83 — Surface aliases on the row so authors can see the
    // routing triggers at a glance. Up to 4 chips inline; "+N more" if
    // the Strategy declares many. Empty aliases → no chip strip.
    const aliasList = Array.isArray(w.aliases) ? w.aliases : [];
    const visibleAliases = aliasList.slice(0, 4);
    const aliasOverflow  = aliasList.length - visibleAliases.length;
    const aliasHtml = aliasList.length === 0 ? '' : `
      <div class="workflow-entity-aliases">
        ${visibleAliases.map(a => `<span class="workflow-entity-alias">${escHtml(a)}</span>`).join('')}
        ${aliasOverflow > 0 ? `<span class="workflow-entity-alias-more" title="${escAttr(aliasList.slice(4).join(', '))}">+${aliasOverflow} more</span>` : ''}
      </div>`;

    // v2.74.84 — Run / Cancel button flip. v2.74.91 — adds pause/resume
    // when an invocation is in-flight. State combinations:
    //   idle               → [ ▶ run ]
    //   running, unpaused  → [ ⏸ pause ] [ ■ cancel ]
    //   running, paused    → [ ▶ resume ] [ ■ cancel ]
    const invocationId = _workflowsState.runningInvocations.get(w.id);
    const isRunning = !!invocationId;
    const isPaused  = isRunning && _workflowsState.pausedInvocations.has(invocationId);

    let actionButtons;
    if (!isRunning) {
      // v2.74.92 — Debug button opens the dedicated debugger sidepanel
      // before invoking. ▶ keeps the lean toast-based run.
      actionButtons = `
        <button class="btn-action" data-action="run-workflow-entity"   data-wid="${escAttr(w.id)}" title="Run this Workflow">▶</button>
        <button class="btn-action" data-action="debug-workflow-entity" data-wid="${escAttr(w.id)}" title="Run with debugger sidepanel">◐</button>`;
    } else if (isPaused) {
      actionButtons = `
        <button class="btn-action is-paused" data-action="resume-workflow-entity" data-wid="${escAttr(w.id)}" title="Resume this run">▶</button>
        <button class="btn-action is-running" data-action="cancel-workflow-entity" data-wid="${escAttr(w.id)}" title="Cancel this run">■</button>`;
    } else {
      actionButtons = `
        <button class="btn-action is-running" data-action="pause-workflow-entity" data-wid="${escAttr(w.id)}" title="Pause this run">⏸</button>
        <button class="btn-action is-running" data-action="cancel-workflow-entity" data-wid="${escAttr(w.id)}" title="Cancel this run">■</button>`;
    }

    const statePill = isPaused
      ? '<span class="workflow-entity-paused-pill">paused</span>'
      : isRunning
        ? '<span class="workflow-entity-running-pill">running…</span>'
        : '';

    return `
      <div class="workflow-entity-row${isRunning ? ' is-running' : ''}${isPaused ? ' is-paused' : ''}" data-wid="${escAttr(w.id)}">
        <div class="workflow-entity-row-main">
          <span class="workflow-entity-name">${escHtml(w.name ?? 'Unnamed')}</span>
          ${stepLabel}
          ${statePill}
        </div>
        ${w.description ? `<div class="workflow-entity-desc">${escHtml(w.description)}</div>` : ''}
        ${aliasHtml}
        <div class="workflow-entity-row-meta">
          ${w.updatedAt ? `<span class="workflow-updated">updated ${escHtml(_relTime(w.updatedAt))}</span>` : ''}
        </div>
        <div class="workflow-entity-row-actions">
          ${actionButtons}
          <button class="btn-action" data-action="edit-workflow-entity"   data-wid="${escAttr(w.id)}" title="Edit">✎</button>
          <button class="btn-action" data-action="json-workflow-entity"   data-wid="${escAttr(w.id)}" title="View JSON">{ }</button>
          <button class="btn-action danger" data-action="delete-workflow-entity" data-wid="${escAttr(w.id)}" title="Delete">✕</button>
        </div>
      </div>`;
  }).join('');

  list.querySelectorAll('[data-action="run-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', () => testRunWorkflow(btn.dataset.wid));
  });
  list.querySelectorAll('[data-action="debug-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', () => testRunWorkflowDebug(btn.dataset.wid));
  });
  list.querySelectorAll('[data-action="cancel-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', () => cancelRunningWorkflow(btn.dataset.wid));
  });
  list.querySelectorAll('[data-action="pause-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', () => pauseRunningWorkflow(btn.dataset.wid));
  });
  list.querySelectorAll('[data-action="resume-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', () => resumeRunningWorkflow(btn.dataset.wid));
  });
  list.querySelectorAll('[data-action="edit-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const w = await StorageManager.getWorkflow(btn.dataset.wid);
      if (!w) { toast('Workflow not found', 'err'); return; }
      openWorkflowForm(w);
    });
  });
  list.querySelectorAll('[data-action="json-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const w = await StorageManager.getWorkflow(btn.dataset.wid);
      if (!w) { toast('Workflow not found', 'err'); return; }
      showJsonModal(`Workflow: ${w.name ?? w.id}`, w, 'workflow');
    });
  });
  list.querySelectorAll('[data-action="delete-workflow-entity"]').forEach(btn => {
    btn.addEventListener('click', () => deleteWorkflow(btn.dataset.wid));
  });
}

function _renderWorkflowRow(s) {
  const ground = _workflowsState.grounds.get(s.groundId);
  const sTier = s.implementations?.[0]?.tier ?? 'cache';
  const stepCount = countExecutableNodes(normalizeStrategyBody(s.fragmentSteps));

  const tierBadge = sTier === 'frontier'
    ? `<span class="strategy-tier-badge tier-frontier" title="T3 Composer-based">T3</span>`
    : `<span class="strategy-tier-badge tier-cache" title="T1 Hand-authored">T1</span>`;

  const stepLabel = sTier === 'frontier' ? 'composed at runtime' : `${stepCount} step${stepCount === 1 ? '' : 's'}`;
  const inputs = Array.isArray(s.params) ? s.params : [];
  const inputCount = inputs.length;
  const inputSummary = inputCount === 0
    ? '0 inputs'
    : `${inputCount} input${inputCount === 1 ? '' : 's'}: ${inputs.map(p => {
        const name = typeof p === 'string' ? p : (p?.name ?? '');
        const kind = typeof p === 'string' ? 'scalar' : (p?.kind ?? 'scalar');
        const type = typeof p === 'string' ? 'string' : (p?.type ?? 'string');
        const annot = [];
        if (kind === 'list') annot.push('list');
        if (type !== 'string') annot.push(type);
        return escHtml(name) + (annot.length ? ` (${annot.join(', ')})` : '');
      }).join(', ')}`;

  return `
    <div class="workflow-row" data-sid="${escAttr(s.id)}">
      <div class="workflow-row-main">
        <span class="workflow-name">${escHtml(s.name ?? 'Unnamed')}</span>
        ${tierBadge}
        <span class="workflow-ground-chip" title="${escAttr(ground?.url ?? '')}">${escHtml(ground?.name ?? '—')}</span>
        <span class="workflow-step-count">${escHtml(stepLabel)}</span>
      </div>
      ${s.goal ? `<div class="workflow-goal">${escHtml(s.goal)}</div>` : ''}
      <div class="workflow-row-meta">
        <span class="workflow-inputs">${inputSummary}</span>
        ${s.updatedAt ? `<span class="workflow-updated">updated ${escHtml(_relTime(s.updatedAt))}</span>` : ''}
      </div>
      <div class="workflow-row-actions">
        <button class="btn-action" data-action="run-workflow"    data-sid="${escAttr(s.id)}" title="Test-run this Strategy">▶</button>
        <button class="btn-action" data-action="edit-workflow"   data-sid="${escAttr(s.id)}" title="Edit on its Ground">✎</button>
        <button class="btn-action" data-action="json-workflow"   data-sid="${escAttr(s.id)}" title="View JSON">{ }</button>
        <button class="btn-action danger" data-action="delete-workflow" data-sid="${escAttr(s.id)}" title="Delete">✕</button>
      </div>
    </div>`;
}

// ─── Chat launcher from Studio ──────────────────────────────────────────────
//
// Studio's Chat button switches the side panel to chat.html. v2.74.146 —
// Route through the shared openSidepanelHere helper so a prior per-tab
// override (e.g. an active workflow-debug pinning sidepanel.html on the
// current tab) is displaced. Without setOptions, chrome.sidePanel.open
// reopens whatever path is currently bound — so clicking Chat after a
// debug session left the panel on the debugger surface.
//
// chrome.sidePanel.open requires a user gesture, so the click handler is
// the gesture; openSidepanelHere awaits internally without breaking it.

$('btn-open-chat')?.addEventListener('click', async () => {
  try {
    await openSidepanelHere('chat.html');
  } catch (err) {
    toast(`Couldn't open chat: ${err.message}`, 'err');
  }
});

// ─── v2.72.45 (Pass 17g iter) — Perspective capture launcher ─────────────────────
//
// Click "+ Perspective" on a Ground card → this helper opens the debugger
// sidepanel (preserving the click's user gesture for chrome.sidePanel.open)
// and sends BEGIN_PERSPECTIVE_CAPTURE to background, which:
//   1. Opens (or focuses) a tab on the Ground's URL
//   2. Re-injects the content script for reliable picker reach
//   3. Stores a pending session and broadcasts to the debugger
//
// All perspective authoring then happens in the debugger sidepanel — name,
// description, URL pattern (auto-synced to active tab), landmark
// selectors, save. Studio's role ends here; the debugger handles
// the loop. STORAGE_CHANGED broadcasts after each save refresh the
// Ground's perspective library row.
async function launchPerspectiveCapture(groundId) {
  // Open the sidepanel SYNCHRONOUSLY first (preserves user gesture).
  // v2.72.50 (Stage 1) — point the panel at sidepanel.html (the new
  // shell). Background's BEGIN_PERSPECTIVE_CAPTURE handler will set the mode
  // to 'perspective-capture' which the shell mounts.
  //
  // v2.74.140 — Use openSidepanelHere so a prior per-tab Chat override
  // doesn't leave the panel on chat.html.
  await openSidepanelHere('sidepanel.html');
  // Send BEGIN_PERSPECTIVE_CAPTURE. Background will open the Ground's URL
  // as the starting tab and set the mode (broadcasting
  // SIDEPANEL_MODE_CHANGED for the shell).
  let res;
  try {
    res = await chrome.runtime.sendMessage({
      type: 'BEGIN_PERSPECTIVE_CAPTURE',
      payload: { groundId },
    });
  } catch (e) {
    toast(`Could not start capture: ${e.message}`, 'err');
    return;
  }
  if (!res?.success) {
    toast(`Could not start capture: ${res?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast(`Capture started — author perspectives in the debugger sidepanel.`);
}

// ─── v2.27.0 — STORAGE_CHANGED listener ──────────────────────────────────────
//
// Background.js (and any UI context that directly edits storage) broadcasts
// STORAGE_CHANGED when shared records change. The sidepanel listens so that
// edits made in Studio (or anywhere else) refresh the sidepanel's views.
//
// Message 1 behavior: refresh the Ground list when anything changes. That's
// cheap (one storage read) and catches all the relevant kinds (grounds,
// fragments, strategies all live inside ground accordions).
//
// v2.74.954 (CR-X4b) — debounce bursts with a 150ms TRAILING timer. The old microtask flag only
// collapsed same-tick messages; a cascading delete arrives as N sequential MACROTASK messages, so the
// full Ground list re-rendered N times. The timer resets on every message and fires once, 150ms after
// the burst ends. (Direct refreshGroundList() callers are unaffected — they await the single-flight
// render as before; only this listener coalesces.)
let _storageRefreshTimer = null;
chrome.runtime.onMessage.addListener((msg, _sender, _sendResponse) => {
  if (msg?.type === 'STORAGE_CHANGED') {
    clearTimeout(_storageRefreshTimer);
    _storageRefreshTimer = setTimeout(async () => {
      try { await refreshGroundList(); } catch (_) { /* ignore */ }
      // v2.74.69 — keep the Workflows tab in sync; cheap re-derive from
      // storage, no UI flicker since the tab listens only when visible.
      try { await refreshWorkflows(); } catch (_) { /* ignore */ }
    }, 150);
  }
  return false;
});

// ─── State ────────────────────────────────────────────────────────────────────

let editingGroundId   = null;
let expandedGrounds   = new Set();

// ─── Grounds accordion ────────────────────────────────────────────────────────

/**
 * Pass A (v2.21.0) — slimmed Ground list.
 *
 * Each Ground renders as:
 *   - Header row (name, URL, aliases, 🗺 siteMap node badge, Discover/Edit/Delete buttons)
 *   - Site Map section (canonical structural viewer — GROUND_SPEC § 7)
 *   - Fragment stub row ("Fragments: N" with + Fragment button — stubbed in A, wired in B)
 *   - Strategy stub row ("Strategies: N" with + Strategy button — stubbed in A, wired in C)
 *
 * Removed in Pass A: Path cards, template/procedure/trace panels, question panel,
 * walk panel entry points, spot-toggle. Those surfaces came from the Path era
 * which is being wiped.
 */

// v2.72.33 (Pass 17c) — Compact display helpers for the assertion library
// section. Used by the Ground card's assertion row rendering. Pure
// functions; no shared state. Live here near refreshGroundList so the
// Ground card section can see them without import indirection.
function assertionConditionSummary(c) {
  if (!c) return '?';
  if (c.type === 'selector_present')  return `selector ${truncate(c.selector ?? '', 40)} appears`;
  if (c.type === 'selector_absent')   return `selector ${truncate(c.selector ?? '', 40)} absent`;
  if (c.type === 'url_matches')       return `url matches /${truncate(c.pattern ?? '', 40)}/`;
  if (c.type === 'text_present')      return `text "${truncate(c.text ?? '', 40)}" appears`;
  if (c.type === 'attribute_equals')  return `${truncate(c.selector ?? '', 30)}[${c.attribute ?? ''}]="${truncate(c.value ?? '', 20)}"`;
  if (c.type === 'assertion_ref')     return `@${c.assertionId ?? '?'}`;
  if (c.type === 'perspective_ref')        return `@perspective:${c.perspectiveId ?? '?'}`;
  return c.type ?? '?';
}

function truncate(s, n) {
  if (s == null) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// v2.70.5 — Single-flight serialization state for refreshGroundList.
// Declared before the function so the references resolve unambiguously.
let _refreshGroundListRunning = false;
let _refreshGroundListQueued = false;

// v2.74.9 — Verbose-fragment-description preference. Module-scoped cache
// of the user's toggle in Settings. Read once at studio boot, updated on
// toggle change, consulted at render time in renderFragmentDescription.
// Default false (compact). Lives in chrome.storage via SET_SETTING /
// GET_SETTING (background-side persistence — same pattern as the
// close-tab-after-run setting).
let _verboseFragmentDesc = false;
async function _loadVerboseFragmentDescPref() {
  try {
    const res = await new Promise(r =>
      chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'verbose_fragment_desc', defaultValue: false } }, r)
    );
    _verboseFragmentDesc = res?.value === true;
  } catch (_) {
    _verboseFragmentDesc = false;
  }
}
// Load the preference once at module init. Studio's initial Ground list
// render happens shortly after; if the load races and finishes after the
// first render, the toggle change handler triggers a re-render anyway.
_loadVerboseFragmentDescPref();

/**
 * Compute a fragment's description based on the current verbose preference.
 * Live-parses rawJson so old fragments respond to the toggle without
 * re-saving. Falls back to the stored f.description on parse failure.
 */
function renderFragmentDescription(f) {
  if (!f) return '';
  // Try live composition from rawJson — handles toggling between formats
  // without re-walk.
  if (typeof f.rawJson === 'string' && f.rawJson) {
    try {
      const actions = JSON.parse(f.rawJson);
      if (Array.isArray(actions) && actions.length > 0) {
        const both = composeDescriptions(actions);
        return _verboseFragmentDesc ? both.verbose : both.compact;
      }
    } catch (_) { /* fall through to stored field */ }
  }
  return f.description ?? '';
}

async function refreshGroundList() {
  // v2.70.5 — Single-flight serialization. Multiple call sites (save handlers,
  // STORAGE_CHANGED listener, init) can call this concurrently; without
  // serialization, two interleaved runs both clear+append against the same
  // list, producing duplicate cards as one's mid-iteration appends collide
  // with the other's clear-then-append.
  //
  // Pattern: if a render is in-flight, set _refreshGroundListQueued and
  // return. The currently-running render checks the flag on completion;
  // if set, runs a follow-up (clearing the flag). N concurrent calls
  // collapse into at most 2 sequential renders — current + one queued.
  if (_refreshGroundListRunning) {
    _refreshGroundListQueued = true;
    return;
  }
  _refreshGroundListRunning = true;
  try {
    await _refreshGroundListImpl();
    while (_refreshGroundListQueued) {
      _refreshGroundListQueued = false;
      await _refreshGroundListImpl();
    }
  } finally {
    _refreshGroundListRunning = false;
  }
}

async function _refreshGroundListImpl() {
  const grounds = await StorageManager.getAllGrounds();
  const list    = $('ground-list');

  if (grounds.length === 0) {
    list.innerHTML = '<p class="empty-state">No grounds yet. Add one above.</p>';
    return;
  }


  // v2.74.399 — Locale catalogs (Perspective capability model, PAGEMODEL_SPEC) live
  // under 'localeCache', keyed ground → url. Listed in the "Locales" section.
  let localeMap = {};
  try {
    const got = await new Promise(r => chrome.storage.local.get('localeCache', r));
    localeMap = got?.localeCache ?? {};
  } catch { localeMap = {}; }

  list.innerHTML = '';

  for (const ground of grounds) {
    await _renderGroundCard(ground, { list, localeMap });   // v2.74.954 (CR-X4b) — one card per ground
  }
}

// v2.74.954 (CR-X4b) — ONE Ground's accordion card, extracted whole from the 1,261-line
// _refreshGroundListImpl (which is now a fetch + a loop). The section blocks (Fragments /
// Assertions / Perspectives / Locales / Observations / Strategies / Site Map / Chrome / ...)
// remain inline within this builder, in their original order and indentation — the per-section
// split is deferred until the studio sections gain a live-smoke harness (it pairs with the
// CR-D8-deferred shared.js moves). Body is byte-identical to the old loop body.
async function _renderGroundCard(ground, { list, localeMap }) {
    // v2.74.434 — Ground siteMap (GROUND_SPEC § 7) replaces the retired
    // GroundMap. Fetched once here and reused by the header badge / Discover
    // label AND the Site Map section below (single GET_SITEMAP round trip).
    let siteMapRes = null;
    try { siteMapRes = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_SITEMAP', payload: { groundId: ground.id } }, r)); }
    catch { siteMapRes = null; }
    const smMap   = siteMapRes?.siteMap ?? null;
    const smStats = siteMapRes?.stats ?? null;
    const hasMap  = !!(smStats && smStats.nodes > 0);
    // v2.74.484 — Ground.chrome (GROUND_SPEC § 4): the global header/nav/footer controls
    // hoisted off the per-archetype Locales (modeled once, not per page). Fetched here so the
    // Chrome section renders inline alongside the Site Map. Best-effort.
    let chromeRes = null;
    try { chromeRes = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_GROUND_CHROME', payload: { groundId: ground.id } }, r)); }
    catch { chromeRes = null; }
    const fragments = await StorageManager.listFragments(ground.id);
    const strategies = await StorageManager.listStrategies(ground.id);
    const assertions = await StorageManager.listAssertions(ground.id);
    const analyses = await StorageManager.listAnalyses(ground.id);
    // v2.65.0 (Pass 2) — Observations are foundation-only. Listed here for
    // count display in the Ground card; no authoring or runtime yet.
    const observations = await StorageManager.listObservations(ground.id);
    // v2.72.29 (Pass 17) — Perspectives: vocabulary (verified DOM landmarks).
    const perspectives = await StorageManager.listPerspectives(ground.id);

    // v2.74.329 — GROUND_SPEC § 5 derived intent. Effective description =
    // override ?? derived ?? placeholder; stale = Perspectives changed since the
    // cached derivation.
    const descStale = isDerivationStale(ground, perspectives);
    const descText  = effectiveDescription(ground, perspectives);
    const descKind  = ground.descriptionOverride ? 'override' : (ground.derivedDescription ? 'derived' : '');

    // v2.74.434 — Static 🗺 node-count badge. The Site Map section below is the
    // canonical viewer (the old click-to-toggle GroundMap viewer was retired).
    const mapBadge = hasMap
      ? `<span class="groundmap-badge" title="Site map — ${smStats.modeled} modeled · ${smStats.discovered} discovered${smStats.stub ? ` · ${smStats.stub} stub` : ''} · ${smStats.edges} edge(s)">🗺 ${smStats.nodes} node${smStats.nodes === 1 ? '' : 's'}</span>`
      : '';

    // v2.28.4 — Visual grouping. Each Ground renders as a single card
    // containing the header + Fragments section + Strategies section.
    // Previously these were three DOM siblings with no visual envelope —
    // users couldn't tell which Fragments belonged to which Ground at a
    // glance. Wrapping them in a card with subtle background + rounded
    // corners + internal dividers establishes the parent-child relationship
    // visually through containment (Gestalt proximity + common region).
    const card = document.createElement('div');
    card.className = 'ground-card';
    // v2.74.330 — GROUND_SPEC § 9: visually distinguish deprecated Grounds.
    if (ground.metadata?.lifecycle === 'deprecated') card.classList.add('ground-card-deprecated');
    card.dataset.id = ground.id;

    const groupHeader = document.createElement('div');
    groupHeader.className = 'ground-group-header';
    groupHeader.innerHTML = `
      <button class="ground-card-collapse-toggle" data-action="toggle-collapse" data-gid="${escAttr(ground.id)}" title="Collapse / expand this Ground card" aria-label="Collapse Ground card" aria-expanded="true">
        <span class="ground-card-collapse-chevron" aria-hidden="true">▾</span>
      </button>
      <div class="ground-group-info">
        <span class="ground-group-name">${escHtml(ground.name ?? 'Unnamed Ground')}${
          ground.metadata?.lifecycle === 'deprecated'
            ? ` <span class="ground-lifecycle-badge ground-lifecycle-deprecated" title="Deprecated (soft-deleted). Hidden from active URL matching; reactivate to restore.">deprecated</span>`
            : (ground.metadata?.lifecycle === 'draft'
                ? ` <span class="ground-lifecycle-badge ground-lifecycle-draft" title="Draft — no Perspectives yet. Not active for URL matching until it has at least one Perspective.">draft</span>`
                : '')}</span>
        <span class="ground-group-url">${escHtml(ground.url ?? '')}</span>
        <div class="ground-group-desc">
          <span class="ground-group-desc-text ${descText ? '' : 'ground-group-desc-empty'}">${escHtml(descText || '(no description yet — click ↻ to derive from Perspectives)')}</span>
          <span class="ground-desc-badges">
            ${descKind === 'override' ? `<span class="ground-desc-tag ground-desc-tag-override" title="Custom description (override). Clear it to fall back to the auto-derived one.">overridden</span>` : (descKind === 'derived' ? `<span class="ground-desc-tag" title="Auto-derived from this Ground's Perspectives (GROUND_SPEC § 5).">derived</span>` : '')}
            ${descStale ? `<span class="ground-desc-tag ground-desc-tag-stale" title="Perspectives changed since this was derived — click ↻ to refresh.">stale</span>` : ''}
          </span>
          <button class="btn-action ground-desc-refresh" data-action="derive-desc" data-gid="${escAttr(ground.id)}" title="Derive / refresh the description from this Ground's Perspectives (calls the LLM)" ${perspectives.length === 0 ? 'disabled' : ''}>↻</button>
          <button class="btn-action ground-desc-override-btn" data-action="override-desc" data-gid="${escAttr(ground.id)}" title="${ground.descriptionOverride ? 'Edit or clear the custom description' : 'Write a custom description (overrides the derived one)'}">✎</button>
        </div>
        <div class="ground-group-meta">
          ${mapBadge}
          ${ground.aliases?.length ? `<div class="ground-alias-tags">${ground.aliases.map(a => `<span class="ground-alias-tag">${escHtml(a)}</span>`).join('')}</div>` : ''}
        </div>
      </div>
      <div class="ground-group-actions">
        <button class="btn-secondary small" data-action="discover"     data-gid="${escAttr(ground.id)}" title="${hasMap ? 'Re-discover' : 'Discover structural map of this Ground (read-only crawl)'}">${hasMap ? '↻ Rediscover' : '🔍 Discover'}</button>
        <button class="btn-action" data-action="edit-ground"           data-gid="${escAttr(ground.id)}" title="Edit Ground">✎</button>
        ${ground.metadata?.lifecycle === 'deprecated'
          ? `<button class="btn-secondary small" data-action="reactivate-ground" data-gid="${escAttr(ground.id)}" title="Reactivate this Ground (restore to active)">↑ Reactivate</button>`
          : `<button class="btn-action" data-action="deprecate-ground" data-gid="${escAttr(ground.id)}" title="Deprecate (soft-delete) — hide from active use, reversible">⤓</button>`}
        <button class="btn-action danger" data-action="delete-ground"  data-gid="${escAttr(ground.id)}" title="Delete Ground permanently (and everything on it)">✕</button>
      </div>
      <div class="ground-discovery-panel hidden" id="discovery-panel-${escAttr(ground.id)}"></div>`;

    // v2.74.8 — Collapse toggle. Hides all the .ground-section-row children
    // (Fragments, Assertions, Perspectives, Observations, Analyses, Strategies)
    // when the user wants to focus on a different Ground. Header stays
    // visible so name, url, badges, and action buttons remain accessible.
    // Ephemeral state — lost on reload. Default expanded.
    groupHeader.querySelector('[data-action="toggle-collapse"]').addEventListener('click', (e) => {
      e.stopPropagation();
      const collapsed = card.classList.toggle('ground-card-collapsed');
      const btn = e.currentTarget;
      const chev = btn.querySelector('.ground-card-collapse-chevron');
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', collapsed ? 'Expand Ground card' : 'Collapse Ground card');
      if (chev) chev.textContent = collapsed ? '▸' : '▾';
    });

    // v2.74.329 — Derive / refresh the Ground description from its Perspectives.
    // force=false: respects the cache (returns "up to date" when unchanged),
    // derives when stale or never-derived. Lazy/manual — only on click.
    groupHeader.querySelector('[data-action="derive-desc"]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = '⏳';
      const res = await new Promise(r => chrome.runtime.sendMessage(
        { type: 'DERIVE_GROUND_DESCRIPTION', payload: { groundId: ground.id, force: false } }, r));
      if (res?.success) {
        toast(res.cached ? 'Description already up to date' : 'Description derived');
        await refreshGroundList();
      } else {
        toast(`Derive failed: ${res?.error ?? 'unknown'}`, 'err');
        btn.disabled = false; btn.textContent = orig;
      }
    });
    // v2.74.329 — Set / clear the description override.
    groupHeader.querySelector('[data-action="override-desc"]')?.addEventListener('click', async () => {
      const cur = ground.descriptionOverride ?? '';
      const next = prompt('Custom Ground description (leave blank to clear and use the auto-derived one):', cur);
      if (next === null) return;  // cancelled
      const res = await new Promise(r => chrome.runtime.sendMessage(
        { type: 'SET_GROUND_DESCRIPTION_OVERRIDE', payload: { groundId: ground.id, override: next } }, r));
      if (res?.success) {
        toast(next.trim() ? 'Description overridden' : 'Override cleared');
        await refreshGroundList();
      } else {
        toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      }
    });

    // v2.74.330 — GROUND_SPEC § 9 deprecate (soft-delete) / reactivate.
    groupHeader.querySelector('[data-action="deprecate-ground"]')?.addEventListener('click', async () => {
      if (!confirm(`Deprecate Ground "${ground.name}"? It's hidden from active URL matching but kept — you can reactivate it any time.`)) return;
      const res = await new Promise(r => chrome.runtime.sendMessage(
        { type: 'SET_GROUND_LIFECYCLE', payload: { groundId: ground.id, lifecycle: 'deprecated' } }, r));
      if (res?.success) { toast('Ground deprecated'); await refreshGroundList(); }
      else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
    });
    groupHeader.querySelector('[data-action="reactivate-ground"]')?.addEventListener('click', async () => {
      const res = await new Promise(r => chrome.runtime.sendMessage(
        { type: 'SET_GROUND_LIFECYCLE', payload: { groundId: ground.id, lifecycle: 'active' } }, r));
      if (res?.success) { toast('Ground reactivated'); await refreshGroundList(); }
      else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
    });

    groupHeader.querySelector('[data-action="edit-ground"]').addEventListener('click', () => openGroundForm(ground));
    groupHeader.querySelector('[data-action="delete-ground"]').addEventListener('click', () => {
      // v2.74.327 — Message reflects the full Tier-1 cascade (GROUND_SPEC
      // § 11). Landmarks are preserved (orphaned) per spec, so they're
      // excluded from this list.
      if (confirm(`Delete Ground "${ground.name}" and all its Fragments, Strategies, Perspectives, Observations, Analyses, and Assertions? Captured landmarks are kept. This cannot be undone.`)) {
        deleteGround(ground.id);
      }
    });
    groupHeader.querySelector('[data-action="discover"]').addEventListener('click', () => startDiscovery(ground.id));
    card.appendChild(groupHeader);

    // Fragments stub row — wired in Pass B
    const fragRow = document.createElement('div');
    fragRow.className = 'ground-section-row';
    fragRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Fragments</span>
        <span class="ground-section-count">${fragments.length}</span>
        <button class="btn-secondary tiny" data-action="add-fragment" data-gid="${escAttr(ground.id)}" title="Record a new Fragment">+ Fragment</button>
      </div>
      <div class="ground-section-body" id="fragments-body-${escAttr(ground.id)}">
        ${fragments.length === 0
          ? `<span class="empty-state small">No Fragments yet — record page-state transitions as reusable units.</span>`
          : fragments.map(f => {
              // Pass B+ — resolve antecedent name for a compact library indicator
              const antecedentName = f.antecedentFragmentId
                ? (fragments.find(x => x.id === f.antecedentFragmentId)?.name ?? '?')
                : null;
              return `
            <div class="fragment-row${f.lifecycle === 'deprecated' ? ' fragment-row-deprecated' : ''}" data-fid="${f.id}">
              <div class="fragment-row-main">
                <span class="fragment-name">${escHtml(f.name ?? 'Unnamed')}</span>
                <span class="fragment-tier tier-${(f.authoringTier ?? 'T3').toLowerCase()}" title="Authoring tier — ${(f.authoringTier ?? 'T3') === 'T1' ? 'hand-authored' : 'AI-walked'}">${escHtml(f.authoringTier ?? 'T3')}</span>
                <span class="fragment-health health-${f.healthStatus ?? 'untested'}">${escHtml(f.healthStatus ?? 'untested')}</span>
                ${f.lifecycle === 'deprecated' ? '<span class="ground-lifecycle-badge ground-lifecycle-deprecated" title="Deprecated (soft-deleted). Kept but excluded from active use; reactivate to restore.">deprecated</span>' : ''}
              </div>
              ${(() => {
                // v2.74.9 — Description rendered live from rawJson via
                // renderFragmentDescription so toggling verbose mode in
                // Settings switches between compact and multi-line forms
                // without requiring re-walk. Empty string suppresses the
                // div entirely.
                // v2.74.11 — Inline white-space:pre-line so verbose mode's
                // newlines render as line breaks even when the stylesheet
                // is cached without that rule. The CSS file also has the
                // rule for completeness.
                const desc = renderFragmentDescription(f);
                return desc
                  ? `<div class="fragment-desc" style="white-space:pre-line">${escHtml(desc)}</div>`
                  : '';
              })()}
              ${antecedentName ? `<div class="fragment-antecedent-indicator">↑ after <strong>${escHtml(antecedentName)}</strong></div>` : ''}
              <div class="fragment-row-actions">
                <span class="fragment-meta">${(f.preconditions?.length ?? 0)} pre · ${(f.postconditions?.length ?? 0)} post · ${(f.params?.length ?? 0)} param${(f.params?.length === 1) ? '' : 's'}</span>
                <button class="btn-action" data-action="edit-fragment" data-fid="${f.id}" title="Edit name, description, or conditions (rawJson untouched)">✎</button>
                ${(() => {
                  // v2.72.6 (Pass 5) — Migrate to Observation button. Visible
                  // (faded if disabled) for every fragment so users learn it
                  // exists; tooltip explains eligibility per fragment.
                  const cls = classifyFragmentForMigration(f);
                  const title = cls.eligible
                    ? `Migrate to Observation (${cls.kind === 'enumerate' ? 'list_of_records' : 'scalar'} shape). Source Fragment is kept; you'll need to update Strategies manually.`
                    : `Not migratable: ${cls.reason}`;
                  return `<button class="btn-action${cls.eligible ? '' : ' migrate-disabled'}"
                            data-action="migrate-fragment" data-fid="${f.id}"
                            title="${escAttr(title)}"
                            ${cls.eligible ? '' : 'disabled'}>↪</button>`;
                })()}
                <button class="btn-action" data-action="rewalk-fragment" data-fid="${f.id}" title="Re-walk this Fragment (replace its DOM actions)">↻</button>
                ${f.authoringTier === 'T1' ? `<button class="btn-action" data-action="enhance-fragment" data-fid="${f.id}" title="Auto-insert WAIT/BLUR transition gates between actions (T1 only)">✨</button>` : ``}
                <button class="btn-action" data-action="json-fragment" data-fid="${f.id}" title="View JSON (read-only, copyable)">{ }</button>
                ${f.lifecycle === 'deprecated'
                  ? `<button class="btn-secondary small" data-action="reactivate-fragment" data-fid="${f.id}" title="Reactivate this Fragment (restore to active)">↑</button>`
                  : `<button class="btn-action" data-action="deprecate-fragment" data-fid="${f.id}" title="Deprecate (soft-delete) — keep but flag as deprecated, reversible">⤓</button>`}
                <button class="btn-action danger" data-action="delete-fragment" data-fid="${f.id}" title="Delete Fragment">✕</button>
              </div>
            </div>`;
          }).join('')
        }
      </div>`;
    fragRow.querySelector('[data-action="add-fragment"]').addEventListener('click', async () => {
      // v2.74.22 — + Fragment now opens the sidepanel observation-author
      // mode-equivalent for fragments directly. AI-walked (T3) authoring
      // is gone; cache (T1) is the only path. Mirrors + Observation.
      const fragmentId = `frag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // v2.74.140 — Use openSidepanelHere so a prior per-tab Chat override
      // doesn't leave the panel on chat.html.
      await openSidepanelHere('sidepanel.html');
      chrome.runtime.sendMessage({
        type: 'BEGIN_FRAGMENT_AUTHOR',
        payload: {
          fragmentId,
          groundId : ground.id,
          groundUrl: ground.url,
          name: '',
          description: '',
          pageClass: null,
          isRewalk : false,
          // Antecedent is picked from the in-mode card; nothing seeded here.
          antecedentFragmentId    : null,
          antecedentParamBindings : null,
        },
      });
    });
    // Wire per-Fragment actions
    fragRow.querySelectorAll('[data-action="edit-fragment"]').forEach(btn => {
      btn.addEventListener('click', () => editFragment(btn.dataset.fid));
    });
    // v2.72.6 (Pass 5) — Migrate to Observation
    fragRow.querySelectorAll('[data-action="migrate-fragment"]').forEach(btn => {
      btn.addEventListener('click', () => openMigrationModal(ground.id, btn.dataset.fid));
    });
    fragRow.querySelectorAll('[data-action="rewalk-fragment"]').forEach(btn => {
      btn.addEventListener('click', () => rewalkFragment(btn.dataset.fid));
    });
    fragRow.querySelectorAll('[data-action="enhance-fragment"]').forEach(btn => {
      btn.addEventListener('click', () => enhanceFragment(btn.dataset.fid));
    });
    fragRow.querySelectorAll('[data-action="json-fragment"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const f = await StorageManager.getFragment(btn.dataset.fid);
        if (!f) { toast('Fragment not found', 'err'); return; }
        showJsonModal(`Fragment: ${f.name ?? f.id}`, f, 'fragment');
      });
    });
    fragRow.querySelectorAll('[data-action="delete-fragment"]').forEach(btn => {
      btn.addEventListener('click', () => deleteFragment(btn.dataset.fid));
    });
    // v2.74.510 — STORAGE_SCHEMA §9/§10 deprecate (soft-delete) / reactivate.
    fragRow.querySelectorAll('[data-action="deprecate-fragment"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Deprecate this Fragment? It\'s kept but flagged deprecated — reactivate it any time.')) return;
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'DEPRECATE_PRIMITIVE', payload: { kind: 'fragment', id: btn.dataset.fid } }, r));
        if (res?.success) { toast('Fragment deprecated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    fragRow.querySelectorAll('[data-action="reactivate-fragment"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'RESTORE_PRIMITIVE', payload: { kind: 'fragment', id: btn.dataset.fid } }, r));
        if (res?.success) { toast('Fragment reactivated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    card.appendChild(fragRow);

    // v2.42.0 (Pass M2) — Assertions section. Like fragments but for
    // named conditions. Authors save commonly-used checks here and
    // reference them from DETECT/LOOP/WAIT/postconditions.
    const predRow = document.createElement('div');
    predRow.className = 'ground-section-row';
    predRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Assertions</span>
        <span class="ground-section-count">${assertions.length}</span>
        <button class="btn-secondary tiny" data-action="add-assertion" data-gid="${escAttr(ground.id)}" title="Create a new named assertion">+ Assertion</button>
      </div>
      <div class="ground-section-body" id="assertions-body-${escAttr(ground.id)}">
        ${assertions.length === 0
          ? `<span class="empty-state small">No assertions yet — assertions are <strong>vocabulary</strong>, not primitives. They're saved condition expressions referenced from primitive pre/post envelopes (DETECT branches, LOOP exit checks, Analysis preconditions, etc.) via assertion_ref.</span>`
          : assertions.map(p => {
              const cs = p.body?.conditions ?? [];
              const mode = p.body?.match ?? 'all';
              // v2.47.0 (Pass O2) — k_of_n shows "K of N conditions"
              const condSummary = cs.length === 0 ? '(empty)'
                : cs.length === 1 ? assertionConditionSummary(cs[0])
                : mode === 'k_of_n' ? `${p.body?.count ?? '?'} of ${cs.length} conditions`
                : `${cs.length} conditions ${mode === 'any' ? 'OR' : 'AND'}`;
              return `
            <div class="assertion-row" data-pid="${escAttr(p.id)}">
              <div class="assertion-row-main">
                <span class="assertion-name">${escHtml(p.name ?? 'Unnamed')}</span>
                ${p.authoredBy === 'model' ? `<span class="assertion-generated-badge" title="Authored by model — generated from a description, then saved as a regular T1 artifact. Edit freely.">⚡</span>` : ''}
                <span class="assertion-summary">${escHtml(condSummary)}</span>
              </div>
              ${p.description ? `<div class="assertion-desc">${escHtml(p.description)}</div>` : ''}
              <div class="assertion-row-actions">
                <button class="btn-action" data-action="edit-assertion" data-pid="${escAttr(p.id)}" title="Edit assertion">✎</button>
                <button class="btn-action" data-action="json-assertion" data-pid="${escAttr(p.id)}" title="View JSON (read-only, copyable)">{ }</button>
                <button class="btn-action danger" data-action="delete-assertion" data-pid="${escAttr(p.id)}" title="Delete assertion">✕</button>
              </div>
            </div>`;
          }).join('')
        }
      </div>`;
    predRow.querySelector('[data-action="add-assertion"]').addEventListener('click', () => {
      openAssertionForm(ground.id, null);
    });
    predRow.querySelectorAll('[data-action="edit-assertion"]').forEach(btn => {
      btn.addEventListener('click', () => openAssertionForm(ground.id, btn.dataset.pid));
    });
    predRow.querySelectorAll('[data-action="json-assertion"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const p = await StorageManager.getAssertion(btn.dataset.pid);
        if (!p) { toast('Assertion not found', 'err'); return; }
        showJsonModal(`Assertion: ${p.name ?? p.id}`, p, 'assertion');
      });
    });
    predRow.querySelectorAll('[data-action="delete-assertion"]').forEach(btn => {
      btn.addEventListener('click', () => deleteAssertion(btn.dataset.pid));
    });
    card.appendChild(predRow);

    // v2.72.29 (Pass 17) — Perspectives section. Vocabulary, like Assertions,
    // but for verified DOM landmark records rather than logical assertions.
    // Referenced from primitive contracts via `perspective_ref` to assert "this
    // primitive runs on that kind of page."
    const perspectiveRow = document.createElement('div');
    perspectiveRow.className = 'ground-section-row';
    perspectiveRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Perspectives</span>
        <span class="ground-section-count">${perspectives.length}</span>
        <button class="btn-secondary tiny" data-action="add-perspective" data-gid="${escAttr(ground.id)}" title="Author a new Perspective (verified DOM landmarks for a kind of page)">+ Perspective</button>
      </div>
      <div class="ground-section-body" id="perspectives-body-${escAttr(ground.id)}">
        ${perspectives.length === 0
          ? `<span class="empty-state small">No Perspectives yet — Perspectives are <strong>vocabulary</strong>: verified DOM landmark records. Author one when you have a "kind of page" (e.g. search-results, job-detail) whose structural elements multiple primitives will need.</span>`
          : perspectives.map(l => {
              // v2.74.335 — landmarks is now LandmarkNode[]; count via the
              // flat landmarkRefs mirror. lifecycle drives the deprecated UI.
              const isDeprecated = l.lifecycle === 'deprecated';
              const lmCount = Array.isArray(l.landmarkRefs)
                ? l.landmarkRefs.length
                : (Array.isArray(l.landmarks) ? l.landmarks.length : 0);
              const verifiedAts = (l.landmarks ?? [])
                .map(lm => lm?.verified?.verifiedAt)
                .filter(t => Number.isFinite(t));
              const oldestVerified = verifiedAts.length > 0 ? Math.min(...verifiedAts) : null;
              const verifiedSummary = oldestVerified
                ? `last verified ${relTime(oldestVerified)}`
                : 'unverified';
              return `
            <div class="perspective-row${isDeprecated ? ' perspective-row-deprecated' : ''}" data-lid="${l.id}">
              <div class="perspective-row-main">
                <span class="perspective-name">${escHtml(l.name ?? 'Unnamed')}</span>
                ${l.authoredBy === 'model' ? `<span class="assertion-generated-badge" title="Authored by model.">⚡</span>` : ''}
                ${isDeprecated ? `<span class="ground-lifecycle-badge ground-lifecycle-deprecated" title="Deprecated (soft-deleted). Excluded from the active set + authoring; reactivate to restore.">deprecated</span>` : ''}
                <span class="perspective-summary">${lmCount} landmark${lmCount === 1 ? '' : 's'} · ${escHtml(verifiedSummary)}</span>
              </div>
              ${l.description ? `<div class="perspective-desc">${escHtml(l.description)}</div>` : ''}
              <div class="perspective-row-actions">
                <button class="btn-action" data-action="json-perspective" data-lid="${l.id}" title="View JSON (read-only, copyable)">{ }</button>
                ${isDeprecated
                  ? `<button class="btn-secondary small" data-action="reactivate-perspective" data-lid="${l.id}" title="Reactivate this Perspective (restore to active)">↑</button>`
                  : `<button class="btn-action" data-action="deprecate-perspective" data-lid="${l.id}" title="Deprecate (soft-delete) — hide from active set + authoring, reversible">⤓</button>`}
                <button class="btn-action danger" data-action="delete-perspective" data-lid="${l.id}" title="Delete perspective">✕</button>
              </div>
            </div>`;
            }).join('')
        }
      </div>`;
    perspectiveRow.querySelector('[data-action="add-perspective"]').addEventListener('click', async () => {
      await launchPerspectiveCapture(ground.id);
    });
    // v2.72.45 (Pass 17g iter) — Edit-perspective removed. The new debugger-based
    // capture flow doesn't support editing existing perspectives; users delete +
    // re-create. Edit can return in a future pass if/when the debugger gets
    // a "load existing for re-capture" mode.
    perspectiveRow.querySelectorAll('[data-action="json-perspective"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const l = await StorageManager.getPerspective(btn.dataset.lid);
        if (!l) { toast('Perspective not found', 'err'); return; }
        showJsonModal(`Perspective: ${l.name ?? l.id}`, l, 'perspective');
      });
    });
    perspectiveRow.querySelectorAll('[data-action="delete-perspective"]').forEach(btn => {
      btn.addEventListener('click', () => deletePerspective(btn.dataset.lid));
    });
    // v2.74.335 — PERSPECTIVE_SPEC § 12 deprecate (soft-delete) / reactivate.
    perspectiveRow.querySelectorAll('[data-action="deprecate-perspective"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Deprecate this Perspective? It will be excluded from the active set and authoring, but kept — reactivate it any time.')) return;
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'SET_PERSPECTIVE_LIFECYCLE', payload: { perspectiveId: btn.dataset.lid, lifecycle: 'deprecated' } }, r));
        if (res?.success) { toast('Perspective deprecated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    perspectiveRow.querySelectorAll('[data-action="reactivate-perspective"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'SET_PERSPECTIVE_LIFECYCLE', payload: { perspectiveId: btn.dataset.lid, lifecycle: 'active' } }, r));
        if (res?.success) { toast('Perspective reactivated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    card.appendChild(perspectiveRow);


    // v2.74.399 — Locales section. The Locale capability catalog
    // (PAGEMODEL_SPEC): a whole-page Feature list (input/action/disclosure/
    // navigation/collection/region) built read-only at L0, cached per (ground,
    // normalized URL). Listed here so captures are inspectable across sessions.
    const locales = (localeMap && localeMap[ground.id]) ? localeMap[ground.id] : {};
    const localeEntries = Object.entries(locales)
      .sort((a, b) => (b[1]?.capturedAt ?? 0) - (a[1]?.capturedAt ?? 0));
    const localeRow = document.createElement('div');
    localeRow.className = 'ground-section-row';
    localeRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Locales</span>
        <span class="ground-section-count">${localeEntries.length}</span>
      </div>
      <div class="ground-section-body" id="locales-body-${escAttr(ground.id)}">
        ${localeEntries.length === 0
          ? `<span class="empty-state small">No Locales yet — a <strong>Locale</strong> is the page's capability catalog (every Feature on the page, with selectors + scroll positions), built read-only by Explore or the side panel's "🗂 Build Locale".</span>`
          : localeEntries.map(([key, entry]) => {
              const m = entry?.model ?? {};
              const feats = m.features ? Object.values(m.features) : [];
              const byKind = {};
              for (const f of feats) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;
              const order = ['input', 'action', 'disclosure', 'navigation', 'collection', 'region'];
              const counts = order.filter(k => byKind[k]).map(k => `${byKind[k]} ${k}`).join(' · ');
              const full = entry?.url || m.url || key;
              let path = key;
              try { const u = new URL(full); path = (u.pathname || '/') + (u.search || ''); } catch { /* keep key */ }
              const bits = [`${feats.length} feature(s)`];
              if (counts) bits.push(counts);
              if (m.coverage?.bands) bits.push(`${m.coverage.bands} band(s)`);
              if (m.coverage?.fidelity) bits.push(m.coverage.fidelity);
              if (entry?.capturedAt) bits.push(relTime(entry.capturedAt));
              return `
            <div class="page-structure-row" data-locale-key="${escAttr(key)}">
              <div class="page-structure-row-main">
                <span class="page-structure-path" title="${escAttr(full)}">${escHtml(path)}</span>
                <span class="page-structure-summary">${escHtml(bits.join(' · '))}</span>
              </div>
              <div class="page-structure-row-actions">
                <button class="btn-action" data-action="json-locale" data-locale-key="${escAttr(key)}" title="View the full Locale JSON (features + layers + goals + index)">{ }</button>
                <button class="btn-action danger" data-action="delete-locale" data-locale-key="${escAttr(key)}" title="Delete this Locale (next Explore / Build Locale will re-enumerate)">✕</button>
              </div>
            </div>`;
            }).join('')
        }
      </div>`;
    localeRow.querySelectorAll('[data-action="json-locale"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const entry = locales[btn.dataset.localeKey];
        if (!entry?.model) { toast('Locale not found', 'err'); return; }
        showJsonModal(`Locale: ${btn.dataset.localeKey}`, entry.model, 'locale');
      });
    });
    localeRow.querySelectorAll('[data-action="delete-locale"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.localeKey;
        if (!confirm('Delete this Locale? The next Explore / Build Locale on this page will re-enumerate it.')) return;
        try {
          const res = await new Promise(r => chrome.runtime.sendMessage({
            type: 'DELETE_LOCALE',
            payload: { groundId: ground.id, localeKey: key },
          }, r));
          if (!res?.success) {
            toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
            return;
          }
          toast('Locale deleted');
          await refreshGroundList();
        } catch (e) { toast(`Failed: ${e?.message ?? 'unknown'}`, 'err'); }
      });
    });
    card.appendChild(localeRow);

    // v2.74.416 — OUTCOMES slice 5: the unified append-only stream viewer
    // (OUTCOMES_SPEC). Reads the background fold (GET_OUTCOMES) — recent events
    // (phase/op/verdict), the conventions histogram, and rollup tallies for
    // Feature health + Perspective usage. Read-only inspector + clear control.
    let outcomes = null;
    try {
      outcomes = await new Promise(r => chrome.runtime.sendMessage(
        { type: 'GET_OUTCOMES', payload: { groundId: ground.id, includeEvents: true, limit: 60 } }, r));
    } catch { outcomes = null; }
    const oRoll = outcomes?.rollups ?? null;
    const oEvents = Array.isArray(outcomes?.events) ? outcomes.events : [];
    const oCount = outcomes?.eventCount ?? 0;
    const oRow = document.createElement('div');
    oRow.className = 'ground-section-row';
    {
      const conv = oRoll?.conventions;
      const convStr = (conv && conv.total)
        ? Object.entries(conv.selectorTierHistogram || {}).filter(([, f]) => f > 0)
            .sort((a, b) => b[1] - a[1]).map(([t, f]) => `${t} ${Math.round(f * 100)}%`).join(' · ')
        : '';
      const fh = oRoll?.featureHealth ?? {};
      const fhVals = Object.values(fh);
      const stale = fhVals.filter(h => h?.lifecycle === 'stale-suspected').length;
      const pu = oRoll?.perspectiveUsage ?? {};
      const puVals = Object.values(pu);
      const avgSucc = puVals.length ? Math.round(puVals.reduce((a, h) => a + (h?.successRate ?? 0), 0) / puVals.length * 100) : null;
      const summaryBits = [];
      if (convStr) summaryBits.push(`conventions: ${convStr}`);
      if (fhVals.length) summaryBits.push(`${fhVals.length} feature(s) tracked${stale ? ` · ${stale} stale-suspected` : ''}`);
      if (puVals.length) summaryBits.push(`${puVals.length} perspective(s)${avgSucc != null ? ` · ${avgSucc}% avg success` : ''}`);
      const VERDICT_ICON = { verified: '✓', failed: '✗', abstained: '∅', corrected: '✎' };
      const eventsHtml = oEvents.slice(0, 12).map(ev => {
        const v = ev.verdict || ev.outcome || '?';
        const icon = VERDICT_ICON[ev.verdict] ?? (ev.outcome === 'success' ? '✓' : ev.outcome === 'failure' ? '✗' : '·');
        const sel = ev.llmOutput?.selector || ev.humanFinal?.selector || '';
        const label = ev.role || ev.featureId || ev.perspectiveId || '';
        return `<div class="outcomes-event outcomes-${escAttr(v)}">
            <span class="outcomes-ev-icon">${icon}</span>
            <span class="outcomes-ev-op">${escHtml(ev.op || '?')}</span>
            <span class="outcomes-ev-label" title="${escAttr(sel)}">${escHtml(label)}</span>
            <span class="outcomes-ev-ts">${ev.ts ? relTime(ev.ts) : ''}</span>
          </div>`;
      }).join('');
      oRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Outcomes</span>
        <span class="ground-section-count">${oCount}</span>
        ${oCount ? `<button class="btn-secondary tiny" data-action="json-outcomes" data-gid="${escAttr(ground.id)}" title="View the full rollups (Feature health · Perspective usage · conventions histogram) as JSON">{ }</button>
        <button class="btn-secondary tiny danger" data-action="clear-outcomes" data-gid="${escAttr(ground.id)}" title="Clear this ground's outcome stream (rollups recompute empty)">✕</button>` : ''}
      </div>
      <div class="ground-section-body" id="outcomes-body-${escAttr(ground.id)}">
        ${oCount === 0
          ? `<span class="empty-state small">No outcomes yet — the append-only stream fills as you <strong>⚡ Resolve roles</strong> (each verdict becomes a training pair; verified selectors build the site's <em>conventions histogram</em>).</span>`
          : `${summaryBits.length ? `<div class="outcomes-summary">${escHtml(summaryBits.join('  ·  '))}</div>` : ''}
             <div class="outcomes-events">${eventsHtml}${oEvents.length > 12 ? `<div class="empty-state small">+${oEvents.length - 12} more recent event(s) — see JSON</div>` : ''}</div>`
        }
      </div>`;
    }
    oRow.querySelector('[data-action="json-outcomes"]')?.addEventListener('click', () => {
      showJsonModal(`Outcomes rollups: ${ground.name ?? ground.id}`, { rollups: oRoll, recentEvents: oEvents }, 'outcomes');
    });
    oRow.querySelector('[data-action="clear-outcomes"]')?.addEventListener('click', async () => {
      if (!confirm('Clear this ground\'s outcome stream? Rollups (Feature health, conventions histogram) will recompute from empty. The locale features keep their current confidence.')) return;
      try {
        // v2.74.463 — per-ground key; also prune the legacy aggregate if it predates migration.
        await new Promise(r => chrome.storage.local.remove(`outcomes:${ground.id}`, r));
        const got = await new Promise(r => chrome.storage.local.get('outcomesStream', r));
        if (got?.outcomesStream && ground.id in got.outcomesStream) {
          delete got.outcomesStream[ground.id];
          await new Promise(r => chrome.storage.local.set({ outcomesStream: got.outcomesStream }, r));
        }
        toast('Outcome stream cleared');
        await refreshGroundList();
      } catch (e) { toast(`Failed: ${e?.message ?? 'unknown'}`, 'err'); }
    });
    card.appendChild(oRow);

    // v2.74.431 — Site Map section (GROUND_SPEC § 7). The navigation graph of the
    // site: the current page(s) modeled, every nav destination discovered. Reuses
    // the smMap/smStats fetched once at the top of this iteration (v2.74.434).
    // Read-only inspector + clear control.
    const smRow = document.createElement('div');
    smRow.className = 'ground-section-row';
    {
      const nodes = smMap?.nodes ? Object.values(smMap.nodes) : [];
      // String-strip the origin (NOT new URL — patterns contain {id} which URL would %7B-encode).
      const shortPath = (pat) => (pat || '').replace(/^https?:\/\/[^/]+/i, '') || '/';
      const modeled = nodes.filter(n => n.status === 'modeled');
      const discovered = nodes.filter(n => n.status === 'discovered');
      // v2.74.439 — surface stubs (sitemap.xml-known, not yet crawled) so a freshly
      // ingested ground isn't an empty list under "N stub".
      const stub = nodes.filter(n => n.status !== 'modeled' && n.status !== 'discovered');
      // v2.74.441 — Explore queue (slice 4): archetypes not yet modeled but with a
      // navigable exemplar URL can be auto-Explored → modeled.
      const modelable = nodes.filter(n => n.status !== 'modeled' && n.exemplarUrl);
      const nodeRow = (n) => `
          <div class="sitemap-node sitemap-${escAttr(n.status)}">
            <span class="sitemap-node-status">${n.status === 'modeled' ? '●' : (n.status === 'discovered' ? '◐' : '○')}</span>
            <span class="sitemap-node-name" title="${escAttr(n.urlPattern)}">${escHtml(n.name || shortPath(n.urlPattern))}</span>
            <span class="sitemap-node-meta">${escHtml(shortPath(n.urlPattern))}${n.instanceCount > 1 ? ` · ×${n.instanceCount}` : ''}${n.goals?.length ? ` · ${n.goals.length} goal(s)` : ''}${n.status === 'modeled' ? ` · <button class="btn-secondary tiny" data-action="locale-graph" data-arch="${escAttr(n.id)}" title="Show this archetype's page graph — reveals / contains / enables / leadsTo edges — and which outgoing links lead to modeled vs unknown archetypes (discovery gaps)">⊹ graph</button>` : ''}</span>
          </div>`;
      // v2.74.442 — Coverage (slice 5): proportional bar (modeled/discovered/stub) +
      // "% modeled" headline, so a Ground's modeling progress reads at a glance.
      const cov = smStats || { nodes: 0, modeled: 0, discovered: 0, stub: 0, edges: 0, pages: 0, modeledPages: 0 };
      const covTotal = cov.nodes || 0;
      const covPct = covTotal ? Math.round((cov.modeled / covTotal) * 100) : 0;
      const covSeg = (n, color) => (covTotal && n) ? `<span style="display:inline-block;height:100%;width:${(n / covTotal * 100).toFixed(1)}%;background:${color}"></span>` : '';
      const coverageHtml = covTotal ? `
        <div class="sitemap-coverage" title="${cov.modeled} modeled · ${cov.discovered} discovered · ${cov.stub} stub of ${covTotal} archetypes">
          <div style="display:flex;height:6px;border-radius:3px;overflow:hidden;background:rgba(127,127,127,.18);margin:2px 0 4px">${covSeg(cov.modeled, '#3fb950')}${covSeg(cov.discovered, '#d29922')}${covSeg(cov.stub, '#6e7681')}</div>
          <div style="font-size:11px;opacity:.75"><strong>${covPct}% modeled</strong> · ${cov.modeled}/${covTotal} archetypes · ${cov.edges} edge(s)${cov.pages > covTotal ? ` · ${cov.modeledPages}/${cov.pages} pages` : ''}${cov.locales?.length > 1 ? ` · 🌐 ${cov.locales.length} langs` : ''}</div>
        </div>` : '';
      // v2.74.465 — Site capability catalog: "what can I do across this site", rolled up from
      // every modeled archetype's goals (siteMapCapabilities). Sits beside coverage ("how much
      // is modeled") to answer "what does the modeled territory let me DO".
      const caps = smMap ? siteMapCapabilities(smMap) : { capabilities: [], totals: { distinct: 0 } };
      const CAP_SHOWN = 12;
      // v2.74.467 — each row carries an "open" link to the archetype's exemplar (the "go there"
      // action) and a per-row meta line; the same renderer serves the default prevalence list
      // AND the live intent-ranked results (matchSiteCapabilities returns the same shape).
      const capRow = (c) => {
        const ex = (c.archetypes.find(a => a.exemplarUrl) || {}).exemplarUrl || '';
        const meta = [c.count > 1 ? `×${c.count}` : '', c.pageTypes.join(', ')].filter(Boolean).join(' · ');
        // v2.74.472 — a modeled archetype (has a Locale) can be drafted into a runnable capability.
        const synthArch = c.archetypes.find(a => a.status === 'modeled') || c.archetypes[0] || null;
        return `
          <div class="sitemap-node" title="${escAttr(c.archetypes.map(a => shortPath(a.urlPattern)).join('\n'))}">
            <span class="sitemap-node-status">★</span>
            <span class="sitemap-node-name">${escHtml(c.goal)}${c.why ? ` <span style="opacity:.6;font-style:italic">— ${escHtml(c.why)}</span>` : ''}</span>
            <span class="sitemap-node-meta">${escHtml(meta)}${ex ? ` · <a href="${escAttr(ex)}" target="_blank" rel="noopener" title="Open ${escAttr(ex)}">↗</a>` : ''}${synthArch ? ` · <button class="btn-secondary tiny" data-action="synth-cap" data-arch="${escAttr(synthArch.id)}" data-goal="${escAttr(c.goal)}" title="Draft a runnable capability (Fragment + Strategy) from this goal — a best-effort draft to review/refine">⚙ draft</button>` : ''}</span>
          </div>`;
      };
      const capListHtml = (list, isDefault) => list.length
        ? list.map(capRow).join('') + ((isDefault && caps.capabilities.length > CAP_SHOWN) ? `<div class="empty-state small">+${caps.capabilities.length - CAP_SHOWN} more — see JSON</div>` : '')
        : `<div class="empty-state small">No capability matches that intent.</div>`;
      const capabilitiesHtml = caps.totals.distinct ? `
        <div class="ground-section-head" style="margin-top:8px;border-top:1px solid rgba(127,127,127,.18);padding-top:6px">
          <span class="ground-section-label">Can do</span>
          <span class="ground-section-count">${caps.totals.distinct}</span>
          <button class="btn-secondary tiny" data-action="ai-rank" data-gid="${escAttr(ground.id)}" title="Rank the catalog against your typed intent with AI (semantic / synonym match, e.g. &quot;buy&quot; → &quot;checkout&quot;)">✨</button>
          <button class="btn-secondary tiny" data-action="json-capabilities" data-gid="${escAttr(ground.id)}" title="View the full site capability catalog (goals × archetypes) as JSON">{ }</button>
        </div>
        <input type="text" id="cap-intent-${escAttr(ground.id)}" placeholder="What do you want to do? (type to rank)" autocomplete="off" style="width:100%;box-sizing:border-box;margin:2px 0 4px;font-size:12px;padding:3px 6px" />
        <div class="sitemap-nodes" id="cap-results-${escAttr(ground.id)}">${capListHtml(caps.capabilities.slice(0, CAP_SHOWN), true)}</div>` : '';
      // v2.74.484 — Chrome (GROUND_SPEC § 4): the global controls hoisted off the Locales, shown
      // once here. Each row: kind, label, the regions it sits in, how many archetypes saw it
      // (seenIn), a ⊕ depth badge if it carries a reveal layer, and an override count. So the
      // "modeled once, referenced everywhere" set is inspectable.
      const chromeObj = chromeRes?.success ? (chromeRes.chrome || {}) : {};
      const chromeList = Object.values(chromeObj);
      const CHROME_SHOWN = 14;
      const ovByUid = {};   // uid -> # of Locales that override it
      for (const perLocale of Object.values(chromeRes?.overrides || {})) for (const uid of Object.keys(perLocale || {})) ovByUid[uid] = (ovByUid[uid] || 0) + 1;
      const chromeIcon = { input: '⌨', action: '⏺', navigation: '↗', disclosure: '▾', composite: '▣' };
      const chromeRow = (f) => {
        const hasDepth = !!(f.reveals && chromeRes?.chromeLayers?.[f.reveals]);
        const meta = [
          (f.regions && f.regions.length) ? f.regions.join('/') : '',
          (f.seenIn && f.seenIn.length) ? `×${f.seenIn.length}` : '',
          hasDepth ? '⊕ depth' : '',
          ovByUid[f.id] ? `${ovByUid[f.id]} override(s)` : '',
        ].filter(Boolean).join(' · ');
        return `<div class="sitemap-node" title="${escAttr(f.selector || '')}"><span class="sitemap-node-status">${chromeIcon[f.kind] || '•'}</span><span class="sitemap-node-name">${escHtml(f.label || f.kind || '(chrome)')}</span><span class="sitemap-node-meta">${escHtml(meta)}</span></div>`;
      };
      const chromeHtml = chromeList.length ? `
        <div class="ground-section-head" style="margin-top:8px;border-top:1px solid rgba(127,127,127,.18);padding-top:6px">
          <span class="ground-section-label">Chrome</span>
          <span class="ground-section-count">${chromeList.length}</span>
          <span class="sitemap-node-meta" title="Global header/nav/footer controls hoisted off the per-archetype Locales — captured once, referenced everywhere (GROUND_SPEC §4)">hoisted · ${chromeRes?.stats?.layers || 0} w/ depth</span>
          <button class="btn-secondary tiny" data-action="json-chrome" data-gid="${escAttr(ground.id)}" title="View the full Ground.chrome (promoted features + depth layers + per-Locale overrides) as JSON">{ }</button>
        </div>
        <div class="sitemap-nodes">${chromeList.slice(0, CHROME_SHOWN).map(chromeRow).join('')}${chromeList.length > CHROME_SHOWN ? `<div class="empty-state small">+${chromeList.length - CHROME_SHOWN} more — see JSON</div>` : ''}</div>` : '';
      // v2.74.494 — within-Ground cross-Locale STRATEGIES (partOf; a multi-page journey within ONE
      // Ground is a Tier-2 Strategy — docs/TIER_MODEL.md): pick a destination archetype → the multi-page
      // paths there (GET_WORKFLOWS); each row builds a runnable Strategy (BUILD_WORKFLOW; legacy msg name).
      const wfTargets = [...modeled, ...discovered];
      const workflowsHtml = (wfTargets.length && (smMap?.edges?.length || 0) > 0) ? `
        <div class="ground-section-head" style="margin-top:8px;border-top:1px solid rgba(127,127,127,.18);padding-top:6px">
          <span class="ground-section-label">Strategies</span>
          <span class="sitemap-node-meta" title="Multi-page journeys composed over the site map (partOf): pick a destination to see the paths there, then build a runnable cross-page Strategy (a multi-page journey within this Ground)">multi-page journeys</span>
        </div>
        <select id="wf-target-${escAttr(ground.id)}" style="width:100%;box-sizing:border-box;margin:2px 0 4px;font-size:12px;padding:3px 6px">
          <option value="">Reach which page…</option>
          ${wfTargets.map(n => `<option value="${escAttr(n.id)}">${escHtml(n.name || shortPath(n.urlPattern))}${n.status !== 'modeled' ? ' (not modeled)' : ''}</option>`).join('')}
        </select>
        <div class="sitemap-nodes" id="wf-results-${escAttr(ground.id)}"></div>` : '';
      smRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Site Map</span>
        <span class="ground-section-count">${nodes.length}</span>
        ${modelable.length ? `<button class="btn-secondary tiny" data-action="explore-queue" data-gid="${escAttr(ground.id)}" title="Auto-Explore every un-modeled archetype (opens a background tab; one Explore per template → modeled). Slow (~15–30s each); Abort anytime.">▶ Model ${modelable.length}</button>` : ''}
        ${nodes.length ? `<button class="btn-secondary tiny" data-action="json-sitemap" data-gid="${escAttr(ground.id)}" title="View the full siteMap (nodes + edges) as JSON">{ }</button>
        <button class="btn-secondary tiny danger" data-action="clear-sitemap" data-gid="${escAttr(ground.id)}" title="Clear this ground's site map (rebuilds on next Explore)">✕</button>` : ''}
      </div>
      <div class="ground-section-body" id="sitemap-body-${escAttr(ground.id)}">
        ${nodes.length === 0
          ? `<span class="empty-state small">No site map yet — <strong>Explore</strong> a page to sketch the territory: the current page becomes a <em>modeled</em> node and every same-site nav destination a <em>discovered</em> node + edge.</span>`
          : `${coverageHtml}
             <div class="sitemap-nodes">${modeled.map(nodeRow).join('')}${discovered.slice(0, 20).map(nodeRow).join('')}${discovered.length > 20 ? `<div class="empty-state small">+${discovered.length - 20} more discovered — see JSON</div>` : ''}${stub.slice(0, 25).map(nodeRow).join('')}${stub.length > 25 ? `<div class="empty-state small">+${stub.length - 25} more stub — see JSON</div>` : ''}</div>${capabilitiesHtml}${chromeHtml}${workflowsHtml}`
        }
      </div>
      <div class="explore-queue-panel hidden" id="exq-panel-${escAttr(ground.id)}"></div>`;
      // v2.74.467 — live intent ranking: type → matchSiteCapabilities re-ranks the "Can do"
      // list; empty input restores the default prevalence-ordered catalog. Pure client-side,
      // no LLM. Attached here (inside the block) so caps/capListHtml/CAP_SHOWN are in scope.
      const capInput = smRow.querySelector(`#cap-intent-${ground.id}`);
      const capResults = smRow.querySelector(`#cap-results-${ground.id}`);
      if (capInput && capResults) {
        // Instant lexical re-rank as you type (resets the default list when cleared).
        capInput.addEventListener('input', () => {
          const q = capInput.value.trim();
          capResults.innerHTML = q
            ? capListHtml(matchSiteCapabilities(q, caps, { limit: CAP_SHOWN }), false)
            : capListHtml(caps.capabilities.slice(0, CAP_SHOWN), true);
        });
        // v2.74.469 — "✨" sends the typed intent for an LLM semantic re-rank (MATCH_CAPABILITIES);
        // results carry a `why`. Falls back to the lexical list when AI is unavailable.
        const aiBtn = smRow.querySelector('[data-action="ai-rank"]');
        aiBtn?.addEventListener('click', async () => {
          const q = capInput.value.trim();
          if (!q) { capInput.focus(); return; }
          aiBtn.disabled = true; const prev = aiBtn.textContent; aiBtn.textContent = '…';
          capResults.innerHTML = `<div class="empty-state small">Ranking with AI…</div>`;
          try {
            const resp = await new Promise(r => chrome.runtime.sendMessage({ type: 'MATCH_CAPABILITIES', payload: { groundId: ground.id, intent: q } }, r));
            if (resp?.success && Array.isArray(resp.matches)) {
              capResults.innerHTML = resp.matches.length
                ? capListHtml(resp.matches, false) + (resp.source === 'lexical' ? `<div class="empty-state small">lexical match — AI unavailable</div>` : '')
                : `<div class="empty-state small">No capability fits “${escHtml(q)}”.</div>`;
            } else {
              capResults.innerHTML = `<div class="empty-state small">Match failed: ${escHtml(resp?.error || 'unknown')}</div>`;
            }
          } catch (e) {
            capResults.innerHTML = `<div class="empty-state small">Match failed: ${escHtml(e?.message || 'error')}</div>`;
          } finally { aiBtn.disabled = false; aiBtn.textContent = prev; }
        });
        // v2.74.472 — "⚙ draft" synthesizes a runnable capability from a goal (SYNTHESIZE_CAPABILITY).
        // Delegated on the (stable) results container so it survives live re-renders. The result
        // is a DRAFT — toast notes runnable vs navigate-only + any warnings; review in Strategies.
        capResults.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-action="synth-cap"]');
          if (!btn) return;
          const archId = btn.getAttribute('data-arch'); const goalLabel = btn.getAttribute('data-goal');
          if (!archId || !goalLabel) return;
          btn.disabled = true; const prev = btn.textContent; btn.textContent = '…';
          try {
            const resp = await new Promise(r => chrome.runtime.sendMessage({ type: 'SYNTHESIZE_CAPABILITY', payload: { groundId: ground.id, archetypeId: archId, goal: goalLabel } }, r));
            if (resp?.success) {
              const warn = (resp.warnings && resp.warnings.length) ? ` · ${resp.warnings.length} warning(s) — refine before running` : '';
              toast(`Drafted “${resp.name}” — ${resp.runnable ? 'runnable' : 'navigate-only'}, ${resp.actionCount} step(s)${warn}. Review in this Ground's Strategies.`);
              btn.textContent = '✓ drafted'; btn.disabled = true;
              await refreshGroundList();
            } else {
              toast(`Synthesis failed: ${resp?.error || 'unknown'}`, 'err'); btn.textContent = prev; btn.disabled = false;
            }
          } catch (err) {
            toast(`Synthesis failed: ${err?.message || 'error'}`, 'err'); btn.textContent = prev; btn.disabled = false;
          }
        });
      }
      // v2.74.494 — Workflows picker: choose a destination → GET_WORKFLOWS renders the paths
      // (step chips + via labels + modeled badge); "⚙ build" → BUILD_WORKFLOW persists a runnable
      // cross-page Fragment+Strategy. In-block so wfRow is in scope; delegated on the results div.
      const wfSelect = smRow.querySelector(`#wf-target-${ground.id}`);
      const wfResults = smRow.querySelector(`#wf-results-${ground.id}`);
      if (wfSelect && wfResults) {
        const wfRow = (wf) => {
          const chips = wf.steps.map((s) => `${escHtml(s.name)}${s.terminal ? '' : ` <span style="opacity:.45">${s.viaLabel ? `—${escHtml(s.viaLabel.slice(0, 14))}→` : '→'}</span> `}`).join('');
          const path = wf.steps.map((s) => s.archetypeId).join(',');
          const badge = wf.fullyModeled
            ? '<span style="color:#3fb950" title="every step is a modeled archetype">●</span>'
            : '<span style="opacity:.55" title="some steps not yet modeled — build navigates but may skip un-modeled steps’ actions">◐</span>';
          return `<div class="sitemap-node"><span class="sitemap-node-status">${badge}</span><span class="sitemap-node-name" style="font-size:11px">${chips}</span><span class="sitemap-node-meta"><button class="btn-secondary tiny" data-action="build-wf" data-path="${escAttr(path)}" title="Build a runnable cross-page Strategy (persisted as a Fragment + Strategy) for this path — a best-effort draft to review/run">⚙ build</button></span></div>`;
        };
        wfSelect.addEventListener('change', async () => {
          const target = wfSelect.value;
          if (!target) { wfResults.innerHTML = ''; return; }
          wfResults.innerHTML = `<div class="empty-state small">Finding paths…</div>`;
          try {
            const resp = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_WORKFLOWS', payload: { groundId: ground.id, target } }, r));
            if (!resp?.success) { wfResults.innerHTML = `<div class="empty-state small">Failed: ${escHtml(resp?.error || 'unknown')}</div>`; return; }
            wfResults.innerHTML = (resp.workflows && resp.workflows.length)
              ? resp.workflows.map(wfRow).join('')
              : `<div class="empty-state small">No path to that page in the site map (it may be an entry point, or isn't linked from a modeled page).</div>`;
          } catch (e) { wfResults.innerHTML = `<div class="empty-state small">Failed: ${escHtml(e?.message || 'error')}</div>`; }
        });
        wfResults.addEventListener('click', async (e) => {
          const btn = e.target.closest('[data-action="build-wf"]');
          if (!btn) return;
          const path = (btn.getAttribute('data-path') || '').split(',').filter(Boolean);
          if (!path.length) return;
          btn.disabled = true; const prev = btn.textContent; btn.textContent = '…';
          try {
            const resp = await new Promise(r => chrome.runtime.sendMessage({ type: 'BUILD_WORKFLOW', payload: { groundId: ground.id, path } }, r));
            if (resp?.success) {
              const warn = (resp.warnings && resp.warnings.length) ? ` · ${resp.warnings.length} warning(s)` : '';
              toast(`Built “${resp.name}” — ${resp.runnable ? 'runnable' : 'navigate-only'}, ${resp.actionCount} step(s)${warn}. Review in this Ground's Strategies.`);
              btn.textContent = '✓ built'; btn.disabled = true;
              await refreshGroundList();
            } else { toast(`Build failed: ${resp?.error || 'unknown'}`, 'err'); btn.textContent = prev; btn.disabled = false; }
          } catch (err) { toast(`Build failed: ${err?.message || 'error'}`, 'err'); btn.textContent = prev; btn.disabled = false; }
        });
      }
    }
    smRow.querySelector('[data-action="explore-queue"]')?.addEventListener('click', () => startExploreQueue(ground.id));
    // v2.74.477 — Locale graph inspector: "⊹ graph" on a modeled archetype fetches its
    // typed edge set (LOCALE_GRAPH) + the leadsTo→siteMap reconciliation, shown in the
    // JSON modal. Delegated on smRow so it survives re-renders (there can be many rows).
    smRow.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action="locale-graph"]');
      if (!btn) return;
      const archId = btn.getAttribute('data-arch');
      if (!archId) return;
      btn.disabled = true; const prev = btn.textContent; btn.textContent = '…';
      try {
        const resp = await new Promise(r => chrome.runtime.sendMessage({ type: 'LOCALE_GRAPH', payload: { groundId: ground.id, archetypeId: archId } }, r));
        if (resp?.success) {
          showGraphModal(archId, resp);
        } else {
          toast(`Graph failed: ${resp?.error || 'unknown'}`, 'err');
        }
      } catch (err) {
        toast(`Graph failed: ${err?.message || 'error'}`, 'err');
      } finally { btn.disabled = false; btn.textContent = prev; }
    });
    smRow.querySelector('[data-action="json-sitemap"]')?.addEventListener('click', () => {
      showJsonModal(`Site Map: ${ground.name ?? ground.id}`, smMap, 'sitemap');
    });
    smRow.querySelector('[data-action="json-chrome"]')?.addEventListener('click', () => {
      // Re-fetch fresh so the JSON reflects the latest derivation, not the render snapshot.
      chrome.runtime.sendMessage({ type: 'GET_GROUND_CHROME', payload: { groundId: ground.id } }, (resp) => {
        showJsonModal(`Ground.chrome: ${ground.name ?? ground.id}`, resp?.success ? resp : (chromeRes || {}), 'ground-chrome');
      });
    });
    smRow.querySelector('[data-action="json-capabilities"]')?.addEventListener('click', () => {
      showJsonModal(`Capabilities: ${ground.name ?? ground.id}`, siteMapCapabilities(smMap), 'capabilities');
    });
    smRow.querySelector('[data-action="clear-sitemap"]')?.addEventListener('click', async () => {
      if (!confirm('Clear this ground\'s site map? It rebuilds as you Explore pages.')) return;
      try {
        // v2.74.463 — per-ground key; also prune the legacy aggregate if it predates migration.
        await new Promise(r => chrome.storage.local.remove(`siteMap:${ground.id}`, r));
        const got = await new Promise(r => chrome.storage.local.get('siteMapCache', r));
        if (got?.siteMapCache && ground.id in got.siteMapCache) {
          delete got.siteMapCache[ground.id];
          await new Promise(r => chrome.storage.local.set({ siteMapCache: got.siteMapCache }, r));
        }
        toast('Site map cleared');
        await refreshGroundList();
      } catch (e) { toast(`Failed: ${e?.message ?? 'unknown'}`, 'err'); }
    });
    card.appendChild(smRow);

    // v2.65.0 (Pass 2) — Observations section. Foundation only: storage
    // exists, library row exists. NO authoring flow, NO runtime path,
    // NO strategy DSL changes. The "+ Observation" button shows a toast
    // explaining authoring is still in design. See docs/observation-
    // design.md for architectural framing and what's deferred.
    //
    // Placement: between Assertions and Analyses. Page-side primitives
    // (Fragments, Assertions, Observations) cluster first; Analyses
    // (data-side) follow; Strategies (composition) last.
    const obsRow = document.createElement('div');
    obsRow.className = 'ground-section-row';
    obsRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Observations</span>
        <span class="ground-section-count">${observations.length}</span>
        <button class="btn-secondary tiny" data-action="add-observation" data-gid="${escAttr(ground.id)}" title="Author a new Observation (page → data extraction)">+ Observation</button>
      </div>
      <div class="ground-section-body" id="observations-body-${escAttr(ground.id)}">
        ${observations.length === 0
          ? `<span class="empty-state small">No Observations yet — these read page state into named scope bindings (page → data primitive).</span>`
          : observations.map(o => {
            // v2.74.17 (Ship C) — Multi-extract observation rendering.
            // Read implementations[0].extracts[] and show one-line summary
            // per extract. Walk button always visible for cache-tier (any
            // shape now, including image / image_list / list_of_records).
            const impl = o.implementations?.[0] ?? {};
            const tier = impl.tier ?? 'cache';
            const extracts = Array.isArray(impl.extracts) ? impl.extracts : [];
            const outputSummary = extracts.length === 0
              ? '<em>no extracts</em>'
              : extracts.map(ex => `<span class="observation-output">${escHtml(ex.output ?? '?')}<span class="observation-output-shape">:${escHtml(ex.shape ?? '?')}</span></span>`).join(' ');
            const walkBtn = tier === 'cache'
              ? `<button class="btn-action" data-action="walk-observation" data-oid="${o.id}" title="Walk on live page (T1 authoring) — replaces extracts">▶</button>`
              : '';
            return `
            <div class="observation-row" data-oid="${o.id}">
              <div class="observation-row-main">
                <span class="observation-name">${escHtml(o.name ?? 'Unnamed')}</span>
                <span class="observation-shape">${escHtml(tier === 'cache' ? 'T1' : 'T3')}</span>
                <span class="observation-extract-count">${extracts.length} extract${extracts.length === 1 ? '' : 's'}</span>
              </div>
              <div class="observation-outputs">${outputSummary}</div>
              ${o.description ? `<div class="observation-desc">${escHtml(o.description)}</div>` : ''}
              <div class="observation-row-actions">
                ${walkBtn}
                <button class="btn-action" data-action="edit-observation" data-oid="${o.id}" title="Edit metadata + conditions (extracts unchanged)">✎</button>
                <button class="btn-action" data-action="json-observation" data-oid="${o.id}" title="View JSON (read-only, copyable)">{ }</button>
                <button class="btn-action danger" data-action="delete-observation" data-oid="${o.id}" title="Delete observation">✕</button>
              </div>
            </div>`;
          }).join('')
        }
      </div>`;
    obsRow.querySelector('[data-action="add-observation"]').addEventListener('click', async () => {
      // v2.74.17 (Ship C) — + Observation now opens the sidepanel
      // observation-author mode directly, mirroring fragment Walk pattern.
      // T1 is the default; frontier-tier authoring (T3 vision-LLM) goes
      // through a separate flow which isn't wired in this ship.
      const observationId = `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // v2.74.140 — Use openSidepanelHere so a prior per-tab Chat override
      // doesn't leave the panel on chat.html.
      await openSidepanelHere('sidepanel.html');
      chrome.runtime.sendMessage({
        type: 'BEGIN_OBSERVATION_AUTHOR',
        payload: {
          observationId,
          groundId: ground.id,
          groundUrl: ground.url,
          name: '',
          description: '',
        },
      });
    });
    obsRow.querySelectorAll('[data-action="edit-observation"]').forEach(btn => {
      btn.addEventListener('click', () => openObservationForm(ground.id, btn.dataset.oid));
    });
    // v2.72.95 (Phase 1) — Walk Observation: open sidepanel mode for
    // live-page authoring. Supported shapes: scalar, raw_text, raw_html.
    // v2.72.96 — Sidepanel.open() must happen WITHIN the synchronous
    // user-gesture window. Any await that runs before sidePanel.open
    // breaks that chain. So we:
    //   1. Look up the observation from the closed-over `observations`
    //      array (already loaded — no fetch needed).
    //   2. Open the sidepanel as the very first awaited operation.
    //   3. Then dispatch BEGIN_OBSERVATION_AUTHOR.
    obsRow.querySelectorAll('[data-action="walk-observation"]').forEach(btn => {
      const oid = btn.dataset.oid;
      const o = observations.find(x => x.id === oid);
      if (!o) return;       // shouldn't happen — row exists for it
      btn.addEventListener('click', async () => {
        // 1. Open sidepanel synchronously (user gesture).
        // v2.74.140 — Use openSidepanelHere so a prior per-tab Chat
        // override doesn't leave the panel on chat.html. The shared
        // helper sets BOTH the global default AND the active tab's
        // per-tab path, displacing any in-flight Chat override.
        await openSidepanelHere('sidepanel.html');
        // 2. Dispatch the begin message — background opens the tab,
        // mounts the observation-author mode, broadcasts setup completion.
        // v2.74.17 (Ship C) — No legacy single-extract seed. Walk reauthors
        // the extracts from scratch; existing extracts are visible via the
        // JSON modal if the author wants to copy values.
        chrome.runtime.sendMessage({
          type: 'BEGIN_OBSERVATION_AUTHOR',
          payload: {
            observationId: o.id,
            groundId: ground.id,
            groundUrl: ground.url,
            name: o.name ?? '',
            description: o.description ?? '',
          },
        });
      });
    });
    obsRow.querySelectorAll('[data-action="json-observation"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const o = await StorageManager.getObservation(btn.dataset.oid);
        if (!o) { toast('Observation not found', 'err'); return; }
        showJsonModal(`Observation: ${o.name ?? o.id}`, o, 'observation');
      });
    });
    obsRow.querySelectorAll('[data-action="delete-observation"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const o = await StorageManager.getObservation(btn.dataset.oid);
        if (!o) { toast('Observation not found', 'err'); return; }
        // v2.72.10 (bug review) — Surface strategy-reference impact before
        // deletion. Mirrors deleteAssertion's usage warning. Strategy nodes
        // referencing this Observation will continue to point at a dead id;
        // engine surfaces "Observation not found" at runtime, but warning at
        // delete time gives the author a chance to update strategies first.
        const refCount = await countStrategyRefsToObservation(o.groundId, o.id);
        let msg = `Delete Observation "${o.name ?? o.id}"?`;
        if (refCount > 0) {
          msg = `Delete Observation "${o.name ?? o.id}"?\n\n⚠ ${refCount} ${refCount === 1 ? 'Strategy step references' : 'Strategy steps reference'} this Observation. After deletion, those steps will fail at runtime with "Observation not found" until you update them.\nThis cannot be undone.`;
        }
        if (!confirm(msg)) return;
        const res = await new Promise(r => chrome.runtime.sendMessage({
          type: 'DELETE_OBSERVATION', payload: { observationId: btn.dataset.oid },
        }, r));
        if (!res?.success) {
          toast(`Delete failed: ${res?.error ?? 'unknown'}`, 'err');
          return;
        }
        toast(refCount > 0
          ? `Observation "${o.name ?? o.id}" deleted (${refCount} Strategy reference${refCount === 1 ? '' : 's'} now broken)`
          : `Observation "${o.name ?? o.id}" deleted`, 'ok');
        refreshGroundList();
      });
    });
    card.appendChild(obsRow);

    // v2.62.0 — Analyses section. Library of named, parameterized data-ops
    // definitions. Built-ins ship with the system and appear here on every
    // Ground (read-only). User-authored Analyses are Ground-scoped and
    // editable. Strategies will reference these in Iteration B; for now
    // this is an isolated authoring surface.
    const allAnalyses = [
      ...BUILTIN_ANALYSES.map(a => ({ ...a, _isBuiltin: true })),
      ...analyses.map(a => ({ ...a, _isBuiltin: false })),
    ];
    const analysisRow = document.createElement('div');
    analysisRow.className = 'ground-section-row';
    analysisRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Analyses</span>
        <span class="ground-section-count">${allAnalyses.length}</span>
        <button class="btn-secondary tiny" data-action="add-analysis" data-gid="${escAttr(ground.id)}" title="Author a new Analysis">+ Analysis</button>
      </div>
      <div class="ground-section-body" id="analyses-body-${escAttr(ground.id)}">
        ${allAnalyses.length === 0
          ? `<span class="empty-state small">No Analyses yet — define reusable data operations (filter / sort / take) here.</span>`
          : allAnalyses.map(a => {
              // v2.66.0 (Pass 3a) — op-count from first implementation.
              // v2.72.16 (Pass 7a) — operations now under impl.body.operations.
              // v2.72.18 (Pass 7b) — body kind drives the summary text.
              // Defensive fallback chain handles records that bypassed migration.
              const impl0 = Array.isArray(a.implementations) && a.implementations.length > 0
                ? a.implementations[0]
                : null;
              const tier = impl0?.tier ?? 'cache';
              const bodyKind = (tier === 'cache') ? (impl0?.body?.kind ?? 'operations') : null;
              const paramsCount = Array.isArray(a.params) ? a.params.length : 0;
              let metaText;
              if (tier === 'frontier') {
                metaText = `frontier · ${paramsCount} param${paramsCount === 1 ? '' : 's'}`;
              } else if (bodyKind === 'template') {
                const inputsCount = Array.isArray(impl0?.body?.inputs) ? impl0.body.inputs.length : 0;
                metaText = `template, ${inputsCount} input${inputsCount === 1 ? '' : 's'} · ${paramsCount} param${paramsCount === 1 ? '' : 's'}`;
              } else {
                const ops = impl0?.body?.operations ?? impl0?.operations ?? a.operations;
                const opsCount = Array.isArray(ops) ? ops.length : 0;
                metaText = `${opsCount} op${opsCount === 1 ? '' : 's'} · ${paramsCount} param${paramsCount === 1 ? '' : 's'}`;
              }
              return `
            <div class="analysis-row${a.lifecycle === 'deprecated' ? ' analysis-row-deprecated' : ''}" data-aid="${escAttr(a.id)}" data-builtin="${a._isBuiltin ? '1' : '0'}">
              <div class="analysis-row-main">
                <span class="analysis-name">${escHtml(a.name ?? 'Unnamed')}</span>
                ${a._isBuiltin ? '<span class="analysis-builtin-badge">built-in</span>' : ''}
                ${a.lifecycle === 'deprecated' ? '<span class="ground-lifecycle-badge ground-lifecycle-deprecated" title="Deprecated (soft-deleted). Kept but excluded from active use; reactivate to restore.">deprecated</span>' : ''}
              </div>
              ${a.description ? `<div class="analysis-desc">${escHtml(a.description)}</div>` : ''}
              <div class="analysis-row-actions">
                <span class="analysis-meta">${metaText}</span>
                ${a._isBuiltin
                  ? `<button class="btn-action" data-action="json-analysis" data-aid="${escAttr(a.id)}" title="View JSON (read-only, copyable)">{ }</button>`
                  : `<button class="btn-action" data-action="edit-analysis" data-aid="${escAttr(a.id)}" title="Edit Analysis">✎</button>
                     <button class="btn-action" data-action="json-analysis" data-aid="${escAttr(a.id)}" title="View JSON (read-only, copyable)">{ }</button>
                     ${a.lifecycle === 'deprecated'
                       ? `<button class="btn-secondary small" data-action="reactivate-analysis" data-aid="${escAttr(a.id)}" title="Reactivate this Analysis (restore to active)">↑</button>`
                       : `<button class="btn-action" data-action="deprecate-analysis" data-aid="${escAttr(a.id)}" title="Deprecate (soft-delete) — keep but flag as deprecated, reversible">⤓</button>`}
                     <button class="btn-action danger" data-action="delete-analysis" data-aid="${escAttr(a.id)}" title="Delete Analysis">✕</button>`
                }
              </div>
            </div>`;
          }).join('')
        }
      </div>`;
    analysisRow.querySelector('[data-action="add-analysis"]').addEventListener('click', async () => {
      try {
        await openAnalysisForm(ground.id, null);
      } catch (err) {
        console.error('openAnalysisForm threw:', err);
        toast(`Open analysis form failed: ${err.message}`, 'err');
      }
    });
    analysisRow.querySelectorAll('[data-action="edit-analysis"]').forEach(btn => {
      btn.addEventListener('click', () => openAnalysisForm(ground.id, btn.dataset.aid));
    });
    analysisRow.querySelectorAll('[data-action="json-analysis"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const aid = btn.dataset.aid;
        // Built-in analyses come from the registry; user analyses from storage.
        const a = isBuiltinAnalysisId(aid)
          ? getBuiltinAnalysis(aid)
          : await StorageManager.getAnalysis(aid);
        if (!a) { toast('Analysis not found', 'err'); return; }
        showJsonModal(`Analysis: ${a.name ?? a.id}`, a, 'analysis');
      });
    });
    analysisRow.querySelectorAll('[data-action="delete-analysis"]').forEach(btn => {
      btn.addEventListener('click', () => deleteAnalysis(btn.dataset.aid));
    });
    // v2.74.510 — STORAGE_SCHEMA §9/§10 deprecate (soft-delete) / reactivate (user analyses only).
    analysisRow.querySelectorAll('[data-action="deprecate-analysis"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Deprecate this Analysis? It\'s kept but flagged deprecated — reactivate it any time.')) return;
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'DEPRECATE_PRIMITIVE', payload: { kind: 'analysis', id: btn.dataset.aid } }, r));
        if (res?.success) { toast('Analysis deprecated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    analysisRow.querySelectorAll('[data-action="reactivate-analysis"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'RESTORE_PRIMITIVE', payload: { kind: 'analysis', id: btn.dataset.aid } }, r));
        if (res?.success) { toast('Analysis reactivated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    card.appendChild(analysisRow);

    // Strategies stub row — wired in Pass C
    const stratRow = document.createElement('div');
    stratRow.className = 'ground-section-row';
    stratRow.innerHTML = `
      <div class="ground-section-head">
        <span class="ground-section-label">Strategies</span>
        <span class="ground-section-count">${strategies.length}</span>
        <button class="btn-secondary tiny" data-action="add-strategy" data-gid="${escAttr(ground.id)}" title="Author a new Strategy">+ Strategy</button>
      </div>
      <div class="ground-section-body" id="strategies-body-${escAttr(ground.id)}">
        ${strategies.length === 0
          ? `<span class="empty-state small">No Strategies yet — compose goal-directed plans from Fragments.</span>`
          : strategies.map(s => {
              // v2.29.0 (Pass E2-1) — Count fragments by walking the tree so
              // FOREACH bodies contribute their children. Pre-E2 Strategies
              // normalize to flat arrays where this is equal to .length.
              // v2.60.1 — count all executable nodes, not just fragments.
              // A strategy of NAVIGATE+PAUSE was previously shown as "0 steps."
              const stepCount = countExecutableNodes(normalizeStrategyBody(s.fragmentSteps));
              // v2.72.27 (Pass 15) — tier badge.
              const sTier = s.implementations?.[0]?.tier ?? 'cache';
              const tierBadge = sTier === 'frontier'
                ? `<span class="strategy-tier-badge tier-frontier" title="T3 Composer-based — frontier model composes from primitives at runtime. Real per-call cost. Composer ships in Pass 16.">T3</span>`
                : `<span class="strategy-tier-badge tier-cache" title="T1 Hand-authored — deterministic fragment tree.">T1</span>`;
              // v2.74.510 — STORAGE_SCHEMA §9/§10 soft-delete (deprecate/reactivate),
              // mirroring the Perspective pattern. lifecycle drives the deprecated UI.
              const isDeprecated = s.lifecycle === 'deprecated';
              return `
            <div class="strategy-row${isDeprecated ? ' strategy-row-deprecated' : ''}" data-sid="${s.id}">
              <div class="strategy-row-main">
                <span class="strategy-name">${escHtml(s.name ?? 'Unnamed')}</span>
                ${tierBadge}
                ${isDeprecated ? '<span class="ground-lifecycle-badge ground-lifecycle-deprecated" title="Deprecated (soft-deleted). Kept but excluded from active use; reactivate to restore.">deprecated</span>' : ''}
                <span class="strategy-step-count">${sTier === 'frontier' ? 'composed at runtime' : `${stepCount} step${stepCount === 1 ? '' : 's'}`}</span>
              </div>
              ${s.goal ? `<div class="strategy-goal">${escHtml(s.goal)}</div>` : ''}
              <div class="strategy-row-actions">
                <span class="strategy-meta">${(s.params ?? []).length} input${(s.params ?? []).length === 1 ? '' : 's'}${(s.params ?? []).length ? `: ${(s.params ?? []).map(p => {
                  // v2.59.0 — params normalized to [{name, kind}]. Render
                  // list-kind with a "(list)" annotation; scalars unchanged.
                  const name = typeof p === 'string' ? p : (p?.name ?? '');
                  const kind = typeof p === 'string' ? 'scalar' : (p?.kind ?? 'scalar');
                  return escHtml(name) + (kind === 'list' ? ' (list)' : '');
                }).join(', ')}` : ''}</span>
                <button class="btn-action" data-action="run-strategy" data-sid="${s.id}" title="Test-run this Strategy now">▶</button>
                <button class="btn-action" data-action="edit-strategy" data-sid="${s.id}" title="Edit Strategy">✎</button>
                <button class="btn-action" data-action="json-strategy" data-sid="${s.id}" title="View JSON (read-only, copyable)">{ }</button>
                ${isDeprecated
                  ? `<button class="btn-secondary small" data-action="reactivate-strategy" data-sid="${s.id}" title="Reactivate this Strategy (restore to active)">↑</button>`
                  : `<button class="btn-action" data-action="deprecate-strategy" data-sid="${s.id}" title="Deprecate (soft-delete) — keep but flag as deprecated, reversible">⤓</button>`}
                <button class="btn-action danger" data-action="delete-strategy" data-sid="${s.id}" title="Delete Strategy">✕</button>
              </div>
            </div>`;
            }).join('')
        }
      </div>`;
    stratRow.querySelector('[data-action="add-strategy"]').addEventListener('click', async () => {
      try {
        await openStrategyForm(ground.id);
      } catch (e) {
        // v2.72.49 — surface silent failures. Without this wrapper, an
        // exception inside openStrategyForm (a missing storage method,
        // a stale DOM ID, a render that throws) would just leave the
        // user looking at a button that "does nothing." The toast tells
        // them what broke.
        console.error('[studio] openStrategyForm threw:', e);
        toast(`Strategy form failed: ${e.message}`, 'err');
      }
    });
    stratRow.querySelectorAll('[data-action="run-strategy"]').forEach(btn => {
      btn.addEventListener('click', () => testRunStrategy(btn.dataset.sid));
    });
    stratRow.querySelectorAll('[data-action="edit-strategy"]').forEach(btn => {
      btn.addEventListener('click', () => editStrategy(btn.dataset.sid));
    });
    stratRow.querySelectorAll('[data-action="json-strategy"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const s = await StorageManager.getStrategy(btn.dataset.sid);
        if (!s) { toast('Strategy not found', 'err'); return; }
        showJsonModal(`Strategy: ${s.name ?? s.id}`, s, 'strategy');
      });
    });
    stratRow.querySelectorAll('[data-action="delete-strategy"]').forEach(btn => {
      btn.addEventListener('click', () => deleteStrategy(btn.dataset.sid));
    });
    // v2.74.510 — STORAGE_SCHEMA §9/§10 deprecate (soft-delete) / reactivate via the
    // generic primitive lifecycle ops (background DEPRECATE_PRIMITIVE/RESTORE_PRIMITIVE).
    stratRow.querySelectorAll('[data-action="deprecate-strategy"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Deprecate this Strategy? It\'s kept but flagged deprecated — reactivate it any time.')) return;
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'DEPRECATE_PRIMITIVE', payload: { kind: 'strategy', id: btn.dataset.sid } }, r));
        if (res?.success) { toast('Strategy deprecated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    stratRow.querySelectorAll('[data-action="reactivate-strategy"]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const res = await new Promise(r => chrome.runtime.sendMessage(
          { type: 'RESTORE_PRIMITIVE', payload: { kind: 'strategy', id: btn.dataset.sid } }, r));
        if (res?.success) { toast('Strategy reactivated'); await refreshGroundList(); }
        else toast(`Failed: ${res?.error ?? 'unknown'}`, 'err');
      });
    });
    card.appendChild(stratRow);

    // Finally append the fully-assembled card to the list
    list.appendChild(card);
}

function openGroundForm(ground = null) {
  editingGroundId = ground?.id ?? null;
  $('ground-form-title').textContent = ground ? 'Edit Ground' : 'New Ground';
  // v2.74.328 — Prefill from the real pattern (urlPatterns[0]), NOT the
  // navigable `url` mirror (which has wildcards stripped). Otherwise editing
  // would silently drop a `/*` and break matching on re-save.
  $('input-url').value               = ground?.urlPatterns?.[0]?.pattern ?? ground?.url ?? '';
  $('input-ground-name').value       = ground?.name  ?? '';
  $('input-ground-aliases').value    = (ground?.aliases ?? []).join(', ');
  $('ground-form-card').classList.remove('hidden');
  $('input-url').focus();
}

function closeGroundForm() {
  editingGroundId = null;
  $('ground-form-card').classList.add('hidden');
  $('input-url').value            = '';
  $('input-ground-name').value    = '';
  $('input-ground-aliases').value = '';
}

async function saveGroundFromForm() {
  const url  = $('input-url').value.trim();
  const name = $('input-ground-name').value.trim();
  const aliasesText = $('input-ground-aliases').value.trim();

  if (!url) { toast('Enter a URL', 'err'); $('input-url').focus(); return; }

  // Light URL sanity check — accept anything URL constructor accepts
  try { new URL(url); } catch { toast('That doesn\'t look like a valid URL', 'err'); $('input-url').focus(); return; }

  if (!name) { toast('Enter a name', 'err'); $('input-ground-name').focus(); return; }

  const aliases = aliasesText
    .split(',').map(s => s.trim()).filter(Boolean);

  const isEditing = !!editingGroundId;
  const existing  = isEditing ? await StorageManager.getGround(editingGroundId) : null;

  const ground = {
    // v2.74.325 — new grounds get the GROUND_SPEC `gnd_` prefix; existing
    // ids are preserved (not re-keyed). saveGround normalizes the rest of
    // the record (urlPatterns[] from url, metadata{}, name/url mirrors).
    id        : existing?.id ?? `gnd_${uid()}`,
    url,
    name,
    aliases,
    createdAt : existing?.createdAt ?? Date.now(),
    updatedAt : Date.now(),
  };

  try {
    await StorageManager.saveGround(ground);
  } catch (err) {
    toast(`Failed to save Ground: ${err.message}`, 'err');
    return;
  }

  // v2.27.0 — notify other extension contexts (Studio, chat) that storage changed
  broadcastStorageChanged('ground', ground.id, 'saved');

  toast(isEditing ? `Ground "${name}" updated` : `Ground "${name}" created`);
  closeGroundForm();
  await refreshGroundList();
}

// Wire form buttons once at module load
$('btn-add-ground').addEventListener('click', () => openGroundForm(null));
$('btn-cancel-ground').addEventListener('click', () => closeGroundForm());
$('btn-save-ground').addEventListener('click', saveGroundFromForm);

async function deleteGround(id) {
  await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'SYNC_BRIDGE', kind: 'ground', id, action: 'deleted' }, () => resolve());
  });
  await StorageManager.deleteGround(id);
  await cloudMsg('RUN_SYNC');
  broadcastStorageChanged('ground', id, 'deleted');
  expandedGrounds.delete(id);
  toast('Ground deleted');
  await refreshGroundList();
}

// ─── Discovery ──────────────────────────────────────────────────────────────

async function startDiscovery(groundId) {
  const hasKey = await new Promise(res =>
    chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' }, r => res(r?.hasKey))
  );
  if (!hasKey) {
    toast('Sign in to the cloud or add an Anthropic API key in Settings', 'err');
    qs('[data-tab="settings"]').click();
    return;
  }

  // v2.74.434 — Confirm re-discovery against the siteMap (GroundMap retired).
  let existingStats = null;
  try {
    const r = await new Promise(res => chrome.runtime.sendMessage({ type: 'GET_SITEMAP', payload: { groundId } }, res));
    existingStats = r?.stats ?? null;
  } catch { existingStats = null; }
  if (existingStats && existingStats.nodes > 0) {
    if (!confirm(`Re-discover this Ground? The crawl re-folds into the existing site map (${existingStats.nodes} node${existingStats.nodes === 1 ? '' : 's'}, ${existingStats.edges} edge${existingStats.edges === 1 ? '' : 's'}).`)) return;
  }

  const panel = document.getElementById(`discovery-panel-${groundId}`);
  if (panel) {
    panel.classList.remove('hidden');
    panel.innerHTML = `
      <div class="discovery-progress">
        <span class="discovery-progress-status">Opening tab…</span>
        <button class="btn-secondary tiny" data-action="abort-discovery">Abort</button>
      </div>`;
    panel.querySelector('[data-action="abort-discovery"]').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'ABORT_DISCOVERY', payload: { groundId } });
    });
  }

  chrome.runtime.sendMessage({ type: 'START_DISCOVERY', payload: { groundId } }, (response) => {
    if (!response?.success && panel) {
      panel.innerHTML = `<span class="discovery-error">${escHtml(response?.error ?? 'Failed to start discovery')}</span>`;
    }
  });
}

// ─── Explore queue (Completeness slice 4) ────────────────────────────────────
//
// Auto-Explore every un-modeled archetype → modeled. Studio-driven (not a
// background worker): it opens ONE dedicated UNFOCUSED window, then for each
// archetype navigates that window's tab to the archetype's exemplar URL and reuses
// the existing EXPLORE_PAGE_STRUCTURE handler (which builds + caches the Locale and
// merges siteMapFromLocale → the node becomes `modeled`). Rate-limited; Abortable;
// resumable across runs (each run re-derives the not-yet-modeled set, so closing
// Studio merely pauses — re-click ▶ Model to continue).
//
// v2.74.442 — a SEPARATE unfocused window (not a background tab in the user's
// window): the queue tab is then the ACTIVE/visible tab of its own window, so it
// renders + loads lazy content AND screenshots work (captureVisibleTab needs the
// active tab) — closing the focused-vs-unfocused capture gap — without hijacking
// the user's working tab. (A window does briefly appear behind theirs.)
const exploreQueueRunning = new Set();   // groundIds with a live queue (also the abort flag)

function _navigateStudioTab(tabId, url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); reject(new Error('navigation timeout')); }, timeoutMs);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') { clearTimeout(to); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch((e) => { clearTimeout(to); chrome.tabs.onUpdated.removeListener(listener); reject(e); });
  });
}

async function startExploreQueue(groundId) {
  if (exploreQueueRunning.has(groundId)) return;

  const hasKey = await new Promise(res => chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' }, r => res(r?.hasKey)));
  if (!hasKey) { toast('Sign in to the cloud or add an Anthropic API key in Settings', 'err'); qs('[data-tab="settings"]')?.click(); return; }

  let res = null;
  try { res = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_SITEMAP', payload: { groundId } }, r)); } catch { res = null; }
  const nodes = res?.siteMap?.nodes ? Object.values(res.siteMap.nodes) : [];
  const targets = nodes
    .filter(n => n.status !== 'modeled' && n.exemplarUrl && /^https?:/i.test(n.exemplarUrl))
    .map(n => ({ url: n.exemplarUrl, name: n.name || n.urlPattern || n.exemplarUrl, exemplarByLocale: n.exemplarByLocale || {} }));
  if (!targets.length) { toast('No un-modeled archetypes with a navigable URL'); return; }
  if (!confirm(`Auto-Explore ${targets.length} archetype(s)? Opens a separate window (behind this one) and runs one Explore per template (~15–30s each → a few minutes total). Abort anytime; closing Studio pauses it (re-run to resume).`)) return;

  const panel = document.getElementById(`exq-panel-${groundId}`);
  const render = (msg, cls = '') => {
    if (!panel) return;
    panel.classList.remove('hidden');
    panel.innerHTML = `<div class="discovery-progress"><span class="discovery-progress-status ${cls}">${escHtml(msg)}</span><button class="btn-secondary tiny" data-action="abort-exq">Abort</button></div>`;
    panel.querySelector('[data-action="abort-exq"]')?.addEventListener('click', () => { exploreQueueRunning.delete(groundId); toast('Aborting after the current page…'); });
  };

  exploreQueueRunning.add(groundId);
  render(`Starting — ${targets.length} archetype(s)…`);
  let win = null, tabId = null, done = 0, failed = 0;
  try {
    // Separate, unfocused window → its tab is active/visible (renders lazy content +
    // captureVisibleTab works) without taking over the user's current tab.
    win = await chrome.windows.create({ url: 'about:blank', focused: false, type: 'normal', width: 1280, height: 900 });
    tabId = win?.tabs?.[0]?.id ?? null;
    if (tabId == null) throw new Error('could not open a window for the Explore queue');
    for (let i = 0; i < targets.length; i++) {
      if (!exploreQueueRunning.has(groundId)) break;   // aborted
      const t = targets[i];
      render(`Modeling ${i + 1}/${targets.length}: ${t.name.slice(0, 56)}`);
      try {
        await _navigateStudioTab(tabId, t.url);
        await new Promise(r => setTimeout(r, 1500));   // settle (lazy content)
        const r = await new Promise(rs => chrome.runtime.sendMessage({ type: 'EXPLORE_PAGE_STRUCTURE', payload: { tabId, groundId } }, rs));
        if (r?.success) {
          done++;
          // v2.74.446 — slice 3b: harvest other-language labels for this archetype
          // (bounded, no LLM) so resolution is language-agnostic. Best-effort.
          if (Object.keys(t.exemplarByLocale || {}).length > 1 && exploreQueueRunning.has(groundId)) {
            render(`Harvesting labels (${Object.keys(t.exemplarByLocale).length} langs): ${t.name.slice(0, 44)}`);
            try { await new Promise(rs => chrome.runtime.sendMessage({ type: 'HARVEST_LOCALE_LABELS', payload: { tabId, groundId, exemplarUrl: t.url, exemplarByLocale: t.exemplarByLocale } }, rs)); } catch { /* */ }
          }
        } else failed++;
      } catch { failed++; }
      await new Promise(r => setTimeout(r, 1200));      // rate-limit between archetypes
    }
    const aborted = !exploreQueueRunning.has(groundId);
    render(`${aborted ? 'Aborted' : 'Done'} — modeled ${done}/${targets.length}${failed ? `, ${failed} failed` : ''}`, aborted ? '' : 'discovery-progress-done');
    toast(`${aborted ? 'Explore queue aborted' : 'Explore queue complete'} — ${done} modeled${failed ? `, ${failed} failed` : ''}`);
  } catch (e) {
    if (panel) panel.innerHTML = `<span class="discovery-error">${escHtml(e?.message ?? 'Explore queue failed')}</span>`;
  } finally {
    exploreQueueRunning.delete(groundId);
    if (win?.id != null) { try { await chrome.windows.remove(win.id); } catch { /* */ } }
    refreshGroundList().catch(() => {});
  }
}

// Listen for discovery progress/completion broadcasts
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DISCOVERY_PROGRESS') {
    const { groundId, visited, total, currentUrl, currentPageType } = message.payload;
    const panel = document.getElementById(`discovery-panel-${groundId}`);
    if (!panel) return;
    const statusSpan = panel.querySelector('.discovery-progress-status');
    if (statusSpan) {
      const type = currentPageType ? ` — ${currentPageType}` : '';
      statusSpan.textContent = `Mapped ${visited} of ~${total} · ${currentUrl.slice(0, 60)}${type}`;
    }
  } else if (message.type === 'DISCOVERY_COMPLETE') {
    const { groundId, pageCount, aborted, drift } = message.payload;
    // v2.74.450 — drift (§8): surface what (re-)discovery changed.
    const driftTxt = drift && (drift.added || drift.statusChanged || drift.removed)
      ? ` · ${drift.added} new${drift.statusChanged ? `, ${drift.statusChanged} changed` : ''}${drift.removed ? `, ${drift.removed} removed` : ''}`
      : '';
    toast(aborted
      ? `Discovery aborted — kept partial map (${pageCount} pages)`
      : `Discovery complete — mapped ${pageCount} pages${driftTxt}`);
    refreshGroundList().catch(() => {});
  } else if (message.type === 'DISCOVERY_FAILED') {
    const { groundId, error } = message.payload;
    const panel = document.getElementById(`discovery-panel-${groundId}`);
    if (panel) {
      panel.innerHTML = `<span class="discovery-error">Discovery failed: ${escHtml(error)}</span>`;
    }
    toast(`Discovery failed: ${error}`, 'err');
  }
});

// ─── GroundMap viewer — RETIRED (v2.74.434) ─────────────────────────────────
//
// The per-Ground GroundMap viewer (toggleGroundMapViewer / renderGroundMapHtml)
// was removed: the Site Map section (GROUND_SPEC § 7) in each Ground card is now
// the canonical structural viewer, fed by GET_SITEMAP.

// ─── Parameter extraction helper ───────────────────────────────────────────

function extractParams(text) {
  const matches = [...text.matchAll(/\{\{([^}]+)\}\}/g)];
  const params  = matches.map(m => m[1]).filter(p => p !== 'USER_QUESTION');
  return [...new Set(params)];
}

// ─── Fragment authoring — Pass 17f: extracted ────────────────────────────
//
// Review panel + EXTRACT/ENUMERATE/EMIT inline forms live in
// Studio/FragmentForm.js. Studio.js retains the Ground card's Fragment
// list rendering (the + Fragment handler above launches the sidepanel
// fragment-author mode directly via BEGIN_FRAGMENT_AUTHOR; per-row
// edit/re-walk/delete dispatch through editFragment + rewalkFragment +
// deleteFragment imports).
//
// v2.74.22 — Fragment form, AI-walked (T3) tier, in-Studio walk panel,
// fragment-walk sidepanel mode, and the runtime dispatcher for
// FRAGMENT_WALK_* events all removed. Fragments are authored exclusively
// through the sidepanel fragment-author mode (T1 cache).
//
// State still file-local in FragmentForm.js:
//   - fragmentDrafts (Map)
//   - fragmentReviews (Map)
//   - fragmentAssertionCache (Map)
//   - fragmentPerspectiveCache (Map)
//
// checkAssertionRefFamilies extracted to Studio/assertionFamilyCheck.js
// (used by Fragment review save and Analysis save).
// ─── Strategy authoring (Pass C) ────────────────────────────────────────────
//
// A Strategy is a named, linear sequence of Fragment invocations with per-step
// param bindings. Strategies are composed (not walked) — the user picks
// Fragments from the library, sets bindings, saves. Invocation happens from
// chat via CapabilityAPI → ExecutionEngine.executeStrategy.
//
// Pass C is LINEAR only. Iterate / detect / conditional nodes are Pass E.

// v2.73.2 (Pass 4-f Phase 2) — Strategy form state migrated to
// Studio/StrategyForm.js as module-locals (_strategyDraft and 6
// caches + _dragSourceIdx). Form lifecycle now fully self-contained.
// See StrategyForm.js for the doc comments that previously lived here.

/**
 * v2.43.2 — Editor-side condition shape adapter.
 *
 * StrategyTree.normalizeStrategyBody wraps single conditions into Assertion
 * shape (`{match: 'all', conditions: [c]}`) because the engine and the
 * compound-assertion path want it that way. The editor, however, was
 * authored before M1 and operates on single-condition shape (`{type, ...}`).
 *
 * This walker unwraps Assertion-shaped conditions back to single-condition
 * shape after load. Editor code, handlers, save serialization all stay in
 * the single-condition mental model. Engine eval re-wraps via
 * TemplateWalker.checkConditions.#asAssertion, which already accepts both
 * shapes — so the round-trip works cleanly.
 *
 * If/when the editor gains compound assertion authoring (multiple conditions
 * per node with AND/OR), this adapter goes away and the editor moves to
 * Assertion shape natively.
 *
 * @param {Array<Object>} body - normalized strategy body
 * @returns {Array<Object>} body with conditions unwrapped in-place
 * @private
 */
// v2.72.83 — unwrapAssertionConditionsForEditor moved to
// Studio/StrategyForm.js (Pass 1). Imported below via the strategy-form
// imports near the top of this file.

/**
 * v2.63.0 (Iteration B) — Migrate legacy inline-operations sieves to
 * Analysis references.
 *
 * Pre-Iteration B sieves had `operations: [...]` directly on the node.
 * Iteration B sieves reference an Analysis by id with paramBindings. To
 * avoid breaking existing strategies, we migrate on load: each inline
 * sieve becomes a freshly-created user Analysis (saved to storage) and
 * the node is rewritten to reference it.
 *
 * Migration is idempotent — sieve nodes already in the new shape pass
 * through unchanged.
 *
 * The auto-created Analysis is named generically; user can rename or
 * delete after migration. Operations are preserved verbatim — no
 * automatic placeholder insertion. The Analysis has empty params (since
 * the operations are concrete values, not templates), so the strategy
 * step shows no param-binding rows.
 *
 * @param {Array} steps  - strategy fragmentSteps (mutated in place)
 * @param {string} groundId
 * @param {string} strategyName  - used for naming the auto-created Analysis
 * @returns {Promise<number>}    - count of sieve nodes migrated
 */
// v2.72.83 — migrateLegacySieves moved to Studio/StrategyForm.js (Pass 1).

/**
 * Open the Strategy form for authoring. If existingStrategy is supplied, the
 * form is pre-populated for editing; otherwise a fresh draft is created.
 */
// v2.72.99 (Pass 4-d) — openStrategyForm moved to Studio/StrategyForm.js.
// State writes via injected setters; cache loaders use the module's own
// imports of BUILTIN_ANALYSES / normalizeStrategyBody / uid.

/**
 * v2.72.27 (Pass 15) — Render the strategy form's tier picker / indicator
 * and gate body sections by tier:
 *   - tier=null (new strategy not yet picked): show gating screen, hide
 *     fragment steps section. Pre/post sections still visible (contract
 *     applies to both tiers) but the user is encouraged to pick tier first.
 *   - tier='cache': show indicator + fragment steps section.
 *   - tier='frontier': show indicator, hide fragment steps section. The
 *     compose contract (pre/post) is everything the model needs. Note:
 *     T3 strategies cannot run yet (Pass 16 will implement composer).
 */
// v2.72.86 (Pass 4a) — renderStrategyTierUI moved to
// Studio/StrategyForm.js. Imported alongside other strategy helpers.

// v2.72.98 (Pass 4-c) — closeStrategyForm moved to Studio/StrategyForm.js.
// State writes go through injected setters in setupStrategyForm.

// v2.72.84 (Pass 2) — renderStrategyConditions and
// renderStrategyConditionRow moved to Studio/StrategyForm.js. Imported
// at the top of this file along with Pass 1 helpers. The form module
// reads strategyDraft / strategyAssertionCache / strategyPerspectiveCache
// via injected getters (state still lives here until Pass 4); mutations
// happen on the returned references and propagate naturally.

/**
 * v2.29.3 (Pass E2-4) — Recursively render the Strategy body as a tree.
 * Fragment nodes render as the familiar step card. FOREACH nodes render
 * as a container card with nested body + nested +Add buttons.
 *
 * Node addressing uses a path array: [0, 'body', 2] means "top-level
 * step 0, then into its body, then step 2." Event handlers encode this
 * path in data-path attributes as JSON strings, and use the helpers
 * getNodeByPath / removeNodeByPath / swapSiblings to mutate the tree
 * without walking DOM.
 */

// v2.72.97 (Pass 4-b) — renderStrategySteps moved to
// Studio/StrategyForm.js. Imported alongside other strategy helpers.
// renderStrategyNodes + wireStrategyStepHandlers are still in studio.js
// (move in Passes 4-e and 4-f); they're injected via setupStrategyForm.

// v2.73.0 (Pass 4-e) — renderStrategyNodes (the 1011-line recursive
// body renderer) moved to Studio/StrategyForm.js. State reads go
// through _setup getters; renderConditionEditor (still in this file)
// is injected via setupStrategyForm.

/**
 * v2.31.0 (Pass G2) — Render an inline editor for a condition object.
 * Used by DETECT branches. Emits a type dropdown + the single value input
 * relevant to that type (selector / pattern / text). The path argument
 * points at the condition object's location in the tree — event handlers
 * use it to mutate the right condition without ambiguity.
 *
 * Shape matches the normalized condition: `{type, selector|pattern|text}`.
 *
 * @param {Object} condition  - the current condition object
 * @param {Array}  path       - path array from root to this condition
 * @returns {string} HTML
 * @private
 */
/**
 * v2.41.0 (Pass M1.1) — unified condition editor used everywhere a single
 * condition appears: DETECT branches, LOOP while, WAIT until, fragment
 * pre/postcondition rows.
 *
 * v2.42.0 (Pass M2) — added `assertion_ref` type. When opts.assertions is
 * provided (a list of stored assertions on the current ground), users can
 * pick a named assertion from a dropdown instead of authoring the condition
 * inline.
 *
 * Renders type dropdown + value field(s) appropriate to the type.
 *
 * Two callsite contexts share this:
 *
 *   1. Strategy editor (default) — strategy-tree path is a JSON array;
 *      handlers in renderStrategySteps wire .cond-type-select and
 *      .cond-value-input via data-path.
 *
 *   2. Fragment review (opts.context='fragment') — path is a different
 *      shape (fragmentId + side + idx). Handlers wire by data-fragment-id +
 *      data-side + data-idx instead.
 *
 * @param {Object} condition  - the current condition object
 * @param {Array|Object} path - path information; for strategies, an array;
 *   for fragments, an object { fragmentId, side, idx }
 * @param {Object} [opts]
 * @param {'strategy'|'fragment'} [opts.context='strategy']
 * @param {Array<Object>} [opts.assertions] - available named assertions on
 *   the current ground; if omitted, assertion_ref is hidden from the dropdown
 * @returns {string} HTML
 * @private
 */
/**
 * Render the editor for one condition row. Used by:
 *   - Fragment pre/post (context='fragment', allowedFamilies=['page'])
 *   - Strategy DETECT/LOOP/WAIT_FOR/TRY (context='strategy', allowedFamilies=['page','scope'])
 *   - Library assertion authoring (context='fragment' historically, but now
 *     allowedFamilies=['page','scope'] so authors can mix)
 *
 * v2.70.1 — Schema-driven type dropdown (filtered by allowedFamilies and
 * grouped by family/subfamily) replaces the hardcoded list. Generic field
 * renderer for scope-family conditions covers all 19 scope types with a
 * shared input layout.
 *
 * @param condition - the condition object, with .type and per-type fields
 * @param path - identifies this condition in the larger structure
 * @param opts - {context, assertions, iterScope, allowedFamilies}
 *   context:         'fragment' | 'strategy' (drives data-* attribute shape)
 *   assertions:      array of {id, name} for assertion_ref dropdown
 *   iterScope:       Set of FOREACH `as` names visible at this position
 *   allowedFamilies: ['page'] | ['scope'] | ['page','scope']
 *                    Defaults to ['page'] for backward compat. When 'scope'
 *                    is in the list, the dropdown surfaces scope-condition
 *                    types (binding_is_list, every_record_*, scalar_*, etc.)
 *                    and the renderer handles their fields generically.
 */
function renderConditionEditor(condition, path, opts = {}) {
  const context = opts.context ?? 'strategy';
  const assertions = Array.isArray(opts.assertions) ? opts.assertions : null;
  // v2.72.29 (Pass 17) — perspectives for perspective_ref dropdown integration.
  const perspectives = Array.isArray(opts.perspectives) ? opts.perspectives : [];
  const iterScope = opts.iterScope instanceof Set ? opts.iterScope : null;
  const iterNames = iterScope ? [...iterScope] : [];
  // v2.70.1 — Per-context family allowlist. Defaults to ['page'] — pre-v2.70
  // behavior. Strategy editing should pass ['page','scope']; library assertion
  // authoring should pass ['page','scope']; Fragment pre/post stays ['page'].
  const allowedFamilies = Array.isArray(opts.allowedFamilies) && opts.allowedFamilies.length > 0
    ? opts.allowedFamilies
    : ['page'];

  const type = condition?.type ?? 'selector_present';
  const isFieldOp = String(type).startsWith('field_');

  // Build the data-* attributes that route change events to the right handler.
  let dataAttrs;
  if (context === 'fragment') {
    const { fragmentId, side, idx } = path;
    dataAttrs =
      `data-context="fragment" data-fragment-id="${escAttr(fragmentId)}" data-side="${escAttr(side)}" data-idx="${idx}"`;
  } else if (context === 'observation') {
    // v2.72.4 (Pass 3d) — Observation form pre/post. side is 'pre' or 'post'.
    // Handlers are scoped to the Observation form's list containers and
    // mutate observationDraft.preconditions/postconditions in place.
    const { side, idx } = path;
    dataAttrs =
      `data-context="observation" data-side="${escAttr(side)}" data-idx="${idx}"`;
  } else {
    const pathJson = JSON.stringify(path);
    dataAttrs = `data-context="strategy" data-path="${escAttr(pathJson)}"`;
  }

  // ── Per-type field rendering ────────────────────────────────────────────
  // Page-side types keep their existing rich layouts (preserved verbatim).
  // Scope-side types get a generic renderer driven by CONDITION_FIELDS
  // schema — fields beyond `binding`/`variable` rendered as text inputs
  // with placeholders derived from field name.
  let valueFieldHtml;
  if (type === 'selector_present' || type === 'selector_absent') {
    valueFieldHtml = `
      <input type="text" class="cond-value-input" ${dataAttrs} data-field="selector"
             value="${escAttr(condition?.selector ?? '')}"
             placeholder="CSS selector, e.g. .job-detail.loaded" />`;
  } else if (type === 'url_matches') {
    valueFieldHtml = `
      <input type="text" class="cond-value-input" ${dataAttrs} data-field="pattern"
             value="${escAttr(condition?.pattern ?? '')}"
             placeholder="URL substring or regex, e.g. /viewjob?jk=" />`;
  } else if (type === 'text_present') {
    valueFieldHtml = `
      <input type="text" class="cond-value-input" ${dataAttrs} data-field="text"
             value="${escAttr(condition?.text ?? '')}"
             placeholder="Text to look for (case-insensitive)" />`;
  } else if (type === 'attribute_equals') {
    valueFieldHtml = `
      <div class="cond-attr-row">
        <input type="text" class="cond-value-input cond-value-narrow" ${dataAttrs} data-field="selector"
               value="${escAttr(condition?.selector ?? '')}"
               placeholder="CSS selector" title="Element selector" />
        <input type="text" class="cond-value-input cond-value-narrow" ${dataAttrs} data-field="attribute"
               value="${escAttr(condition?.attribute ?? '')}"
               placeholder="attribute name" title="Attribute name (e.g. aria-pressed)" />
        <input type="text" class="cond-value-input" ${dataAttrs} data-field="value"
               value="${escAttr(condition?.value ?? '')}"
               placeholder="expected value" title="Expected attribute value (empty = empty attribute)" />
      </div>`;
  } else if (type === 'assertion_ref') {
    // v2.70.6 — The primary type dropdown now carries the assertion
    // selection directly (synthetic `pred_ref:<id>` values under the
    // Custom optgroup). The right-side area shows the selected assertion's
    // description as read-only hint text — useful context without
    // duplicating the picker UI.
    const refId = condition?.assertionId;
    const matched = (assertions ?? []).find(p => p.id === refId);
    if (matched) {
      const desc = matched.description ?? '';
      valueFieldHtml = desc
        ? `<span class="cond-pred-hint" title="${escAttr(matched.name ?? matched.id)}">${escHtml(desc)}</span>`
        : `<span class="cond-pred-hint cond-pred-hint-empty">no description</span>`;
    } else if (refId) {
      // Reference points at a assertion not in our list — deleted or stale.
      valueFieldHtml = `<span class="cond-pred-hint cond-pred-hint-stale">missing assertion: ${escHtml(refId)}</span>`;
    } else {
      valueFieldHtml = `<span class="cond-pred-hint cond-pred-hint-empty">— pick a assertion from the dropdown —</span>`;
    }
  } else if (type === 'perspective_ref') {
    // v2.72.29 (Pass 17) — perspective_ref. Like assertion_ref, the primary
    // dropdown carries the perspective selection (synthetic `perspective_ref:<id>`).
    // Right-side area shows the selected perspective's landmark count + first
    // landmark role as a quick reference.
    const refId = condition?.perspectiveId;
    const matched = perspectives.find(l => l.id === refId);
    if (matched) {
      // v2.74.343 — Count via the flat landmarkRefs mirror (matched.landmarks
      // is now a LandmarkNode[] tree; .length is just the root count, which
      // undercounts structured perspectives). Node role label, falling back to
      // legacy alias.
      const lmCount = Array.isArray(matched.landmarkRefs) ? matched.landmarkRefs.length
        : (Array.isArray(matched.landmarks) ? matched.landmarks.length : 0);
      const firstRole = matched.landmarks?.[0]?.role ?? matched.landmarks?.[0]?.alias ?? '';
      const summary = lmCount > 0
        ? `${lmCount} landmark${lmCount === 1 ? '' : 's'}${firstRole ? ` · ${firstRole}${lmCount > 1 ? '…' : ''}` : ''}`
        : 'no landmarks';
      valueFieldHtml = `<span class="cond-pred-hint" title="${escAttr(matched.description ?? '')}">${escHtml(summary)}</span>`;
    } else if (refId) {
      valueFieldHtml = `<span class="cond-pred-hint cond-pred-hint-stale">missing perspective: ${escHtml(refId)}</span>`;
    } else {
      valueFieldHtml = `<span class="cond-pred-hint cond-pred-hint-empty">— pick a perspective from the dropdown —</span>`;
    }
  } else if (isFieldOp) {
    // v2.46.0 (Pass O1) — record-field condition on iteration variable.
    const variableOpts = iterNames.map(n =>
      `<option value="${escAttr(n)}" ${n === condition?.variable ? 'selected' : ''}>${escHtml(n)}</option>`
    ).join('');
    const showValue = type !== 'field_present';
    const valuePlaceholder = type === 'field_equals'
      ? 'expected value (e.g. true, Caregiver, etc.)'
      : 'comparison value (number)';
    valueFieldHtml = `
      <div class="cond-attr-row">
        <select class="cond-value-input cond-value-narrow" ${dataAttrs} data-field="variable" title="Iteration variable to read from">
          <option value="" ${!condition?.variable ? 'selected' : ''}>— pick a variable —</option>
          ${variableOpts}
        </select>
        <input type="text" class="cond-value-input cond-value-narrow" ${dataAttrs} data-field="field"
               value="${escAttr(condition?.field ?? '')}"
               placeholder="field name (must match an OBSERVATION or ENUMERATE field)" title="Field name on the iteration record" />
        ${showValue ? `<input type="text" class="cond-value-input" ${dataAttrs} data-field="value"
               value="${escAttr(condition?.value ?? '')}"
               placeholder="${valuePlaceholder}" />` : ''}
      </div>`;
  } else if (CONDITION_FIELDS[type]?.family === 'scope') {
    // v2.70.1 — Scope-family condition (binding_is_list, every_record_*,
    // record_*, scalar_*). Generic renderer driven by schema fields.
    //
    // The `binding` field is hidden — at strategy/library call-sites the
    // author types the binding name as a free-text input (the binding has
    // to exist in scope at the call-site). At Analysis pre/post call-sites
    // the binding is implicit (INPUT/OUTPUT) and that editor uses a
    // different code path.
    valueFieldHtml = renderScopeConditionFields(condition, type, dataAttrs);
  } else {
    // Unknown type — render a fallback message so authors can see something
    // is wrong rather than getting silent emptiness.
    valueFieldHtml = `<span class="field-hint">unknown condition type: ${escHtml(type)}</span>`;
  }

  // v2.70.6 — Schema-driven dropdown via shared helper. Replaces the
  // previous four separate option-builders (pageOptionsHtml, refOptionHtml,
  // fieldOpsHtml, scopeOptionsHtml) with a single call that handles all
  // the family/subfamily grouping. The helper emits flat optgroups with
  // "Page · DOM" / "Data · Scalar" / "Custom" labels (HTML doesn't support
  // nested optgroups).
  const typeOpts = buildConditionTypeOptions({
    allowedFamilies,
    assertions,
    perspectives,
    iterScope,
    currentType: type,
    currentPredId: condition?.assertionId ?? '',
    currentPerspectiveId: condition?.perspectiveId ?? '',
  });

  return `
    <div class="cond-editor" ${dataAttrs}>
      <select class="cond-type-select" ${dataAttrs}>
        ${typeOpts}
      </select>
      ${valueFieldHtml}
    </div>`;
}

/**
 * v2.70.1 — Generic field renderer for scope-family conditions.
 *
 * All scope types share a small set of field names: binding, fieldName,
 * variable, field, min, max, count, value, values. This function maps
 * each to an input shape with appropriate placeholder. The schema
 * (CONDITION_FIELDS) drives which fields appear for the given type.
 *
 * Fields rendered side-by-side in a cond-attr-row for compact layout.
 */
function renderScopeConditionFields(condition, type, dataAttrs) {
  const schema = CONDITION_FIELDS[type];
  if (!schema) return '';
  const placeholderFor = (fname) => {
    switch (fname) {
      case 'binding':   return 'binding name (e.g. DEVICES, OUTPUT)';
      case 'fieldName': return 'field name (e.g. deviceName)';
      case 'min':       return 'min (number or {{PARAM}})';
      case 'max':       return 'max (number or {{PARAM}})';
      case 'count':     return 'exact count (number or {{PARAM}})';
      case 'value':     return 'value to match (string or {{PARAM}})';
      case 'values':    return 'comma-separated values (e.g. active,pending)';
      case 'variable':  return 'iteration variable';
      case 'field':     return 'field name';
      default:          return fname;
    }
  };
  const titleFor = (fname) => {
    switch (fname) {
      case 'binding':   return 'Scope binding to test (must exist in scope at runtime)';
      case 'fieldName': return 'Record field name';
      case 'values':    return 'Comma-separated allowed values';
      default:          return placeholderFor(fname);
    }
  };
  // Determine which fields are wide vs narrow. Numeric and short fields
  // are narrow; binding name and value text are wider.
  const NARROW_FIELDS = new Set(['min', 'max', 'count', 'fieldName']);
  const inputs = schema.fields.map(fname => {
    const v = condition?.[fname] ?? '';
    const cls = NARROW_FIELDS.has(fname) ? 'cond-value-input cond-value-narrow' : 'cond-value-input';
    return `<input type="text" class="${cls}" ${dataAttrs} data-field="${escAttr(fname)}"
                   value="${escAttr(v)}"
                   placeholder="${escAttr(placeholderFor(fname))}"
                   title="${escAttr(titleFor(fname))}" />`;
  }).join('');
  return `<div class="cond-attr-row">${inputs}</div>`;
}

/**
 * v2.70.6 — Unified condition-type dropdown builder. Used by both
 * renderConditionEditor (strategy/library/fragment) and renderAnalysisConditionRow
 * (Analysis pre/post) so the dropdown shape stays consistent across editors.
 *
 * Three top-level groups: Page, Data, Custom. Within Page and Data, second-tier
 * sub-groups by subfamily. Custom is library assertions as direct options.
 *
 * HTML <select> doesn't support nested <optgroup>. The two-tier structure is
 * approximated by flat optgroups labeled "Page · DOM", "Page · Browser",
 * "Data · List" etc. — visually two-tier, structurally flat.
 *
 * @param opts.allowedFamilies  - ['page'] | ['scope'] | ['page','scope']
 * @param opts.assertions       - array of library assertions (full records, with .body)
 * @param opts.iterScope        - Set of FOREACH `as` names (drives Iteration record group)
 * @param opts.currentType      - currently-selected condition type (for selected attr)
 * @param opts.currentPredId    - currently-selected assertion id (for selected attr on Custom)
 *
 * Library assertion options use synthetic value `pred_ref:<id>`. Change handlers
 * detect this prefix and construct {type: 'assertion_ref', assertionId: <id>}.
 *
 * Family filtering for Custom group: a library assertion is included only
 * when its conditions' families are a subset of allowedFamilies. A page-only
 * library assertion referenced from Analysis (scope-only) call-site is
 * excluded — picking it would just fail at save with the family-compat error.
 * Mixed-family assertions are included when allowedFamilies is page+scope.
 */
function buildConditionTypeOptions(opts = {}) {
  const allowedFamilies = Array.isArray(opts.allowedFamilies) && opts.allowedFamilies.length > 0
    ? opts.allowedFamilies
    : ['page'];
  const assertions = Array.isArray(opts.assertions) ? opts.assertions : [];
  // v2.72.29 (Pass 17) — perspectives array and currentPerspectiveId for perspective_ref
  // dropdown integration. Perspectives are page-family vocabulary; only surfaced
  // when 'page' is in allowedFamilies.
  const perspectives = Array.isArray(opts.perspectives) ? opts.perspectives : [];
  const iterScope = opts.iterScope instanceof Set ? opts.iterScope : null;
  const iterAvailable = iterScope ? iterScope.size > 0 : false;
  const currentType = opts.currentType ?? '';
  const currentPredId = opts.currentPredId ?? '';
  const currentPerspectiveId = opts.currentPerspectiveId ?? '';

  const groups = [];

  // ── Page family ─────────────────────────────────────────────────────────
  if (allowedFamilies.includes('page')) {
    const PAGE_SUBS = [
      { sub: 'dom',     label: 'Page · DOM' },
      { sub: 'browser', label: 'Page · Browser' },
    ];
    // v2.70.1 historical: only 5 of 8 page types were exposed in the dropdown
    // (selector_present, selector_absent, url_matches, text_present,
    // attribute_equals). v2.70.6 keeps that visible set — the remaining
    // three (meta_equals, resource_loaded, cookie_present) exist in schema
    // and at runtime, but renderConditionEditor's per-type field rendering
    // doesn't have branches for them yet. Surfacing them in the dropdown
    // without value-input rendering would produce "unknown condition type"
    // hints. A future iteration can add field rendering for these and
    // remove the exclude list.
    const PAGE_HIDDEN = new Set(['meta_equals', 'resource_loaded', 'cookie_present']);
    const PAGE_LABELS = {
      selector_present: 'selector appears',
      selector_absent:  'selector disappears',
      text_present:     'text appears',
      attribute_equals: 'attribute equals',
      url_matches:      'URL matches',
    };
    for (const { sub, label } of PAGE_SUBS) {
      const types = Object.entries(CONDITION_FIELDS)
        .filter(([t, schema]) =>
          schema.family === 'page' && schema.subfamily === sub && !PAGE_HIDDEN.has(t)
        )
        .map(([t]) => t);
      if (types.length === 0) continue;
      const optionsHtml = types.map(t =>
        `<option value="${escAttr(t)}"${t === currentType ? ' selected' : ''}>${escHtml(PAGE_LABELS[t] ?? t)}</option>`
      ).join('');
      groups.push(`<optgroup label="${escAttr(label)}">${optionsHtml}</optgroup>`);
    }
  }

  // ── Data family ─────────────────────────────────────────────────────────
  if (allowedFamilies.includes('scope')) {
    // v2.70.6 — Iteration record subgroup renders when an iteration variable
    // is in scope OR when the current condition is already a field_* type.
    // The latter ensures an existing field_* condition keeps its option
    // visible in the dropdown even at a position outside FOREACH (e.g.
    // when editing).
    const currentIsFieldOp = typeof currentType === 'string' && currentType.startsWith('field_');
    const SCOPE_SUBS = [
      { sub: 'list',         label: 'Data · List',            condition: () => true },
      { sub: 'record',       label: 'Data · Record',          condition: () => true },
      { sub: 'scalar',       label: 'Data · Scalar',          condition: () => true },
      // v2.72.20 (Pass 7c) — Tagged-value kind checks (binding_is_section,
      // binding_is_image, binding_is_document) and document assertions.
      { sub: 'tagged-value', label: 'Data · Type check',       condition: () => true },
      { sub: 'document',     label: 'Data · Document',         condition: () => true },
      { sub: 'record-field', label: 'Data · Iteration record', condition: () => iterAvailable || currentIsFieldOp },
    ];
    for (const { sub, label, condition } of SCOPE_SUBS) {
      if (!condition()) continue;
      const types = Object.entries(CONDITION_FIELDS)
        .filter(([_, schema]) => schema.family === 'scope' && schema.subfamily === sub)
        .map(([t]) => t);
      if (types.length === 0) continue;
      const optionsHtml = types.map(t =>
        `<option value="${escAttr(t)}"${t === currentType ? ' selected' : ''}>${escHtml(t)}</option>`
      ).join('');
      groups.push(`<optgroup label="${escAttr(label)}">${optionsHtml}</optgroup>`);
    }
  }

  // ── Custom family — library assertions ──────────────────────────────────
  // Filter by family compatibility: include only assertions whose conditions
  // are all in allowedFamilies. A assertion's effective families come from
  // walking its conditions; we accept it iff every family is allowed (so
  // mixed-family assertions need ALL their families allowed by the call-site).
  // Sort alphabetically by name (case-insensitive). Falls back to id if no name.
  const allowedSet = new Set(allowedFamilies);
  const compatAssertions = assertions.filter(p => {
    const fams = effectiveFamilies(p.body ?? {});
    // No conditions → effective families empty → vacuously compatible.
    for (const fam of fams) {
      if (fam === 'reference') continue;  // nested ref — accept; runtime resolves
      if (!allowedSet.has(fam)) return false;
    }
    return true;
  }).sort((a, b) => {
    const an = (a.name ?? a.id ?? '').toLowerCase();
    const bn = (b.name ?? b.id ?? '').toLowerCase();
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  if (compatAssertions.length > 0) {
    const optionsHtml = compatAssertions.map(p => {
      const value = `pred_ref:${p.id}`;
      const isSelected = currentType === 'assertion_ref' && currentPredId === p.id;
      return `<option value="${escAttr(value)}"${isSelected ? ' selected' : ''}>${escHtml(p.name ?? p.id)}</option>`;
    }).join('');
    groups.push(`<optgroup label="Custom">${optionsHtml}</optgroup>`);
  }

  // Edge case: current condition references a assertion that's not in the
  // compatAssertions list (deleted, or family-incompatible). Add a stale
  // option so the dropdown can show a 'selected' state matching the stored
  // condition. Author can pick a different option to replace it.
  if (currentType === 'assertion_ref' && currentPredId) {
    const presentInList = compatAssertions.some(p => p.id === currentPredId);
    if (!presentInList) {
      const value = `pred_ref:${currentPredId}`;
      groups.push(`<optgroup label="Custom · Stale"><option value="${escAttr(value)}" selected>(missing: ${escHtml(currentPredId)})</option></optgroup>`);
    }
  }

  // ── v2.72.29 (Pass 17) — Perspectives optgroup ─────────────────────────────
  // Perspectives are page-family vocabulary. Only surfaced when 'page' is
  // allowed at the call-site. Sorted alphabetically.
  if (allowedFamilies.includes('page') && perspectives.length > 0) {
    const sortedLocs = [...perspectives].sort((a, b) => {
      const an = (a.name ?? a.id ?? '').toLowerCase();
      const bn = (b.name ?? b.id ?? '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });
    const optionsHtml = sortedLocs.map(l => {
      const value = `perspective_ref:${l.id}`;
      const isSelected = currentType === 'perspective_ref' && currentPerspectiveId === l.id;
      const lmCount = Array.isArray(l.landmarks) ? l.landmarks.length : 0;
      return `<option value="${escAttr(value)}"${isSelected ? ' selected' : ''}>${escHtml(l.name ?? l.id)} (${lmCount} landmark${lmCount === 1 ? '' : 's'})</option>`;
    }).join('');
    groups.push(`<optgroup label="Perspectives">${optionsHtml}</optgroup>`);
  }
  // Stale perspective_ref handling.
  if (currentType === 'perspective_ref' && currentPerspectiveId) {
    const presentInList = perspectives.some(l => l.id === currentPerspectiveId);
    if (!presentInList) {
      const value = `perspective_ref:${currentPerspectiveId}`;
      groups.push(`<optgroup label="Perspectives · Stale"><option value="${escAttr(value)}" selected>(missing: ${escHtml(currentPerspectiveId)})</option></optgroup>`);
    }
  }

  return groups.join('');
}

/**
 * v2.70.6 — Decode a dropdown value (which may be a synthetic 'pred_ref:<id>'
 * for library assertion options) into a condition skeleton.
 *
 * Returns { type, assertionId? } — caller passes type to emptyCondition() to
 * fill out remaining fields, then sets assertionId if reference.
 */
function decodeConditionTypeValue(value) {
  if (typeof value === 'string' && value.startsWith('pred_ref:')) {
    return { type: 'assertion_ref', assertionId: value.slice('pred_ref:'.length) };
  }
  // v2.72.29 (Pass 17) — perspective_ref:<id> → perspective_ref condition.
  if (typeof value === 'string' && value.startsWith('perspective_ref:')) {
    return { type: 'perspective_ref', perspectiveId: value.slice('perspective_ref:'.length) };
  }
  return { type: value };
}

// v2.72.97 (Pass 4-b) — renderStrategyBindings moved to
// Studio/StrategyForm.js. Imported alongside other strategy helpers.

// ── Path-based tree navigation helpers ───────────────────────────────────
// v2.72.83 — getNodeByPath + getParentArrayAndIndex moved to
// Studio/StrategyForm.js (Pass 1).

// ── Event wiring ─────────────────────────────────────────────────────────

// v2.72.86 (Pass 4a) — setFragmentSelectValues moved to
// Studio/StrategyForm.js. Imported alongside other strategy helpers.

// v2.73.1 (Pass 4-f Phase 1) — wireStrategyStepHandlers (the
// 800-line step-level event wiring) moved to Studio/StrategyForm.js.
// State reads go through _setup getters; decodeConditionTypeValue is
// injected via setupStrategyForm.

// v2.72.98 (Pass 4-c) — wireTopLevelDragAndDrop moved to
// Studio/StrategyForm.js. dragSourceIdx access goes through
// setup-injected getter/setter.


// v2.72.85 (Pass 3) — renderStrategyParamsPreview, collectStrategyParams,
// detectStrategyParamConflicts, analyzeStrategyComposition, and
// renderStrategyWarnings moved to Studio/StrategyForm.js. Imported
// at the top of this file alongside Pass 1+2 helpers.

function addWarningIcon(card) {
  const head = card.querySelector('.strategy-step-head, .strategy-foreach-head');
  if (!head || head.querySelector('.step-warning-icon')) return;
  const icon = document.createElement('span');
  icon.className = 'step-warning-icon';
  icon.textContent = '⚠';
  icon.title = 'See composition warnings below';
  const label = head.querySelector('.strategy-step-label');
  if (label) label.after(icon);
  else head.prepend(icon);
}

// v2.72.99 (Pass 4-d) — 11 body Add handlers (btn-add-strategy-step,
// foreach, wait, pause, sieve, detect, loop, try, navigate, scroll,
// observation, in-new-tab) moved into wireStrategyTopLevelInputs()
// inside Studio/StrategyForm.js.

// v2.72.97 (Pass 4-b) — result-template input handler moved into
// wireStrategyTopLevelInputs() inside Studio/StrategyForm.js. Called
// once during init below the setupStrategyForm({...}) block.

// v2.72.98 (Pass 4-c) — cancel handler moved into
// wireStrategyTopLevelInputs() inside Studio/StrategyForm.js.

// v2.73.2 (Pass 4-f Phase 2) — btn-save-strategy click handler
// (the 656-line save+validate+persist) moved to Studio/StrategyForm.js
// inside an exported wireStrategySaveHandler() init function. Called
// once from init alongside wireStrategyTopLevelInputs().

// v2.72.99 (Pass 4-d) — editStrategy moved to Studio/StrategyForm.js.
// Imported alongside openStrategyForm.

// v2.72.86 (Pass 4a) — deleteStrategy and testRunStrategy moved to
// Studio/StrategyForm.js. Imported at the top of this file alongside
// other strategy helpers.

async function refreshSettings() {
  const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_API_KEY' }, r));
  const keyInput = $('input-api-key');
  keyInput.placeholder = res?.key ? `Current: ${res.key}` : 'sk-ant-…';
  keyInput.value = '';
  // Optional disclosure: auto-expand only when a local key is already saved so
  // existing BYO-key users still see/manage it; otherwise keep it collapsed
  // (the managed proxy is the default path — no key needed).
  const keyDetails = $('api-key-details');
  if (keyDetails) keyDetails.open = !!res?.key;

  // Load close-tab setting
  const ctRes = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'close_tab_after_run', defaultValue: true } }, r)
  );
  $('chk-close-tab').checked = ctRes?.value !== false;

  // v2.74.9 — Verbose fragment descriptions toggle. Reflect current
  // preference value in the checkbox; cache in module state so the
  // ground list render path picks it up without re-fetching.
  const vRes = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'verbose_fragment_desc', defaultValue: false } }, r)
  );
  _verboseFragmentDesc = vRes?.value === true;
  const vChk = $('chk-verbose-fragment-desc');
  if (vChk) vChk.checked = _verboseFragmentDesc;

  // v2.74.12 — Fragment length cap + unlimited.
  const capRes = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'fragment_cap', defaultValue: 7 } }, r)
  );
  const capInput = $('input-fragment-cap');
  if (capInput) capInput.value = String(Number(capRes?.value) || 7);
  const unlimRes = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'fragment_cap_unlimited', defaultValue: false } }, r)
  );
  const unlimChk = $('chk-fragment-cap-unlimited');
  if (unlimChk) unlimChk.checked = unlimRes?.value === true;
  // When unlimited is on, dim the numeric input — it's still preserved as
  // the "soft threshold" reference but doesn't gate authoring.
  if (capInput) capInput.disabled = unlimRes?.value === true;

  // v2.74.18 (Ship D) — Observation extract cap + unlimited. Mirrors the
  // fragment-cap pattern. Setting keys: observation_extract_cap (numeric)
  // and observation_extract_cap_unlimited (boolean). The sidepanel
  // observation-author mode reads these on mount.
  const obsCapRes = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'observation_extract_cap', defaultValue: 7 } }, r)
  );
  const obsCapInput = $('input-observation-extract-cap');
  if (obsCapInput) obsCapInput.value = String(Number(obsCapRes?.value) || 7);
  const obsUnlimRes = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_SETTING', payload: { key: 'observation_extract_cap_unlimited', defaultValue: false } }, r)
  );
  const obsUnlimChk = $('chk-observation-extract-cap-unlimited');
  if (obsUnlimChk) obsUnlimChk.checked = obsUnlimRes?.value === true;
  if (obsCapInput) obsCapInput.disabled = obsUnlimRes?.value === true;

  await refreshCloudSettings();
}

function cloudMsg(type, payload = {}) {
  const timeoutMs = (type === 'RUN_SYNC' || type === 'CLOUD_SIGN_IN' || type === 'CLOUD_SIGN_OUT')
    ? 120000
    : 15000;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    const timer = setTimeout(() => {
      finish({
        success: false,
        error: 'Background not responding — open chrome://extensions and reload AHuB',
      });
    }, timeoutMs);
    chrome.runtime.sendMessage({ type, payload }, (res) => {
      clearTimeout(timer);
      finish(res ?? {
        success: false,
        error: chrome.runtime.lastError?.message || 'No response from background',
      });
    });
  });
}

function showCloudMsg(text, type) {
  const el = $('cloud-status-msg');
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function syncPathLabel(path) {
  const meta = recordMetaFromPath(path);
  if (meta) {
    const name = meta.kind === 'locale' ? meta.id : `${meta.kind} ${meta.id}`;
    return name.length > 80 ? `${name.slice(0, 77)}…` : name;
  }
  const tail = String(path).split('/').slice(-2).join('/');
  return tail.length > 80 ? `${tail.slice(0, 77)}…` : tail;
}

async function refreshCloudSettings() {
  const statusLine = $('cloud-status-line');
  const userIdEl = $('cloud-user-id');
  const signInBtn = $('btn-cloud-sign-in');
  const signOutBtn = $('btn-cloud-sign-out');
  const syncBtn = $('btn-cloud-sync-now');
  const syncLine = $('cloud-sync-line');
  const conflictsEl = $('cloud-conflicts');
  const enabledChk = $('chk-cloud-enabled');
  if (!statusLine) return;

  const [statusRes, settingsRes] = await Promise.all([
    cloudMsg('GET_CLOUD_STATUS'),
    cloudMsg('GET_CLOUD_SETTINGS'),
  ]);

  const settings = settingsRes?.settings || {};
  if (enabledChk) enabledChk.checked = settings.enabled === true;

  const apiInput = $('input-cloud-api-url');
  const domainInput = $('input-cloud-cognito-domain');
  const clientInput = $('input-cloud-cognito-client');
  const redirectInput = $('input-cloud-oauth-redirect');
  if (apiInput) apiInput.value = settings.apiBaseUrl || '';
  if (domainInput) domainInput.value = settings.cognitoDomain || '';
  if (clientInput) clientInput.value = settings.cognitoClientId || '';

  if (!statusRes?.success) {
    const err = statusRes?.error ? `: ${statusRes.error}` : '';
    statusLine.textContent = `Cloud status unavailable${err}`;
    if (userIdEl) userIdEl.classList.add('hidden');
    // Keep auth buttons usable even when the status probe fails.
    if (signInBtn) signInBtn.disabled = false;
    if (signOutBtn) signOutBtn.disabled = false;
    if (syncBtn) syncBtn.disabled = true;
    return;
  }

  const s = statusRes.status || {};
  if (redirectInput) redirectInput.value = s.oauthRedirectUri || '';
  const canSync = !!(s.signedIn && s.cloudEnabled);
  const hybridActive = canSync && s.storageBackend === 'hybrid';

  if (syncBtn) syncBtn.disabled = !canSync;
  if (syncLine) {
    if (canSync) {
      const mode = hybridActive ? 'hybrid sync' : 'ready (upgrades on sync)';
      const parts = [mode, `conflicts: ${s.pendingConflicts || 0}`];
      if (hybridActive) {
        parts.push(`outbox: ${s.outboxPending || 0}`);
        if (s.workspacePartitionCount > 0) {
          parts.push(`partition: ${s.workspacePartitionCount}`);
        }
        const last = s.lastSync;
        if (last?.ok) {
          parts.push(`last: +${last.pushed || 0}/-${last.pulled || 0}`);
        }
        if (s.lastSyncAt) {
          parts.push(relTime(s.lastSyncAt));
        }
      }
      syncLine.textContent = parts.join(' · ');
      syncLine.classList.remove('hidden');
    } else if (s.signedIn) {
      syncLine.textContent = 'Signed in — enable Orchard Cloud to sync';
      syncLine.classList.remove('hidden');
    } else {
      syncLine.classList.add('hidden');
    }
  }

  if (conflictsEl) {
    if ((s.pendingConflicts || 0) > 0 && hybridActive) {
      const conflictsRes = await cloudMsg('GET_SYNC_CONFLICTS');
      const rows = conflictsRes?.conflicts || [];
      conflictsEl.innerHTML = rows.map((row) => {
        const c = row.conflict || {};
        const tier = conflictTierForPath(row.path);
        const label = syncPathLabel(row.path);
        return `
        <div class="settings-note" style="margin-bottom:8px;padding:8px;border:1px solid var(--border, #333);border-radius:6px">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
            <strong>${escHtml(label)}</strong>
            <span class="pick-chooser-tier-badge tier-${tier}" title="Conflict tier ${tier}">tier ${tier}</span>
          </div>
          <div style="font-family:monospace;font-size:10px;opacity:0.7;margin-top:4px;word-break:break-all">${escHtml(row.path)}</div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap">
            <button class="btn-secondary tiny" type="button" data-conflict-view="${escAttr(row.path)}">View diff</button>
            <button class="btn-secondary tiny" type="button" data-conflict-path="${escAttr(row.path)}" data-resolution="keep-mine">Keep mine</button>
            <button class="btn-secondary tiny" type="button" data-conflict-path="${escAttr(row.path)}" data-resolution="keep-theirs">Keep theirs</button>
          </div>
        </div>`;
      }).join('');
      conflictsEl.classList.remove('hidden');
      conflictsEl.querySelectorAll('[data-conflict-view]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const path = btn.getAttribute('data-conflict-view');
          const row = rows.find((r) => r.path === path);
          const c = row?.conflict || {};
          showJsonModal(`Sync conflict: ${syncPathLabel(path)}`, { mine: c.client ?? null, theirs: c.server ?? null }, 'sync-conflict');
        });
      });
      conflictsEl.querySelectorAll('[data-conflict-path]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const path = btn.getAttribute('data-conflict-path');
          const resolution = btn.getAttribute('data-resolution');
          const res = await cloudMsg('RESOLVE_SYNC_CONFLICT', { path, resolution });
          if (res?.success) {
            showCloudMsg('Conflict resolved', 'ok');
            await refreshCloudSettings();
            refreshGroundList().catch(() => {});
          } else {
            showCloudMsg(res?.error || 'Resolve failed', 'err');
          }
        });
      });
    } else {
      conflictsEl.innerHTML = '';
      conflictsEl.classList.add('hidden');
    }
  }

  if (s.signedIn) {
    statusLine.textContent = 'Signed in to Orchard Cloud';
    if (userIdEl) {
      userIdEl.textContent = s.orchardUserId || s.orchardUserIdPreview || '';
      userIdEl.classList.toggle('hidden', !userIdEl.textContent);
    }
    if (signInBtn) signInBtn.disabled = true;
    if (signOutBtn) signOutBtn.disabled = false;
  } else if (s.cloudEnabled) {
    statusLine.textContent = 'Signed out — sign in to link this device';
    if (userIdEl) {
      userIdEl.textContent = s.orchardUserIdPreview ? `Local identity: ${s.orchardUserIdPreview}` : '';
      userIdEl.classList.toggle('hidden', !userIdEl.textContent);
    }
    if (signInBtn) signInBtn.disabled = false;
    if (signOutBtn) signOutBtn.disabled = true;
  } else {
    statusLine.textContent = 'Cloud disabled — enable below, then sign in';
    if (userIdEl) {
      userIdEl.textContent = s.orchardUserIdPreview ? `Local identity: ${s.orchardUserIdPreview}` : '';
      userIdEl.classList.toggle('hidden', !userIdEl.textContent);
    }
    if (signInBtn) signInBtn.disabled = false;
    if (signOutBtn) signOutBtn.disabled = true;
  }
}

$('chk-cloud-enabled')?.addEventListener('change', async (e) => {
  const chk = /** @type {HTMLInputElement} */ (e.target);
  const enabled = chk.checked;
  const res = await cloudMsg('SET_CLOUD_SETTINGS', { settings: { enabled } });
  if (res?.success) {
    toast(enabled ? 'Orchard Cloud enabled' : 'Orchard Cloud disabled');
    await refreshCloudSettings();
  } else {
    showCloudMsg(res?.error || 'Failed to update cloud setting', 'err');
    toast(res?.error || 'Failed to update cloud setting', 'err');
    chk.checked = !enabled;
  }
});

// ── Live monitoring (Track) — global toggle ──────────────────────────────────
async function refreshMonitorSetting() {
  const chk = $('chk-monitor-enabled');
  const line = $('monitor-status-line');
  const res = await cloudMsg('GET_MONITOR_CONSENT', {});
  const enabled = !!(res?.success && res.trackEnabled);
  if (chk) chk.checked = enabled;
  const excl = (res?.consent?.track?.excludeHosts) || [];
  if (line) line.textContent = enabled
    ? `On — capturing interactions on every site${excl.length ? `, except ${excl.length} excluded page(s)` : ''}.`
    : 'Off — nothing is captured.';
}
$('chk-monitor-enabled')?.addEventListener('change', async (e) => {
  const chk = /** @type {HTMLInputElement} */ (e.target);
  const enabled = chk.checked;
  const res = await cloudMsg('SET_MONITOR_CONSENT', { enabled });
  if (res?.success) {
    toast(enabled ? 'Live monitoring enabled' : 'Live monitoring disabled');
    await refreshMonitorSetting();
  } else {
    toast(res?.error || 'Failed to update monitoring', 'err');
    chk.checked = !enabled;
  }
});
refreshMonitorSetting();

// C5-viewer (v2.74.894) — session trace inspector over GET_INTERACTION_TRACE: the recorded L3 stream
// (classified, value-free), newest first. Loads on expand + Refresh; shows the ring stats so "is the
// recorder running?" is answerable at a glance. Empty after an SW restart by design (in-memory v1).
async function refreshMonitorTrace() {
  const list = $('monitor-trace-list'); const statsEl = $('monitor-trace-stats');
  if (!list) return;
  const res = await cloudMsg('GET_INTERACTION_TRACE', { limit: 50 });
  if (!res?.success) { list.innerHTML = `<em>${escHtml(res?.error || 'Trace unavailable.')}</em>`; return; }
  const entries = Array.isArray(res.entries) ? res.entries : [];
  const stats = res.stats || {};
  if (statsEl) {
    const tiers = stats.byTier && Object.keys(stats.byTier).length
      ? ` — ${Object.entries(stats.byTier).map(([t, n]) => `${t} ${n}`).join(', ')}` : '';
    statsEl.textContent = `${stats.size ?? 0}/${stats.cap ?? 0} recorded${tiers}`;
  }
  if (!entries.length) {
    list.innerHTML = '<em>No interactions recorded this session — turn monitoring on, then interact with a page that has accepted Perspectives.</em>';
    return;
  }
  list.innerHTML = entries.slice().reverse().map((e) => {
    const t = Number.isFinite(e.ts) ? new Date(e.ts).toLocaleTimeString() : '—';
    const c = e.classified || {};
    const lm = c.primary && c.primary.landmarkUid ? ` → ${c.primary.landmarkUid}` : '';
    const gid = e.groundId ? ` · ${String(e.groundId).slice(-6)}` : '';
    return `<div>#${e.seq} ${escHtml(t)} <strong>${escHtml(e.verb || '?')}</strong> <span style="opacity:.7">[${escHtml(e.tier || '—')}]</span>${escHtml(lm + gid)}</div>`;
  }).join('');
}
$('btn-monitor-trace-refresh')?.addEventListener('click', refreshMonitorTrace);
$('monitor-trace-details')?.addEventListener('toggle', (e) => { if (e.target.open) refreshMonitorTrace(); });

async function handleCloudSignIn() {
  const btn = $('btn-cloud-sign-in');
  if (btn) btn.disabled = true;
  toast('Opening sign-in…', 'ok');
  try {
    await cloudMsg('SET_CLOUD_SETTINGS', { settings: { enabled: true } });
    const enabledChk = $('chk-cloud-enabled');
    if (enabledChk) enabledChk.checked = true;
    const res = await cloudMsg('CLOUD_SIGN_IN');
    if (res?.success) {
      toast('Signed in to Orchard Cloud', 'ok');
      showCloudMsg('Signed in', 'ok');
    } else {
      const err = res?.error || 'Sign-in failed';
      toast(err, 'err');
      showCloudMsg(err, 'err');
    }
  } finally {
    await refreshCloudSettings();
  }
}

async function handleCloudSignOut() {
  const btn = $('btn-cloud-sign-out');
  if (btn) btn.disabled = true;
  toast('Signing out…', 'ok');
  try {
    const res = await cloudMsg('CLOUD_SIGN_OUT');
    if (res?.success) {
      toast('Signed out', 'ok');
      showCloudMsg('Signed out', 'ok');
    } else {
      const err = res?.error || 'Sign-out failed';
      toast(err, 'err');
      showCloudMsg(err, 'err');
    }
  } finally {
    await refreshCloudSettings();
  }
}

// Cloud auth/sync — delegated on the card so clicks always reach handlers.
document.getElementById('card-orchard-cloud')?.addEventListener('click', (e) => {
  if (e.target instanceof HTMLElement && e.target.closest('.toggle-switch')) return;
  const t = /** @type {HTMLElement|null} */ (e.target instanceof HTMLElement ? e.target : null);
  if (!t?.id) return;
  e.preventDefault();
  if (t.id === 'btn-cloud-sign-in') {
    handleCloudSignIn().catch((err) => toast(err?.message || 'Sign-in failed', 'err'));
  } else if (t.id === 'btn-cloud-sign-out') {
    handleCloudSignOut().catch((err) => toast(err?.message || 'Sign-out failed', 'err'));
  } else if (t.id === 'btn-cloud-sync-now') {
    handleCloudSyncNow().catch((err) => toast(err?.message || 'Sync failed', 'err'));
  }
});

async function handleCloudSyncNow() {
  const btn = $('btn-cloud-sync-now');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = 'Syncing…';
  toast('Syncing…', 'ok');
  try {
    const res = await cloudMsg('RUN_SYNC');
    if (res?.success || res?.ok) {
      if (res.error === 'sync_already_running') {
        toast('Sync already in progress — try again in a moment', 'ok');
        showCloudMsg('Sync already in progress', 'ok');
        return;
      }
      const seed = res.bootstrapped ? ` · seeded ${res.bootstrapped}` : '';
      const pending = res.outboxPending ? ` · ${res.outboxPending} pending` : '';
      const remote = res.remoteChangeCount ? ` · ${res.remoteChangeCount} remote` : '';
      const msg = `Sync complete · pushed ${res.pushed ?? 0}, pulled ${res.pulled ?? 0}${seed}${pending}${remote}`;
      if (res.warning) {
        toast(res.warning, 'warn');
        showCloudMsg(res.warning, 'warn');
      }
      if ((res.pushed ?? 0) === 0 && (res.pulled ?? 0) === 0 && (res.outboxPending ?? 0) === 0 && !res.warning) {
        toast(`${msg} — already up to date`, 'ok');
        showCloudMsg(`${msg} — already up to date`, 'ok');
      } else if ((res.pushed ?? 0) === 0 && (res.pulled ?? 0) === 0 && (res.outboxPending ?? 0) > 0) {
        toast(`${msg} (upload blocked — check service worker console)`, 'err');
        showCloudMsg(`${msg} — upload blocked`, 'err');
      } else {
        toast(msg, 'ok');
        showCloudMsg(msg, 'ok');
      }
      refreshGroundList().catch(() => {});
    } else {
      const err = res?.error || 'Sync failed';
      toast(err, 'err');
      showCloudMsg(err, 'err');
    }
  } catch (e) {
    const err = e?.message || 'Sync failed';
    toast(err, 'err');
    showCloudMsg(err, 'err');
  } finally {
    btn.textContent = prevLabel || 'Sync now';
    await refreshCloudSettings();
  }
}

$('btn-save-cloud-config')?.addEventListener('click', async () => {
  /** @type {Record<string, string>} */
  const patch = {};
  const apiUrl = $('input-cloud-api-url')?.value.trim();
  const cognitoDomain = $('input-cloud-cognito-domain')?.value.trim();
  const cognitoClientId = $('input-cloud-cognito-client')?.value.trim();
  if (apiUrl) patch.apiBaseUrl = apiUrl;
  if (cognitoDomain) patch.cognitoDomain = cognitoDomain;
  if (cognitoClientId) patch.cognitoClientId = cognitoClientId;
  const res = await cloudMsg('SET_CLOUD_SETTINGS', { settings: patch });
  if (res?.success) {
    showCloudMsg('Cloud config saved', 'ok');
    await refreshCloudSettings();
  } else {
    showCloudMsg(res?.error || 'Save failed', 'err');
  }
});

// v2.28.2 (Pass Q) — Chat Mode toggle removed. The multi-ground chat setting
// was a pre-relocation chat-UI feature; chat.js doesn't read it, the toggle
// was a stranded UI fragment. Deletion of the card, GET/SET wiring, and the
// applyChatMode handler are all consolidated here.

$('btn-save-api-key').addEventListener('click', async () => {
  const key = $('input-api-key').value.trim();
  if (!key) { showApiMsg('Enter an API key', 'warn'); return; }
  if (!key.startsWith('sk-ant-')) { showApiMsg('Key should start with sk-ant-…', 'warn'); return; }
  const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'SET_API_KEY', payload: { key } }, r));
  if (res?.success) {
    showApiMsg('API key saved', 'ok');
    $('input-api-key').value = '';
    await refreshSettings();
  } else {
    showApiMsg(`Failed: ${res?.error}`, 'err');
  }
});

$('btn-archive-run')?.addEventListener('click', async () => {
  const el = $('diagnostics-status');
  const show = (text, type) => { if (el) { el.textContent = text; el.className = `msg ${type}`; el.classList.remove('hidden'); setTimeout(() => el.classList.add('hidden'), 5000); } };
  const btn = $('btn-archive-run');
  btn.disabled = true;
  show('Uploading…', 'ok');
  const res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'ARCHIVE_EXECUTION' }, r));
  btn.disabled = false;
  if (res?.success) show(`Uploaded run ${res.executionId} for support.`, 'ok');
  else show(`Failed: ${res?.error || 'no recent run / not signed in'}`, 'err');
});

$('chk-close-tab').addEventListener('change', async (e) => {
  await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'SET_SETTING', payload: { key: 'close_tab_after_run', value: e.target.checked } }, r)
  );
  toast(e.target.checked ? 'Tab will close after test run' : 'Tab will stay open after test run');
});

// v2.74.9 — Verbose fragment description toggle. Persists via SET_SETTING,
// updates module-cached preference, and re-renders the Ground list so
// the new format applies immediately without a manual refresh.
$('chk-verbose-fragment-desc')?.addEventListener('change', async (e) => {
  const checked = e.target.checked;
  _verboseFragmentDesc = checked;
  await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'SET_SETTING', payload: { key: 'verbose_fragment_desc', value: checked } }, r)
  );
  toast(checked ? 'Verbose descriptions on — fragments show multi-line breakdowns' : 'Verbose descriptions off');
  // Re-render so the new format applies right away.
  refreshGroundList().catch(() => {});
});

// v2.74.12 — Fragment length cap. Numeric input + unlimited toggle.
// The fragment-author mode reads these settings on mount; changes here
// only take effect for the NEXT fragment-authoring session, not any
// in-progress one.
$('input-fragment-cap')?.addEventListener('change', async (e) => {
  const raw = parseInt(e.target.value, 10);
  if (!Number.isFinite(raw) || raw < 1) {
    e.target.value = '7';
    toast('Fragment cap must be at least 1', 'err');
    return;
  }
  if (raw > 100) {
    e.target.value = '100';
    toast('Fragment cap clamped to 100 — for higher, use Unlimited', 'warn');
  }
  const capValue = Math.min(Math.max(raw, 1), 100);
  await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'SET_SETTING', payload: { key: 'fragment_cap', value: capValue } }, r)
  );
  toast(`Fragment cap set to ${capValue}`);
});
$('chk-fragment-cap-unlimited')?.addEventListener('change', async (e) => {
  const checked = e.target.checked;
  await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'SET_SETTING', payload: { key: 'fragment_cap_unlimited', value: checked } }, r)
  );
  // Dim the numeric input when unlimited is on.
  const capInput = $('input-fragment-cap');
  if (capInput) capInput.disabled = checked;
  toast(checked
    ? 'Fragment cap removed — long fragments allowed (warned past soft threshold)'
    : 'Fragment cap re-enabled');
});

// v2.74.18 (Ship D) — Observation extract cap. Same shape as the
// fragment-cap handlers. Setting keys: observation_extract_cap and
// observation_extract_cap_unlimited. The sidepanel observation-author
// mode reads these at mount; changes here apply to the NEXT authoring
// session, not any in-progress one.
$('input-observation-extract-cap')?.addEventListener('change', async (e) => {
  const raw = parseInt(e.target.value, 10);
  if (!Number.isFinite(raw) || raw < 1) {
    e.target.value = '7';
    toast('Extract cap must be at least 1', 'err');
    return;
  }
  if (raw > 100) {
    e.target.value = '100';
    toast('Extract cap clamped to 100 — for higher, use Unlimited', 'warn');
  }
  const capValue = Math.min(Math.max(raw, 1), 100);
  await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'SET_SETTING', payload: { key: 'observation_extract_cap', value: capValue } }, r)
  );
  toast(`Observation extract cap set to ${capValue}`);
});
$('chk-observation-extract-cap-unlimited')?.addEventListener('change', async (e) => {
  const checked = e.target.checked;
  await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'SET_SETTING', payload: { key: 'observation_extract_cap_unlimited', value: checked } }, r)
  );
  const capInput = $('input-observation-extract-cap');
  if (capInput) capInput.disabled = checked;
  toast(checked
    ? 'Observation extract cap removed — long Observations allowed (warned past soft threshold)'
    : 'Observation extract cap re-enabled');
});

function showApiMsg(text, type) {
  const el = $('api-key-status');
  el.textContent = text;
  el.className   = `msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 3000);
}

// ─── Sharing / publications (STORAGE_SCHEMA §9 / AWS_INTEGRATION §7.4) ───────────
// Studio surface for the publication engine: publish a primitive as a signed package, browse +
// import from the registry, and check/apply lineage updates on imports. Registry calls need cloud
// sign-in; same-device publish→import also works offline via the local outgoing store.
// NOTE (Appendix A terminology): publish `kind` here is the storage-layer kind — `ground`,
// `workflow` (global Tier-2), `strategy` (per-Ground Tier-3) — matching collectWorkspacePrimitives.

function _shareSend(type, payload) {
  return new Promise((res) => chrome.runtime.sendMessage({ type, payload }, res));
}

function _shareMsg(id, text, type) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function _refreshPublishItems() {
  const sel = $('pub-item');
  if (!sel) return;
  const type = $('pub-type').value;
  let items = [];
  try {
    if (type === 'ground') items = (await StorageManager.getAllGrounds()).map((g) => ({ id: g.id, label: g.name || g.id }));
    else if (type === 'strategy') items = (await StorageManager.getAllStrategies()).map((s) => ({ id: s.id, label: s.name || s.id }));
    else if (type === 'workflow') items = (await StorageManager.listWorkflows()).map((w) => ({ id: w.id, label: w.name || w.id }));
  } catch { /* list method absent in some builds */ }
  sel.innerHTML = items.length
    ? items.map((it) => `<option value="${escAttr(it.id)}">${escHtml(it.label)}</option>`).join('')
    : '<option value="">(none available)</option>';
}

async function renderOutgoingPublications() {
  const box = $('outgoing-list');
  if (!box) return;
  const res = await _shareSend('LIST_OUTGOING_PUBLICATIONS');
  const pubs = res?.publications || [];
  box.innerHTML = pubs.length
    ? pubs.map((p) => `
        <div class="prompt-item">
          <div><b>${escHtml(p.title || p.publicationId)}</b>
            <span class="settings-note">v${escHtml(p.version || '1.0.0')} · ${escHtml(p.visibility || 'unlisted')} · ${p.uploaded ? 'uploaded' : 'local-only'}</span></div>
          <div class="settings-note" style="font-family:monospace;font-size:11px">${escHtml(p.publicationId)}</div>
        </div>`).join('')
    : '<p class="settings-note">None yet.</p>';
}

async function renderIncomingPublications() {
  const box = $('incoming-list');
  if (!box) return;
  const res = await _shareSend('LIST_INCOMING_PUBLICATIONS');
  const pubs = res?.publications || [];
  box.innerHTML = pubs.length
    ? pubs.map((p) => `
        <div class="prompt-item" data-pub="${escAttr(p.publicationId)}">
          <div><b>${escHtml(p.title || p.publicationId)}</b> <span class="settings-note">v${escHtml(p.version || '1.0.0')}</span></div>
          <div class="settings-note" style="font-family:monospace;font-size:11px">${escHtml(p.publicationId)}</div>
          <div style="margin-top:4px">
            <button class="btn-secondary small" data-act="check-updates" data-pub="${escAttr(p.publicationId)}">Check updates</button>
            <span class="share-update-note settings-note"></span>
          </div>
        </div>`).join('')
    : '<p class="settings-note">None yet.</p>';
}

async function renderRegistryResults(query) {
  const box = $('registry-list');
  if (!box) return;
  box.innerHTML = '<p class="settings-note">Searching…</p>';
  const res = await _shareSend('SEARCH_PUBLICATIONS', { query: query || '' });
  if (!res?.success) {
    box.innerHTML = `<p class="settings-note">Registry unavailable (${escHtml(res?.error || 'sign in to search')}).</p>`;
    return;
  }
  const pubs = res.publications || [];
  if (!pubs.length) { box.innerHTML = '<p class="settings-note">No results.</p>'; return; }
  const grounds = await StorageManager.getAllGrounds();
  const groundOpts = '<option value="">— new/auto (ground packages)</option>'
    + grounds.map((g) => `<option value="${escAttr(g.id)}">${escHtml(g.name || g.id)}</option>`).join('');
  box.innerHTML = pubs.map((p) => `
      <div class="prompt-item">
        <div><b>${escHtml(p.title || p.publicationId)}</b> <span class="settings-note">v${escHtml(p.version || '1.0.0')}</span></div>
        ${p.description ? `<div class="settings-note">${escHtml(p.description)}</div>` : ''}
        <div style="margin-top:4px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">
          <select class="reg-target" data-pub="${escAttr(p.publicationId)}" style="max-width:220px">${groundOpts}</select>
          <button class="btn-secondary small" data-act="import" data-pub="${escAttr(p.publicationId)}">Import</button>
        </div>
      </div>`).join('');
}

// ── Team workspaces (DD-05 C) ───────────────────────────────────────────────
async function renderWorkspaceDetail(wsId, container) {
  if (!container) return;
  const res = await _shareSend('GET_WORKSPACE', { workspaceId: wsId });
  if (!res?.success) { container.innerHTML = `<span class="settings-note">load failed: ${escHtml(res?.error || '?')}</span>`; return; }
  const ws = res.workspace || {};
  const canAdmin = ws.role === 'admin' || ws.role === 'owner';
  const members = (ws.members || []).map((m) => `
        <div style="display:flex;gap:6px;align-items:center;justify-content:space-between">
          <span class="settings-note" style="font-family:monospace;font-size:11px">${escHtml(m.orchardUserId)} · ${escHtml(m.role)}</span>
          ${canAdmin && m.role !== 'owner'
            ? `<button class="btn-secondary small" data-act="ws-remove-member" data-ws="${escAttr(wsId)}" data-member="${escAttr(m.orchardUserId)}">Remove</button>`
            : ''}
        </div>`).join('');

  // Team grounds synced into this workspace locally (groundId→wsId registry).
  const [mapRes, grounds] = await Promise.all([
    _shareSend('GET_GROUND_WORKSPACES'),
    StorageManager.getAllGrounds(),
  ]);
  const map = mapRes?.map || {};
  const wsGrounds = (grounds || []).filter((g) => map[g.id] === wsId);
  const groundsHtml = wsGrounds.length
    ? wsGrounds.map((g) => `<div class="settings-note" style="font-family:monospace;font-size:11px">${escHtml(g.name || g.id)}</div>`).join('')
    : '<div class="settings-note">No team grounds synced locally yet.</div>';

  container.innerHTML = `
      <div class="settings-note" style="margin-top:4px">Members</div>
      ${members}
      ${canAdmin ? `
        <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap">
          <input type="text" class="ws-invite-id" placeholder="orchardUserId (pk_…)" style="flex:1 1 200px" autocomplete="off" />
          <select class="ws-invite-role"><option value="editor">editor</option><option value="viewer">viewer</option><option value="admin">admin</option></select>
          <button class="btn-secondary small" data-act="ws-invite" data-ws="${escAttr(wsId)}">Invite</button>
        </div>` : ''}
      <div class="settings-note" style="margin-top:8px">Team grounds</div>
      ${groundsHtml}`;
}

async function renderWorkspaces() {
  const box = $('workspaces-list');
  if (!box) return;
  const st = await _shareSend('GET_CLOUD_STATUS');
  const myId = st?.status?.orchardUserId;
  const idEl = $('my-orchard-id');
  if (idEl) idEl.textContent = myId || '(sign in to the cloud)';
  if (!myId) { box.innerHTML = '<p class="settings-note">Sign in to the cloud to use team workspaces.</p>'; return; }

  const res = await _shareSend('LIST_WORKSPACES');
  if (!res?.success) { box.innerHTML = `<p class="settings-note">Unavailable (${escHtml(res?.error || '?')}).</p>`; return; }
  const list = res.workspaces || [];
  box.innerHTML = list.length
    ? list.map((w) => `
        <div class="prompt-item" data-ws="${escAttr(w.workspaceId)}">
          <div><b>${escHtml(w.name || w.workspaceId)}</b> <span class="settings-note">${escHtml(w.role)}</span></div>
          <div class="settings-note" style="font-family:monospace;font-size:11px">${escHtml(w.workspaceId)}</div>
          <div style="margin-top:4px"><button class="btn-secondary small" data-act="ws-manage" data-ws="${escAttr(w.workspaceId)}">Manage</button></div>
          <div class="ws-detail" style="margin-top:6px"></div>
        </div>`).join('')
    : '<p class="settings-note">None yet.</p>';
}

async function refreshSharing() {
  await _refreshPublishItems();
  await renderOutgoingPublications();
  await renderIncomingPublications();
  await renderWorkspaces();
}

$('btn-create-workspace')?.addEventListener('click', async () => {
  const name = $('ws-new-name').value.trim();
  if (!name) { _shareMsg('workspace-status', 'Enter a workspace name.', 'warn'); return; }
  const res = await _shareSend('CREATE_WORKSPACE', { name });
  if (res?.success) {
    _shareMsg('workspace-status', `Created ${res.workspace?.workspaceId || ''}.`, 'ok');
    $('ws-new-name').value = '';
    renderWorkspaces();
  } else {
    _shareMsg('workspace-status', `Failed: ${res?.error || 'unknown error'}`, 'err');
  }
});

$('workspaces-list')?.addEventListener('click', async (e) => {
  const manageBtn = e.target.closest('[data-act="ws-manage"]');
  if (manageBtn) {
    const detail = manageBtn.closest('.prompt-item')?.querySelector('.ws-detail');
    if (!detail) return;
    if (detail.innerHTML.trim()) { detail.innerHTML = ''; return; }   // toggle closed
    detail.innerHTML = '<span class="settings-note">loading…</span>';
    await renderWorkspaceDetail(manageBtn.dataset.ws, detail);
    return;
  }
  const inviteBtn = e.target.closest('[data-act="ws-invite"]');
  if (inviteBtn) {
    const wsId = inviteBtn.dataset.ws;
    const detail = inviteBtn.closest('.ws-detail');
    const memberId = detail?.querySelector('.ws-invite-id')?.value.trim();
    const role = detail?.querySelector('.ws-invite-role')?.value || 'editor';
    if (!memberId) { toast('Enter an orchardUserId to invite.', 'err'); return; }
    const res = await _shareSend('ADD_WORKSPACE_MEMBER', { workspaceId: wsId, orchardUserId: memberId, role });
    if (res?.success) { toast('Member added.'); await renderWorkspaceDetail(wsId, detail); }
    else { toast(`Invite failed: ${res?.error || 'unknown error'}`, 'err'); }
    return;
  }
  const removeBtn = e.target.closest('[data-act="ws-remove-member"]');
  if (removeBtn) {
    const wsId = removeBtn.dataset.ws;
    const detail = removeBtn.closest('.ws-detail');
    const res = await _shareSend('REMOVE_WORKSPACE_MEMBER', { workspaceId: wsId, orchardUserId: removeBtn.dataset.member });
    if (res?.success) { toast('Member removed.'); await renderWorkspaceDetail(wsId, detail); }
    else { toast(`Remove failed: ${res?.error || 'unknown error'}`, 'err'); }
  }
});

$('pub-type')?.addEventListener('change', _refreshPublishItems);

$('btn-publish')?.addEventListener('click', async () => {
  const kind = $('pub-type').value;
  const id = $('pub-item').value;
  if (!id) { _shareMsg('publish-status', 'Select an item to publish.', 'warn'); return; }
  const details = {
    title: $('pub-title').value.trim() || undefined,
    description: $('pub-description').value.trim() || undefined,
    version: $('pub-version').value.trim() || '1.0.0',
    visibility: $('pub-visibility').value,
    tags: $('pub-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  const btn = $('btn-publish');
  btn.disabled = true;
  _shareMsg('publish-status', 'Publishing…', 'ok');
  const res = await _shareSend('PUBLISH_PRIMITIVE', { kind, id, details });
  btn.disabled = false;
  if (res?.success) {
    const pubId = res.publication?.publicationId || '';
    _shareMsg('publish-status', `Published ${pubId} (${res.publication?.uploaded ? 'uploaded' : 'local-only'}).`, 'ok');
    renderOutgoingPublications();
  } else {
    _shareMsg('publish-status', `Failed: ${res?.error || 'unknown error'}`, 'err');
  }
});

$('btn-registry-search')?.addEventListener('click', () => renderRegistryResults($('registry-search').value.trim()));
$('registry-search')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') renderRegistryResults($('registry-search').value.trim());
});

$('registry-list')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act="import"]');
  if (!btn) return;
  const publicationId = btn.dataset.pub;
  const targetSel = qs(`.reg-target[data-pub="${CSS.escape(publicationId)}"]`);
  const targetGroundId = targetSel?.value || undefined;
  btn.disabled = true; btn.textContent = 'Importing…';
  const res = await _shareSend('IMPORT_PUBLICATION', { publicationId, targetGroundId });
  btn.disabled = false; btn.textContent = 'Import';
  if (res?.success) { toast(`Imported ${res.installedIds?.length || 0} primitive(s).`); renderIncomingPublications(); }
  else { toast(`Import failed: ${res?.error || 'unknown error'}`, 'err'); }
});

$('incoming-list')?.addEventListener('click', async (e) => {
  const checkBtn = e.target.closest('[data-act="check-updates"]');
  if (checkBtn) {
    const publicationId = checkBtn.dataset.pub;
    const note = checkBtn.parentElement.querySelector('.share-update-note');
    checkBtn.disabled = true;
    const res = await _shareSend('CHECK_PUBLICATION_UPDATES', { publicationId });
    checkBtn.disabled = false;
    if (!res?.success) { if (note) note.textContent = ` check failed: ${res?.error || '?'}`; return; }
    const updates = res.updates || [];
    if (!updates.length) { if (note) note.textContent = ' up to date'; return; }
    const latest = updates[updates.length - 1];
    if (note) {
      note.innerHTML = ` ${updates.length} update(s) — `
        + `<button class="btn-primary small" data-act="apply-update" data-from="${escAttr(publicationId)}" data-to="${escAttr(latest.publicationId)}">Apply v${escHtml(latest.version || '?')}</button>`;
    }
    return;
  }
  const applyBtn = e.target.closest('[data-act="apply-update"]');
  if (applyBtn) {
    applyBtn.disabled = true; applyBtn.textContent = 'Applying…';
    const res = await _shareSend('APPLY_PUBLICATION_UPDATE', {
      fromPublicationId: applyBtn.dataset.from,
      toPublicationId: applyBtn.dataset.to,
    });
    if (res?.success) { toast('Update applied.'); renderIncomingPublications(); }
    else { toast(`Update failed: ${res?.error || 'unknown error'}`, 'err'); applyBtn.disabled = false; applyBtn.textContent = 'Apply'; }
  }
});


// ─── Runtime messages ─────────────────────────────────────────────────────────

// v2.74.22 — Fragment walk dispatcher gone with the AI-walked path.
// Studio's role in fragment authoring is now: launch the sidepanel mode
// (+ Fragment / re-walk handlers above) and refresh its fragment list
// when STORAGE_CHANGED fires after a save in the mode.
chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
  if (message.type === 'LOG_ENTRY')        appendLiveLogEntry(message.payload);
  if (message.type === 'PROFILING_STATUS') handleProfilingStatus(message.payload);
});

// ─── Logs tab ─────────────────────────────────────────────────────────────────

/**
 * @type {'ALL'|'DEBUG'|'INFO'|'WARN'|'ERROR'}
 */
let activeLogFilter = 'ALL';

/** @type {import('./Core/Logger.js').LogEntry[]} All entries loaded or received live. */
let allLogEntries   = [];

const LOG_LEVEL_ORDER = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

/**
 * Loads persisted log entries from the service worker and renders them.
 * Called when the Logs tab is activated.
 * @returns {Promise<void>}
 */
async function refreshLogs() {
  const res = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_LOGS' }, r)
  );
  allLogEntries = res?.entries ?? [];
  renderLogList();
}

/**
 * Renders allLogEntries filtered by activeLogFilter into #log-list.
 * Newest entries appear at the bottom (chronological order).
 */
function renderLogList() {
  const list = $('log-list');

  const filtered = activeLogFilter === 'ALL'
    ? allLogEntries
    : allLogEntries.filter(e => e.level === activeLogFilter);

  if (filtered.length === 0) {
    list.innerHTML = `<p class="empty-state">${activeLogFilter === 'ALL' ? 'No log entries yet.' : `No ${activeLogFilter} entries.`}</p>`;
    return;
  }

  list.innerHTML = '';
  filtered.forEach(entry => list.appendChild(buildLogRow(entry)));

  if ($('chk-autoscroll')?.checked) {
    list.scrollTop = list.scrollHeight;
  }
}

/**
 * Builds a single log row element.
 * @param {import('./Core/Logger.js').LogEntry} entry
 * @returns {HTMLElement}
 */
function buildLogRow(entry) {
  const row = document.createElement('div');
  row.className = `log-row log-${entry.level.toLowerCase()}`;

  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    : '—';

  let dataHtml = '';
  if (entry.data !== null && entry.data !== undefined) {
    let dataStr;
    try {
      dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
    } catch {
      dataStr = String(entry.data);
    }
    // Show stack traces expanded, everything else collapsed
    const isStack = typeof entry.data === 'object' && entry.data?.stack;
    dataHtml = `<details class="log-data" ${isStack ? 'open' : ''}>
      <summary>data</summary>
      <pre class="log-data-pre">${escHtml(dataStr)}</pre>
    </details>`;
  }

  row.innerHTML = `
    <div class="log-row-main">
      <span class="log-time">${time}</span>
      <span class="log-level-badge log-lvl-${entry.level.toLowerCase()}">${entry.level}</span>
      <span class="log-source">${escHtml(entry.source ?? '')}</span>
      <span class="log-msg">${escHtml(entry.message ?? '')}</span>
    </div>
    ${dataHtml}`;

  return row;
}

/**
 * Appends a single live entry to the log list if it passes the current filter.
 * Called from the chrome.runtime.onMessage listener without a full re-render.
 * @param {import('./Core/Logger.js').LogEntry} entry
 */
function appendLiveLogEntry(entry) {
  allLogEntries.push(entry);

  const passes = activeLogFilter === 'ALL' || entry.level === activeLogFilter;
  if (!passes) return;

  const list  = $('log-list');
  const empty = list.querySelector('.empty-state');
  if (empty) empty.remove();

  list.appendChild(buildLogRow(entry));

  if ($('chk-autoscroll')?.checked) {
    list.scrollTop = list.scrollHeight;
  }

  // Update log tab badge if not active
  const logTab = qs('[data-tab="logs"]');
  if (logTab && !logTab.classList.contains('active') && (entry.level === 'ERROR' || entry.level === 'WARN')) {
    logTab.dataset.badge = (parseInt(logTab.dataset.badge || '0', 10) + 1).toString();
    logTab.setAttribute('data-has-alert', '1');
  }
}

// ── Filter buttons ────────────────────────────────────────────────────────────

qsa('.log-filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    qsa('.log-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeLogFilter = btn.dataset.level;
    renderLogList();
  });
});

// ── Copy latest event logs ────────────────────────────────────────────────────

/**
 * Finds the start index of the most recent event in allLogEntries.
 * An event begins at the last log entry whose message contains one of the
 * known event-start markers: START_WALK, RUN_TEST, or Job enqueued.
 *
 * @returns {number} Index into allLogEntries, or 0 if no marker found.
 */
function findLatestEventStart() {
  const EVENT_MARKERS = ['START_WALK', 'RUN_TEST', 'Job enqueued'];
  for (let i = allLogEntries.length - 1; i >= 0; i--) {
    const msg = allLogEntries[i].message ?? '';
    if (EVENT_MARKERS.some(m => msg.includes(m))) return i;
  }
  return 0;
}

/**
 * Formats a single log entry as a plain-text line.
 * @param {Object} entry
 * @returns {string}
 */
function formatLogEntryAsText(entry) {
  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString('en-US', {
        hour12: false, hour: '2-digit', minute: '2-digit',
        second: '2-digit', fractionalSecondDigits: 3,
      })
    : '—';
  // v2.74.1014 — coerce level defensively: a single entry with a missing/non-string
  // level would otherwise throw `padEnd of undefined` and abort the ENTIRE download
  // (the FULL path maps every entry; Decisions filtered the bad one out first, so the
  // failure looked FULL-only and produced no file + no error). Never throw here.
  let line = `${time} ${String(entry.level ?? '?').padEnd(5)} ${String(entry.source ?? '').padEnd(20)} ${entry.message ?? ''}`;
  if (entry.data !== null && entry.data !== undefined) {
    try {
      const dataStr = typeof entry.data === 'string'
        ? entry.data
        : JSON.stringify(entry.data, null, 2);
      line += `\n  ${dataStr.replace(/\n/g, '\n  ')}`;
    } catch { /* skip */ }
  }
  return line;
}

$('btn-copy-logs').addEventListener('click', async () => {
  if (allLogEntries.length === 0) { toast('No logs to copy', 'warn'); return; }

  const startIdx = findLatestEventStart();
  const eventEntries = allLogEntries.slice(startIdx);
  const text = eventEntries.map(formatLogEntryAsText).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${eventEntries.length} log lines`);
  } catch {
    // Fallback for contexts where clipboard API is unavailable
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast(`Copied ${eventEntries.length} log lines`);
  }
});

// ── Download logs (since the last extension reload) ───────────────────────────
// v2.74.797 — download the WHOLE current session as a .txt, so a trace can be handed off without copy-pasting.
// v2.74.799 — the primary boundary is now the persisted session-start stamp (see the handler below); this marker
// scan is the FALLBACK for when no stamp exists. It finds the LAST 'service worker starting' marker — note that
// fires on idle-wake too, so on its own it can clip pre-idle-restart errors; the stamp is preferred precisely
// because it doesn't. If no marker is in the buffer either, download everything. The Logger scrubs PII before
// persisting (and never-evicts WARN+ERROR), so the file is safe to share and won't silently drop failures.
function findLastReloadStart() {
  for (let i = allLogEntries.length - 1; i >= 0; i--) {
    if ((allLogEntries[i].message ?? '').includes('service worker starting')) return i;
  }
  return 0;   // no reload marker in the buffer → download everything we have
}

// v2.74.812 — a "decision/outcome" line: the SIGNAL a gl review wants (routing / match / bind / read / the run
// frame / param bindings) plus every problem (WARN/ERROR). Excludes per-action mechanics + DEBUG, so the Decisions
// download reads as the story: ▶ RUN … → comprehend → resolve → bind → bindings → read → ✓ RUN.
// v2.74.818 — observability pass: + GROUNDS (inventory), ROUTE (chat path + cues), _bind (bind pool/miss reason),
// HANDOFF (cross-Ground value flow), postcond (postcondition relax/keep), DETECT/MERGE_GROUNDS + mergeGround +
// Ground saved/deleted (dedup + storage mutations).
// v2.74.882 — surface the signals a gl kept being BLIND to (#165): the LLM front-door router (ROUTE_ASK), the
// cross-Ground param bind (bindClauseParams — e.g. CATEGORY="Videos", the .881 fix), Explore freshness/trust
// (locale-fresh-skip / locale-trust / EXPLORE_PAGE_STRUCTURE done), and monitor capture start.
// v2.74.906 — + the rich-intent arc (INTENT_MENU/RICH_INTENTS), the teach promotion (ACCEPT_SG_TRIAL —
// incl. HS-1's "+ N observation step(s)"), the C5 monitoring flush, and the EX/G1 leftovers (#165) — every
// decision marker shipped since .882 that a decisions gl was structurally blind to.
// v2.74.1044 — + DBR Phase-2 converge markers (SYNC ▸ / MERGE ▸ / ABANDON ▸) so a `sync`/`merge`/abandon shows
// in a decisions gl (INVARIANT #1, the #165 lesson — a marker absent here is invisible to a decisions download).
const _DECISION_RE = /(▶ RUN |[✓✗] RUN |COMPREHEND_CROSS_GROUND ▸|T3X resolve ▸|T3X bind ▸|_bind ▸|GROUNDS ▸|ROUTE ▸|HANDOFF ▸|postcond ▸|ORCH_MATCH ▸|ORCH_MATCH_GLOBAL ▸|DETECT_DUPLICATE_GROUNDS ▸|MERGE_GROUNDS ▸|mergeGround |Ground saved:|Ground deleted:|→ (?:auto|propose|miss)\/|RUN_OBSERVATION|RUN_BEST_OBSERVATION|ORCH_RECORD_ALIAS|ORCH_ADMIN ▸|REPLAY_SG_CAPABILITY —|— bindings:|CLICK caused navigation|WALK ▸|LOOP ▸|ORCH_PLAN ▸|OPEN_URL_NEW_TAB —|REVERIFY_SG_CAPABILITY —|ROUTE_ASK "|bindClauseParams →|locale-fresh-skip|locale-trust:|EXPLORE_PAGE_STRUCTURE done|RUN_SG_TRIAL|INTERACTION_MONITOR_START|INTENT_MENU ▸|RICH_INTENTS ▸|ACCEPT_SG_TRIAL|INTERACTION_OUTCOMES ▸|proposeRichIntents —|ensureGroundForUrl|EXPLORE ▸|STOP ▸|FOCUS ▸|CLARIFY ▸|CLOSE_TABS ▸|DEVBR ▸|LT ▸|CONCERN ▸|SYNC ▸|MERGE ▸|ABANDON ▸)/;
function _isDecisionLine(entry) {
  if (!entry) return false;
  if (entry.level === 'WARN' || entry.level === 'ERROR') return true;
  return _DECISION_RE.test(String(entry.message ?? ''));
}

// Shared by the Download (full) + Decisions (signal-only) buttons. Slices "since the last reload" by the persisted
// session-start stamp (set on a real reload/startup, NOT an idle SW wake), so an error before a mid-session SW
// idle-restart is still included. refreshLogs → getPersistedLogs() merges the never-evicted WARN+ERROR sidecar.
// Falls back to the SW-start marker (then to everything) if the session was never stamped. PII is scrubbed at persist.
async function _downloadLogs(decisionsOnly = false) {
  // v2.74.1014 — whole body wrapped: a throw anywhere here (formatter, blob, storage)
  // previously produced NO file AND NO message — a silent failure indistinguishable
  // from "nothing happened" (the symptom behind two days of zero FULL traces). Now the
  // failure is surfaced via toast AND console.error (which the ErrorCapture patch routes
  // to the Logger, so it persists into the NEXT grab instead of vanishing).
  try {
    await refreshLogs();
    if (allLogEntries.length === 0) { toast('No logs to download', 'warn'); return; }
    let entries;
    const sess = await chrome.storage.local.get('logger:sessionStart');   // Logger.SESSION_START_KEY
    const sessionStart = sess?.['logger:sessionStart'] ?? null;
    if (sessionStart) {
      entries = allLogEntries.filter(e => (e.timestamp ?? '') >= sessionStart);
      if (entries.length === 0) entries = allLogEntries.slice(findLastReloadStart());
    } else {
      entries = allLogEntries.slice(findLastReloadStart());
    }
    if (decisionsOnly) entries = entries.filter(_isDecisionLine);
    if (entries.length === 0) { toast(decisionsOnly ? 'No decision lines this session' : 'No logs to download', 'warn'); return; }
    const text = entries.map(formatLogEntryAsText).join('\n');

    // Filename stamped with local date-time: orchard-logs[-decisions]-YYYYMMDD-HHMMSS.txt
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `orchard-logs${decisionsOnly ? '-decisions' : ''}-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast(`Downloaded ${entries.length} ${decisionsOnly ? 'decision' : 'log'} line(s) (since last reload)`);
  } catch (err) {
    console.error(`[studio] ${decisionsOnly ? 'decisions' : 'full'} log download failed:`, err);
    toast(`Download failed: ${err?.message ?? err}`, 'warn');
  }
}
// v2.74.1017 — chat export rides along with EVERY log grab (no dedicated button): one click writes the
// log file AND `orchard-chats-*.txt` (when there's new non-dev chat activity), so `gch` works off the same
// gesture as `gl`/`gc`. Both are independent + self-toasting (own try/catch), fired in the same user
// gesture so Chrome treats them as one multi-file download.
$('btn-download-logs')?.addEventListener('click', () => { _downloadLogs(false); _downloadChats(); });
$('btn-download-decisions')?.addEventListener('click', () => { _downloadLogs(true); _downloadChats(); });

// ── Grab Chat (v2.74.1015; trigger moved v2.74.1017) ────────────────────────
// Export the human↔AI conversation history accumulated SINCE the last grab, as a
// readable transcript (`orchard-chats-<ts>.txt`) — the counterpart to gl/gc for the
// CHAT stream rather than the LOG stream. Fired automatically alongside EVERY log
// grab (Download + Decisions) — NOT a dedicated button — so a `gch` read works off
// the same gesture as `gl`/`gc` (v2.74.1017, per user: "do the same thing"). The
// boundary is a persisted timestamp,
// advanced to the grab moment on every successful export (first grab → everything).
// "Non-dev chats only": a conversation touched by the dev-bridge (any message with
// `devBridge: true`, the `dev:` Claude Code replies — Services/Chat/devBridge.js) is
// excluded WHOLE. The boundary still advances past skipped dev chats, so they don't
// resurface each grab. Mirrors _downloadLogs's full-body try/catch: a throw anywhere
// must surface (toast + console.error → Logger), never a silent no-file no-error.
const LAST_CHAT_EXPORT_KEY = 'settings:lastChatExport';   // chrome.storage.local, ms epoch

function formatConversationAsText(conv) {
  const when = (ts) => ts
    ? new Date(ts).toLocaleString('en-US', { hour12: false })
    : '—';
  const lines = [];
  lines.push(`# ${conv.title ?? 'Untitled'}`);
  lines.push(`created ${when(conv.createdAt)} · updated ${when(conv.updatedAt)} · ${(conv.messages ?? []).length} message(s)`);
  lines.push('');
  for (const m of (conv.messages ?? [])) {
    lines.push(`## ${String(m.role ?? '?')} — ${when(m.ts)}`);
    lines.push(String(m.body ?? ''));
    if (m.outcome && m.outcome.label) lines.push(`_outcome: ${m.outcome.label}${m.outcome.detail ? ' — ' + m.outcome.detail : ''}_`);
    lines.push('');
  }
  return lines.join('\n');
}

async function _downloadChats() {
  try {
    const now = Date.now();
    const summaries = await ConversationStore.list();   // newest-first metadata, no bodies
    if (!summaries.length) { toast('No conversations to export', 'warn'); return; }
    const sess = await chrome.storage.local.get(LAST_CHAT_EXPORT_KEY);
    const since = sess?.[LAST_CHAT_EXPORT_KEY] ?? 0;
    // Conversations with activity since the last grab. Load bodies oldest→newest for a
    // chronological transcript; drop any conversation carrying a dev-bridge message.
    const candidates = summaries
      .filter(s => (s.updatedAt ?? 0) > since)
      .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    if (!candidates.length) { toast('No new chat activity since last grab', 'warn'); return; }
    const convs = [];
    let devSkipped = 0;
    for (const s of candidates) {
      const conv = await ConversationStore.load(s.id);
      if (!conv) continue;
      if ((conv.messages ?? []).some(m => m.devBridge)) { devSkipped++; continue; }
      convs.push(conv);
    }
    // Advance the boundary regardless of dev-filtering, so skipped dev chats don't
    // reappear on the next grab. Only persist AFTER a successful blob/click below.
    if (!convs.length) {
      await chrome.storage.local.set({ [LAST_CHAT_EXPORT_KEY]: now });
      toast(devSkipped ? `Only dev-bridge chat(s) since last grab — nothing to export` : 'No chats to export', 'warn');
      return;
    }
    const text = convs.map(formatConversationAsText).join(`\n${'─'.repeat(60)}\n\n`);

    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;

    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `orchard-chats-${stamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    await chrome.storage.local.set({ [LAST_CHAT_EXPORT_KEY]: now });
    toast(`Exported ${convs.length} chat(s) since last grab${devSkipped ? ` (${devSkipped} dev chat(s) skipped)` : ''}`);
  } catch (err) {
    console.error('[studio] chat export failed:', err);
    toast(`Chat export failed: ${err?.message ?? err}`, 'warn');
  }
}
// v2.74.1017 — no dedicated chat button: _downloadChats() now rides along with the log Download/Decisions
// grabs (wired above). Kept callable on its own in case a chat-only trigger is added later.

// ── Clear logs ────────────────────────────────────────────────────────────────

$('btn-clear-logs').addEventListener('click', async () => {
  await new Promise(r => chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' }, r));
  allLogEntries = [];
  renderLogList();
  toast('Logs cleared');
});

// ── Auto-scroll toggle preserves scroll position when disabled ────────────────

$('chk-autoscroll').addEventListener('change', (e) => {
  if (e.target.checked) {
    $('log-list').scrollTop = $('log-list').scrollHeight;
  }
});

// ─── Walk progress panel ──────────────────────────────────────────────────────

/** @type {Map<string, HTMLElement>} groundId → walk panel element */
const walkPanels = new Map();

/**
 * Creates or resets the live walk panel for a ground card.
 * Inserts it below the ground card header, above the questions panel.
 * @param {string} groundId
 * @param {string} aiName
 */


// ─── Profiling status indicator ───────────────────────────────────────────────

/**
 * Handles PROFILING_STATUS broadcast — updates the ground card with a
 * live "Chatting N/5…" or "Profile ready" badge.
 * @param {{ groundId: string, status: string, progress: number, total: number }} payload
 */
function handleProfilingStatus({ groundId, status, progress, total }) {
  const card = document.querySelector(`.ground-card[data-id="${groundId}"]`);
  if (!card) return;

  // v2.28.4 — Previously looked for .ground-card-right (old template class
  // name that disappeared in Pass R). Now uses .ground-group-actions which
  // is the current action cluster in the Ground header.
  const right = card.querySelector('.ground-group-actions');
  if (!right) return;

  let badge = card.querySelector('.profiling-badge');

  if (status === 'running') {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'profiling-badge';
      right.insertBefore(badge, right.firstChild);
    }
    badge.textContent = `Chatting ${progress + 1}/${total}…`;
    badge.classList.remove('complete');

  } else if (status === 'complete') {
    if (badge) {
      badge.textContent = 'Profile ready';
      badge.classList.add('complete');
      // Fade out after 4s
      setTimeout(() => badge?.remove(), 4000);
    }

  } else if (status === 'error') {
    if (badge) badge.remove();
  }
}

// v2.28.2 (Pass Q) — Chat-initialisation wiring removed. Chat lives in
// chat.html, not Studio; there's no chat hint to update. handleProfilingStatus
// now just maintains the per-ground badge.


// ─── Prompts tab ──────────────────────────────────────────────────────────────

/**
 * Registry of all built-in system prompts used by Agent HUB.
 * Each entry has: id, label, badge (phase), description, and text.
 * Text is fetched from AnthropicService at render time via a dedicated
 * GET_PROMPTS message so the source of truth stays in AnthropicService.
 */
// v2.74.290 — Complete catalog of every system prompt the substrate
// sends to Anthropic. Each entry's `id` MUST match a key returned by
// AnthropicService.getPromptTexts(); the studio fetches the text via
// GET_PROMPTS and renders this list as collapsible cards in the Docs
// tab. When a new prompt is added in AnthropicService, add a matching
// entry here AND a snapshot to getPromptTexts(), otherwise the new
// prompt won't surface in the docs.
const PROMPT_REGISTRY = [
  // ── Ground (Tier 2 affordance) ─────────────────────────────────────
  {
    id   : 'deriveGroundDescription',
    label: 'Ground — Derived Description',
    badge: 'authoring',
    desc : 'GROUND_SPEC § 5. Synthesizes a 1-3 sentence summary of "what this Ground is for" from its constituent Perspectives\' names + descriptions. Lazy/manual — run on demand via the ↻ button on a Ground card; cache-validated by an inputs hash so unchanged Perspectives don\'t re-spend tokens.',
  },
  // ── Perspective (Tier 1 affordance) ─────────────────────────────────────
  {
    id   : 'proposePerspectiveStructure',
    label: 'Perspective — Structured Composition',
    badge: 'authoring',
    desc : 'PERSPECTIVE_SPEC § 3/§ 13 (LLM-as-author). Organizes a Perspective\'s already-picked landmarks into a structured perspective — a LandmarkNode tree (contains/role/multiplicity) plus groupings/sequences overlays. Run via "🧬 Structure with Claude" in perspective-capture; a safety parser clamps refs to the picked set and guarantees every landmark appears exactly once. Refine mode (v2.74.347) feeds the reviewed structure + judgments back so "Re-structure" preserves accepted/edited arrangements.',
  },
  {
    id   : 'proposePerspectives',
    label: 'Perspective — Description-First Perspectives',
    badge: 'authoring',
    desc : 'PERSPECTIVE_SPEC § 13 / § 16 priority 6 (description-first authoring). Seeded by the Perspective\'s intent description + the current page; proposes 2-3 perspective OPTIONS, each a named set of landmark ROLES to fill (not concrete selectors) plus urlMatches predicates and a rationale. Run via the baseline/enhanced buttons in perspective-capture; the user picks an option and fills each role with the picker. v2.74.350 adds an A/B benchmark — the "enhanced" arm additively passes a page screenshot + this Ground\'s existing perspectives/landmarks as context (system prompt unchanged, so the comparison isolates the added context).',
  },
  // ── Walk / Auto-mode runner ────────────────────────────────────────
  {
    id   : 'getNextStep_phase1',
    label: 'Walk Phase 1 — Access Point Discovery',
    badge: 'walk',
    desc : 'Sent each turn during Phase 1 of AI ground discovery. Navigation-only (CLICK, NAVIGATE, FIND_AI, WAIT, WAIT_FOR). Terminates when FOCUS_CHECK confirms the AI input is focusable.',
  },
  {
    id   : 'getNextStep_phase2',
    label: 'Walk Phase 2 — Interaction Discovery',
    badge: 'walk',
    desc : 'Sent each turn during Phase 2. Interaction-only (TYPE, CLICK, WAIT, EXTRACT). Panel is already open; input selector provided directly from Phase 1 handoff.',
  },
  {
    id   : 'getNextTaskStep',
    label: 'Auto-mode — Task Runner',
    badge: 'walk',
    desc : 'Sent each turn during a user-defined task walk. Single-phase runner that emits one DOM action per turn against the live page until STEP_DONE / DONE. Includes detailed sections on DOM attribute interpretation, transient signal reading, BLUR-after-TYPE, autocomplete handling, and SCROLL_TO semantics.',
  },
  {
    id   : 'proposeNextStep',
    label: 'Auto-mode — Step Proposer',
    badge: 'walk',
    desc : 'Called each iteration of the goal-oriented step proposer. Sees current DOM + screenshot + confirmed step history; returns one human-readable step (with {{PARAM}} tokens), rationale, and params, OR a "done" / "clarify" outcome.',
  },
  {
    id   : 'generateTemplate',
    label: 'Legacy — One-shot Template',
    badge: 'walk',
    desc : 'Legacy single-call template generation from a static DOM snapshot. Used when manually pasting a template JSON instead of running the live walk.',
  },

  // ── Discovery / Profiling ──────────────────────────────────────────
  {
    id   : 'generateSampleQuestion',
    label: 'Discovery — Sample Question',
    badge: 'discovery',
    desc : 'Called once at walk start in parallel with initial DOM capture. Generates a contextually appropriate discovery question for the specific AI product.',
  },
  {
    id   : 'discoverAnchors',
    label: 'Discovery — Anchor Discovery',
    badge: 'discovery',
    desc : 'Called after the send CLICK (processing-state DOM). Identifies generationIndicator + responseContainer + responseElement for Layer 2 and Layer 3 validation.',
  },
  {
    id   : 'isResponseComplete',
    label: 'Discovery — Response Completion',
    badge: 'discovery',
    desc : 'Polled during response capture to determine whether the AI has finished streaming. Falls back to "complete:true" on API failure so extraction proceeds.',
  },
  {
    id   : 'generateProfileQuestions',
    label: 'Profiling — Question Generation',
    badge: 'profiling',
    desc : 'Called once before the profiling pass. Generates N introspective meta-questions asking the AI about its own capabilities, data access, and scope.',
  },
  {
    id   : 'summarizeSite',
    label: 'Discovery — Site Summarizer',
    badge: 'discovery',
    desc : 'Used by the Ground Discover flow. Takes a domain + sample of crawled pages and returns { name, aliases, description }.',
  },
  {
    id   : 'classifyPage',
    label: 'Discovery — Page Classifier',
    badge: 'discovery',
    desc : 'Called once per page during structural Discovery. Returns { pageType, formFields[], outgoingLinks[] } for a single URL + DOM snapshot.',
  },
  {
    id   : 'generateTaskProfile',
    label: 'Discovery — Task Profile',
    badge: 'discovery',
    desc : 'Builds a semantic routing profile for a user-defined task ground. Generated directly from task description + steps + params (no live Q&A).',
  },

  // ── Perspective / Landmark ──────────────────────────────────────────────
  // v2.74.392 — 'suggestPerspective' entry removed with the legacy auto-suggest feature.
  {
    id   : 'suggestSelector',
    label: 'Picker — Suggest Selector',
    badge: 'authoring',
    desc : 'Picker-loop selector refinement. Given an Inspect report + author intent shape (and optionally a cropped element screenshot), returns a more stable CSS selector than the picker found.',
  },
  {
    id   : 'generateLandmarkProfile',
    label: 'Landmark — Generate Profile',
    badge: 'authoring',
    desc : 'Wave-2 landmark profile generation. After the picker resolves a target, this call produces the rich profile: description, aliases, operationsCommon, pitfalls, expectedContent, confidence. As of v2.74.288 the picker\'s selector is the authority — Claude can only override it when its proposal is at a strictly more stable tier.',
  },

  // ── Routing ────────────────────────────────────────────────────────
  {
    id   : 'matchQuestionToGround',
    label: 'Routing — Ground Matching',
    badge: 'routing',
    desc : 'Called at runtime when the user submits a chat question. Ranks all ground profiles by confidence and routes to the best-matched ground.',
  },
  {
    id   : 'extractStrategyParams',
    label: 'Routing — Strategy Param Extraction',
    badge: 'routing',
    desc : 'After a Strategy is routed to, this call pulls concrete values for its declared params out of the user\'s natural-language message (e.g. QUERY=\'software engineer\', LOCATION=\'Seattle\').',
  },

  // ── Fragment / Assertion / Conditions ──────────────────────────────
  {
    id   : 'proposeFragmentConditions',
    label: 'Fragment — Propose Conditions',
    badge: 'authoring',
    desc : 'Called after a Fragment walk completes. Compares start/end DOM + recorded actions and proposes 2–4 preconditions and 2–4 postconditions using the page-scope condition grammar.',
  },
  {
    id   : 'composeAssertion',
    label: 'Assertion — Compose Body',
    badge: 'authoring',
    desc : 'Authors an Assertion body ({match, conditions} envelope) from a typed contract (name + description + family). Used by the Studio Assertion form\'s Generate button and by the T3 strategy composer.',
  },
  {
    id   : 'generateDetectConditions',
    label: 'Strategy — DETECT Branch Conditions',
    badge: 'authoring',
    desc : 'Generates mutually-exclusive branch conditions for DETECT nodes in a Strategy procedure. Sees the DOM observations the user captured at each fork point.',
  },

  // ── Observation ────────────────────────────────────────────────────
  {
    id   : 'extractSectionItems_text',
    label: 'Observation — Section Text Items',
    badge: 'observation',
    desc : 'Distills a section\'s text content into a curated list of meaningful values (titles, names, prices). Powers the Observation Section extract shape in text mode.',
  },
  {
    id   : 'extractSectionItems_url',
    label: 'Observation — Section URL Items',
    badge: 'observation',
    desc : 'Distills a section\'s link list into a curated array of navigable URLs. Powers the Observation Section extract shape in url mode.',
  },
  {
    id   : 'readImage',
    label: 'Observation — Image Read',
    badge: 'observation',
    desc : 'Vision read of a cropped screenshot. The Observation Image extract shape sends this when the author drags a region and writes a description of what they want extracted.',
  },
  {
    id   : 'observationFrontierVision',
    label: 'Observation — Frontier Vision (T3)',
    badge: 'frontier',
    desc : 'Frontier-tier (Opus) vision Observation. Receives a screenshot + Observation record and returns bounding boxes of the requested content via the locate_regions tool. Used for high-precision visual region locating.',
  },

  // ── Analysis ──────────────────────────────────────────────────────
  {
    id   : 'recoverAnalysisFromCache',
    label: 'Analysis — Recovery (T3)',
    badge: 'recovery',
    desc : 'Sent when an Analysis with autoRecover=true has its cache implementation produce output that violates the contract. Asks the model to identify which input items (by index) satisfy the contract. Per-call dynamic content (operations, contract, input items, cache output) is added at runtime.',
  },
  {
    id   : 'invokeAnalysisFrontierPrimary',
    label: 'Analysis — Frontier Primary (T3)',
    badge: 'frontier',
    desc : 'Sent when an Analysis whose primary tier is Frontier executes. The model receives description (primary intent signal), pre/post conditions, params, and input data, and produces output that satisfies the contract.',
  },

  // ── Misc ──────────────────────────────────────────────────────────
  {
    id   : 'generateConversationTitle',
    label: 'Chat — Conversation Title',
    badge: 'misc',
    desc : 'Generates a short 4–6 word title from the first user message in a chat. Used to name persisted conversations in the side panel.',
  },
];

const BADGE_LABELS = {
  walk        : 'Walk',
  discovery   : 'Discovery',
  profiling   : 'Profiling',
  routing     : 'Routing',
  authoring   : 'Authoring',
  observation : 'Observation',
  recovery    : 'Recovery',
  frontier    : 'Frontier',
  misc        : 'Misc',
};

/**
 * Renders the prompts tab. Fetches prompt text from background via GET_PROMPTS,
 * then builds collapsible cards for each entry in the registry.
 */
async function renderPromptsTab() {
  const list = $('prompt-list');
  if (!list) return;

  // Fetch all prompt texts from background/AnthropicService
  const res = await new Promise(r =>
    chrome.runtime.sendMessage({ type: 'GET_PROMPTS' }, r)
  );
  const prompts = res?.prompts ?? {};

  list.innerHTML = '';

  PROMPT_REGISTRY.forEach(entry => {
    const text = prompts[entry.id] ?? '(prompt text unavailable)';
    const card = document.createElement('div');
    card.className = 'prompt-card';
    card.dataset.id = entry.id;

    card.innerHTML = `
      <div class="prompt-card-header">
        <span class="prompt-expand-btn">▶</span>
        <div class="prompt-card-meta">
          <div class="prompt-card-label">${escHtml(entry.label)}</div>
          <div class="prompt-card-desc">${escHtml(entry.desc)}</div>
        </div>
        <span class="prompt-card-badge badge-${entry.badge}">${escHtml(BADGE_LABELS[entry.badge] ?? entry.badge)}</span>
      </div>
      <div class="prompt-card-body">
        <pre class="prompt-full-text">${escHtml(text)}</pre>
        <div class="prompt-copy-row">
          <button class="prompt-copy-btn" data-id="${entry.id}">Copy</button>
        </div>
      </div>`;

    // Toggle expand/collapse
    card.querySelector('.prompt-card-header').addEventListener('click', () => {
      card.classList.toggle('open');
    });

    // Copy button
    card.querySelector('.prompt-copy-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await navigator.clipboard.writeText(text);
        toast('Prompt copied');
      } catch {
        toast('Copy failed', 'err');
      }
    });

    list.appendChild(card);
  });
}

// ─── Docs tab: Definitions section ──────────────────────────────────────────
//
// System-concept reference cards. Mirrors the System Prompts list visually
// (same .prompt-card structure) but each card collapses to a multi-line
// definition and expands to a primitive list with examples. Primitive names
// reflect the actual registries in code:
//   - Fragment action types        → Services/SchemaValidator.js ACTION_TYPES
//   - Observation extract shapes   → Services/Observation.js T1/T3 tiers
//   - Strategy node types          → Services/SchemaValidator.js NODE_TYPES
//   - Assertion/Condition vocab    → Services/ConditionVocabulary.js
//   - Analysis tiers/ops           → Services/BuiltinAnalyses.js
const DEFINITION_REGISTRY = [
  {
    id: 'fragment',
    label: 'Fragment',
    definition: 'A reusable, parameterizable sequence of UI actions replayed against a page. Captures the steps needed to drive an interaction — open a panel, send a query, dismiss a banner — as one named unit a Strategy can dispatch or that runs standalone.',
    primitives: [
      { name: 'NAVIGATE',       def: 'Load a URL in the active tab. Usually the first action so subsequent steps run from a known starting page.', example: 'Navigate to /chat before typing into the chat input.' },
      { name: 'CLICK',          def: 'Click a CSS-selected element.', example: 'Click button.send-message to submit the prompt.' },
      { name: 'CLICK_BY_LABEL', def: 'Click the element whose visible text matches a label. Resilient when class names change but copy stays stable. Hosts the action-branch mechanism.', example: 'Click the button labelled "Send".' },
      { name: 'TYPE',           def: 'Type text into an input. Supports {{PARAM}} placeholders that are substituted at run time.', example: 'Type "{{QUERY}}" into the chat input.' },
      { name: 'WAIT',           def: 'Pause for a fixed duration in milliseconds.', example: 'WAIT 800 ms to let an animation settle before the next click.' },
      { name: 'WAIT_FOR',       def: 'Pause until a selector appears in the DOM.', example: 'Wait for .response-bubble after submitting the prompt.' },
      { name: 'WAIT_FOR_GONE',  def: 'Pause until a selector disappears.', example: 'Wait for the loading spinner to vanish before reading the result.' },
      { name: 'FIND_AI',        def: 'Locate a target by intent rather than selector, when picker-based selection is not reliable.', example: 'Find the primary "send" affordance regardless of its current class name.' },
      { name: 'EXTRACT',        def: 'Capture text or an attribute from a selector and bind it to a parameter name for use later in the fragment.', example: 'Extract .price text into BIND PRICE so a later TYPE can echo it.' },
      { name: 'ENUMERATE',      def: 'Iterate over matched elements and bind them as a list of records.', example: 'Enumerate li.search-result and bind each row\'s href and title.' },
      { name: 'SELECT',         def: 'Pick a value from a native <select> or a custom dropdown.', example: 'Select "Last 30 days" in the date-range dropdown.' },
      { name: 'BLUR',           def: 'Remove focus from the active element. Useful when a site only commits an input on blur.', example: 'Blur the search input so its onChange fires before the next click.' },
      { name: 'SCROLL_TO',      def: 'Scroll a selector into view.', example: 'Scroll to the footer cookie button before clicking it.' },
      { name: 'Action branch',  def: 'A conditional sub-sequence carried inside a CLICK_BY_LABEL action. Lets a single fragment handle alternate UI states without forking into multiple fragments.', example: 'Click "Account"; in branches, if "Settings" is visible click it, otherwise click "More" first and then "Settings".' },
    ],
  },
  {
    id: 'observation',
    label: 'Observation',
    definition: 'A reusable bundle of named reads from the page. Pairs selectors with binding names so each run produces a record of UI state that downstream Strategies, Assertions, and Analyses can consume.',
    primitives: [
      { name: 'scalar',          def: 'Capture one value — text or an attribute — from a single element.', example: 'Bind the headline text to HEADLINE.' },
      { name: 'raw_text',        def: 'Capture the full inner text of a region as a single string.', example: 'Read the entire footer block as one paragraph for later parsing.' },
      { name: 'raw_html',        def: 'Capture innerHTML for downstream parsing or vision review.', example: 'Keep the response container\'s HTML so a token-count analysis can inspect it.' },
      { name: 'list_of_records', def: 'Iterate matched rows and bind each row\'s fields as a structured record.', example: 'From the search-result list, bind each row\'s title, url, and snippet.' },
      { name: 'section',         def: 'Capture a logical region of the page (header, sidebar, results panel) as a structured chunk.', example: 'Capture the entire results panel for a follow-up summary analysis.' },
      { name: 'image_refs',      def: 'Capture image src/href references rather than the rendered pixels.', example: 'Collect every thumbnail URL in a gallery without downloading the bytes.' },
      { name: 'image / image_list', def: 'Capture rendered images, single or list. Available in both cache (T1) and frontier (T3) tiers — frontier feeds them to a vision model.', example: 'Capture the chart image for a frontier analysis that reads its axes.' },
      { name: 'image_snap',      def: 'Capture a screenshot of the element itself rather than its source URL. Use when the rendered pixels matter more than the file.', example: 'Snap a generated visualization that has no clean image src to read.' },
      { name: 'Extract (picker)',def: 'Selector chosen via the in-page picker overlay. Preferred when the picker can isolate the element cleanly.', example: 'Click + Extract, then pick the price element on the product page.' },
      { name: 'Free extract',    def: 'Author-written selector. Used when the picker cannot reach the target (shadow DOM, dynamic class) or when a hand-written CSS path is more stable.', example: 'Write [data-test-id="price"] by hand because the picker keeps grabbing the wrong wrapper.' },
    ],
  },
  {
    id: 'strategy',
    label: 'Strategy',
    definition: 'A higher-level procedure that composes Fragments and Observations into a goal-oriented flow. Strategies branch on page state, iterate over collected data, and decide which Fragments to dispatch in which order.',
    primitives: [
      { name: 'SEQUENCE', def: 'Run a flat list of steps in order. The implicit shape of every Strategy\'s top level.', example: 'Run the cookie-banner fragment, then the login fragment, then the search observation.' },
      { name: 'FOR_EACH', def: 'Iterate over a bound list and run a body once per item.', example: 'For each row in RESULTS, dispatch the "open detail page" fragment with that row\'s link.' },
      { name: 'DETECT',   def: 'Branch on a page condition and run the matching body. The Strategy version of an if/elif/else.', example: 'If the cookie banner is present, run the dismiss fragment; otherwise skip ahead to the search step.' },
    ],
  },
  {
    id: 'ground',
    label: 'Ground',
    definition: 'The per-site context profile. One Ground per target domain holds the URL pattern, capability notes, and the library of Fragments, Observations, Strategies, Assertions, and Analyses authored against that site. Picking a Ground at run time tells the system "use this site\'s library to answer the question."',
    primitives: [
      { name: 'URL pattern',     def: 'The match expression that identifies which pages belong to this Ground. Used to auto-route an incoming question to the right library.', example: 'https://app.example.com/* matches the entire customer dashboard.' },
      { name: 'Library entries', def: 'Each Ground owns its own collection of Fragments, Observations, Strategies, Assertions, and Analyses. Entries are scoped — assertions written for one Ground don\'t pollute another.', example: 'The "Acme Console" Ground has its own login fragment that the "Acme Marketing" Ground never sees.' },
      { name: 'Capability notes',def: 'Author-written summary of what the site supports. Used during routing to pick the best-matched Ground for a question.', example: '"Supports filtering invoices by date range and exporting to CSV" — surfaced to the router when a user asks about invoices.' },
    ],
  },
  {
    id: 'assertion',
    label: 'Assertion',
    definition: 'A reusable validation rule. Defines a condition the system can check against the page itself or against a bound value produced by an Observation or Analysis. Assertions are the unit of "this worked" — both pre-flight gates and post-run verifications draw from this library.',
    primitives: [
      { name: 'Page family',    def: 'Inspects the DOM, URL, cookies, or page metadata: selector_present, selector_absent, url_matches, text_present, attribute_equals, resource_loaded, cookie_present, meta_equals.', example: 'Assert url_matches /account before running the logout fragment; assert text_present "Saved" after submit.' },
      { name: 'Scope (list)',   def: 'Validates a bound list: binding_is_list, binding_length_min/max/range/exactly, every_record_has_field, every_record_field_non_empty/equals/starts_with/in_set.', example: 'Every record in RESULTS has a non-empty title and a url that starts with https://.' },
      { name: 'Scope (record)', def: 'Validates a bound record: binding_is_record, record_has_field, record_field_non_empty.', example: 'The USER record has a non-empty displayName field.' },
      { name: 'Scope (scalar)', def: 'Validates a bound scalar: binding_is_scalar, scalar_non_empty, scalar_is_number, scalar_equals, scalar_number_range, scalar_in_set.', example: 'PRICE is a number between 0 and 1000.' },
      { name: 'Scope (document)', def: 'Validates a bound document/section/image: binding_is_section, binding_is_image, binding_is_document, document_min_length, document_contains.', example: 'The captured TERMS document is at least 200 characters and contains the phrase "Terms of Service".' },
    ],
  },
  {
    id: 'condition',
    label: 'Condition',
    definition: 'A pre- or post-condition attached to a Fragment, Observation, or Analysis. Pre-conditions decide whether to run; post-conditions decide whether the run succeeded. Conditions reuse the Assertion vocabulary — the same primitives describe both the gate and the verification.',
    primitives: [
      { name: 'Pre-condition',   def: 'Evaluated before the body runs. Used to skip when the page isn\'t in the right shape, or to refuse to run a fragment from the wrong URL.', example: 'Pre = url_matches /results so the "extract result row" observation only runs on the results page.' },
      { name: 'Post-condition',  def: 'Evaluated after the body runs. Used to validate the outcome before binding it to downstream consumers.', example: 'Post = binding_is_list on the RESULTS output of a list observation, so a failed extraction is caught immediately.' },
      { name: 'Page-scope conditions',  def: 'Apply to Fragment pre/post and Strategy DETECT branches. Inspect the live DOM and URL: selector_present, url_matches, text_present, etc.', example: 'A fragment that only makes sense on the cart page has pre = url_matches /cart.' },
      { name: 'Scope-scope conditions', def: 'Apply to Observation and Analysis post-conditions. Inspect bound values rather than the DOM.', example: 'An Analysis that filters records has post = binding_length_min 1 to fail loudly when nothing matches.' },
    ],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    definition: 'A transformation step that takes bound inputs and produces a derived output. Analyses sit between raw Observations and the user-visible answer — they filter, sort, aggregate, or summarize the data before it\'s surfaced.',
    primitives: [
      { name: 'Cache tier (T1)',    def: 'Deterministic operations encoded as a recipe of filter/sort/take steps. Runs locally in milliseconds, no model call.', example: 'Filter RESULTS to records where price < 100, sort by rating descending, take the top 5.' },
      { name: 'Frontier tier (T3)', def: 'Invokes the Claude model with the bound inputs and a description of the desired output. Slower (seconds) but handles transformations that aren\'t easily expressed as rules — semantic summarization, fuzzy classification.', example: 'Given the RESPONSES list, return the one that best answers the original question and explain why.' },
      { name: 'filter',             def: 'Cache-tier op. Drops records that don\'t match an assertion type from the Scope family.', example: 'filter every_record_field_starts_with url "https://" — keeps only secure links.' },
      { name: 'sort',               def: 'Cache-tier op. Orders records by a named field, ascending or descending.', example: 'sort by rating descending so the highest-rated row is first.' },
      { name: 'take',               def: 'Cache-tier op. Limits the output to the first N records.', example: 'take 5 after sorting, to return only the top results.' },
    ],
  },
];

/**
 * Renders the Definitions section of the Docs tab. Mirrors renderPromptsTab's
 * structure — each definition is a collapsible card whose header shows the
 * concept name + a multi-line definition (always visible), and whose body
 * lists the concept's primitives with per-item definition and example.
 */
function renderDefinitionsList() {
  const list = $('definition-list');
  if (!list) return;
  list.innerHTML = '';

  DEFINITION_REGISTRY.forEach(entry => {
    const card = document.createElement('div');
    card.className = 'prompt-card definition-card';
    card.dataset.id = entry.id;

    const items = entry.primitives.map(p => `
      <li class="definition-primitive">
        <span class="definition-primitive-name">${escHtml(p.name)}</span>
        <span class="definition-primitive-def">${escHtml(p.def)}</span>
        <span class="definition-primitive-example">Example: ${escHtml(p.example)}</span>
      </li>`).join('');

    card.innerHTML = `
      <div class="prompt-card-header">
        <span class="prompt-expand-btn">▶</span>
        <div class="prompt-card-meta">
          <div class="prompt-card-label">${escHtml(entry.label)}</div>
          <div class="prompt-card-desc definition-card-desc">${escHtml(entry.definition)}</div>
        </div>
      </div>
      <div class="prompt-card-body">
        <ul class="definition-primitives">${items}</ul>
      </div>`;

    card.querySelector('.prompt-card-header').addEventListener('click', () => {
      card.classList.toggle('open');
    });

    list.appendChild(card);
  });
}

function renderDocsTab() {
  renderDefinitionsList();
  renderPromptsTab();
}

// Render when Docs tab is activated
qsa('.tab-btn').forEach(btn => {
  if (btn.dataset.tab === 'prompts') {
    btn.addEventListener('click', () => renderDocsTab());
  }
});

// ─── v2.74.357 — Resolve performance viewer ─────────────────────────────────
// Mines the resolveRoles:perf log (written by perspective-capture per ⚡ Resolve
// run) into success-by-difficulty + failure-mode analysis. See
// DESIGN_resolve_roles.md § 7/§ 8.
const RESOLVE_PERF_KEY = 'resolveRoles:perf';
const RP_TIERS = ['simple', 'moderate', 'complex', 'severe'];

// Collapse near-identical reasons (digits → N) so they group in the histogram.
function _rpNormReason(reason) {
  return String(reason || 'unknown').toLowerCase().replace(/\d+/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 80);
}
// SYNTHESIS = bad/unreachable/ambiguous selector (→ set-of-marks / feedback);
// MATCHING = wrong element chosen (→ better visual capture / region scoping).
function _rpFailClass(reason) {
  const r = String(reason || '').toLowerCase();
  if (r.includes('type does not match') || r.includes('role implies') || r.includes('not visible') || r.includes('not interactable')) return 'matching';
  return 'synthesis';   // 0-matches, ambiguous (expected one), threw, default
}

async function renderResolvePerf() {
  const body = $('resolveperf-body');
  if (!body) return;
  const got = await new Promise(r => chrome.storage.local.get(RESOLVE_PERF_KEY, r));
  const runs = Array.isArray(got?.[RESOLVE_PERF_KEY]) ? got[RESOLVE_PERF_KEY] : [];
  if (!runs.length) {
    body.innerHTML = `<p class="empty-state">No Resolve-roles runs logged yet. Use ⚡ Resolve roles in perspective capture — each run lands here.</p>`;
    return;
  }

  const agg = {};
  for (const t of RP_TIERS) agg[t] = { initRuns:0, initRoles:0, initResolved:0, repairRuns:0, repairResolved:0, msSum:0, msN:0, scoreSum:0, scoreN:0 };
  const reasons = {};
  let synth = 0, match = 0, firstTs = Infinity, lastTs = 0;

  for (const run of runs) {
    if (run.ts) { firstTs = Math.min(firstTs, run.ts); lastTs = Math.max(lastTs, run.ts); }
    const t = RP_TIERS.includes(run.tier) ? run.tier : null;
    if (t) {
      const a = agg[t];
      if (run.mode === 'repair') { a.repairRuns++; a.repairResolved += run.resolved||0; }
      else { a.initRuns++; a.initRoles += run.rolesTotal||0; a.initResolved += run.resolved||0; }
      if (typeof run.ms === 'number') { a.msSum += run.ms; a.msN++; }
      if (typeof run.score === 'number') { a.scoreSum += run.score; a.scoreN++; }
    }
    for (const d of Array.isArray(run.details) ? run.details : []) {
      if (d.status === 'failed' && d.reason) {
        const key = _rpNormReason(d.reason);
        const cls = _rpFailClass(d.reason);
        if (!reasons[key]) reasons[key] = { count: 0, cls };
        reasons[key].count++;
        if (cls === 'matching') match++; else synth++;
      }
    }
  }

  const pct = (n, d) => d > 0 ? Math.round(100*n/d) : null;
  let tierRows = '';
  for (const t of RP_TIERS) {
    const a = agg[t];
    if (a.initRuns === 0 && a.repairRuns === 0) continue;
    const initP = pct(a.initResolved, a.initRoles);
    const afterP = pct(a.initResolved + a.repairResolved, a.initRoles);
    const avgScore = a.scoreN ? Math.round(a.scoreSum/a.scoreN) : null;
    const avgMs = a.msN ? Math.round(a.msSum/a.msN) : null;
    tierRows += `<tr>
      <td><span class="cx-pill cx-${t}">${t}</span>${avgScore!=null?` <span class="rp-dim">${avgScore}</span>`:''}</td>
      <td>${initP!=null?initP+'%':'—'} <span class="rp-dim">${a.initResolved}/${a.initRoles}</span></td>
      <td>${afterP!=null?afterP+'%':'—'}${a.repairResolved?` <span class="rp-up">+${a.repairResolved}</span>`:''}</td>
      <td class="rp-dim">${a.initRuns}${a.repairRuns?` +${a.repairRuns}r`:''}</td>
      <td class="rp-dim">${avgMs!=null?avgMs+'ms':'—'}</td>
    </tr>`;
  }

  const totalFail = synth + match;
  const synthPct = totalFail ? Math.round(100*synth/totalFail) : 0;
  const matchPct = totalFail ? 100 - synthPct : 0;
  const reasonList = Object.entries(reasons).sort((a,b)=>b[1].count-a[1].count).slice(0,10);
  const maxReason = reasonList.length ? reasonList[0][1].count : 1;
  const reasonRows = reasonList.map(([r, info]) => `
    <div class="rp-reason">
      <span class="rp-reason-tag rp-${info.cls}">${info.cls}</span>
      <span class="rp-reason-label">${escHtml(r)}</span>
      <span class="rp-reason-bar"><span style="width:${Math.round(100*info.count/maxReason)}%"></span></span>
      <span class="rp-reason-count">${info.count}</span>
    </div>`).join('');

  const recent = runs.slice(-25).reverse().map(run => {
    const time = run.ts ? new Date(run.ts).toLocaleTimeString() : '—';
    let host = ''; try { host = new URL(run.url).host; } catch { host = (run.url || '').slice(0, 40); }
    const t = RP_TIERS.includes(run.tier) ? run.tier : '';
    return `<tr>
      <td class="rp-dim">${escHtml(time)}</td>
      <td>${run.mode==='repair'?'<span class="rp-up">retry</span>':'initial'}</td>
      <td>${t?`<span class="cx-pill cx-${t}">${t}</span>`:''} <span class="rp-dim">${run.score??'?'}</span></td>
      <td>${run.resolved??0}/${run.rolesTotal??0}</td>
      <td class="rp-dim">${run.failed??0}</td>
      <td class="rp-dim">${run.abstained??0}</td>
      <td class="rp-dim">${run.ms??'?'}ms</td>
      <td class="rp-dim" title="${escAttr(run.url||'')}">${escHtml(host)}</td>
    </tr>`;
  }).join('');

  const range = (firstTs < Infinity) ? `${new Date(firstTs).toLocaleDateString()} – ${new Date(lastTs).toLocaleDateString()}` : '';

  body.innerHTML = `
    <div class="rp-summary">${runs.length} run(s) · ${escHtml(range)}</div>

    <div class="section-header"><h3 class="card-subheading">Success by difficulty tier</h3></div>
    <table class="rp-table">
      <thead><tr><th>Tier <span class="rp-dim">(avg score)</span></th><th>Initial</th><th>After retry</th><th>Runs</th><th>Avg time</th></tr></thead>
      <tbody>${tierRows || '<tr><td colspan="5" class="rp-dim">No tiered runs.</td></tr>'}</tbody>
    </table>

    <div class="section-header"><h3 class="card-subheading">Failure modes ${totalFail?`<span class="rp-dim">(${totalFail} failed roles)</span>`:''}</h3></div>
    ${totalFail ? `
      <div class="rp-modesplit">
        <span class="rp-synthesis">synthesis ${synthPct}%</span> · <span class="rp-matching">matching ${matchPct}%</span>
      </div>
      <div class="rp-modehint">${synthPct >= matchPct
        ? 'Synthesis-dominated → selectors are wrong / unreachable / ambiguous. Levers: the feedback loop (§8) and set-of-marks (§4).'
        : 'Matching-dominated → Claude picks the wrong element. Levers: better visual capture / region scoping.'}</div>
      ${reasonRows}
    ` : `<p class="rp-dim">No verification failures logged.</p>`}

    <div class="section-header"><h3 class="card-subheading">Recent runs</h3></div>
    <table class="rp-table">
      <thead><tr><th>Time</th><th>Mode</th><th>Tier</th><th>Resolved</th><th>Fail</th><th>Abst</th><th>ms</th><th>Site</th></tr></thead>
      <tbody>${recent}</tbody>
    </table>`;
}

$('btn-resolveperf-refresh')?.addEventListener('click', renderResolvePerf);
$('btn-resolveperf-copy')?.addEventListener('click', async () => {
  const got = await new Promise(r => chrome.storage.local.get(RESOLVE_PERF_KEY, r));
  try { await navigator.clipboard.writeText(JSON.stringify(got?.[RESOLVE_PERF_KEY] ?? [], null, 2)); toast?.('Copied run log JSON'); }
  catch (e) { toast?.(`Copy failed: ${e.message}`, 'err'); }
});
$('btn-resolveperf-clear')?.addEventListener('click', async () => {
  if (!confirm('Clear the Resolve-roles run log? This cannot be undone.')) return;
  await new Promise(r => chrome.storage.local.remove(RESOLVE_PERF_KEY, r));
  renderResolvePerf();
});

// ─── v2.74.358 — LLM audit viewer (DESIGN_llm_roles.md § 5) ──────────────────
const LLM_AUDIT_KEY = 'llm:audit';
const LLM_ROLE_ORDER = ['propose', 'resolve', 'describe', 'plan', 'extract', 'classify', 'unclassified'];
const _rolePillCls = (role) => `role-pill ${role === 'unclassified' ? 'role-unclassified' : 'role-' + role}`;

async function renderLlmAudit() {
  const body = $('llm-audit-body');
  if (!body) return;
  const got = await new Promise(r => chrome.storage.local.get(LLM_AUDIT_KEY, r));
  const calls = Array.isArray(got?.[LLM_AUDIT_KEY]) ? got[LLM_AUDIT_KEY] : [];
  if (!calls.length) {
    body.innerHTML = `<p class="empty-state">No LLM calls audited yet. Trigger any Claude-backed action; calls land here.</p>`;
    return;
  }

  const byRole = {}, byOp = {};
  let firstTs = Infinity, lastTs = 0, totalTok = 0, totalCost = 0;
  const add = (map, key, c) => {
    const m = map[key] ?? (map[key] = { calls:0, ok:0, latSum:0, latN:0, lats:[], tok:0, cost:0 });
    m.calls++; if (c.ok) m.ok++;
    if (typeof c.latencyMs === 'number') { m.latSum += c.latencyMs; m.latN++; m.lats.push(c.latencyMs); }
    m.tok += (c.inTokens || 0) + (c.outTokens || 0);
    m.cost += (c.costUsd || 0);
  };
  for (const c of calls) {
    const role = c.role || 'unclassified';
    add(byRole, role, c);
    add(byOp, `${role} ${c.operation || 'unknown'}`, c);
    totalTok += (c.inTokens || 0) + (c.outTokens || 0);
    totalCost += (c.costUsd || 0);
    if (c.ts) { firstTs = Math.min(firstTs, c.ts); lastTs = Math.max(lastTs, c.ts); }
  }
  const p95 = (arr) => { if (!arr.length) return null; const s = [...arr].sort((a,b)=>a-b); return s[Math.min(s.length-1, Math.floor(0.95*s.length))]; };
  const stat = (m) => ({ calls:m.calls, okPct: m.calls?Math.round(100*m.ok/m.calls):0, avg: m.latN?Math.round(m.latSum/m.latN):null, p95: p95(m.lats), tok: m.tok, cost: m.cost });
  const fmtTok = (n) => !n ? '—' : (n >= 1000 ? (n/1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n));
  const fmtUsd = (n) => !n ? '—' : (n < 0.01 ? '<$0.01' : '$' + n.toFixed(n < 1 ? 3 : 2));
  const shortModel = (m) => String(m || '—').replace(/-(\d{8})$/, '').replace(/^claude-/, '');

  const roleKeys = [...new Set([...LLM_ROLE_ORDER.filter(r=>byRole[r]), ...Object.keys(byRole)])];
  const roleRows = roleKeys.map(role => {
    const s = stat(byRole[role]);
    return `<tr>
      <td><span class="${_rolePillCls(role)}">${escHtml(role)}</span></td>
      <td>${s.calls}</td><td>${s.okPct}%</td>
      <td class="rp-dim">${s.avg!=null?s.avg+'ms':'—'}</td>
      <td class="rp-dim">${s.p95!=null?s.p95+'ms':'—'}</td>
      <td class="rp-dim">${fmtTok(s.tok)}</td>
      <td class="rp-dim">${fmtUsd(s.cost)}</td>
    </tr>`;
  }).join('');

  const opRows = Object.entries(byOp)
    .map(([k,m]) => { const [role,op] = k.split(' '); return { role, op, s: stat(m) }; })
    .sort((a,b)=>b.s.calls-a.s.calls)
    .map(e => `<tr>
      <td><span class="${_rolePillCls(e.role)}">${escHtml(e.role)}</span></td>
      <td>${escHtml(e.op)}</td><td>${e.s.calls}</td><td>${e.s.okPct}%</td>
      <td class="rp-dim">${e.s.avg!=null?e.s.avg+'ms':'—'}</td>
      <td class="rp-dim">${fmtTok(e.s.tok)}</td>
      <td class="rp-dim">${fmtUsd(e.s.cost)}</td>
    </tr>`).join('');

  const recent = calls.slice(-30).reverse().map(c => {
    const role = c.role || 'unclassified';
    const time = c.ts ? new Date(c.ts).toLocaleTimeString() : '—';
    return `<tr>
      <td class="rp-dim">${escHtml(time)}</td>
      <td><span class="${_rolePillCls(role)}">${escHtml(role)}</span></td>
      <td>${escHtml(c.operation || 'unknown')}</td>
      <td>${c.ok ? '<span class="rp-up">ok</span>' : '<span class="rp-fail">fail</span>'}</td>
      <td class="rp-dim">${c.latencyMs!=null?c.latencyMs+'ms':'—'}</td>
      <td class="rp-dim" title="${(c.inTokens||0)} in / ${(c.outTokens||0)} out">${fmtTok((c.inTokens||0)+(c.outTokens||0))}</td>
      <td class="rp-dim">${fmtUsd(c.costUsd)}</td>
      <td class="rp-dim">${escHtml(shortModel(c.model))}</td>
    </tr>`;
  }).join('');

  const unclassified = byRole['unclassified']?.calls ?? 0;
  const range = firstTs<Infinity ? `${new Date(firstTs).toLocaleString()} – ${new Date(lastTs).toLocaleString()}` : '';

  body.innerHTML = `
    <div class="rp-summary">${calls.length} call(s) · ${fmtTok(totalTok)} tokens · ${fmtUsd(totalCost)} · ${escHtml(range)}${unclassified?` · <span class="rp-fail">${unclassified} unclassified</span> (need a role declared)`:''}</div>
    <div class="section-header"><h3 class="card-subheading">By role</h3></div>
    <table class="rp-table"><thead><tr><th>Role</th><th>Calls</th><th>OK</th><th>Avg</th><th>p95</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${roleRows}</tbody></table>
    <div class="section-header"><h3 class="card-subheading">By operation</h3></div>
    <table class="rp-table"><thead><tr><th>Role</th><th>Operation</th><th>Calls</th><th>OK</th><th>Avg</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${opRows}</tbody></table>
    <div class="section-header"><h3 class="card-subheading">Recent calls</h3></div>
    <table class="rp-table"><thead><tr><th>Time</th><th>Role</th><th>Operation</th><th>Status</th><th>Latency</th><th>Tokens</th><th>Cost</th><th>Model</th></tr></thead><tbody>${recent}</tbody></table>`;
}

$('btn-llm-refresh')?.addEventListener('click', renderLlmAudit);
$('btn-llm-copy')?.addEventListener('click', async () => {
  const got = await new Promise(r => chrome.storage.local.get(LLM_AUDIT_KEY, r));
  try { await navigator.clipboard.writeText(JSON.stringify(got?.[LLM_AUDIT_KEY] ?? [], null, 2)); toast?.('Copied LLM audit JSON'); }
  catch (e) { toast?.(`Copy failed: ${e.message}`, 'err'); }
});
$('btn-llm-clear')?.addEventListener('click', async () => {
  if (!confirm('Clear the LLM audit log? This cannot be undone.')) return;
  await new Promise(r => chrome.storage.local.remove(LLM_AUDIT_KEY, r));
  renderLlmAudit();
});



// ─── v2.42.0 (Pass M2) — Assertion library ─ Pass 17c: extracted ─────────
//
// Assertion form moved to Studio/AssertionForm.js in Pass 17c. This
// module imports openAssertionForm + deleteAssertion (used by the
// Ground cards assertion library section) and calls setupAssertionForm()
// once at module load to wire button handlers.
//
// Assertion-related code that remains in studio.js:
//   - Assertion library section rendering inside the Ground card (above)
//   - assertionConditionSummary + truncate helpers (above)
//   - assertion_ref handling in renderConditionEditor / buildConditionTypeOptions
//   - strategyAssertionCache / fragmentAssertionCache / analysisAssertionCache
//
// v2.72.34 (Pass 17d) — The dangling libraryAssertionCache /
// libraryPerspectiveCache module-globals previously here have been removed:
// they were Observation-form-only state and are now file-local in
// Studio/ObservationForm.js.

// ─── v2.72.45 (Pass 17g iter) — Perspective authoring ────────────────────────
//
// Perspective authoring lives in the debugger sidepanel as of Pass 17g iter.
// "+ Perspective" on a Ground card calls launchPerspectiveCapture (top of this file)
// which opens the debugger sidepanel and sends BEGIN_PERSPECTIVE_CAPTURE.
// The debugger handles name/description/URL pattern + landmarks + save.
//
// Studio/PerspectiveForm.js still hosts: deletePerspective (with usage-count UX) +
// setupPerspectiveForm (no-op shim that wires refreshGroundList for delete).
//
// Perspective-related code that remains in studio.js:
//   - Ground card's Perspective library section rendering (above)
//   - perspective_ref handling in renderConditionEditor / buildConditionTypeOptions
//   - strategyPerspectiveCache, libraryPerspectiveCache, fragmentPerspectiveCache
//     (state owned by their respective forms; lifecycle stays here)

// v2.72.33 (Pass 17c) — Assertion form button wiring + Generate handler
// moved to Studio/AssertionForm.js setupAssertionForm().

// ─── v2.62.0 — Analysis library — Pass 17e: extracted ────────────────────
//
// Analysis form moved to Studio/AnalysisForm.js in Pass 17e. Studio.js
// retains the Ground cards Analysis library section (calls
// openAnalysisForm + deleteAnalysis via imports).
//
// Analysis-related code that remains in studio.js:
//   - Analysis library section rendering inside the Ground card (above)
//   - analysisAssertionCache: now file-local in AnalysisForm.js


// v2.73.2 (Pass 4-f Phase 2) — tier-choice button handlers folded into
// wireStrategyTopLevelInputs() inside Studio/StrategyForm.js (along with
// the rest of the strategy form wiring).




// v2.72.99 (Pass 4-d) — Strategy pre/post Add buttons + section toggle
// tracking moved into wireStrategyTopLevelInputs() inside
// Studio/StrategyForm.js.


// ─── v2.43.0 — JSON view modal ───────────────────────────────────────────
// v2.51.0 — modal is now EDITABLE. Save button parses the textarea content,
// runs the same validators the form editors use, and persists via the same
// SAVE_X messages. On validation failure the modal stays open with an inline
// error. The form editors don't auto-refresh from JSON edits — when you
// re-open the form for an entity edited via JSON, you'll see the new shape.

/**
 * Open the JSON modal with a serialized object.
 * @param {string} title  - shown in the header
 * @param {Object} obj    - the entity record (storage shape)
 * @param {'strategy'|'fragment'|'assertion'} kind - which save channel to use
 */
// v2.74.478 — Locale graph viz: render the LOCALE_GRAPH response as an SVG node-link
// diagram (layers → features → goals, edges colored by kind) in a self-contained modal
// built entirely in JS with inline styles (so studio.html is untouched). The layout is
// the pure Core/graphLayout helper; this is just the draw + chrome (close / JSON / legend).
const _GRAPH_NODE_COLOR = {
  layer: '#a371f7', goal: '#3fb950',
  input: '#1f6feb', action: '#db61a2', navigation: '#388bfd',
  disclosure: '#d29922', collection: '#6e7681', region: '#484f58', composite: '#8957e5',
};
const _GRAPH_EDGE_COLOR = { reveals: '#d29922', contains: '#8b949e', enables: '#3fb950', partOf: '#58a6ff' };

function showGraphModal(archId, resp) {
  const L = layoutLocaleGraph({ nodes: resp?.nodes || [], edges: resp?.edges || [] });
  const labelPad = 180;
  const W = Math.max(L.width + labelPad, 360);
  const H = Math.max(L.height, 140);
  const colX = [100, 330, 560];   // mirrors graphLayout padX(100)+ci*colGap(230)
  const colHdr = ['LAYERS', 'FEATURES', 'GOALS'];

  let svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="font-family:inherit">`;
  colHdr.forEach((h, i) => { svg += `<text x="${colX[i]}" y="14" font-size="10" fill="#6e7681" text-anchor="middle" letter-spacing="1">${h}</text>`; });
  for (const e of L.edges) {
    svg += `<line x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" stroke="${_GRAPH_EDGE_COLOR[e.kind] || '#888'}" stroke-width="1.2" opacity="0.5"/>`;
  }
  for (const n of L.nodes) {
    const c = _GRAPH_NODE_COLOR[n.kind] || '#888';
    const anchor = n.col === 0 ? 'end' : 'start';
    const tx = n.col === 0 ? n.x - n.r - 5 : n.x + n.r + 5;
    const label = (n.label || n.kind || '').slice(0, 30);
    svg += `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${c}" stroke="#0d1117" stroke-width="1"><title>${escHtml(n.kind + ': ' + (n.label || ''))}</title></circle>`;
    svg += `<text x="${tx}" y="${n.y + 3.5}" font-size="11" fill="#c9d1d9" text-anchor="${anchor}">${escHtml(label)}</text>`;
  }
  svg += `</svg>`;

  const counts = resp?.counts || {};
  const edgeLegend = Object.entries(_GRAPH_EDGE_COLOR)
    .map(([k, col]) => `<span style="display:inline-flex;align-items:center;gap:4px;margin-right:10px"><span style="width:14px;height:2px;background:${col};display:inline-block"></span>${k}${counts[k] ? ` (${counts[k]})` : ''}</span>`).join('');

  // Achievement paths: how each goal is reached (depth-aware), with disclosure gating shown
  // as "(open ‹trigger›)" before a hidden control. Verb hints make the step sequence readable.
  const stepVerb = (kind) => kind === 'input' ? 'type' : (kind === 'navigation' ? 'go' : (kind === 'disclosure' ? 'open' : 'click'));
  const pathsHtml = (Array.isArray(resp?.goalPaths) && resp.goalPaths.length)
    ? `<div style="padding:8px 14px;border-top:1px solid #21262d;max-height:26vh;overflow:auto">
         <div style="font-size:10px;letter-spacing:1px;color:#6e7681;margin-bottom:6px">ACHIEVEMENT PATHS</div>
         ${resp.goalPaths.map((gp) => {
           const seenTrig = new Set();
           const steps = (gp.steps || []).map((s) => {
             let pre = '';
             if (s.trigger && !seenTrig.has(s.trigger)) { seenTrig.add(s.trigger); pre = `<span style="opacity:.6">open “${escHtml((s.triggerLabel || 'menu').slice(0, 24))}” ▸ </span>`; }
             return `${pre}<span title="${escHtml(s.kind || '')}">${stepVerb(s.kind)} “${escHtml((s.label || s.kind || '').slice(0, 28))}”</span>`;
           }).join('<span style="opacity:.4"> ▸ </span>');
           return `<div style="margin:3px 0;font-size:11px"><span style="color:#3fb950">★ ${escHtml(gp.label || '(goal)')}</span>${steps ? ` <span style="opacity:.5">—</span> ${steps}` : ' <span style="opacity:.5">(navigate only)</span>'}</div>`;
         }).join('')}
       </div>`
    : '';
  const leadsToTxt = counts.leadsTo
    ? ` · <span title="navigation links out of this page; ${resp.gaps || 0} lead to archetypes not yet modeled">leadsTo ${counts.leadsTo}${resp.gaps ? ` · ${resp.gaps} gap(s)` : ''}</span>`
    : '';
  const droppedTxt = L.dropped ? ` · <span title="leadsTo (cross-page) + collection→members are not drawn">${L.dropped} off-graph</span>` : '';

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(1,4,9,.72);z-index:10000;display:flex;align-items:center;justify-content:center';
  const panel = document.createElement('div');
  panel.style.cssText = 'background:#0d1117;border:1px solid #30363d;border-radius:8px;max-width:92vw;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.6);min-width:360px';
  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #21262d">
      <strong style="font-size:13px">Locale graph</strong>
      <span style="font-size:11px;opacity:.6;font-family:monospace">${escHtml(archId)}</span>
      <span style="flex:1"></span>
      <button data-g="json" class="btn-secondary tiny" title="View the raw graph data (edges + leadsTo reconciliation) as JSON">{ }</button>
      <button data-g="close" class="btn-secondary tiny" title="Close">✕</button>
    </div>
    <div style="overflow:auto;padding:10px 14px;flex:1">${L.nodes.length ? svg : '<div class="empty-state small">This Locale has no graph nodes yet.</div>'}</div>
    ${pathsHtml}
    <div style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 14px;border-top:1px solid #21262d;font-size:11px;opacity:.85">${edgeLegend}${leadsToTxt}${droppedTxt}</div>`;
  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (ev) => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('click', (ev) => { if (ev.target === overlay) close(); });
  panel.querySelector('[data-g="close"]').addEventListener('click', close);
  panel.querySelector('[data-g="json"]').addEventListener('click', () => {
    showJsonModal(`Locale graph: ${archId}`, { counts: resp.counts, gaps: resp.gaps, leadsTo: resp.leadsTo, nodes: resp.nodes, edges: resp.edges }, 'locale-graph');
  });
}

function showJsonModal(title, obj, kind) {
  const modal = $('json-modal');
  const titleEl = $('json-modal-title');
  const bodyEl  = $('json-modal-body');
  const errEl   = $('json-modal-error');
  if (!modal || !titleEl || !bodyEl) return;
  titleEl.textContent = title;
  // Pretty-print with 2-space indent. JSON.stringify naturally drops
  // undefined fields; the round-trip through textarea preserves the shape
  // we serialized.
  bodyEl.value = JSON.stringify(obj, null, 2);
  // v2.51.0 — store kind + original id on the modal so save can route correctly
  // and we can detect (and reject) id changes that would orphan references.
  modal.dataset.kind = kind ?? '';
  modal.dataset.originalId = obj?.id ?? '';
  const saveBtn = $('btn-json-modal-save');
  const readOnly = kind === 'sync-conflict';
  if (saveBtn) saveBtn.classList.toggle('hidden', readOnly);
  bodyEl.readOnly = readOnly;
  // Clear any prior error state
  if (errEl) {
    errEl.classList.add('hidden');
    errEl.textContent = '';
  }
  modal.classList.remove('hidden');
  // Focus the textarea so the user can edit immediately
  bodyEl.focus();
}

function hideJsonModal() {
  const modal = $('json-modal');
  const bodyEl = $('json-modal-body');
  const saveBtn = $('btn-json-modal-save');
  if (bodyEl) bodyEl.readOnly = false;
  if (saveBtn) saveBtn.classList.remove('hidden');
  if (modal) modal.classList.add('hidden');
}

function showJsonModalError(msg) {
  const errEl = $('json-modal-error');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.classList.remove('hidden');
}

/**
 * v2.51.0 — Save edits made in the JSON modal. Parse → validate per kind →
 * SAVE_X. Inline error on parse or validation failure; on save success,
 * close the modal and refresh the relevant studio list.
 */
async function saveJsonModalEdits() {
  const modal = $('json-modal');
  const bodyEl = $('json-modal-body');
  const errEl = $('json-modal-error');
  if (!modal || !bodyEl) return;

  const kind = modal.dataset.kind;
  const originalId = modal.dataset.originalId;
  const text = bodyEl.value ?? '';

  // Parse
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    showJsonModalError(`JSON parse error: ${e.message}`);
    return;
  }
  if (!parsed || typeof parsed !== 'object') {
    showJsonModalError('Top level must be an object.');
    return;
  }

  // Validate id stability — changing the id would orphan references to
  // this entity from elsewhere (strategies referencing fragmentIds, etc.)
  if (originalId && parsed.id !== originalId) {
    showJsonModalError(
      `id field cannot be changed (was "${originalId}", is "${parsed.id}"). ` +
      `Other entities may reference this id; renaming would break them.`
    );
    return;
  }

  // Validate per kind, then save via the matching message channel.
  let saveType, payloadKey;
  if (kind === 'strategy') {
    saveType   = 'SAVE_STRATEGY';
    payloadKey = 'strategy';
    if (typeof parsed.groundId !== 'string' || !parsed.groundId.trim()) {
      showJsonModalError('Strategy: groundId must be a non-empty string.');
      return;
    }
    if (!Array.isArray(parsed.fragmentSteps)) {
      showJsonModalError('Strategy: fragmentSteps must be an array.');
      return;
    }
    // v2.74.139 — Pass body-kind lookup so transform/template sieves
    // don't false-positive on source/output requirements. The studio's
    // _workflowsState.analyses is the cache.
    const v = validateStrategyBody(parsed.fragmentSteps, {
      getAnalysisBodyKind: (id) => {
        const a = _workflowsState.analyses?.find?.(x => x.id === id);
        const i0 = a && Array.isArray(a.implementations) && a.implementations.length > 0
          ? a.implementations[0] : null;
        if (!i0) return null;
        if (i0.tier === 'frontier') return 'frontier';
        return i0?.body?.kind ?? 'operations';
      },
    });
    if (v.errors && v.errors.length > 0) {
      showJsonModalError(`Validation: ${v.errors[0]}`);
      return;
    }
  } else if (kind === 'fragment') {
    saveType   = 'SAVE_FRAGMENT';
    payloadKey = 'fragment';
    // Fragments lack a deep structured validator; do basic shape checks.
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
      showJsonModalError('Fragment: name must be a non-empty string.');
      return;
    }
    if (typeof parsed.groundId !== 'string' || !parsed.groundId.trim()) {
      showJsonModalError('Fragment: groundId must be a non-empty string.');
      return;
    }
    if (typeof parsed.rawJson !== 'string') {
      showJsonModalError('Fragment: rawJson must be a string (JSON-encoded array of actions).');
      return;
    }
    try {
      const acts = JSON.parse(parsed.rawJson);
      if (!Array.isArray(acts)) {
        showJsonModalError('Fragment: rawJson must encode an array of actions.');
        return;
      }
    } catch (e) {
      showJsonModalError(`Fragment: rawJson is not valid JSON — ${e.message}`);
      return;
    }
  } else if (kind === 'assertion') {
    saveType   = 'SAVE_ASSERTION';
    payloadKey = 'assertion';
    if (typeof parsed.groundId !== 'string' || !parsed.groundId.trim()) {
      showJsonModalError('Assertion: groundId must be a non-empty string.');
      return;
    }
    if (!parsed.body || typeof parsed.body !== 'object') {
      showJsonModalError('Assertion: body must be an object with match + conditions.');
      return;
    }
    const v = validateAssertion(parsed.body, 'assertion');
    if (v.errors && v.errors.length > 0) {
      showJsonModalError(`Validation: ${v.errors[0]}`);
      return;
    }
  } else if (kind === 'workflow') {
    // Workflow entity — the top-level orchestration. UI label "Workflow"
    // matches the storage `kind: 'workflow'` discriminator since the
    // v2.74.142 relabel. JSON editing is the primary way to author
    // complex step fields (param bindings, FOREACH bodies, DETECT branch
    // conditions) until inline editors land. Validation here is
    // intentionally minimal — SAVE_WORKFLOW + normalizeStrategyParams
    // enforce the canonical shape at storage time.
    saveType   = 'SAVE_WORKFLOW';
    payloadKey = 'workflow';
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
      showJsonModalError('Workflow: name must be a non-empty string.');
      return;
    }
    if (parsed.steps != null && !Array.isArray(parsed.steps)) {
      showJsonModalError('Workflow: steps must be an array (or omitted).');
      return;
    }
  } else if (kind === 'analysis') {
    // v2.63.0 (Iteration B) — Analyses are viewable but not yet editable
    // through the JSON modal. SAVE_ANALYSIS message channel isn't wired in
    // background.js this iteration. Edit Analyses through the form instead.
    showJsonModalError('Analyses are read-only in this view. Use the form (✎) to edit.');
    return;
  } else if (kind === 'observation') {
    // v2.72.0 (Pass 3a) — Observations support JSON edit via the same modal.
    saveType   = 'SAVE_OBSERVATION';
    payloadKey = 'observation';

    // v2.72.11 (Pass 8) — Validate implementations shape if present, hoist
    // impl[0]'s extraction fields to top-level for the existing per-shape
    // validation. Storage migration on save re-canonicalizes either way,
    // so accepting both legacy and new shapes is forgiving.
    if (parsed.implementations != null) {
      if (!Array.isArray(parsed.implementations) || parsed.implementations.length === 0) {
        showJsonModalError('Observation: implementations must be a non-empty array.');
        return;
      }
      const impl0 = parsed.implementations[0];
      if (!impl0 || typeof impl0 !== 'object') {
        showJsonModalError('Observation: implementations[0] must be an object.');
        return;
      }
      if (impl0.tier !== 'cache' && impl0.tier !== 'frontier') {
        showJsonModalError(`Observation: implementations[0].tier must be 'cache' or 'frontier' (got ${JSON.stringify(impl0.tier)}).`);
        return;
      }
      // Hoist extraction fields to top-level for the per-shape validation.
      // After validation, the saved record is rebuilt by storage migration.
      if (impl0.target  !== undefined && parsed.target  === undefined) parsed.target  = impl0.target;
      if (impl0.extract !== undefined && parsed.extract === undefined) parsed.extract = impl0.extract;
      if (impl0.fields  !== undefined && parsed.fields  === undefined) parsed.fields  = impl0.fields;
    }

    if (typeof parsed.groundId !== 'string' || !parsed.groundId.trim()) {
      showJsonModalError('Observation: groundId must be a non-empty string.');
      return;
    }
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) {
      showJsonModalError('Observation: name must be a non-empty string.');
      return;
    }
    // v2.72.11 (Pass 8) — image/image_list reserved for frontier-tier (Pass 9).
    // v2.72.14 (Pass 6) — section/image_refs added to cache tier.
    const tier = parsed.implementations?.[0]?.tier ?? 'cache';
    const cacheShapes = ['scalar', 'list_of_records', 'raw_text', 'raw_html', 'section', 'image_refs'];
    const frontierShapes = ['image', 'image_list'];
    const validShapes = tier === 'frontier' ? frontierShapes : cacheShapes;
    if (!validShapes.includes(parsed.shape)) {
      showJsonModalError(`Observation: shape must be one of ${validShapes.join(', ')} for tier=${tier}.`);
      return;
    }
    if (typeof parsed.target !== 'string' || !parsed.target.trim()) {
      showJsonModalError('Observation: target must be a non-empty CSS selector string.');
      return;
    }
    if (typeof parsed.output !== 'string' || !parsed.output.trim()) {
      showJsonModalError('Observation: output must be a non-empty binding name.');
      return;
    }
    // v2.72.1 (Pass 3b) — list_of_records: validate fields array shape.
    if (parsed.shape === 'list_of_records') {
      if (!Array.isArray(parsed.fields) || parsed.fields.length === 0) {
        showJsonModalError('Observation: list_of_records needs a non-empty fields array.');
        return;
      }
      const seen = new Set();
      for (let i = 0; i < parsed.fields.length; i++) {
        const f = parsed.fields[i];
        if (!f || typeof f !== 'object') {
          showJsonModalError(`Observation: fields[${i}] must be an object.`);
          return;
        }
        if (typeof f.name !== 'string' || !f.name.trim()) {
          showJsonModalError(`Observation: fields[${i}].name is required.`);
          return;
        }
        if (typeof f.selector !== 'string' || !f.selector.trim()) {
          showJsonModalError(`Observation: fields[${i}].selector is required.`);
          return;
        }
        if (seen.has(f.name)) {
          showJsonModalError(`Observation: duplicate field name "${f.name}".`);
          return;
        }
        seen.add(f.name);
        if (f.extract && f.extract.kind === 'attribute' && !f.extract.name) {
          showJsonModalError(`Observation: fields[${i}].extract.name required for attribute extraction.`);
          return;
        }
      }
    }
    // v2.72.7 (Pass 3e) — params validation. If user supplied a `params`
    // array in JSON, ensure it's string[] of UPPERCASE_WITH_UNDERSCORES.
    // Then re-derive params from the actual {{NAME}} placeholders in the
    // record — the user's manual list is a hint but not authoritative.
    if (parsed.params != null) {
      if (!Array.isArray(parsed.params)) {
        showJsonModalError('Observation: params must be an array of strings if present.');
        return;
      }
      for (const p of parsed.params) {
        if (typeof p !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(p)) {
          showJsonModalError(`Observation: params entry "${p}" must be UPPERCASE_WITH_UNDERSCORES.`);
          return;
        }
      }
    }
    // Re-derive params from the record's actual selector/condition fields.
    // Authoritative — overrides whatever the user wrote into the JSON's
    // params field. Keeps storage canonical.
    parsed.params = detectObservationParams(parsed);
  } else {
    showJsonModalError(`Unknown entity kind: "${kind}". Cannot save.`);
    return;
  }

  // Bump updatedAt so the row's "edited X ago" display refreshes
  parsed.updatedAt = Date.now();

  // Send the save
  const res = await new Promise(r => chrome.runtime.sendMessage({
    type: saveType,
    payload: { [payloadKey]: parsed },
  }, r));

  if (!res?.success) {
    showJsonModalError(`Save failed: ${res?.error ?? 'unknown'}`);
    return;
  }

  toast(`${kind[0].toUpperCase()}${kind.slice(1)} saved`);
  hideJsonModal();

  // Refresh the studio's main list so the row shows the updated data.
  // refreshGroundList rebuilds fragments/strategies/assertions for every
  // ground; sufficient for any single-entity edit.
  refreshGroundList();
}

// Wire close + copy + save buttons (one-time, at module load)
$('btn-json-modal-close')?.addEventListener('click', hideJsonModal);
$('btn-json-modal-copy')?.addEventListener('click', async () => {
  const bodyEl = $('json-modal-body');
  if (!bodyEl) return;
  try {
    // Textareas use .value, not .textContent
    await navigator.clipboard.writeText(bodyEl.value ?? '');
    toast('JSON copied');
  } catch (e) {
    toast(`Copy failed: ${e?.message ?? 'unknown'}`, 'err');
  }
});
$('btn-json-modal-save')?.addEventListener('click', () => saveJsonModalEdits());
// Backdrop click closes modal — both the backdrop element and the explicit
// close button share data-action="json-modal-close".
document.addEventListener('click', (e) => {
  const target = e.target;
  if (target instanceof Element && target.dataset.action === 'json-modal-close') {
    hideJsonModal();
  }
});
// Escape key closes modal
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modal = $('json-modal');
    if (modal && !modal.classList.contains('hidden')) hideJsonModal();
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// v2.72.0 (Pass 3a) — Observation form / v2.72.2 (Pass 3c.0) — Live picker
// v2.72.34 (Pass 17d) — Both extracted to Studio/ObservationForm.js
// ═══════════════════════════════════════════════════════════════════════════
//
// Form lifecycle, per-shape rendering, pre/post conditions, save/validate,
// and the live-page selector picker all live in Studio/ObservationForm.js.
// Studio.js retains the Ground card's Observation library section (calls
// openObservationForm + the migration tool) and imports detectObservationParams
// for the JSON modal validator and migration tool.
//
// Note: libraryAssertionCache and libraryPerspectiveCache (which were dangling
// in studio.js after Pass 17c) are now properly file-local in the form
// module. They no longer exist as studio.js globals.

// ═══════════════════════════════════════════════════════════════════════════
// v2.72.6 (Pass 5) — Fragment → Observation migration tool
// ═══════════════════════════════════════════════════════════════════════════
//
// Some Fragments are extraction-only — a single ENUMERATE or EXTRACT, no
// CLICK/KEYBOARD/NAVIGATE. They're better expressed as Observations: the
// page→data direction belongs to the Observation primitive, not Fragment.
//
// This pass adds a "Migrate" button on each Fragment row that's eligible.
// Clicking opens a modal showing the proposed Observation. User edits name/
// output, sees field-name renames (camelCase → UPPERCASE_WITH_UNDERSCORES),
// and creates the Observation. The source Fragment is NOT deleted.
//
// Eligibility rules (v1):
//   - Single ENUMERATE action, no others    → list_of_records Observation
//   - Single EXTRACT action, no others      → scalar Observation
//   - Mixed actions or empty                → not eligible
//   - WAIT actions allowed alongside ENUMERATE/EXTRACT (translated to a
//     selector_present precondition for each, when WAIT has a selector)
//
// Multi-EXTRACT, EMIT, mixed extraction kinds — deferred to a later v2.

/**
 * Classify a Fragment for migration eligibility. Returns:
 *   { eligible: boolean, reason: string, kind?: 'enumerate'|'extract',
 *     action?: <the matched action>, waits?: [<wait-actions-with-selector>],
 *     fieldRenames?: [{from, to}] }
 *
 * `kind` is the destination Observation shape:
 *   'enumerate' → list_of_records
 *   'extract'   → scalar
 *
 * `waits` are WAIT actions with a selector field that should be translated
 * to selector_present preconditions on the Observation.
 *
 * `fieldRenames` tracks camelCase → UPPERCASE_WITH_UNDERSCORES transforms
 * applied to ENUMERATE field names. Used to surface the rename in UI.
 */
function classifyFragmentForMigration(fragment) {
  let actions;
  try {
    actions = JSON.parse(fragment.rawJson ?? '[]');
  } catch (err) {
    return { eligible: false, reason: `rawJson is not valid JSON: ${err.message}` };
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    return { eligible: false, reason: 'fragment has no actions' };
  }

  // Bucket actions: extraction (ENUMERATE/EXTRACT), waits with a selector
  // (translatable to preconditions), other (disqualifying).
  const extractions = [];
  const waits = [];
  const other = [];
  for (const a of actions) {
    const op = a?.action;
    if (op === 'ENUMERATE' || op === 'EXTRACT') {
      extractions.push(a);
    } else if (op === 'WAIT' && a?.selector) {
      // WAIT for selector — translate to selector_present precondition.
      waits.push(a);
    } else if (op === 'WAIT' || op === 'EMIT') {
      // Timed WAIT (no selector) and EMIT can't be cleanly migrated.
      other.push(a);
    } else {
      other.push(a);
    }
  }

  if (other.length > 0) {
    const sample = other[0]?.action ?? '?';
    return {
      eligible: false,
      reason: `fragment has non-extraction action(s) (e.g. ${sample}). Only ENUMERATE/EXTRACT (with optional WAIT-for-selector) can be migrated.`,
    };
  }
  if (extractions.length === 0) {
    return { eligible: false, reason: 'fragment has no ENUMERATE or EXTRACT action' };
  }
  if (extractions.length > 1) {
    return {
      eligible: false,
      reason: `fragment has ${extractions.length} extraction actions; v1 migration only supports single-extraction fragments`,
    };
  }

  const action = extractions[0];
  const kind = action.action === 'ENUMERATE' ? 'enumerate' : 'extract';

  // For ENUMERATE, build field-rename preview.
  let fieldRenames = [];
  if (kind === 'enumerate' && Array.isArray(action.fields)) {
    fieldRenames = action.fields.map(f => ({
      from: f.name ?? '',
      to:   _camelToUpperSnake(f.name ?? ''),
    }));
  }

  return { eligible: true, reason: 'eligible', kind, action, waits, fieldRenames };
}

/**
 * Convert camelCase or PascalCase to UPPERCASE_WITH_UNDERSCORES.
 * Examples: deviceName → DEVICE_NAME, lastCheckIn → LAST_CHECK_IN,
 * URL → URL, deviceID → DEVICE_ID.
 *
 * Algorithm:
 *   - Insert _ before any uppercase letter that follows a lowercase letter.
 *   - Insert _ before any uppercase letter that's followed by a lowercase
 *     letter, when preceded by another uppercase (handles "URLAddress" →
 *     "URL_Address").
 *   - Convert the whole thing to uppercase.
 *   - Collapse runs of _ and trim.
 *
 * Input that's already UPPERCASE_WITH_UNDERSCORES is returned unchanged.
 * Input with non-identifier chars is replaced with _ then collapsed.
 */
function _camelToUpperSnake(s) {
  if (!s) return '';
  if (/^[A-Z][A-Z0-9_]*$/.test(s)) return s;  // already conforming
  let out = String(s)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toUpperCase();
  // Collapse multiple _; trim leading/trailing.
  out = out.replace(/_+/g, '_').replace(/^_|_$/g, '');
  // If first char is a digit, prefix with _ (output binding regex requires
  // letter start). E.g. "2nd_choice" → "_2ND_CHOICE".
  if (/^\d/.test(out)) out = '_' + out;
  return out;
}

/**
 * Build a fresh Observation record from a classified Fragment.
 * The returned record has a NEW id; never touches the source Fragment.
 *
 * `classification` is the truthy result of classifyFragmentForMigration.
 * Preconditions: WAITs with selectors become selector_present conditions.
 */
function buildObservationFromFragment(fragment, classification) {
  const id = `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const action = classification.action;
  const description = fragment.description
    ? `Migrated from Fragment "${fragment.name ?? fragment.id}". ${fragment.description}`
    : `Migrated from Fragment "${fragment.name ?? fragment.id}".`;

  // Build preconditions from WAIT-with-selector actions.
  const preconditions = (classification.waits ?? []).map(w => ({
    type: 'selector_present',
    selector: w.selector,
  }));

  if (classification.kind === 'enumerate') {
    return {
      id,
      groundId: fragment.groundId,
      name: fragment.name ?? '',
      description,
      shape: 'list_of_records',
      output: action.target ?? '',
      target: action.selector ?? '',
      fields: (Array.isArray(action.fields) ? action.fields : []).map(f => {
        // ENUMERATE field types: 'string', 'number', 'presence', 'attribute:NAME'.
        // Observation v1 supports text and attribute extraction. number/presence
        // collapse to text — the value is captured as the element's textContent
        // and the user's DataAssertion post can coerce/check (e.g. scalar_is_number).
        const t = String(f.type ?? 'string');
        let extract;
        if (t.startsWith('attribute:')) {
          extract = { kind: 'attribute', name: t.slice('attribute:'.length) };
        } else {
          extract = { kind: 'text' };
        }
        return {
          name    : _camelToUpperSnake(f.name ?? ''),
          selector: f.source ?? '',
          extract,
        };
      }),
      preconditions,
      postconditions: [],
    };
  }

  // EXTRACT → text or attribute (v2.74.131 — was `shape: 'scalar'` with
  // extract.kind discriminator; now split into separate shape ids).
  const isAttribute = action.attribute && action.attribute !== 'text';
  const base = {
    id,
    groundId: fragment.groundId,
    name: fragment.name ?? '',
    description,
    output: action.target ?? '',
    target: action.selector ?? '',
    preconditions,
    postconditions: [],
  };
  return isAttribute
    ? { ...base, shape: 'attribute', attribute: action.attribute }
    : { ...base, shape: 'text' };
}

// v2.72.83 — countStrategyRefsToFragment + countStrategyRefsToObservation
// moved to Studio/StrategyForm.js (Pass 1). Imported by the migrate-
// observation handler at line 579 area and the delete-fragment cleanup
// flow further down.

/**
 * Open the migration modal for a Fragment. Builds the proposed Observation,
 * shows it as an editable preview, lets the user save.
 */
async function openMigrationModal(groundId, fragmentId) {
  // Defensive: remove any prior migration modal before opening a new one.
  document.querySelector('.migration-modal-overlay')?.remove();

  const fragment = await StorageManager.getFragment(fragmentId);
  if (!fragment) { toast('Fragment not found', 'err'); return; }

  const classification = classifyFragmentForMigration(fragment);
  if (!classification.eligible) {
    toast(`Not eligible: ${classification.reason}`, 'warn');
    return;
  }

  const proposed = buildObservationFromFragment(fragment, classification);
  const refCount = await countStrategyRefsToFragment(groundId, fragmentId);

  // Build the modal HTML. Inline so the Observation form doesn't have to
  // grow to accommodate a "migrate" mode.
  const overlay = document.createElement('div');
  overlay.className = 'migration-modal-overlay';

  const renames = (classification.fieldRenames ?? []).filter(r => r.from !== r.to);

  // v2.72.10 (bug review) — Compute rename validity. _camelToUpperSnake
  // can produce names that fail the UPPERCASE_WITH_UNDERSCORES regex
  // (e.g. "123-foo" → "_123_FOO" with leading underscore). Surface those
  // upfront so the user understands why Create is blocked.
  const NAME_RE = /^[A-Z][A-Z0-9_]*$/;
  const invalidRenames = renames.filter(r => !NAME_RE.test(r.to));
  const hasInvalid = invalidRenames.length > 0;

  overlay.innerHTML = `
    <div class="migration-modal">
      <div class="migration-modal-head">
        <span class="migration-modal-title">Migrate Fragment to Observation</span>
        <button class="btn-action migration-modal-close" type="button" title="Cancel">×</button>
      </div>

      <div class="migration-modal-body">
        <p class="migration-modal-source">
          From: <strong>${escHtml(fragment.name ?? fragment.id)}</strong>
          <span class="migration-modal-kind">→ ${classification.kind === 'enumerate' ? 'list_of_records' : 'scalar'} Observation</span>
        </p>

        ${renames.length > 0 ? `
          <div class="migration-modal-renames">
            <div class="migration-modal-renames-title">Field name renames (UPPERCASE_WITH_UNDERSCORES convention):</div>
            <ul class="migration-modal-renames-list">
              ${renames.map(r => {
                const ok = NAME_RE.test(r.to);
                return `<li>
                  <code>${escHtml(r.from)}</code> → <code class="${ok ? '' : 'migration-rename-invalid'}">${escHtml(r.to)}</code>
                  ${ok ? '' : ' <span class="migration-rename-warning">⚠ invalid name; please rename the source field manually before migrating</span>'}
                </li>`;
              }).join('')}
            </ul>
          </div>` : ''}

        ${classification.waits?.length > 0 ? `
          <div class="migration-modal-waits">
            <div class="migration-modal-waits-title">WAIT actions translated to preconditions:</div>
            <ul>
              ${classification.waits.map(w => `<li><code>WAIT ${escHtml(w.selector)}</code> → <code>selector_present</code> precondition</li>`).join('')}
            </ul>
          </div>` : ''}

        <div class="migration-modal-fields">
          <label>Observation name
            <input type="text" id="migration-input-name" maxlength="80" value="${escAttr(proposed.name)}" />
          </label>
          <label>Output binding
            <input type="text" id="migration-input-output" maxlength="60" value="${escAttr(proposed.output)}" />
            <span class="field-hint">UPPERCASE_WITH_UNDERSCORES (e.g. JOB_ROWS, PAGE_TITLE)</span>
          </label>
          <label>Target selector
            <input type="text" id="migration-input-target" value="${escAttr(proposed.target)}" />
          </label>
        </div>

        <details class="migration-modal-preview">
          <summary>Preview the full Observation record</summary>
          <pre class="migration-modal-pre" id="migration-preview-pre">${escHtml(JSON.stringify(proposed, null, 2))}</pre>
        </details>

        ${refCount > 0 ? `
          <div class="migration-modal-refs">
            <strong>⚠ ${refCount} ${refCount === 1 ? 'Strategy' : 'Strategies'}</strong> still reference this Fragment.
            Migration creates a new Observation; it does NOT delete the Fragment or rewrite Strategies.
            You'll need to update those Strategies to use the new Observation manually.
          </div>` : ''}

        <div class="migration-modal-note">
          The source Fragment will <strong>not</strong> be deleted. You can delete it manually after
          updating any Strategies that reference it.
        </div>
      </div>

      <div class="migration-modal-actions">
        <button class="btn-secondary" id="btn-migration-cancel" type="button">Cancel</button>
        <button class="btn-primary" id="btn-migration-create" type="button"
                ${hasInvalid ? 'disabled title="Fix the field name(s) flagged as invalid in the source Fragment first"' : ''}>Create Observation</button>
      </div>
    </div>`;

  document.body.appendChild(overlay);

  const cleanup = () => overlay.remove();

  // Live-update preview when name/output/target change. Cheap re-stringify.
  const refreshPreview = () => {
    proposed.name   = $('migration-input-name').value;
    proposed.output = $('migration-input-output').value;
    proposed.target = $('migration-input-target').value;
    $('migration-preview-pre').textContent = JSON.stringify(proposed, null, 2);
  };
  ['migration-input-name', 'migration-input-output', 'migration-input-target'].forEach(id => {
    $(id)?.addEventListener('input', refreshPreview);
  });

  overlay.querySelector('.migration-modal-close')?.addEventListener('click', cleanup);
  $('btn-migration-cancel')?.addEventListener('click', cleanup);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cleanup();
  });

  $('btn-migration-create')?.addEventListener('click', async () => {
    refreshPreview();   // capture latest edits
    // v2.72.10 (bug review) — Delegate to shared validator so migration
    // applies the same field-level checks as form save. Without this,
    // edge cases like _camelToUpperSnake producing a leading-underscore
    // name slip through and reach storage.
    const err = validateObservationRecord(proposed);
    if (err) { toast(err, 'err'); return; }

    // v2.72.7 (Pass 3e) — Auto-detect params on the migrated record. Most
    // migrations from ENUMERATE/EXTRACT-only Fragments produce no params,
    // but any {{NAME}} in source selectors carries through and should be
    // surfaced as a param.
    proposed.params = detectObservationParams(proposed);

    const res = await new Promise(r => chrome.runtime.sendMessage({
      type: 'SAVE_OBSERVATION', payload: { observation: proposed },
    }, r));
    if (!res?.success) {
      toast(`Migration failed: ${res?.error ?? 'unknown'}`, 'err');
      return;
    }
    toast(`Created Observation "${proposed.name}". Source Fragment was kept — delete it manually after updating Strategies.`, 'ok');
    cleanup();
    refreshGroundList();
  });
}

// ─── v2.72.32 (Pass 17b) — Module-level setup for extracted forms ───────
//
// Forms moved to Studio/*.js need their button handlers wired and any
// callbacks (like refreshGroundList) plumbed through. Setup runs once at
// script load; the DOM is ready because studio.html loads studio.js after
// the form markup.
setupPerspectiveForm({ refreshGroundList });

// v2.72.33 (Pass 17c) — AssertionForm needs the shared editor surface
// (renderConditionEditor, decodeConditionTypeValue, emptyCondition)
// injected at setup time. These are studio.js-internal functions; the
// form module imports them indirectly via the setup callback rather than
// reaching back into studio.js (which would create a circular import).
setupAssertionForm({
  refreshGroundList,
  renderConditionEditor,
  decodeConditionTypeValue,
  emptyCondition,
});

// v2.72.34 (Pass 17d) — ObservationForm needs the same shared editor
// surface plus buildConditionTypeOptions for its post-condition rows.
setupObservationForm({
  refreshGroundList,
  renderConditionEditor,
  decodeConditionTypeValue,
  buildConditionTypeOptions,
});

// v2.72.35 (Pass 17e) — AnalysisForm needs buildConditionTypeOptions +
// decodeConditionTypeValue for its scope-only condition rows.
// v2.72.36 (Pass 17f) — checkAssertionRefFamilies removed from this
// injection list; AnalysisForm now imports it directly from
// Studio/assertionFamilyCheck.js (along with FragmentForm, which uses it
// for the same family-compat check on fragment review save).
setupAnalysisForm({
  refreshGroundList,
  buildConditionTypeOptions,
  decodeConditionTypeValue,
});

// v2.72.36 (Pass 17f) — FragmentForm uses renderConditionEditor +
// decodeConditionTypeValue for the review panel pre/post editor.
// checkAssertionRefFamilies is imported directly inside the form module.
setupFragmentForm({
  refreshGroundList,
  renderConditionEditor,
  decodeConditionTypeValue,
});

// v2.72.83+ — StrategyForm setup. After Pass 4-f Phase 2 state migration,
// the form module owns its state as module-locals. setupStrategyForm now
// only injects shared utilities defined in studio.js.
//
// Queued post-Pass-4: renderConditionEditor / buildConditionTypeOptions /
// decodeConditionTypeValue are used by 4 form modules. Extract to a shared
// module (e.g. Services/ConditionEditor.js) so all 4 modules can import
// directly and these last 3 injections drop. addWarningIcon and
// refreshGroundList are studio.js-resident concerns and stay here.
setupStrategyForm({
  buildConditionTypeOptions,
  decodeConditionTypeValue,
  addWarningIcon,
  refreshGroundList,
  renderConditionEditor,
});

// v2.72.97 (Pass 4-b) — wire the result-template live-update input. The
// previous bare top-level addEventListener block moved into this init
// function inside StrategyForm.js.
wireStrategyTopLevelInputs();
// v2.73.2 (Pass 4-f Phase 2) — save handler now lives in StrategyForm.js
// and is wired by this init function. Called once.
wireStrategySaveHandler();


// v2.72.37 (Pass 17 review) — Initial load. This call was originally at
// the end of the EXTRACT section in studio.js (post-Pass-E1). It got
// pulled into FragmentForm.js during Pass 17f extraction, where it
// resolved to an undefined identifier and the initial Ground-list
// render silently failed. Restored to studio.js where it belongs.
refreshGroundList();

// v2.74.69 — Workflows tab is the default-active tab now, so populate it
// at boot. Both initial-loads fire in parallel — they read disjoint storage
// indexes so there's no contention.
setupWorkflowsTab();
refreshWorkflows();
