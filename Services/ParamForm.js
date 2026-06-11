/**
 * @file Services/ParamForm.js
 * @module ParamForm
 *
 * Shared invocation-time parameter collection UI. Renders one control per
 * normalized strategy param and resolves with a values dictionary on submit.
 *
 * ─── Why it lives in Services ─────────────────────────────────────────────
 *
 * Two surfaces collect strategy params today (chat.js `runTaskCapability`
 * for direct task invocation, `_promptForMissingParams` for routed Strategy
 * calls), and Studio's invocation flow needs the same logic. Before typed
 * inputs landed (v2.74.64) each surface rolled its own `<input type="text">`
 * loop. Adding number/boolean/file controls to three places independently
 * would be a maintenance trap, so the form is now a single module.
 *
 * ─── Input shape (canonical from `normalizeStrategyParams`) ──────────────
 *
 *   { name, kind, type, required, accept?, parse?, default? }
 *
 *   type='string'  → <input type="text">
 *   type='number'  → <input type="number" inputmode="decimal">
 *   type='boolean' → <input type="checkbox">
 *   type='file'    → <input type="file" accept={accept}>
 *
 * ─── Output shape ─────────────────────────────────────────────────────────
 *
 * The promise resolves with `{ [paramName]: value | null }` on submit
 * (only collected params are present), or `null` on cancel. Per-type:
 *
 *   string  → string (trimmed, may be empty for non-required)
 *   number  → number (Number(); NaN means user left it empty)
 *   boolean → boolean (checkbox.checked)
 *   file    → { filename, mimeType, sizeBytes, dataUrl } | null
 *             dataUrl is universal (binary-safe via base64) so callers
 *             can stash, ship to background, or hand to a parser.
 *
 * Callers downstream are responsible for parsing file dataUrls into
 * scope-tagged bindings; this module is collection-only.
 *
 * ─── Two factories ────────────────────────────────────────────────────────
 *
 *   createParamForm(params, options) → { element, promise }
 *     Caller appends `element` where it wants (e.g. as a chat message).
 *     The promise resolves when the form's Run / Cancel is clicked.
 *
 *   promptForParams(params, options) → Promise<values | null>
 *     Convenience: builds a modal overlay, appends to document.body,
 *     auto-cleans up on settle.
 *
 * ─── Options ──────────────────────────────────────────────────────────────
 *
 *   title       — Heading text (e.g. capability name)
 *   hint        — Short subtitle under the title
 *   submitLabel — Defaults to 'Run'
 *   cancelLabel — Defaults to 'Cancel'
 *   prefilled   — Map of name → value used to seed inputs
 *   variant     — 'inline' | 'modal'   (purely cosmetic — picks CSS class
 *                                       prefix: .param-form-* vs .param-modal-*)
 */

// ─── HTML escape (kept local to avoid cross-module import for a 1-liner) ────
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ─── File-size cap ─────────────────────────────────────────────────────────
//
// File values flow as base64-encoded dataUrls through chrome.runtime.sendMessage
// to the background service worker, then into Scope. MV3's structured-clone
// path technically allows large strings, but anything over ~50 MB starts
// triggering OOM or timeout failures in practice — and a runaway upload locks
// up the SW (and any other pending invocations) until it finishes.
//
// 10 MB is the conservative default; it covers virtually every real document
// (text/csv/docx/xlsx) and most images. Authors who genuinely need bigger can
// override per-param via `maxBytes` (added to the param descriptor by
// normalizeStrategyParams when a strategy declares it).
//
// Cap is checked BEFORE FileReader runs so we fail fast — no point burning
// time + memory reading a file we're about to reject.
const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ─── File → dataUrl (binary-safe, base64) ──────────────────────────────────
//
// FileReader.readAsDataURL handles arbitrary binary types correctly. We use
// it (rather than readAsArrayBuffer) so file values can flow through
// chrome.runtime.sendMessage without ArrayBuffer-loss (sendMessage
// structured-clones, which IS ArrayBuffer-safe, but every consumer would
// then need its own base64/text decoder; a single dataUrl is simpler).
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload  = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('Read failed'));
    fr.readAsDataURL(file);
  });
}

