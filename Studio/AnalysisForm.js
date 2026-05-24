/**
 * @file Studio/AnalysisForm.js
 * @description Analysis primitive authoring form. Analyses are scope→scope
 * primitives that operate over a synthetic input scope (typically a
 * collection bound from upstream) and produce a synthetic output scope.
 *
 * Two body kinds (cache tier):
 *   - operations  : JSON array of operation steps (filter, count, derive,
 *                   rank, etc.). Authored via raw JSON for now; future
 *                   versions may add a structured builder.
 *   - template    : prose template with {{INPUT}} / {{NAMED_INPUT}}
 *                   substitution (Pass 7b/7c). Has declared inputs for
 *                   compose-mode authoring.
 *
 * Plus frontier tier (Pass 9+): LLM-driven analysis with a prose
 * description as the primary instruction.
 *
 * Pre/post conditions are scope-only (allowedFamilies=['scope']) — they
 * assert shape on the input/output bindings, not page state. Perspectives and
 * page-family assertions don't apply here.
 *
 * ── Module shape ──────────────────────────────────────────────────────
 *
 * Internal state (file-local):
 *   - analysisDraft           : in-progress Analysis
 *   - analysisAssertionCache  : library assertions on this Ground
 *
 * Exported entry points:
 *   - openAnalysisForm(groundId, analysisId | null) : show form
 *   - closeAnalysisForm()                           : close (also exported
 *                                                     for symmetry)
 *   - deleteAnalysis(analysisId)                    : delete with confirm
 *   - setupAnalysisForm({ refreshGroundList,
 *                         buildConditionTypeOptions,
 *                         decodeConditionTypeValue,
 *                       }) : one-time wiring
 *
 * Dependencies (direct imports):
 *   - StorageManager       : Analysis CRUD
 *   - shared.js helpers    : $, escAttr, escHtml, toast
 *   - Services/Assertion   : CONDITION_FIELDS, emptyCondition
 *   - Services/DataAssertion : DATA_CONDITION_FIELDS, emptyDataCondition,
 *                              validateDataConditionList
 *   - Services/BuiltinAnalyses : isBuiltinAnalysisId
 *   - Services/TemplateEngine : parseTemplate, collectTemplateReferences
 *
 * Setup-time injections (studio.js-internal editor surface):
 *   - buildConditionTypeOptions / decodeConditionTypeValue — shared editor
 *   - refreshGroundList — host's refresh callback
 *
 * Note: The Analysis form does NOT use renderConditionEditor — it has its
 * own row renderer (renderAnalysisConditionRow) specialized to scope-only
 * conditions and the analysis-specific binding semantics (INPUT/OUTPUT
 * implicit, named bindings for template body).
 *
 * Extracted from studio.js (Pass 17e) following the PerspectiveForm /
 * AssertionForm / ObservationForm pattern.
 *
 * @module Studio/AnalysisForm
 * @author Agent HUB
 * @version 2.72.35
 */

import { StorageManager } from '../Services/StorageManager.js';
import { $, escAttr, escHtml, toast } from '../shared.js';
import { CONDITION_FIELDS, emptyCondition } from '../Services/Assertion.js';
import {
  DATA_CONDITION_FIELDS, emptyDataCondition, validateDataConditionList,
} from '../Services/DataAssertion.js';
import { isBuiltinAnalysisId } from '../Services/BuiltinAnalyses.js';
import { parseTemplate, collectTemplateReferences } from '../Services/TemplateEngine.js';
import { validateTransformBody } from '../Services/TransformOps.js';
import { checkAssertionRefFamilies } from './assertionFamilyCheck.js';

// ─── Setup-time injections ──────────────────────────────────────────────

let _refreshGroundList = null;
let _buildConditionTypeOptions = null;
let _decodeConditionTypeValue = null;

let analysisDraft = null;

// v2.70.3 — Assertion cache for the Analysis form's assertion_ref picker.
// Populated in openAnalysisForm by loading the ground's library assertions;
// cleared in closeAnalysisForm. Lets the Analysis pre/post editor render a
// "named assertion" option in the type dropdown and a picker over the
// ground's library assertions. Family-compat (scope-only) is enforced at
// save time, not at picker time — authors see the full list and get a
// descriptive error if they pick a page-only assertion.
let analysisAssertionCache = [];

