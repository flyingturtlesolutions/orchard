/**
 * @file Studio/ObservationForm.js
 * @description Observation primitive authoring form, live-page selector
 * picker, and supporting per-shape rendering. Observations are
 * extraction primitives — they observe values from a live page (cache
 * tier) or via LLM frontier extraction (frontier tier) and produce
 * structured output. Shapes: scalar, raw_text, raw_html, list_of_records.
 *
 * Storage shape per shape (cache tier):
 *   text:             { ..., shape:'text',            target }    // v2.74.131
 *   attribute:        { ..., shape:'attribute',       target, attribute: 'href' }   // v2.74.131
 *   scalar:           { ..., shape:'scalar',          target, extract: { kind:'text' } | { kind:'attribute', name } }   // legacy
 *   raw_text:         { ..., shape:'raw_text',        target }                                                          // legacy
 *   raw_html:         { ..., shape:'raw_html',        target }
 *   list_of_records:  { ..., shape:'list_of_records', target, fields: [{ name, selector, extract }, ...] }
 *
 * v2.74.21 — Edit-only form. New Observations are authored via the
 * sidepanel observation-author mode (BEGIN_OBSERVATION_AUTHOR); this
 * form edits metadata (name, description, pre/post conditions) on
 * already-saved records and shows extracts read-only via the Recorded
 * extracts section. To change extracts, re-walk via the Ground card.
 *
 * ── Module shape ──────────────────────────────────────────────────────
 *
 * Internal state (file-local):
 *   - observationDraft         : in-progress Observation
 *   - libraryAssertionCache    : assertions on this Ground (for assertion_ref)
 *   - libraryPerspectiveCache       : perspectives on this Ground (for perspective_ref)
 *
 * Exported entry points:
 *   - openObservationForm(groundId, observationId)  — observationId required
 *   - closeObservationForm()
 *   - detectObservationParams(obs)   — used by JSON modal save path
 *   - validateObservationRecord(obs) — used by Fragment → Observation migration
 *   - setupObservationForm({ refreshGroundList, renderConditionEditor,
 *                            decodeConditionTypeValue,
 *                            buildConditionTypeOptions })
 *
 * Dependencies (direct imports):
 *   - StorageManager        : Observation + cross-primitive reads
 *   - shared.js helpers     : $, escAttr, escHtml, toast
 *   - Services/Assertion    : CONDITION_FIELDS, emptyCondition
 *   - Services/DataAssertion: DATA_CONDITION_FIELDS for post conditions
 *   - Services/ObservationDescription: composeCompactDescription —
 *     used to refresh the description on open with the latest composer
 *     output (legacy descriptions migrate to the new format on next save)
 *
 * Setup-time injections (studio.js-internal editor surface):
 *   - renderConditionEditor / decodeConditionTypeValue /
 *     buildConditionTypeOptions — shared editor helpers
 *   - refreshGroundList — host's refresh callback
 *
 * @module Studio/ObservationForm
 * @author Agent HUB
 */

import { StorageManager } from '../Services/StorageManager.js';
import { $, escAttr, escHtml, toast } from '../shared.js';
import { CONDITION_FIELDS, emptyCondition } from '../Services/Assertion.js';
import { DATA_CONDITION_FIELDS } from '../Services/DataAssertion.js';
import { composeCompactDescription } from '../Services/ObservationDescription.js';

// ─── File-local state ───────────────────────────────────────────────────

// Assertions and perspectives cached when form opens, used by pre/post editors.
// v2.72.34 (Pass 17d) — were module-globals in studio.js used only by this
// form; now genuinely private. Defensive `typeof` guards in the body have
// been removed since these are guaranteed declared.
let libraryAssertionCache = [];
let libraryPerspectiveCache = [];

// Setup-time injections.
let _refreshGroundList = null;
let _renderConditionEditor = null;
let _decodeConditionTypeValue = null;
let _buildConditionTypeOptions = null;

let observationDraft = null;