// ─── Per-param control HTML ────────────────────────────────────────────────
function renderField(param, cls, prefilled) {
  // v2.74.890 — Normalize the name to a string up front. Legacy capabilities
  // can deliver a param whose `name` is itself an object (when object param
  // descriptors leak through the EXTRACT_STRATEGY_PARAMS boundary); the old
  // `param.name.replace(...)` then threw "replace is not a function" and took
  // down the whole missing-param prompt. Deriving every name-keyed bit of
  // markup from `pname` keeps the form renderable no matter what slips in.
  const pname = String(param && param.name != null ? param.name : '');
  const id = `pf-${pname}`;
  const required = param.required ? ' aria-required="true"' : '';
  const seedVal = prefilled[pname];

  // Common label markup
  const label = `<label class="${cls}-label" for="${esc(id)}">${esc(pname)}${param.required ? ' <span class="' + cls + '-req">*</span>' : ''}</label>`;

  // Per-type control
  let control = '';
  const hint = pname.replace(/_/g, ' ').toLowerCase();

  // v2.74.68 — list-kind STRING params render as a one-per-line textarea
  // (Studio's historical UI for list inputs). Submit time splits on newlines.
  // Other type+list combos aren't useful yet — engine only seeds list<scalar>.
  // File/number/boolean lists fall through to their scalar control.
  if (param.kind === 'list' && param.type === 'string') {
    const seedText = Array.isArray(seedVal) ? seedVal.join('\n') : (typeof seedVal === 'string' ? seedVal : '');
    control = `
      <textarea id="${esc(id)}" class="${cls}-input ${cls}-input-list" rows="5"
                data-param="${esc(pname)}" data-type="string" data-kind="list"
                placeholder="${esc(hint)}&#10;${esc(hint)}&#10;…"${required}>${esc(seedText)}</textarea>
      <span class="${cls}-list-hint">one value per line</span>`;
    return `
      <div class="${cls}-field">
        ${label}
        ${control}
      </div>`;
  }

  if (param.type === 'boolean') {
    const checked = (seedVal === true || seedVal === 'true') ? ' checked' : (param.default === true ? ' checked' : '');
    control = `<input type="checkbox" id="${esc(id)}" class="${cls}-input ${cls}-input-checkbox" data-param="${esc(pname)}" data-type="boolean"${checked}${required} />`;
  }
  else if (param.type === 'number') {
    const val = (seedVal !== undefined && seedVal !== null)
      ? esc(seedVal)
      : (Number.isFinite(param.default) ? esc(param.default) : '');
    control = `<input type="number" id="${esc(id)}" class="${cls}-input" data-param="${esc(pname)}" data-type="number" inputmode="decimal" value="${val}" placeholder="${esc(hint)}"${required} />`;
  }
  else if (param.type === 'file') {
    const accept = param.accept ? ` accept="${esc(param.accept)}"` : '';
    const acceptHint = param.accept ? `<span class="${cls}-file-accept">${esc(param.accept)}</span>` : '';
    control = `
      <input type="file" id="${esc(id)}" class="${cls}-input ${cls}-input-file" data-param="${esc(pname)}" data-type="file"${accept}${required} />
      ${acceptHint}`;
  }
  else { // 'string' (default)
    const val = (seedVal !== undefined && seedVal !== null && seedVal !== '')
      ? esc(seedVal)
      : (typeof param.default === 'string' ? esc(param.default) : '');
    control = `<input type="text" id="${esc(id)}" class="${cls}-input" data-param="${esc(pname)}" data-type="string" value="${val}" placeholder="${esc(hint)}"${required} />`;
  }

  // Layout differs for checkbox (control before label reads better) —
  // everything else stacks label-over-control.
  if (param.type === 'boolean') {
    return `
      <div class="${cls}-field ${cls}-field-checkbox">
        ${control}
        ${label}
      </div>`;
  }
  return `
    <div class="${cls}-field">
      ${label}
      ${control}
    </div>`;
}