export async function openAnalysisForm(groundId, analysisId) {
  const card = $('analysis-form-card');
  const title = $('analysis-form-title');
  const groundLabel = $('analysis-form-ground-label');
  if (!card || !title || !groundLabel) {
    toast('Analysis form is not in the DOM — something is wrong with studio.html', 'err');
    return;
  }

  const ground = await StorageManager.getGround(groundId);
  if (!ground) {
    toast('Ground not found', 'err');
    return;
  }
  groundLabel.textContent = `on Ground: ${ground.name ?? '(unnamed)'}`;

  // v2.70.3 — Load library assertions for the assertion_ref picker.
  // List is small per ground; cheap to refresh on each form open.
  try {
    analysisAssertionCache = await StorageManager.listAssertions(groundId);
  } catch (_) {
    analysisAssertionCache = [];
  }

  if (analysisId) {
    // Built-ins are read-only; should never reach this branch from the UI
    // (no edit button surfaced for built-ins) but guard anyway.
    if (isBuiltinAnalysisId(analysisId)) {
      toast('Built-in Analyses are read-only', 'warn');
      return;
    }
    const existing = await StorageManager.getAnalysis(analysisId);
    if (!existing) {
      toast('Analysis not found', 'err');
      return;
    }
    analysisDraft = (() => {
      const impl0 = Array.isArray(existing.implementations) && existing.implementations.length > 0
        ? existing.implementations[0]
        : null;
      // v2.72.18 (Pass 7b) — Detect body kind. Template-body Analyses load
      // template + inputs; operations-body load operations array (existing
      // path). Frontier-tier has no body so bodyKind stays null.
      const tier = impl0?.tier ?? 'cache';
      const bodyKind = (tier === 'cache')
        ? (impl0?.body?.kind ?? 'operations')   // operations as default for pre-7a records
        : null;
      // Operations-style fields. Defensive fallback chain for records that
      // bypassed migration. Empty array if this is a template-body record.
      const ops = (() => {
        if (bodyKind !== 'operations') return [];
        if (Array.isArray(impl0?.body?.operations)) return impl0.body.operations;
        if (Array.isArray(impl0?.operations))       return impl0.operations;
        if (Array.isArray(existing.operations))     return existing.operations;
        return [];
      })();
      // Template-style fields. Empty if this is an operations-body record.
      const tmpl = (bodyKind === 'template' && typeof impl0?.body?.template === 'string')
        ? impl0.body.template : '';
      const inputs = (bodyKind === 'template' && Array.isArray(impl0?.body?.inputs))
        ? impl0.body.inputs.map(i => ({
            name: i?.name ?? '',
            expects: i?.expects ?? 'scalar',
            ...(i?.itemKind ? { itemKind: i.itemKind } : {}),
          }))
        : [];
      // v2.74.133 — Transform body envelope. Stored under
      // impl0.body when bodyKind === 'transform'. Editor surfaces the
      // whole envelope as JSON for v1; structured editor in a follow-up.
      const transform = (bodyKind === 'transform' && impl0?.body && typeof impl0.body === 'object')
        ? {
            inputs:  Array.isArray(impl0.body.inputs)  ? impl0.body.inputs  : [],
            ops:     Array.isArray(impl0.body.ops)     ? impl0.body.ops     : [],
            outputs: Array.isArray(impl0.body.outputs) ? impl0.body.outputs : [],
          }
        : { inputs: [], ops: [], outputs: [] };
      return {
        id: existing.id,
        groundId: existing.groundId,
        name: existing.name ?? '',
        description: existing.description ?? '',
        params: Array.isArray(existing.params) ? [...existing.params] : [],
        operations: ops,
        // v2.72.18 (Pass 7b) — template-body fields. Empty for operations-body.
        template: tmpl,
        inputs,
        // v2.74.133 — transform-body envelope. Stays as a plain
        // {inputs, ops, outputs} object on the draft; save serializes
        // it under impl0.body when bodyKind === 'transform'.
        transform,
        // v2.64.0 (Pass 1) — pre/post conditions on the Analysis. Load
        // existing arrays or default empty.
        // v2.64.1 — Auto-correct binding values for operations/frontier
        // body kinds (force pre→INPUT, post→OUTPUT — synth scope sentinels).
        // v2.70.0 — Pre/post are now assertion envelopes ({match, conditions});
        // the editor still works on flat arrays internally for simpler row
        // rendering. Extract .conditions for editing; preserve match/count
        // on the draft so saveAnalysis can re-wrap correctly.
        // v2.70.3 — Skip assertion_ref entries; they don't carry a binding field.
        // v2.72.20 (Pass 7c) — Template body: preconditions keep their
        // author-specified binding (referencing declared inputs by name);
        // post still forces OUTPUT (synth scope sentinel for the bound
        // document). Authors who upgraded a pre-7c template Analysis with
        // pre conditions get the legacy binding=INPUT; they'll need to
        // edit it to reference an actual input.
        // v2.72.23 — Frontier tier: preconditions preserve author-specified
        // non-INPUT bindings (compose mode); INPUT bindings stay INPUT.
        // Cache-tier operations still force INPUT (single-source semantics).
        preconditions: ((existing.preconditions?.conditions ?? (Array.isArray(existing.preconditions) ? existing.preconditions : [])) || [])
          .map(c => {
            if (c.type === 'assertion_ref') return c;
            // Template body: preserve binding as-stored.
            if (bodyKind === 'template') return c;
            // v2.74.133 — Transform body: preserve binding as-stored
            // (references declared inputs by name, same shape as template).
            if (bodyKind === 'transform') return c;
            // Frontier tier: preserve non-INPUT bindings; default INPUT for
            // empty/missing.
            if (tier === 'frontier') {
              const b = (c.binding ?? '').toString().trim();
              if (!b || b === 'INPUT') return { ...c, binding: 'INPUT' };
              return { ...c, binding: b };
            }
            // Cache-tier operations: force INPUT.
            return { ...c, binding: 'INPUT' };
          }),
        preMatch: existing.preconditions?.match ?? 'all',
        preCount: existing.preconditions?.count,
        // v2.74.133 — Transform body: postconditions reference declared
        // output names, preserve as-stored. Other body kinds force OUTPUT.
        postconditions: ((existing.postconditions?.conditions ?? (Array.isArray(existing.postconditions) ? existing.postconditions : [])) || [])
          .map(c => {
            if (c.type === 'assertion_ref') return c;
            if (bodyKind === 'transform') return c;
            return { ...c, binding: 'OUTPUT' };
          }),
        postMatch: existing.postconditions?.match ?? 'all',
        postCount: existing.postconditions?.count,
        autoRecover: existing.autoRecover === true,
        tier,
        bodyKind,
      };
    })();
    title.textContent = 'Edit Analysis';
  } else {
    analysisDraft = {
      id: `analysis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      groundId: ground.id,
      name: '',
      description: '',
      params: [],
      operations: [],
      // v2.72.18 (Pass 7b) — template-body fields, default empty.
      template: '',
      inputs: [],
      // v2.74.133 — transform-body envelope, default empty skeleton.
      transform: { inputs: [], ops: [], outputs: [] },
      preconditions: [],
      preMatch: 'all',
      preCount: undefined,
      postconditions: [],
      postMatch: 'all',
      postCount: undefined,
      autoRecover: false,
      // v2.68.0 — New Analyses start with tier=null. The gating UI is
      // visible until the user picks. Save is disabled until set.
      tier: null,
      // v2.72.18 (Pass 7b) — bodyKind starts null too. Cache-tier users
      // pick at the sub-gate; frontier-tier users skip body-kind entirely.
      bodyKind: null,
    };
    title.textContent = 'New Analysis';
  }

  renderAnalysisFormForTier();

  // Pre-fill inputs (these only apply when tier is set; renderAnalysisFormForTier
  // hides the cache-only fields when tier === 'frontier').
  const nameInput = $('input-analysis-name');
  const descInput = $('input-analysis-description');
  if (!nameInput || !descInput) {
    toast('Form inputs missing from DOM', 'err');
    return;
  }
  nameInput.value = analysisDraft.name;
  descInput.value = analysisDraft.description;
  if ($('input-analysis-operations')) {
    $('input-analysis-operations').value = analysisDraft.operations.length > 0
      ? JSON.stringify(analysisDraft.operations, null, 2)
      : '';
  }
  // v2.72.18 (Pass 7b) — template-body fields. Populated regardless of
  // current body kind; visibility gates whether they're shown.
  if ($('input-analysis-template')) {
    $('input-analysis-template').value = analysisDraft.template ?? '';
  }
  // v2.74.133 — Transform body JSON populated regardless of current
  // body kind; visibility gates whether it's shown.
  if ($('input-analysis-transform')) {
    const xform = analysisDraft.transform ?? { inputs: [], ops: [], outputs: [] };
    $('input-analysis-transform').value = (xform.inputs?.length || xform.ops?.length || xform.outputs?.length)
      ? JSON.stringify(xform, null, 2)
      : '';
  }
  renderAnalysisInputs();
  if ($('input-analysis-auto-recover')) {
    $('input-analysis-auto-recover').checked = analysisDraft.autoRecover;
  }

  renderAnalysisParamsPreview();
  renderAnalysisConditions('pre');
  renderAnalysisConditions('post');

  card.classList.remove('hidden');

  // v2.69.0 — Explicit scrollIntoView. The other +Add forms scroll into
  // view because focus on their first input triggers browser auto-scroll.
  // Analysis can have its name input hidden when tier=null (gating UI),
  // so focus alone doesn't scroll. Be explicit.
  card.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // v2.69.0 — Tier-aware focus. When gating is showing (tier=null), the
  // name input is hidden; focus the cache button instead (first visible
  // interactive element). When tier is set, focus the name input.
  // v2.72.18 (Pass 7b) — Body-kind aware too: cache tier with no body
  // kind shows body-kind gating; focus the first body-kind button.
  if (analysisDraft.tier === null) {
    $('btn-tier-cache')?.focus();
  } else if (analysisDraft.tier === 'cache' && analysisDraft.bodyKind === null) {
    $('btn-body-kind-operations')?.focus();
  } else {
    nameInput.focus();
  }
}

export function closeAnalysisForm() {
  $('analysis-form-card').classList.add('hidden');
  analysisDraft = null;
  analysisAssertionCache = [];
}

/**
 * v2.68.0 (Pass 3c) — Render the Analysis form according to the draft's
 * tier value.
 *
 * Three states:
 *   - tier === null (new Analysis, not yet picked): gating section visible,
 *     name/description/operations/conditions hidden, save disabled.
 *   - tier === 'cache': gating hidden, indicator visible ("Tier: Cache"),
 *     operations editor + autoRecover toggle visible, frontier note hidden.
 *   - tier === 'frontier': gating hidden, indicator visible ("Tier: Frontier"),
 *     operations editor + autoRecover toggle hidden, frontier note visible.
 *
 * Tier-shared fields (name, description, params preview, pre/post sections,
 * cancel/save buttons) stay visible whenever any tier is set.
 */
function renderAnalysisFormForTier() {
  if (!analysisDraft) return;

  const gating = $('analysis-tier-gating');
  const indicator = $('analysis-tier-indicator');
  const indicatorValue = $('analysis-tier-indicator-value');
  const bodyKindGating = $('analysis-body-kind-gating');
  const bodyKindIndicator = $('analysis-body-kind-indicator');
  const bodyKindIndicatorValue = $('analysis-body-kind-indicator-value');
  const operationsSection = $('analysis-operations-section');
  const templateSection = $('analysis-template-section');
  // v2.74.133 — Transform body editor section.
  const transformSection = $('analysis-transform-section');
  const frontierNote = $('analysis-frontier-note');
  const autoRecoverSection = $('analysis-auto-recover-section');
  const saveBtn = $('btn-save-analysis');

  // v2.72.18 (Pass 7b) — State machine:
  //   tier=null            → tier gating shown
  //   tier=frontier        → tier indicator; frontier note; save enabled
  //   tier=cache, kind=null   → tier indicator; body-kind gating shown
  //   tier=cache, kind=ops    → tier+kind indicators; operations section
  //   tier=cache, kind=tmpl   → tier+kind indicators; template section
  // Shared form fields (name/description/pre/post/auto-recover/save row)
  // appear once a complete state is reached: tier is set, and if cache,
  // body kind is also set.
  const tier = analysisDraft.tier;
  const bodyKind = analysisDraft.bodyKind ?? null;
  const isCacheNeedingBodyKind = (tier === 'cache' && bodyKind === null);
  const showShared = (tier !== null && !isCacheNeedingBodyKind);

  const sharedFieldIds = [
    'input-analysis-name',
    'input-analysis-description',
    'analysis-params-preview',
    'analysis-pre-section',
    'analysis-post-section',
  ];

  // Tier gating (shown when tier null).
  if (gating) gating.classList.toggle('hidden', tier !== null);

  // Tier indicator (shown when tier set).
  if (indicator) indicator.classList.toggle('hidden', tier === null);
  if (indicatorValue && tier) {
    indicatorValue.textContent = tier === 'cache' ? 'Cache (Rule-based)' : 'Frontier (Model-based)';
  }

  // Body-kind gating (cache-tier-only, when kind not yet picked).
  if (bodyKindGating) bodyKindGating.classList.toggle('hidden', !isCacheNeedingBodyKind);

  // Body-kind indicator (cache-tier-only, when kind picked).
  if (bodyKindIndicator) {
    bodyKindIndicator.classList.toggle('hidden', !(tier === 'cache' && bodyKind !== null));
  }
  if (bodyKindIndicatorValue && bodyKind) {
    // v2.74.133 — Add transform label.
    bodyKindIndicatorValue.textContent =
      bodyKind === 'operations' ? 'Operations (filter / sort / take pipeline)'
      : bodyKind === 'template' ? 'Template (Mustache-lite composer)'
      : bodyKind === 'transform' ? 'Transform (named-binding value pipeline)'
      : bodyKind;
  }

  // Shared form fields.
  for (const id of sharedFieldIds) {
    const el = $(id);
    if (!el) continue;
    const container = el.closest('label') ?? el;
    container.classList.toggle('hidden', !showShared);
  }

  // Body-section visibility — gated on tier=cache AND respective body kind.
  if (operationsSection) operationsSection.classList.toggle('hidden', !(tier === 'cache' && bodyKind === 'operations'));
  if (templateSection)   templateSection.classList.toggle('hidden',   !(tier === 'cache' && bodyKind === 'template'));
  // v2.74.133 — Transform body editor visibility.
  if (transformSection)  transformSection.classList.toggle('hidden',  !(tier === 'cache' && bodyKind === 'transform'));

  // Auto-recover row: cache tier only (regardless of body kind).
  // Auto-recover row: cache tier + operations body only. Template body
  // has no escalation path defined; frontier has no contract failure path
  // that auto-recover would help with.
  if (autoRecoverSection) {
    autoRecoverSection.classList.toggle('hidden',
      !(showShared && tier === 'cache' && bodyKind === 'operations'));
  }

  // Frontier note: frontier tier only.
  if (frontierNote) frontierNote.classList.toggle('hidden', tier !== 'frontier');

  // Form actions row (cancel/save).
  const formActions = $('btn-cancel-analysis')?.parentElement;
  if (formActions) formActions.classList.toggle('hidden', !showShared);

  // Save disabled until state is complete.
  if (saveBtn) saveBtn.disabled = !showShared;
}

/**
 * Walk an operations array (array of objects, possibly nested) and collect
 * every {{NAME}} placeholder seen in any string-typed value. Returns sorted
 * unique param names.
 */
function extractAnalysisParams(operations) {
  const found = new Set();
  const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
  const visit = (val) => {
    if (val == null) return;
    if (typeof val === 'string') {
      let m;
      while ((m = PLACEHOLDER_RE.exec(val)) !== null) found.add(m[1]);
    } else if (Array.isArray(val)) {
      for (const v of val) visit(v);
    } else if (typeof val === 'object') {
      for (const v of Object.values(val)) visit(v);
    }
  };
  visit(operations);
  return [...found].sort();
}

function renderAnalysisParamsPreview() {
  const container = $('analysis-params-preview');
  if (!container || !analysisDraft) return;
  const params = analysisDraft.params ?? [];
  if (params.length === 0) {
    container.innerHTML = '<span class="field-hint">No params detected — operations have no <code>{{NAME}}</code> placeholders.</span>';
    return;
  }
  container.innerHTML = `
    <div class="analysis-params-label">Detected params</div>
    <div class="analysis-params-list">${params.map(p => `<span class="analysis-param-chip">${escHtml(p)}</span>`).join('')}</div>`;
}

/**
 * v2.72.18 (Pass 7b) — Render the inputs declaration list for template-body
 * Analyses. Each row: name input, expects select, item-kind select
 * (conditional on expects=list), delete button.
 *
 * Re-renders on structural change (add/delete/expects-change-affecting-
 * itemKind-visibility); inline edits to name / itemKind mutate the draft
 * in place without re-render.
 */
function renderAnalysisInputs() {
  if (!analysisDraft) return;
  const list = $('analysis-inputs-list');
  const countEl = $('analysis-inputs-count');
  if (!list) return;
  const inputs = Array.isArray(analysisDraft.inputs) ? analysisDraft.inputs : [];
  if (countEl) countEl.textContent = String(inputs.length);

  if (inputs.length === 0) {
    list.innerHTML = '<div class="analysis-conditions-empty"><span class="field-hint">No inputs declared. Add the scope bindings this template reads from (e.g. ARTICLE: section, GALLERY: list of record).</span></div>';
    return;
  }

  // Render rows. Use data-idx attribute for row delegation. Item-kind
  // dropdown is hidden when expects !== 'list' but kept in DOM so its
  // value persists across expects changes.
  const KINDS = ['scalar', 'list', 'record', 'section', 'image', 'document', 'element'];
  const ITEM_KINDS = ['scalar', 'record', 'section', 'image']; // kinds that make sense as list items
  list.innerHTML = inputs.map((inp, idx) => {
    const expects = inp.expects ?? 'scalar';
    const itemKind = inp.itemKind ?? 'record';
    const showItemKind = expects === 'list';
    const expectsOptions = KINDS.map(k => `<option value="${k}"${k === expects ? ' selected' : ''}>${k}</option>`).join('');
    const itemKindOptions = ITEM_KINDS.map(k => `<option value="${k}"${k === itemKind ? ' selected' : ''}>${k}</option>`).join('');
    return `
      <div class="analysis-input-row" data-idx="${idx}">
        <input type="text" class="input-name" data-field="name" value="${escAttr(inp.name ?? '')}" placeholder="UPPERCASE_NAME" maxlength="40" />
        <select class="input-expects" data-field="expects">${expectsOptions}</select>
        <select class="input-itemkind ${showItemKind ? '' : 'hidden'}" data-field="itemKind">${itemKindOptions}</select>
        <button class="btn-row-delete" type="button" data-action="delete" title="Remove input">×</button>
      </div>
    `;
  }).join('');

  // Wire row-level inputs. Use event delegation per-row.
  list.querySelectorAll('.analysis-input-row').forEach(row => {
    const idx = parseInt(row.dataset.idx, 10);
    if (!Number.isInteger(idx)) return;

    const nameInput = row.querySelector('[data-field="name"]');
    const expectsSel = row.querySelector('[data-field="expects"]');
    const itemKindSel = row.querySelector('[data-field="itemKind"]');
    const deleteBtn = row.querySelector('[data-action="delete"]');

    nameInput?.addEventListener('input', () => {
      // Uppercase the input as the user types — inputs follow the binding
      // naming convention enforced at save time.
      const upper = nameInput.value.toUpperCase().replace(/[^A-Z0-9_]/g, '');
      if (upper !== nameInput.value) nameInput.value = upper;
      analysisDraft.inputs[idx].name = upper;
    });
    expectsSel?.addEventListener('change', () => {
      const newExpects = expectsSel.value;
      analysisDraft.inputs[idx].expects = newExpects;
      // Show/hide itemKind without re-rendering the whole list.
      if (itemKindSel) {
        itemKindSel.classList.toggle('hidden', newExpects !== 'list');
      }
      // If expects changed away from list, drop itemKind from the draft
      // to avoid stale data lingering.
      if (newExpects !== 'list') {
        delete analysisDraft.inputs[idx].itemKind;
      } else if (!analysisDraft.inputs[idx].itemKind) {
        // Default itemKind when first switching to list.
        analysisDraft.inputs[idx].itemKind = itemKindSel?.value ?? 'record';
      }
    });
    itemKindSel?.addEventListener('change', () => {
      analysisDraft.inputs[idx].itemKind = itemKindSel.value;
    });
    deleteBtn?.addEventListener('click', () => {
      analysisDraft.inputs.splice(idx, 1);
      renderAnalysisInputs();
    });
  });
}

/**
 * v2.66.0 (Pass 3a) — Render an analysis condition row.
 *
 * v2.64.0 (Pass 1) — Render the pre or post condition list inside the
 * Analysis form. `which` is 'pre' or 'post'. Each condition row offers a
 * type dropdown and per-type field inputs. The list re-renders on any
 * structural change (type change, add, remove); per-field text edits
 * mutate the draft in place without re-render.
 *
 * Field input values support {{NAME}} placeholders for the Analysis's
 * params. Validation/substitution happens at engine evaluation time.
 */
function renderAnalysisConditions(which) {
  if (!analysisDraft) return;
  const arr = which === 'pre' ? analysisDraft.preconditions : analysisDraft.postconditions;
  const listEl = $(which === 'pre' ? 'analysis-pre-list' : 'analysis-post-list');
  const countEl = $(which === 'pre' ? 'analysis-pre-count' : 'analysis-post-count');
  const sectionEl = $(which === 'pre' ? 'analysis-pre-section' : 'analysis-post-section');
  if (!listEl || !countEl) return;

  countEl.textContent = String(arr.length);

  // Auto-expand the section when there are conditions; collapse when empty
  // (unless user has explicitly toggled it). We only auto-expand on render
  // — once the user toggles, their choice is preserved.
  if (sectionEl && arr.length > 0 && !sectionEl.dataset.userToggled) {
    sectionEl.open = true;
  }

  if (arr.length === 0) {
    listEl.innerHTML = '<div class="analysis-conditions-empty"><span class="field-hint">No conditions yet.</span></div>';
    return;
  }

  listEl.innerHTML = arr.map((cond, idx) => renderAnalysisConditionRow(cond, idx, which)).join('');

  // Wire row-level handlers
  listEl.querySelectorAll('[data-action="ac-type"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const which = sel.dataset.which;
      const idx = parseInt(sel.dataset.idx, 10);
      const target = which === 'pre' ? analysisDraft.preconditions : analysisDraft.postconditions;
      if (!target[idx]) return;
      // v2.70.6 — Decode synthetic 'pred_ref:<id>' values from the Custom
      // group. The decoded shape gives type and (for references) assertionId.
      const decoded = _decodeConditionTypeValue(sel.value);
      const newType = decoded.type;
      // v2.70.3 — Use canonical emptyCondition (handles all unified types
      // including assertion_ref). emptyDataCondition was scope-only and
      // would fall back to binding_is_list when handed assertion_ref.
      const fresh = emptyCondition(newType);
      const oldFieldsByName = { ...target[idx] };
      for (const f of CONDITION_FIELDS[newType]?.fields ?? []) {
        if (oldFieldsByName[f] != null) fresh[f] = oldFieldsByName[f];
      }
      // v2.70.6 — assertion_ref selections from the Custom group carry the
      // chosen assertion's ID encoded in the dropdown value. Apply it here,
      // overriding any preserved field from a prior reference.
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.perspectiveId) fresh.perspectiveId = decoded.perspectiveId;
      // v2.64.1 — Force binding to implicit value per section. The user
      // never sets binding directly; it's a fixed convention per pre/post.
      // Only applies to scope conditions that have a `binding` field;
      // assertion_ref has no binding.
      if (CONDITION_FIELDS[newType]?.fields?.includes('binding')) {
        fresh.binding = which === 'pre' ? 'INPUT' : 'OUTPUT';
      }
      target[idx] = fresh;
      renderAnalysisConditions(which);
    });
  });

  listEl.querySelectorAll('[data-action="ac-field"]').forEach(inp => {
    // v2.70.3 — Both 'input' (text inputs) and 'change' (select dropdowns
    // for assertion_ref picker) trigger the handler.
    const handler = () => {
      const which = inp.dataset.which;
      const idx = parseInt(inp.dataset.idx, 10);
      const fname = inp.dataset.field;
      const target = which === 'pre' ? analysisDraft.preconditions : analysisDraft.postconditions;
      if (target[idx]) target[idx][fname] = inp.value;
    };
    inp.addEventListener('input', handler);
    inp.addEventListener('change', handler);
  });

  listEl.querySelectorAll('[data-action="ac-remove"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const which = btn.dataset.which;
      const idx = parseInt(btn.dataset.idx, 10);
      const target = which === 'pre' ? analysisDraft.preconditions : analysisDraft.postconditions;
      target.splice(idx, 1);
      renderAnalysisConditions(which);
    });
  });
}

/**
 * Render one condition row. Polymorphic on the condition type — the type
 * dropdown is always present; the right-side fields adapt to the type.
 */
function renderAnalysisConditionRow(cond, idx, which) {
  // v2.70.6 — Schema-driven dropdown via shared buildConditionTypeOptions
  // helper. Replaces the previous local grouping logic. Library assertions
  // appear as direct options under the Custom group; selecting one creates
  // a assertion_ref condition with the picked assertionId. No secondary
  // picker — the type dropdown carries the full selection.
  //
  // Analysis pre/post is scope-only (allowedFamilies=['scope']). The Page
  // group never renders for Analysis conditions. Custom group is filtered
  // by family-compat: scope-only library assertions pass; page-only
  // assertions are excluded (they wouldn't evaluate against an Analysis's
  // scope-only synthetic context).
  const typeOpts = _buildConditionTypeOptions({
    allowedFamilies: ['scope'],
    assertions: analysisAssertionCache,
    iterScope: null,  // Analysis pre/post don't have an iteration variable
    currentType: cond.type,
    currentPredId: cond.assertionId ?? '',
  });

  // ── Right-side fields ───────────────────────────────────────────────────
  // Scope conditions: schema-driven inputs (existing behavior).
  // Reference conditions: read-only description of the picked assertion.
  let fieldsHtml;
  if (cond.type === 'assertion_ref') {
    const refId = cond.assertionId;
    const matched = (analysisAssertionCache ?? []).find(p => p.id === refId);
    if (matched) {
      const desc = matched.description ?? '';
      fieldsHtml = desc
        ? `<span class="cond-pred-hint" title="${escAttr(matched.name ?? matched.id)}">${escHtml(desc)}</span>`
        : `<span class="cond-pred-hint cond-pred-hint-empty">no description</span>`;
    } else if (refId) {
      fieldsHtml = `<span class="cond-pred-hint cond-pred-hint-stale">missing assertion: ${escHtml(refId)}</span>`;
    } else {
      fieldsHtml = `<span class="cond-pred-hint cond-pred-hint-empty">— pick a assertion from the dropdown —</span>`;
    }
  } else {
    const schema = DATA_CONDITION_FIELDS[cond.type];
    const fields = schema?.fields ?? [];
    // v2.64.1 — Skip the `binding` field for operations/frontier body kinds.
    // It's set implicitly per section (pre → INPUT; post → OUTPUT) by the
    // add-button handler and by load/save normalization. Surfacing it as a
    // user-input field invited the failure mode where authors typed scope
    // names that the engine's synthetic scope can't resolve.
    //
    // v2.72.20 (Pass 7c) — Template body kind is different. Template
    // preconditions evaluate against real scope, so authors must pick
    // the binding name from declared inputs. Render a dropdown of
    // declared input names for pre conditions on template Analyses.
    // Post conditions stay implicit (binding=OUTPUT, synth-scope sentinel).
    //
    // v2.72.23 — Frontier-tier preconditions also surface a binding input.
    // Default value INPUT (legacy single-source); type a name like ARTICLE
    // to enter compose mode at runtime. Free-text input — the strategy
    // editor shows bound/unbound check against upstream nodes.
    const isTemplatePre = (analysisDraft?.bodyKind === 'template' && which === 'pre');
    const isFrontierPre = (analysisDraft?.tier === 'frontier' && which === 'pre');
    const declaredInputs = Array.isArray(analysisDraft?.inputs) ? analysisDraft.inputs : [];

    let bindingFieldHtml = '';
    if (isTemplatePre && fields.includes('binding')) {
      const opts = ['<option value="">— input —</option>']
        .concat(declaredInputs.map(i => `<option value="${escAttr(i.name)}"${i.name === cond.binding ? ' selected' : ''}>${escHtml(i.name)}</option>`))
        .join('');
      bindingFieldHtml = `<select class="ac-binding-select" data-action="ac-field" data-which="${escAttr(which)}" data-idx="${idx}" data-field="binding">${opts}</select>`;
    } else if (isFrontierPre && fields.includes('binding')) {
      const v = cond.binding ?? 'INPUT';
      bindingFieldHtml = `<input type="text" class="ac-binding-input" data-action="ac-field" data-which="${escAttr(which)}" data-idx="${idx}" data-field="binding" value="${escAttr(v)}" placeholder="INPUT or scope name (e.g. ARTICLE)" title="INPUT = single-source mode (use node.source). Other UPPERCASE_NAME = compose mode (engine fans this binding from scope into the model)." />`;
    }

    fieldsHtml = bindingFieldHtml + fields.filter(fname => fname !== 'binding').map(fname => {
      const v = cond[fname] ?? '';
      let placeholder = fname;
      if (fname === 'fieldName') {
        placeholder = 'field name (e.g. deviceName)';
      } else if (fname === 'min' || fname === 'max') {
        placeholder = `${fname} (number or {{PARAM}})`;
      } else if (fname === 'count') {
        placeholder = 'exact count (number or {{PARAM}})';
      } else if (fname === 'value') {
        placeholder = 'value to match (string or {{PARAM}})';
      } else if (fname === 'values') {
        placeholder = 'comma-separated values (e.g. active,pending,closed)';
      }
      return `<input type="text" class="ac-field-input" data-action="ac-field" data-which="${escAttr(which)}" data-idx="${idx}" data-field="${escAttr(fname)}" value="${escAttr(v)}" placeholder="${escAttr(placeholder)}" />`;
    }).join('');
  }

  return `
    <div class="ac-row">
      <select class="ac-type-select" data-action="ac-type" data-which="${escAttr(which)}" data-idx="${idx}">
        ${typeOpts}
      </select>
      <div class="ac-fields">${fieldsHtml}</div>
      <button class="btn-action danger" data-action="ac-remove" data-which="${escAttr(which)}" data-idx="${idx}" title="Remove condition">✕</button>
    </div>`;
}

// v2.72.71 — renderStrategyConditions and renderStrategyConditionRow used
// to live here but were moved to studio.js. They reference strategyDraft,
// strategyAssertionCache, and strategyPerspectiveCache, which all live in
// studio.js's module scope. Hosting them here was a mis-placement that
// made the strategy form's pre/post condition rendering permanently
// broken ("renderStrategyConditions is not defined" when called from
// studio.js).

async function saveAnalysis() {
  if (!analysisDraft) return;

  // v2.68.0 — Tier must be picked. Save button is disabled when null,
  // but defensive-check anyway.
  if (!analysisDraft.tier) {
    toast('Pick an Analysis tier first (Cache or Frontier)', 'err');
    return;
  }

  // v2.72.18 (Pass 7b) — For cache tier, body kind must be picked too.
  if (analysisDraft.tier === 'cache' && !analysisDraft.bodyKind) {
    toast('Pick a body kind (Operations or Template)', 'err');
    return;
  }

  // Read inputs (tier-shared fields).
  analysisDraft.name = $('input-analysis-name').value.trim();
  analysisDraft.description = $('input-analysis-description').value.trim();

  if (!analysisDraft.name) {
    toast('Analysis needs a name', 'err');
    return;
  }
  if (!analysisDraft.description) {
    if (analysisDraft.tier === 'frontier') {
      toast('Frontier-tier Analyses especially need a clear description — it is the model\'s primary intent signal', 'err');
    } else {
      toast('Analysis needs a description (it\'s shown when picking from the library)', 'err');
    }
    return;
  }

  // v2.72.18 (Pass 7b) — Body-kind-specific parsing & validation. Cache
  // tier branches on bodyKind. Frontier tier has no body to parse.
  let operations = [];
  let templateSource = '';
  let templateInputs = [];
  if (analysisDraft.tier === 'cache' && analysisDraft.bodyKind === 'operations') {
    const opsText = $('input-analysis-operations').value.trim();
    try {
      operations = opsText ? JSON.parse(opsText) : [];
    } catch (e) {
      toast(`Operations JSON parse error: ${e.message}`, 'err');
      return;
    }
    if (!Array.isArray(operations)) {
      toast('Operations must be a JSON array', 'err');
      return;
    }
    // Light shape validation — every op has at least an `op` field.
    for (let i = 0; i < operations.length; i++) {
      const o = operations[i];
      if (!o || typeof o !== 'object' || typeof o.op !== 'string') {
        toast(`Operation ${i + 1}: missing or invalid "op" field`, 'err');
        return;
      }
    }
    analysisDraft.operations = operations;
    analysisDraft.template = '';
    analysisDraft.inputs = [];
  } else if (analysisDraft.tier === 'cache' && analysisDraft.bodyKind === 'transform') {
    // v2.74.133 — Transform body: parse JSON envelope, run the registry's
    // validator. Surfaces inline kind / binding / op errors.
    const xfText = $('input-analysis-transform')?.value?.trim() ?? '';
    let parsed;
    try {
      parsed = xfText ? JSON.parse(xfText) : { inputs: [], ops: [], outputs: [] };
    } catch (e) {
      toast(`Transform JSON parse error: ${e.message}`, 'err');
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      toast('Transform body must be a JSON object with inputs/ops/outputs', 'err');
      return;
    }
    const result = validateTransformBody(parsed);
    if (!result.ok) {
      const first = result.errors[0] ?? 'unknown error';
      const more = result.errors.length > 1 ? ` (+${result.errors.length - 1} more)` : '';
      toast(`Transform body invalid: ${first}${more}`, 'err');
      // Log all errors for the author to diagnose.
      console.warn('[AnalysisForm] Transform body validation errors:', result.errors);
      return;
    }
    analysisDraft.transform = {
      inputs:  Array.isArray(parsed.inputs)  ? parsed.inputs  : [],
      ops:     Array.isArray(parsed.ops)     ? parsed.ops     : [],
      outputs: Array.isArray(parsed.outputs) ? parsed.outputs : [],
    };
    analysisDraft.operations = [];
    analysisDraft.template = '';
    analysisDraft.inputs = [];
  } else if (analysisDraft.tier === 'cache' && analysisDraft.bodyKind === 'template') {
    templateSource = $('input-analysis-template').value;
    if (!templateSource.trim()) {
      toast('Template body cannot be empty', 'err');
      return;
    }
    // Parse the template — surfaces syntax errors at save time so authors
    // don't ship broken templates that fail at strategy run.
    const parsed = parseTemplate(templateSource);
    if (!parsed.ok) {
      toast(`Template parse error: ${parsed.error}`, 'err');
      return;
    }
    // Validate inputs declarations.
    const declaredInputs = Array.isArray(analysisDraft.inputs) ? analysisDraft.inputs : [];
    const seen = new Set();
    const validKinds = new Set(['scalar', 'list', 'record', 'section', 'image', 'document', 'element']);
    const validItemKinds = new Set(['scalar', 'record', 'section', 'image']);
    for (let i = 0; i < declaredInputs.length; i++) {
      const inp = declaredInputs[i];
      const where = `Input ${i + 1}`;
      if (!inp.name) {
        toast(`${where}: name is required`, 'err');
        return;
      }
      if (!/^[A-Z][A-Z0-9_]*$/.test(inp.name)) {
        toast(`${where} ("${inp.name}"): name must be UPPERCASE_WITH_UNDERSCORES`, 'err');
        return;
      }
      if (seen.has(inp.name)) {
        toast(`Duplicate input name "${inp.name}" — each input must be unique`, 'err');
        return;
      }
      seen.add(inp.name);
      if (!validKinds.has(inp.expects)) {
        toast(`${where} ("${inp.name}"): unknown expects "${inp.expects}"`, 'err');
        return;
      }
      if (inp.expects === 'list' && inp.itemKind && !validItemKinds.has(inp.itemKind)) {
        toast(`${where} ("${inp.name}"): unknown itemKind "${inp.itemKind}"`, 'err');
        return;
      }
    }
    // Cross-check: template references that don't match any declared input
    // are surfaced as a warning (toast, but proceed). Authoring strict-mode
    // (block save on mismatch) lands in 7c with live preview.
    const refs = collectTemplateReferences(parsed.ast);
    const declaredNames = new Set(declaredInputs.map(i => i.name));
    const undeclared = refs.filter(r => !declaredNames.has(r));
    if (undeclared.length > 0) {
      // Reusing toast as a soft warning; it's the closest we have to a
      // non-blocking message channel today.
      toast(`Template references ${undeclared.length} undeclared name(s): ${undeclared.slice(0, 3).join(', ')}${undeclared.length > 3 ? '…' : ''}. Saved anyway — Strategies referencing this Analysis will fail at run if those names aren't bound in scope.`, 'info');
    }
    templateInputs = declaredInputs;
    analysisDraft.template = templateSource;
    analysisDraft.operations = [];
  } else {
    // Frontier — no operations, template, or inputs.
    analysisDraft.operations = [];
    analysisDraft.template = '';
    analysisDraft.inputs = [];
  }

  // v2.64.0 (Pass 1) — Validate pre/post conditions. Either both arrays
  // are valid or save fails with a descriptive error.
  const preErrors = validateDataConditionList(analysisDraft.preconditions ?? [], 'Preconditions');
  if (preErrors.length > 0) {
    toast(preErrors[0], 'err');
    return;
  }
  const postErrors = validateDataConditionList(analysisDraft.postconditions ?? [], 'Postconditions');
  if (postErrors.length > 0) {
    toast(postErrors[0], 'err');
    return;
  }

  // v2.70.3 — Family-compat check on assertion_ref. Analysis pre/post only
  // evaluates scope-family conditions (no page is available during Analysis
  // execution). If pre/post contains a assertion_ref pointing at a library
  // assertion that has page-family conditions, the reference will silently
  // no-op at runtime — fail save with a descriptive error.
  const refIncompat = await checkAssertionRefFamilies(
    [...(analysisDraft.preconditions ?? []), ...(analysisDraft.postconditions ?? [])],
    ['scope'],
    analysisDraft.groundId
  );
  if (refIncompat.length > 0) {
    const first = refIncompat[0];
    toast(
      `Analysis can't use assertion "${first.name}" — it has ${first.foreignFamilies.join('/')} conditions which Analyses don't evaluate. Use only scope-side library assertions.`,
      'err'
    );
    return;
  }

  // v2.64.1 — Defense-in-depth on bindings.
  // v2.72.20 (Pass 7c) — Body-kind aware:
  //   - operations body: pre→INPUT, post→OUTPUT (synth scope sentinels)
  //   - template body:   pre keeps author-specified binding (which must be
  //                       a declared input name); post→OUTPUT (synth sentinel)
  //   - frontier:        pre→INPUT, post→OUTPUT (synth scope sentinels)
  // v2.72.23 — Frontier tier extended: pre keeps author-specified non-INPUT
  //   bindings (enables compose mode where pre conditions name scope
  //   bindings the model fans in). Empty/missing binding defaults to INPUT
  //   for backward compat with existing single-source frontier Analyses.
  // Skip assertion_ref entries; they don't carry a binding field.
  const forceBinding = (c, bindingValue) => {
    if (c.type === 'assertion_ref') return c;
    return { ...c, binding: bindingValue };
  };
  // v2.74.133 — Transform body: pre/post both keep author-specified
  // bindings (which must reference a declared input for pre, or a
  // declared output for post). validateTransformBody (called above) has
  // already validated input/output declarations; here we just check
  // condition bindings against the declared names.
  if (analysisDraft.bodyKind === 'transform') {
    const declaredInputNames  = new Set((analysisDraft.transform?.inputs  ?? []).map(i => i.name));
    const declaredOutputNames = new Set((analysisDraft.transform?.outputs ?? []).map(o => o.name));
    for (let i = 0; i < (analysisDraft.preconditions ?? []).length; i++) {
      const c = analysisDraft.preconditions[i];
      if (c.type === 'assertion_ref') continue;
      const b = c.binding;
      if (!b) {
        toast(`Precondition ${i + 1} (${c.type}) has no binding — pick one of the declared inputs.`, 'err');
        return;
      }
      if (!declaredInputNames.has(b)) {
        toast(`Precondition ${i + 1} (${c.type}) references "${b}" which is not a declared input. Declared inputs: ${[...declaredInputNames].join(', ') || '(none)'}.`, 'err');
        return;
      }
    }
    for (let i = 0; i < (analysisDraft.postconditions ?? []).length; i++) {
      const c = analysisDraft.postconditions[i];
      if (c.type === 'assertion_ref') continue;
      const b = c.binding;
      if (!b) {
        toast(`Postcondition ${i + 1} (${c.type}) has no binding — pick one of the declared inputs or outputs.`, 'err');
        return;
      }
      // Allow referencing inputs too (lets conditions compare in/out).
      if (!declaredOutputNames.has(b) && !declaredInputNames.has(b)) {
        toast(`Postcondition ${i + 1} (${c.type}) references "${b}" which is not a declared input or output. Declared outputs: ${[...declaredOutputNames].join(', ') || '(none)'}.`, 'err');
        return;
      }
    }
  } else if (analysisDraft.bodyKind === 'template') {
    // Pre: validate that each condition's binding references a declared
    // input. Skip assertion_ref. Don't auto-rewrite — author chose the name.
    const declaredInputNames = new Set((analysisDraft.inputs ?? []).map(i => i.name));
    for (let i = 0; i < (analysisDraft.preconditions ?? []).length; i++) {
      const c = analysisDraft.preconditions[i];
      if (c.type === 'assertion_ref') continue;
      const b = c.binding;
      if (!b) {
        toast(`Precondition ${i + 1} (${c.type}) has no binding — pick one of the declared inputs.`, 'err');
        return;
      }
      if (!declaredInputNames.has(b)) {
        toast(`Precondition ${i + 1} (${c.type}) references "${b}" which is not a declared input. Declared inputs: ${[...declaredInputNames].join(', ') || '(none)'}.`, 'err');
        return;
      }
    }
    // Post: force OUTPUT (the synth-scope sentinel for the bound document).
    analysisDraft.postconditions = (analysisDraft.postconditions ?? []).map(c => forceBinding(c, 'OUTPUT'));
  } else if (analysisDraft.tier === 'frontier') {
    // Frontier: pre keeps author binding if non-empty and not INPUT (compose
    // mode); else defaults to INPUT (single-source mode). Validate binding
    // names look reasonable: must be UPPERCASE_NAME format if not INPUT.
    analysisDraft.preconditions = (analysisDraft.preconditions ?? []).map(c => {
      if (c.type === 'assertion_ref') return c;
      const b = (c.binding ?? '').toString().trim();
      if (!b || b === 'INPUT') return { ...c, binding: 'INPUT' };
      return { ...c, binding: b };
    });
    // Validate non-INPUT pre bindings have valid name format.
    for (let i = 0; i < (analysisDraft.preconditions ?? []).length; i++) {
      const c = analysisDraft.preconditions[i];
      if (c.type === 'assertion_ref' || c.binding === 'INPUT') continue;
      if (!/^[A-Z][A-Z0-9_]*$/.test(c.binding)) {
        toast(`Precondition ${i + 1} (${c.type}) binding "${c.binding}" must be UPPERCASE_NAME format (or INPUT for single-source).`, 'err');
        return;
      }
    }
    // Post: always force OUTPUT (synth scope sentinel for the model's output).
    analysisDraft.postconditions = (analysisDraft.postconditions ?? []).map(c => forceBinding(c, 'OUTPUT'));
  } else {
    // Cache-tier operations: existing INPUT/OUTPUT pseudo-bindings.
    analysisDraft.preconditions  = (analysisDraft.preconditions  ?? []).map(c => forceBinding(c, 'INPUT'));
    analysisDraft.postconditions = (analysisDraft.postconditions ?? []).map(c => forceBinding(c, 'OUTPUT'));
  }

  // Auto-detect params from operations or template + pre/post. The {{NAME}}
  // placeholders can appear in any of these, so the params list is the
  // union of names found across all sources.
  // v2.72.18 (Pass 7b) — For template-body Analyses, declared input names
  // are scope references (not params), so subtract them from the auto-
  // detected set. Template references include sub-field forms like
  // {{ARTICLE.markdown}} — collectTemplateReferences returns the root names
  // and skips loop iterators introduced by {{#each}} blocks.
  let bodyParams = [];
  if (analysisDraft.bodyKind === 'template') {
    // Re-parse to be safe (the saved-template parse may have been on a
    // slightly different value if there were edits between validate and pack).
    const parsedForParams = parseTemplate(analysisDraft.template ?? '');
    if (parsedForParams.ok) {
      bodyParams = collectTemplateReferences(parsedForParams.ast);
    }
  } else if (analysisDraft.bodyKind === 'transform') {
    // v2.74.133 — Walk the transform body's ops for {{NAME}} placeholders.
    // extractAnalysisParams recursively visits all string-typed values in
    // the structure, so passing the whole ops array works the same way
    // it does for the operations-body.
    bodyParams = extractAnalysisParams(analysisDraft.transform?.ops ?? []);
  } else {
    bodyParams = extractAnalysisParams(operations);
  }
  const preParams = extractAnalysisParams(analysisDraft.preconditions ?? []);
  const postParams = extractAnalysisParams(analysisDraft.postconditions ?? []);
  let allParams = [...new Set([...bodyParams, ...preParams, ...postParams])];
  if (analysisDraft.bodyKind === 'template') {
    const inputNames = new Set((analysisDraft.inputs ?? []).map(i => i.name));
    allParams = allParams.filter(p => !inputNames.has(p));
  } else if (analysisDraft.bodyKind === 'transform') {
    // Same exclusion: declared input names are scope references, not params.
    // Also exclude declared output names (they're produced, not consumed).
    const inputNames  = new Set((analysisDraft.transform?.inputs  ?? []).map(i => i.name));
    const outputNames = new Set((analysisDraft.transform?.outputs ?? []).map(o => o.name));
    allParams = allParams.filter(p => !inputNames.has(p) && !outputNames.has(p));
  }
  analysisDraft.params = allParams.sort();

  // v2.67.0 (Pass 3b) — Read autoRecover checkbox into draft. Explicit
  // boolean: only true when checked; never undefined or truthy-non-boolean.
  // v2.68.0 — Only meaningful for cache tier. Frontier ignores it.
  if (analysisDraft.tier === 'cache') {
    analysisDraft.autoRecover = $('input-analysis-auto-recover').checked === true;
  } else {
    analysisDraft.autoRecover = false;
  }

  // v2.66.0 (Pass 3a) — Reshape draft into layered storage form before
  // persisting. The editor still works on a flat `operations` array
  // internally; persisted shape carries `implementations: [{tier, ...}]`.
  // v2.68.0 (Pass 3c) — Tier-aware persistence:
  //   cache:    implementations[0] = {tier: 'cache', body: {kind: 'operations', operations: [...]}}
  //   frontier: implementations[0] = {tier: 'frontier'}  (no body)
  // v2.70.0 — Pre/post wrapped into assertion envelope shape on save.
  // v2.72.16 (Pass 7a) — operations under body envelope (body.kind === 'operations').
  // v2.72.18 (Pass 7b) — template body kind: implementations[0].body =
  //   {kind: 'template', template: '...', inputs: [...]}.
  // The editor works on flat arrays internally; persisted shape is
  // {match, conditions, count?}.
  // The editor-state fields (`tier`, `bodyKind`, `operations`, `template`,
  // `inputs`, `preMatch`/`preCount`, `postMatch`/`postCount`) are stripped
  // before persisting; the persisted record carries only the canonical shape.
  const {
    operations: _draftOps,
    template: _draftTmpl,
    inputs: _draftInputs,
    // v2.74.133 — strip the editor's transform envelope from the persisted
    // record; it lives canonically under implementations[0].body.
    transform: _draftTransform,
    tier: _draftTier,
    bodyKind: _draftBodyKind,
    preMatch: _preMatch,
    preCount: _preCount,
    postMatch: _postMatch,
    postCount: _postCount,
    ...draftRest
  } = analysisDraft;

  // Build implementation by tier + bodyKind.
  let implementation;
  if (analysisDraft.tier === 'frontier') {
    implementation = { tier: 'frontier' };
  } else if (analysisDraft.bodyKind === 'template') {
    implementation = {
      tier: 'cache',
      body: {
        kind: 'template',
        template: analysisDraft.template ?? '',
        inputs: (analysisDraft.inputs ?? []).map(i => ({
          name: i.name,
          expects: i.expects,
          ...(i.itemKind ? { itemKind: i.itemKind } : {}),
        })),
      },
    };
  } else if (analysisDraft.bodyKind === 'transform') {
    // v2.74.133 — Transform body envelope. validateTransformBody (run
    // earlier in save) has already checked structural well-formedness;
    // the draft.transform fields are persisted as-is here.
    const xf = analysisDraft.transform ?? { inputs: [], ops: [], outputs: [] };
    implementation = {
      tier: 'cache',
      body: {
        kind: 'transform',
        inputs:  Array.isArray(xf.inputs)  ? xf.inputs  : [],
        ops:     Array.isArray(xf.ops)     ? xf.ops     : [],
        outputs: Array.isArray(xf.outputs) ? xf.outputs : [],
      },
    };
  } else {
    // bodyKind === 'operations' (or default)
    implementation = {
      tier: 'cache',
      body: { kind: 'operations', operations: analysisDraft.operations ?? [] },
    };
  }

  const wrapEnvelope = (conds, match, count) => {
    const m = (match === 'any' || match === 'k_of_n') ? match : 'all';
    const out = { match: m, conditions: conds ?? [] };
    if (m === 'k_of_n' && Number.isInteger(count) && count > 0) out.count = count;
    return out;
  };

  const recordToSave = {
    ...draftRest,
    implementations: [implementation],
    preconditions:  wrapEnvelope(analysisDraft.preconditions,  analysisDraft.preMatch,  analysisDraft.preCount),
    postconditions: wrapEnvelope(analysisDraft.postconditions, analysisDraft.postMatch, analysisDraft.postCount),
    autoRecover: analysisDraft.autoRecover === true,
  };

  try {
    await StorageManager.saveAnalysis(recordToSave);
    toast(`Analysis saved: ${analysisDraft.name}`, 'ok');
    closeAnalysisForm();
    _refreshGroundList();
  } catch (e) {
    toast(`Save failed: ${e.message}`, 'err');
  }
}

