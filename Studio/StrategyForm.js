/**
 * @file Studio/StrategyForm.js
 * @description Strategy form authoring module. Owns the form lifecycle,
 * recursive body renderer, step-level event wiring, save handler, and all
 * strategy-form module state. Studio.js imports a small public surface
 * (form-open entry points + init wirings + ref-count helpers + a few
 * cross-module utilities); setupStrategyForm injects 5 shared helpers
 * defined in studio.js (renderConditionEditor, refreshGroundList,
 * buildConditionTypeOptions, decodeConditionTypeValue, addWarningIcon).
 *
 * Public surface (10 exports):
 *   Form lifecycle entry points:
 *     openStrategyForm(groundId, existing?)  — open or edit a Strategy
 *     editStrategy(strategyId)               — load by id then open
 *   Init wirings (called once from studio.js init):
 *     setupStrategyForm({...})               — inject shared helpers
 *     wireStrategyTopLevelInputs()           — top-level form inputs
 *     wireStrategySaveHandler()              — save button click
 *   Cross-cutting actions called from ground-list buttons:
 *     deleteStrategy(strategyId)
 *     testRunStrategy(strategyId)
 *   Reference-count helpers (called from Fragment/Observation delete):
 *     countStrategyRefsToFragment(groundId, fragmentId)
 *     countStrategyRefsToObservation(groundId, observationId)
 *
 * Everything else (renderers, step handlers, condition editors, helpers,
 * the 7 state vars) is module-internal. State lives here; the form module
 * is fully self-contained as of v2.73.2.
 *
 * Extraction history (Pass 4, completed v2.73.2):
 *   Pre-handoff (4-a): foundation helpers + reference counters.
 *   v2.72.97 (4-b): renderStrategyBindings, renderStrategySteps,
 *     wireStrategyTopLevelInputs (initially just result-template input).
 *   v2.72.98 (4-c): closeStrategyForm, wireTopLevelDragAndDrop, cancel.
 *   v2.72.99 (4-d): openStrategyForm + editStrategy + 13 add buttons +
 *     2 pre/post buttons + 2 toggle handlers (folded into wireStrategyTopLevelInputs).
 *   v2.73.0 (4-e): renderStrategyNodes (the 1011-line recursive renderer).
 *   v2.73.1 (4-f Phase 1): wireStrategyStepHandlers (800 lines of wiring).
 *   v2.73.2 (4-f Phase 2): wireStrategySaveHandler + state migration.
 *   v2.73.3: bug fix — bare refreshGroundList → _setup.refreshGroundList.
 *
 * Section headers further down ("Pass 1 helpers", "Pass 4-c additions",
 * etc.) preserve the chronological extraction pass each function arrived
 * in; useful for git-blame correlation. A logical regrouping by concern
 * is queued post-Pass-4.
 *
 * @module Studio/StrategyForm
 * @author Agent HUB
 */

import { StorageManager } from '../Services/StorageManager.js';
import { ChatAPI } from '../Services/ChatAPI.js';
import { CONDITION_FIELDS, emptyCondition } from '../Services/Assertion.js';
import { escHtml, escAttr, $, toast, uid, openSidepanelHere } from '../shared.js';
import { promptForParams } from '../Services/ParamForm.js';
// v2.72.99 (Pass 4-d) — openStrategyForm needs these for cache loading +
// body normalization + new-strategy ID generation.
import { BUILTIN_ANALYSES } from '../Services/BuiltinAnalyses.js';
// v2.74.72 — INPUT_TYPES / FILE_PARSERS no longer imported here. The typed-
// inputs editor moved to the Strategy form (studio.js); the Workflow form
// renders body-derived params only. normalizeStrategyParams kept for the
// defensive normalize in testRunStrategy.
import { normalizeStrategyBody, validateStrategyBody, normalizeStrategyParams } from '../Services/StrategyTree.js';

// ─── Module state (Pass 4-f Phase 2 — migrated from studio.js) ───────────
//
// All strategy form state lives here as module-locals. Previously these
// were declared in studio.js and accessed via _setup getters/setters; the
// implicit migration at the tail of Pass 4-f completed Pass 4 by moving
// state into the module that owns the form lifecycle.

let _strategyDraft = null;
let _strategyFragmentCache = new Map();
let _strategyAssertionCache = new Map();
let _strategyPerspectiveCache = new Map();
let _strategyAnalysisCache = new Map();
let _strategyObservationCache = new Map();
let _dragSourceIdx = null;


// ─── Pass 1 helpers ──────────────────────────────────────────────────────

/**
 * Pre-Iteration B (legacy) → Iteration B sieve migration.
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
 * @param {Array} steps         - strategy fragmentSteps (mutated in place)
 * @param {string} groundId
 * @param {string} strategyName - used for naming the auto-created Analysis
 * @returns {Promise<number>}   - count of sieve nodes migrated
 */
async function migrateLegacySieves(steps, groundId, strategyName) {
  let migratedCount = 0;
  let stepCounter = 0;
  const walk = async (nodes) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      stepCounter += 1;
      if (!node) continue;
      if (node.type === 'sieve') {
        // New shape already — skip.
        if (node.analysisId) {
          // Drop legacy operations field if it co-exists (shouldn't, but
          // be defensive).
          delete node.operations;
          continue;
        }
        // Legacy shape — create an Analysis from the operations.
        if (Array.isArray(node.operations) && node.operations.length > 0) {
          const analysisId = `analysis_migrated_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const analysis = {
            id: analysisId,
            groundId,
            name: `Inline sieve from "${strategyName}" #${stepCounter}`,
            description: `Migrated from inline sieve in strategy "${strategyName}". Source: ${node.source ?? '?'} → Output: ${node.output ?? '?'}.`,
            params: [],
            operations: node.operations,
          };
          try {
            await StorageManager.saveAnalysis(analysis);
            node.analysisId = analysisId;
            node.paramBindings = {};
            delete node.operations;
            migratedCount += 1;
          } catch (e) {
            console.error('[StrategyForm] Failed to migrate inline sieve:', e.message);
          }
        } else {
          // Empty or missing operations — node is broken either way; clear.
          delete node.operations;
        }
      }
      // Descend
      if (node.type === 'foreach')        await walk(node.body ?? []);
      else if (node.type === 'detect')    {
        for (const b of (node.branches ?? [])) await walk(b?.body ?? []);
        await walk(node.default ?? []);
      }
      else if (node.type === 'loop')      await walk(node.body ?? []);
      else if (node.type === 'try')       { await walk(node.body ?? []); await walk(node.recover ?? []); }
      else if (node.type === 'in_new_tab') await walk(node.body ?? []);
    }
  };
  await walk(steps);
  return migratedCount;
}

/**
 * Unwrap Iteration B `{conditions: [{...}]}` envelopes back to single
 * conditions for the legacy condition editor's UI shape. Walks DETECT
 * branches, LOOP conditions, WAIT-condition modes, FOREACH bodies, TRY
 * bodies/recover, and IN_NEW_TAB bodies recursively.
 *
 * If/when the editor gains compound assertion authoring (multiple
 * conditions per node with AND/OR), this adapter goes away.
 *
 * @param {Array<Object>} body - normalized strategy body
 * @returns {Array<Object>} body with conditions unwrapped in-place
 */
function unwrapAssertionConditionsForEditor(body) {
  if (!Array.isArray(body)) return body;
  for (const node of body) {
    if (!node || typeof node !== 'object') continue;
    if (node.type === 'detect') {
      for (const branch of node.branches ?? []) {
        if (branch?.condition && Array.isArray(branch.condition.conditions)) {
          branch.condition = branch.condition.conditions[0] ?? { type: 'selector_present', selector: '' };
        }
        unwrapAssertionConditionsForEditor(branch?.body ?? []);
      }
      unwrapAssertionConditionsForEditor(node.default ?? []);
    } else if (node.type === 'loop') {
      if (node.condition && Array.isArray(node.condition.conditions)) {
        node.condition = node.condition.conditions[0] ?? { type: 'selector_present', selector: '' };
      }
      unwrapAssertionConditionsForEditor(node.body ?? []);
    } else if (node.type === 'wait' && node.mode === 'condition') {
      if (node.condition && Array.isArray(node.condition.conditions)) {
        node.condition = node.condition.conditions[0] ?? { type: 'selector_present', selector: '' };
      }
    } else if (node.type === 'foreach') {
      unwrapAssertionConditionsForEditor(node.body ?? []);
    } else if (node.type === 'try') {
      unwrapAssertionConditionsForEditor(node.body ?? []);
      unwrapAssertionConditionsForEditor(node.recover ?? []);
    } else if (node.type === 'in_new_tab') {
      unwrapAssertionConditionsForEditor(node.body ?? []);
    }
  }
  return body;
}

/**
 * Walk a strategy-tree path and return the node at that path (or undefined).
 *
 * Path segments can be: array indices (numbers), 'body' (descend to the body
 * field), 'recover' (TRY recover field), 'default' (DETECT default field),
 * 'trigger' (IN_NEW_TAB trigger — a single node, acts as a one-element
 * collection for path purposes), or 'branches' (DETECT branches).
 */
function getNodeByPath(root, path) {
  let cur = root;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (seg === 'body' || seg === 'recover' || seg === 'default' || seg === 'branches') {
      cur = cur?.[seg];
    } else if (seg === 'trigger') {
      // J2: trigger is a single node. If the next segment is 0 (treating
      // it as a one-element list), descend. If next is something else
      // like 'body', that's navigating INTO the trigger — pass through.
      const next = path[i + 1];
      cur = cur?.trigger;
      if (next === 0) {
        // Skip the following 0 — it's addressing the trigger as element [0]
        i++;
      }
    } else {
      cur = cur?.[seg];
    }
    if (cur === undefined) return undefined;
  }
  return cur;
}

/**
 * Get the parent ARRAY and final index for a strategy-tree path.
 * Returns {arr, idx}.
 *
 * J2: trigger is a single-node slot, not an array element. For paths whose
 * second-to-last segment is 'trigger' (like [0, 'trigger', 0]), we return
 * a synthetic "trigger slot" handle: arr is the parent IN_NEW_TAB node,
 * idx is the sentinel string 'trigger'. The caller (node-remove etc.) is
 * responsible for recognizing this and acting accordingly (set parent.trigger
 * = null instead of splice).
 */
function getParentArrayAndIndex(rootArr, path) {
  if (path.length === 0) return { arr: rootArr, idx: -1 };
  // J2: detect trigger-slot paths
  if (path.length >= 2 && path[path.length - 2] === 'trigger' && path[path.length - 1] === 0) {
    const parentNodePath = path.slice(0, -2);
    const parentNode = parentNodePath.length === 0
      ? null   // shouldn't happen — IN_NEW_TAB can't be at root with this path shape
      : getNodeByPath(rootArr, parentNodePath);
    if (parentNode && parentNode.type === 'in_new_tab') {
      return { arr: parentNode, idx: 'trigger' };
    }
  }
  const parentPath = path.slice(0, -1);
  const lastIdx = path[path.length - 1];
  let arr;
  if (parentPath.length === 0) {
    arr = rootArr;
  } else {
    arr = getNodeByPath(rootArr, parentPath);
  }
  return { arr, idx: lastIdx };
}

/**
 * Count strategies on this Ground that reference the given Fragment.
 * Used to surface migration impact ("X strategies still reference this
 * Fragment after you migrate").
 */
export async function countStrategyRefsToFragment(groundId, fragmentId) {
  try {
    const strategies = await StorageManager.listStrategies(groundId);
    let count = 0;
    const walk = (nodes) => {
      for (const n of nodes ?? []) {
        if (!n || typeof n !== 'object') continue;
        if ((n.type === 'fragment' || !n.type) && n.fragmentId === fragmentId) {
          count++;
        }
        if (Array.isArray(n.body)) walk(n.body);
        if (Array.isArray(n.recover)) walk(n.recover);
        if (Array.isArray(n.default)) walk(n.default);
        if (Array.isArray(n.branches)) {
          for (const b of n.branches) walk(b?.body);
        }
        if (n.trigger) walk([n.trigger]);
      }
    };
    for (const s of strategies) walk(s.fragmentSteps);
    return count;
  } catch (_) {
    return 0;
  }
}

/**
 * v2.72.10 (bug review) — Count strategy nodes referencing this Observation
 * across all strategies on the same Ground. Used by the delete-observation
 * handler to warn the user before they break strategy references.
 *
 * Walks the same strategy structure as countStrategyRefsToFragment.
 * Observation nodes have type='observation' and observationId.
 */
export async function countStrategyRefsToObservation(groundId, observationId) {
  try {
    const strategies = await StorageManager.listStrategies(groundId);
    let count = 0;
    const walk = (nodes) => {
      for (const n of nodes ?? []) {
        if (!n || typeof n !== 'object') continue;
        if (n.type === 'observation' && n.observationId === observationId) {
          count++;
        }
        if (Array.isArray(n.body)) walk(n.body);
        if (Array.isArray(n.recover)) walk(n.recover);
        if (Array.isArray(n.default)) walk(n.default);
        if (Array.isArray(n.branches)) {
          for (const b of n.branches) walk(b?.body);
        }
        if (n.trigger) walk([n.trigger]);
      }
    };
    for (const s of strategies) walk(s.fragmentSteps);
    return count;
  } catch (_) {
    return 0;
  }
}

// v2.74.68 — labPromptForParams retired. testRunStrategy now uses
// Services/ParamForm.js (promptForParams), which renders typed controls
// (string / number / boolean / file) plus the same list-kind textarea
// this function used to provide. One module owns the invocation form for
// both chat and Studio so future param types land everywhere at once.

// ─── Pass 2: condition rendering ─────────────────────────────────────────
//
// renderStrategyConditions and renderStrategyConditionRow render the
// pre/post condition lists in the strategy form. They're tightly coupled
// to _strategyDraft (preconditions/postconditions arrays) and the
// assertion + perspective caches. Initially extracted with _setup getter
// access; state migrated to module-locals in Pass 4-f Phase 2 (v2.73.2).

/**
 * v2.72.24 (Pass 13) — Render the strategy form pre/post condition list.
 * Parallels renderAnalysisConditions but accepts both page and scope
 * family conditions (strategies evaluate pre/post against the live tab
 * AND the scope; both are valid).
 *
 * v2.72.71 — Originally moved between studio.js and AnalysisForm.js
 * because of mis-placement. v2.72.84 (Pass 2): moved to StrategyForm.js.
 *
 * @param {string} which - 'pre' or 'post'
 */
function renderStrategyConditions(which) {
  const strategyDraft = _strategyDraft;
  if (!strategyDraft) return;
  const arr = which === 'pre' ? strategyDraft.preconditions : strategyDraft.postconditions;
  const listEl = $(which === 'pre' ? 'strategy-pre-list' : 'strategy-post-list');
  const countEl = $(which === 'pre' ? 'strategy-pre-count' : 'strategy-post-count');
  const sectionEl = $(which === 'pre' ? 'strategy-pre-section' : 'strategy-post-section');
  if (!listEl || !countEl) return;

  countEl.textContent = String(arr.length);

  // Auto-expand when there are conditions; collapse when empty (unless
  // user toggled). Mirrors renderAnalysisConditions.
  if (sectionEl && arr.length > 0 && !sectionEl.dataset.userToggled) {
    sectionEl.open = true;
  }

  if (arr.length === 0) {
    listEl.innerHTML = '<div class="analysis-conditions-empty"><span class="field-hint">No conditions yet.</span></div>';
    return;
  }

  listEl.innerHTML = arr.map((cond, idx) => renderStrategyConditionRow(cond, idx, which)).join('');

  // ── Type-select change: replace condition with new type, preserve common fields ──
  listEl.querySelectorAll('[data-action="sc-type"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const w = sel.dataset.which;
      const idx = parseInt(sel.dataset.idx, 10);
      const draft = _strategyDraft;
      if (!draft) return;
      const target = w === 'pre' ? draft.preconditions : draft.postconditions;
      if (!target[idx]) return;
      const decoded = _setup.decodeConditionTypeValue(sel.value);
      const newType = decoded.type;
      const fresh = emptyCondition(newType);
      const oldFieldsByName = { ...target[idx] };
      for (const f of CONDITION_FIELDS[newType]?.fields ?? []) {
        if (oldFieldsByName[f] != null) fresh[f] = oldFieldsByName[f];
      }
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.perspectiveId) fresh.perspectiveId = decoded.perspectiveId;
      target[idx] = fresh;
      renderStrategyConditions(w);
    });
  });

  // ── Field input change: write directly to draft, no re-render ──
  listEl.querySelectorAll('[data-action="sc-field"]').forEach(inp => {
    const handler = () => {
      const w = inp.dataset.which;
      const idx = parseInt(inp.dataset.idx, 10);
      const fname = inp.dataset.field;
      const draft = _strategyDraft;
      if (!draft) return;
      const target = w === 'pre' ? draft.preconditions : draft.postconditions;
      if (target[idx]) target[idx][fname] = inp.value;
    };
    inp.addEventListener('input', handler);
    inp.addEventListener('change', handler);
  });

  // ── Remove button: splice and re-render ──
  listEl.querySelectorAll('[data-action="sc-remove"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const w = btn.dataset.which;
      const idx = parseInt(btn.dataset.idx, 10);
      const draft = _strategyDraft;
      if (!draft) return;
      const target = w === 'pre' ? draft.preconditions : draft.postconditions;
      target.splice(idx, 1);
      renderStrategyConditions(w);
    });
  });
}

// v2.74.155 — Render the Results section (declared outputs that the
// Strategy promotes to the parent Workflow's scope).
//
// One row per output: a name input + remove button. The input has a
// datalist suggesting names produced by the body (OBSERVATION extracts,
// SIEVE outputs, Analysis outputs — see collectStrategyProducers).
// Free-text input is supported so authors can declare output names that
// aren't yet present in the body (forward-declaration). Runtime treats
// the declared list as a filter; names that the body doesn't end up
// binding simply don't promote — no hard error.
//
// Auto-expand mirrors the conditions section: open when entries exist
// and the user hasn't manually collapsed, collapsed-with-empty-state
// when zero rows.
function renderStrategyOutputs() {
  const draft = _strategyDraft;
  if (!draft) return;
  const arr = Array.isArray(draft.outputs) ? draft.outputs : (draft.outputs = []);
  const listEl    = $('strategy-outputs-list');
  const countEl   = $('strategy-outputs-count');
  const sectionEl = $('strategy-outputs-section');
  if (!listEl || !countEl) return;

  countEl.textContent = String(arr.length);

  if (sectionEl && arr.length > 0 && !sectionEl.dataset.userToggled) {
    sectionEl.open = true;
  }

  // v2.74.160 — Each Results row is a `<select>` dropdown populated
  // from the body's producer set (OBSERVATION extracts, SIEVE outputs,
  // Analysis outputs). Free-text + datalist was too permissive — users
  // could type names that didn't exist, and the autocomplete dropdown
  // wasn't browser-consistent. The select-only form forces every
  // declared output to be a name the body actually produces; orphaned
  // selections (e.g. the producing step was removed after declaring
  // the Result) survive in the dropdown as a stale option so the user
  // can see what's no longer valid and fix it.
  //
  // v2.74.161 — Pass all three caches so the walker can resolve
  // observation extract names (impl.extracts[].output), analysis
  // body outputs (template/transform), AND fragment EXTRACT /
  // ENUMERATE / EMIT targets (parsed from rawJson). The previous
  // version only looked at node-level fields, which meant observations
  // and fragments contributed nothing — the typical case for any
  // body that didn't inline its extracts.
  //
  // Strategy input params are also surfaced here. They flow through
  // extractedValues at runtime (the engine echoes them back), so an
  // author who wants an input to land in the parent Workflow's scope
  // declares it as a Result like any body-produced binding.
  const bodyProducers = collectStrategyProducers(
    draft.fragmentSteps,
    _strategyAnalysisCache,
    _strategyObservationCache,
    _strategyFragmentCache,
  );
  // Strategy input param names. The form derives params from body
  // references at save time (collectStrategyParams returns a Map
  // keyed by referenced names — the {{PARAM}} tokens in fragment
  // selectors, navigate URLs, observation paramBindings, etc.). At
  // render time we compute the same set live so the Results dropdown
  // includes them — inputs flow through extractedValues at runtime
  // and a Strategy author may legitimately want to promote one as a
  // Result so it lands in the parent Workflow's scope.
  const inputParamNames = [...collectStrategyParams(draft.fragmentSteps).keys()];
  // Producer union: body-produced names + strategy input param names.
  // Dedupes naturally via Set; sorted for stable dropdown order.
  const producerNames = [...new Set([...bodyProducers, ...inputParamNames])].sort();

  if (arr.length === 0) {
    listEl.innerHTML = '<div class="analysis-conditions-empty"><span class="field-hint">No results declared yet — when empty, all final-scope bindings flow up to the parent Workflow (back-compat behavior).</span></div>';
    return;
  }

  // Names already declared by OTHER rows (so the dropdown for row N
  // can grey out duplicates — same name twice has no semantic value).
  const declaredElsewhere = (currentIdx) => {
    const set = new Set();
    for (let i = 0; i < arr.length; i++) {
      if (i === currentIdx) continue;
      const n = String(arr[i]?.name ?? '').trim();
      if (n) set.add(n);
    }
    return set;
  };

  listEl.innerHTML = arr.map((row, idx) => {
    const current = String(row?.name ?? '');
    const otherSelections = declaredElsewhere(idx);
    // Build the option list: producers first, sorted. If `current` is
    // set but not in producers (orphan — body changed after Results
    // was authored), surface it with a stale marker so the author can
    // diagnose; the option stays selectable so save still round-trips
    // until they replace it.
    const opts = [];
    opts.push(`<option value=""${current === '' ? ' selected' : ''}>— pick a binding —</option>`);
    let currentInProducers = false;
    for (const n of producerNames) {
      if (n === current) currentInProducers = true;
      const isOther = otherSelections.has(n);
      const disabledAttr = isOther ? ' disabled' : '';
      const selectedAttr = n === current ? ' selected' : '';
      const label = isOther ? `${n} (already added)` : n;
      opts.push(`<option value="${escAttr(n)}"${selectedAttr}${disabledAttr}>${escHtml(label)}</option>`);
    }
    if (current && !currentInProducers) {
      // Orphan — the body no longer produces this name. Show with a
      // "stale" marker so the author understands why the dropdown
      // doesn't list it under producers.
      opts.push(`<option value="${escAttr(current)}" selected>${escHtml(current)} (stale — body no longer produces this)</option>`);
    }
    const emptyHint = producerNames.length === 0
      ? `<span class="field-hint" style="margin-left:8px">no body bindings yet — add an OBSERVATION, SIEVE, or Analysis step first</span>`
      : '';
    return `
      <div class="ac-row">
        <select class="ac-field-input"
                data-action="so-name" data-idx="${idx}">
          ${opts.join('')}
        </select>
        ${emptyHint}
        <button class="btn-action danger"
                data-action="so-remove" data-idx="${idx}"
                title="Remove result">✕</button>
      </div>`;
  }).join('');

  listEl.querySelectorAll('select[data-action="so-name"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = parseInt(sel.dataset.idx, 10);
      const d = _strategyDraft;
      if (!d || !d.outputs?.[idx]) return;
      d.outputs[idx].name = sel.value.trim();
      // Re-render so dropdowns on OTHER rows recompute their "already
      // added" disabled options now that the current selection
      // changed. Cheap — outputs list is small.
      renderStrategyOutputs();
    });
  });

  listEl.querySelectorAll('[data-action="so-remove"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.idx, 10);
      const d = _strategyDraft;
      if (!d || !Array.isArray(d.outputs)) return;
      d.outputs.splice(idx, 1);
      renderStrategyOutputs();
    });
  });
}

/**
 * v2.72.24 (Pass 13) — Render a single condition row inside the strategy
 * form's pre/post list. Accepts page-family AND scope-family conditions;
 * the per-type inputs handle both vocabularies. Reused for both pre and
 * post sections via the `which` parameter.
 *
 * Fields wire through data-action="sc-field" / "sc-type" / "sc-remove",
 * scoped to draft.preconditions[idx] / postconditions[idx] in the
 * change handlers (renderStrategyConditions wires them).
 */
function renderStrategyConditionRow(cond, idx, which) {
  const assertionCache = _strategyAssertionCache;
  const perspectiveCache    = _strategyPerspectiveCache;
  // Type dropdown: both families allowed. Custom group filtered by
  // family-compat — assertions with both page and scope children are fine
  // in the strategy form because the engine evaluates each by family.
  const typeOpts = _setup.buildConditionTypeOptions({
    allowedFamilies: ['page', 'scope'],
    assertions: [...assertionCache.values()],
    perspectives: [...perspectiveCache.values()],
    iterScope: null,
    currentType: cond.type,
    currentPredId: cond.assertionId ?? '',
    currentPerspectiveId: cond.perspectiveId ?? '',
  });

  // Per-type fields. Page-side types use selector / pattern / text /
  // attribute / value. Scope-side types use the schema-driven fields
  // (binding, min, max, count, value, values, fieldName, variable).
  // assertion_ref renders the picked assertion's description as a hint.
  // perspective_ref (Pass 17) renders the picked perspective's landmark count.
  let fieldsHtml;
  if (cond.type === 'assertion_ref') {
    const refId = cond.assertionId;
    const matched = [...assertionCache.values()].find(p => p.id === refId);
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
  } else if (cond.type === 'perspective_ref') {
    const refId = cond.perspectiveId;
    const matched = [...perspectiveCache.values()].find(l => l.id === refId);
    if (matched) {
      const lmCount = Array.isArray(matched.landmarks) ? matched.landmarks.length : 0;
      const summary = `${lmCount} landmark${lmCount === 1 ? '' : 's'}`;
      fieldsHtml = `<span class="cond-pred-hint" title="${escAttr(matched.description ?? '')}">${escHtml(summary)}</span>`;
    } else if (refId) {
      fieldsHtml = `<span class="cond-pred-hint cond-pred-hint-stale">missing perspective: ${escHtml(refId)}</span>`;
    } else {
      fieldsHtml = `<span class="cond-pred-hint cond-pred-hint-empty">— pick a perspective from the dropdown —</span>`;
    }
  } else {
    // Generic schema-driven field rendering. CONDITION_FIELDS includes
    // both page-family and scope-family schemas. Each schema lists its
    // fields; we render text inputs for each. This unifies page and
    // scope condition rendering in the strategy form.
    const schema = CONDITION_FIELDS[cond.type];
    const fields = schema?.fields ?? [];
    fieldsHtml = fields.map(fname => {
      const v = cond[fname] ?? '';
      let placeholder = fname;
      if (fname === 'selector')   placeholder = 'CSS selector (e.g. .product-grid)';
      else if (fname === 'pattern')    placeholder = 'URL substring or /regex/';
      else if (fname === 'text')       placeholder = 'text to match (case-insensitive)';
      else if (fname === 'attribute')  placeholder = 'attribute name (e.g. aria-pressed)';
      else if (fname === 'value')      placeholder = 'expected value';
      else if (fname === 'binding')    placeholder = 'scope binding name (e.g. RESULT)';
      else if (fname === 'min' || fname === 'max') placeholder = `${fname} (number)`;
      else if (fname === 'count')      placeholder = 'exact count (number)';
      else if (fname === 'values')     placeholder = 'comma-separated values';
      else if (fname === 'fieldName')  placeholder = 'field name (e.g. price)';
      else if (fname === 'variable')   placeholder = 'iteration variable name';
      return `<input type="text" class="ac-field-input" data-action="sc-field" data-which="${escAttr(which)}" data-idx="${idx}" data-field="${escAttr(fname)}" value="${escAttr(v)}" placeholder="${escAttr(placeholder)}" />`;
    }).join('');
  }

  return `
    <div class="ac-row">
      <select class="ac-type-select" data-action="sc-type" data-which="${escAttr(which)}" data-idx="${idx}">
        ${typeOpts}
      </select>
      <div class="ac-fields">${fieldsHtml}</div>
      <button class="btn-action danger" data-action="sc-remove" data-which="${escAttr(which)}" data-idx="${idx}" title="Remove condition">✕</button>
    </div>`;
}