export async function openObservationForm(groundId, observationId) {
  const card = $('observation-form-card');
  const title = $('observation-form-title');
  const groundLabel = $('observation-form-ground-label');
  const ground = await StorageManager.getGround(groundId);

  if (!ground) {
    toast('Ground not found', 'err');
    return;
  }
  groundLabel.textContent = `on Ground: ${ground.name ?? '(unnamed)'}`;

  // v2.72.4 (Pass 3d) — Load library assertions on this Ground so the
  // Observation pre/post editors can offer the assertion_ref option in the
  // Custom group of the type dropdown. Mirrors openAssertionForm.
  try {
    const all = await StorageManager.listAssertions(groundId);
    libraryAssertionCache = all;
  } catch (_) {
    libraryAssertionCache = [];
  }

  // v2.72.31 (Pass 17a) — Load perspectives for the Observation pre editor's
  // perspective_ref picker. Observation post is scope-only; perspectives don't apply.
  try {
    libraryPerspectiveCache = await StorageManager.listPerspectives(groundId);
  } catch (_) {
    libraryPerspectiveCache = [];
  }

  if (!observationId) {
    // v2.74.21 — New-Observation authoring lives in the sidepanel
    // (BEGIN_OBSERVATION_AUTHOR). The Studio form is now edit-only.
    toast('Use + Observation to create a new Observation', 'warn');
    return;
  }
  const existing = await StorageManager.getObservation(observationId);
  if (!existing) {
    toast('Observation not found', 'err');
    return;
  }
  // v2.72.11 (Pass 8) — Read tier + extraction config from
  // implementations[0]. Storage migration ensures this exists; the
  // top-level field fallback covers any record that bypassed migration.
  const impl = (Array.isArray(existing.implementations) && existing.implementations.length > 0)
    ? existing.implementations[0]
    : null;
  const tier = impl?.tier ?? 'cache';
  // v2.74.21 — Multi-extract observations carry implementations[0].extracts.
  // Legacy single-extract records carry target/extract/fields directly on
  // the implementation (or top-level). Normalize to a single extracts list
  // so the recorded-extracts panel and description composer have one
  // shape to work with regardless of vintage.
  const extracts = _normalizeExtracts(impl, existing);

  observationDraft = {
    id           : existing.id,
    groundId     : existing.groundId,
    tier         : tier,
    name         : existing.name ?? '',
    description  : existing.description ?? '',
    // Implementations are preserved verbatim through save — this form
    // edits metadata + pre/post only, not extract bodies. Re-walk to
    // change extracts.
    implementations: Array.isArray(existing.implementations)
      ? existing.implementations.map(i => ({ ...i }))
      : [],
    extracts     : extracts,
    // v2.72.4 (Pass 3d) — Pre/post conditions. Defensive shallow copy of
    // each condition object so editor mutations don't bleed into storage.
    preconditions : Array.isArray(existing.preconditions)
      ? existing.preconditions.map(c => ({ ...c }))
      : [],
    postconditions: Array.isArray(existing.postconditions)
      ? existing.postconditions.map(c => ({ ...c }))
      : [],
  };
  title.textContent = 'Edit Observation';

  // Pre-fill inputs.
  $('input-observation-name').value = observationDraft.name;
  // v2.74.21 — Always recompose the description from extracts on open so
  // legacy stored descriptions (old composer format) refresh to the new
  // human-readable phrasing. User edits override the auto value on save.
  const liveDescription = (extracts.length > 0)
    ? composeCompactDescription(extracts)
    : (observationDraft.description || '');
  $('input-observation-description').value = liveDescription;
  observationDraft.description = liveDescription;

  // v2.72.11 (Pass 8) — tier indicator (gating only fires for new
  // observations, which now go through the sidepanel author).
  _renderObservationFormForTier();
  // Always open the form with the recorded-extracts list collapsed —
  // the metadata is the primary editing surface; extracts are a
  // reference. User toggles to inspect.
  $('observation-recorded-extracts')?.classList.add('hidden');
  _renderRecordedExtracts();
  // v2.72.4 (Pass 3d) — render pre/post lists.
  renderObservationConditions('pre');
  renderObservationConditions('post');
  // v2.72.7 (Pass 3e) — populate live params preview from current draft state.
  _refreshObservationParamsPreview();

  card.classList.remove('hidden');
  $('input-observation-name').focus();
}

/**
 * v2.74.21 — Normalize an implementation's extract storage shape into a
 * single extracts array. Multi-extract Observations have
 * implementations[0].extracts; legacy single-extract records carry
 * target/extract/fields on the implementation (or top-level on very old
 * records).
 */
function _normalizeExtracts(impl, existing) {
  if (Array.isArray(impl?.extracts)) {
    return impl.extracts.map(ex => ({ ...ex }));
  }
  // Legacy single-extract: synthesize a one-element list from the
  // available fields. Used only for displaying the recorded-extracts
  // panel; saveObservation preserves the original implementations.
  const target  = impl?.target  ?? existing?.target  ?? '';
  const extract = impl?.extract ?? existing?.extract ?? { kind: 'text' };
  const fields  = impl?.fields  ?? existing?.fields  ?? [];
  const shape   = existing?.shape ?? 'scalar';
  const output  = existing?.output ?? '';
  if (!target && !output && (!Array.isArray(fields) || fields.length === 0)) {
    return [];
  }
  const ex = { shape, output };
  if (target) ex.target = target;
  if (shape === 'scalar' && extract) ex.extract = extract;
  if (Array.isArray(fields) && fields.length > 0) ex.fields = fields;
  return [ex];
}

/**
 * v2.74.21 — Render the read-only Recorded extracts panel. Mirrors
 * Studio/FragmentForm.js's renderRecordedActions: index, shape badge,
 * selector or coords, output binding. No edit affordances — re-walk
 * to change.
 */
