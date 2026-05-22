/**
 * @file Services/StrategyTree.js
 * @description Data model for Strategy bodies in Pass E2 (FOREACH iteration).
 *
 * ─── Shape evolution ───────────────────────────────────────────────────────
 *
 * Strategies historically had a flat `fragmentSteps: []` array of Fragment
 * invocations. Pass E2 introduces FOREACH which needs nesting. Rather than
 * renaming the field (52 call sites in the codebase), the ARRAY CONTENTS
 * became a tree-admitting shape: nodes are tagged by `type`, and FOREACH
 * nodes carry a nested `body` array of child nodes.
 *
 * ─── Node types ────────────────────────────────────────────────────────────
 *
 *   // Fragment invocation — what today's linear step is.
 *   // Legacy entries without a `type` field default to 'fragment'.
 *   {
 *     type?: 'fragment',     // optional for legacy compat; normalize fills it in
 *     fragmentId: string,
 *     paramBindings: { [paramName]: Binding }
 *   }
 *
 *   // Iterate a list binding from Scope, running body once per item.
 *   // `over` names a binding previously populated by ENUMERATE.
 *   // `as` names the iteration variable available to the body.
 *   {
 *     type: 'foreach',
 *     over: string,          // e.g. "JOBS"
 *     as: string,            // e.g. "JOB"
 *     body: Node[]
 *   }
 *
 *   // Pause execution — either for a fixed duration or until a condition
 *   // holds. Leaf node (no children). Added in Pass G1 to let authors give
 *   // SPAs breathing room between actions without relying on post-check
 *   // retry alone.
 *   //
 *   // Duration form:
 *   {
 *     type: 'wait',
 *     mode: 'duration',
 *     durationMs: number     // e.g. 500
 *   }
 *   //
 *   // Condition form — polls up to timeoutMs, fails if still not met.
 *   // The `condition` object uses the same shape as Fragment pre/post
 *   // conditions so the engine hands it straight to checkConditions().
 *   {
 *     type: 'wait',
 *     mode: 'condition',
 *     condition: {
 *       type: 'selector_present' | 'selector_absent' | 'url_matches' | 'text_present',
 *       selector?: string,   // for selector_present / selector_absent
 *       pattern?:  string,   // for url_matches
 *       text?:     string    // for text_present
 *     },
 *     timeoutMs: number,     // e.g. 5000
 *     pollIntervalMs: number // e.g. 100
 *   }
 *
 *   // Multi-way conditional (Pass G2). Evaluates each branch's condition
 *   // in order; the first branch whose condition holds executes. If no
 *   // branch matches, the `default` body runs. Branches are one-shot
 *   // evaluated — use a WAIT beforehand if a condition needs time to
 *   // stabilize.
 *   //
 *   // "IF X THEN Y" is a single-branch detect with empty default.
 *   // "IF X THEN Y ELSE Z" is a single-branch detect with non-empty default.
 *   //
 *   // Conditions reuse the WAIT vocabulary (selector_present/_absent,
 *   // url_matches, text_present) so the engine can evaluate them via
 *   // checkConditions({timeoutMs: 0}).
 *   {
 *     type: 'detect',
 *     branches: [
 *       { condition: { type, selector|pattern|text }, body: Node[] },
 *       ...
 *     ],
 *     default: Node[]   // runs if no branch matched; may be empty []
 *   }
 *
 *   // Condition-assertiond loop (Pass H1). Test-first ("while") semantics:
 *   // evaluates condition before each iteration; if true, runs body; if
 *   // false, exits. Safety-capped by maxIterations to prevent runaway
 *   // loops from authoring mistakes (bad condition, page that never
 *   // changes state). Hitting the cap FAILS the strategy loudly rather
 *   // than silently exiting.
 *   //
 *   // Scope-transparent: iteration variables from enclosing FOREACHes
 *   // remain visible inside the body. LOOP doesn't introduce its own
 *   // iteration variable — it's a count-agnostic loop.
 *   //
 *   // Typical use: pagination ("while next-page button enabled, click it,
 *   // scrape results"), retry-with-backoff, scroll-until-bottom.
 *   {
 *     type: 'loop',
 *     condition: { type, selector|pattern|text },
 *     body: Node[],
 *     maxIterations: number   // default 100; fail if exceeded
 *   }
 *
 *   // Try/recover (Pass H2). Runs body; if any body node fails, runs
 *   // recover. TRY succeeds iff recover succeeds. Empty recover = swallow
 *   // the failure. Aborts never trigger recover.
 *   {
 *     type: 'try',
 *     body: Node[],
 *     recover: Node[]   // may be empty [] — empty swallows failure
 *   }
 *
 *   // Run-in-new-tab (Pass J2). `trigger` runs on the outer tab and is
 *   // expected to open exactly one new tab as a side effect (typically a
 *   // CLICK on a link with target=_blank or a button whose handler calls
 *   // window.open). The engine detects the new tab via chrome.tabs.onCreated
 *   // filtered by openerTabId, waits for it to finish loading, then runs
 *   // `body` with the new tab as the active execution target. On body
 *   // completion (success OR failure), the new tab is closed (unless
 *   // closeOnExit is false) and execution returns to the outer tab.
 *   //
 *   // Scope-transparent: bindings written in body are available on the
 *   // outer tab after return.
 *   //
 *   // Strict failure when no tab opens: if trigger runs but no new tab
 *   // appears within a short timeout, the node fails loudly. Wrap in TRY
 *   // if the author wants graceful degradation.
 *   {
 *     type: 'in_new_tab',
 *     trigger: Node,              // the action that opens the tab
 *     body: Node[],               // runs on the newly-opened tab
 *     closeOnExit: boolean        // default true
 *   }
 *
 *   // Navigate (Pass H3). Drives the browser tab. Three modes:
 *   //   url    — go to a specific URL (URL may be a literal string or a
 *   //            binding object: strategy_param / iteration_variable).
 *   //   back   — browser back (no URL needed).
 *   //   reload — reload current tab (no URL needed).
 *   //
 *   // Always waits for tab load status = complete, with a 10s internal
 *   // timeout. Fire-and-forget would race subsequent selectors; if a page
 *   // legitimately needs longer, the author adds a WAIT after.
 *   //
 *   // NAVIGATE does not alter the ground-URL contract. Fragments that
 *   // require ground-URL context will fail their preconditions loudly if
 *   // you've navigated somewhere incompatible.
 *   {
 *     type: 'navigate',
 *     mode: 'url' | 'back' | 'reload',
 *     url?: string | { kind: 'literal'|'strategy_param'|'iteration_variable', ... }
 *       // url is required for mode='url', ignored for 'back'|'reload'
 *   }
 *
 *   // Scroll (v2.71.0). Selectorless strategy-level scroll. v1 = mode 'by'
 *   // with signed viewport distance. Smooth scrolls the window over ~500ms.
 *   // Mirrors NAVIGATE in being tab-level / selectorless. Used inside LOOP
 *   // for infinite-feed patterns (scroll, wait, check exit condition).
 *   //
 *   // domChanged false is acceptable (matches SCROLL_TO action's exemption);
 *   // pure scrolls without lazy-load don't mutate the DOM.
 *   {
 *     type: 'scroll',
 *     mode: 'by',
 *     distance: { kind: 'literal', value: '1.0' }
 *           | { kind: 'strategy_param', name: 'AMOUNT' }
 *           | { kind: 'iteration_variable', name: 'PAGE' }
 *       // signed viewport count: +1.0 = one screen down, -0.5 = half up.
 *   }
 *
 *   // v2.72.3 (Pass 4) — Observation node. References an authored Observation
 *   // by id. Reads page state into scope. The Observation record (in
 *   // StorageManager) carries shape (scalar/raw_text/raw_html/list_of_records),
 *   // target selector, fields, and pre/post. The node here is mostly a pointer
 *   // plus paramBindings reserved for future param substitution.
 *   {
 *     type: 'observation',
 *     observationId: 'obs_xxx',
 *     paramBindings: {}    // future: { PARAM_NAME: { kind, value/name }, ... }
 *   }
 *
 * ─── Binding kinds ─────────────────────────────────────────────────────────
 *
 * Params on a fragment step's paramBindings take one of three shapes in E2:
 *
 *   { kind: 'literal',           value: string }
 *   { kind: 'strategy_param',    name:  string }    // input or EXTRACTed
 *   { kind: 'iteration_variable', name: string }    // from enclosing FOREACH
 *
 * The iteration_variable kind is new in E2 and only valid if the binding
 * appears inside a FOREACH body whose `as` matches `name`.
 *
 * ─── Backward compatibility ───────────────────────────────────────────────
 *
 * `normalizeStrategyBody` converts legacy `fragmentSteps` array entries
 * (no type field) into the E2 shape. Always call this on a read path
 * before handing to engine or UI — keeps downstream code from having to
 * handle the legacy case.
 *
 * @module Services/StrategyTree
 * @since 2.29.0 (Pass E2)
 */