// ─── Pass 3: param preview + composition analysis ────────────────────────
//
// All five functions in this section are pure-ish — they read state via
// injected getters but do no mutation, no async, no DOM event wiring.
// renderStrategyParamsPreview and renderStrategyWarnings touch the DOM
// (innerHTML assignments and querySelector calls); collectStrategyParams,
// detectStrategyParamConflicts, and analyzeStrategyComposition are full
// pure functions on passed-in data.

function renderStrategyParamsPreview() {
  const el = $('strategy-params-preview');
  if (!_strategyDraft) { el.classList.add('hidden'); el.innerHTML = ''; return; }

  const derivedParams = collectStrategyParams(_strategyDraft.fragmentSteps);

  if (derivedParams.size === 0) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }

  // v2.59.0 — chips show kind for list-typed params so the author can see at
  // a glance which inputs expect a list of values.
  // v2.74.72 — Typed-input annotations dropped from this preview; typed
  // inputs are now authored on the parent Strategy form (studio.js), not
  // here. The Workflow form's only param surface is the body-derived chip
  // strip below — a pure read-only view of what {{NAME}} references exist.
  const sortedEntries = [...derivedParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const chips = sortedEntries.map(([name, info]) => {
    const kindLabel = info.kind === 'list' ? ' (list)' : '';
    return `<code class="strategy-param-chip">${escHtml(name)}${escHtml(kindLabel)}</code>`;
  }).join('');
  el.innerHTML = `<span class="strategy-params-label">Inputs</span> <span class="strategy-params-chips">${chips}</span>`;
  el.classList.remove('hidden');
}

// v2.74.72 — renderStrategyInputsEditor and _renderInputRow removed.
// The typed-inputs editor now lives on the Strategy form (studio.js).
// Body-derived params from the chip preview above are persisted at save
// time as canonical [{name, kind, type:'string', required:true}] entries.

/**
 * Extract the unique set of strategy-level param names referenced by any
 * `strategy_param` binding across all fragment steps.
 */
/**
 * Extract the strategy-level params referenced by the body. Returns a Map
 * keyed by name with `{ kind, sources }` per entry:
 *
 *   kind     — 'scalar' or 'list', inferred from how the name is used.
 *              FOREACH `over` references → list. NAVIGATE URL template
 *              `{name}` references → scalar. Fragment param bindings of
 *              kind 'strategy_param' → scalar. NAVIGATE url binding of
 *              kind 'strategy_param' → scalar.
 *   sources  — array of strings describing where the name was seen
 *              (used for conflict-warning messages).
 *
 * If a name is referenced as both a FOREACH source AND as a scalar (e.g.
 * a URL template variable with the same name), the kind is set to whichever
 * came first; both sources are recorded so the save path can surface a
 * conflict warning.
 *
 * Names bound by an enclosing FOREACH (i.e. matching the `as` of an
 * outer FOREACH) are NOT strategy inputs — they're iteration variables.
 * The walker tracks the iteration-name stack and skips matches.
 *
 * v2.59.0 — return type changed from Set<name> to Map<name, info> to carry
 * kind information needed by the Lab modal and the engine's seeding loop.
 */
// v2.74.155 / v2.74.161 — Producer walker for the Results section.
//
// Returns the set of scope binding names available at the Strategy's
// final-scope boundary — the candidates that can be promoted to the
// parent Workflow's context via the Results filter. Used to populate
// the Results dropdown so authors pick from known bindings instead of
// typing names that don't exist.
//
// Producers covered (v2.74.161 — now reads through all three caches):
//   - OBSERVATION nodes: the cached record's
//       implementations[0].extracts[].output (canonical, post-v2.72.11)
//       and legacy top-level observation.extracts[].output (pre-migration)
//     Plus any node.output / node.extracts directly attached to the
//     node (legacy frontier shape).
//   - SIEVE node.output.
//   - Analysis nodes: the cached analysis record's body kind determines
//     the producers — operations/frontier → node.output; template /
//     transform bodies → declared body.outputs[].name.
//   - FRAGMENT nodes: parsed rawJson EXTRACT / ENUMERATE / EMIT
//     `target` names from the cached fragment record. These are the
//     binding writes that flow into Strategy scope at runtime
//     (TemplateWalker.#executeFragment scope.set on each target).
//
// FOREACH `as` is intentionally excluded — iteration variables live
// inside the body scope and don't survive past the FOREACH end.
function collectStrategyProducers(fragmentSteps, analysisCache, observationCache, fragmentCache) {
  const out = new Set();

  const walk = (nodes) => {
    for (const node of nodes ?? []) {
      if (!node) continue;
      const type = node.type ?? 'fragment';

      if (type === 'observation') {
        // Direct-on-node fallbacks for legacy / inline forms.
        if (node.output) out.add(String(node.output));
        for (const ex of (node.extracts ?? [])) {
          if (ex?.output) out.add(String(ex.output));
        }
        // v2.74.161 — Look up the cached observation and walk its
        // declared extracts. The typical node shape carries only
        // `observationId` + `paramBindings` — the actual extract
        // names (DIVISION_NAME, etc.) are on the record's
        // implementations[0].extracts list.
        const obs = node.observationId ? observationCache?.get?.(node.observationId) : null;
        const obsImpl0 = obs && Array.isArray(obs.implementations) && obs.implementations.length > 0
          ? obs.implementations[0] : null;
        for (const ex of (obsImpl0?.extracts ?? [])) {
          if (ex?.output) out.add(String(ex.output));
        }
        // Legacy flat-shape (pre-implementations envelope).
        for (const ex of (obs?.extracts ?? [])) {
          if (ex?.output) out.add(String(ex.output));
        }
      } else if (type === 'sieve') {
        if (node.output) out.add(String(node.output));
      } else if (type === 'analysis') {
        const cachedAnalysis = node.analysisId ? analysisCache?.get?.(node.analysisId) : null;
        const impl0 = cachedAnalysis && Array.isArray(cachedAnalysis.implementations) && cachedAnalysis.implementations.length > 0
          ? cachedAnalysis.implementations[0] : null;
        const bodyKind = impl0?.body?.kind;
        if (bodyKind === 'template' || bodyKind === 'transform') {
          const declared = Array.isArray(impl0?.body?.outputs) ? impl0.body.outputs : [];
          for (const o of declared) {
            if (o?.name) out.add(String(o.name));
          }
        } else if (node.output) {
          out.add(String(node.output));
        }
      } else if (type === 'foreach') {
        walk(node.body);
      } else if (type === 'detect') {
        for (const branch of node.branches ?? []) walk(branch?.body);
        walk(node.default);
      } else if (type === 'loop') {
        walk(node.body);
      } else if (type === 'try') {
        walk(node.body);
        walk(node.recover);
      } else if (type === 'in_new_tab') {
        if (node.trigger) walk([node.trigger]);
        walk(node.body);
      } else if (type === 'fragment' || !node.type) {
        // v2.74.161 — Fragment EXTRACT / ENUMERATE / EMIT outputs.
        // The fragment's rawJson is a JSON-stringified array of action
        // objects; each writes a scope binding under action.target.
        // Mirrors the existing walkForeachRefs walker (line ~1158)
        // which scans the same fields for FOREACH source candidates.
        const f = node.fragmentId ? fragmentCache?.get?.(node.fragmentId) : null;
        if (f?.rawJson) {
          let actions;
          try { actions = JSON.parse(f.rawJson); } catch { actions = []; }
          if (Array.isArray(actions)) {
            for (const a of actions) {
              if (!a) continue;
              if ((a.action === 'EXTRACT' || a.action === 'ENUMERATE' || a.action === 'EMIT') && a.target) {
                out.add(String(a.target));
              }
            }
          }
        }
      }
      // wait / pause / navigate / scroll — no scope-level producers.
    }
  };
  walk(fragmentSteps);
  return out;
}

function collectStrategyParams(fragmentSteps) {
  const out = new Map(); // name → { kind, sources: [string] }

  // Adds a referenced name with its inferred kind. If the name is already
  // present with a different kind, both sources are recorded but the first-
  // seen kind wins (deterministic).
  const addRef = (name, kind, source, iterStack) => {
    if (!name) return;
    // Iteration variables shadow strategy params — skip if bound by an
    // enclosing FOREACH.
    if (iterStack.includes(name)) return;
    const existing = out.get(name);
    if (existing) {
      existing.sources.push(source);
    } else {
      out.set(name, { kind, sources: [source] });
    }
  };

  // Find {name} references in a literal URL string (used by NAVIGATE URL
  // template substitution at runtime — same regex as the engine).
  const TEMPLATE_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  const collectTemplateRefs = (urlStr, iterStack) => {
    if (typeof urlStr !== 'string') return;
    let m;
    TEMPLATE_RE.lastIndex = 0;
    while ((m = TEMPLATE_RE.exec(urlStr)) !== null) {
      addRef(m[1], 'scalar', `NAVIGATE URL template {${m[1]}}`, iterStack);
    }
  };

  const walk = (nodes, iterStack) => {
    for (const node of nodes ?? []) {
      if (!node) continue;
      if (node.type === 'foreach') {
        // FOREACH `over` is a list source. Record it as a list-kind input,
        // unless it's bound by an even-outer FOREACH (rare but valid —
        // nested FOREACHs over the same variable name).
        if (node.over) addRef(node.over, 'list', `FOREACH over "${node.over}"`, iterStack);
        // Inside the body, `as` shadows any enclosing strategy param of the
        // same name.
        const newStack = node.as ? [...iterStack, node.as] : iterStack;
        walk(node.body, newStack);
      } else if (node.type === 'wait') {
        continue;
      } else if (node.type === 'pause') {
        // v2.60.0 — PAUSE has no params. Skip cleanly.
        continue;
      } else if (node.type === 'sieve') {
        // v2.61.0 — SIEVE source/output are list bindings in scope, not
        // strategy params. v2.63.1 — but paramBindings can reference
        // strategy params via {kind:'strategy_param', name:'X'}; those
        // contribute. Iteration_variable bindings are consumed locally
        // and don't surface as strategy params (same treatment as
        // fragment bindings).
        for (const [paramName, binding] of Object.entries(node.paramBindings ?? {})) {
          if (binding?.kind === 'strategy_param' && binding.name) {
            addRef(binding.name, 'scalar', `SIEVE param "${paramName}"`, iterStack);
          }
        }
        continue;
      } else if (node.type === 'detect') {
        for (const branch of node.branches ?? []) {
          walk(branch?.body, iterStack);
        }
        walk(node.default, iterStack);
      } else if (node.type === 'loop') {
        walk(node.body, iterStack);
      } else if (node.type === 'try') {
        walk(node.body, iterStack);
        walk(node.recover, iterStack);
      } else if (node.type === 'navigate') {
        if (node.mode === 'url') {
          // Two paths into params: the binding kind itself...
          if (node.url?.kind === 'strategy_param' && node.url.name) {
            addRef(node.url.name, 'scalar', `NAVIGATE url binding "${node.url.name}"`, iterStack);
          }
          // ...and {name} template substitutions inside the literal URL or
          // inside a strategy_param/iteration_variable that resolves to a
          // template string. Only literals are statically inspectable; the
          // dynamic case is checked at runtime.
          if (node.url?.kind === 'literal' && typeof node.url.value === 'string') {
            collectTemplateRefs(node.url.value, iterStack);
          }
        }
      } else if (node.type === 'scroll') {
        // v2.72.3 (Pass 4 audit) — SCROLL distance bindings can reference
        // strategy_params. Pre-v2.72.3 SCROLL silently fell into the
        // implicit-fragment branch (the iterator over paramBindings just
        // skipped because SCROLL has no paramBindings); same outcome,
        // but the explicit case is correct for future audits.
        if (node.distance?.kind === 'strategy_param' && node.distance.name) {
          addRef(node.distance.name, 'scalar', `SCROLL distance binding "${node.distance.name}"`, iterStack);
        }
      } else if (node.type === 'observation') {
        // v2.72.3 (Pass 4) — OBSERVATION paramBindings reserved for future
        // param substitution (Pass 3d). Currently always {} for 3a-era
        // observations, but the contributing pattern mirrors SIEVE so the
        // architecture is forward-compatible.
        for (const [paramName, binding] of Object.entries(node.paramBindings ?? {})) {
          if (binding?.kind === 'strategy_param' && binding.name) {
            addRef(binding.name, 'scalar', `OBSERVATION param "${paramName}"`, iterStack);
          }
        }
      } else if (node.type === 'in_new_tab') {
        if (node.trigger) walk([node.trigger], iterStack);
        walk(node.body, iterStack);
      } else if (node.type === 'fragment' || !node.type) {
        // v2.72.3 (Pass 4 audit) — Made fragment-type explicit (mirroring
        // walkForeachRefs / serializeNode). Future unknown node types fall
        // through to the explicit `else` rather than silently being treated
        // as fragments with empty paramBindings.
        for (const b of Object.values(node.paramBindings ?? {})) {
          if (b?.kind === 'strategy_param' && b.name) {
            addRef(b.name, 'scalar', `Fragment binding "${b.name}"`, iterStack);
          }
        }
      } else {
        // Unknown node type — log a warning so this doesn't silently
        // absorb future audit misses. Don't throw; analysis should be
        // best-effort.
        console.warn(`analyzeStrategy walk: unknown node type "${node.type}" — skipping`);
      }
    }
  };
  walk(fragmentSteps, []);
  return out;
}

/**
 * Detect kind conflicts in the collected params map. Returns an array of
 * warning strings — one per name that was referenced in incompatible ways.
 * Empty array means no conflicts. Used by the save path to surface warnings.
 */
function detectStrategyParamConflicts(paramsMap) {
  const warnings = [];
  for (const [name, info] of paramsMap.entries()) {
    // Conflict heuristic: a name appears both as a FOREACH source AND as a
    // scalar reference (URL template, fragment binding, etc.). The runtime
    // semantics are incompatible — FOREACH wants a list, scalar references
    // want a single value.
    const hasListSource    = info.sources.some(s => s.startsWith('FOREACH over'));
    const hasScalarSource  = info.sources.some(s => !s.startsWith('FOREACH over'));
    if (hasListSource && hasScalarSource) {
      warnings.push(
        `Input "${name}" is used both as a FOREACH source (expects list) and as a scalar reference. ` +
        `Sources: ${info.sources.join('; ')}`
      );
    }
  }
  return warnings;
}

/**
 * v2.25.6 — Analyze a Strategy's composition for antecedent issues.
 *
 * Returns warnings for:
 *  - missing: a step's Fragment has an antecedent (transitive ancestor) that
 *    isn't included as any earlier step. Antecedent replay handles this at
 *    runtime (the engine memoizes, so it's not a bug), but the user almost
 *    certainly meant to include it explicitly.
 *  - out-of-order: an ancestor IS in the Strategy but appears AFTER the step
 *    that depends on it. Same root cause; same fix.
 *
 * Walks the antecedent chain of each step's Fragment using the cached
 * Fragments. The cache is keyed by id; chain walk is iterative + cycle-safe
 * (StorageManager.resolveAntecedentChain throws on cycle, but here we walk
 * the cache directly since the cache may include self-edits).
 *
 * Pure: no side effects, no async — operates on cached data only.
 *
 * @param {Array} fragmentSteps - _strategyDraft.fragmentSteps shape
 * @param {Map<string, Object>} fragmentCache - id → Fragment
 * @returns {Array<{stepIdx, kind, expectedFragmentId, expectedFragmentName, dependentFragmentName}>}
 */
function analyzeStrategyComposition(fragmentSteps, fragmentCache, opts = {}) {
  const warnings = [];

  // v2.29.3 (Pass E2-4) — Flatten the tree to fragment nodes in execution
  // order. Antecedent / collision / template checks were written for the
  // flat linear schema; by flattening we reuse them without rewriting each.
  //
  // Pre-order traversal: a fragment before a FOREACH is considered BEFORE
  // the fragments inside that FOREACH (matches runtime order). Fragments
  // inside a FOREACH body are considered AFTER each other (linear within
  // body) but don't "come before" siblings of the FOREACH at the outer
  // level — acceptable approximation for a warning panel.
  const flatFragments = [];
  const flatten = (nodes) => {
    for (const node of nodes ?? []) {
      if (!node) continue;
      if (node.type === 'foreach') {
        flatten(node.body);
      } else if (node.type === 'wait') {
        // Pass G1 — WAIT doesn't contribute to antecedent warnings.
        continue;
      } else if (node.type === 'pause') {
        // v2.60.0 — PAUSE doesn't contribute to antecedent warnings.
        continue;
      } else if (node.type === 'sieve') {
        // v2.61.0 — SIEVE doesn't contribute to antecedent warnings.
        continue;
      } else if (node.type === 'detect') {
        // Pass G2 — descend into every branch body and default for
        // antecedent-ordering analysis. DETECT itself is not a fragment.
        for (const branch of node.branches ?? []) {
          flatten(branch?.body);
        }
        flatten(node.default);
      } else if (node.type === 'loop') {
        // Pass H1 — descend into loop body for antecedent analysis.
        flatten(node.body);
      } else if (node.type === 'try') {
        // Pass H2 — descend into both body and recover for antecedent
        // analysis. Both are potential execution paths; fragments in
        // either contribute to the flat list.
        flatten(node.body);
        flatten(node.recover);
      } else if (node.type === 'navigate') {
        // Pass H3 — NAVIGATE is a leaf with no fragment. Skip cleanly.
        continue;
      } else if (node.type === 'scroll') {
        // v2.71.10 (Bug Y fix) — SCROLL is a leaf with no fragment. Pre-v2.71.10
        // SCROLL fell through to the implicit-fragment else branch and was
        // pushed as a fragment with undefined fragmentId, generating spurious
        // antecedent warnings. Same defensive pattern as v2.71.2's audits.
        continue;
      } else if (node.type === 'in_new_tab') {
        // Pass J2 — descend into trigger and body. Both contribute
        // fragments to antecedent analysis.
        if (node.trigger) flatten([node.trigger]);
        flatten(node.body);
      } else if (node.type === 'fragment' || !node.type) {
        // v2.71.10 (Bug Y fix) — Made fragment match explicit. Legacy
        // (pre-v2.29) shape is `{fragmentId, ...}` with no `type` field;
        // we honor that for backward compat. Future strategy node types
        // that miss this audit point will fall to the `else` below and
        // fail loudly with a console warning.
        flatFragments.push(node);
      } else {
        // Unknown node type — log and skip rather than silently
        // misclassifying as a fragment.
        console.warn(`[antecedent-flatten] unknown node type "${node.type}" — skipping`);
        continue;
      }
    }
  };
  flatten(fragmentSteps);

  // v2.29.4 (Pass E2-5) — FOREACH reference checks.
  //
  // For each FOREACH node: does an EARLIER step in the tree produce a list
  // binding matching its `over` name? We walk the tree in pre-order carrying
  // a running set of list-binding names that have been written so far, and
  // check each FOREACH's `over` against it. A missing or empty `over` is
  // caught by validateStrategyBody at save — we only flag the "references a
  // name that nothing produces" case here.
  const foreachWarnings = [];
  const producedSoFar = new Set();
  const walkForeachRefs = (nodes, path) => {
    for (let i = 0; i < (nodes ?? []).length; i++) {
      const node = nodes[i];
      if (!node) continue;
      const here = [...path, i];
      if (node.type === 'foreach') {
        if (node.over && !producedSoFar.has(node.over)) {
          foreachWarnings.push({
            kind: 'foreach-unproduced-over',
            path: here,
            over: node.over,
            availableListNames: [...producedSoFar].sort(),
          });
        }
        // A FOREACH body may produce additional bindings too (EXTRACTs /
        // ENUMERATEs inside body fragments). We don't descend for them
        // here — their output is visible only during iterations, not to
        // siblings AFTER the FOREACH. The EXTRACT-collision code above
        // already handles collision detection for those.
        walkForeachRefs(node.body ?? [], [...here, 'body']);
      } else if (node.type === 'wait') {
        // Pass G1 — WAIT nodes produce no bindings and have no FOREACH-over
        // to check.
        continue;
      } else if (node.type === 'pause') {
        // v2.60.0 — PAUSE has no bindings and no FOREACH-over.
        continue;
      } else if (node.type === 'sieve') {
        // v2.61.0 — SIEVE has no FOREACH-over and produces a list binding,
        // not strategy params. Skip.
        continue;
      } else if (node.type === 'detect') {
        // Pass G2 — descend into each branch body and the default. Branch
        // bodies are conditionally run, not guaranteed, so the producedSoFar
        // set they contribute is NOT propagated to siblings (same reasoning
        // as FOREACH body). Check any nested FOREACHes within for bad refs.
        for (let bi = 0; bi < (node.branches ?? []).length; bi++) {
          walkForeachRefs(node.branches[bi]?.body ?? [], [...here, 'branches', bi, 'body']);
        }
        walkForeachRefs(node.default ?? [], [...here, 'default']);
      } else if (node.type === 'loop') {
        // Pass H1 — descend into loop body. Loop body is also conditionally
        // run (may run zero times), so bindings it produces are NOT
        // propagated to siblings, matching the FOREACH/DETECT rule.
        walkForeachRefs(node.body ?? [], [...here, 'body']);
      } else if (node.type === 'try') {
        // Pass H2 — descend into both body and recover. Body may fail
        // partway through; recover is conditional. Neither's bindings
        // are safely available to siblings (same rule as above).
        walkForeachRefs(node.body ?? [], [...here, 'body']);
        walkForeachRefs(node.recover ?? [], [...here, 'recover']);
      } else if (node.type === 'navigate') {
        // Pass H3 — NAVIGATE is a leaf. Produces no bindings, has no
        // FOREACH-over to check. Skip.
        continue;
      } else if (node.type === 'in_new_tab') {
        // Pass J2 — descend into trigger and body. The body runs on a
        // different tab, but bindings from EXTRACTs/EMITs land in the
        // shared scope and ARE available to sibling steps after return —
        // similar to a TRY body that succeeded. Match TRY rule: don't
        // propagate bindings to siblings (conservative — body may fail
        // partway), match the body to its own subtree.
        if (node.trigger) walkForeachRefs([node.trigger], [...here, 'trigger']);
        walkForeachRefs(node.body ?? [], [...here, 'body']);
      } else if (node.type === 'scroll' || node.type === 'pause' || node.type === 'wait') {
        // v2.71.1 — Leaf nodes that produce no bindings. Nothing to walk;
        // sibling visibility unaffected.
        continue;
      } else if (node.type === 'observation') {
        // v2.72.3 (Pass 4) — OBSERVATION produces a binding into scope under
        // its `output` name. Only `list_of_records` shape produces a list
        // (FOREACH-iterable); scalar/raw_* produce scalars (not iterable).
        // We add list-shaped output names to producedSoFar so subsequent
        // FOREACHes can reference them. _strategyObservationCache is
        // module-scoped, populated when the strategy form opens.
        const o = _strategyObservationCache.get(node.observationId);
        if (o && o.shape === 'list_of_records' && o.output) {
          producedSoFar.add(o.output);
        }
        // No body to descend into.
        continue;
      } else if (node.type === 'fragment' || !node.type) {
        // v2.71.1 — Made fragment-type explicit. The legacy "no type field"
        // shape (pre-v2.29) is treated as fragment for backward compat.
        // fragment — add any list-producing targets this fragment writes
        // to producedSoFar.
        // v2.72.26 (Pass 14b) — Walk rawJson for legacy ENUMERATE/EMIT
        // targets. Pass 14's fragment.produces was reverted; Fragment
        // contract is name/description/pre/post/params, internals opaque
        // to composers. Editor-side legacy walking is acceptable.
        const f = fragmentCache.get(node.fragmentId);
        if (f?.rawJson) {
          let actions;
          try { actions = JSON.parse(f.rawJson ?? '[]'); } catch { actions = []; }
          if (Array.isArray(actions)) {
            for (const a of actions) {
              if (a?.action === 'ENUMERATE' && a.target) {
                producedSoFar.add(a.target);
              }
              // v2.35.0 (I1) — EMIT also produces a list-typed binding.
              if (a?.action === 'EMIT' && a.target) {
                producedSoFar.add(a.target);
              }
            }
          }
        }
      }
    }
  };
  walkForeachRefs(fragmentSteps, []);
  warnings.push(...foreachWarnings);

  // ── Antecedent ordering checks (v2.25.6) ────────────────────────────────
  for (let i = 0; i < flatFragments.length; i++) {
    const step = flatFragments[i];
    const frag = fragmentCache.get(step.fragmentId);
    if (!frag) continue;   // dropdown empty or unknown id — caught elsewhere

    // Build the transitive antecedent chain by walking fragmentCache.
    const chain = [];
    const visited = new Set([step.fragmentId]);
    let cursor = frag.antecedentFragmentId;
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const anc = fragmentCache.get(cursor);
      if (!anc) break;
      chain.unshift(anc);
      cursor = anc.antecedentFragmentId;
    }

    if (chain.length === 0) continue;

    const priorStepFragmentIds = new Set(
      flatFragments.slice(0, i).map(s => s.fragmentId).filter(Boolean)
    );
    const allStepFragmentIds = new Set(flatFragments.map(s => s.fragmentId).filter(Boolean));

    for (const ancestor of chain) {
      if (priorStepFragmentIds.has(ancestor.id)) continue;

      if (allStepFragmentIds.has(ancestor.id)) {
        warnings.push({
          stepIdx: i,
          kind: 'out-of-order',
          expectedFragmentId: ancestor.id,
          expectedFragmentName: ancestor.name ?? '?',
          dependentFragmentName: frag.name ?? '?',
        });
      } else {
        warnings.push({
          stepIdx: i,
          kind: 'missing',
          expectedFragmentId: ancestor.id,
          expectedFragmentName: ancestor.name ?? '?',
          dependentFragmentName: frag.name ?? '?',
        });
      }
    }
  }

  // ── E1 — Output-binding collision + result-template checks ─────────────
  const inputParamNames = collectStrategyParams(fragmentSteps);

  // Map from binding name → list of fragment names that write it.
  // v2.29.3 — was ENUMERATE targets only; expanded to all scope-writing actions.
  // v2.35.0 (I1) — added EMIT targets.
  // v2.72.26 (Pass 14b) — Walk rawJson directly. Pass 14's fragment.produces
  // was reverted; the editor still needs to identify legacy scope-writing
  // actions for collision detection, which requires looking inside rawJson.
  const extractWriters = new Map();
  for (const step of flatFragments) {
    const f = fragmentCache.get(step.fragmentId);
    if (!f) continue;
    let actions;
    try { actions = JSON.parse(f.rawJson ?? '[]'); } catch { continue; }
    if (!Array.isArray(actions)) continue;
    for (const a of actions) {
      if ((a?.action === 'EXTRACT' || a?.action === 'ENUMERATE' || a?.action === 'EMIT') && a.target) {
        if (!extractWriters.has(a.target)) extractWriters.set(a.target, []);
        extractWriters.get(a.target).push(f.name ?? '?');
      }
    }
  }

  // Collisions: input param shares a name with an EXTRACT/ENUMERATE target
  for (const [name, writers] of extractWriters) {
    if (inputParamNames.has(name)) {
      warnings.push({ kind: 'name-collision-input', name, writers });
    }
    if (writers.length > 1) {
      warnings.push({ kind: 'name-collision-extract', name, writers });
    }
  }

  // Result-template undefined references
  const template = String(opts.resultTemplate ?? '').trim();
  if (template) {
    const referenced = new Set();
    const re = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
    let m;
    while ((m = re.exec(template)) !== null) referenced.add(m[1]);

    const availableNames = new Set([...inputParamNames, ...extractWriters.keys()]);
    // v2.74.159 — When the author has declared explicit Results
    // (strategy.outputs), the template should reference ONLY declared
    // outputs at runtime: ExecutionEngine filters extractedValues by
    // strategy.outputs (v2.74.155), so any reference to a binding the
    // body produces but the author didn't promote will render as the
    // literal `{{NAME}}` token in chat. Surface this as its own
    // warning so it's distinguishable from the existing "template
    // references an unknown name" case.
    const declaredOutputs = Array.isArray(opts.declaredOutputs) ? opts.declaredOutputs : [];
    const promotedNames = new Set(
      declaredOutputs.map(o => String(o?.name ?? '').trim()).filter(Boolean)
    );
    const hasOutputFilter = promotedNames.size > 0;
    for (const ref of referenced) {
      if (!availableNames.has(ref)) {
        warnings.push({ kind: 'template-undefined', name: ref });
      } else if (hasOutputFilter && extractWriters.has(ref) && !promotedNames.has(ref)) {
        // The name is body-produced (extract / observation / sieve /
        // analysis output) but not in the declared outputs list. With
        // the Results filter on, runtime drops it from extractedValues
        // and chat renders the literal `{{NAME}}` token. Strategy
        // inputs (typed-inputs editor) flow through regardless of the
        // outputs filter — only body-produced bindings are at risk,
        // hence the extractWriters gate here.
        warnings.push({ kind: 'template-not-promoted', name: ref });
      }
    }
  }

  return warnings;
}