function _renderRecordedExtracts() {
  const container = $('observation-recorded-extracts');
  const toggleBtn = $('observation-recorded-extracts-toggle');
  if (!container || !observationDraft) return;
  const extracts = Array.isArray(observationDraft.extracts) ? observationDraft.extracts : [];

  // Update the toggle label with the live count, preserving the current
  // expand/collapse glyph based on the list's hidden state. Mirrors
  // Fragment's "Show / Hide recorded actions (N)" pattern.
  if (toggleBtn) {
    const hidden = container.classList.contains('hidden');
    toggleBtn.textContent = hidden
      ? `▶ Show recorded extracts (${extracts.length})`
      : `▼ Hide recorded extracts (${extracts.length})`;
  }

  if (extracts.length === 0) {
    container.innerHTML = `<div class="empty-state small">No extracts recorded — re-walk to author.</div>`;
    return;
  }
  container.innerHTML = extracts.map((ex, i) => {
    const shape = ex.shape ?? '?';
    const out = ex.output ?? '?';
    // Per-extract family class. Free-extract shapes (image_snap, future
    // video_snap) take the teal + Free Extract button accent; everything
    // else takes the violet + Extract button accent. Matches the row
    // accent rule the sidepanel uses on its in-flight cards.
    const family = _isFreeExtractShape(shape) ? 'oa-recorded-extract-free' : 'oa-recorded-extract-picker';
    let target;
    if (shape === 'image_snap' && ex.rect) {
      const r = ex.rect;
      const dims = (Number.isFinite(r.width) && Number.isFinite(r.height))
        ? `${r.width}×${r.height}` : '?×?';
      const at = (Number.isFinite(r.x) && Number.isFinite(r.y))
        ? ` @ (${r.x}, ${r.y})` : '';
      target = `${dims}${at}`;
    } else {
      target = ex.target ?? '';
    }
    // Field count badge for list_of_records.
    const fieldCount = (shape === 'list_of_records' && Array.isArray(ex.fields))
      ? ex.fields.length : 0;
    const fieldsBadge = fieldCount > 0
      ? `<span class="action-enum-fields" title="${fieldCount} field${fieldCount === 1 ? '' : 's'} per record: ${escAttr(ex.fields.map(f => f.name).join(', '))}">+${fieldCount} field${fieldCount === 1 ? '' : 's'}</span>`
      : '';
    return `
      <div class="review-action-row ${family}">
        <span class="action-idx">${i + 1}</span>
        <span class="action-name action-${escAttr(shape)}">${escHtml(shape)}</span>
        <code class="action-selector">${escHtml(String(target).slice(0, 80))}</code>
        ${fieldsBadge}
        <code class="action-extract-target">→ {{${escHtml(out)}}}</code>
      </div>`;
  }).join('');
}

/**
 * Free-extract shapes use coordinate-based capture instead of a DOM
 * picker. Kept in sync with shapes/index.js#freeExtractShapes — when a
 * new free-extract shape lands (e.g. video_snap), add it here too.
 */
function _isFreeExtractShape(shape) {
  return shape === 'image_snap';
}

export function closeObservationForm() {
  $('observation-form-card')?.classList.add('hidden');
  observationDraft = null;
  libraryAssertionCache = [];
  libraryPerspectiveCache = [];
}

// Show/hide per-shape conditional rows. Called on form open + on shape change.

/**
 * v2.72.7 (Pass 3e) — Detect {{NAME}} param placeholders across all
 * substitutable string positions in an Observation record. Returns a
 * sorted unique array of param names (UPPERCASE_WITH_UNDERSCORES).
 *
 * Substitutable positions:
 *   - target selector
 *   - extract.name (when shape='scalar' and extract.kind='attribute')
 *   - fields[].selector (when shape='list_of_records')
 *   - fields[].extract.name (when field's extract.kind='attribute')
 *   - condition value fields in preconditions/postconditions
 *
 * Output binding name is NOT scanned — it's structural (the scope key),
 * not data, and parameterizing it would create instability.
 */
/**
 * Exported alias so the migration tool and JSON modal validator in
 * studio.js can detect params on Observation records they construct
 * outside the form lifecycle. Same logic as the internal version.
 */
export function detectObservationParams(obs) {
  return _detectObservationParams(obs);
}

function _detectObservationParams(obs) {
  const found = new Set();
  const PARAM_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
  const scan = (s) => {
    if (typeof s !== 'string' || !s) return;
    let m;
    PARAM_RE.lastIndex = 0;
    while ((m = PARAM_RE.exec(s))) found.add(m[1]);
  };

  // v2.74.21 — Multi-extract scan. Walks implementations[0].extracts
  // when present; falls back to legacy top-level fields for migration
  // tools that hand us a pre-pack draft.
  const extracts = Array.isArray(obs?.extracts)
    ? obs.extracts
    : (Array.isArray(obs?.implementations?.[0]?.extracts)
        ? obs.implementations[0].extracts : []);
  for (const ex of extracts) {
    scan(ex?.target);
    // v2.74.131 — Canonical `attribute` shape carries the name top-level.
    if (ex?.shape === 'attribute') scan(ex.attribute);
    // Legacy `scalar`-with-attribute.
    if (ex?.shape === 'scalar' && ex?.extract?.kind === 'attribute') {
      scan(ex.extract.attr ?? ex.extract.name);
    }
    if (ex?.shape === 'list_of_records' && Array.isArray(ex.fields)) {
      for (const f of ex.fields) {
        scan(f?.selector);
        if (f?.kind === 'attribute') scan(f.attr);
        if (f?.extract?.kind === 'attribute') scan(f.extract.attr ?? f.extract.name);
      }
    }
  }
  // Legacy single-extract fall-through (used by migration tools that
  // pass a flat draft pre-implementations).
  if (extracts.length === 0) {
    scan(obs?.target);
    if (obs?.shape === 'attribute') scan(obs.attribute);
    if (obs?.shape === 'scalar' && obs?.extract?.kind === 'attribute') {
      scan(obs.extract.attr ?? obs.extract.name);
    }
    if (obs?.shape === 'list_of_records' && Array.isArray(obs.fields)) {
      for (const f of obs.fields) {
        scan(f?.selector);
        if (f?.extract?.kind === 'attribute') scan(f.extract.attr ?? f.extract.name);
      }
    }
  }

  // Conditions: any string-valued field with {{NAME}} contributes.
  const scanConds = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      if (!c || typeof c !== 'object') continue;
      for (const v of Object.values(c)) scan(v);
    }
  };
  scanConds(obs?.preconditions);
  scanConds(obs?.postconditions);

  return [...found].sort();
}