export async function deleteAnalysis(analysisId) {
  if (isBuiltinAnalysisId(analysisId)) {
    toast('Built-in Analyses cannot be deleted', 'warn');
    return;
  }
  const a = await StorageManager.getAnalysis(analysisId);
  if (!a) { toast('Analysis not found', 'err'); return; }
  if (!confirm(`Delete Analysis "${a.name}"? This cannot be undone.`)) return;
  await StorageManager.deleteAnalysis(analysisId);
  toast('Analysis deleted', 'ok');
  _refreshGroundList();
}


// ─── Setup (one-time wiring) ────────────────────────────────────────────

/**
 * Wire Analysis form button handlers and store injected dependencies.
 * Called once at studio.js load time.
 *
 * @param {Object} opts
 * @param {Function} opts.refreshGroundList
 * @param {Function} opts.buildConditionTypeOptions
 * @param {Function} opts.decodeConditionTypeValue
 */
export function setupAnalysisForm({
  refreshGroundList,
  buildConditionTypeOptions,
  decodeConditionTypeValue,
}) {
  _refreshGroundList = refreshGroundList;
  _buildConditionTypeOptions = buildConditionTypeOptions;
  _decodeConditionTypeValue = decodeConditionTypeValue;

// Wire analysis form buttons (one-time)
$('btn-cancel-analysis')?.addEventListener('click', () => closeAnalysisForm());
$('btn-save-analysis')?.addEventListener('click', () => saveAnalysis());

// v2.68.0 (Pass 3c) — Tier-choice buttons. Set draft.tier and re-render
// the form to reveal tier-appropriate fields.
$('btn-tier-cache')?.addEventListener('click', () => {
  if (!analysisDraft) return;
  analysisDraft.tier = 'cache';
  // Don't auto-pick body kind — let the user choose at the sub-gate.
  renderAnalysisFormForTier();
  // Focus the first body-kind button to invite the next choice.
  $('btn-body-kind-operations')?.focus();
});
$('btn-tier-frontier')?.addEventListener('click', () => {
  if (!analysisDraft) return;
  analysisDraft.tier = 'frontier';
  // Frontier has no body kind in this build.
  renderAnalysisFormForTier();
  $('input-analysis-name')?.focus();
});

// v2.72.18 (Pass 7b) — Body-kind buttons. Cache tier only; sets
// draft.bodyKind and re-renders to reveal kind-specific fields.
$('btn-body-kind-operations')?.addEventListener('click', () => {
  if (!analysisDraft || analysisDraft.tier !== 'cache') return;
  analysisDraft.bodyKind = 'operations';
  renderAnalysisFormForTier();
  $('input-analysis-name')?.focus();
});
$('btn-body-kind-template')?.addEventListener('click', () => {
  if (!analysisDraft || analysisDraft.tier !== 'cache') return;
  analysisDraft.bodyKind = 'template';
  // Initialize inputs array on first switch (so the editor renders empty
  // rather than throwing on undefined).
  if (!Array.isArray(analysisDraft.inputs)) analysisDraft.inputs = [];
  renderAnalysisInputs();
  renderAnalysisFormForTier();
  $('input-analysis-name')?.focus();
});
// v2.74.133 — Transform body kind. JSON-textarea editor for v1; the
// structured per-op UI is a follow-up. Stores the parsed body envelope
// on `analysisDraft.transform` (sibling of `operations` and `template`).
$('btn-body-kind-transform')?.addEventListener('click', () => {
  if (!analysisDraft || analysisDraft.tier !== 'cache') return;
  analysisDraft.bodyKind = 'transform';
  if (!analysisDraft.transform || typeof analysisDraft.transform !== 'object') {
    analysisDraft.transform = { inputs: [], ops: [], outputs: [] };
  }
  if ($('input-analysis-transform')) {
    $('input-analysis-transform').value = JSON.stringify(analysisDraft.transform, null, 2);
  }
  renderAnalysisFormForTier();
  $('input-analysis-name')?.focus();
});

// v2.72.18 (Pass 7b) — Add-input button: append a fresh input declaration
// row to the draft and re-render. Default to expects=scalar so the user
// can rename and adjust.
$('btn-add-analysis-input')?.addEventListener('click', (e) => {
  if (!analysisDraft) return;
  e.preventDefault();
  if (!Array.isArray(analysisDraft.inputs)) analysisDraft.inputs = [];
  analysisDraft.inputs.push({ name: '', expects: 'scalar' });
  renderAnalysisInputs();
});
// v2.64.0 (Pass 1) — Pre/post condition add buttons. Push an empty
// condition; user picks a different type from the row's dropdown if needed.
// v2.64.1 — Seed binding implicitly per section. Pre always INPUT; post
// always OUTPUT. The author doesn't set binding manually.
// v2.72.20 (Pass 7c) — Body-kind aware seeding. For template body, pre
// references a declared input by name (first one); the row's binding
// dropdown lets the author pick a different one. Post stays OUTPUT
// (synth-scope sentinel for the bound document).
$('btn-add-analysis-pre')?.addEventListener('click', (e) => {
  if (!analysisDraft) return;
  e.preventDefault();
  analysisDraft.preconditions = analysisDraft.preconditions ?? [];
  // Pick a sensible default condition type and seed binding accordingly.
  let condType = 'binding_is_list';
  let binding = 'INPUT';
  if (analysisDraft.bodyKind === 'template') {
    const inputs = Array.isArray(analysisDraft.inputs) ? analysisDraft.inputs : [];
    if (inputs.length > 0) {
      const first = inputs[0];
      binding = first.name;
      // Match condition type to the input's expects kind.
      if (first.expects === 'section')  condType = 'binding_is_section';
      else if (first.expects === 'image')   condType = 'binding_is_image';
      else if (first.expects === 'document') condType = 'binding_is_document';
      else if (first.expects === 'record')   condType = 'binding_is_record';
      else if (first.expects === 'scalar')   condType = 'binding_is_scalar';
      else                                    condType = 'binding_is_list';
    } else {
      // No declared inputs yet — author needs to add some first. Surface a hint.
      toast('Declare inputs first, then add preconditions referencing them.', 'info');
      return;
    }
  }
  const cond = emptyDataCondition(condType);
  cond.binding = binding;
  analysisDraft.preconditions.push(cond);
  const sec = $('analysis-pre-section');
  if (sec) delete sec.dataset.userToggled;
  renderAnalysisConditions('pre');
});
$('btn-add-analysis-post')?.addEventListener('click', (e) => {
  if (!analysisDraft) return;
  e.preventDefault();
  analysisDraft.postconditions = analysisDraft.postconditions ?? [];
  // Default condition type per body kind. Template post operates on a
  // document; default to binding_is_document.
  const condType = (analysisDraft.bodyKind === 'template')
    ? 'binding_is_document'
    : 'binding_is_list';
  const cond = emptyDataCondition(condType);
  cond.binding = 'OUTPUT';
  analysisDraft.postconditions.push(cond);
  const sec = $('analysis-post-section');
  if (sec) delete sec.dataset.userToggled;
  renderAnalysisConditions('post');
});
// Track manual section toggles so auto-expand on render doesn't override
// the user's collapse choice.
$('analysis-pre-section')?.addEventListener('toggle', (e) => {
  e.target.dataset.userToggled = '1';
});
$('analysis-post-section')?.addEventListener('toggle', (e) => {
  e.target.dataset.userToggled = '1';
});
// Live param-detection as the user edits operations JSON. Don't require
// save to see what params will be detected.
$('input-analysis-operations')?.addEventListener('input', (e) => {
  if (!analysisDraft) return;
  try {
    const ops = e.target.value.trim() ? JSON.parse(e.target.value) : [];
    // v2.64.0 — params come from operations + pre/post; refresh union.
    const opParams = extractAnalysisParams(ops);
    const preParams = extractAnalysisParams(analysisDraft.preconditions ?? []);
    const postParams = extractAnalysisParams(analysisDraft.postconditions ?? []);
    analysisDraft.params = [...new Set([...opParams, ...preParams, ...postParams])].sort();
  } catch {
    // Invalid JSON during typing — keep last successful params
  }
  renderAnalysisParamsPreview();
});

}