/**
 * v2.25.6 — Render the composition warnings panel and per-step ⚠ icons.
 * Called from renderStrategySteps so it stays in sync with mutations.
 */
function renderStrategyWarnings() {
  const panel = $('strategy-warnings');
  if (!panel || !_strategyDraft) return;

  // Read template live from the form so warnings update as the user types.
  const resultTemplate = $('input-strategy-result-template')?.value ?? '';
  // v2.74.159 — Pass declared outputs so the analyzer can flag
  // template references to names the runtime will filter out of
  // extractedValues (see template-not-promoted warning).
  const declaredOutputs = Array.isArray(_strategyDraft.outputs) ? _strategyDraft.outputs : [];
  const warnings = analyzeStrategyComposition(
    _strategyDraft.fragmentSteps,
    _strategyFragmentCache,
    { resultTemplate, declaredOutputs },
  );

  if (warnings.length === 0) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }

  // Render the warnings list
  const rows = warnings.map(w => {
    let text;
    switch (w.kind) {
      case 'missing':
        text = `<strong>Step ${w.stepIdx + 1}:</strong> ${escHtml(w.dependentFragmentName)} expects <strong>${escHtml(w.expectedFragmentName)}</strong> to run first, but it isn't in this Strategy. The engine will handle this at runtime (antecedent replay), but you may want to add the Fragment explicitly for clarity.`;
        break;
      case 'out-of-order':
        text = `<strong>Step ${w.stepIdx + 1}:</strong> ${escHtml(w.dependentFragmentName)} expects <strong>${escHtml(w.expectedFragmentName)}</strong> to run first, but it appears later in the sequence. The engine will handle this at runtime (antecedent replay), but you may want to reorder.`;
        break;
      case 'name-collision-input':
        text = `<strong>Name collision:</strong> Strategy input <code>{{${escHtml(w.name)}}}</code> is also written by an EXTRACT or OBSERVATION in <strong>${escHtml(w.writers.join(', '))}</strong>. The captured value overwrites the input at runtime — pick distinct names if both should be available.`;
        break;
      case 'name-collision-extract':
        text = `<strong>Name collision:</strong> binding <code>{{${escHtml(w.name)}}}</code> is written by multiple steps (<strong>${escHtml(w.writers.join(', '))}</strong>). Last write wins — rename to keep both values available.`;
        break;
      case 'template-undefined':
        text = `<strong>Result template:</strong> references <code>{{${escHtml(w.name)}}}</code>, but no Strategy input, EXTRACT target, or OBSERVATION output has that name. The placeholder will appear literally in chat.`;
        break;
      case 'template-not-promoted':
        // v2.74.159 — Companion to template-undefined for the case
        // where the name DOES exist in the body but isn't promoted by
        // the declared Results filter (v2.74.155). Runtime drops it
        // from extractedValues, so the template renders the literal
        // token in chat.
        text = `<strong>Result template:</strong> references <code>{{${escHtml(w.name)}}}</code>, but this binding isn't in the declared Results list and won't be promoted to the parent Workflow's scope. The placeholder will appear literally in chat. Add it to Results, or remove it from the template.`;
        break;
      case 'foreach-unproduced-over':
        // v2.29.4 (E2-5) — FOREACH over name has no upstream producer.
        // This is the exact failure mode that surfaced at runtime as
        // "FOREACH 'over' binding is not in scope" — now caught at
        // authoring time.
        text = `<strong>FOREACH:</strong> iterates over <code>{{${escHtml(w.over)}}}</code>, but no earlier step produces it. The Strategy will fail at runtime. ${w.availableListNames.length > 0 ? `Available list names: <code>${escHtml(w.availableListNames.join(', '))}</code>.` : 'Add an OBSERVATION (list_of_records shape) upstream, or an ENUMERATE action to an upstream Fragment.'}`;
        break;
      default:
        text = `Unknown warning: ${escHtml(w.kind)}`;
    }
    return `
      <div class="strategy-warning-row">
        <span class="warning-icon">⚠</span>
        <span class="warning-text">${text}</span>
      </div>`;
  }).join('');

  panel.innerHTML = `
    <div class="strategy-warnings-head">
      ${warnings.length} composition warning${warnings.length === 1 ? '' : 's'}
    </div>
    ${rows}`;
  panel.classList.remove('hidden');

  // v2.29.4 (Pass E2-5) — Decorate affected step/foreach cards with ⚠ badges.
  //
  // Two addressing schemes exist in the DOM:
  //   - Top-level flat cards: data-step-idx="N" (legacy, retained for drag-drop)
  //   - All tree nodes:       data-path="[...]"    (added in E2-4)
  //
  // Warnings carrying `w.path` use the tree path; warnings carrying only
  // `w.stepIdx` use the top-level index. Both resolve to the same visible
  // element at top-level but only path-based works for nested nodes.
  const decorated = new Set();   // guard against double-decorating on re-render

  // Path-based (new warnings from E2-5 — FOREACH reference)
  warnings.filter(w => Array.isArray(w.path)).forEach(w => {
    const pathJson = JSON.stringify(w.path);
    const card = document.querySelector(
      `.strategy-foreach-card[data-path="${pathJson.replace(/"/g, '&quot;')}"], .strategy-step-card[data-path="${pathJson.replace(/"/g, '&quot;')}"]`
    );
    if (!card || decorated.has(card)) return;
    decorated.add(card);
    _setup.addWarningIcon(card);
  });

  // stepIdx-based (legacy warnings — antecedents, template-undefined which
  // doesn't tag a step). These only decorate top-level cards.
  warnings.filter(w => typeof w.stepIdx === 'number').forEach(w => {
    const card = document.querySelector(`.strategy-step-card[data-step-idx="${w.stepIdx}"]`);
    if (!card || decorated.has(card)) return;
    decorated.add(card);
    _setup.addWarningIcon(card);
  });
}


// ─── Pass 4a: small lifecycle/run/delete functions ────────────────────────
//
// Initially extracted in Pass 4a using _setup getters; state migrated to
// module-locals at the tail of Pass 4-f Phase 2 (v2.73.2). All state
// access in this block now reads/writes module-locals directly.
//
// Functions in this block:
//   renderStrategyTierUI      — toggle gating/indicator UI based on draft.tier
//   setFragmentSelectValues   — sync .step-fragment-select dropdowns to draft
//   deleteStrategy            — async delete with confirm + ground-list refresh
//   testRunStrategy           — Lab test-run with sidepanel-debug invocation
//
// editStrategy NOT moved here: it calls openStrategyForm, which still
// lives in studio.js. They migrate together when openStrategyForm moves
// (full Pass 4).

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
function renderStrategyTierUI() {
  const strategyDraft = _strategyDraft;
  if (!strategyDraft) return;
  const tier = strategyDraft.tier;
  const gatingEl = $('strategy-tier-gating');
  const indicatorEl = $('strategy-tier-indicator');
  const indicatorValueEl = $('strategy-tier-indicator-value');
  const stepsSectionEl = $('strategy-steps-section');

  if (gatingEl) gatingEl.classList.toggle('hidden', tier !== null);
  if (indicatorEl) indicatorEl.classList.toggle('hidden', tier === null);
  if (indicatorValueEl) {
    if (tier === 'cache') indicatorValueEl.textContent = 'Cache (Hand-authored, T1)';
    else if (tier === 'frontier') indicatorValueEl.textContent = 'Frontier (Composer-based, T3)';
    else indicatorValueEl.textContent = '—';
  }
  if (stepsSectionEl) {
    // Hide fragment steps for T3 (no authored body) and during gating.
    stepsSectionEl.classList.toggle('hidden', tier !== 'cache');
  }
}

/**
 * Sync the .step-fragment-select dropdowns to their draft.fragmentId values.
 * Called after renderStrategySteps so option ordering changes don't unstick
 * existing selections.
 */
function setFragmentSelectValues() {
  const listEl = $('strategy-steps-list');
  const draft = _strategyDraft;
  if (!listEl || !draft) return;
  listEl.querySelectorAll('.step-fragment-select').forEach(sel => {
    try {
      const path = JSON.parse(sel.dataset.path);
      const node = getNodeByPath(draft.fragmentSteps, path);
      sel.value = node?.fragmentId ?? '';
    } catch { /* malformed path */ }
  });
}

/**
 * Delete a Strategy with user confirmation. Refreshes Ground list on success.
 */
export async function deleteStrategy(strategyId) {
  const s = await StorageManager.getStrategy(strategyId);
  if (!s) return;
  if (!confirm(`Delete Strategy "${s.name}"? This cannot be undone.`)) return;
  const response = await new Promise(r => chrome.runtime.sendMessage({
    type: 'DELETE_STRATEGY', payload: { strategyId },
  }, r));
  if (!response?.success) {
    toast(`Failed to delete: ${response?.error ?? 'unknown'}`, 'err');
    return;
  }
  toast('Strategy deleted');
  if (typeof _setup.refreshGroundList === 'function') {
    await _setup.refreshGroundList();
  }
}

/**
 * Pass C — Lab test-run for a Strategy. Prompts the user for param values
 * (if any), then fires CAPABILITY_INVOKE. Progress/result flow through the
 * standard invocation event channel — we surface them as toasts since the
 * Lab has no chat bubble.
 */
export async function testRunStrategy(strategyId) {
  const strategy = await StorageManager.getStrategy(strategyId);
  if (!strategy) { toast('Strategy not found', 'err'); return; }

  const hasKey = await new Promise(res =>
    chrome.runtime.sendMessage({ type: 'CHECK_API_KEY' }, r => res(r?.hasKey))
  );
  if (!hasKey) { toast('Add your Anthropic API key in Settings first', 'err'); return; }

  // v2.74.68 — Studio test-run now uses the shared ParamForm so file uploads,
  // numbers, and booleans collect the same way they do in chat. Params come
  // straight off the strategy record (already in canonical typed-input shape
  // after the authoring UI shipped) so a defensive normalize is enough to
  // tolerate legacy bare-string params.
  let paramValues = {};
  const declared = normalizeStrategyParams(strategy.params);
  if (declared.length > 0) {
    const values = await promptForParams(declared, {
      title: `${strategy.name} — inputs`,
      hint:  'Fill in values for this run.',
      submitLabel: 'Run',
    });
    if (values === null) return;   // cancelled
    paramValues = values;
  }

  toast(`Running "${strategy.name}"…`);
  try {
    const invocationId = crypto.randomUUID();
    // v2.72.51 (Stage 2) — Open the sidepanel and set strategy-debug mode
    // BEFORE invoking. Must run synchronously in the click handler
    // (preserves the user gesture for chrome.sidePanel.open). The shell
    // mounts strategy-debug; the mode subscribes to ChatAPI.onEvent and
    // attaches to the invocation we're about to fire.
    try {
      // v2.74.140 — Routes through the shared openSidepanelHere helper
      // which sets BOTH global AND per-tab paths. The v2.72.59 comment
      // about "use only global" was correct for avoiding chrome.sidePanel.close
      // ambiguity, but it left a hole: if the active tab had a per-tab
      // override from popup-Chat, the panel kept showing chat.html and
      // the strategy-debug mode-change request landed in the wrong panel.
      // openSidepanelHere fixes both pre-existing per-tab overrides AND
      // the window-scoped default in one call. close() isn't called from
      // anywhere in studio code, so the close-ambiguity concern is moot.
      await openSidepanelHere('sidepanel.html');
      // Tell background to set the mode. The shell receives
      // SIDEPANEL_MODE_CHANGED and mounts strategy-debug.
      await chrome.runtime.sendMessage({
        type: 'REQUEST_SIDEPANEL_MODE',
        payload: { mode: 'strategy-debug' },
      });
    } catch (e) {
      console.warn('[StrategyForm] Could not open sidepanel for strategy-debug:', e.message);
      // Don't block — the invocation can still run; user can open the
      // sidepanel manually via the extension icon.
    }

    // v2.38.2 (K1.1) — Studio test-runs always launch under the debugger.
    // Default is run-live (startPaused=false) — strategy executes normally,
    // user clicks Pause in the debugger to break in.
    const invokePayload = {
      capabilityId: strategyId,
      input: { question: '', params: paramValues },
      invocationId,
      debug: { pauseMode: 'after-node', startPaused: false },
    };
    const response = await new Promise(r => chrome.runtime.sendMessage({
      type: 'CAPABILITY_INVOKE',
      payload: invokePayload,
    }, r));
    if (!response?.success) {
      toast(`Invocation failed to start: ${response?.error ?? 'unknown'}`, 'err');
      return;
    }
    // Subscribe to one-shot result via ChatAPI.onEvent
    const unsubscribe = ChatAPI.onEvent((event) => {
      if (event.invocationId !== invocationId) return;
      if (event.type === 'invocation.completed') {
        const ok = event.result?.success;
        const steps = event.result?.stepResults ?? [];
        const ran  = steps.filter(s => s.success && !s.skipped).length;
        const skip = steps.filter(s => s.skipped).length;
        const tot  = steps.length;
        const skipPart = skip > 0 ? ` (${skip} skipped)` : '';

        // E1 (v2.26.0) — If the Strategy captured anything beyond its inputs,
        // append a brief preview to the toast. Inputs alone aren't worth
        // showing (the user just typed them in).
        const extracted = event.result?.extractedValues ?? {};
        const declaredInputs = new Set(Object.keys(paramValues ?? {}));
        const newKeys = Object.keys(extracted).filter(k => !declaredInputs.has(k));
        let extractedPart = '';
        if (newKeys.length > 0) {
          const previews = newKeys.slice(0, 3).map(k => {
            const v = extracted[k];
            const str = (v?.kind === 'scalar') ? String(v.value ?? '')
                       : (v?.kind === 'list')   ? `[${(v.items ?? []).length} items]`
                       : String(v ?? '');
            return `${k}=${str.slice(0, 30)}${str.length > 30 ? '…' : ''}`;
          });
          const more = newKeys.length > 3 ? ` +${newKeys.length - 3} more` : '';
          extractedPart = ` · ${previews.join(', ')}${more}`;
        }

        toast(
          ok ? `✓ ${strategy.name} — ${ran + skip}/${tot} step${tot === 1 ? '' : 's'}${skipPart}${extractedPart}`
             : `✕ ${strategy.name} completed with errors`,
          ok ? 'ok' : 'warn'
        );
        unsubscribe();
      } else if (event.type === 'invocation.failed') {
        toast(`✕ ${strategy.name}: ${event.error ?? 'failed'}`, 'err');
        unsubscribe();
      } else if (event.type === 'invocation.cancelled') {
        toast(`${strategy.name} cancelled`, 'warn');
        unsubscribe();
      } else if (event.type === 'invocation.progress') {
        // Optional: surface intermediate progress as a toast. For now silent —
        // user can watch the tab.
      }
    });
  } catch (err) {
    toast(`Test-run failed: ${err.message}`, 'err');
  }
}

// ─── Pass 4-b additions ──────────────────────────────────────────────────
//
// renderStrategyBindings is pure (no state access). renderStrategySteps
// reads _strategyDraft + _strategyFragmentCache directly (state migrated
// to module-locals in Pass 4-f Phase 2) and dispatches to sibling
// renderStrategyNodes + wireStrategyStepHandlers + wireTopLevelDragAndDrop.
//
// wireStrategyTopLevelInputs is the umbrella for top-level form input
// handlers: result-template, cancel button, 11 body Add buttons,
// 2 pre/post Add buttons, 2 toggle handlers, and 2 tier-choice buttons.
// Studio.js calls it once during init alongside setupStrategyForm.

/**
 * Render the param-binding rows for a fragment step. Offers three kinds:
 * literal, strategy_param (input name), iteration_variable (dropdown of
 * enclosing FOREACH `as` names). Last option only appears when iterScope
 * has names — keeping the UI simple when there's nothing to pick.
 */
function renderStrategyBindings(step, fragmentParams, path, iterScope) {
  if (fragmentParams.length === 0) {
    return `<div class="step-no-params">No parameters</div>`;
  }
  const pathJson = JSON.stringify(path);
  const iterNames = [...iterScope];

  return fragmentParams.map(paramName => {
    const binding = step.paramBindings?.[paramName] ?? { kind: 'literal', value: '' };
    const kind = binding.kind ?? 'literal';

    // Build the value control based on binding kind.
    let valueControlHtml;
    if (kind === 'literal') {
      valueControlHtml = `<input type="text" class="step-binding-value" data-path="${escAttr(pathJson)}" data-param="${escAttr(paramName)}"
             value="${escAttr(binding.value ?? '')}"
             placeholder="value to use directly" />`;
    } else if (kind === 'strategy_param') {
      valueControlHtml = `<input type="text" class="step-binding-value" data-path="${escAttr(pathJson)}" data-param="${escAttr(paramName)}"
             value="${escAttr(binding.name ?? paramName)}"
             placeholder="input name, e.g. QUERY" />`;
    } else if (kind === 'iteration_variable') {
      // Dropdown of in-scope iteration variables — plus the current binding
      // even if it's out-of-scope, so we don't silently drop the user's value.
      const names = new Set(iterNames);
      if (binding.name && !names.has(binding.name)) names.add(binding.name);
      const options = [...names].map(n => {
        const outOfScope = !iterScope.has(n);
        const label = outOfScope ? `${n} ⚠ (not in scope here)` : n;
        return `<option value="${escAttr(n)}" ${n === binding.name ? 'selected' : ''}>${escHtml(label)}</option>`;
      }).join('');
      valueControlHtml = `<select class="step-binding-value" data-path="${escAttr(pathJson)}" data-param="${escAttr(paramName)}" data-binding-kind="iteration_variable">
        ${iterNames.length === 0 ? '<option value="">— no iteration vars in scope —</option>' : ''}
        ${options}
      </select>`;
    }

    // The kind dropdown. Only show iteration_variable when there's at least
    // one in scope OR when the binding already is one (so we can display it).
    const showIter = iterNames.length > 0 || kind === 'iteration_variable';
    const iterOption = showIter
      ? `<option value="iteration_variable" ${kind === 'iteration_variable' ? 'selected' : ''}>from FOREACH item</option>`
      : '';

    return `
      <div class="step-binding-row" data-param="${escAttr(paramName)}">
        <code class="step-binding-name">{{${escHtml(paramName)}}}</code>
        <select class="step-binding-kind" data-path="${escAttr(pathJson)}" data-param="${escAttr(paramName)}">
          <option value="literal"         ${kind === 'literal' ? 'selected' : ''}>literal</option>
          <option value="strategy_param"  ${kind === 'strategy_param' ? 'selected' : ''}>from input</option>
          ${iterOption}
        </select>
        ${valueControlHtml}
      </div>`;
  }).join('');
}

/**
 * v2.29.3 (Pass E2-4) — Top-level Strategy body renderer. Calls into
 * sibling renderStrategyNodes for the recursive render, then wires step
 * handlers and top-level drag/drop.
 *
 * Reads _strategyDraft and _strategyFragmentCache directly (module-locals).
 */
function renderStrategySteps() {
  const strategyDraft = _strategyDraft;
  const listEl = $('strategy-steps-list');
  if (!strategyDraft) { listEl.innerHTML = ''; return; }

  if (strategyDraft.fragmentSteps.length === 0) {
    listEl.innerHTML = `<div class="empty-state small">No steps yet — add a Fragment, FOREACH, NAVIGATE, SCROLL, OBSERVATION, WAIT, PAUSE, DETECT, LOOP, TRY, or IN_NEW_TAB.</div>`;
    renderStrategyWarnings();
    return;
  }

  // Build fragment dropdown options once — reused per step
  const fragmentCache = _strategyFragmentCache;
  const fragOptions = [...fragmentCache.values()]
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
    .map(f => `<option value="${escAttr(f.id)}">${escHtml(f.name ?? 'Unnamed')}</option>`)
    .join('');

  // v2.73.0 (Pass 4-e) — renderStrategyNodes is now a sibling export.
  listEl.innerHTML = renderStrategyNodes(strategyDraft.fragmentSteps, [], fragOptions, new Set(), new Set());

  // After the HTML is in the DOM, fix up fragment select values (can't
  // embed `selected` in shared option strings) and wire all event handlers.
  setFragmentSelectValues();
  // v2.73.1 (Pass 4-f Phase 1) — wireStrategyStepHandlers is now a sibling export.
  wireStrategyStepHandlers();
  // v2.72.98 (Pass 4-c) — wireTopLevelDragAndDrop is now a sibling export.
  wireTopLevelDragAndDrop();
  renderStrategyWarnings();
  // v2.74.155 — Body just changed; refresh the Results section so the
  // datalist suggestions reflect the new producer set. The renderer is
  // cheap (small DOM) and idempotent, so calling on every body
  // re-render is fine.
  renderStrategyOutputs();
}

/**
 * Wire top-level form input handlers that aren't tied to step rendering.
 * Called once from studio.js init.
 *   - result-template input — re-runs composition warnings live (E1, v2.26.0)
 *   - cancel button — confirm-and-close
 *   - 11 body Add buttons — push step nodes onto strategyDraft
 *   - 2 pre/post Add buttons — push conditions onto pre/postconditions
 *   - 2 pre/post section toggle handlers — track user-toggle state
 */