import { normalizeAssertion, validateAssertion, CONDITION_TYPES } from './Assertion.js';

/**
 * Normalize a strategy's body (fragmentSteps) into the E2 tree shape.
 * Legacy steps (no `type`) get type: 'fragment' filled in. Future E2 writes
 * already produce normalized shapes; this function is idempotent.
 *
 * @param {Array<Object>} steps - The strategy.fragmentSteps array as read from storage.
 * @returns {Array<Object>} Normalized node array — safe to walk recursively.
 */
export function normalizeStrategyBody(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map(normalizeNode);
}

/**
 * Normalize a strategy's params array into canonical [{name, kind}] form.
 *
 * Accepts:
 *   - ['NAME', ...]                          (legacy: implicit scalar)
 *   - [{name, kind}, ...]                    (canonical)
 *   - [{name}, ...]                          (canonical missing kind → scalar)
 *   - mixed array of strings and objects     (each entry handled independently)
 *
 * Always returns the canonical shape. Drops entries with no name (defensive).
 * Idempotent on already-canonical input.
 *
 * v2.59.0 — params gained a `kind` field to support list-typed inputs.
 * Strategies authored before this version stored params as a flat string
 * array. Load-time normalization ensures runtime always sees the canonical
 * shape regardless of when the strategy was last saved.
 *
 * v2.74.64 — params gained typed-input fields (`type`, `required`,
 * `default`, plus `accept` / `parse` for file inputs). See
 * `INPUT_TYPES` and `FILE_PARSERS` below. Params without `type`
 * normalize to type='string' so pre-v2.74.64 strategies keep working.
 *
 * Canonical shape per param:
 *   {
 *     name     : string non-empty,
 *     kind     : 'scalar' | 'list',
 *     type     : 'string'|'number'|'boolean'|'file',
 *     required : boolean,
 *     // type-specific (omitted when not applicable):
 *     accept   : string,                     // file: <input accept>
 *     parse    : string,                     // file: parser id
 *     default  : string|number|boolean|null, // non-file only
 *   }
 *
 * @param {Array<string|Object>} params
 * @returns {Array<Object>}
 */
// v2.74.64 — Typed invocation inputs. `type` describes how a value is
// COLLECTED at strategy invocation time (independent of `kind` which
// describes the resulting binding's cardinality).
//
//   string  — free-text input (the historical default; substituted
//             textually into {{NAME}} placeholders before steps run).
//   number  — numeric input; coerced to Number at substitution time.
//   boolean — checkbox / toggle.
//   file    — file picker. Bytes are read at invocation; parsed by
//             the parser in `parse` (or 'auto' inferred from MIME /
//             extension); the parsed content becomes the binding.
//             `accept` is the standard <input accept> string
//             (".docx,.pdf,image/*" etc).
//
// Params authored before this field existed default to type='string',
// preserving exact prior behavior.
export const INPUT_TYPES = Object.freeze(['string', 'number', 'boolean', 'file']);