/**
 * v2.72.7 (Pass 3e) — Refresh the live params preview block. Reads the
 * current observationDraft (which mutations from input listeners keep
 * up-to-date) and shows detected params or "none". Cheap — runs on every
 * relevant input, but the work is just a regex sweep over a few strings.
 */
function _refreshObservationParamsPreview() {
  const listEl = $('observation-params-preview-list');
  if (!listEl || !observationDraft) return;
  // v2.74.21 — Group params by extract so authors can see which extract
  // contributes which param. Conditions get their own line if they carry
  // any params. "none" appears when no source contributes a {{NAME}}
  // placeholder.
  const grouped = _detectObservationParamsGrouped(observationDraft);
  const extractRows = grouped.extracts.filter(g => g.params.length > 0);
  const condParams  = grouped.conditions;

  if (extractRows.length === 0 && condParams.length === 0) {
    listEl.textContent = 'none';
    listEl.classList.add('observation-params-preview-empty');
    return;
  }
  listEl.classList.remove('observation-params-preview-empty');
  const renderChips = (params) => params
    .map(p => `<code class="observation-param-chip">${escHtml(p)}</code>`)
    .join(' ');
  const rows = [];
  for (const row of extractRows) {
    rows.push(
      `<div class="observation-params-row">` +
        `<span class="observation-params-row-label">${escHtml(row.output)}</span>` +
        `<span class="observation-params-row-chips">${renderChips(row.params)}</span>` +
      `</div>`
    );
  }
  if (condParams.length > 0) {
    rows.push(
      `<div class="observation-params-row">` +
        `<span class="observation-params-row-label">conditions</span>` +
        `<span class="observation-params-row-chips">${renderChips(condParams)}</span>` +
      `</div>`
    );
  }
  listEl.innerHTML = rows.join('');
}

/**
 * v2.74.21 — Per-extract param attribution for the Detected params
 * preview. Returns:
 *   { extracts: [{output, params: string[]}, ...],
 *     conditions: string[] }
 *
 * Extracts that contribute no params still appear in the array (with
 * an empty params list); the renderer filters them out. Conditions are
 * collapsed across pre + post into a single set since the form treats
 * them symmetrically and ordering between pre/post doesn't carry meaning
 * for the params list.
 */
function _detectObservationParamsGrouped(obs) {
  const PARAM_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
  const collect = (s, into) => {
    if (typeof s !== 'string' || !s) return;
    let m;
    PARAM_RE.lastIndex = 0;
    while ((m = PARAM_RE.exec(s))) into.add(m[1]);
  };

  // Resolve extracts list from either flat draft (sidepanel) or
  // implementations[0].extracts (storage shape).
  const extracts = Array.isArray(obs?.extracts)
    ? obs.extracts
    : (Array.isArray(obs?.implementations?.[0]?.extracts)
        ? obs.implementations[0].extracts : []);

  const extractRows = [];
  for (const ex of extracts) {
    const found = new Set();
    collect(ex?.target, found);
    // v2.74.131 — Canonical `attribute` shape carries name top-level.
    if (ex?.shape === 'attribute') collect(ex.attribute, found);
    if (ex?.shape === 'scalar' && ex?.extract?.kind === 'attribute') {
      collect(ex.extract.attr ?? ex.extract.name, found);
    }
    if (ex?.shape === 'list_of_records' && Array.isArray(ex.fields)) {
      for (const f of ex.fields) {
        collect(f?.selector, found);
        if (f?.kind === 'attribute') collect(f.attr, found);
        if (f?.extract?.kind === 'attribute') collect(f.extract.attr ?? f.extract.name, found);
      }
    }
    extractRows.push({
      output: ex?.output || '(unnamed)',
      params: [...found].sort(),
    });
  }

  const condFound = new Set();
  const scanConds = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const c of arr) {
      if (!c || typeof c !== 'object') continue;
      for (const v of Object.values(c)) collect(v, condFound);
    }
  };
  scanConds(obs?.preconditions);
  scanConds(obs?.postconditions);

  return {
    extracts: extractRows,
    conditions: [...condFound].sort(),
  };
}

/**
 * v2.72.11 (Pass 8) — Tier-aware form rendering for the Observation form.
 * Mirrors renderAnalysisFormForTier exactly in shape: tier=null shows the
 * gating block, tier set shows the indicator + fields. Cache-tier shows
 * extraction config; frontier-tier hides it (Pass 9 will fill the
 * frontier-only fields).
 *
 * Pass 8: the frontier-tier choice button is disabled in HTML, so this
 * function is reachable only with tier=null or tier='cache'. The
 * tier='frontier' branch is reserved for Pass 9.
 */