// ─── Read submitted values out of the form ─────────────────────────────────
async function collectValues(root, params) {
  const out = {};
  for (const param of params) {
    const ctrl = root.querySelector(`[data-param="${CSS.escape(param.name)}"]`);
    if (!ctrl) continue;

    // v2.74.68 — list-kind STRING textarea: split on newlines, trim, drop
    // empties. Don't dedupe — the user might intentionally want repeated
    // values. Engine's scope seeding wraps each item as scalar(string).
    if (ctrl.dataset.kind === 'list') {
      const lines = String(ctrl.value || '').split('\n').map(s => s.trim()).filter(Boolean);
      out[param.name] = lines;
      continue;
    }

    if (param.type === 'boolean') {
      out[param.name] = !!ctrl.checked;
    }
    else if (param.type === 'number') {
      const raw = ctrl.value.trim();
      out[param.name] = raw === '' ? null : Number(raw);
    }
    else if (param.type === 'file') {
      const file = ctrl.files && ctrl.files[0];
      if (!file) { out[param.name] = null; continue; }

      // Size cap — fail before FileReader runs.
      const cap = Number.isFinite(param.maxBytes) ? param.maxBytes : DEFAULT_MAX_FILE_BYTES;
      if (file.size > cap) {
        throw new Error(`${param.name}: "${file.name}" is ${formatBytes(file.size)} — exceeds the ${formatBytes(cap)} limit.`);
      }

      const dataUrl = await readFileAsDataUrl(file);
      out[param.name] = {
        filename:  file.name,
        mimeType:  file.type || '',
        sizeBytes: file.size,
        dataUrl,
      };
    }
    else { // string
      out[param.name] = ctrl.value.trim();
    }
  }
  return out;
}

// ─── Validate before resolving ─────────────────────────────────────────────
//
// "Required" means: the field must produce a non-empty/non-null value
//   string  → trimmed length > 0
//   number  → Number.isFinite
//   boolean → no validation (checkboxes always produce a boolean; "required
//             boolean" semantically means "must be checked", but invocation
//             time would rarely use that — left permissive)
//   file    → a File was selected
//
// Returns array of param names that failed validation (empty = OK).
function findMissing(values, params) {
  const missing = [];
  for (const p of params) {
    if (!p.required) continue;
    const v = values[p.name];
    // v2.74.68 — list-kind string: require non-empty array (the textarea
    // produced [] when every line was blank).
    if (p.kind === 'list' && p.type === 'string') {
      if (!Array.isArray(v) || v.length === 0) missing.push(p.name);
      continue;
    }
    if (p.type === 'string' && (typeof v !== 'string' || v.length === 0)) missing.push(p.name);
    else if (p.type === 'number' && !Number.isFinite(v))                  missing.push(p.name);
    else if (p.type === 'file' && !v)                                     missing.push(p.name);
    // boolean: always defined — skip
  }
  return missing;
}

// ─── Public API: createParamForm — caller-managed lifecycle ────────────────
/**
 * Build a parameter form. The returned element is unmounted (not yet in
 * the DOM); the caller appends it where appropriate.
 *
 * @param {Array<Object>} params - canonical normalizeStrategyParams shape
 * @param {Object}        [options]
 * @param {string}        [options.title]
 * @param {string}        [options.hint]
 * @param {string}        [options.submitLabel='Run']
 * @param {string}        [options.cancelLabel='Cancel']
 * @param {Object}        [options.prefilled={}]
 * @param {'inline'|'modal'} [options.variant='inline']
 * @returns {{ element: HTMLElement, promise: Promise<Object|null> }}
 */