// Parser ids recognized for type='file'. 'auto' lets the runtime
// pick a parser based on the file's MIME type / extension. Specific
// ids pin the choice — useful when MIME inference is unreliable
// (e.g. '.csv' served as 'text/plain').
//
// Engine support is rolled out incrementally; an unknown id is
// normalized to 'auto'. As parsers ship they're added here:
//
//   auto       — infer at parse time (always available)
//   text       — read bytes as UTF-8; bind as scalar
//   json       — read + JSON.parse; bind as scalar (raw object/array)
//   csv        — split rows + header; bind as list<record>
//   docx-text  — mammoth.js → plain text; bind as scalar
//   pdf-text   — pdf.js → text per page; bind as scalar (joined)
//   xlsx       — SheetJS → list<record> per sheet (active sheet only)
//   image      — read as data URL; bind as image() tag
export const FILE_PARSERS = Object.freeze([
  'auto', 'text', 'json', 'csv', 'docx-text', 'pdf-text', 'xlsx', 'image',
]);

export function normalizeStrategyParams(params) {
  if (!Array.isArray(params)) return [];
  const out = [];
  for (const p of params) {
    // Legacy: bare string → name with default scalar/string typing.
    if (typeof p === 'string') {
      const name = p.trim();
      if (name) out.push({ name, kind: 'scalar', type: 'string', required: true });
      continue;
    }
    if (!p || typeof p !== 'object' || typeof p.name !== 'string') continue;
    const name = p.name.trim();
    if (!name) continue;

    const kind = (p.kind === 'list') ? 'list' : 'scalar';
    const type = INPUT_TYPES.includes(p.type) ? p.type : 'string';
    const required = (typeof p.required === 'boolean') ? p.required : true;

    const norm = { name, kind, type, required };

    // file-only fields
    if (type === 'file') {
      norm.accept = (typeof p.accept === 'string') ? p.accept : '';
      norm.parse  = FILE_PARSERS.includes(p.parse) ? p.parse : 'auto';
      // v2.74.68 — Optional per-param size cap (bytes). ParamForm enforces
      // the cap at submit time; missing / non-positive values fall back to
      // ParamForm's 10 MB default. Sanity-floor at 1 KB so a typo'd zero
      // doesn't block legitimate sub-KB files.
      if (Number.isFinite(p.maxBytes) && p.maxBytes >= 1024) {
        norm.maxBytes = Math.floor(p.maxBytes);
      }
    }

    // string / number / boolean default value (file inputs have no
    // meaningful "default" — every run must collect fresh bytes).
    if (type !== 'file' && p.default !== undefined && p.default !== null) {
      if (type === 'string'  && typeof p.default === 'string')  norm.default = p.default;
      if (type === 'number'  && Number.isFinite(p.default))     norm.default = p.default;
      if (type === 'boolean' && typeof p.default === 'boolean') norm.default = p.default;
    }

    out.push(norm);
  }
  return out;
}

/**
 * v2.61.0 — Normalize a single sieve operation. Returns null for unknown ops
 * so the caller can filter them out.
 * @private
 */
function normalizeSieveOp(op) {
  if (!op || typeof op !== 'object') return null;
  if (op.op === 'filter') {
    return {
      op: 'filter',
      assertion: normalizeSieveAssertion(op.assertion ?? {}),
    };
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
    const count = Number.isFinite(op.count) ? Math.max(0, Math.floor(op.count)) : 0;
    return { op: 'take', count };
  }
  return null;
}

/**
 * v2.61.0 — Normalize a sieve assertion. Assertions are either flat (operate
 * on a record field) or compound (combine other assertions).
 *
 * Flat:     field_equals, field_starts_with, field_contains, field_present
 * Compound: all_of, any_of, not
 *
 * Unknown assertion types normalize to a no-op (always-true) so a malformed
 * sieve doesn't crash the engine — just behaves as if there's no filter.
 * @private
 */
function normalizeSieveAssertion(p) {
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
        assertions: Array.isArray(p.assertions) ? p.assertions.map(normalizeSieveAssertion) : [],
      };
    case 'not':
      return { type: 'not', assertion: normalizeSieveAssertion(p.assertion ?? {}) };
    default:
      return { type: 'always_true' };
  }
}

/**
 * Normalize a single node. Recursive for FOREACH body.
 * @private
 */
