/**
 * @file Sidepanel/modes/workflow-debug.js
 * @description Dedicated sidepanel debugger for top-level Workflow entities
 * (storage kind: `workflow`). Mirrors the per-Ground `strategy-debug` mode
 * used by Strategies, but consumes the Workflow-tier runtime broadcasts
 * (WORKFLOW_PROGRESS, WORKFLOW_PAUSE_STATE) rather than the CapabilityAPI
 * event channel.
 *
 * Mounted via REQUEST_SIDEPANEL_MODE with payload:
 *   {
 *     invocationId  : string,    // optional — auto-fills as events arrive
 *     workflowId    : string,
 *     workflowName  : string,
 *     steps         : Array,     // snapshot of the Workflow's top-level steps
 *                                // (for the step-list preview before events fire)
 *   }
 *
 * What this mode shows:
 *   • Header — Workflow name + status pill (idle / running / paused /
 *     completed / failed / aborted)
 *   • Step list — one row per top-level step with progress markers that
 *     fill in as `strategy_step_done` / `strategy_step_skipped` events
 *     stream through (the shared event-type vocabulary is kept generic
 *     across both runtimes — see Bucket E in v2.74.142 notes)
 *   • Scope inspector — live view of the Workflow-tier scope bindings
 *     the run has accumulated. Updates after every step via
 *     `strategy_scope_snapshot` events emitted by the executor (gated
 *     on debug envelope presence, so non-debug invocations don't pay
 *     for the broadcast).
 *   • Event log — chronological list of progress events for the run
 *   • Controls — Pause / Resume / Cancel while running; Close when done
 *
 * Out of scope (deliberate):
 *   - Step-through controls (single-step semantics)
 *   - Nested-step expansion (FOREACH iterations / DETECT branches show
 *     only at the top-level step granularity for now)
 *
 * @module Sidepanel/modes/workflow-debug
 */

import { toast, exitToStudio } from '../shell-api.js';

// ─── DOM refs (populated on mount) ────────────────────────────────────────
let _mountEl = null;

// ─── Mode state ───────────────────────────────────────────────────────────
//
// Single-invocation debugger. If a new invocation is requested while one is
// active, the old state is replaced. This matches the per-Ground
// strategy-debug mode's single-session posture; multi-invocation overlay
// belongs in a later pass (probably a different mode or a sub-view).
let _state = {
  invocationId : null,
  workflowId   : null,
  workflowName : '',
  steps        : [],   // [{type, ...}] — snapshot from payload
  paused       : false,
  completed    : false,
  outcome      : null,  // 'success' | 'failed' | 'aborted' | null (still running)
  // v2.74.100 — Switched from numeric stepIndex to dot-path keying so
  // nested control-flow body steps can be tracked individually.
  //   currentStep  : path string of the step currently executing | null
  //   resultByPath : { [path]: {success, skipped?, error?} }
  //   controlState : { [path]: {kind, iter?, total?, branch?, inRecovery?} }
  currentStep  : null,
  resultByPath : {},
  log          : [],   // [{ts, type, message}]  — capped at 200
  // v2.74.93 — Live Workflow-tier scope. Updates from
  // `strategy_scope_snapshot` events after every step (event-type name
  // kept generic across both runtimes per v2.74.142 Bucket E). Empty
  // map until the first event arrives. Shape: { [name]: TaggedValue }.
  scope        : {},
  // v2.74.95 — Top-level breakpoints (Set of step indices). Updates from
  // WORKFLOW_BREAKPOINTS broadcasts. Click a step row's gutter to toggle.
  breakpoints  : new Set(),
  // v2.74.96 — Scope rows that are currently expanded for deep inspection.
  // Click a row's chevron to toggle. Survives scope-snapshot updates
  // (renamed bindings disappear naturally; existing ones persist).
  expandedScope: new Set(),
  // v2.74.97 — Control-flow progress per step. Updated from
  // strategy_foreach_iter / strategy_loop_iter / strategy_detect_branch /
  // strategy_detect_default / strategy_try_recover events; cleared when
  // the step completes. Shape per entry:
  //   { kind, iter?, total?, branch?, inRecovery? }
  // Used to render the inline progress pill on each step row.
  controlState : {},
  // v2.74.97 — Toggle: when true, fromInnerWorkflow events show in the
  // log. Default false because the inner runtime's events are usually
  // noise from the Workflow-tier debugger's perspective; turn on when
  // you want to see what's happening inside a specific Strategy step.
  showInner    : false,
};

let _runtimeListener = null;

const LOG_CAP = 200;

// v2.74.103 — Internal separator for expandedScope paths.
//
// Previously used "." which collided with binding names containing dots
// (e.g. a binding "FOO.BAR" can't be distinguished from item 1 of binding
// "FOO" — both produce the path "FOO.BAR"). Switching to U+001F (ASCII
// Unit Separator) — purpose-built control char, can never appear in
// legitimate user-authored binding names. Internal-only; never displayed,
// just used as the Set key delimiter.
//
// HTML attribute encoding tolerates control chars; DOM `dataset` reads
// roundtrip cleanly through `data-path="..."`.
const SCOPE_PATH_SEP = '\x1F';