function _renderObservationFormForTier() {
  if (!observationDraft) return;
  // v2.74.21 — Edit-only form. Tier is always set on a loaded record, so
  // gating never fires; we just surface the tier indicator. Shape /
  // target / extract / fields are no longer authored here (re-walk to
  // change), so the per-shape visibility helpers are gone.
  const gating = $('observation-tier-gating');
  const indicator = $('observation-tier-indicator');
  const indicatorValue = $('observation-tier-indicator-value');
  if (gating) gating.classList.add('hidden');
  if (indicator) indicator.classList.remove('hidden');
  if (indicatorValue && observationDraft.tier) {
    indicatorValue.textContent = observationDraft.tier === 'cache'
      ? 'Cache (DOM-based)'
      : 'Frontier (Vision-based)';
  }
  if (observationDraft.tier === 'frontier') _showFrontierDescriptionHint();
}

/**
 * v2.72.12 (Pass 9) — In frontier mode, the description field becomes
 * semantically meaningful: it's the LLM's instruction. Surface this so
 * authors know to write a precise capture target.
 *
 * Inserts (or removes) a hint node next to the description input.
 */
function _showFrontierDescriptionHint() {
  const descLabel = $('input-observation-description')?.closest('label');
  if (!descLabel) return;
  const existing = descLabel.querySelector('.frontier-description-hint');
  if (observationDraft?.tier === 'frontier') {
    if (!existing) {
      const hint = document.createElement('span');
      hint.className = 'frontier-description-hint field-hint';
      hint.textContent = 'In frontier mode, this description IS the LLM instruction. Write a precise capture target — name the specific element/region and any disambiguators (e.g. "the main product image", "the price in the header", "the chart on the right").';
      descLabel.appendChild(hint);
    }
  } else if (existing) {
    existing.remove();
  }
}

// v2.72.16 (Pass 7a) — Per-shape form configuration. Single source of
// truth for shape-conditional form behavior. Adding a new cache-tier
// shape: add a key here, add the <option data-tier="cache"> in studio.html,
// add the cacheShapes membership in _validateObservationRecord and JSON
// modal validator. Frontier shapes have their own visibility path
// (_renderObservationFormForTier handles tier=frontier separately) so
// they don't appear in this map.
//
// Field meanings:
//   - showsExtractRow:    true if shape needs the extract-kind row (scalar)
//   - showsFieldsSection: true if shape needs the fields editor (list_of_records)
//   - hint:               text under the shape select describing the shape
//   - targetHint:         text under the target selector
//   - targetPlaceholder:  placeholder text for the target input
// v2.74.21 — Per-shape config, visibility helper, and the list_of_records
// fields editor lived here. They drove form behavior for the legacy
// single-extract authoring surface, which has moved to the sidepanel
// observation-author mode. The Studio form is now edit-only and shows
// extracts read-only via _renderRecordedExtracts above.

// ─── v2.72.4 (Pass 3d) — Observation pre/post conditions ────────────────────
//
// Pre: page-state assertions (Services/Assertion.js). Same vocabulary as
//      Fragment pre/post. Reuses renderConditionEditor with context='observation'.
// Post: data-shape assertions (Services/DataAssertion.js). References OUTPUT.
//       Same vocabulary as Analysis post. Inline-rendered (parallel to
//       renderAnalysisConditionRow) with data-context='observation' attrs.
//
// Two different editors in one form. Asymmetry by design: page assertions
// don't apply to bound output, data assertions don't apply to live page.