function normalizeNode(node) {
  if (!node || typeof node !== 'object') return null;

  // Legacy fragment step — no `type` field, has fragmentId
  if (!node.type && node.fragmentId) {
    return {
      type         : 'fragment',
      fragmentId   : node.fragmentId,
      paramBindings: { ...(node.paramBindings ?? {}) },
    };
  }

  if (node.type === 'fragment') {
    return {
      type         : 'fragment',
      fragmentId   : node.fragmentId,
      paramBindings: { ...(node.paramBindings ?? {}) },
    };
  }

  if (node.type === 'foreach') {
    return {
      type: 'foreach',
      over: String(node.over ?? ''),
      as  : String(node.as ?? ''),
      body: normalizeStrategyBody(node.body),
    };
  }

  // Pass G1 (v2.30.0) — WAIT node. Leaf. Two modes: fixed-duration sleep
  // or condition-poll-with-timeout. Condition objects use the same shape
  // as Fragment pre/postconditions (`{type, selector|pattern|text}`) so
  // the engine can feed them straight into TemplateWalker.checkConditions.
  if (node.type === 'wait') {
    const mode = node.mode === 'condition' ? 'condition' : 'duration';
    if (mode === 'duration') {
      const raw = Number(node.durationMs);
      const durationMs = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 500;
      return { type: 'wait', mode: 'duration', durationMs };
    }
    // condition mode — normalize the embedded condition.
    const condition = normalizeCondition(node.condition ?? {}, node);
    const timeoutRaw = Number(node.timeoutMs);
    const pollRaw = Number(node.pollIntervalMs);
    const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 5000;
    const pollIntervalMs = Number.isFinite(pollRaw) && pollRaw >= 10 ? Math.floor(pollRaw) : 100;
    return { type: 'wait', mode: 'condition', condition, timeoutMs, pollIntervalMs };
  }

  // v2.60.0 — PAUSE node. Leaf, parameterless. Halts strategy execution at
  // this point until the user clicks Resume in the debugger. Distinct from
  // WAIT (which sleeps or polls) — PAUSE waits indefinitely for an explicit
  // user signal. Requires debug mode at invocation time; non-debug
  // invocations will fail when execution reaches a PAUSE.
  if (node.type === 'pause') {
    return { type: 'pause' };
  }

  // v2.61.0 — SIEVE node. List-to-list transformation. Reads a list-typed
  // binding from scope, applies a sequence of operations (filter/sort/take)
  // in order, writes the result as a new (or replacement) list binding.
  //
  // Operations preserve item identity — items keep their kind, baseSelector,
  // index, record, etc. exactly as ENUMERATE produced them. So downstream
  // FOREACH iterates the narrowed list with all the usual binding semantics
  // (selector resolution, field access via iteration_variable bindings).
  //
  // Sieves are pure transformations on captured data — they have no DOM
  // effects and cannot fail at runtime due to page state. They CAN produce
  // empty lists (filter found nothing, take 0) which downstream FOREACH
  // handles by iterating zero times.
  //
  // v2.63.0 (Iteration B) — sieve nodes now reference a named Analysis
  // (built-in or user-authored) by id, with paramBindings supplying values
  // for the Analysis's params. The legacy shape (`operations` inline on
  // the node) is preserved here on normalize so the studio's load-time
  // migrator can detect it and convert. After migration the node has
  // `analysisId` + `paramBindings` and no `operations`.
  if (node.type === 'sieve') {
    const out = {
      type: 'sieve',
      source: String(node.source ?? '').trim(),
      output: String(node.output ?? '').trim(),
    };
    // New shape: analysisId + paramBindings
    if (typeof node.analysisId === 'string' && node.analysisId.trim()) {
      out.analysisId = node.analysisId.trim();
      out.paramBindings = (node.paramBindings && typeof node.paramBindings === 'object')
        ? { ...node.paramBindings }
        : {};
    }
    // Legacy shape: inline operations array. Preserved as-is for the
    // studio's migrator to detect and rewrite. Both fields can technically
    // coexist during migration; engine prefers analysisId when both present.
    if (Array.isArray(node.operations)) {
      out.operations = node.operations.map(normalizeSieveOp).filter(Boolean);
    }
    return out;
  }

  // Pass G2 (v2.31.0) — DETECT node. Multi-way conditional. Evaluates
  // each branch's condition one-shot in order; first match's body runs.
  // If no branch matches, `default` body runs. Branches and default can
  // nest any node type including other detects.
  //
  // "IF X THEN Y" ≡ single-branch detect with empty default.
  // "IF X THEN Y ELSE Z" ≡ single-branch detect with default=Z.
  if (node.type === 'detect') {
    const rawBranches = Array.isArray(node.branches) ? node.branches : [];
    const branches = rawBranches.map(b => {
      if (!b || typeof b !== 'object') return null;
      return {
        condition: normalizeCondition(b.condition ?? {}, b),
        body: normalizeStrategyBody(b.body),
      };
    }).filter(Boolean);
    return {
      type: 'detect',
      branches,
      default: normalizeStrategyBody(node.default),
    };
  }

  // Pass H1 (v2.32.0) — LOOP node. Condition-assertiond while-loop.
  // Test-first semantics: evaluate condition, if true run body, repeat.
  // Safety-capped by maxIterations (default 100) — exceeding that is an
  // authoring bug, not a valid runtime outcome, so we fail rather than
  // silently truncate.
  if (node.type === 'loop') {
    const condition = normalizeCondition(node.condition ?? {}, node);
    const maxRaw = Number(node.maxIterations);
    const maxIterations = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.floor(maxRaw) : 100;
    return {
      type: 'loop',
      condition,
      body: normalizeStrategyBody(node.body),
      maxIterations,
    };
  }

  // Pass H2 (v2.33.0) — TRY node. Expected-failure recovery.
  //
  // Execute `body` sequentially. If all body nodes succeed, skip `recover`
  // and exit cleanly. If any body node FAILS, stop the body, run
  // `recover`, and return `recover`'s status. An empty `recover` swallows
  // the failure (TRY succeeds). If `recover` itself fails, TRY fails —
  // we do NOT recurse into another recovery (prevents infinite loops).
  //
  // Aborts propagate normally (body or recover).
  //
  // TRY is scope-transparent: iteration variables from enclosing
  // FOREACHes remain visible in both body and recover. The recover body
  // does NOT receive failure information as a binding — for H2 it's
  // opaque. If we find we need it, FAILURE can be added as a synthetic
  // binding later without breaking existing strategies.
  if (node.type === 'try') {
    return {
      type: 'try',
      body: normalizeStrategyBody(node.body),
      recover: normalizeStrategyBody(node.recover),
    };
  }

  // Pass H3 (v2.34.0) — NAVIGATE node. Drives the browser tab.
  //
  // Three modes:
  //   url    — go to URL. URL may be a literal string or a binding
  //            ({kind: 'strategy_param'|'iteration_variable'|'literal', ...}).
  //   back   — browser back.
  //   reload — reload current tab.
  //
  // Always waits for load completion with a 10s internal timeout. No
  // author-configurable timeout; if a page legitimately needs more, add
  // a WAIT after.
  //
  // NAVIGATE does not alter ground-URL semantics. A strategy that
  // navigates to an unrelated URL and then tries to run a fragment
  // requiring ground-URL context will fail preconditions — correct
  // behavior.
  if (node.type === 'navigate') {
    const mode = (node.mode === 'back' || node.mode === 'reload') ? node.mode : 'url';
    if (mode !== 'url') {
      // back / reload — URL is irrelevant, don't include it.
      return { type: 'navigate', mode };
    }
    // url mode — normalize the URL field to one of:
    //   { kind: 'literal', value: string }
    //   { kind: 'strategy_param', name: string }
    //   { kind: 'iteration_variable', name: string }
    // Accept raw strings as a convenience — treat as literal.
    let url;
    if (typeof node.url === 'string') {
      url = { kind: 'literal', value: node.url };
    } else if (node.url && typeof node.url === 'object') {
      const k = node.url.kind;
      if (k === 'strategy_param') {
        url = { kind: 'strategy_param', name: String(node.url.name ?? '') };
      } else if (k === 'iteration_variable') {
        url = { kind: 'iteration_variable', name: String(node.url.name ?? '') };
      } else {
        // default/legacy/unknown -> literal
        url = { kind: 'literal', value: String(node.url.value ?? '') };
      }
    } else {
      url = { kind: 'literal', value: '' };
    }
    return { type: 'navigate', mode: 'url', url };
  }

  // v2.71.0 — SCROLL node. Selectorless strategy-level scroll. v1 mode='by'
  // with signed viewport distance. distance follows NAVIGATE's url-binding
  // shape: literal | strategy_param | iteration_variable. Raw numbers/strings
  // are accepted as a convenience (treated as literal).
  if (node.type === 'scroll') {
    let distance;
    if (typeof node.distance === 'string' || typeof node.distance === 'number') {
      distance = { kind: 'literal', value: String(node.distance) };
    } else if (node.distance && typeof node.distance === 'object') {
      const k = node.distance.kind;
      if (k === 'strategy_param') {
        distance = { kind: 'strategy_param', name: String(node.distance.name ?? '') };
      } else if (k === 'iteration_variable') {
        distance = { kind: 'iteration_variable', name: String(node.distance.name ?? '') };
      } else {
        // legacy/unknown -> literal
        distance = { kind: 'literal', value: String(node.distance.value ?? '') };
      }
    } else {
      distance = { kind: 'literal', value: '' };
    }
    return { type: 'scroll', mode: 'by', distance };
  }

  // v2.72.3 (Pass 4) — Observation node. References an authored Observation
  // by id. The Observation record (in StorageManager) carries the shape,
  // target, fields, etc. The node is mostly a pointer plus future param
  // bindings. paramBindings is reserved for parameterized Observations
  // (e.g. selectors with {{TOKEN}} placeholders); 3a-era Observations have
  // no params and so paramBindings is typically empty `{}`.
  if (node.type === 'observation') {
    return {
      type: 'observation',
      observationId: typeof node.observationId === 'string' ? node.observationId : '',
      paramBindings: (node.paramBindings && typeof node.paramBindings === 'object')
        ? { ...node.paramBindings }
        : {},
    };
  }

  // Pass J2 (v2.37.0) — IN_NEW_TAB node. Trigger runs on outer tab,
  // expected to open exactly one new tab; body runs there.
  //
  // `trigger` is itself a single Node (must be a tree node, typically a
  // fragment). Normalized via normalizeNode and wrapped into {trigger: ...}.
  // If the caller passes a null/undefined trigger, validation will flag it;
  // we don't throw here.
  //
  // closeOnExit defaults to true — common case is apply-and-close. Authors
  // who want to keep the new tab open (e.g. debugging, or the new tab IS
  // the result) can set false.
  if (node.type === 'in_new_tab') {
    const trigger = (node.trigger && typeof node.trigger === 'object')
      ? normalizeNode(node.trigger) : null;
    return {
      type: 'in_new_tab',
      trigger,
      body: normalizeStrategyBody(node.body),
      closeOnExit: node.closeOnExit === false ? false : true,
    };
  }

  // Unknown type — skip (caller may want to warn; we don't throw).
  return null;
}