// ─── HTML escape (kept local) ────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// v2.74.93 — Pretty-print a Scope tagged value for the inspector row.
//
//   scalar    → quoted string value (truncated at 80 chars)
//   list      → "N items" + optional first-item preview
//   record    → "{ k1, k2, … } · N fields"
//   image     → "image (W×H)" + label
//   section   → "section · N chars"
//   document  → "document · N bytes"
//   untagged  → JSON-stringify fallback
//
// The kind chip is rendered separately by the row template; this returns
// only the value-side text, already HTML-escaped.
function _formatTaggedValue(v) {
  if (v == null) return '<em>∅</em>';
  if (typeof v !== 'object') return esc(String(v));

  switch (v.kind) {
    case 'scalar': {
      const s = String(v.value ?? '');
      return `"${esc(s.length > 80 ? s.slice(0, 77) + '…' : s)}"`;
    }
    case 'list': {
      const items = Array.isArray(v.items) ? v.items : [];
      if (items.length === 0) return '<em>empty list</em>';
      // Preview first item if it's a scalar; otherwise just count.
      const first = items[0];
      const tail  = items.length === 1 ? '' : ` <span class="wfd-scope-meta">+${items.length - 1} more</span>`;
      if (first?.kind === 'scalar') {
        const s = String(first.value ?? '');
        return `${esc(s.length > 40 ? s.slice(0, 37) + '…' : s)}${tail}`;
      }
      return `<span class="wfd-scope-meta">${items.length} item${items.length === 1 ? '' : 's'}</span>`;
    }
    case 'record': {
      const keys = Object.keys(v.fields ?? {});
      const shown = keys.slice(0, 4).map(esc).join(', ');
      const more  = keys.length > 4 ? `, +${keys.length - 4}…` : '';
      return `<span class="wfd-scope-meta">{ ${shown}${more} }</span>`;
    }
    case 'image':
      return `<span class="wfd-scope-meta">image ${v.width ?? '?'}×${v.height ?? '?'}${v.label ? ` · ${esc(v.label)}` : ''}</span>`;
    case 'section':
      return `<span class="wfd-scope-meta">section · ${String(v.markdown ?? '').length} chars</span>`;
    case 'document':
      return `<span class="wfd-scope-meta">document · ${v.byteSize ?? '?'} bytes</span>`;
    case 'element':
      return `<code class="wfd-scope-code">${esc(v.selector ?? '')}</code>`;
    default: {
      const json = (() => { try { return JSON.stringify(v); } catch (_) { return String(v); } })();
      return esc(json.length > 80 ? json.slice(0, 77) + '…' : json);
    }
  }
}

function _scopeKindChip(v) {
  if (v == null || typeof v !== 'object' || !v.kind) return '';
  return `<span class="wfd-scope-kind wfd-scope-kind-${esc(v.kind)}">${esc(v.kind)}</span>`;
}

// v2.74.102 — Worth a chevron of its own? Used by the recursive
// expanded-content renderer to decide whether a list item gets a
// sub-row chevron (and is therefore drillable). Scalars and elements
// don't expand to anything more useful than their summary; everything
// else (list, record, image, section, document) does.
function _isComplexTaggedValue(v) {
  if (v == null || typeof v !== 'object') return false;
  return v.kind === 'list' || v.kind === 'record' || v.kind === 'image'
      || v.kind === 'section' || v.kind === 'document';
}

// v2.74.103 — Drop expansion entries whose root binding is no longer in
// scope. Path format: "BINDING_NAME" or "BINDING_NAME<US>0<US>3..." where
// <US> is SCOPE_PATH_SEP. The root segment is everything up to the first
// separator. Called whenever a snapshot replaces the live scope.
function _pruneExpandedScope() {
  if (!_state.expandedScope || _state.expandedScope.size === 0) return;
  const liveNames = new Set(Object.keys(_state.scope ?? {}));
  const toRemove = [];
  for (const path of _state.expandedScope) {
    const sepIdx = path.indexOf(SCOPE_PATH_SEP);
    const rootName = sepIdx >= 0 ? path.slice(0, sepIdx) : path;
    if (!liveNames.has(rootName)) toRemove.push(path);
  }
  for (const p of toRemove) _state.expandedScope.delete(p);
}