export function createParamForm(params, options = {}) {
  const {
    title       = '',
    hint        = '',
    submitLabel = 'Run',
    cancelLabel = 'Cancel',
    prefilled   = {},
    variant     = 'inline',
  } = options;

  // CSS class prefix: 'param-form' for inline (chat conversation), 'param-modal' for modal.
  // This keeps existing stylesheet rules working without invasive renames.
  const cls = variant === 'modal' ? 'param-modal' : 'param-form';

  const root = document.createElement('div');
  root.className = cls;
  root.innerHTML = `
    ${title ? `<div class="${cls}-title">${esc(title)}</div>` : ''}
    ${hint  ? `<div class="${cls}-hint">${esc(hint)}</div>`   : ''}
    <div class="${cls}-fields">
      ${params.map(p => renderField(p, cls, prefilled)).join('')}
    </div>
    <div class="${cls}-actions">
      <button type="button" class="btn-secondary" data-action="cancel">${esc(cancelLabel)}</button>
      <button type="button" class="btn-primary"   data-action="submit">${esc(submitLabel)}</button>
    </div>
    <div class="${cls}-error" hidden></div>`;

  let settle; // resolver shared by submit/cancel paths
  const promise = new Promise((resolve) => { settle = resolve; });

  const setError = (msg) => {
    const el = root.querySelector(`.${cls}-error`);
    if (!el) return;
    if (!msg) { el.hidden = true; el.textContent = ''; return; }
    el.hidden = false;
    el.textContent = msg;
  };

  // v2.74.110 — Reentrant submit guard. onSubmit is async; between
  // `await collectValues(...)` (which awaits per-file FileReader) and the
  // eventual settle(values), the Submit button stays enabled. A user
  // clicking again — or pressing Enter via the keydown handler below —
  // used to fire a second onSubmit in parallel, double-reading every file
  // input. The Promise is settle-once so no correctness bug, but the
  // wasted FileReader pass on a 10MB upload is real.
  const submitBtn = root.querySelector('[data-action="submit"]');
  let isSubmitting = false;
  const onSubmit = async () => {
    if (isSubmitting) return;
    isSubmitting = true;
    submitBtn.disabled = true;
    try {
      setError('');
      let values;
      try {
        values = await collectValues(root, params);
      } catch (err) {
        setError(`Couldn't read input: ${err?.message || err}`);
        return;
      }
      const missing = findMissing(values, params);
      if (missing.length) {
        setError(`Required: ${missing.join(', ')}`);
        return;
      }
      settle(values);
    } finally {
      // Re-enable for the validation-failed path — caller can edit and
      // retry. The success path settles the promise; downstream cleanup
      // will unmount the form anyway, so the re-enable is harmless.
      isSubmitting = false;
      submitBtn.disabled = false;
    }
  };

  submitBtn.addEventListener('click', onSubmit);
  root.querySelector('[data-action="cancel"]').addEventListener('click', () => settle(null));

  // Enter on a non-textarea field submits. (We have no textareas today, but
  // keeping the guard means future file-description fields won't trap users.)
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'textarea') return;
    e.preventDefault();
    onSubmit();
  });

  // Focus the first non-checkbox control for natural keyboard flow.
  // Defer to next tick so caller has time to insert the element.
  queueMicrotask(() => {
    const first = root.querySelector(`.${cls}-input:not([type="checkbox"])`)
               || root.querySelector(`.${cls}-input`);
    first?.focus();
  });

  return { element: root, promise };
}

// ─── Public API: promptForParams — modal convenience ───────────────────────
/**
 * Show a modal that collects parameters. Resolves on Run / Cancel / Escape.
 *
 * @param {Array<Object>} params - canonical shape
 * @param {Object} [options] - same as createParamForm; variant forced to 'modal'
 * @returns {Promise<Object|null>}
 */
export function promptForParams(params, options = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'param-modal-overlay';

  const { element, promise } = createParamForm(params, { ...options, variant: 'modal' });
  overlay.appendChild(element);

  // v2.74.110 — Cancel helper. Mirrors the user clicking Cancel: clicking
  // the form's own button drives the createParamForm settler, so both
  // backdrop-click and Escape converge on the same dismiss path.
  const cancel = () => element.querySelector('[data-action="cancel"]')?.click();

  // v2.74.110 — Escape cancels. Previously bound on the overlay, which
  // only received keydown events when the overlay (or a descendant) had
  // focus. If the user tabbed out of the form or clicked somewhere outside
  // it (the running bar, history button), Escape silently stopped working.
  // Document-level binding catches the key regardless of focus state; the
  // `document.body.contains(overlay)` guard ensures we ignore stray Escape
  // presses after the modal is gone (e.g. during the .then teardown
  // microtask).
  const onKey = (e) => {
    if (e.key === 'Escape' && document.body.contains(overlay)) {
      cancel();
    }
  };
  document.addEventListener('keydown', onKey);

  // v2.74.110 — Backdrop click also cancels. Filter by `e.target === overlay`
  // so clicks inside the form (which bubble through but originate on a
  // descendant) don't dismiss the modal mid-typing. Matches the convention
  // most chat / settings modals use today.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) cancel();
  });

  document.body.appendChild(overlay);

  // Tear down the overlay once the form settles either way.
  return promise.then((values) => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    return values;
  });
}