/**
 * Normalize a condition object into canonical `{type, selector|pattern|text}`
 * shape. Accepts either a nested condition or flat fields on the parent
 * node (for authoring convenience). Used by WAIT (condition mode) and
 * DETECT (per-branch).
 *
 * Only includes the field relevant to the condition type, so stale
 * fields from an earlier type don't leak into storage.
 *
 * @param {Object} cond   - the nested condition object (possibly empty)
 * @param {Object} parent - the parent node, for legacy flat-field fallback
 * @returns {Object} canonical condition
 * @private
 */
/**
 * v2.41.0 (Pass M1) — Normalize a condition slot on a node into a canonical
 * Assertion. Accepts:
 *   - Old single-condition shape { type, selector|pattern|text }
 *   - Old fragment-pre/post array shape [{ type, ... }, ...]
 *   - New Assertion shape { match, conditions: [...] }
 *
 * Returns a Assertion. Empty / null inputs return { match: 'all', conditions: [] }.
 *
 * The legacy fallback for a missing `type` field used to coerce to
 * 'selector_present' with an empty selector; now we drop unknowns silently
 * and let the validator catch empty conditions at save time.
 *
 * @param {*} cond - node.condition (or branch.condition) value
 * @param {Object} parent - the parent node, for legacy flat-field fallback
 * @returns {{ match: 'all'|'any', conditions: Object[] }}
 * @private
 */
function normalizeCondition(cond, parent = {}) {
  // Legacy flat-field fallback: some very old strategies stored
  // `node.conditionType` + `node.selector` directly on the node, with no
  // `condition` sub-object. If we got an empty/missing cond but the parent
  // looks like that shape, synthesize the old shape and let normalizeAssertion
  // wrap it.
  if ((cond == null || (typeof cond === 'object' && Object.keys(cond).length === 0))
      && parent?.conditionType) {
    cond = {
      type: parent.conditionType,
      selector: parent.selector,
      pattern : parent.pattern,
      text    : parent.text,
    };
  }
  return normalizeAssertion(cond);
}

/**
 * Walk all nodes in a normalized body, calling visitor(node, depth, parent).
 * Pre-order traversal: parent is visited before its children.
 *
 * Useful for static analysis — detecting missing iteration_variable bindings,
 * computing max nesting depth, enumerating Fragment usages, etc.
 */