// v2.74.100 — Recursive step-tree renderer for the Steps section.
//
// Walks the live `steps` array building a flat list of step rows, each
// addressed by its dot-notation path. Control-flow types (FOREACH /
// LOOP / DETECT / TRY) get their bodies recursively rendered immediately
// after the parent row, indented one level deeper.
//
// Path conventions match the executor's:
//   ""           — top-level array
//   "0.body"     — FOREACH / LOOP body
//   "0.recovery" — TRY recovery body
//   "0.default"  — DETECT default body
//   "0.branches.K.body" — DETECT branch K's body
function _renderStepTree(steps, pathPrefix, depth) {
  if (!Array.isArray(steps) || steps.length === 0) return '';
  return steps.map((step, i) => {
    const path = pathPrefix ? `${pathPrefix}.${i}` : String(i);
    const rowHtml = _renderStepRow(step, i, path, depth);
    // Recurse into children for control-flow types. Branches and recovery
    // get their own sub-headers so the user can see WHICH body the nested
    // rows belong to.
    let childrenHtml = '';
    if (step?.type === 'foreach' && Array.isArray(step.body) && step.body.length) {
      childrenHtml = _renderStepTree(step.body, `${path}.body`, depth + 1);
    }
    else if (step?.type === 'loop' && Array.isArray(step.body) && step.body.length) {
      childrenHtml = _renderStepTree(step.body, `${path}.body`, depth + 1);
    }
    else if (step?.type === 'try') {
      const bodyHtml     = Array.isArray(step.body)     && step.body.length     ? _renderStepTree(step.body,     `${path}.body`,     depth + 1) : '';
      const recoveryHtml = Array.isArray(step.recovery) && step.recovery.length ? _renderStepTree(step.recovery, `${path}.recovery`, depth + 1) : '';
      childrenHtml = (bodyHtml || recoveryHtml) ? `
        ${bodyHtml ? `<div class="wfd-step-sub-label" style="--wfd-depth: ${depth + 1}">body</div>${bodyHtml}` : ''}
        ${recoveryHtml ? `<div class="wfd-step-sub-label" style="--wfd-depth: ${depth + 1}">recovery</div>${recoveryHtml}` : ''}
      ` : '';
    }
    else if (step?.type === 'detect') {
      const branches = Array.isArray(step.branches) ? step.branches : [];
      const branchSections = branches.map((branch, k) => {
        if (!Array.isArray(branch?.body) || branch.body.length === 0) return '';
        const inner = _renderStepTree(branch.body, `${path}.branches.${k}.body`, depth + 1);
        return `<div class="wfd-step-sub-label" style="--wfd-depth: ${depth + 1}">branch ${k + 1}</div>${inner}`;
      }).join('');
      const defaultSection = Array.isArray(step.default) && step.default.length
        ? `<div class="wfd-step-sub-label" style="--wfd-depth: ${depth + 1}">default</div>${_renderStepTree(step.default, `${path}.default`, depth + 1)}`
        : '';
      childrenHtml = branchSections + defaultSection;
    }
    return rowHtml + childrenHtml;
  }).join('');
}

function _renderStepRow(step, localIdx, path, depth) {
  const s = _state;
  const result = s.resultByPath?.[path];
  let cls = 'wfd-step';
  let icon = '○';
  let tail = '';
  if (result) {
    if (result.skipped)           { cls += ' skipped'; icon = '⊘'; tail = '<span class="wfd-step-tail">skipped</span>'; }
    else if (result.success === false) { cls += ' failed';  icon = '✕'; tail = `<span class="wfd-step-tail wfd-step-error">${esc(result.error ?? 'failed')}</span>`; }
    else                          { cls += ' done';    icon = '✓'; }
  } else if (path === s.currentStep) {
    cls += ' current';
    icon = s.paused ? '⏸' : '▶';
  }
  const hasBp = s.breakpoints?.has(path);
  if (hasBp) cls += ' has-breakpoint';

  // Control-flow progress pill (FOREACH iter / LOOP iter / DETECT branch /
  // TRY recovery). Keyed by path now.
  const ctrl = s.controlState?.[path];
  let ctrlPill = '';
  if (ctrl) {
    let label = '';
    let pillCls = 'wfd-step-ctrl';
    if (ctrl.kind === 'foreach') {
      label = ctrl.total != null ? `iter ${ctrl.iter}/${ctrl.total}` : `iter ${ctrl.iter}`;
    } else if (ctrl.kind === 'loop') {
      label = `iter ${ctrl.iter ?? '?'}`;
    } else if (ctrl.kind === 'detect') {
      label = ctrl.branch === 'default' ? 'default' : `branch ${ctrl.branch}`;
    } else if (ctrl.kind === 'try' && ctrl.inRecovery) {
      label = 'recovering'; pillCls += ' wfd-step-ctrl-warn';
    }
    if (label) ctrlPill = `<span class="${pillCls}">${esc(label)}</span>`;
  }

  return `<div class="${cls}" data-path="${esc(path)}" style="--wfd-depth: ${depth}">
    <span class="wfd-step-gutter${hasBp ? ' is-set' : ''}"
          data-action="toggle-breakpoint" data-step-path="${esc(path)}"
          title="${hasBp ? 'Clear breakpoint' : 'Set breakpoint'}">●</span>
    <span class="wfd-step-icon">${icon}</span>
    <span class="wfd-step-num">${localIdx + 1}</span>
    <span class="wfd-step-type">${esc(step?.type ?? '?')}</span>
    ${ctrlPill}
    ${tail}
  </div>`;
}