function renderObservationConditions(which) {
  if (!observationDraft) return;
  const arr = which === 'pre' ? observationDraft.preconditions : observationDraft.postconditions;
  const listEl = $(which === 'pre' ? 'observation-pre-list' : 'observation-post-list');
  const countEl = $(which === 'pre' ? 'observation-pre-count' : 'observation-post-count');
  const sectionEl = $(which === 'pre' ? 'observation-pre-section' : 'observation-post-section');
  if (!listEl || !countEl) return;

  countEl.textContent = String(arr.length);

  // Auto-expand when conditions exist; collapse when empty (until user toggles).
  if (sectionEl && arr.length > 0 && !sectionEl.dataset.userToggled) {
    sectionEl.open = true;
  }

  if (arr.length === 0) {
    listEl.innerHTML = '<div class="observation-conditions-empty"><span class="field-hint">No conditions yet.</span></div>';
    return;
  }

  if (which === 'pre') {
    // Page-vocabulary editor. Route via observation context.
    // libraryAssertionCache: same library available to Fragment forms — page
    // and scope assertions on this Ground.
    const preds = libraryAssertionCache;
    // v2.72.31 (Pass 17a) — Perspectives for the perspective_ref picker.
    const locs = libraryPerspectiveCache;
    listEl.innerHTML = arr.map((cond, idx) => {
      const editorHtml = _renderConditionEditor(cond, { side: 'pre', idx }, {
        context: 'observation',
        assertions: preds,
        perspectives: locs,
        // Observation pre runs against the live page only — restrict to page family.
        allowedFamilies: ['page'],
      });
      return `
        <div class="review-condition-row" data-idx="${idx}">
          ${editorHtml}
          <button class="btn-action danger observation-cond-remove"
                  data-which="pre" data-idx="${idx}" title="Remove" type="button">✕</button>
        </div>`;
    }).join('');
  } else {
    // Data-vocabulary rows for post. Mirrors renderAnalysisConditionRow's
    // structure but routed via data-context='observation' so observation
    // handlers (added below) handle events.
    listEl.innerHTML = arr.map((cond, idx) => {
      const typeOpts = _buildConditionTypeOptions({
        allowedFamilies: ['scope'],
        assertions: libraryAssertionCache,
        iterScope: null,
        currentType: cond.type,
        currentPredId: cond.assertionId ?? '',
      });

      let fieldsHtml;
      if (cond.type === 'assertion_ref') {
        const refId = cond.assertionId;
        const lib = libraryAssertionCache;
        const matched = lib.find(p => p.id === refId);
        if (matched) {
          const desc = matched.description ?? '';
          fieldsHtml = desc
            ? `<span class="cond-pred-hint" title="${escAttr(matched.name ?? matched.id)}">${escHtml(desc)}</span>`
            : `<span class="cond-pred-hint cond-pred-hint-empty">no description</span>`;
        } else if (refId) {
          fieldsHtml = `<span class="cond-pred-hint cond-pred-hint-stale">missing assertion: ${escHtml(refId)}</span>`;
        } else {
          fieldsHtml = `<span class="cond-pred-hint cond-pred-hint-empty">— pick a assertion —</span>`;
        }
      } else {
        const schema = DATA_CONDITION_FIELDS[cond.type];
        const fields = schema?.fields ?? [];
        // Skip the binding field — implicitly OUTPUT for Observation post.
        fieldsHtml = fields.filter(fname => fname !== 'binding').map(fname => {
          const v = cond[fname] ?? '';
          let placeholder = fname;
          if (fname === 'fieldName') {
            placeholder = 'field name (e.g. TITLE)';
          } else if (fname === 'min' || fname === 'max') {
            placeholder = `${fname} (number or {{PARAM}})`;
          } else if (fname === 'count') {
            placeholder = 'exact count (number or {{PARAM}})';
          } else if (fname === 'value') {
            placeholder = 'value to match';
          } else if (fname === 'values') {
            placeholder = 'comma-separated values';
          }
          return `<input type="text" class="oc-field-input"
                  data-context="observation" data-which="post" data-idx="${idx}" data-field="${escAttr(fname)}"
                  value="${escAttr(v)}" placeholder="${escAttr(placeholder)}" />`;
        }).join('');
      }

      return `
        <div class="oc-row" data-idx="${idx}">
          <select class="oc-type-select" data-context="observation" data-which="post" data-idx="${idx}">
            ${typeOpts}
          </select>
          <div class="oc-fields">${fieldsHtml}</div>
          <button class="btn-action danger observation-cond-remove"
                  data-which="post" data-idx="${idx}" title="Remove" type="button">✕</button>
        </div>`;
    }).join('');
  }

  // ─── Wire handlers ────────────────────────────────────────────────────────
  // Pre-side: type select + value input via renderConditionEditor's classes.
  // Post-side: type select + value input via observation-specific .oc-* classes.
  // Both: row-remove button with data-which to route to the right array.

  if (which === 'pre') {
    listEl.querySelectorAll('.cond-type-select[data-context="observation"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx, 10);
        const decoded = _decodeConditionTypeValue(sel.value);
        const fresh = emptyCondition(decoded.type);
        if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
        if (decoded.perspectiveId) fresh.perspectiveId = decoded.perspectiveId;
        observationDraft.preconditions[idx] = fresh;
        renderObservationConditions('pre');
        _refreshObservationParamsPreview();
      });
    });
    listEl.querySelectorAll('.cond-value-input[data-context="observation"]').forEach(inp => {
      const handler = () => {
        const idx = parseInt(inp.dataset.idx, 10);
        const cond = observationDraft.preconditions[idx];
        if (!cond) return;
        const field = inp.dataset.field;
        if (CONDITION_FIELDS[cond.type]?.fields.includes(field)) {
          cond[field] = inp.value;
          _refreshObservationParamsPreview();
        }
      };
      inp.addEventListener('input', handler);
      inp.addEventListener('change', handler);
    });
  } else {
    listEl.querySelectorAll('.oc-type-select[data-context="observation"]').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = parseInt(sel.dataset.idx, 10);
        const decoded = _decodeConditionTypeValue(sel.value);
        const fresh = emptyCondition(decoded.type);
        if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
        if (decoded.perspectiveId) fresh.perspectiveId = decoded.perspectiveId;
        // Force binding=OUTPUT for scope conditions (mirrors Analysis post).
        if (CONDITION_FIELDS[decoded.type]?.fields?.includes('binding')) {
          fresh.binding = 'OUTPUT';
        }
        observationDraft.postconditions[idx] = fresh;
        renderObservationConditions('post');
        _refreshObservationParamsPreview();
      });
    });
    listEl.querySelectorAll('.oc-field-input[data-context="observation"]').forEach(inp => {
      const handler = () => {
        const idx = parseInt(inp.dataset.idx, 10);
        const cond = observationDraft.postconditions[idx];
        if (!cond) return;
        const field = inp.dataset.field;
        cond[field] = inp.value;
        _refreshObservationParamsPreview();
      };
      inp.addEventListener('input', handler);
      inp.addEventListener('change', handler);
    });
  }

  // Remove buttons (shared selector since both pre and post use it; data-which
  // disambiguates).
  listEl.querySelectorAll('.observation-cond-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = btn.dataset.which;
      const idx = parseInt(btn.dataset.idx, 10);
      const target = w === 'pre' ? observationDraft.preconditions : observationDraft.postconditions;
      target.splice(idx, 1);
      renderObservationConditions(w);
      _refreshObservationParamsPreview();
    });
  });
}