export function walkNodes(body, visitor, depth = 0, parent = null) {
  if (!Array.isArray(body)) return;
  for (const node of body) {
    if (!node) continue;
    visitor(node, depth, parent);
    if (node.type === 'foreach') {
      walkNodes(node.body, visitor, depth + 1, node);
    } else if (node.type === 'detect') {
      // Pass G2 — descend into every branch body AND the default.
      for (const branch of node.branches ?? []) {
        walkNodes(branch?.body, visitor, depth + 1, node);
      }
      walkNodes(node.default, visitor, depth + 1, node);
    } else if (node.type === 'loop') {
      // Pass H1 — descend into loop body.
      walkNodes(node.body, visitor, depth + 1, node);
    } else if (node.type === 'try') {
      // Pass H2 — descend into both body and recover.
      walkNodes(node.body, visitor, depth + 1, node);
      walkNodes(node.recover, visitor, depth + 1, node);
    } else if (node.type === 'in_new_tab') {
      // Pass J2 — descend into trigger (as a one-element list) and body.
      // The trigger is one node; the body is a list. Both count as
      // children of this node at depth+1.
      if (node.trigger) walkNodes([node.trigger], visitor, depth + 1, node);
      walkNodes(node.body, visitor, depth + 1, node);
    }
  }
}

/**
 * Collect the names of iteration variables that are in scope at each node.
 * Returns a Map<node, Set<string>>. A param binding of kind 'iteration_variable'
 * is valid iff its `name` appears in the set for its containing fragment node.
 */
export function computeIterationScopes(body) {
  const scopes = new Map();   // node → Set<string>
  const visit = (nodes, active) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node) continue;
      scopes.set(node, new Set(active));
      if (node.type === 'foreach') {
        const nested = new Set(active);
        if (node.as) nested.add(node.as);
        visit(node.body, nested);
      } else if (node.type === 'detect') {
        // Pass G2 — DETECT is scope-transparent. Branch bodies + default
        // see the same iteration variables their enclosing scope sees.
        for (const branch of node.branches ?? []) {
          visit(branch?.body, active);
        }
        visit(node.default, active);
      } else if (node.type === 'loop') {
        // Pass H1 — LOOP is scope-transparent. Body sees the same iteration
        // variables the enclosing scope sees. LOOP introduces no new
        // iteration variable of its own.
        visit(node.body, active);
      } else if (node.type === 'try') {
        // Pass H2 — TRY is scope-transparent. Both body AND recover see
        // the same iteration variables the enclosing scope sees.
        visit(node.body, active);
        visit(node.recover, active);
      } else if (node.type === 'in_new_tab') {
        // Pass J2 — IN_NEW_TAB is scope-transparent. Trigger and body
        // both see the enclosing iteration variables. Bindings written
        // in body persist into outer scope (scope is tab-agnostic).
        if (node.trigger) visit([node.trigger], active);
        visit(node.body, active);
      }
    }
  };
  visit(body, new Set());
  return scopes;
}

/**
 * Validate an E2 Strategy body. Checks that:
 *   - FOREACH nodes have non-empty `over` and `as`
 *   - FOREACH nodes don't nest with the same `as` (shadowing is allowed but
 *     immediate re-use is almost always a mistake)
 *   - iteration_variable bindings reference a name in scope at that point
 *   - fragment nodes have a fragmentId
 *
 * Returns { ok: boolean, errors: string[] }. Non-throwing — callers decide
 * what to do with the error list.
 */