// v2.74.93 — Render the Scope inspector body. Empty state when no
// bindings yet; otherwise a sorted-by-name table of {name, kind, preview}.
// v2.74.96 — Each row has a chevron toggle that expands to a detailed
// view (full scalar, enumerated list items, record fields, image preview,
// section/document text dump).
function _renderScopeRows(scope) {
  const entries = Object.entries(scope ?? {});
  if (entries.length === 0) {
    return '<div class="wfd-scope-empty">No scope bindings yet — they appear as Strategy / Analysis steps complete.</div>';
  }
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const expanded = _state.expandedScope ?? new Set();
  return entries.map(([name, value]) => {
    const open = expanded.has(name);
    // v2.74.102 — Pass the path so nested sub-rows can compute their own
    // child paths and recurse via the same expandedScope mechanism.
    const expandedHtml = open
      ? `<div class="wfd-scope-expanded">${_renderScopeExpandedContent(value, name)}</div>`
      : '';
    return `
      <div class="wfd-scope-row${open ? ' is-expanded' : ''}" title="${esc(name)}">
        <span class="wfd-scope-chev${open ? ' is-open' : ''}"
              data-action="toggle-scope-expand" data-path="${esc(name)}"
              title="${open ? 'Collapse' : 'Expand'}">▸</span>
        <code class="wfd-scope-name">${esc(name)}</code>
        ${_scopeKindChip(value)}
        <span class="wfd-scope-value">${_formatTaggedValue(value)}</span>
      </div>
      ${expandedHtml}`;
  }).join('');
}

// v2.74.96 — Per-kind deep view. Lists enumerate items as sub-rows;
// records show key/value table; scalars dump full text; sections /
// documents render first 1000 chars as `<pre>` with an ellipsis tail
// if truncated; images render a thumbnail when base64 is present.
function _renderScopeExpandedContent(value, path) {
  if (value == null) return '<em>null</em>';
  if (typeof value !== 'object') {
    return `<pre class="wfd-scope-expanded-text">${esc(String(value))}</pre>`;
  }
  switch (value.kind) {
    case 'scalar': {
      const s = String(value.value ?? '');
      const subtype = value.subtype && value.subtype !== 'string' ? `<span class="wfd-scope-meta">(${esc(value.subtype)})</span>` : '';
      return `<div class="wfd-scope-expanded-block">${subtype}<pre class="wfd-scope-expanded-text">${esc(s)}</pre></div>`;
    }
    case 'list': {
      // v2.74.102 — Each list item gets a sub-row. Complex items (kind
      // = list / record / image / section / document) become themselves
      // expandable via a chevron; clicking it adds `path.idx` to
      // expandedScope and recurses through this same renderer.
      const items = Array.isArray(value.items) ? value.items : [];
      if (items.length === 0) return '<div class="wfd-scope-expanded-block"><em>empty list</em></div>';
      const expanded = _state.expandedScope ?? new Set();
      const rows = items.slice(0, 50).map((item, i) => {
        const subPath = `${path}${SCOPE_PATH_SEP}${i}`;
        const complex = _isComplexTaggedValue(item);
        const open = complex && expanded.has(subPath);
        const chev = complex
          ? `<span class="wfd-scope-chev wfd-scope-chev-sub${open ? ' is-open' : ''}"
                   data-action="toggle-scope-expand" data-path="${esc(subPath)}"
                   title="${open ? 'Collapse' : 'Expand'}">▸</span>`
          : '<span class="wfd-scope-chev wfd-scope-chev-sub wfd-scope-chev-placeholder"></span>';
        const inner = open
          ? `<div class="wfd-scope-expanded wfd-scope-expanded-nested">${_renderScopeExpandedContent(item, subPath)}</div>`
          : '';
        return `
          <div class="wfd-scope-sub-row${open ? ' is-expanded' : ''}">
            ${chev}
            <span class="wfd-scope-sub-idx">${i}</span>
            ${_scopeKindChip(item)}
            <span class="wfd-scope-sub-value">${_formatTaggedValue(item)}</span>
          </div>
          ${inner}`;
      }).join('');
      const overflow = items.length > 50
        ? `<div class="wfd-scope-sub-row wfd-scope-meta">+${items.length - 50} more items…</div>`
        : '';
      return `<div class="wfd-scope-expanded-block">${rows}${overflow}</div>`;
    }
    case 'record': {
      const fields = value.fields ?? {};
      const keys = Object.keys(fields);
      if (keys.length === 0) return '<div class="wfd-scope-expanded-block"><em>empty record</em></div>';
      const rows = keys.slice(0, 50).map(k => {
        const v = fields[k];
        const vText = typeof v === 'string' ? v
          : typeof v === 'number' || typeof v === 'boolean' ? String(v)
          : JSON.stringify(v);
        const trimmed = vText.length > 200 ? vText.slice(0, 197) + '…' : vText;
        return `<div class="wfd-scope-sub-row">
          <code class="wfd-scope-sub-key">${esc(k)}</code>
          <span class="wfd-scope-sub-value">${esc(trimmed)}</span>
        </div>`;
      }).join('');
      const overflow = keys.length > 50
        ? `<div class="wfd-scope-sub-row wfd-scope-meta">+${keys.length - 50} more fields…</div>`
        : '';
      return `<div class="wfd-scope-expanded-block">${rows}${overflow}</div>`;
    }
    case 'image': {
      const src = value.base64
        ? `data:${value.mime || 'image/png'};base64,${value.base64}`
        : (value.src ?? '');
      const meta = `${value.width ?? '?'}×${value.height ?? '?'}${value.label ? ' · ' + value.label : ''}${value.sourceUrl ? ' · ' + value.sourceUrl : ''}`;
      return `<div class="wfd-scope-expanded-block">
        ${src ? `<img class="wfd-scope-expanded-image" src="${esc(src)}" alt="${esc(value.label ?? '')}" />` : '<em>(no image data)</em>'}
        <div class="wfd-scope-meta">${esc(meta)}</div>
      </div>`;
    }
    case 'section': {
      const md = String(value.markdown ?? '');
      const shown = md.length > 1000 ? md.slice(0, 1000) + '\n…' : md;
      return `<div class="wfd-scope-expanded-block">
        <pre class="wfd-scope-expanded-text">${esc(shown)}</pre>
        <div class="wfd-scope-meta">${md.length} chars${value.sourceUrl ? ' · ' + esc(value.sourceUrl) : ''}</div>
      </div>`;
    }
    case 'document': {
      const txt = String(value.content ?? '');
      const shown = txt.length > 1000 ? txt.slice(0, 1000) + '\n…' : txt;
      return `<div class="wfd-scope-expanded-block">
        <pre class="wfd-scope-expanded-text">${esc(shown)}</pre>
        <div class="wfd-scope-meta">format: ${esc(value.format ?? 'markdown')} · ${value.byteSize ?? txt.length} bytes</div>
      </div>`;
    }
    case 'element': {
      return `<div class="wfd-scope-expanded-block">
        <pre class="wfd-scope-expanded-text">${esc(JSON.stringify({ selector: value.selector, attribute: value.attribute }, null, 2))}</pre>
      </div>`;
    }
    default: {
      // Untagged or unknown — JSON-stringify with pretty indent.
      const json = (() => { try { return JSON.stringify(value, null, 2); } catch (_) { return String(value); } })();
      return `<div class="wfd-scope-expanded-block"><pre class="wfd-scope-expanded-text">${esc(json)}</pre></div>`;
    }
  }
}