/**
 * v2.72.10 (bug review) — Validate an Observation record. Returns the
 * first error message string, or null if valid. Shared between the form's
 * saveObservation flow and the migration tool's save flow so both paths
 * apply the same checks.
 *
 * Mirrors the original inline checks in saveObservation. Doesn't validate
 * params — that's auto-detected, not authored.
 */
/**
 * Exported alias so the Fragment → Observation migration tool in
 * studio.js can apply the same field-level validation as form save.
 * Same logic as the internal version.
 */
export function validateObservationRecord(obs) {
  return _validateObservationRecord(obs);
}

function _validateObservationRecord(obs) {
  if (!obs?.name) return 'Observation name is required';

  // v2.74.21 — Multi-extract shape: validate the extracts list. Per-extract
  // bodies are authored in the sidepanel and validated there, so the studio
  // layer just confirms the list is non-empty. Authors can edit name /
  // description / pre/post conditions through this form without touching
  // extracts.
  const impl = (Array.isArray(obs?.implementations) && obs.implementations.length > 0)
    ? obs.implementations[0] : null;
  if (impl && Array.isArray(impl.extracts)) {
    if (impl.extracts.length === 0) {
      return 'Observation has no extracts — re-walk to author at least one';
    }
    return null;
  }

  // Legacy single-extract path (migration tool builds records in this
  // shape). Keep the original output/target/shape checks.
  if (!obs?.output) return 'Output binding name is required';
  if (!/^[A-Z][A-Z0-9_]*$/.test(obs.output)) {
    return 'Output binding should be UPPERCASE_WITH_UNDERSCORES (e.g. PAGE_TITLE)';
  }

  // v2.72.12 (Pass 9) — Tier-aware validation. The validator runs over a
  // pre-pack draft (top-level target/extract/fields) but tier may or may
  // not be set on the draft. Look at tier first; if absent (legacy callers
  // like the migration tool), default to cache rules.
  const tier = obs.tier ?? 'cache';
  // v2.72.14 (Pass 6) — section/image_refs added to cache shapes.
  const cacheShapes    = ['scalar', 'list_of_records', 'raw_text', 'raw_html', 'section', 'image_refs'];
  const frontierShapes = ['image', 'image_list'];

  if (tier === 'frontier') {
    if (!frontierShapes.includes(obs.shape)) {
      return `Frontier-tier requires shape 'image' or 'image_list' (got '${obs.shape}')`;
    }
    if (!obs.description || !obs.description.trim()) {
      return 'Frontier-tier Observation requires a description — the description is the instruction sent to the vision model.';
    }
    // Target is optional for frontier (empty = full screenshot).
    return null;
  }

  // Cache tier
  if (!cacheShapes.includes(obs.shape)) {
    return `Cache-tier shape must be one of ${cacheShapes.join(', ')} (got '${obs.shape}')`;
  }
  if (!obs?.target) return 'Target selector is required';

  // v2.74.131 — Canonical attribute shape.
  if (obs.shape === 'attribute') {
    if (typeof obs.attribute !== 'string' || obs.attribute.trim().length === 0) {
      return 'Attribute name is required for shape=attribute';
    }
  }
  if (obs.shape === 'scalar' && obs.extract?.kind === 'attribute') {
    if (!obs.extract.name) return 'Attribute name is required when extracting an attribute';
  }

  if (obs.shape === 'list_of_records') {
    const fields = obs.fields ?? [];
    if (fields.length === 0) return 'list_of_records needs at least one field';
    const seen = new Set();
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      const where = `field ${i + 1}`;
      if (!f.name) return `${where}: name is required`;
      if (!/^[A-Z][A-Z0-9_]*$/.test(f.name)) {
        return `${where}: name should be UPPERCASE_WITH_UNDERSCORES (got "${f.name}")`;
      }
      if (seen.has(f.name)) return `Duplicate field name "${f.name}" — each field must be unique`;
      seen.add(f.name);
      if (!f.selector) return `${where} ("${f.name}"): selector is required`;
      if (f.extract?.kind === 'attribute' && !f.extract.name) {
        return `${where} ("${f.name}"): attribute name is required when extracting an attribute`;
      }
    }
  }
  return null;
}