export function wireStrategyTopLevelInputs() {
  $('input-strategy-result-template').addEventListener('input', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.resultTemplate = $('input-strategy-result-template').value;
    renderStrategyWarnings();
  });

  // v2.72.98 (Pass 4-c) — cancel handler moved here. closeStrategyForm
  // is now in this module; cancel checks the draft for unsaved work then
  // tears down.
  $('btn-cancel-strategy').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (strategyDraft?.fragmentSteps.length > 0) {
      if (!confirm('Discard this Strategy draft?')) return;
    }
    closeStrategyForm();
  });

  // ── v2.72.99 (Pass 4-d) — Body Add buttons ────────────────────────────

  $('btn-add-strategy-step').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    const fragmentCache = _strategyFragmentCache;
    const first = fragmentCache.values().next().value;
    if (!first) { toast('No Fragments available on this Ground', 'err'); return; }
    const paramBindings = {};
    (first.params ?? []).forEach(p => { paramBindings[p] = { kind: 'strategy_param', name: p }; });
    strategyDraft.fragmentSteps.push({ type: 'fragment', fragmentId: first.id, paramBindings });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.74.72 — Typed-inputs editor wiring removed from the Workflow form;
  // typed inputs are now authored on the parent Strategy form (studio.js).
  // The Workflow form persists body-derived params as plain strings only.

  // v2.29.3 (Pass E2-4) — + Add FOREACH at the top level. Appends an empty
  // FOREACH node. The user fills in `over`/`as` and populates the body via
  // the nested +Add buttons that appear inside the FOREACH card.
  $('btn-add-strategy-foreach').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({ type: 'foreach', over: '', as: '', body: [] });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.30.0 (Pass G1) — + Add WAIT at the top level. Default to a 500ms
  // duration wait — the most common need ("pause a bit between iterations").
  // User can switch to condition mode via the card's mode toggle.
  $('btn-add-strategy-wait').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({ type: 'wait', mode: 'duration', durationMs: 500 });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.60.0 — + Add PAUSE at the top level. PAUSE has no parameters; it just
  // halts strategy execution until the user clicks Resume in the debugger.
  // Used for human intervention points (e.g. "let the user click the right
  // button manually, then resume").
  $('btn-add-strategy-pause').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({ type: 'pause' });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.61.0 — + Add SIEVE at the top level. Sieves transform list-typed
  // scope bindings: filter by assertion, sort by field, take first N.
  // Used between an upstream ENUMERATE-producing fragment and a downstream
  // FOREACH that needs only the matching/winning items.
  $('btn-add-strategy-sieve').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({
      type: 'sieve',
      source: '',
      output: '',
      analysisId: null,
      paramBindings: {},
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.31.0 (Pass G2) — + Add DETECT at the top level. Starts with a single
  // empty branch so the editor shows a condition slot right away. User can
  // add more branches via the card's "+ Add branch" button.
  $('btn-add-strategy-detect').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({
      type: 'detect',
      branches: [
        { condition: { type: 'selector_present', selector: '' }, body: [] },
      ],
      default: [],
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.32.0 (Pass H1) — + Add LOOP at the top level. Starts with an empty
  // condition + empty body + default maxIterations (100, matching the
  // data-model + engine fallback).
  $('btn-add-strategy-loop').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({
      type: 'loop',
      condition: { type: 'selector_present', selector: '' },
      body: [],
      maxIterations: 100,
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.33.0 (Pass H2) — + Add TRY at the top level. Starts with empty body
  // and empty recover. Empty recover swallows any body failure; typical
  // authoring pattern is to add body steps then optionally add recovery
  // steps if you want a real fallback rather than silent swallowing.
  $('btn-add-strategy-try').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({
      type: 'try',
      body: [],
      recover: [],
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.34.0 (Pass H3) — + Add NAVIGATE at the top level. Starts in url
  // mode with an empty literal URL.
  $('btn-add-strategy-navigate').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({
      type: 'navigate',
      mode: 'url',
      url: { kind: 'literal', value: '' },
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.71.0 — + Add SCROLL at the top level. Defaults to one viewport down.
  $('btn-add-strategy-scroll')?.addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({
      type: 'scroll',
      mode: 'by',
      distance: { kind: 'literal', value: '1.0' },
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.72.3 (Pass 4) — + Add OBSERVATION at the top level. Default
  // observationId is the first observation on the Ground (if any); else
  // empty string so the picker dropdown shows "no Observations on this Ground".
  $('btn-add-strategy-observation')?.addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    const observationCache = _strategyObservationCache;
    const first = observationCache.values().next().value;
    if (!first) {
      toast('No Observations on this Ground yet — author one in the Observations section first', 'warn');
      return;
    }
    // v2.72.7 (Pass 3e) — Default each declared param to a strategy_param
    // binding of the same name. Author can flip to literal/iteration_variable
    // in the editor.
    const params = Array.isArray(first.params) ? first.params : [];
    const paramBindings = {};
    for (const p of params) paramBindings[p] = { kind: 'strategy_param', name: p };
    strategyDraft.fragmentSteps.push({
      type: 'observation',
      observationId: first.id,
      paramBindings,
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // v2.37.0 (Pass J2) — + Add IN_NEW_TAB at the top level. Starts with a
  // null trigger (author fills it via "Use Fragment" / "Use NAVIGATE" in
  // the card) and empty body. closeOnExit defaults to true.
  $('btn-add-strategy-in-new-tab').addEventListener('click', () => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    strategyDraft.fragmentSteps.push({
      type: 'in_new_tab',
      trigger: null,
      body: [],
      closeOnExit: true,
    });
    renderStrategySteps();
    renderStrategyParamsPreview();
  });

  // ── v2.72.99 (Pass 4-d) — Pre/post condition Add + toggle handlers ────
  //
  // v2.72.24 (Pass 13) — Strategy pre/post add buttons + toggle tracking.
  // Default condition type is selector_present — the most common page-side
  // precondition pattern. Author changes via the row dropdown.

  $('btn-add-strategy-pre')?.addEventListener('click', (e) => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    e.preventDefault();
    strategyDraft.preconditions = strategyDraft.preconditions ?? [];
    const cond = emptyCondition('selector_present');
    strategyDraft.preconditions.push(cond);
    const sec = $('strategy-pre-section');
    if (sec) delete sec.dataset.userToggled;
    renderStrategyConditions('pre');
  });

  $('btn-add-strategy-post')?.addEventListener('click', (e) => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    e.preventDefault();
    strategyDraft.postconditions = strategyDraft.postconditions ?? [];
    const cond = emptyCondition('selector_present');
    strategyDraft.postconditions.push(cond);
    const sec = $('strategy-post-section');
    if (sec) delete sec.dataset.userToggled;
    renderStrategyConditions('post');
  });

  $('strategy-pre-section')?.addEventListener('toggle', (e) => {
    e.target.dataset.userToggled = '1';
  });

  $('strategy-post-section')?.addEventListener('toggle', (e) => {
    e.target.dataset.userToggled = '1';
  });

  // v2.74.155 — + Result button: append an empty output row and open the
  // section. User toggling is captured below so once they've manually
  // collapsed, future re-renders respect their choice.
  $('btn-add-strategy-output')?.addEventListener('click', (e) => {
    const strategyDraft = _strategyDraft;
    if (!strategyDraft) return;
    e.preventDefault();
    if (!Array.isArray(strategyDraft.outputs)) strategyDraft.outputs = [];
    strategyDraft.outputs.push({ name: '' });
    const sec = $('strategy-outputs-section');
    if (sec) delete sec.dataset.userToggled;
    renderStrategyOutputs();
  });

  $('strategy-outputs-section')?.addEventListener('toggle', (e) => {
    e.target.dataset.userToggled = '1';
  });

  // v2.73.2 (Pass 4-f Phase 2) — tier-choice buttons. Mirror the analysis
  // tier UI: set draft.tier, re-render to reveal tier-appropriate sections.
  // (These handlers were originally separate top-level addEventListener
  // calls in studio.js; folded in here when the last bits of strategy form
  // wiring migrated.)
  $('btn-strategy-tier-cache')?.addEventListener('click', () => {
    if (!_strategyDraft) return;
    _strategyDraft.tier = 'cache';
    renderStrategyTierUI();
    $('input-strategy-name')?.focus();
  });
  $('btn-strategy-tier-frontier')?.addEventListener('click', () => {
    if (!_strategyDraft) return;
    _strategyDraft.tier = 'frontier';
    renderStrategyTierUI();
    $('input-strategy-name')?.focus();
  });
}

// ─── Pass 4-c additions ──────────────────────────────────────────────────
//
// closeStrategyForm and wireTopLevelDragAndDrop both write to module
// state. Initially extracted using setter injection (Pass 4-c); state
// migrated to module-locals at the tail of Pass 4-f Phase 2 (v2.73.2),
// so writes are now plain assignments to _strategyDraft etc.

/**
 * Reset the form. All 6 state caches and _dragSourceIdx are zeroed; DOM
 * inputs are emptied; pre/post sections reset.
 * v2.72.98 (Pass 4-c) — moved from studio.js with setter-injection state.
 * v2.73.2 (Pass 4-f Phase 2) — state migration: plain assignments now.
 */
function closeStrategyForm() {
  _strategyDraft = null;
  _strategyFragmentCache = new Map();
  _strategyAssertionCache = new Map();
  _strategyAnalysisCache = new Map();
  _strategyObservationCache = new Map();
  _strategyPerspectiveCache = new Map();
  _dragSourceIdx = null;
  $('strategy-form-card').classList.add('hidden');
  $('input-strategy-name').value    = '';
  $('input-strategy-goal').value    = '';
  $('input-strategy-aliases').value = '';
  $('input-strategy-result-template').value = '';
  $('strategy-steps-list').innerHTML = '';
  $('strategy-params-preview').classList.add('hidden');
  $('strategy-params-preview').innerHTML = '';
  // v2.25.6 — clear composition warnings
  const warningsEl = $('strategy-warnings');
  if (warningsEl) { warningsEl.classList.add('hidden'); warningsEl.innerHTML = ''; }
  // v2.72.24 (Pass 13) — clear pre/post sections.
  const preEl = $('strategy-pre-list');
  if (preEl) preEl.innerHTML = '';
  const postEl = $('strategy-post-list');
  if (postEl) postEl.innerHTML = '';
  const preCount = $('strategy-pre-count');
  if (preCount) preCount.textContent = '0';
  const postCount = $('strategy-post-count');
  if (postCount) postCount.textContent = '0';
  const preSect = $('strategy-pre-section');
  if (preSect) { preSect.open = false; delete preSect.dataset.userToggled; }
  const postSect = $('strategy-post-section');
  if (postSect) { postSect.open = false; delete postSect.dataset.userToggled; }
}

/**
 * Drag-and-drop for TOP-LEVEL cards only. Nested reordering uses up/down
 * buttons. See v2.25.7 design notes for the drag-handle gating logic.
 * v2.72.98 (Pass 4-c) — moved from studio.js with setter-injection state.
 * v2.73.2 (Pass 4-f Phase 2) — state migration: now reads/writes
 * module-local _dragSourceIdx and _strategyDraft directly.
 */
function wireTopLevelDragAndDrop() {
  const listEl = $('strategy-steps-list');
  // Only look at top-level strategy-step-cards (have data-step-idx). FOREACH
  // cards and nested step cards are not draggable.
  listEl.querySelectorAll(':scope > .strategy-step-card').forEach(card => {
    const handle = card.querySelector('.strategy-step-handle');
    if (!handle) return;
    handle.addEventListener('mousedown', () => { card.draggable = true; });
    card.addEventListener('mouseup',   () => { setTimeout(() => { card.draggable = false; }, 0); });
    card.addEventListener('mouseleave', () => { if (!card.classList.contains('dragging')) card.draggable = false; });
    card.addEventListener('dragstart', (e) => {
      if (!card.draggable) { e.preventDefault(); return; }
      const idx = parseInt(card.dataset.stepIdx, 10);
      _dragSourceIdx = idx;
      card.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', String(idx)); } catch { /* ignore */ }
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      card.draggable = false;
      _dragSourceIdx = null;
      listEl.querySelectorAll('.strategy-step-card').forEach(c => c.classList.remove('drop-before', 'drop-after'));
    });
    card.addEventListener('dragover', (e) => {
      if (_dragSourceIdx === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const targetIdx = parseInt(card.dataset.stepIdx, 10);
      if (targetIdx === _dragSourceIdx) return;
      const rect = card.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const isAbove = e.clientY < midY;
      card.classList.toggle('drop-before', isAbove);
      card.classList.toggle('drop-after', !isAbove);
    });
    card.addEventListener('dragleave', (e) => {
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('drop-before', 'drop-after');
      }
    });
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      if (_dragSourceIdx === null) return;
      const targetIdx = parseInt(card.dataset.stepIdx, 10);
      if (targetIdx === _dragSourceIdx) return;
      const dropBefore = card.classList.contains('drop-before');
      let insertAt = dropBefore ? targetIdx : targetIdx + 1;
      if (_dragSourceIdx < insertAt) insertAt -= 1;
      const arr = _strategyDraft.fragmentSteps;
      const [moved] = arr.splice(_dragSourceIdx, 1);
      arr.splice(insertAt, 0, moved);
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });
}

// ─── Pass 4-d additions ──────────────────────────────────────────────────
//
// openStrategyForm is the form-lifecycle entry point — loads ground caches,
// initializes/normalizes the draft, renders the form. editStrategy is the
// thin wrapper that loads an existing record by id and forwards.
//
// State writes go through _setup setters (8 sites: 6 cache-loaders + draft
// init + analyses-refresh after sieve migration).

/**
 * v2.29.0+ — Open the Strategy form. If existingStrategy is supplied,
 * the form opens in edit mode with all fields populated; otherwise it
 * opens fresh. Loads all per-Ground caches needed by the form modules
 * (Fragments, Assertions, Perspectives, Analyses, Observations) and runs
 * legacy-sieve migration if any inline-ops sieves remain.
 */
export async function openStrategyForm(groundId, existingStrategy = null) {
  const ground = await StorageManager.getGround(groundId);
  if (!ground) { toast('Ground not found', 'err'); return; }

  // Load all Fragments on this Ground to populate step dropdowns
  const fragments = await StorageManager.listFragments(groundId);
  _strategyFragmentCache = new Map(fragments.map(f => [f.id, f]));

  // v2.42.0 (Pass M2) — Load named Assertions on this Ground for the
  // "named assertion" picker in DETECT/LOOP/WAIT condition editors.
  const assertions = await StorageManager.listAssertions(groundId);
  _strategyAssertionCache = new Map(assertions.map(p => [p.id, p]));

  // v2.72.29 (Pass 17) — Load Perspectives for the perspective_ref picker.
  const perspectives = await StorageManager.listPerspectives(groundId);
  _strategyPerspectiveCache = new Map(perspectives.map(l => [l.id, l]));

  // v2.63.0 (Iteration B) — Load Analyses (built-in + user) for the SIEVE
  // step's Analysis-picker dropdown. Cache mirrors the fragment/assertion
  // pattern. Built-ins shipped with the system are always available.
  const userAnalyses = await StorageManager.listAnalyses(groundId);
  _strategyAnalysisCache = new Map([
    ...BUILTIN_ANALYSES.map(a => [a.id, a]),
    ...userAnalyses.map(a => [a.id, a]),
  ]);

  // v2.72.3 (Pass 4) — Load Observations on this Ground for the
  // OBSERVATION node picker.
  const observations = await StorageManager.listObservations(groundId);
  _strategyObservationCache = new Map(observations.map(o => [o.id, o]));

  // v2.71.1 — Removed fragment-count gate. Strategies are no longer
  // fragment-only — NAVIGATE, SCROLL, PAUSE, WAIT, IN_NEW_TAB are all
  // first-class compositional nodes that don't reference any fragment.
  // A strategy that does `NAVIGATE → WAIT → SCROLL → PAUSE` is fully
  // valid without any fragment authored. The empty-state hint inside
  // the form (renderStrategySteps) provides appropriate guidance for
  // authors who DO want to start with fragments.

  const strategyDraft = existingStrategy
    ? {
        groundId, id: existingStrategy.id,
        name: existingStrategy.name ?? '',
        goal: existingStrategy.goal ?? '',
        aliases: (existingStrategy.aliases ?? []).join(', '),
        resultTemplate: existingStrategy.resultTemplate ?? '',   // E1
        // v2.29.0 (Pass E2-1) — Normalize the body on load. Legacy Strategies
        // without `type` fields come back with `type: 'fragment'` filled in,
        // FOREACH bodies are recursively normalized. Editor code from here on
        // sees one canonical shape.
        //
        // v2.43.2 — Then unwrap Assertion-shaped conditions back to single-
        // condition shape. The editor was built pre-M1 around single
        // conditions; the unwrap restores that mental model. See helper
        // docstring above for full reasoning.
        fragmentSteps: unwrapAssertionConditionsForEditor(
          normalizeStrategyBody(existingStrategy.fragmentSteps)
        ),
        // v2.72.24 (Pass 13) — Strategy pre/post envelopes. Storage migration
        // ensures envelope shape on read; extract conditions array and
        // match/count for the form, persist back as envelope on save.
        preconditions: (existingStrategy.preconditions?.conditions
          ?? (Array.isArray(existingStrategy.preconditions) ? existingStrategy.preconditions : [])).map(c => ({ ...c })),
        preMatch: existingStrategy.preconditions?.match ?? 'all',
        preCount: existingStrategy.preconditions?.count,
        postconditions: (existingStrategy.postconditions?.conditions
          ?? (Array.isArray(existingStrategy.postconditions) ? existingStrategy.postconditions : [])).map(c => ({ ...c })),
        postMatch: existingStrategy.postconditions?.match ?? 'all',
        postCount: existingStrategy.postconditions?.count,
        // v2.74.155 — Declared outputs (the Results section). Empty when
        // the record predates this feature — the runtime treats absent
        // / empty outputs as "promote everything" for back-compat.
        // Clone each row so editing one doesn't mutate the stored record.
        outputs: Array.isArray(existingStrategy.outputs)
          ? existingStrategy.outputs.map(o => ({ ...o })) : [],
        // v2.72.27 (Pass 15) — Tier from implementations envelope. Storage
        // migration ensures implementations is present; default cache for
        // safety on records that bypassed migration.
        tier: existingStrategy.implementations?.[0]?.tier ?? 'cache',
        // v2.74.72 — declaredInputs field retired from the Workflow draft.
        // Typed inputs are authored on the parent Strategy form (studio.js).
        // Existing records with typed-input params still load via
        // normalizeStrategyParams; they survive save→load round-trips
        // unmodified because the save path now only writes body-derived
        // entries and preserves nothing else.
        isEditing: true,
      }
    : {
        groundId, id: uid(),
        name: '', goal: '', aliases: '',
        resultTemplate: '',   // E1
        fragmentSteps: [],
        // v2.72.24 (Pass 13) — Empty pre/post envelopes for new strategies.
        preconditions: [],
        preMatch: 'all',
        preCount: undefined,
        postconditions: [],
        postMatch: 'all',
        postCount: undefined,
        // v2.74.155 — No declared outputs by default. Empty list →
        // runtime promotes the full final scope, preserving the
        // historical workflow-step merge behavior.
        outputs: [],
        // v2.72.27 (Pass 15) — Tier null until picked. The tier picker
        // gates form interaction for new strategies.
        tier: null,
        isEditing: false,
      };
  _strategyDraft = strategyDraft;

  // v2.63.0 (Iteration B) — Migrate any legacy inline-ops sieves to
  // Analysis references. Auto-creates user Analyses for each. After
  // migration, write the new shape back to storage so the migration is
  // one-shot — repeat opens of the same strategy don't keep re-migrating
  // and producing duplicate auto-Analyses (v2.63.1 fix).
  if (existingStrategy) {
    const migratedCount = await migrateLegacySieves(
      strategyDraft.fragmentSteps,
      groundId,
      strategyDraft.name || '(unnamed)'
    );
    if (migratedCount > 0) {
      // Persist the migrated strategy shape back to disk before the editor
      // opens. This is a one-shot upgrade side effect — same approach used
      // when normalizing legacy structures elsewhere. The user's edits
      // proceed against the migrated shape; the durable record is now
      // consistent regardless of whether they save again.
      try {
        await StorageManager.saveStrategy({
          ...existingStrategy,
          fragmentSteps: strategyDraft.fragmentSteps,
          updatedAt: Date.now(),
        });
      } catch (e) {
        console.error('[StrategyForm] Failed to persist migrated strategy:', e.message);
      }
      toast(`Migrated ${migratedCount} inline sieve${migratedCount === 1 ? '' : 's'} to library Analyses.`, 'ok');
      // Refresh the analyses cache to include newly-created ones so the
      // editor's dropdown shows them.
      const refreshed = await StorageManager.listAnalyses(groundId);
      _strategyAnalysisCache = new Map([
        ...BUILTIN_ANALYSES.map(a => [a.id, a]),
        ...refreshed.map(a => [a.id, a]),
      ]);
    }
  }

  $('strategy-form-title').textContent = existingStrategy ? 'Edit Strategy' : 'New Strategy';
  $('strategy-form-ground-label').textContent = `on Ground: ${ground.name ?? groundId}`;
  $('input-strategy-name').value     = strategyDraft.name;
  $('input-strategy-goal').value     = strategyDraft.goal;
  $('input-strategy-aliases').value  = strategyDraft.aliases;
  $('input-strategy-result-template').value = strategyDraft.resultTemplate;

  renderStrategySteps();
  renderStrategyParamsPreview();
  // v2.74.72 — renderStrategyInputsEditor call removed; the editor moved
  // to the Strategy form (studio.js).
  // v2.72.24 (Pass 13) — Render strategy pre/post condition lists.
  renderStrategyConditions('pre');
  renderStrategyConditions('post');
  // v2.74.155 — Render the declared-outputs (Results) list.
  renderStrategyOutputs();
  // v2.72.27 (Pass 15) — Render tier picker / indicator and gate the
  // form's body sections by tier.
  renderStrategyTierUI();

  $('strategy-form-card').classList.remove('hidden');
  $('input-strategy-name').focus();
}

/**
 * Load an existing Strategy by id and open the form in edit mode.
 */
export async function editStrategy(strategyId) {
  const existing = await StorageManager.getStrategy(strategyId);
  if (!existing) { toast('Strategy not found', 'err'); return; }
  openStrategyForm(existing.groundId, existing);
}

// ─── Pass 4-e additions ──────────────────────────────────────────────────
//
// renderStrategyNodes is the recursive body renderer — the largest single
// function in the strategy form. It dispatches on node.type to render each
// of 12 step-card variants (fragment, foreach, wait, pause, sieve, detect,
// loop, try, navigate, scroll, observation, in_new_tab) and returns the
// composed HTML string. Recursive over body[]/branches[]/recover[] arms.
//
// State reads (5 caches) hit module-locals directly (post-Pass-4-f-Phase-2
// state migration); renderConditionEditor lives in studio.js (used by 4
// form modules) and is reached via the _setup injection. Sibling
// renderStrategyBindings + recursive self-call resolve in module scope.

/**
 * Render an array of body nodes. `pathPrefix` is the path array from
 * root to this body — used to construct the data-path on each child.
 * `iterScope` is a Set of iteration variable names in scope from enclosing
 * FOREACH ancestors — consumed by the binding renderer to show an
 * iteration_variable option when appropriate.
 */
function renderStrategyNodes(nodes, pathPrefix, fragOptions, iterScope, availableLists) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return `<div class="empty-state small nested">Empty body — click a button below to add a step.</div>`;
  }

  const isTopLevel = pathPrefix.length === 0;
  // Available lists is a running set of list-binding names produced by
  // ENUMERATE actions in PRECEDING fragment steps. Updated as we walk.
  // Passed in from the entry point (renderStrategySteps) and mutated as
  // we descend + iterate siblings.
  availableLists = availableLists ?? new Set();

  return nodes.map((node, idx) => {
    const path = [...pathPrefix, idx];
    const pathJson = JSON.stringify(path);
    const isFirst = idx === 0;
    const isLast  = idx === nodes.length - 1;

    if (node.type === 'foreach') {
      // Snapshot available-lists AT THIS POINT for the datalist (what an
      // authored `over` reference could legally resolve to).
      const visibleListNames = [...availableLists].sort();
      const datalistId = `foreach-over-options-${pathJson.replace(/[^a-z0-9]/gi, '-')}`;
      const datalistHtml = visibleListNames.length > 0
        ? `<datalist id="${datalistId}">${visibleListNames.map(n => `<option value="${escAttr(n)}"></option>`).join('')}</datalist>`
        : '';

      // Recurse into body with this FOREACH's `as` added to iter-scope.
      // Clone availableLists before recursing so body additions don't leak
      // to our siblings — but since the engine only exposes body-internal
      // bindings during iterations (not to later siblings of the FOREACH),
      // this matches runtime semantics.
      const childScope = new Set(iterScope);
      if (node.as) childScope.add(node.as);
      const bodyAvailable = new Set(availableLists);
      const nestedHtml = renderStrategyNodes(node.body ?? [], [...path, 'body'], fragOptions, childScope, bodyAvailable);
      const bodyAddPathJson = JSON.stringify([...path, 'body']);

      return `
        <div class="strategy-foreach-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-foreach-head">
            <span class="strategy-foreach-badge">FOREACH</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove (including body)">✕</button>
          </div>
          <div class="strategy-foreach-fields">
            <label class="strategy-foreach-field">
              <span class="strategy-foreach-label">Iterate over (list binding)</span>
              <input type="text" class="foreach-over-input" data-path="${escAttr(pathJson)}"
                     value="${escAttr(node.over ?? '')}"
                     placeholder="${visibleListNames.length > 0 ? `e.g. ${escAttr(visibleListNames[0])} — from an earlier OBSERVATION (list_of_records) or ENUMERATE` : 'e.g. JOBS — name of a list from an earlier OBSERVATION (list_of_records) or ENUMERATE'}"
                     ${datalistHtml ? `list="${datalistId}"` : ''} />
              ${datalistHtml}
              ${visibleListNames.length === 0 ? `<span class="strategy-foreach-hint">No list-producing steps yet — add an OBSERVATION (list_of_records shape) upstream, or an ENUMERATE action to an upstream Fragment.</span>` : ''}
            </label>
            <label class="strategy-foreach-field">
              <span class="strategy-foreach-label">Bind each item as</span>
              <input type="text" class="foreach-as-input" data-path="${escAttr(pathJson)}"
                     value="${escAttr(node.as ?? '')}"
                     placeholder="e.g. JOB — iteration variable name for the body" />
            </label>
            <div class="strategy-foreach-gotcha">
              <span class="strategy-foreach-gotcha-icon">ⓘ</span>
              Body fragments inside FOREACH always re-run per iteration — the "skip when done" optimisation is disabled inside the loop.
            </div>
          </div>
          <div class="strategy-foreach-body">
            ${nestedHtml}
            <div class="strategy-foreach-body-add">
              <button class="btn-secondary tiny" data-action="add-fragment-in-body" data-path="${escAttr(bodyAddPathJson)}">+ Fragment in body</button>
              <button class="btn-secondary tiny" data-action="add-foreach-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Nested FOREACH">+ FOREACH in body</button>
              <button class="btn-secondary tiny" data-action="add-wait-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a WAIT inside the loop body">+ WAIT in body</button>
              <button class="btn-secondary tiny" data-action="add-pause-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Halt the strategy until the user clicks Resume — for human intervention">+ PAUSE in body</button>
              <button class="btn-secondary tiny" data-action="add-sieve-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a SIEVE — narrow a list (filter / sort / take) before iterating it">+ SIEVE in body</button>
              <button class="btn-secondary tiny" data-action="add-detect-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Branch based on page state (e.g. recover if navigated away)">+ DETECT in body</button>
              <button class="btn-secondary tiny" data-action="add-loop-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Nested LOOP — e.g. paginate sub-list per iteration">+ LOOP in body</button>
              <button class="btn-secondary tiny" data-action="add-try-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Wrap a body in TRY so the FOREACH can skip items that fail">+ TRY in body</button>
              <button class="btn-secondary tiny" data-action="add-navigate-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a NAVIGATE step (URL / back / reload)">+ NAVIGATE in body</button>
              <button class="btn-secondary tiny" data-action="add-scroll-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a SCROLL step (smooth scroll the window by N viewports)">+ SCROLL in body</button>
              <button class="btn-secondary tiny" data-action="add-observation-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add an OBSERVATION step (read page state into scope)">+ OBSERVE in body</button>
              <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add an IN_NEW_TAB block — trigger opens a new tab, body runs there">+ IN_NEW_TAB in body</button>
            </div>
          </div>
        </div>`;
    }

    // v2.60.0 — PAUSE node render. Leaf, no parameters. Just a card showing
    // the badge and step controls. Halts strategy execution at this point
    // until the user clicks Resume in the debugger. Distinct from WAIT
    // (which sleeps or polls); PAUSE waits indefinitely for user signal.
    if (node.type === 'pause') {
      return `
        <div class="strategy-pause-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-pause-head">
            <span class="strategy-pause-badge">PAUSE</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <span class="strategy-pause-hint">Strategy halts here — click Resume in the debugger to continue.</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove">✕</button>
          </div>
        </div>`;
    }

    // v2.61.0 — SIEVE node render. Card with source/output binding inputs
    // and a sub-list of operations (filter / sort / take). Each operation
    // has its own mini-editor; assertions use a recursive assertion-builder.
    if (node.type === 'sieve') {
      // v2.63.0 (Iteration B) — SIEVE node renders as a reference to a
      // named Analysis. Inline operations are no longer authored here;
      // Analyses live in the Analyses library and are picked from the
      // dropdown. The user binds the Analysis's params + source + output.

      // v2.63.1 — Detect missing-Analysis case (referenced id no longer
      // exists in cache, e.g. user deleted the Analysis). Show the dangling
      // id in the dropdown so the user sees the situation; preserve any
      // existing paramBindings rather than silently dropping them.
      const chosen = node.analysisId ? _strategyAnalysisCache.get(node.analysisId) : null;
      const isMissing = node.analysisId && !chosen;

      // v2.72.20 (Pass 7c) — Detect body kind of the chosen Analysis. Drives
      // source field visibility (template Analyses don't take a source list).
      const chosenImpl0 = chosen && Array.isArray(chosen.implementations) && chosen.implementations.length > 0
        ? chosen.implementations[0] : null;
      const chosenTier = chosenImpl0?.tier ?? 'cache';
      const chosenBodyKind = (chosenTier === 'cache') ? (chosenImpl0?.body?.kind ?? 'operations') : null;
      const isTemplateAnalysis = chosenBodyKind === 'template';
      // v2.74.136 — Detect transform-body Analysis. Transform body wires
      // inputs and outputs by declared name (just like template body's
      // inputs); neither `node.source` nor `node.output` is used by the
      // runtime. The card shows the declared inputs/outputs as read-only
      // rows with availability checks against upstream-produced names.
      const isTransformAnalysis = chosenBodyKind === 'transform';

      // v2.72.22 (Pass: frontier compose) — Detect frontier compose mode
      // for the chosen Analysis. A frontier Analysis with pre conditions
      // referencing scope bindings (any binding name other than INPUT)
      // runs in compose mode: engine fans those bindings in to the model
      // and the model synthesizes the output. Source-list picker hidden;
      // declared inputs panel shown instead (mirrors template).
      const chosenPreConds = chosen?.preconditions?.conditions
        ?? (Array.isArray(chosen?.preconditions) ? chosen.preconditions : []);
      const chosenPreBindings = chosenPreConds
        .map(c => (c && typeof c === 'object' && typeof c.binding === 'string') ? c.binding : null)
        .filter(b => b && b !== 'INPUT');
      const isFrontierComposeAnalysis = chosenTier === 'frontier' && chosenPreBindings.length > 0;

      // Build Analysis dropdown options. v2.72.20 — split by body kind
      // for visual differentiation (operations / template / frontier /
      // frontier-compose).
      const annotateName = (a) => {
        const aImpl0 = Array.isArray(a.implementations) && a.implementations.length > 0 ? a.implementations[0] : null;
        const aTier = aImpl0?.tier ?? 'cache';
        const aKind = (aTier === 'cache') ? (aImpl0?.body?.kind ?? 'operations') : aTier;
        // v2.72.22 — Frontier with pre bindings is compose-style; annotate
        // distinctly from regular [frontier] (single-source list-reduction).
        let tag = '';
        if (aKind === 'template') {
          tag = ' [template]';
        } else if (aKind === 'frontier') {
          const aPreConds = a?.preconditions?.conditions
            ?? (Array.isArray(a?.preconditions) ? a.preconditions : []);
          const aHasBindingPre = aPreConds.some(c =>
            c && typeof c === 'object'
            && typeof c.binding === 'string'
            && c.binding && c.binding !== 'INPUT');
          tag = aHasBindingPre ? ' [compose]' : ' [frontier]';
        }
        return `${a.name ?? a.id}${tag}`;
      };
      const builtinAnalyses = [..._strategyAnalysisCache.values()].filter(a => a.id?.startsWith?.('builtin:'));
      const userAnalyses    = [..._strategyAnalysisCache.values()].filter(a => !a.id?.startsWith?.('builtin:'));
      const analysisOpts =
        '<option value="">— select an Analysis —</option>' +
        (isMissing
          ? `<option value="${escAttr(node.analysisId)}" selected>⚠ deleted Analysis: ${escHtml(node.analysisId)}</option>`
          : '') +
        (builtinAnalyses.length > 0
          ? `<optgroup label="Built-in">${builtinAnalyses
              .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
              .map(a => `<option value="${escAttr(a.id)}"${a.id === node.analysisId ? ' selected' : ''}>${escHtml(annotateName(a))}</option>`)
              .join('')}</optgroup>`
          : '') +
        (userAnalyses.length > 0
          ? `<optgroup label="On this Ground">${userAnalyses
              .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
              .map(a => `<option value="${escAttr(a.id)}"${a.id === node.analysisId ? ' selected' : ''}>${escHtml(annotateName(a))}</option>`)
              .join('')}</optgroup>`
          : '');

      // Description block — for found Analyses, the Analysis's description.
      // For missing Analyses, an explanatory note so the user knows what
      // happened without losing their binding work.
      const chosenDescHtml = chosen?.description
        ? `<div class="sieve-analysis-desc">${escHtml(chosen.description)}</div>`
        : (isMissing
          ? `<div class="sieve-analysis-desc sieve-analysis-missing">The referenced Analysis was deleted. Pick another Analysis or recreate one with the original id. Existing param bindings are preserved below.</div>`
          : '');

      // Source datalist — reuses upstream availableLists set
      const visibleListNames = [...availableLists].sort();
      const datalistId = `sieve-source-options-${pathJson.replace(/[^a-z0-9]/gi, '-')}`;
      const datalistHtml = visibleListNames.length > 0
        ? `<datalist id="${datalistId}">${visibleListNames.map(n => `<option value="${escAttr(n)}"></option>`).join('')}</datalist>`
        : '';

      // Param binding rows. v2.63.1 — when the Analysis is missing, derive
      // param names from the existing paramBindings so the user sees their
      // bindings instead of an empty list.
      const bindings = node.paramBindings ?? {};
      const params = chosen
        ? (Array.isArray(chosen.params) ? chosen.params : [])
        : (isMissing ? Object.keys(bindings) : []);
      // What iteration variables and strategy-list params are visible at
      // this position? Reuse iterScope (FOREACH `as` names already seen).
      const iterVars = [...iterScope].sort();

      const paramRowsHtml = params.length === 0
        ? '<div class="sieve-params-empty"></div>'
        : params.map(pname => {
            const b = bindings[pname] ?? { kind: 'literal', value: '' };
            const kind = b.kind ?? 'literal';
            return `
              <div class="sieve-param-row" data-path="${escAttr(pathJson)}" data-param="${escAttr(pname)}">
                <span class="sieve-param-name">${escHtml(pname)}</span>
                <select class="sieve-param-kind" data-path="${escAttr(pathJson)}" data-param="${escAttr(pname)}">
                  <option value="literal"${kind === 'literal' ? ' selected' : ''}>Literal</option>
                  <option value="iteration_variable"${kind === 'iteration_variable' ? ' selected' : ''}${iterVars.length === 0 ? ' disabled' : ''}>Iteration variable</option>
                  <option value="strategy_param"${kind === 'strategy_param' ? ' selected' : ''}>Strategy param</option>
                </select>
                ${kind === 'iteration_variable'
                  ? `<select class="sieve-param-iter" data-path="${escAttr(pathJson)}" data-param="${escAttr(pname)}">
                      ${iterVars.length === 0 ? '<option value="">no iteration variables in scope</option>' : ''}
                      ${iterVars.map(n => `<option value="${escAttr(n)}"${n === b.name ? ' selected' : ''}>${escHtml(n)}</option>`).join('')}
                    </select>`
                  : `<input type="text" class="sieve-param-value" data-path="${escAttr(pathJson)}" data-param="${escAttr(pname)}"
                            value="${escAttr(kind === 'literal' ? (b.value ?? '') : (b.name ?? ''))}"
                            placeholder="${kind === 'strategy_param' ? 'strategy param name' : 'literal value'}" />`
                }
              </div>`;
          }).join('');

      const html = `
        <div class="strategy-sieve-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-sieve-head">
            <span class="strategy-sieve-badge">ANALYZE</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove">✕</button>
          </div>
          <label class="sieve-analysis-row">
            <span class="sieve-binding-label">Analysis</span>
            <select class="sieve-analysis-select" data-path="${escAttr(pathJson)}">
              ${analysisOpts}
            </select>
          </label>
          ${chosenDescHtml}
          <div class="strategy-sieve-bindings">
            ${isTransformAnalysis ? (() => {
              // v2.74.136 — Transform Analyses wire BOTH inputs and outputs
              // by declared name (no source field, no output field on the
              // sieve node — the runtime uses the declared names directly
              // to read from / write to the live scope).
              // v2.74.137 — Compact inline chips instead of the verbose
              // row-with-status layout inherited from template-body. Each
              // binding becomes a single chip showing name + kind, with
              // input chips picking up a missing/bound visual state. Chips
              // flow horizontally and wrap, taking a fraction of the
              // vertical space the rows did for multi-input Analyses.
              const declaredInputs  = Array.isArray(chosenImpl0?.body?.inputs)  ? chosenImpl0.body.inputs  : [];
              const declaredOutputs = Array.isArray(chosenImpl0?.body?.outputs) ? chosenImpl0.body.outputs : [];
              const upstreamNames = new Set([...availableLists, ...iterScope]);
              const inputChips = declaredInputs.length === 0
                ? `<span class="sieve-binding-empty">no inputs</span>`
                : declaredInputs.map(inp => {
                    const ok = upstreamNames.has(inp.name);
                    return `<span class="sieve-binding-chip${ok ? '' : ' is-unbound'}" title="${ok ? 'bound by an upstream node' : 'not yet bound by any upstream node — strategy will fail at this step'}">
                      <code class="sieve-binding-chip-name">${escHtml(inp.name)}</code>
                      <span class="sieve-binding-chip-kind">${escHtml(inp.expects)}</span>
                    </span>`;
                  }).join('');
              const outputChips = declaredOutputs.length === 0
                ? `<span class="sieve-binding-empty">no outputs</span>`
                : declaredOutputs.map(out =>
                    `<span class="sieve-binding-chip sieve-binding-chip-output" title="produced by this step; available to downstream nodes">
                      <code class="sieve-binding-chip-name">${escHtml(out.name)}</code>
                      <span class="sieve-binding-chip-kind">${escHtml(out.expects)}</span>
                    </span>`
                  ).join('');
              // Register declared outputs as available bindings for
              // downstream nodes' availability checks. The runtime writes
              // these into the live scope after the step.
              for (const out of declaredOutputs) {
                if (out?.name) availableLists.add(out.name);
              }
              return `
                <div class="sieve-transform-wiring">
                  <div class="sieve-transform-row">
                    <span class="sieve-transform-row-label">in</span>
                    <div class="sieve-transform-row-chips">${inputChips}</div>
                  </div>
                  <div class="sieve-transform-row">
                    <span class="sieve-transform-row-label">out</span>
                    <div class="sieve-transform-row-chips">${outputChips}</div>
                  </div>
                </div>`;
            })() : isTemplateAnalysis ? (() => {
              // Template Analyses pull inputs from scope by name; no source-list
              // picker. Show declared inputs with an availability check so the
              // author sees which ones are bound by upstream nodes vs unbound.
              const declared = Array.isArray(chosenImpl0?.body?.inputs) ? chosenImpl0.body.inputs : [];
              const upstreamNames = new Set([...availableLists, ...iterScope]);
              const inputRows = declared.length === 0
                ? `<div class="sieve-template-inputs-empty"><span class="field-hint">This Analysis declares no inputs.</span></div>`
                : declared.map(inp => {
                    const ok = upstreamNames.has(inp.name);
                    const itemSuffix = inp.expects === 'list' && inp.itemKind ? ` of ${inp.itemKind}` : '';
                    return `<div class="sieve-template-input-row${ok ? '' : ' missing'}">
                      <span class="sieve-template-input-name">${escHtml(inp.name)}</span>
                      <span class="sieve-template-input-kind">${escHtml(inp.expects)}${escHtml(itemSuffix)}</span>
                      <span class="sieve-template-input-status" title="${ok ? 'bound by an upstream node' : 'not yet bound by any upstream node — strategy will fail at this step'}">${ok ? '✓ bound' : '⚠ unbound'}</span>
                    </div>`;
                  }).join('');
              return `
                <div class="sieve-template-info">
                  <div class="sieve-template-info-line"><span class="field-hint">Inputs come from scope by name. No source-list picker — declared inputs below.</span></div>
                  <div class="sieve-template-inputs">${inputRows}</div>
                </div>
                <label class="sieve-binding-row">
                  <span class="sieve-binding-label">Output</span>
                  <input type="text" class="sieve-output-input" data-path="${escAttr(pathJson)}"
                         value="${escAttr(node.output ?? '')}"
                         placeholder="document binding name (e.g. REPORT)" />
                </label>`;
            })() : isFrontierComposeAnalysis ? (() => {
              // v2.72.22 — Frontier compose: bindings come from pre conditions.
              // Mirrors template UI (no source-list picker; bindings panel
              // with availability check). Each pre condition binding becomes
              // an input row.
              const upstreamNames = new Set([...availableLists, ...iterScope]);
              // De-duplicate; preserve order.
              const seen = new Set();
              const uniqueBindings = chosenPreBindings.filter(b => {
                if (seen.has(b)) return false;
                seen.add(b);
                return true;
              });
              const inputRows = uniqueBindings.length === 0
                ? `<div class="sieve-template-inputs-empty"><span class="field-hint">No pre conditions reference bindings.</span></div>`
                : uniqueBindings.map(name => {
                    const ok = upstreamNames.has(name);
                    return `<div class="sieve-template-input-row${ok ? '' : ' missing'}">
                      <span class="sieve-template-input-name">${escHtml(name)}</span>
                      <span class="sieve-template-input-kind">from pre</span>
                      <span class="sieve-template-input-status" title="${ok ? 'bound by an upstream node' : 'not yet bound by any upstream node — strategy will fail at this step'}">${ok ? '✓ bound' : '⚠ unbound'}</span>
                    </div>`;
                  }).join('');
              // Output placeholder: post conditions hint at expected kind.
              const chosenPostConds = chosen?.postconditions?.conditions
                ?? (Array.isArray(chosen?.postconditions) ? chosen.postconditions : []);
              const wantsDocumentOutput = chosenPostConds.some(c =>
                c?.type === 'binding_is_document' && c?.binding === 'OUTPUT');
              const outputPlaceholder = wantsDocumentOutput
                ? 'document binding name (e.g. REPORT)'
                : 'result binding name (e.g. SUMMARY)';
              return `
                <div class="sieve-template-info">
                  <div class="sieve-template-info-line"><span class="field-hint">Frontier compose: model fans in scope bindings named by pre conditions. No source-list picker.</span></div>
                  <div class="sieve-template-inputs">${inputRows}</div>
                </div>
                <label class="sieve-binding-row">
                  <span class="sieve-binding-label">Output</span>
                  <input type="text" class="sieve-output-input" data-path="${escAttr(pathJson)}"
                         value="${escAttr(node.output ?? '')}"
                         placeholder="${escAttr(outputPlaceholder)}" />
                </label>`;
            })() : `
            <label class="sieve-binding-row">
              <span class="sieve-binding-label">Source</span>
              <input type="text" class="sieve-source-input" data-path="${escAttr(pathJson)}"
                     value="${escAttr(node.source ?? '')}"
                     placeholder="${visibleListNames.length > 0 ? `e.g. ${escAttr(visibleListNames[0])}` : 'upstream list binding (e.g. DEVICES)'}"
                     ${datalistHtml ? `list="${datalistId}"` : ''} />
              ${datalistHtml}
            </label>
            <label class="sieve-binding-row">
              <span class="sieve-binding-label">Output</span>
              <input type="text" class="sieve-output-input" data-path="${escAttr(pathJson)}"
                     value="${escAttr(node.output ?? '')}"
                     placeholder="result binding name (e.g. TARGET)" />
            </label>`}
          </div>
          ${params.length > 0 ? `<div class="strategy-sieve-params">${paramRowsHtml}</div>` : ''}
        </div>`;
      // Register sieve output so later siblings' datalists see it.
      // v2.72.18 (Pass 7b) — Skip template-body Analyses: their output is
      // a document, not a list. Downstream FOREACH/SIEVE expecting a list
      // would fail at runtime.
      // v2.74.136 — Skip transform-body Analyses entirely: their outputs
      // are already registered above (inside the transform branch using
      // declaredOutputs); `node.output` isn't used at runtime so any
      // stray value here would be misleading data.
      const out = String(node.output ?? '').trim();
      if (out) {
        const cachedAnalysis = node.analysisId ? _strategyAnalysisCache.get(node.analysisId) : null;
        const cImpl0 = cachedAnalysis && Array.isArray(cachedAnalysis.implementations) && cachedAnalysis.implementations.length > 0
          ? cachedAnalysis.implementations[0] : null;
        const skipNodeOutput = cImpl0?.body?.kind === 'template' || cImpl0?.body?.kind === 'transform';
        if (!skipNodeOutput) availableLists.add(out);
      }
      return html;
    }

    // v2.30.0 (Pass G1) — WAIT node render. Mode toggle (duration | condition),
    // with inline fields for the chosen mode. Duration uses a simple quick-pick
    // + custom-value input. Condition uses condition-type selector + the field
    // relevant to that type (selector / pattern / text) + timeout + poll.
    if (node.type === 'wait') {
      const mode = node.mode === 'condition' ? 'condition' : 'duration';

      // Duration mode UI
      let modeBodyHtml;
      if (mode === 'duration') {
        const durationMs = Number.isFinite(node.durationMs) ? node.durationMs : 500;
        modeBodyHtml = `
          <div class="wait-mode-body">
            <label class="wait-field">
              <span class="wait-label">Wait for</span>
              <input type="number" class="wait-duration-input" data-path="${escAttr(pathJson)}"
                     min="0" step="50" value="${durationMs}" />
              <span class="wait-unit">ms</span>
            </label>
            <div class="wait-quick-picks">
              ${[250, 500, 1000, 2000, 5000].map(ms =>
                `<button type="button" class="btn-tiny-chip wait-duration-preset" data-path="${escAttr(pathJson)}" data-ms="${ms}" ${ms === durationMs ? 'aria-pressed="true"' : ''}>${ms < 1000 ? `${ms}ms` : `${ms/1000}s`}</button>`
              ).join('')}
            </div>
            <div class="wait-gotcha">
              <span class="wait-gotcha-icon">ⓘ</span>
              Fixed delay — always waits the full duration. For a faster "wait until ready" use the Condition mode.
            </div>
          </div>`;
      } else {
        // Condition mode UI — v2.41.0 (Pass M1.1): use the shared
        // renderConditionEditor for the type+value pieces. Timeout and
        // poll-interval are WAIT-specific and stay inline.
        const cond = node.condition ?? { type: 'selector_present', selector: '' };
        const timeoutMs = Number.isFinite(node.timeoutMs) ? node.timeoutMs : 5000;
        const pollIntervalMs = Number.isFinite(node.pollIntervalMs) ? node.pollIntervalMs : 100;

        modeBodyHtml = `
          <div class="wait-mode-body">
            <label class="wait-field">
              <span class="wait-label">Wait until</span>
              ${_setup.renderConditionEditor(cond, [...path, 'condition'], { assertions: [..._strategyAssertionCache.values()], perspectives: [..._strategyPerspectiveCache.values()], iterScope, allowedFamilies: ['page', 'scope'] })}
            </label>
            <label class="wait-field wait-field-inline">
              <span class="wait-label">Timeout (ms)</span>
              <input type="number" class="wait-timeout-input" data-path="${escAttr(pathJson)}"
                     min="100" step="100" value="${timeoutMs}" />
            </label>
            <label class="wait-field wait-field-inline">
              <span class="wait-label">Poll interval (ms)</span>
              <input type="number" class="wait-poll-input" data-path="${escAttr(pathJson)}"
                     min="10" step="10" value="${pollIntervalMs}" />
            </label>
            <div class="wait-gotcha">
              <span class="wait-gotcha-icon">ⓘ</span>
              Polls the page every ${pollIntervalMs}ms — returns as soon as the condition holds. Fails if still not met after the timeout.
            </div>
          </div>`;
      }

      return `
        <div class="strategy-wait-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-wait-head">
            <span class="strategy-wait-badge">WAIT</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <div class="wait-mode-toggle">
              <label class="wait-mode-option">
                <input type="radio" name="wait-mode-${escAttr(pathJson)}" value="duration"
                       class="wait-mode-radio" data-path="${escAttr(pathJson)}"
                       ${mode === 'duration' ? 'checked' : ''} />
                <span>Duration</span>
              </label>
              <label class="wait-mode-option">
                <input type="radio" name="wait-mode-${escAttr(pathJson)}" value="condition"
                       class="wait-mode-radio" data-path="${escAttr(pathJson)}"
                       ${mode === 'condition' ? 'checked' : ''} />
                <span>Condition</span>
              </label>
            </div>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove">✕</button>
          </div>
          ${modeBodyHtml}
        </div>`;
    }

    // v2.31.0 (Pass G2) — DETECT node render. Branches list + default body.
    // Each branch has a condition editor + its own body (recursively rendered
    // by renderStrategyNodes). Default is a body-only section. Accent color
    // is violet to distinguish from FOREACH (yellow) and WAIT (cyan).
    if (node.type === 'detect') {
      const branches = Array.isArray(node.branches) ? node.branches : [];
      const defaultBody = Array.isArray(node.default) ? node.default : [];

      // Render each branch as a condition card + its body.
      const branchesHtml = branches.map((branch, bIdx) => {
        const branchPath = [...path, 'branches', bIdx];
        const branchPathJson = JSON.stringify(branchPath);
        const bodyPath = [...branchPath, 'body'];
        const bodyAddPathJson = JSON.stringify(bodyPath);
        const condEditorHtml = _setup.renderConditionEditor(branch?.condition ?? {}, [...branchPath, 'condition'], { assertions: [..._strategyAssertionCache.values()], perspectives: [..._strategyPerspectiveCache.values()], iterScope, allowedFamilies: ['page', 'scope'] });
        // DETECT is scope-transparent — branch body sees same iterScope
        // as the detect itself (not a new frame).
        const branchBodyHtml = renderStrategyNodes(branch?.body ?? [], bodyPath, fragOptions, iterScope, new Set(availableLists));
        return `
          <div class="strategy-detect-branch" data-path="${escAttr(branchPathJson)}">
            <div class="strategy-detect-branch-head">
              <span class="strategy-detect-branch-label">Branch ${bIdx + 1} — when</span>
              <button class="btn-action" data-action="detect-branch-up"     data-path="${escAttr(branchPathJson)}" title="Move branch up"     ${bIdx === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn-action" data-action="detect-branch-down"   data-path="${escAttr(branchPathJson)}" title="Move branch down"   ${bIdx === branches.length - 1 ? 'disabled' : ''}>↓</button>
              <button class="btn-action danger" data-action="detect-branch-remove" data-path="${escAttr(branchPathJson)}" title="Remove branch">✕</button>
            </div>
            <div class="strategy-detect-branch-cond">
              ${condEditorHtml}
            </div>
            <div class="strategy-detect-branch-body">
              <div class="strategy-detect-body-label">then</div>
              ${branchBodyHtml}
              <div class="strategy-detect-body-add">
                <button class="btn-secondary tiny" data-action="add-fragment-in-body" data-path="${escAttr(bodyAddPathJson)}">+ Fragment</button>
                <button class="btn-secondary tiny" data-action="add-foreach-in-body" data-path="${escAttr(bodyAddPathJson)}">+ FOREACH</button>
                <button class="btn-secondary tiny" data-action="add-wait-in-body" data-path="${escAttr(bodyAddPathJson)}">+ WAIT</button>
                <button class="btn-secondary tiny" data-action="add-pause-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Halt the strategy until the user clicks Resume — for human intervention">+ PAUSE</button>
                <button class="btn-secondary tiny" data-action="add-sieve-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a SIEVE — narrow a list (filter / sort / take) before iterating it">+ SIEVE</button>
                <button class="btn-secondary tiny" data-action="add-detect-in-body" data-path="${escAttr(bodyAddPathJson)}">+ DETECT</button>
                <button class="btn-secondary tiny" data-action="add-loop-in-body" data-path="${escAttr(bodyAddPathJson)}">+ LOOP</button>
                <button class="btn-secondary tiny" data-action="add-try-in-body" data-path="${escAttr(bodyAddPathJson)}">+ TRY</button>
                <button class="btn-secondary tiny" data-action="add-navigate-in-body" data-path="${escAttr(bodyAddPathJson)}">+ NAVIGATE</button>

                <button class="btn-secondary tiny" data-action="add-scroll-in-body" data-path="${escAttr(bodyAddPathJson)}">+ SCROLL</button>
                <button class="btn-secondary tiny" data-action="add-observation-in-body" data-path="${escAttr(bodyAddPathJson)}">+ OBSERVE</button>
                <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(bodyAddPathJson)}">+ IN_NEW_TAB</button>
              </div>
            </div>
          </div>`;
      }).join('');

      const defaultPath = [...path, 'default'];
      const defaultAddPathJson = JSON.stringify(defaultPath);
      const defaultBodyHtml = renderStrategyNodes(defaultBody, defaultPath, fragOptions, iterScope, new Set(availableLists));

      return `
        <div class="strategy-detect-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-detect-head">
            <span class="strategy-detect-badge">DETECT</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove (including all branches)">✕</button>
          </div>
          <div class="strategy-detect-branches">
            ${branchesHtml || '<div class="empty-state small nested">No branches yet — click + Add branch below.</div>'}
          </div>
          <div class="strategy-detect-add-branch">
            <button class="btn-secondary tiny" data-action="detect-add-branch" data-path="${escAttr(pathJson)}">+ Add branch</button>
          </div>
          <div class="strategy-detect-default">
            <div class="strategy-detect-default-label">otherwise (default)</div>
            <div class="strategy-detect-default-body">
              ${defaultBodyHtml}
              <div class="strategy-detect-body-add">
                <button class="btn-secondary tiny" data-action="add-fragment-in-body" data-path="${escAttr(defaultAddPathJson)}">+ Fragment</button>
                <button class="btn-secondary tiny" data-action="add-foreach-in-body" data-path="${escAttr(defaultAddPathJson)}">+ FOREACH</button>
                <button class="btn-secondary tiny" data-action="add-wait-in-body" data-path="${escAttr(defaultAddPathJson)}">+ WAIT</button>
                <button class="btn-secondary tiny" data-action="add-pause-in-body" data-path="${escAttr(defaultAddPathJson)}" title="Halt the strategy until the user clicks Resume — for human intervention">+ PAUSE</button>
                <button class="btn-secondary tiny" data-action="add-sieve-in-body" data-path="${escAttr(defaultAddPathJson)}" title="Add a SIEVE — narrow a list (filter / sort / take) before iterating it">+ SIEVE</button>
                <button class="btn-secondary tiny" data-action="add-detect-in-body" data-path="${escAttr(defaultAddPathJson)}">+ DETECT</button>
                <button class="btn-secondary tiny" data-action="add-loop-in-body" data-path="${escAttr(defaultAddPathJson)}">+ LOOP</button>
                <button class="btn-secondary tiny" data-action="add-try-in-body" data-path="${escAttr(defaultAddPathJson)}">+ TRY</button>
                <button class="btn-secondary tiny" data-action="add-navigate-in-body" data-path="${escAttr(defaultAddPathJson)}">+ NAVIGATE</button>

                <button class="btn-secondary tiny" data-action="add-scroll-in-body" data-path="${escAttr(defaultAddPathJson)}">+ SCROLL</button>
                <button class="btn-secondary tiny" data-action="add-observation-in-body" data-path="${escAttr(defaultAddPathJson)}">+ OBSERVE</button>
                <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(defaultAddPathJson)}">+ IN_NEW_TAB</button>
              </div>
            </div>
          </div>
          <div class="strategy-detect-gotcha">
            <span class="strategy-detect-gotcha-icon">ⓘ</span>
            Branches evaluated in order — first match wins. Conditions are checked once (no polling) — use a WAIT beforehand if a condition needs time to stabilize.
          </div>
        </div>`;
    }

    // v2.32.0 (Pass H1) — LOOP node render. Condition editor + body +
    // maxIterations input. Rose/crimson accent to distinguish from FOREACH
    // (yellow), WAIT (cyan), DETECT (violet).
    if (node.type === 'loop') {
      const cond = node.condition ?? { type: 'selector_present', selector: '' };
      const maxIterations = Number.isFinite(node.maxIterations) ? node.maxIterations : 100;
      const bodyPath = [...path, 'body'];
      const bodyAddPathJson = JSON.stringify(bodyPath);
      const condEditorHtml = _setup.renderConditionEditor(cond, [...path, 'condition'], { assertions: [..._strategyAssertionCache.values()], perspectives: [..._strategyPerspectiveCache.values()], iterScope, allowedFamilies: ['page', 'scope'] });
      // LOOP is scope-transparent — body sees same iterScope as the loop itself.
      const bodyHtml = renderStrategyNodes(node.body ?? [], bodyPath, fragOptions, iterScope, new Set(availableLists));

      return `
        <div class="strategy-loop-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-loop-head">
            <span class="strategy-loop-badge">LOOP</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove (including body)">✕</button>
          </div>
          <div class="strategy-loop-fields">
            <label class="strategy-loop-field">
              <span class="strategy-loop-label">Repeat while</span>
              ${condEditorHtml}
            </label>
            <label class="strategy-loop-field strategy-loop-field-inline">
              <span class="strategy-loop-label">Max iterations</span>
              <input type="number" class="loop-max-input" data-path="${escAttr(pathJson)}"
                     min="1" step="1" value="${maxIterations}" />
              <span class="strategy-loop-hint-inline">safety cap — fails strategy if exceeded</span>
            </label>
          </div>
          <div class="strategy-loop-body">
            <div class="strategy-loop-body-label">each iteration</div>
            ${bodyHtml}
            <div class="strategy-loop-body-add">
              <button class="btn-secondary tiny" data-action="add-fragment-in-body" data-path="${escAttr(bodyAddPathJson)}">+ Fragment</button>
              <button class="btn-secondary tiny" data-action="add-foreach-in-body" data-path="${escAttr(bodyAddPathJson)}">+ FOREACH</button>
              <button class="btn-secondary tiny" data-action="add-wait-in-body" data-path="${escAttr(bodyAddPathJson)}">+ WAIT</button>
              <button class="btn-secondary tiny" data-action="add-pause-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Halt the strategy until the user clicks Resume — for human intervention">+ PAUSE</button>
              <button class="btn-secondary tiny" data-action="add-sieve-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a SIEVE — narrow a list (filter / sort / take) before iterating it">+ SIEVE</button>
              <button class="btn-secondary tiny" data-action="add-detect-in-body" data-path="${escAttr(bodyAddPathJson)}">+ DETECT</button>
              <button class="btn-secondary tiny" data-action="add-loop-in-body" data-path="${escAttr(bodyAddPathJson)}">+ LOOP</button>
              <button class="btn-secondary tiny" data-action="add-try-in-body" data-path="${escAttr(bodyAddPathJson)}">+ TRY</button>
              <button class="btn-secondary tiny" data-action="add-navigate-in-body" data-path="${escAttr(bodyAddPathJson)}">+ NAVIGATE</button>

              <button class="btn-secondary tiny" data-action="add-scroll-in-body" data-path="${escAttr(bodyAddPathJson)}">+ SCROLL</button>
              <button class="btn-secondary tiny" data-action="add-observation-in-body" data-path="${escAttr(bodyAddPathJson)}">+ OBSERVE</button>
              <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(bodyAddPathJson)}">+ IN_NEW_TAB</button>
            </div>
          </div>
          <div class="strategy-loop-gotcha">
            <span class="strategy-loop-gotcha-icon">ⓘ</span>
            Condition tested BEFORE each iteration — if false at the start, body never runs. Condition is checked once per iteration (no polling) — add a WAIT inside the body if the page needs time to settle before the next check.
          </div>
        </div>`;
    }

    // v2.33.0 (Pass H2) — TRY node card. Expected-failure recovery.
    // Structure: header, body (the attempt), recover body (runs on failure).
    // Amber accent to distinguish from FOREACH (yellow), WAIT (cyan),
    // DETECT (violet), LOOP (rose).
    if (node.type === 'try') {
      const bodyPath = [...path, 'body'];
      const recoverPath = [...path, 'recover'];
      const bodyAddPathJson = JSON.stringify(bodyPath);
      const recoverAddPathJson = JSON.stringify(recoverPath);
      // TRY is scope-transparent — both body AND recover see the same iterScope.
      const bodyHtml = renderStrategyNodes(node.body ?? [], bodyPath, fragOptions, iterScope, new Set(availableLists));
      const recoverHtml = renderStrategyNodes(node.recover ?? [], recoverPath, fragOptions, iterScope, new Set(availableLists));
      const recoverIsEmpty = (node.recover ?? []).length === 0;

      return `
        <div class="strategy-try-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-try-head">
            <span class="strategy-try-badge">TRY</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove (including body + recover)">✕</button>
          </div>
          <div class="strategy-try-body">
            <div class="strategy-try-body-label">attempt</div>
            ${bodyHtml}
            <div class="strategy-try-body-add">
              <button class="btn-secondary tiny" data-action="add-fragment-in-body" data-path="${escAttr(bodyAddPathJson)}">+ Fragment</button>
              <button class="btn-secondary tiny" data-action="add-foreach-in-body" data-path="${escAttr(bodyAddPathJson)}">+ FOREACH</button>
              <button class="btn-secondary tiny" data-action="add-wait-in-body" data-path="${escAttr(bodyAddPathJson)}">+ WAIT</button>
              <button class="btn-secondary tiny" data-action="add-pause-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Halt the strategy until the user clicks Resume — for human intervention">+ PAUSE</button>
              <button class="btn-secondary tiny" data-action="add-sieve-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a SIEVE — narrow a list (filter / sort / take) before iterating it">+ SIEVE</button>
              <button class="btn-secondary tiny" data-action="add-detect-in-body" data-path="${escAttr(bodyAddPathJson)}">+ DETECT</button>
              <button class="btn-secondary tiny" data-action="add-loop-in-body" data-path="${escAttr(bodyAddPathJson)}">+ LOOP</button>
              <button class="btn-secondary tiny" data-action="add-try-in-body" data-path="${escAttr(bodyAddPathJson)}">+ TRY</button>
              <button class="btn-secondary tiny" data-action="add-navigate-in-body" data-path="${escAttr(bodyAddPathJson)}">+ NAVIGATE</button>

              <button class="btn-secondary tiny" data-action="add-scroll-in-body" data-path="${escAttr(bodyAddPathJson)}">+ SCROLL</button>
              <button class="btn-secondary tiny" data-action="add-observation-in-body" data-path="${escAttr(bodyAddPathJson)}">+ OBSERVE</button>
              <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(bodyAddPathJson)}">+ IN_NEW_TAB</button>
            </div>
          </div>
          <div class="strategy-try-recover">
            <div class="strategy-try-recover-label">
              on failure
              ${recoverIsEmpty ? '<span class="strategy-try-swallow-hint">(empty — will swallow failure)</span>' : ''}
            </div>
            ${recoverHtml}
            <div class="strategy-try-recover-add">
              <button class="btn-secondary tiny" data-action="add-fragment-in-body" data-path="${escAttr(recoverAddPathJson)}">+ Fragment</button>
              <button class="btn-secondary tiny" data-action="add-foreach-in-body" data-path="${escAttr(recoverAddPathJson)}">+ FOREACH</button>
              <button class="btn-secondary tiny" data-action="add-wait-in-body" data-path="${escAttr(recoverAddPathJson)}">+ WAIT</button>
              <button class="btn-secondary tiny" data-action="add-pause-in-body" data-path="${escAttr(recoverAddPathJson)}" title="Halt the strategy until the user clicks Resume — for human intervention">+ PAUSE</button>
              <button class="btn-secondary tiny" data-action="add-sieve-in-body" data-path="${escAttr(recoverAddPathJson)}" title="Add a SIEVE — narrow a list (filter / sort / take) before iterating it">+ SIEVE</button>
              <button class="btn-secondary tiny" data-action="add-detect-in-body" data-path="${escAttr(recoverAddPathJson)}">+ DETECT</button>
              <button class="btn-secondary tiny" data-action="add-loop-in-body" data-path="${escAttr(recoverAddPathJson)}">+ LOOP</button>
              <button class="btn-secondary tiny" data-action="add-try-in-body" data-path="${escAttr(recoverAddPathJson)}">+ TRY</button>
              <button class="btn-secondary tiny" data-action="add-navigate-in-body" data-path="${escAttr(recoverAddPathJson)}">+ NAVIGATE</button>

              <button class="btn-secondary tiny" data-action="add-scroll-in-body" data-path="${escAttr(recoverAddPathJson)}">+ SCROLL</button>
              <button class="btn-secondary tiny" data-action="add-observation-in-body" data-path="${escAttr(recoverAddPathJson)}">+ OBSERVE</button>
              <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(recoverAddPathJson)}">+ IN_NEW_TAB</button>
            </div>
          </div>
          <div class="strategy-try-gotcha">
            <span class="strategy-try-gotcha-icon">ⓘ</span>
            If any step in <b>attempt</b> fails, execution jumps to <b>on failure</b>. If <b>on failure</b> is empty or succeeds, TRY succeeds overall. If <b>on failure</b> itself fails, TRY fails. Aborts always propagate — they are not recoverable.
          </div>
        </div>`;
    }

    // v2.34.0 (Pass H3) — NAVIGATE node card. Teal accent distinct from
    // all other nodes. Leaf (no body). Mode selector + conditional URL
    // binding editor (url mode only; back/reload hide the URL row).
    if (node.type === 'navigate') {
      const mode = node.mode === 'back' || node.mode === 'reload' ? node.mode : 'url';
      const urlBinding = node.url ?? { kind: 'literal', value: '' };
      const urlKind = urlBinding.kind ?? 'literal';
      const iterNames = [...iterScope];

      // URL value editor — shape depends on kind.
      let urlValueHtml = '';
      if (urlKind === 'literal') {
        urlValueHtml = `<input type="text" class="nav-url-value" data-path="${escAttr(pathJson)}"
          value="${escAttr(urlBinding.value ?? '')}" placeholder="https://..." />`;
      } else if (urlKind === 'strategy_param') {
        urlValueHtml = `<input type="text" class="nav-url-value" data-path="${escAttr(pathJson)}"
          value="${escAttr(urlBinding.name ?? '')}" placeholder="input name, e.g. SEARCH_URL" />`;
      } else if (urlKind === 'iteration_variable') {
        const names = new Set(iterNames);
        if (urlBinding.name && !names.has(urlBinding.name)) names.add(urlBinding.name);
        const options = [...names].map(n => {
          const outOfScope = !iterScope.has(n);
          const label = outOfScope ? `${n} ⚠ (not in scope here)` : n;
          return `<option value="${escAttr(n)}" ${n === urlBinding.name ? 'selected' : ''}>${escHtml(label)}</option>`;
        }).join('');
        urlValueHtml = `<select class="nav-url-value" data-path="${escAttr(pathJson)}" data-kind="iteration_variable">
          ${iterNames.length === 0 ? '<option value="">— no iteration vars in scope —</option>' : ''}
          ${options}
        </select>`;
      }

      const showIter = iterNames.length > 0 || urlKind === 'iteration_variable';
      const iterOption = showIter
        ? `<option value="iteration_variable" ${urlKind === 'iteration_variable' ? 'selected' : ''}>from FOREACH item</option>`
        : '';

      const urlRowHtml = mode !== 'url' ? '' : `
        <div class="strategy-nav-url-row">
          <span class="strategy-nav-label">URL</span>
          <select class="nav-url-kind" data-path="${escAttr(pathJson)}">
            <option value="literal"        ${urlKind === 'literal' ? 'selected' : ''}>literal</option>
            <option value="strategy_param" ${urlKind === 'strategy_param' ? 'selected' : ''}>from input</option>
            ${iterOption}
          </select>
          ${urlValueHtml}
        </div>`;

      return `
        <div class="strategy-nav-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-nav-head">
            <span class="strategy-nav-badge">NAVIGATE</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <span class="strategy-nav-mode-display">${escHtml(mode === 'url' ? '→ URL' : mode === 'back' ? '← back' : '↻ reload')}</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove">✕</button>
          </div>
          <div class="strategy-nav-fields">
            <div class="strategy-nav-mode-row">
              <span class="strategy-nav-label">Mode</span>
              <select class="nav-mode-select" data-path="${escAttr(pathJson)}">
                <option value="url"    ${mode === 'url' ? 'selected' : ''}>go to URL</option>
                <option value="back"   ${mode === 'back' ? 'selected' : ''}>back</option>
                <option value="reload" ${mode === 'reload' ? 'selected' : ''}>reload</option>
              </select>
            </div>
            ${urlRowHtml}
          </div>
          <div class="strategy-nav-gotcha">
            <span class="strategy-nav-gotcha-icon">ⓘ</span>
            Always waits for the page to finish loading (30s cap). Add a WAIT afterward if the page needs more time for JavaScript to settle before the next step runs.
          </div>
        </div>`;
    }

    // v2.71.0 — SCROLL node card. Selectorless strategy-level scroll.
    // Mirrors NAVIGATE's binding pattern for the distance field.
    if (node.type === 'scroll') {
      const distance = node.distance ?? { kind: 'literal', value: '' };
      const dKind = distance.kind ?? 'literal';
      const iterNames = [...iterScope];

      let dValueHtml = '';
      if (dKind === 'literal') {
        dValueHtml = `<input type="text" class="scroll-distance-value" data-path="${escAttr(pathJson)}"
          value="${escAttr(distance.value ?? '')}" placeholder="signed viewports, e.g. 1.0 or -0.5" />`;
      } else if (dKind === 'strategy_param') {
        dValueHtml = `<input type="text" class="scroll-distance-value" data-path="${escAttr(pathJson)}"
          value="${escAttr(distance.name ?? '')}" placeholder="input name, e.g. SCROLL_AMOUNT" />`;
      } else if (dKind === 'iteration_variable') {
        const names = new Set(iterNames);
        if (distance.name && !names.has(distance.name)) names.add(distance.name);
        const options = [...names].map(n => {
          const outOfScope = !iterScope.has(n);
          const label = outOfScope ? `${n} ⚠ (not in scope here)` : n;
          return `<option value="${escAttr(n)}" ${n === distance.name ? 'selected' : ''}>${escHtml(label)}</option>`;
        }).join('');
        dValueHtml = `<select class="scroll-distance-value" data-path="${escAttr(pathJson)}" data-kind="iteration_variable">
          ${iterNames.length === 0 ? '<option value="">— no iteration vars in scope —</option>' : ''}
          ${options}
        </select>`;
      }

      const showIter = iterNames.length > 0 || dKind === 'iteration_variable';
      const iterOption = showIter
        ? `<option value="iteration_variable" ${dKind === 'iteration_variable' ? 'selected' : ''}>from FOREACH item</option>`
        : '';

      return `
        <div class="strategy-scroll-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-scroll-head">
            <span class="strategy-scroll-badge">SCROLL</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <span class="strategy-scroll-mode-display">by viewports</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove">✕</button>
          </div>
          <div class="strategy-scroll-fields">
            <div class="strategy-scroll-distance-row">
              <span class="strategy-scroll-label">Distance</span>
              <select class="scroll-distance-kind" data-path="${escAttr(pathJson)}">
                <option value="literal"        ${dKind === 'literal' ? 'selected' : ''}>literal</option>
                <option value="strategy_param" ${dKind === 'strategy_param' ? 'selected' : ''}>from input</option>
                ${iterOption}
              </select>
              ${dValueHtml}
            </div>
          </div>
          <div class="strategy-scroll-gotcha">
            <span class="strategy-scroll-gotcha-icon">ⓘ</span>
            Smooth-scrolls the window by signed viewports (+ down, − up). Use inside a LOOP for infinite-feed patterns. Pure scrolls don't change the DOM; that's expected.
          </div>
        </div>`;
    }

    // v2.72.3 (Pass 4) — OBSERVATION node card. Emerald accent (#10b981)
    // distinct from SCROLL's purple — Observations represent "page reading"
    // (information flow), a different visual semantic from action.
    if (node.type === 'observation') {
      const obs = _strategyObservationCache.get(node.observationId);
      const allObservations = [..._strategyObservationCache.values()];
      // Build the picker. If the current observationId isn't in the cache
      // (deleted, wrong ground, legacy data), surface it as a missing
      // entry so the user can see the broken state and re-pick.
      const options = allObservations.map(o => `
        <option value="${escAttr(o.id)}" ${o.id === node.observationId ? 'selected' : ''}>
          ${escHtml(o.name ?? o.id)} (${escHtml(o.shape ?? '?')})
        </option>`).join('');
      const missingOption = (node.observationId && !obs)
        ? `<option value="${escAttr(node.observationId)}" selected>⚠ ${escHtml(node.observationId)} (missing)</option>`
        : '';
      const hint = obs
        ? `Reads <strong>${escHtml(obs.shape ?? '?')}</strong> into scope as <code>{{${escHtml(obs.output ?? '?')}}}</code>.`
        : (node.observationId ? 'Observation not found on this Ground. Re-pick or remove.' : 'Pick an Observation.');

      // v2.72.7 (Pass 3e) — paramBindings UI. Visible only when the picked
      // Observation declares params. Reuses renderStrategyBindings — the
      // binding shape is identical to Fragment's.
      const obsParams = Array.isArray(obs?.params) ? obs.params : [];
      const bindingsHtml = obsParams.length > 0
        ? `<div class="strategy-observation-bindings">
             <div class="strategy-observation-bindings-label">Param bindings</div>
             ${renderStrategyBindings(node, obsParams, path, iterScope)}
           </div>`
        : '';

      // v2.72.11 (Pass 8) — Tier badge. Reads from implementations[0].tier
      // with cache fallback. T1 in emerald (matches the Observation card
      // accent); T3 in amber to flag frontier cost. Mirrors the convention
      // used on Analysis SIEVE cards.
      const obsTier = obs?.implementations?.[0]?.tier ?? 'cache';
      const tierBadge = obsTier === 'frontier'
        ? `<span class="strategy-tier-badge tier-frontier" title="Frontier-tier (vision LLM): real per-call cost. See the Observation's record for details.">T3</span>`
        : `<span class="strategy-tier-badge tier-cache" title="Cache-tier (DOM-based): deterministic, free.">T1</span>`;

      const observationCardHtml = `
        <div class="strategy-observation-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-observation-head">
            <span class="strategy-observation-badge">OBSERVATION</span>
            ${tierBadge}
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove">✕</button>
          </div>
          <div class="strategy-observation-fields">
            <div class="strategy-observation-pick-row">
              <span class="strategy-observation-label">Observation</span>
              <select class="observation-pick" data-path="${escAttr(pathJson)}">
                ${allObservations.length === 0 && !missingOption ? '<option value="">— no Observations on this Ground —</option>' : ''}
                ${missingOption}
                ${options}
              </select>
            </div>
          </div>
          ${bindingsHtml}
          <div class="strategy-observation-gotcha">
            <span class="strategy-observation-gotcha-icon">ⓘ</span>
            ${hint}
          </div>
        </div>`;
      // v2.72.21 (Pass 11) — Register Observation output to availableLists
      // for downstream datalist suggestions. Whether it's a list, image,
      // section, scalar, etc., the binding name should appear in source
      // pickers. Runtime gates catch kind mismatches with clear errors.
      if (obs?.output) availableLists.add(obs.output);
      return observationCardHtml;
    }

    // v2.37.0 (Pass J2) — IN_NEW_TAB node card. Sky-blue accent distinct
    // from NAVIGATE's teal. Two-section card: "trigger" slot (one node)
    // and "body" slot (list of nodes). Body runs on the tab opened by
    // the trigger.
    if (node.type === 'in_new_tab') {
      const triggerPath = [...path, 'trigger'];
      const bodyPath = [...path, 'body'];
      const triggerAddPathJson = JSON.stringify(triggerPath);
      const bodyAddPathJson = JSON.stringify(bodyPath);

      // Render the trigger (a single node) — reuse renderStrategyNodes
      // with a one-element list at triggerPath
      const triggerHtml = node.trigger
        ? renderStrategyNodes([node.trigger], triggerPath, fragOptions, iterScope, new Set(availableLists))
        : '';
      const bodyHtml = renderStrategyNodes(node.body ?? [], bodyPath, fragOptions, iterScope, new Set(availableLists));

      const closeOnExit = node.closeOnExit !== false;

      return `
        <div class="strategy-innewtab-card" data-path="${escAttr(pathJson)}">
          <div class="strategy-innewtab-head">
            <span class="strategy-innewtab-badge">IN_NEW_TAB</span>
            <span class="strategy-step-label">Step ${idx + 1}</span>
            <label class="strategy-innewtab-close-toggle">
              <input type="checkbox" class="innewtab-close-check" data-path="${escAttr(pathJson)}" ${closeOnExit ? 'checked' : ''} />
              close tab when done
            </label>
            <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
            <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove (including trigger + body)">✕</button>
          </div>
          <div class="strategy-innewtab-trigger">
            <div class="strategy-innewtab-section-label">trigger — action that opens the new tab</div>
            ${triggerHtml || '<div class="strategy-innewtab-empty">No trigger. Add an action that opens a new tab (e.g. a fragment with a CLICK that has target=_blank, or NAVIGATE)</div>'}
            ${!node.trigger ? `
              <div class="strategy-innewtab-trigger-add">
                <button class="btn-secondary tiny" data-action="set-innewtab-trigger" data-path="${escAttr(triggerAddPathJson)}" data-trigger-type="fragment">Use Fragment</button>
                <button class="btn-secondary tiny" data-action="set-innewtab-trigger" data-path="${escAttr(triggerAddPathJson)}" data-trigger-type="navigate">Use NAVIGATE</button>
              </div>` : ''}
          </div>
          <div class="strategy-innewtab-body">
            <div class="strategy-innewtab-section-label">body — runs on the newly-opened tab</div>
            ${bodyHtml}
            <div class="strategy-innewtab-body-add">
              <button class="btn-secondary tiny" data-action="add-fragment-in-body" data-path="${escAttr(bodyAddPathJson)}">+ Fragment</button>
              <button class="btn-secondary tiny" data-action="add-foreach-in-body" data-path="${escAttr(bodyAddPathJson)}">+ FOREACH</button>
              <button class="btn-secondary tiny" data-action="add-wait-in-body" data-path="${escAttr(bodyAddPathJson)}">+ WAIT</button>
              <button class="btn-secondary tiny" data-action="add-pause-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Halt the strategy until the user clicks Resume — for human intervention">+ PAUSE</button>
              <button class="btn-secondary tiny" data-action="add-sieve-in-body" data-path="${escAttr(bodyAddPathJson)}" title="Add a SIEVE — narrow a list (filter / sort / take) before iterating it">+ SIEVE</button>
              <button class="btn-secondary tiny" data-action="add-detect-in-body" data-path="${escAttr(bodyAddPathJson)}">+ DETECT</button>
              <button class="btn-secondary tiny" data-action="add-loop-in-body" data-path="${escAttr(bodyAddPathJson)}">+ LOOP</button>
              <button class="btn-secondary tiny" data-action="add-try-in-body" data-path="${escAttr(bodyAddPathJson)}">+ TRY</button>
              <button class="btn-secondary tiny" data-action="add-navigate-in-body" data-path="${escAttr(bodyAddPathJson)}">+ NAVIGATE</button>

              <button class="btn-secondary tiny" data-action="add-scroll-in-body" data-path="${escAttr(bodyAddPathJson)}">+ SCROLL</button>
              <button class="btn-secondary tiny" data-action="add-observation-in-body" data-path="${escAttr(bodyAddPathJson)}">+ OBSERVE</button>
              <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(bodyAddPathJson)}">+ IN_NEW_TAB</button>
              <button class="btn-secondary tiny" data-action="add-in-new-tab-in-body" data-path="${escAttr(bodyAddPathJson)}">+ IN_NEW_TAB</button>
            </div>
          </div>
          <div class="strategy-innewtab-gotcha">
            <span class="strategy-innewtab-gotcha-icon">ⓘ</span>
            The trigger runs on the current tab. If it opens exactly one new tab (within 5s), body runs there. If no tab opens, this node fails — wrap in TRY for graceful fallback.
          </div>
        </div>`;
    }

    // Fragment node
    const step = node;
    const fragment = _strategyFragmentCache.get(step.fragmentId);
    const fragmentParams = fragment?.params ?? [];
    const bindingsHtml = renderStrategyBindings(step, fragmentParams, path, iterScope);

    // v2.29.4 (E2-5) — Register this fragment's list-producing targets as
    // available list names for LATER siblings. Updated after this node's
    // HTML is generated so the FOREACH datalist only sees bindings from
    // nodes that execute BEFORE it.
    //
    // v2.72.26 (Pass 14b) — Walk rawJson directly. Pass 14's fragment.produces
    // contract was reverted: a Fragment's contract is name/description/pre/
    // post/params; data outputs from EXTRACT/ENUMERATE/EMIT are legacy
    // actions migrating to Observations. The strategy editor still needs
    // to identify legacy list-producing targets for FOREACH/SIEVE source
    // datalist suggestions; that requires looking inside rawJson, which
    // is acceptable for editor tooling (not for composers).
    if (fragment?.rawJson) {
      try {
        const actions = JSON.parse(fragment.rawJson);
        if (Array.isArray(actions)) {
          for (const a of actions) {
            if (a?.action === 'ENUMERATE' && a.target) availableLists.add(a.target);
            if (a?.action === 'EMIT' && a.target) availableLists.add(a.target);
            if (a?.action === 'EXTRACT' && a.target && a.append) availableLists.add(a.target);
          }
        }
      } catch { /* invalid rawJson — skip */ }
    }

    // Top-level fragment cards keep the drag handle; body-level ones don't
    // (drag-drop only at top level in E2-4).
    const dragHandle = isTopLevel
      ? `<span class="strategy-step-handle" title="Drag to reorder" aria-label="Drag handle">⋮⋮</span>`
      : '';

    return `
      <div class="strategy-step-card" data-path="${escAttr(pathJson)}"${isTopLevel ? ` data-step-idx="${idx}"` : ''}>
        <div class="strategy-step-head">
          ${dragHandle}
          <span class="strategy-step-label">Step ${idx + 1}</span>
          <button class="btn-action" data-action="node-up"     data-path="${escAttr(pathJson)}" title="Move up"     ${isFirst ? 'disabled' : ''}>↑</button>
          <button class="btn-action" data-action="node-down"   data-path="${escAttr(pathJson)}" title="Move down"   ${isLast ? 'disabled' : ''}>↓</button>
          <button class="btn-action danger" data-action="node-remove" data-path="${escAttr(pathJson)}" title="Remove">✕</button>
        </div>
        <label class="strategy-step-fragment">
          Fragment
          <select class="step-fragment-select" data-path="${escAttr(pathJson)}">
            <option value="">— select —</option>
            ${fragOptions}
          </select>
        </label>
        ${fragment ? `<div class="strategy-step-desc">${escHtml(fragment.description ?? '')}</div>` : ''}
        <div class="strategy-step-bindings">${bindingsHtml}</div>
      </div>`;
  }).join('');
}

// ─── Pass 4-f (Phase 1) additions ────────────────────────────────────────
//
// wireStrategyStepHandlers — the 800-line step-level event wiring. Attaches
// click/change/input handlers to every node card after a render. Path-based
// addressing means handlers stay correct after re-render.
//
// State reads/writes hit module-locals (_strategyDraft etc.) directly
// (post-Pass-4-f-Phase-2 state migration). decodeConditionTypeValue is
// studio.js-resident and reached via the _setup injection.

function wireStrategyStepHandlers() {
  const listEl = $('strategy-steps-list');

  // Fragment select change — also reset bindings based on new Fragment's params
  listEl.querySelectorAll('.step-fragment-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node) return;
      node.fragmentId    = sel.value;
      node.paramBindings = {};
      const frag = _strategyFragmentCache.get(sel.value);
      (frag?.params ?? []).forEach(p => {
        node.paramBindings[p] = { kind: 'strategy_param', name: p };
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // Binding kind change
  listEl.querySelectorAll('.step-binding-kind').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node) return;
      const p = sel.dataset.param;
      const existing = node.paramBindings[p] ?? {};
      // Carry forward the current text/name value when switching kinds so users
      // don't lose what they typed by accident. (For iteration_variable the
      // name might not be in scope — renderer handles that with ⚠.)
      const prevText = existing.kind === 'literal' ? (existing.value ?? '')
                     : existing.name ?? p;
      if (sel.value === 'literal') {
        node.paramBindings[p] = { kind: 'literal', value: prevText };
      } else if (sel.value === 'strategy_param') {
        node.paramBindings[p] = { kind: 'strategy_param', name: prevText };
      } else if (sel.value === 'iteration_variable') {
        node.paramBindings[p] = { kind: 'iteration_variable', name: prevText };
      }
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // Binding value input
  listEl.querySelectorAll('.step-binding-value').forEach(el => {
    const evt = el.tagName === 'SELECT' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      const path = JSON.parse(el.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node) return;
      const p = el.dataset.param;
      const b = node.paramBindings[p];
      if (!b) return;
      if (b.kind === 'literal')            b.value = el.value;
      else if (b.kind === 'strategy_param') b.name  = el.value.trim();
      else if (b.kind === 'iteration_variable') b.name = el.value.trim();
      renderStrategyParamsPreview();
    });
  });

  // FOREACH field edits (over, as)
  listEl.querySelectorAll('.foreach-over-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node) return;
      node.over = inp.value.trim();
    });
  });
  listEl.querySelectorAll('.foreach-as-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node) return;
      node.as = inp.value.trim();
    });
    inp.addEventListener('change', () => {
      // On commit: re-render so iteration_variable dropdowns inside the
      // body pick up the new name.
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // Up / Down / Remove
  listEl.querySelectorAll('[data-action="node-up"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const { arr, idx } = getParentArrayAndIndex(_strategyDraft.fragmentSteps, path);
      if (idx === 'trigger') return;   // trigger is a single slot; up/down N/A
      if (!arr || idx <= 0) return;
      [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });
  listEl.querySelectorAll('[data-action="node-down"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const { arr, idx } = getParentArrayAndIndex(_strategyDraft.fragmentSteps, path);
      if (idx === 'trigger') return;   // ditto
      if (!arr || idx < 0 || idx >= arr.length - 1) return;
      [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });
  listEl.querySelectorAll('[data-action="node-remove"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const { arr, idx } = getParentArrayAndIndex(_strategyDraft.fragmentSteps, path);
      if (idx === 'trigger') {
        // J2: arr is the parent IN_NEW_TAB node. Removing the trigger
        // means setting it back to null so the "Use Fragment / Use NAVIGATE"
        // pickers reappear.
        if (!arr || arr.type !== 'in_new_tab') return;
        if (!confirm('Remove the trigger? You can re-add one with the Use Fragment / Use NAVIGATE buttons.')) return;
        arr.trigger = null;
        renderStrategySteps();
        renderStrategyParamsPreview();
        return;
      }
      if (!arr || idx < 0) return;
      const node = arr[idx];
      // Confirm removal of FOREACH with non-empty body — easy to destroy work
      if (node?.type === 'foreach' && (node.body?.length ?? 0) > 0) {
        if (!confirm(`Remove FOREACH and its ${node.body.length} body step(s)?`)) return;
      }
      arr.splice(idx, 1);
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // v2.61.0 — SIEVE editor handlers.
  //
  // Each handler resolves the sieve node via its data-path, then mutates
  // the right field. Assertion paths are walked separately because they
  // can be deep inside compound assertions (e.g. all_of -> assertions -> i).
  //
  // After every mutation, re-render the whole strategy. This is heavier
  // than fine-grained DOM updates but matches how the rest of the editor
  // works (consistency over performance for the editor's modest size).

  // Source / Output input changes
  listEl.querySelectorAll('.sieve-source-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const sieve = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (sieve) sieve.source = inp.value;
    });
  });
  listEl.querySelectorAll('.sieve-output-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const sieve = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (sieve) sieve.output = inp.value;
    });
  });

  // v2.63.0 (Iteration B) — Analysis picker. Switches the SIEVE node's
  // analysisId reference. When a new Analysis is selected, paramBindings
  // are re-initialized to literal-empty for each of the new Analysis's
  // params (preserving previously-set bindings where the param name still
  // exists). The render call refreshes per-param rows.
  listEl.querySelectorAll('.sieve-analysis-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const sieve = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!sieve) return;
      const newId = sel.value || null;
      sieve.analysisId = newId;
      // Migrate paramBindings: keep existing bindings whose param name
      // is still in the new Analysis; default the rest to literal/empty.
      const chosen = newId ? _strategyAnalysisCache.get(newId) : null;
      const newParams = Array.isArray(chosen?.params) ? chosen.params : [];
      const oldBindings = sieve.paramBindings ?? {};
      const newBindings = {};
      for (const p of newParams) {
        newBindings[p] = oldBindings[p] ?? { kind: 'literal', value: '' };
      }
      sieve.paramBindings = newBindings;
      // v2.74.136 — When the picked Analysis's body kind doesn't use
      // `node.source` / `node.output` on the sieve (template, transform),
      // strip those fields so the persisted record doesn't carry orphan
      // values. The runtime ignores them either way, but stale data
      // confuses the JSON modal and the form's downstream availability
      // computation.
      const chosenImpl0 = chosen && Array.isArray(chosen.implementations) && chosen.implementations.length > 0
        ? chosen.implementations[0] : null;
      const chosenBodyKind = chosenImpl0?.body?.kind ?? null;
      if (chosenBodyKind === 'transform') {
        delete sieve.source;
        delete sieve.output;
      } else if (chosenBodyKind === 'template') {
        delete sieve.source;
      }
      renderStrategySteps();
    });
  });

  // Param binding kind change — toggles between literal / iteration_variable
  // / strategy_param. Switching kind resets the per-kind value field to
  // empty/sensible default so stale values don't leak across kinds.
  listEl.querySelectorAll('.sieve-param-kind').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const paramName = sel.dataset.param;
      const sieve = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!sieve) return;
      sieve.paramBindings = sieve.paramBindings ?? {};
      const newKind = sel.value;
      if (newKind === 'literal') {
        sieve.paramBindings[paramName] = { kind: 'literal', value: '' };
      } else {
        sieve.paramBindings[paramName] = { kind: newKind, name: '' };
      }
      renderStrategySteps();
    });
  });

  // Iteration-variable picker — sets the binding's `name` to the chosen
  // iteration variable.
  listEl.querySelectorAll('.sieve-param-iter').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const paramName = sel.dataset.param;
      const sieve = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!sieve?.paramBindings?.[paramName]) return;
      sieve.paramBindings[paramName].name = sel.value;
    });
  });

  // Literal / strategy_param value text input changes
  listEl.querySelectorAll('.sieve-param-value').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const paramName = inp.dataset.param;
      const sieve = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!sieve?.paramBindings?.[paramName]) return;
      const b = sieve.paramBindings[paramName];
      if (b.kind === 'literal') b.value = inp.value;
      else                      b.name  = inp.value;
    });
  });

  // Add fragment / Add FOREACH INSIDE a body (nested button handlers)
  listEl.querySelectorAll('[data-action="add-fragment-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      const first = _strategyFragmentCache.values().next().value;
      if (!first) { toast('No Fragments available on this Ground', 'err'); return; }
      const paramBindings = {};
      (first.params ?? []).forEach(p => { paramBindings[p] = { kind: 'strategy_param', name: p }; });
      body.push({ type: 'fragment', fragmentId: first.id, paramBindings });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });
  listEl.querySelectorAll('[data-action="add-foreach-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({ type: 'foreach', over: '', as: '', body: [] });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // v2.30.0 (Pass G1) — "+ WAIT in body" inside a FOREACH body.
  listEl.querySelectorAll('[data-action="add-wait-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({ type: 'wait', mode: 'duration', durationMs: 500 });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // v2.60.0 — "+ PAUSE in body" inside a FOREACH/DETECT/etc. body.
  listEl.querySelectorAll('[data-action="add-pause-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({ type: 'pause' });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // v2.61.0 — "+ SIEVE in body" inside a FOREACH/DETECT/etc. body.
  // v2.63.0 (Iteration B) — creates a sieve referencing no Analysis yet;
  // user picks one from the dropdown after creation.
  listEl.querySelectorAll('[data-action="add-sieve-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({ type: 'sieve', source: '', output: '', analysisId: null, paramBindings: {} });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // v2.30.0 (Pass G1) — WAIT card controls.

  // Mode radio (Duration | Condition). When switching modes, preserve any
  // meaningful fields the user had entered in the current mode so an
  // accidental toggle doesn't lose work. Then re-render to show the new
  // mode's fields.
  listEl.querySelectorAll('.wait-mode-radio').forEach(r => {
    r.addEventListener('change', () => {
      if (!r.checked) return;
      const path = JSON.parse(r.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'wait') return;
      const newMode = r.value;
      if (newMode === node.mode) return;
      if (newMode === 'duration') {
        node.mode = 'duration';
        if (!Number.isFinite(node.durationMs)) node.durationMs = 500;
      } else {
        node.mode = 'condition';
        if (!node.condition || typeof node.condition !== 'object') {
          node.condition = { type: 'selector_present', selector: '' };
        }
        if (!Number.isFinite(node.timeoutMs)) node.timeoutMs = 5000;
        if (!Number.isFinite(node.pollIntervalMs)) node.pollIntervalMs = 100;
      }
      renderStrategySteps();
    });
  });

  // Duration input (free-form number field).
  listEl.querySelectorAll('.wait-duration-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'wait' || node.mode !== 'duration') return;
      const parsed = parseInt(inp.value, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        node.durationMs = parsed;
      }
    });
  });

  // Duration quick-pick chips (250ms / 500ms / 1s / 2s / 5s). Clicking one
  // sets the duration + re-renders so the number input updates and the
  // `aria-pressed` highlight shifts.
  listEl.querySelectorAll('.wait-duration-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'wait' || node.mode !== 'duration') return;
      const ms = parseInt(btn.dataset.ms, 10);
      if (!Number.isFinite(ms)) return;
      node.durationMs = ms;
      renderStrategySteps();
    });
  });

  // Condition type selector (changes which value field appears below).
  // v2.41.0 (Pass M1.1) — WAIT condition type/value handlers are now the
  // unified .cond-type-select / .cond-value-input handlers below. This
  // block previously duplicated that logic with .wait-cond-type etc.

  // Condition timeout & poll interval — live-edited while typing.
  listEl.querySelectorAll('.wait-timeout-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'wait') return;
      const parsed = parseInt(inp.value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        node.timeoutMs = parsed;
      }
    });
  });
  listEl.querySelectorAll('.wait-poll-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'wait') return;
      const parsed = parseInt(inp.value, 10);
      if (Number.isFinite(parsed) && parsed >= 10) {
        node.pollIntervalMs = parsed;
      }
    });
  });

  // ── v2.31.0 (Pass G2) — DETECT card controls ─────────────────────────────

  // "+ DETECT in body" inside a FOREACH body, DETECT branch body, or DETECT
  // default body. Same pattern as the other add-in-body variants.
  listEl.querySelectorAll('[data-action="add-detect-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      // Default to a single empty branch so the editor shows a condition
      // slot right away rather than an empty-state placeholder.
      body.push({
        type: 'detect',
        branches: [
          { condition: { type: 'selector_present', selector: '' }, body: [] },
        ],
        default: [],
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // + Add branch on an existing DETECT card. Appends an empty branch.
  listEl.querySelectorAll('[data-action="detect-add-branch"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'detect') return;
      if (!Array.isArray(node.branches)) node.branches = [];
      node.branches.push({
        condition: { type: 'selector_present', selector: '' },
        body: [],
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // Branch-level up/down/remove. Paths: [stepIdx, 'branches', branchIdx].
  listEl.querySelectorAll('[data-action="detect-branch-up"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const branchIdx = path[path.length - 1];
      const detectPath = path.slice(0, -2);   // strip 'branches' + idx
      const detect = getNodeByPath(_strategyDraft.fragmentSteps, detectPath);
      if (!detect || !Array.isArray(detect.branches) || branchIdx <= 0) return;
      [detect.branches[branchIdx - 1], detect.branches[branchIdx]] =
        [detect.branches[branchIdx], detect.branches[branchIdx - 1]];
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });
  listEl.querySelectorAll('[data-action="detect-branch-down"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const branchIdx = path[path.length - 1];
      const detectPath = path.slice(0, -2);
      const detect = getNodeByPath(_strategyDraft.fragmentSteps, detectPath);
      if (!detect || !Array.isArray(detect.branches)) return;
      if (branchIdx < 0 || branchIdx >= detect.branches.length - 1) return;
      [detect.branches[branchIdx], detect.branches[branchIdx + 1]] =
        [detect.branches[branchIdx + 1], detect.branches[branchIdx]];
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });
  listEl.querySelectorAll('[data-action="detect-branch-remove"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const path = JSON.parse(btn.dataset.path);
      const branchIdx = path[path.length - 1];
      const detectPath = path.slice(0, -2);
      const detect = getNodeByPath(_strategyDraft.fragmentSteps, detectPath);
      if (!detect || !Array.isArray(detect.branches)) return;
      const branch = detect.branches[branchIdx];
      if (branch && (branch.body?.length ?? 0) > 0) {
        if (!confirm(`Remove branch and its ${branch.body.length} body step(s)?`)) return;
      }
      detect.branches.splice(branchIdx, 1);
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // Condition type dropdown — switching type resets to a clean condition
  // with just the relevant field populated. Strategy-context only.
  // Path points at the condition object itself.
  listEl.querySelectorAll('.cond-type-select[data-context="strategy"]').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      // Parent (branch or wait.condition) owns the condition. Navigate to
      // the parent, then overwrite `condition` with a fresh shape.
      const parentPath = path.slice(0, -1);
      const parent = getNodeByPath(_strategyDraft.fragmentSteps, parentPath);
      if (!parent) return;
      // v2.70.6 — Decode synthetic 'pred_ref:<id>' values from Custom group.
      // For non-reference types, emptyCondition handles the rest.
      const decoded = _setup.decodeConditionTypeValue(sel.value);
      const fresh = emptyCondition(decoded.type);
      if (decoded.assertionId) fresh.assertionId = decoded.assertionId;
      if (decoded.perspectiveId) fresh.perspectiveId = decoded.perspectiveId;
      parent.condition = fresh;
      renderStrategySteps();
    });
  });

  // Condition value input — strategy context. data-field tells us which
  // property to write (selector / pattern / text / attribute / value /
  // assertionId etc — derived from CONDITION_FIELDS, see #fieldNames helper).
  listEl.querySelectorAll('.cond-value-input[data-context="strategy"]').forEach(inp => {
    const handler = () => {
      const path = JSON.parse(inp.dataset.path);
      const cond = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!cond) return;
      const field = inp.dataset.field;
      // v2.45.0 — allowed-fields list derived from the type's schema. Was
      // previously a hardcoded array that drifted from CONDITION_FIELDS.
      if (CONDITION_FIELDS[cond.type]?.fields.includes(field)) {
        cond[field] = inp.value;
      }
    };
    inp.addEventListener('input', handler);
    inp.addEventListener('change', handler);  // for <select>-typed assertion_ref pickers
  });

  // ── v2.32.0 (Pass H1) — LOOP card controls ───────────────────────────────

  // + LOOP in body (FOREACH body, DETECT branch body, DETECT default, LOOP body)
  listEl.querySelectorAll('[data-action="add-loop-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({
        type: 'loop',
        condition: { type: 'selector_present', selector: '' },
        body: [],
        maxIterations: 100,
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // maxIterations number input.
  listEl.querySelectorAll('.loop-max-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'loop') return;
      const parsed = parseInt(inp.value, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        node.maxIterations = parsed;
      }
    });
  });

  // ── v2.33.0 (Pass H2) — TRY card controls ────────────────────────────────

  // + TRY in body (FOREACH body, DETECT branch body, DETECT default,
  // LOOP body, TRY body, TRY recover).
  listEl.querySelectorAll('[data-action="add-try-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({
        type: 'try',
        body: [],
        recover: [],
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // ── v2.34.0 (Pass H3) — NAVIGATE card controls ───────────────────────────

  // + NAVIGATE in body (every body / branch / default).
  listEl.querySelectorAll('[data-action="add-navigate-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({
        type: 'navigate',
        mode: 'url',
        url: { kind: 'literal', value: '' },
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // v2.71.0 — + SCROLL in body. Mirrors add-navigate-in-body.
  listEl.querySelectorAll('[data-action="add-scroll-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({
        type: 'scroll',
        mode: 'by',
        distance: { kind: 'literal', value: '1.0' },
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // v2.72.3 (Pass 4) — + OBSERVE in body. Mirrors add-scroll-in-body.
  // Defaults observationId to the first cached observation; if none, toasts
  // and bails (matches top-level behavior).
  listEl.querySelectorAll('[data-action="add-observation-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      const first = _strategyObservationCache.values().next().value;
      if (!first) {
        toast('No Observations on this Ground yet — author one in the Observations section first', 'warn');
        return;
      }
      // v2.72.7 (Pass 3e) — seed default paramBindings (mirrors top-level handler).
      const params = Array.isArray(first.params) ? first.params : [];
      const paramBindings = {};
      for (const p of params) paramBindings[p] = { kind: 'strategy_param', name: p };
      body.push({
        type: 'observation',
        observationId: first.id,
        paramBindings,
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // Mode selector (url / back / reload).
  listEl.querySelectorAll('.nav-mode-select').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'navigate') return;
      const newMode = sel.value;
      node.mode = newMode;
      if (newMode === 'url') {
        // Preserve URL if we had one previously; otherwise start empty.
        if (!node.url || typeof node.url !== 'object') {
          node.url = { kind: 'literal', value: '' };
        }
      } else {
        delete node.url;
      }
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // URL binding kind selector (literal / strategy_param / iteration_variable).
  // Changing kind resets the value to avoid stale data in the wrong shape.
  listEl.querySelectorAll('.nav-url-kind').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'navigate' || node.mode !== 'url') return;
      const kind = sel.value;
      if (kind === 'literal') {
        node.url = { kind: 'literal', value: '' };
      } else if (kind === 'strategy_param') {
        node.url = { kind: 'strategy_param', name: '' };
      } else if (kind === 'iteration_variable') {
        node.url = { kind: 'iteration_variable', name: '' };
      }
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // URL value input (literal value, or strategy_param name, or
  // iteration_variable selected option). Input for text fields, change
  // for select. Using input covers both for <input type=text> and fires
  // on change for <select>.
  listEl.querySelectorAll('.nav-url-value').forEach(inp => {
    const handler = () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'navigate' || node.mode !== 'url' || !node.url) return;
      const kind = node.url.kind;
      if (kind === 'literal') {
        node.url.value = inp.value;
      } else if (kind === 'strategy_param' || kind === 'iteration_variable') {
        node.url.name = inp.value;
      }
      renderStrategyParamsPreview();  // strategy-param input may have changed
    };
    inp.addEventListener('input', handler);
    inp.addEventListener('change', handler);
  });

  // v2.71.0 — SCROLL distance binding kind selector. Mirrors NAVIGATE's
  // url-kind handler. Changing kind resets the value field.
  listEl.querySelectorAll('.scroll-distance-kind').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'scroll') return;
      const kind = sel.value;
      if (kind === 'literal') {
        node.distance = { kind: 'literal', value: '' };
      } else if (kind === 'strategy_param') {
        node.distance = { kind: 'strategy_param', name: '' };
      } else if (kind === 'iteration_variable') {
        node.distance = { kind: 'iteration_variable', name: '' };
      }
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // SCROLL distance value input. Same input/change dual-binding as nav-url-value.
  listEl.querySelectorAll('.scroll-distance-value').forEach(inp => {
    const handler = () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'scroll' || !node.distance) return;
      const kind = node.distance.kind;
      if (kind === 'literal') {
        node.distance.value = inp.value;
      } else if (kind === 'strategy_param' || kind === 'iteration_variable') {
        node.distance.name = inp.value;
      }
      renderStrategyParamsPreview();
    };
    inp.addEventListener('input', handler);
    inp.addEventListener('change', handler);
  });

  // v2.72.3 (Pass 4) — OBSERVATION pick dropdown. Updates node.observationId.
  // Re-render after change so the hint text reflects the new observation's
  // shape and output binding.
  // v2.72.7 (Pass 3e) — Also migrate paramBindings to the new Observation's
  // declared params: keep existing bindings whose param name still applies,
  // default new param slots to {kind: 'strategy_param', name: paramName}
  // (lets the strategy's own input drive the Observation by default).
  listEl.querySelectorAll('.observation-pick').forEach(sel => {
    sel.addEventListener('change', () => {
      const path = JSON.parse(sel.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'observation') return;
      node.observationId = sel.value;

      const newObs = _strategyObservationCache.get(sel.value);
      const newParams = Array.isArray(newObs?.params) ? newObs.params : [];
      const oldBindings = node.paramBindings ?? {};
      const fresh = {};
      for (const p of newParams) {
        fresh[p] = oldBindings[p] ?? { kind: 'strategy_param', name: p };
      }
      node.paramBindings = fresh;

      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // ── v2.37.0 (Pass J2) — IN_NEW_TAB card controls ─────────────────────────

  // + IN_NEW_TAB in body (every body / branch / default / existing IN_NEW_TAB body).
  listEl.querySelectorAll('[data-action="add-in-new-tab-in-body"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const bodyPath = JSON.parse(btn.dataset.path);
      const body = getNodeByPath(_strategyDraft.fragmentSteps, bodyPath);
      if (!Array.isArray(body)) return;
      body.push({
        type: 'in_new_tab',
        trigger: null,
        body: [],
        closeOnExit: true,
      });
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // "Use Fragment" / "Use NAVIGATE" buttons — set the trigger when it's
  // null. dataset.path points to the trigger SLOT (parent.trigger).
  listEl.querySelectorAll('[data-action="set-innewtab-trigger"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const triggerPath = JSON.parse(btn.dataset.path);
      // The parent node is triggerPath.slice(0, -1) ending in 'trigger' —
      // but our helper getNodeByPath doesn't handle "field of object"
      // descents. Walk manually: parent is path without last segment.
      const parentPath = triggerPath.slice(0, -1);
      const field = triggerPath[triggerPath.length - 1];  // 'trigger'
      const parent = getNodeByPath(_strategyDraft.fragmentSteps, parentPath);
      if (!parent || parent.type !== 'in_new_tab' || field !== 'trigger') return;
      const triggerType = btn.dataset.triggerType;
      if (triggerType === 'fragment') {
        parent.trigger = { type: 'fragment', fragmentId: '', paramBindings: {} };
      } else if (triggerType === 'navigate') {
        parent.trigger = { type: 'navigate', mode: 'url', url: { kind: 'literal', value: '' } };
      }
      renderStrategySteps();
      renderStrategyParamsPreview();
    });
  });

  // closeOnExit toggle.
  listEl.querySelectorAll('.innewtab-close-check').forEach(inp => {
    inp.addEventListener('change', () => {
      const path = JSON.parse(inp.dataset.path);
      const node = getNodeByPath(_strategyDraft.fragmentSteps, path);
      if (!node || node.type !== 'in_new_tab') return;
      node.closeOnExit = !!inp.checked;
    });
  });
}

// ─── Pass 4-f (Phase 2) additions ────────────────────────────────────────
//
// wireStrategySaveHandler — the 656-line strategy save handler. Validates
// the draft, builds the persisted record, writes via StorageManager, and
// closes the form. Called once from studio.js init alongside the other
// wire* functions.
//
// Inline helpers serializeNode / collectFragmentTargets / wrapEnv are
// scoped inside the handler closure (no separate exports needed).
// validateStrategyBody is imported from Services/StrategyTree.js.

export function wireStrategySaveHandler() {
  $('btn-save-strategy').addEventListener('click', async () => {
    if (!_strategyDraft) return;

    // Read fresh values in case user hasn't blurred inputs
    _strategyDraft.name           = $('input-strategy-name').value.trim();
    _strategyDraft.goal           = $('input-strategy-goal').value.trim();
    _strategyDraft.aliases        = $('input-strategy-aliases').value.trim();
    _strategyDraft.resultTemplate = $('input-strategy-result-template').value.trim();   // E1

    // Validate
    if (!_strategyDraft.tier) { toast('Pick a Strategy tier first (Hand-authored or Composer-based)', 'err'); return; }
    if (!_strategyDraft.name) { toast('Enter a Strategy name', 'err'); return; }
    if (!_strategyDraft.goal) { toast('Enter a Strategy goal', 'err'); return; }
    // T1 (cache) requires authored steps; T3 (frontier) doesn't (the model
    // composes from primitives at runtime).
    if (_strategyDraft.tier === 'cache' && _strategyDraft.fragmentSteps.length === 0) {
      toast('Add at least one step (T1 Strategies have a hand-authored body)', 'err'); return;
    }

    // v2.29.3 (Pass E2-4) — Tree-aware per-step validation.
    //
    // Walks fragment steps at every depth (including inside FOREACH bodies)
    // checking that each fragment has a fragmentId and each required param
    // binding has a non-empty value. FOREACH nodes are checked for non-empty
    // `over` and `as` fields — structurally they're required for runtime.
    //
    // v2.30.0 (Pass G1) — WAIT nodes validated for either duration >= 0 or
    // (mode=condition) a complete condition shape + positive timeout.
    //
    // Generates human-readable path labels like "Step 2 › iteration › Step 1"
    // so users can find where the error is in a deep tree.
    const stepValidationError = (() => {
      const walk = (nodes, label) => {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          const here = label ? `${label} › Step ${i + 1}` : `Step ${i + 1}`;
          if (node.type === 'foreach') {
            if (!node.over?.trim()) return `${here} (FOREACH): "Iterate over" is empty`;
            if (!node.as?.trim())   return `${here} (FOREACH): "Bind each item as" is empty`;
            const bodyErr = walk(node.body ?? [], here);
            if (bodyErr) return bodyErr;
          } else if (node.type === 'wait') {
            // Pass G1 — WAIT validation with friendly locator.
            if (node.mode === 'duration') {
              if (!Number.isFinite(node.durationMs) || node.durationMs < 0) {
                return `${here} (WAIT): duration must be a non-negative number of milliseconds`;
              }
            } else if (node.mode === 'condition') {
              const cond = node.condition;
              if (!cond?.type) {
                return `${here} (WAIT): condition type not chosen`;
              }
              if (cond.type === 'selector_present' || cond.type === 'selector_absent') {
                if (!cond.selector?.trim()) return `${here} (WAIT): CSS selector is empty`;
              } else if (cond.type === 'url_matches') {
                if (!cond.pattern?.trim()) return `${here} (WAIT): URL pattern is empty`;
              } else if (cond.type === 'text_present') {
                if (!cond.text?.trim()) return `${here} (WAIT): text is empty`;
              }
              if (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0) {
                return `${here} (WAIT): timeout must be a positive number of milliseconds`;
              }
            } else {
              return `${here} (WAIT): mode must be Duration or Condition`;
            }
          } else if (node.type === 'pause') {
            // v2.60.0 — PAUSE has no fields to validate. Leaf, parameterless.
          } else if (node.type === 'sieve') {
            // v2.61.0 — SIEVE validation.
            // v2.63.0 (Iteration B) — sieves reference an Analysis by id;
            // operations live in the Analysis. Validate that an Analysis is
            // selected and all its declared params have non-empty bindings.
            // Operations themselves are validated when the Analysis is saved.
            // v2.72.18 (Pass 7b) — Template body kind: source not required
            // (template fans in scope by name; no source list).
            // v2.72.22 (frontier compose) — Frontier compose mode: source
            // not required when pre conditions reference scope bindings;
            // engine fans those bindings in to the model.
            // v2.74.139 — Order changed: detect body kind FIRST, then
            // apply source/output checks per kind. Pre-fix, the unconditional
            // `if (!node.output) return ...` rejected transform-body sieves
            // (whose node.output is intentionally empty — wiring is by
            // declared name, not by sieve fields).
            if (!node.analysisId) return `${here} (SIEVE): no Analysis selected`;
            const chosenForKind = _strategyAnalysisCache.get(node.analysisId);
            const cImpl0Kind = chosenForKind && Array.isArray(chosenForKind.implementations) && chosenForKind.implementations.length > 0
              ? chosenForKind.implementations[0] : null;
            const cTierKind = cImpl0Kind?.tier ?? 'cache';
            const cBodyKind = (cTierKind === 'cache') ? (cImpl0Kind?.body?.kind ?? 'operations') : null;
            const isTransform = cBodyKind === 'transform';
            const isTemplate  = cBodyKind === 'template';
            // Transform-body sieves use neither node.source nor node.output —
            // both wirings are by declared name on the Analysis body. Skip
            // both checks entirely.
            if (!isTransform) {
              if (!node.output) return `${here} (SIEVE): output binding name is empty`;
              if (!node.source) {
                // Template body: source not required.
                // Frontier compose mode: source not required when pre
                // conditions reference scope bindings.
                const preConds = chosenForKind?.preconditions?.conditions
                  ?? (Array.isArray(chosenForKind?.preconditions) ? chosenForKind.preconditions : []);
                const preBindings = preConds
                  .map(c => (c && typeof c === 'object' && typeof c.binding === 'string') ? c.binding : null)
                  .filter(b => b && b !== 'INPUT');
                const isFrontierCompose = cTierKind === 'frontier' && preBindings.length > 0;
                if (!isTemplate && !isFrontierCompose) {
                  return `${here} (SIEVE): source binding name is empty`;
                }
              }
            }
            // Don't fail validation if the cache doesn't have the Analysis —
            // it may have been deleted; surface as a runtime error instead.
            // Param-binding presence is checked when bindings exist.
            const bindings = node.paramBindings ?? {};
            for (const pname of Object.keys(bindings)) {
              const b = bindings[pname];
              if (!b) continue;
              if (b.kind === 'literal' && !String(b.value ?? '').trim()) {
                return `${here} (SIEVE): param "${pname}" has no value`;
              }
              if ((b.kind === 'iteration_variable' || b.kind === 'strategy_param') && !String(b.name ?? '').trim()) {
                return `${here} (SIEVE): param "${pname}" has no source binding`;
              }
            }
          } else if (node.type === 'detect') {
            // Pass G2 — DETECT validation with friendly per-branch locators.
            if (!Array.isArray(node.branches) || node.branches.length === 0) {
              return `${here} (DETECT): add at least one branch`;
            }
            for (let bi = 0; bi < node.branches.length; bi++) {
              const b = node.branches[bi];
              const bHere = `${here} › Branch ${bi + 1} (DETECT)`;
              const cond = b?.condition;
              if (!cond?.type) return `${bHere}: condition type not chosen`;
              if (cond.type === 'selector_present' || cond.type === 'selector_absent') {
                if (!cond.selector?.trim()) return `${bHere}: CSS selector is empty`;
              } else if (cond.type === 'url_matches') {
                if (!cond.pattern?.trim()) return `${bHere}: URL pattern is empty`;
              } else if (cond.type === 'text_present') {
                if (!cond.text?.trim()) return `${bHere}: text is empty`;
              }
              // Recurse into branch body
              const branchBodyErr = walk(b?.body ?? [], bHere);
              if (branchBodyErr) return branchBodyErr;
            }
            // Recurse into default body
            const defaultErr = walk(node.default ?? [], `${here} › Default (DETECT)`);
            if (defaultErr) return defaultErr;
          } else if (node.type === 'loop') {
            // Pass H1 — LOOP validation with friendly locator.
            const cond = node.condition;
            if (!cond?.type) return `${here} (LOOP): condition type not chosen`;
            if (cond.type === 'selector_present' || cond.type === 'selector_absent') {
              if (!cond.selector?.trim()) return `${here} (LOOP): CSS selector is empty`;
            } else if (cond.type === 'url_matches') {
              if (!cond.pattern?.trim()) return `${here} (LOOP): URL pattern is empty`;
            } else if (cond.type === 'text_present') {
              if (!cond.text?.trim()) return `${here} (LOOP): text is empty`;
            }
            if (!Number.isFinite(node.maxIterations) || node.maxIterations <= 0) {
              return `${here} (LOOP): Max iterations must be a positive number`;
            }
            const bodyErr = walk(node.body ?? [], here);
            if (bodyErr) return bodyErr;
          } else if (node.type === 'try') {
            // Pass H2 — TRY validation with friendly locator. No shape
            // constraints other than "body must be an array; recover must be
            // an array (empty is valid)". Descend into both.
            if (!Array.isArray(node.body)) return `${here} (TRY): body must be an array`;
            if (!Array.isArray(node.recover)) return `${here} (TRY): recover must be an array`;
            const tryBodyErr = walk(node.body, `${here} › Attempt (TRY)`);
            if (tryBodyErr) return tryBodyErr;
            const tryRecoverErr = walk(node.recover, `${here} › Recover (TRY)`);
            if (tryRecoverErr) return tryRecoverErr;
          } else if (node.type === 'navigate') {
            // Pass H3 — NAVIGATE validation with friendly locator.
            if (node.mode !== 'url' && node.mode !== 'back' && node.mode !== 'reload') {
              return `${here} (NAVIGATE): mode must be url, back, or reload`;
            }
            if (node.mode === 'url') {
              const u = node.url;
              if (!u || typeof u !== 'object') {
                return `${here} (NAVIGATE): URL not set`;
              }
              if (u.kind === 'literal') {
                if (!u.value || !String(u.value).trim()) {
                  return `${here} (NAVIGATE): URL is empty`;
                }
                if (!/^https?:\/\//i.test(u.value) && !String(u.value).startsWith('about:')) {
                  return `${here} (NAVIGATE): URL must start with http:// or https:// (or about:)`;
                }
              } else if (u.kind === 'strategy_param') {
                if (!u.name || !String(u.name).trim()) {
                  return `${here} (NAVIGATE): input name is empty`;
                }
              } else if (u.kind === 'iteration_variable') {
                if (!u.name || !String(u.name).trim()) {
                  return `${here} (NAVIGATE): iteration variable not chosen`;
                }
              } else {
                return `${here} (NAVIGATE): unknown URL binding kind`;
              }
            }
          } else if (node.type === 'in_new_tab') {
            // Pass J2 — validate IN_NEW_TAB with friendly locator.
            if (!node.trigger) return `${here} (IN_NEW_TAB): trigger is missing — pick Fragment or NAVIGATE for the trigger slot`;
            if (!Array.isArray(node.body)) return `${here} (IN_NEW_TAB): body must be an array`;
            // Recurse into trigger as a one-element array, with a clear locator
            const triggerErr = walk([node.trigger], `${here} › Trigger (IN_NEW_TAB)`);
            if (triggerErr) return triggerErr;
            const bodyErr = walk(node.body, `${here} › Body (IN_NEW_TAB)`);
            if (bodyErr) return bodyErr;
          } else if (node.type === 'scroll') {
            // v2.71.1 — SCROLL has no save-time UI checks. Distance-shape
            // validation lives in StrategyTree.validateStrategyBody (called
            // below). Same pattern as PAUSE — leaf, validated structurally.
          } else if (node.type === 'observation') {
            // v2.72.3 (Pass 4) — OBSERVATION node: surface "no observation
            // selected" early so users get a clearer error than the engine's
            // runtime "OBSERVATION ... not found." Structural validation
            // (paramBindings shape) lives in StrategyTree.validateStrategyBody.
            if (!node.observationId) {
              return `${here} (OBSERVATION): pick an Observation`;
            }
            const obs = _strategyObservationCache.get(node.observationId);
            if (!obs) {
              return `${here} (OBSERVATION): the selected Observation no longer exists on this Ground (id: ${node.observationId})`;
            }
            // v2.72.7 (Pass 3e) — Validate paramBindings cover all declared
            // params. Mirrors the Fragment validator below.
            for (const p of (obs.params ?? [])) {
              const b = node.paramBindings?.[p];
              if (!b) return `${here} (OBSERVATION): missing binding for {{${p}}}`;
              if (b.kind === 'literal' && (b.value ?? '').length === 0) {
                return `${here} (OBSERVATION): literal for {{${p}}} is empty`;
              }
              if (b.kind === 'strategy_param' && (b.name ?? '').length === 0) {
                return `${here} (OBSERVATION): input name for {{${p}}} is empty`;
              }
              if (b.kind === 'iteration_variable' && (b.name ?? '').length === 0) {
                return `${here} (OBSERVATION): iteration variable for {{${p}}} not chosen`;
              }
            }
          } else if (node.type === 'fragment') {
            // v2.71.1 — Made fragment-type explicit. The previous else-fallthrough
            // treated every unknown type as a fragment, which silently broke
            // future strategy-node additions (each new node type without a
            // matching case would fail with "select a Fragment"). Explicit
            // fragment match + explicit unknown-type error makes future
            // additions fail loudly and discoverably.
            if (!node.fragmentId) return `${here}: select a Fragment`;
            const frag = _strategyFragmentCache.get(node.fragmentId);
            for (const p of (frag?.params ?? [])) {
              const b = node.paramBindings?.[p];
              if (!b) return `${here}: missing binding for ${p}`;
              if (b.kind === 'literal' && (b.value ?? '').length === 0) {
                return `${here}: literal for {{${p}}} is empty`;
              }
              if (b.kind === 'strategy_param' && (b.name ?? '').length === 0) {
                return `${here}: input name for {{${p}}} is empty`;
              }
              if (b.kind === 'iteration_variable' && (b.name ?? '').length === 0) {
                return `${here}: iteration variable for {{${p}}} not chosen`;
              }
            }
          } else {
            return `${here}: unknown node type "${node.type}" — possible data corruption or stale extension build`;
          }
        }
        return null;
      };
      return walk(_strategyDraft.fragmentSteps, '');
    })();
    if (stepValidationError) { toast(stepValidationError, 'err'); return; }

    // v2.29.3 (Pass E2-4) — Structural tree validation (iteration_variable
    // references, shadowing). Hard-fail on errors — runtime would fail anyway.
    // v2.74.139 — Pass body-kind lookup so transform/template sieves don't
    // false-positive on source/output requirements.
    const treeValidation = validateStrategyBody(_strategyDraft.fragmentSteps, {
      getAnalysisBodyKind: (id) => {
        const a = _strategyAnalysisCache.get(id);
        const i0 = a && Array.isArray(a.implementations) && a.implementations.length > 0
          ? a.implementations[0] : null;
        if (!i0) return null;
        if (i0.tier === 'frontier') return 'frontier';
        return i0?.body?.kind ?? 'operations';
      },
    });
    if (!treeValidation.ok) {
      toast(`Structural error: ${treeValidation.errors[0]}`, 'err');
      return;
    }

    const aliases = _strategyDraft.aliases
      .split(',').map(s => s.trim()).filter(Boolean);

    // v2.59.0 — collectStrategyParams returns Map<name, {kind, sources}>.
    // Convert to canonical [{name, kind}] sorted by name. Detect kind
    // conflicts and surface as save-time warnings (allowed to save with
    // warnings — same posture as composition warnings below).
    const collectedParams = collectStrategyParams(_strategyDraft.fragmentSteps);
    const derivedParams = [...collectedParams.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, info]) => ({ name, kind: info.kind }));
    const paramConflictWarnings = detectStrategyParamConflicts(collectedParams);

    // v2.74.72 — Typed-input merging removed from the Workflow save path.
    // Body-derived params are saved as-is in their plain scalar/list form.
    // Typed inputs (file / number / boolean / default values) are now
    // authored on the parent Strategy form, which carries its own params
    // dictionary independent of any Workflow's internal references.

    // v2.29.0 (Pass E2-1) — Preserve the full node shape on save, including
    // type field and any nested FOREACH bodies. The old projection stripped
    // non-fragment-specific fields; that was safe when all nodes were fragments
    // but loses tree structure in E2.
    //
    // v2.30.0 (Pass G1) — WAIT nodes serialize only the fields relevant to
    // their mode (duration OR condition, not both). Avoids stale fields
    // from prior mode states living on in storage.
    //
    // v2.31.0 (Pass G2) — DETECT nodes serialize branches + default,
    // recursively. Per-branch condition uses the same pruning rule as
    // WAIT condition mode.
    //
    // v2.45.0 — derived from CONDITION_FIELDS (single source of truth in
    // Services/Assertion.js). Previously per-type if/else chain that drifted
    // from the canonical type definitions; M2 added attribute_equals and
    // assertion_ref to CONDITION_TYPES but missed updating this function,
    // silently stripping fields on save. Schema-derived form prevents the
    // class of bug entirely — adding a new type to CONDITION_FIELDS makes
    // serialization work without touching this function.
    const serializeCondition = (cond) => {
      const t = cond?.type ?? 'selector_present';
      const schema = CONDITION_FIELDS[t];
      const out = { type: t };
      if (schema) {
        for (const f of schema.fields) out[f] = cond?.[f] ?? '';
      }
      return out;
    };
    // v2.61.0 — Sieve op serialization. Mirrors normalizeSieveOp engine-side
    // shape; defensive defaults so partially-edited ops save without
    // exploding (engine normalizes again on load).
    const serializeSieveOp = (op) => {
      if (!op || typeof op !== 'object') return null;
      if (op.op === 'filter') {
        return { op: 'filter', assertion: serializeSieveAssertion(op.assertion ?? {}) };
      }
      if (op.op === 'sort') {
        return {
          op: 'sort',
          key: String(op.key ?? '').trim(),
          direction: op.direction === 'desc' ? 'desc' : 'asc',
          coerceAs: ['number', 'date'].includes(op.coerceAs) ? op.coerceAs : 'string',
        };
      }
      if (op.op === 'take') {
        const n = parseInt(op.count, 10);
        return { op: 'take', count: Number.isFinite(n) ? Math.max(0, n) : 0 };
      }
      return null;
    };
    const serializeSieveAssertion = (p) => {
      if (!p || typeof p !== 'object') return { type: 'always_true' };
      switch (p.type) {
        case 'field_equals':
        case 'field_starts_with':
        case 'field_contains':
          return { type: p.type, field: String(p.field ?? '').trim(), value: String(p.value ?? '') };
        case 'field_present':
          return { type: 'field_present', field: String(p.field ?? '').trim() };
        case 'all_of':
        case 'any_of':
          return {
            type: p.type,
            assertions: Array.isArray(p.assertions) ? p.assertions.map(serializeSieveAssertion) : [],
          };
        case 'not':
          return { type: 'not', assertion: serializeSieveAssertion(p.assertion ?? {}) };
        default:
          return { type: 'always_true' };
      }
    };

    const serializeNode = (n) => {
      if (n.type === 'foreach') {
        return {
          type: 'foreach',
          over: n.over,
          as  : n.as,
          body: (n.body ?? []).map(serializeNode),
        };
      }
      if (n.type === 'wait') {
        if (n.mode === 'condition') {
          return {
            type: 'wait',
            mode: 'condition',
            condition: serializeCondition(n.condition ?? {}),
            timeoutMs: Number.isFinite(n.timeoutMs) ? n.timeoutMs : 5000,
            pollIntervalMs: Number.isFinite(n.pollIntervalMs) ? n.pollIntervalMs : 100,
          };
        }
        // Default to duration mode
        return {
          type: 'wait',
          mode: 'duration',
          durationMs: Number.isFinite(n.durationMs) ? n.durationMs : 500,
        };
      }
      // v2.60.0 — PAUSE node. Leaf, no parameters.
      if (n.type === 'pause') {
        return { type: 'pause' };
      }
      // v2.61.0 — SIEVE node. List-to-list transformation.
      // v2.63.0 (Iteration B) — sieves reference an Analysis by id with
      // paramBindings. Inline `operations` are retained only when no
      // analysisId is set (i.e. user added a sieve but hasn't picked an
      // Analysis yet); the engine treats this as a configuration error at
      // execution time. Migration on next load auto-converts any remaining
      // operations-only shape, so this branch is rare.
      if (n.type === 'sieve') {
        const out = {
          type: 'sieve',
          source: String(n.source ?? '').trim(),
          output: String(n.output ?? '').trim(),
        };
        if (typeof n.analysisId === 'string' && n.analysisId.trim()) {
          out.analysisId = n.analysisId.trim();
          out.paramBindings = (n.paramBindings && typeof n.paramBindings === 'object')
            ? { ...n.paramBindings }
            : {};
        } else if (Array.isArray(n.operations) && n.operations.length > 0) {
          // Legacy fallback (shouldn't reach this in practice after migration).
          out.operations = n.operations.map(serializeSieveOp).filter(Boolean);
        } else {
          out.analysisId = null;
          out.paramBindings = {};
        }
        return out;
      }
      if (n.type === 'detect') {
        return {
          type: 'detect',
          branches: (n.branches ?? []).map(b => ({
            condition: serializeCondition(b?.condition ?? {}),
            body: (b?.body ?? []).map(serializeNode),
          })),
          default: (n.default ?? []).map(serializeNode),
        };
      }
      if (n.type === 'loop') {
        return {
          type: 'loop',
          condition: serializeCondition(n.condition ?? {}),
          body: (n.body ?? []).map(serializeNode),
          maxIterations: Number.isFinite(n.maxIterations) ? n.maxIterations : 100,
        };
      }
      if (n.type === 'try') {
        return {
          type: 'try',
          body: (n.body ?? []).map(serializeNode),
          recover: (n.recover ?? []).map(serializeNode),
        };
      }
      if (n.type === 'navigate') {
        const mode = (n.mode === 'back' || n.mode === 'reload') ? n.mode : 'url';
        if (mode !== 'url') return { type: 'navigate', mode };
        const u = n.url ?? {};
        if (u.kind === 'strategy_param') {
          return { type: 'navigate', mode: 'url', url: { kind: 'strategy_param', name: String(u.name ?? '') } };
        }
        if (u.kind === 'iteration_variable') {
          return { type: 'navigate', mode: 'url', url: { kind: 'iteration_variable', name: String(u.name ?? '') } };
        }
        return { type: 'navigate', mode: 'url', url: { kind: 'literal', value: String(u.value ?? '') } };
      }
      // v2.71.3 — SCROLL node serialization. Mirrors NAVIGATE's url-binding
      // shape for the distance field. mode='by' is the only v1 mode.
      if (n.type === 'scroll') {
        const d = n.distance ?? {};
        let distance;
        if (d.kind === 'strategy_param') {
          distance = { kind: 'strategy_param', name: String(d.name ?? '') };
        } else if (d.kind === 'iteration_variable') {
          distance = { kind: 'iteration_variable', name: String(d.name ?? '') };
        } else {
          distance = { kind: 'literal', value: String(d.value ?? '') };
        }
        return { type: 'scroll', mode: 'by', distance };
      }
      // v2.72.3 (Pass 4) — OBSERVATION node serialization. Just an id
      // pointer + paramBindings (reserved for future param substitution;
      // 3a-era observations have empty bindings).
      if (n.type === 'observation') {
        return {
          type         : 'observation',
          observationId: typeof n.observationId === 'string' ? n.observationId : '',
          paramBindings: { ...(n.paramBindings ?? {}) },
        };
      }
      if (n.type === 'in_new_tab') {
        return {
          type: 'in_new_tab',
          trigger: n.trigger ? serializeNode(n.trigger) : null,
          body: (n.body ?? []).map(serializeNode),
          closeOnExit: n.closeOnExit !== false,
        };
      }
      // v2.71.3 — Made fragment match explicit. Pre-v2.71.3 the catch-all
      // "Default: fragment" caused every unknown type to be silently
      // serialized as a fragment with undefined fragmentId — this corrupted
      // SCROLL nodes when v2.71.0 added them without updating this function.
      // Explicit match + explicit error makes future node-type additions
      // fail loudly at save time rather than silently misshaping data.
      if (n.type === 'fragment' || !n.type) {
        return {
          type         : 'fragment',
          fragmentId   : n.fragmentId,
          paramBindings: { ...(n.paramBindings ?? {}) },
        };
      }
      throw new Error(`serializeNode: unknown node type "${n.type}" — strategy save aborted to prevent data corruption`);
    };

    // v2.72.24 (Pass 13) — Wrap pre/post arrays into envelope shape on save.
    // Envelope = {match, conditions, count?}. Defaults match='all'; count
    // included only for k_of_n.
    const wrapEnv = (arr, match, count) => {
      const m = (match === 'any' || match === 'k_of_n') ? match : 'all';
      const env = {
        match: m,
        conditions: Array.isArray(arr) ? arr : [],
      };
      if (m === 'k_of_n' && Number.isFinite(count) && count > 0) env.count = count;
      return env;
    };

    // v2.72.27 (Pass 15) — Build implementations envelope. T1 wraps the
    // fragment tree under body.tree.fragmentSteps (canonical store). T3
    // has no body — the strategy's name + goal + pre/post are the model's
    // compose instruction. Top-level fragmentSteps stays in the saved
    // record as a mirror (storage-side compat for any consumer that reads
    // it directly; engine reads body.tree first).
    const serializedSteps = _strategyDraft.fragmentSteps.map(serializeNode);
    const implementations = _strategyDraft.tier === 'frontier'
      ? [{ tier: 'frontier' }]
      : [{ tier: 'cache', body: { tree: { fragmentSteps: serializedSteps } } }];

    const strategy = {
      id            : _strategyDraft.id,
      groundId      : _strategyDraft.groundId,
      name          : _strategyDraft.name,
      goal          : _strategyDraft.goal,
      aliases,
      resultTemplate: _strategyDraft.resultTemplate,   // E1 (empty string OK)
      // T1 mirror: fragmentSteps at top level matches body.tree.fragmentSteps.
      // T3: empty array (no authored steps).
      fragmentSteps : _strategyDraft.tier === 'frontier' ? [] : serializedSteps,
      // v2.74.72 — Workflow params are body-derived only. Typed inputs
      // are owned by the parent Strategy form (studio.js).
      params        : derivedParams,
      outcomeSignal : null,    // Pass E2+
      preconditions : wrapEnv(_strategyDraft.preconditions,  _strategyDraft.preMatch,  _strategyDraft.preCount),
      postconditions: wrapEnv(_strategyDraft.postconditions, _strategyDraft.postMatch, _strategyDraft.postCount),
      // v2.74.155 — Declared outputs to promote to the parent Workflow.
      // Drop empty-name rows; trim each name. Save as an array of
      // {name} objects so future extensions (alias, description, kind
      // hint) can land without a shape migration.
      outputs       : (Array.isArray(_strategyDraft.outputs) ? _strategyDraft.outputs : [])
        .map(o => ({ name: String(o?.name ?? '').trim() }))
        .filter(o => o.name.length > 0),
      implementations,
      updatedAt     : Date.now(),
    };
    if (!_strategyDraft.isEditing) strategy.createdAt = Date.now();

    const response = await new Promise(r => chrome.runtime.sendMessage({
      type: 'SAVE_STRATEGY', payload: { strategy },
    }, r));

    if (!response?.success) {
      toast(`Failed to save Strategy: ${response?.error ?? 'unknown'}`, 'err');
      return;
    }

    // v2.25.6 — surface composition warning count in the save toast so users
    // know they saved with unresolved warnings (which is allowed, just noted).
    // v2.59.0 — also surface param-kind conflicts (e.g. a name used as both
    // a FOREACH source and a scalar reference). Allowed to save; flagged.
    const compositionWarnings = analyzeStrategyComposition(
      _strategyDraft.fragmentSteps,
      _strategyFragmentCache,
      { resultTemplate: _strategyDraft.resultTemplate ?? '' },
    );
    // v2.61.2 — SIEVE source-binding warnings. Walk the tree collecting
    // names that name a list binding the user can see from the strategy
    // editor: outputs of upstream sieves, FOREACH `as` names, and
    // ENUMERATE/EMIT targets inside referenced fragments. v2.61.7 — fragment
    // introspection added so SIEVEs consuming an ENUMERATE'd binding no
    // longer trigger a false-positive warning. The cache exposes rawJson;
    // we parse and scan for action: 'ENUMERATE' | 'EMIT' with a target.
    const sieveSourceWarnings = (() => {
      const knownProducers = new Set();
      const warnings = [];
      // v2.61.7 — extract list-binding targets from a fragment's rawJson.
      // Mirrors the renderer's availableLists population logic.
      // v2.72.26 (Pass 14b) — Walk rawJson directly. Pass 14's
      // fragment.produces was reverted.
      const collectFragmentTargets = (fragment) => {
        if (!fragment?.rawJson) return;
        try {
          const actions = JSON.parse(fragment.rawJson);
          if (!Array.isArray(actions)) return;
          for (const a of actions) {
            if ((a?.action === 'ENUMERATE' || a?.action === 'EMIT') && a.target) {
              knownProducers.add(a.target);
            }
          }
        } catch { /* invalid rawJson — skip */ }
      };
      const collect = (nodes) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes) {
          if (!node) continue;
          if (node.type === 'sieve' && node.output) knownProducers.add(node.output);
          if (node.type === 'foreach' && node.as)   knownProducers.add(node.as);
          // v2.61.7 — fragment refs contribute their ENUMERATE/EMIT targets
          if (node.type === 'fragment' || (!node.type && node.fragmentId)) {
            const fid = node.fragmentId ?? node.fragment_id ?? null;
            if (fid) collectFragmentTargets(_strategyFragmentCache.get(fid));
          }
          // descend into bodies for nested producers
          if (node.type === 'foreach') collect(node.body);
          else if (node.type === 'detect') {
            for (const b of node.branches ?? []) collect(b?.body);
            collect(node.default);
          } else if (node.type === 'loop')   collect(node.body);
          else if (node.type === 'try')      { collect(node.body); collect(node.recover); }
          else if (node.type === 'in_new_tab') { if (node.trigger) collect([node.trigger]); collect(node.body); }
        }
      };
      // First pass — collect all known list-binding producers
      collect(_strategyDraft.fragmentSteps);
      // Second pass — flag SIEVE nodes whose source isn't in the set
      const checkSieves = (nodes, depth) => {
        if (!Array.isArray(nodes)) return;
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i];
          if (!node) continue;
          if (node.type === 'sieve') {
            if (node.source && !knownProducers.has(node.source)) {
              warnings.push(
                `Step ${i + 1}${depth ? ' (in ' + depth + ')' : ''}: SIEVE source "${node.source}" `
                + `doesn't match any visible upstream binding (sieve output, FOREACH 'as', `
                + `OBSERVATION output, or fragment ENUMERATE/EMIT target). Will fail at runtime if no node produces it.`
              );
            }
          }
          if (node.type === 'foreach')          checkSieves(node.body, 'FOREACH body');
          else if (node.type === 'detect') {
            for (const b of node.branches ?? []) checkSieves(b?.body, 'DETECT branch');
            checkSieves(node.default, 'DETECT default');
          }
          else if (node.type === 'loop')        checkSieves(node.body, 'LOOP body');
          else if (node.type === 'try')         { checkSieves(node.body, 'TRY body'); checkSieves(node.recover, 'TRY recover'); }
          else if (node.type === 'in_new_tab')  checkSieves(node.body, 'IN_NEW_TAB body');
        }
      };
      checkSieves(_strategyDraft.fragmentSteps, '');
      return warnings;
    })();
    const totalWarningCount = compositionWarnings.length + paramConflictWarnings.length + sieveSourceWarnings.length;
    const warnNote = totalWarningCount > 0
      ? ` · ${totalWarningCount} warning${totalWarningCount === 1 ? '' : 's'}`
      : '';
    // Log param conflicts to console so user can see the details (toast is
    // intentionally short).
    if (paramConflictWarnings.length > 0) {
      console.warn(`[studio] Strategy "${strategy.name}" saved with param-kind conflicts:\n  - ${paramConflictWarnings.join('\n  - ')}`);
    }
    if (sieveSourceWarnings.length > 0) {
      console.warn(`[studio] Strategy "${strategy.name}" saved with SIEVE source warnings:\n  - ${sieveSourceWarnings.join('\n  - ')}`);
    }

    toast(`Strategy "${strategy.name}" saved — ${strategy.fragmentSteps.length} step${strategy.fragmentSteps.length === 1 ? '' : 's'}, ${strategy.params.length} input${strategy.params.length === 1 ? '' : 's'}${warnNote}`, totalWarningCount > 0 ? 'warn' : undefined);
    closeStrategyForm();
    // v2.73.3 — refreshGroundList is a _setup injection, not a sibling.
    // Pass 4-f Phase 2's migration script missed this conversion, leaving
    // a bare reference that would throw ReferenceError after every save.
    await _setup.refreshGroundList();
  });

}

// ─── Setup ───────────────────────────────────────────────────────────────
//
// studio.js calls setupStrategyForm({...}) once during init to inject the
// shared utilities defined in studio.js. Module state lives here as
// module-locals (see "Module state" section near the top of this file);
// state-getter/setter injections that lived in _setup before Pass 4-f
// Phase 2 have been removed.
//
//   SHARED UTILITIES (live in studio.js, injected here)
//     buildConditionTypeOptions  — type dropdown options
//     decodeConditionTypeValue   — type dropdown value decoder
//     addWarningIcon             — surfaces ⚠ on a step card
//     refreshGroundList          — re-renders the ground accordion list
//     renderConditionEditor      — shared condition editor used by
//                                  renderStrategyNodes for DETECT/LOOP/
//                                  WAIT/TRY conditions
//
// Queued post-Pass-4: extract renderConditionEditor / buildConditionTypeOptions /
// decodeConditionTypeValue to a shared module (e.g. Services/ConditionEditor.js)
// so all 4 form modules import them directly and these last 3 injections
// drop. addWarningIcon and refreshGroundList stay studio.js-resident
// (they touch ground-accordion DOM that studio.js owns).

let _setup = {};

export function setupStrategyForm(deps) {
  _setup = deps ?? {};
}