// ─── Status label derivation ─────────────────────────────────────────────
function _statusLabel() {
  if (_state.outcome === 'success')   return 'completed';
  if (_state.outcome === 'failed')    return 'failed';
  if (_state.outcome === 'aborted')   return 'cancelled';
  if (!_state.invocationId)           return 'idle';
  if (_state.paused)                  return 'paused';
  return 'running';
}

// ─── Render ─────────────────────────────────────────────────────────────
function _render() {
  if (!_mountEl) return;
  const s = _state;
  const status = _statusLabel();

  // v2.74.100 — Recursive step renderer. Walks the step tree and renders
  // rows at every depth (top-level + nested control-flow bodies). Each
  // row addresses itself via a dot-notation path that matches the
  // executor's breakpoint keys, so the gutter click sends the right id.
  const stepRows = s.steps.length === 0
    ? '<div class="wfd-step"><span class="wfd-step-type">(no steps)</span></div>'
    : _renderStepTree(s.steps, '', 0);

  // Recent events — last 30, newest at top.
  const recentLog = s.log.slice(-30).reverse();
  const logRows = recentLog.length === 0
    ? '<div class="wfd-log-empty">No events yet…</div>'
    : recentLog.map(e =>
        `<div class="wfd-log-entry wfd-log-${esc(e.type ?? 'info')}">
          <span class="wfd-log-time">${esc(new Date(e.ts).toLocaleTimeString())}</span>
          <span class="wfd-log-msg">${esc(e.message ?? '')}</span>
        </div>`
      ).join('');

  // Controls switch by state. v2.74.94 — Step buttons when paused.
  // v2.74.101 — Two step variants:
  //   ⏭ Step into → advance to next step boundary at ANY depth. For a
  //                  control-flow step, descends into the first body
  //                  step. For a leaf step, same as Step over.
  //   ⏯ Step over → run the current step as a single unit (including
  //                  nested bodies for control-flow steps) and pause at
  //                  the next sibling at the SAME depth.
  let controls;
  if (s.completed) {
    controls = `<button class="btn-primary"   data-action="close"  type="button">Close</button>`;
  } else if (s.paused) {
    controls = `
      <button class="btn-primary"   data-action="resume"    type="button">▶ Resume</button>
      <button class="btn-secondary" data-action="step-into" type="button" title="Descend into the next body when the current step is control flow">⏭ Step into</button>
      <button class="btn-secondary" data-action="step-over" type="button" title="Run the current step as one unit; pause at the next sibling at the same depth">⏯ Step over</button>
      <button class="btn-secondary" data-action="cancel"    type="button">■ Cancel</button>`;
  } else if (s.invocationId) {
    controls = `
      <button class="btn-secondary" data-action="pause"  type="button">⏸ Pause</button>
      <button class="btn-secondary" data-action="cancel" type="button">■ Cancel</button>`;
  } else {
    controls = `<button class="btn-secondary" data-action="close"  type="button">Close</button>`;
  }

  _mountEl.innerHTML = `
    <div class="wfd-root">
      <div class="wfd-header">
        <div class="wfd-header-title">
          <h3 class="wfd-name" title="${esc(s.workflowName)}">${esc(s.workflowName)}</h3>
          <span class="wfd-status wfd-status-${esc(status)}">${esc(status)}</span>
        </div>
        ${s.invocationId ? `<div class="wfd-invocation">inv ${esc(String(s.invocationId).slice(0, 8))}…</div>` : ''}
      </div>

      <div class="wfd-section">
        <div class="wfd-section-head">Steps <span class="wfd-step-count">(${s.steps.length})</span></div>
        <div class="wfd-steps">${stepRows}</div>
      </div>

      <div class="wfd-section">
        <div class="wfd-section-head">Scope <span class="wfd-step-count">${Object.keys(s.scope ?? {}).length}</span></div>
        <div class="wfd-scope">${_renderScopeRows(s.scope)}</div>
      </div>

      <div class="wfd-section wfd-section-log">
        <div class="wfd-section-head">
          Events <span class="wfd-step-count">${s.log.length}</span>
          <label class="wfd-section-toggle" title="Show inner-Strategy events">
            <input type="checkbox" data-action="toggle-show-inner"${s.showInner ? ' checked' : ''} />
            inner
          </label>
        </div>
        <div class="wfd-log">${logRows}</div>
      </div>

      <div class="wfd-controls">${controls}</div>
    </div>`;

  // Wire control buttons.
  _mountEl.querySelector('[data-action="pause"]')    ?.addEventListener('click', () => _sendCtl('PAUSE_WORKFLOW'));
  _mountEl.querySelector('[data-action="resume"]')   ?.addEventListener('click', () => _sendCtl('RESUME_WORKFLOW'));
  _mountEl.querySelector('[data-action="step-into"]')?.addEventListener('click', () => _sendCtl('STEP_WORKFLOW'));
  _mountEl.querySelector('[data-action="step-over"]')?.addEventListener('click', () => _sendCtl('STEP_OVER_WORKFLOW', { stepPath: _state.currentStep ?? '' }));
  _mountEl.querySelector('[data-action="cancel"]')   ?.addEventListener('click', () => _sendCtl('CANCEL_WORKFLOW'));
  _mountEl.querySelector('[data-action="close"]')    ?.addEventListener('click', () => { try { exitToStudio(); } catch (_) { /* swallow */ } });

  // v2.74.95 — Breakpoint gutter clicks. Delegated on the steps container
  // so we don't have to re-bind per render. Sends TOGGLE_BREAKPOINT_WORKFLOW;
  // the background broadcasts WORKFLOW_BREAKPOINTS which our listener
  // picks up and triggers a re-render with the flipped indicator.
  _mountEl.querySelectorAll('[data-action="toggle-breakpoint"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const stepPath = btn.dataset.stepPath;
      if (!stepPath) return;
      // v2.74.99 — Address by invocationId when a run is in flight,
      // otherwise by workflowId (pre-invocation toggle that mutates
      // persisted storage). Either path broadcasts a WORKFLOW_BREAKPOINTS
      // that the listener above filters on either id.
      // v2.74.100 — Payload now carries stepPath instead of stepIndex.
      // v2.74.118 — After a run completes, _state.invocationId stays set
      // but background may have GC'd that invocation record. Toggling by
      // invocationId would fail to round-trip to persistent storage.
      // Prefer workflowId once we've reached a terminal state so the
      // toggle lands in the right keyspace.
      const completed = _state.completed;
      const body = (_state.invocationId && !completed)
        ? { invocationId: _state.invocationId, stepPath }
        : _state.workflowId
          ? { workflowId: _state.workflowId, stepPath }
          : null;
      if (!body) return;
      try {
        chrome.runtime.sendMessage(
          { type: 'TOGGLE_BREAKPOINT_WORKFLOW', payload: body },
          () => { void chrome.runtime.lastError; /* ignore */ }
        );
      } catch (err) {
        toast(`Breakpoint toggle failed: ${err?.message ?? err}`, 'err');
      }
    });
  });

  // v2.74.96 — Scope row expand-toggle. Mutates the local expandedScope
  // Set + rerenders; no background round-trip needed (this is pure UI
  // state). Stop event propagation so a future row-level click won't
  // double-fire when we wire something to .wfd-scope-row.
  _mountEl.querySelectorAll('[data-action="toggle-scope-expand"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // v2.74.102 — Path-keyed expansion. Top-level rows use the
      // binding name; sub-rows use `${name}.${idx}`, recursive deeper.
      const path = btn.dataset.path;
      if (!path) return;
      if (_state.expandedScope.has(path)) _state.expandedScope.delete(path);
      else                                _state.expandedScope.add(path);
      _render();
    });
  });

  // v2.74.97 — Inner-Workflow trace toggle. Flips the showInner flag and
  // rerenders. Past events stay where they are (filtered or shown) —
  // toggling reveals new events from now on.
  const innerToggle = _mountEl.querySelector('[data-action="toggle-show-inner"]');
  if (innerToggle) {
    innerToggle.addEventListener('change', () => {
      _state.showInner = !!innerToggle.checked;
      _render();
    });
  }
}