async function saveObservation() {
  if (!observationDraft) return;

  observationDraft.name        = $('input-observation-name').value.trim();
  observationDraft.description = $('input-observation-description').value.trim();

  if (!observationDraft.name) {
    toast('Observation name is required', 'err');
    return;
  }

  // v2.74.21 — Implementations are passed through verbatim from load.
  // Extract bodies are authored in the sidepanel; this form edits only
  // metadata + pre/post + description. Refuse to save if the loaded
  // record had no extracts (no implementation to preserve).
  const extracts = Array.isArray(observationDraft.extracts) ? observationDraft.extracts : [];
  if (extracts.length === 0 && (observationDraft.implementations ?? []).length === 0) {
    toast('Observation has no extracts. Use Walk Observation to author at least one.', 'err');
    return;
  }

  // Auto-detect params from extracts + condition values. Mirrors the
  // sidepanel author's _collectParams scan.
  observationDraft.params = _detectObservationParams(observationDraft);

  const { extracts: _exTmp, ...rest } = observationDraft;
  const toSave = {
    ...rest,
    // Implementations preserved verbatim — this form doesn't edit
    // extract bodies. Saving overwrites only metadata + pre/post.
    implementations: observationDraft.implementations,
  };

  const res = await new Promise(r => chrome.runtime.sendMessage({
    type: 'SAVE_OBSERVATION', payload: { observation: toSave },
  }, r));
  if (!res?.success) {
    toast(`Save failed: ${res?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast('Observation saved');
  closeObservationForm();
  await _refreshGroundList();
}

// v2.74.21 — The live-page selector picker (Pass 3c.0–3c.2) lived here.
// It powered the Studio form's "Pick on page" button and per-field Pick
// buttons for list_of_records. Studio is edit-only post-refactor; new
// authoring happens in the sidepanel observation-author mode, which has
// its own picker. All picker state, message listeners, and the candidate
// chooser have been removed.

// ─── Setup (one-time wiring) ────────────────────────────────────────────

/**
 * Wire all observation-form and picker-related button handlers and store
 * the injected dependencies. Called once at studio.js load time.
 *
 * @param {Object} opts
 * @param {Function} opts.refreshGroundList
 * @param {Function} opts.renderConditionEditor
 * @param {Function} opts.decodeConditionTypeValue
 * @param {Function} opts.buildConditionTypeOptions
 */
export function setupObservationForm({
  refreshGroundList,
  renderConditionEditor,
  decodeConditionTypeValue,
  buildConditionTypeOptions,
}) {
  _refreshGroundList = refreshGroundList;
  _renderConditionEditor = renderConditionEditor;
  _decodeConditionTypeValue = decodeConditionTypeValue;
  _buildConditionTypeOptions = buildConditionTypeOptions;

  // v2.74.21 — Form is edit-only. Removed: tier-choice handlers, shape /
  // extract-kind / attribute / target input handlers, + Add field, + Pick.
  // The sidepanel author mode owns extract authoring; this form edits
  // metadata + pre/post conditions only.
  $('btn-cancel-observation')?.addEventListener('click', closeObservationForm);
  $('btn-save-observation')?.addEventListener('click', saveObservation);

  // Description input change — refresh params preview in case a {{NAME}}
  // placeholder appears in a condition value down the line. (Description
  // itself isn't scanned for params.)
  $('input-observation-description')?.addEventListener('input', () => {
    if (observationDraft) observationDraft.description = $('input-observation-description').value;
  });

  // v2.72.4 (Pass 3d) — + Precondition / + Postcondition buttons.
  $('btn-add-observation-pre')?.addEventListener('click', () => {
    if (!observationDraft) return;
    if (!Array.isArray(observationDraft.preconditions)) observationDraft.preconditions = [];
    observationDraft.preconditions.push(emptyCondition('selector_present'));
    const sec = $('observation-pre-section');
    if (sec) { sec.open = true; sec.dataset.userToggled = '1'; }
    renderObservationConditions('pre');
  });
  $('btn-add-observation-post')?.addEventListener('click', () => {
    if (!observationDraft) return;
    if (!Array.isArray(observationDraft.postconditions)) observationDraft.postconditions = [];
    const defaultType = 'binding_is_list';
    const fresh = emptyCondition(defaultType);
    if (CONDITION_FIELDS[defaultType]?.fields?.includes('binding')) {
      fresh.binding = 'OUTPUT';
    }
    observationDraft.postconditions.push(fresh);
    const sec = $('observation-post-section');
    if (sec) { sec.open = true; sec.dataset.userToggled = '1'; }
    renderObservationConditions('post');
  });

  // Track user toggle of the section so auto-expand on render doesn't fight
  // with an explicit collapse.
  ['observation-pre-section', 'observation-post-section'].forEach(id => {
    $(id)?.addEventListener('toggle', (e) => {
      e.target.dataset.userToggled = '1';
    });
  });

  // v2.74.21 — Recorded extracts disclosure. Mirrors Fragment's
  // recorded-actions toggle: button flips the list's hidden class, then
  // re-renders so the button label refreshes ("▶ Show" ↔ "▼ Hide").
  $('observation-recorded-extracts-toggle')?.addEventListener('click', () => {
    const listEl = $('observation-recorded-extracts');
    if (!listEl) return;
    listEl.classList.toggle('hidden');
    _renderRecordedExtracts();
  });
}