// v2.74.139 — Accept an optional `getAnalysisBodyKind` callback so the
// SIEVE validator can adapt its source/output requirements to the
// referenced Analysis's body kind. Without the callback (legacy call
// sites), the validator falls back to the pre-v2.74.139 strict checks
// — source AND output both required — which is correct for operations
// bodies but wrong for template (output only) and transform (neither).
// Callers that have an analyses cache should pass the lookup so
// transform-body sieves don't false-positive at structural-validation
// time.
//
//   options.getAnalysisBodyKind(id) → 'operations' | 'template' |
//                                     'transform' | 'frontier' | null
export function validateStrategyBody(body, options = {}) {
  const errors = [];
  const scopes = computeIterationScopes(body);
  const getAnalysisBodyKind = typeof options.getAnalysisBodyKind === 'function'
    ? options.getAnalysisBodyKind
    : null;

  walkNodes(body, (node, depth, parent) => {
    if (node.type === 'fragment') {
      if (!node.fragmentId) {
        errors.push('Fragment step missing fragmentId');
      }
      const active = scopes.get(node) ?? new Set();
      for (const [paramName, binding] of Object.entries(node.paramBindings ?? {})) {
        if (binding?.kind === 'iteration_variable') {
          if (!binding.name) {
            errors.push(`Param "${paramName}" has iteration_variable binding with no name`);
          } else if (!active.has(binding.name)) {
            errors.push(`Param "${paramName}" references iteration variable "${binding.name}" not in scope at this point`);
          }
        }
      }
    } else if (node.type === 'foreach') {
      if (!node.over) errors.push('FOREACH missing "over" (list binding name)');
      if (!node.as)   errors.push('FOREACH missing "as" (iteration variable name)');
      // Shadowing check
      if (parent?.type === 'foreach' && node.as && node.as === parent.as) {
        errors.push(`FOREACH shadows enclosing iteration variable "${node.as}"`);
      }
    } else if (node.type === 'sieve') {
      // v2.63.1 — Validate SIEVE node shape. Sieves reference an Analysis
      // by id; operations live in the Analysis. Validates required fields
      // and paramBindings shape. Operation-level validation happens when
      // the Analysis itself is saved (at the Analysis editor or registry
      // level), not here.
      // v2.74.139 — source/output requirements depend on the Analysis's
      // body kind. When a lookup callback is provided and reports the
      // body kind, skip the checks that don't apply:
      //   - 'transform': skip both (wiring is by declared name)
      //   - 'template':  skip source check (no source list; output kept)
      //   - other / unknown / no callback: keep strict-old behavior
      const bodyKind = (getAnalysisBodyKind && node.analysisId)
        ? getAnalysisBodyKind(node.analysisId)
        : null;
      const isTransform = bodyKind === 'transform';
      const isTemplate  = bodyKind === 'template';
      if (!isTransform && !isTemplate) {
        if (!node.source || !String(node.source).trim()) {
          errors.push('SIEVE: source binding name is empty');
        }
      }
      if (!isTransform) {
        if (!node.output || !String(node.output).trim()) {
          errors.push('SIEVE: output binding name is empty');
        }
      }
      if (!node.analysisId || !String(node.analysisId).trim()) {
        errors.push('SIEVE: analysisId not set (no Analysis selected)');
      }
      const active = scopes.get(node) ?? new Set();
      for (const [paramName, binding] of Object.entries(node.paramBindings ?? {})) {
        if (!binding || typeof binding !== 'object') {
          errors.push(`SIEVE param "${paramName}" has invalid binding shape`);
          continue;
        }
        const kind = binding.kind ?? 'literal';
        if (kind === 'literal') {
          // value can be empty string — caught by the studio editor's stricter
          // validator if needed; permitted at schema level.
        } else if (kind === 'iteration_variable') {
          if (!binding.name) {
            errors.push(`SIEVE param "${paramName}" has iteration_variable binding with no name`);
          } else if (!active.has(binding.name)) {
            errors.push(`SIEVE param "${paramName}" references iteration variable "${binding.name}" not in scope at this point`);
          }
        } else if (kind === 'strategy_param') {
          if (!binding.name) {
            errors.push(`SIEVE param "${paramName}" has strategy_param binding with no name`);
          }
        } else {
          errors.push(`SIEVE param "${paramName}" has unknown binding kind "${kind}"`);
        }
      }
    } else if (node.type === 'wait') {
      // Pass G1 — validate WAIT node shape.
      if (node.mode === 'duration') {
        if (!Number.isFinite(node.durationMs) || node.durationMs < 0) {
          errors.push('WAIT duration must be a non-negative number');
        }
      } else if (node.mode === 'condition') {
        const condErrs = validateConditionShape(node.condition, 'WAIT');
        errors.push(...condErrs);
        if (!Number.isFinite(node.timeoutMs) || node.timeoutMs <= 0) {
          errors.push('WAIT timeout must be a positive number');
        }
      } else {
        errors.push('WAIT mode must be "duration" or "condition"');
      }
    } else if (node.type === 'detect') {
      // Pass G2 — validate DETECT node shape.
      if (!Array.isArray(node.branches) || node.branches.length === 0) {
        errors.push('DETECT must have at least one branch');
      } else {
        for (let i = 0; i < node.branches.length; i++) {
          const b = node.branches[i];
          const condErrs = validateConditionShape(b?.condition, `DETECT branch ${i + 1}`);
          errors.push(...condErrs);
          if (!Array.isArray(b?.body)) {
            errors.push(`DETECT branch ${i + 1}: body must be an array`);
          }
        }
      }
      if (!Array.isArray(node.default)) {
        errors.push('DETECT default must be an array (empty [] is fine)');
      }
    } else if (node.type === 'loop') {
      // Pass H1 — validate LOOP node shape.
      const condErrs = validateConditionShape(node.condition, 'LOOP');
      errors.push(...condErrs);
      if (!Array.isArray(node.body)) {
        errors.push('LOOP body must be an array');
      }
      if (!Number.isFinite(node.maxIterations) || node.maxIterations <= 0) {
        errors.push('LOOP maxIterations must be a positive number');
      }
    } else if (node.type === 'try') {
      // Pass H2 — validate TRY node shape.
      if (!Array.isArray(node.body)) {
        errors.push('TRY body must be an array');
      }
      if (!Array.isArray(node.recover)) {
        errors.push('TRY recover must be an array (empty [] is fine to swallow failure)');
      }
    } else if (node.type === 'navigate') {
      // Pass H3 — validate NAVIGATE node shape.
      if (node.mode !== 'url' && node.mode !== 'back' && node.mode !== 'reload') {
        errors.push('NAVIGATE mode must be one of: url, back, reload');
      }
      if (node.mode === 'url') {
        const u = node.url;
        if (!u || typeof u !== 'object') {
          errors.push('NAVIGATE url mode: url must be set');
        } else if (u.kind === 'literal') {
          if (!u.value || !String(u.value).trim()) {
            errors.push('NAVIGATE url mode: literal URL is empty');
          } else if (!/^https?:\/\//i.test(u.value) && !u.value.startsWith('about:')) {
            errors.push('NAVIGATE url mode: literal URL must start with http:// or https:// (or about:)');
          }
        } else if (u.kind === 'strategy_param') {
          if (!u.name || !String(u.name).trim()) {
            errors.push('NAVIGATE url mode: strategy_param name is empty');
          }
        } else if (u.kind === 'iteration_variable') {
          if (!u.name || !String(u.name).trim()) {
            errors.push('NAVIGATE url mode: iteration_variable name is empty');
          } else {
            // Check iteration variable is in scope at this node
            const active = scopes.get(node) ?? new Set();
            if (!active.has(u.name)) {
              errors.push(`NAVIGATE references iteration variable "${u.name}" not in scope at this point`);
            }
          }
        } else {
          errors.push(`NAVIGATE url mode: unknown binding kind "${u.kind}"`);
        }
      }
    } else if (node.type === 'scroll') {
      // v2.71.0 — Validate SCROLL node shape. Selectorless strategy-level
      // scroll, sibling to NAVIGATE/WAIT/LOOP. v1 = mode 'by' only with a
      // signed viewport distance. distance follows the same binding shape
      // as NAVIGATE's url: literal | strategy_param | iteration_variable.
      if (node.mode !== 'by') {
        errors.push('SCROLL mode must be "by" (other modes deferred to a later iteration)');
      }
      const d = node.distance;
      if (!d || typeof d !== 'object') {
        errors.push('SCROLL: distance must be set');
      } else if (d.kind === 'literal') {
        const raw = String(d.value ?? '').trim();
        if (raw === '') {
          errors.push('SCROLL: literal distance is empty');
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n)) {
            errors.push(`SCROLL: literal distance "${raw}" is not a number`);
          } else if (Math.abs(n) > 100) {
            errors.push(`SCROLL: literal distance ${n} exceeds sanity cap (±100 viewports)`);
          }
        }
      } else if (d.kind === 'strategy_param') {
        if (!d.name || !String(d.name).trim()) {
          errors.push('SCROLL: strategy_param name is empty');
        }
      } else if (d.kind === 'iteration_variable') {
        if (!d.name || !String(d.name).trim()) {
          errors.push('SCROLL: iteration_variable name is empty');
        } else {
          const active = scopes.get(node) ?? new Set();
          if (!active.has(d.name)) {
            errors.push(`SCROLL references iteration variable "${d.name}" not in scope at this point`);
          }
        }
      } else {
        errors.push(`SCROLL: unknown distance binding kind "${d.kind}"`);
      }
    } else if (node.type === 'observation') {
      // v2.72.3 (Pass 4) — Validate Observation node shape. The node only
      // points at an Observation by id; the actual extraction shape lives
      // in storage. Validation here only checks that the reference is
      // well-formed. Engine resolves and validates the referenced record
      // at runtime (it may be missing, deleted, or belong to a different
      // Ground — those are runtime concerns not catchable here).
      if (typeof node.observationId !== 'string' || !node.observationId.trim()) {
        errors.push('Observation node: observationId is required');
      }
      // paramBindings is optional, must be an object if present
      if (node.paramBindings != null && typeof node.paramBindings !== 'object') {
        errors.push('Observation node: paramBindings must be an object if present');
      }
      // v2.72.10 (bug review) — iteration_variable scope check. Mirrors
      // the Fragment validator at the top of this function. Catches the
      // case where an Observation is moved out of its enclosing FOREACH
      // (or never inside one) but its paramBinding still references an
      // iteration variable. Without this, the only signal is a runtime
      // "param not bound" error that doesn't tell the author WHY.
      const active = scopes.get(node) ?? new Set();
      for (const [paramName, binding] of Object.entries(node.paramBindings ?? {})) {
        if (binding?.kind === 'iteration_variable') {
          if (!binding.name) {
            errors.push(`Observation param "${paramName}" has iteration_variable binding with no name`);
          } else if (!active.has(binding.name)) {
            errors.push(`Observation param "${paramName}" references iteration variable "${binding.name}" not in scope at this point`);
          }
        }
      }
    } else if (node.type === 'in_new_tab') {
      // Pass J2 — validate IN_NEW_TAB node shape.
      if (!node.trigger || typeof node.trigger !== 'object') {
        errors.push('IN_NEW_TAB requires a trigger node (the action that opens the new tab)');
      }
      if (!Array.isArray(node.body)) {
        errors.push('IN_NEW_TAB body must be an array');
      }
      if (typeof node.closeOnExit !== 'boolean') {
        errors.push('IN_NEW_TAB closeOnExit must be boolean');
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Validate a condition object's shape. Used by both WAIT (condition mode)
 * and DETECT (per-branch). Returns a list of error messages; empty means
 * valid. `context` prefixes errors for locator-friendly messages.
 *
 * @param {Object} cond
 * @param {string} context - e.g. "WAIT" or "DETECT branch 2"
 * @returns {string[]}
 * @private
 */
/**
 * v2.41.0 (Pass M1) — validate a condition slot. Now accepts a Assertion
 * shape OR a legacy single-condition shape; both flow through normalizeAssertion
 * before validation. Old condition-array fragment pre/post is also accepted
 * here (fragments call this directly via the storage layer).
 *
 * @param {*} cond - condition slot from a node (DETECT branch, LOOP, WAIT)
 * @param {string} context - context label for error messages
 * @returns {string[]}
 * @private
 */
function validateConditionShape(cond, context) {
  // v2.45.0 — delegate per-condition shape validation to Assertion.validateAssertion
  // (the canonical validator). This used to duplicate per-type if/else logic
  // here; the duplication caused v2.42.1's "assertion_ref unknown type" bug.
  // Single source of truth: Services/Assertion.js CONDITION_FIELDS.
  //
  // We still detect "unknown type" specifically by checking the input
  // conditions before normalize drops them silently. That gives a clearer
  // error message than "at least one condition required."

  // First, surface unknown-type errors specifically — normalize would drop them
  // and we'd get an unhelpful "at least one condition" message instead.
  const errors = [];
  const rawConds = Array.isArray(cond)
    ? cond
    : (cond && Array.isArray(cond.conditions))
    ? cond.conditions
    : (cond && typeof cond === 'object' && cond.type)
    ? [cond]
    : [];
  rawConds.forEach((c, i) => {
    if (c && typeof c === 'object' && c.type && !CONDITION_TYPES.includes(c.type)) {
      errors.push(`${context} condition ${i + 1}: unknown type "${c.type}"`);
    }
  });
  if (errors.length > 0) return errors;

  // Normalize and run canonical validation
  const p = normalizeAssertion(cond);
  if (p.conditions.length === 0) {
    return [`${context}: at least one condition is required`];
  }
  const v = validateAssertion(p, context);
  return v.errors ?? [];
}

/**
 * Count total Fragment invocations in a body — walks into FOREACH bodies.
 * Used for display ("5 steps total") and progress denominators that need to
 * flatten the tree.
 *
 * Note: this counts STATIC Fragment invocations in the tree, not runtime
 * executions (a Fragment inside a FOREACH body counts once even though it
 * runs N times at execution).
 */
export function countFragmentInvocations(body) {
  let n = 0;
  walkNodes(body, (node) => {
    if (node.type === 'fragment') n++;
  });
  return n;
}

/**
 * v2.60.1 — Count every executable node in a normalized body, recursively.
 * Unlike countFragmentInvocations (which counts fragment-typed nodes only),
 * this counts every node type: fragment, foreach, wait, pause, detect, loop,
 * try, navigate, in_new_tab. Used for "is this strategy non-empty / ready"
 * checks where any node qualifies — a strategy of just NAVIGATE+PAUSE is
 * legitimately runnable and should report a non-zero step count.
 *
 * @param {Array} body - normalized strategy body
 * @returns {number}
 */
export function countExecutableNodes(body) {
  let n = 0;
  walkNodes(body, () => { n++; });
  return n;
}