function _sendCtl(type, extra) {
  if (!_state.invocationId) return;
  try {
    chrome.runtime.sendMessage(
      { type, payload: { invocationId: _state.invocationId, ...(extra ?? {}) } },
      () => { void chrome.runtime.lastError; /* ignore */ }
    );
  } catch (err) {
    toast(`${type} failed: ${err?.message ?? err}`, 'err');
  }
}

// ─── Event ingestion ─────────────────────────────────────────────────────
function _pushLog(type, message) {
  _state.log.push({ ts: Date.now(), type, message });
  if (_state.log.length > LOG_CAP) _state.log.shift();
}

function _onProgress(event) {
  if (!event) return;
  // v2.74.97 — Inner-Workflow events are filtered by default; the toggle
  // in the Events section header flips _state.showInner to surface them.
  // Logged with a distinct "inner" prefix so they don't blur with
  // Strategy-tier events when the toggle is on.
  if (event.fromInnerWorkflow) {
    if (_state.showInner) {
      _pushLog('info', `[inner] ${event.message ?? event.type ?? '(event)'}`);
      _render();
    }
    return;
  }

  // v2.74.100 — Resolve event to its dot-path. Events from the new
  // executor (this build) carry both stepIndex AND stepPath; events from
  // the inner Workflow runtime only have stepIndex. We prefer stepPath
  // when present; fall back to String(stepIndex) for back-compat.
  const evPath = typeof event.stepPath === 'string'
    ? event.stepPath
    : (Number.isFinite(event.stepIndex) ? String(event.stepIndex) : null);

  switch (event.type) {
    case 'strategy_start':
      _pushLog('info', event.message ?? 'started');
      break;
    case 'strategy_step_start':
      _state.currentStep = evPath;
      _pushLog('info', event.message ?? `step ${(event.stepIndex ?? 0) + 1} start`);
      break;
    case 'strategy_step_done':
      if (evPath != null) {
        _state.resultByPath[evPath] = {
          success: event.success,
          error: event.error,
        };
        delete _state.controlState[evPath];
      }
      _pushLog(event.success === false ? 'err' : 'info',
        event.message ?? `step ${(event.stepIndex ?? 0) + 1} done`);
      break;
    case 'strategy_step_skipped':
      if (evPath != null) {
        _state.resultByPath[evPath] = {
          success: false,
          skipped: true,
          error: event.error ?? null,
        };
      }
      _pushLog('warn', event.message ?? `step ${(event.stepIndex ?? 0) + 1} skipped`);
      break;
    case 'strategy_paused':
      _state.paused = true;
      _pushLog('warn', event.message ?? 'paused');
      break;
    case 'strategy_resumed':
      _state.paused = false;
      _pushLog('info', event.message ?? 'resumed');
      break;
    case 'strategy_foreach_iter':
      // Track iteration count for inline pill. v2.74.100 — path-keyed.
      if (evPath != null) {
        _state.controlState[evPath] = {
          kind  : 'foreach',
          iter  : (event.iter ?? -1) + 1,
          total : event.total ?? null,
        };
      }
      _pushLog('info', event.message ?? event.type);
      break;
    case 'strategy_loop_iter':
      if (evPath != null) {
        _state.controlState[evPath] = { kind: 'loop', iter: event.iter ?? null };
      }
      _pushLog('info', event.message ?? event.type);
      break;
    case 'strategy_detect_branch':
      if (evPath != null) {
        _state.controlState[evPath] = { kind: 'detect', branch: (event.branch ?? -1) + 1 };
      }
      _pushLog('info', event.message ?? event.type);
      break;
    case 'strategy_detect_default':
      if (evPath != null) {
        _state.controlState[evPath] = { kind: 'detect', branch: 'default' };
      }
      _pushLog('info', event.message ?? event.type);
      break;
    case 'strategy_try_recover':
      if (evPath != null) {
        _state.controlState[evPath] = { kind: 'try', inRecovery: true };
      }
      _pushLog('warn', event.message ?? event.type);
      break;
    case 'strategy_scope_snapshot':
      // v2.74.93 — Live scope update. Overwrites the local map; no log
      // entry (would spam since one fires per step).
      if (event.snapshot && typeof event.snapshot === 'object') {
        _state.scope = event.snapshot;
        // v2.74.103 — Prune orphan expansion entries. When upstream steps
        // overwrite or remove a binding, any sub-path under it becomes
        // stale; cleaning up here keeps the Set bounded across long runs.
        _pruneExpandedScope();
      }
      break;
    case 'strategy_breakpoint_hit':
      // v2.74.95 — Surface breakpoint hits in the log so the user sees
      // *why* execution paused (vs. an explicit Pause click).
      // v2.74.100 — Message now identifies the step by path.
      // v2.74.118 — Flip paused state inline. The executor calls
      // requestPause() right after the breakpoint hit, which eventually
      // emits WORKFLOW_PAUSE_STATE — but there's a small window where the
      // breakpoint_hit event has arrived and the pause-state event hasn't
      // yet. Setting paused here closes that window so the status pill
      // and control buttons reflect the new state on the same render
      // that surfaces the breakpoint message.
      _state.paused = true;
      _pushLog('warn', event.message ?? `breakpoint hit at step ${evPath ?? (event.stepIndex + 1)}`);
      break;
    case 'strategy_done':
      _state.completed = true;
      _state.outcome = 'success';
      _state.paused = false;
      _pushLog('info', event.message ?? 'completed');
      break;
    case 'strategy_failed':
      _state.completed = true;
      _state.outcome = event.message?.toLowerCase().includes('aborted') ? 'aborted' : 'failed';
      _state.paused = false;
      _pushLog('err', event.message ?? 'failed');
      break;
    default:
      // Unknown event type — log with the raw type so authors can see
      // what's coming through. Useful while the executor's event vocab
      // is still evolving.
      _pushLog('info', `${event.type}: ${event.message ?? ''}`);
  }
  _render();
}

// ─── Lifecycle ──────────────────────────────────────────────────────────
async function mount(payload, mountEl) {
  _mountEl = mountEl;
  _state = {
    invocationId : payload?.invocationId ?? null,
    workflowId   : payload?.workflowId   ?? null,
    workflowName : payload?.workflowName ?? 'Workflow',
    steps        : Array.isArray(payload?.steps) ? payload.steps : [],
    paused       : false,
    completed    : false,
    outcome      : null,
    currentStep  : null,
    resultByPath : {},
    log          : [],
    scope        : {},
    breakpoints  : new Set(),
    expandedScope: new Set(),
    controlState : {},
    showInner    : false,
  };

  // v2.74.124 — Mount re-entry guard. If mount() is called twice without
  // unmount, the prior _runtimeListener reference is overwritten by the
  // new closure; the prior listener stays registered with chrome.runtime
  // and never gets removed (unmount uses _runtimeListener which by then
  // points at the new one). Every message would fire both listeners,
  // duplicating state updates. Same defensive pattern as strategy-debug
  // v2.74.123. Shell currently enforces mount/unmount pairing, but cheap
  // to guard.
  if (_runtimeListener) {
    try { chrome.runtime.onMessage.removeListener(_runtimeListener); } catch {}
    _runtimeListener = null;
  }

  // Subscribe to runtime broadcasts. WORKFLOW_PROGRESS carries step-level
  // events; WORKFLOW_PAUSE_STATE flips the paused flag. Filter by
  // invocationId so a different tab's run can't fight for this UI.
  _runtimeListener = (msg) => {
    if (msg?.type === 'WORKFLOW_PROGRESS') {
      const { invocationId, event } = msg.payload ?? {};
      // First event for a fresh mount: snapshot the invocationId so
      // subsequent filtering works.
      if (!_state.invocationId && invocationId) _state.invocationId = invocationId;
      if (invocationId && invocationId !== _state.invocationId) return;
      _onProgress(event);
    } else if (msg?.type === 'WORKFLOW_PAUSE_STATE') {
      const { invocationId, paused } = msg.payload ?? {};
      if (invocationId && invocationId !== _state.invocationId) return;
      _state.paused = !!paused;
      _render();
    } else if (msg?.type === 'WORKFLOW_BREAKPOINTS') {
      // v2.74.95 — Breakpoint set updated. Replace the local mirror and
      // rerender so step rows refresh their gutter indicators.
      // v2.74.99 — Filter by EITHER invocationId or workflowId:
      //   - Post-invocation broadcasts carry both; match on either.
      //   - Pre-invocation broadcasts (from workflowId-only toggles)
      //     carry workflowId only; match against payload workflowId.
      const { invocationId, workflowId, breakpoints } = msg.payload ?? {};
      const matchesInv = invocationId && _state.invocationId && invocationId === _state.invocationId;
      const matchesWf  = workflowId   && _state.workflowId   && workflowId   === _state.workflowId;
      if (!matchesInv && !matchesWf) return;
      _state.breakpoints = new Set(Array.isArray(breakpoints) ? breakpoints : []);
      _render();
    }
  };
  chrome.runtime.onMessage.addListener(_runtimeListener);

  _render();

  // v2.74.99 — Fetch persisted breakpoints so gutter dots paint at mount
  // time (before the user clicks Run). Best-effort — failure leaves the
  // step list breakpoint-free, which the invocation will populate when
  // it starts.
  if (_state.workflowId) {
    try {
      chrome.runtime.sendMessage(
        { type: 'GET_WORKFLOW_BREAKPOINTS', payload: { workflowId: _state.workflowId } },
        (resp) => {
          void chrome.runtime.lastError;
          if (resp?.success && Array.isArray(resp.breakpoints)) {
            _state.breakpoints = new Set(resp.breakpoints);
            _render();
          }
        }
      );
    } catch (_) { /* ignore */ }
  }
}

async function unmount() {
  if (_runtimeListener) {
    chrome.runtime.onMessage.removeListener(_runtimeListener);
    _runtimeListener = null;
  }
  if (_mountEl) _mountEl.innerHTML = '';
  _mountEl = null;
}

// Optional getState — if the user switches tabs and comes back, restore
// the in-progress view rather than wiping it. The shell's snapshot system
// (v2.74.36 / .58) handles persistence; we just hand over our state map.
function getState() {
  return { ..._state };
}

// v2.74.147 — Sticky-mode release hook. Shell.js checks isSticky?.()
// before STICKY_MODES set membership.
// v2.74.191 — Stay sticky after completion. The user explicitly asked
// for manual-close-only behavior so the post-run state (log, step
// outcomes, error reasons) stays visible until they hit Close. We
// still release stickiness when the mode hasn't attached to any
// invocation yet (cold mount, no invocationId) so it can't trap the
// panel in that edge case.
function isSticky() {
  if (_state?.invocationId == null) return false;
  return true;
}

export default {
  name: 'workflow-debug',
  mount,
  unmount,
  getState,
  isSticky,
};
