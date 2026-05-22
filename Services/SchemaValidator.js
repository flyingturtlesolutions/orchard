/**
 * @file Services/SchemaValidator.js
 * @description Structural guardrail service for validating LLM-generated JSON step arrays
 * before they are accepted into the execution pipeline. Implements strict schema enforcement
 * using a rule-based validation engine rather than a third-party library, keeping the
 * extension self-contained and auditable.
 *
 * Validation contract:
 *   - Input must be a non-empty JSON array of step objects.
 *   - Every step must pass ALL field-level rules.
 *   - A single invalid step fails the entire payload (fail-fast strategy).
 *
 * @module Services/SchemaValidator
 * @author Agent HUB
 * @version 2.19.0
 */

import { Logger } from '../Core/Logger.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Enumeration of every action type the execution engine recognises.
 * The validator rejects any action value that is not a member of this set,
 * preventing silent no-ops or ambiguous commands from reaching the runner.
 *
 * @readonly
 * @enum {string}
 */
export const ACTION_TYPES = Object.freeze({
  NAVIGATE      : 'NAVIGATE',
  CLICK         : 'CLICK',
  CLICK_BY_LABEL: 'CLICK_BY_LABEL',  // v2.72.91 — container-scoped click by visible label
  TYPE          : 'TYPE',
  WAIT          : 'WAIT',
  WAIT_FOR      : 'WAIT_FOR',       // polls until selector appears
  WAIT_FOR_GONE : 'WAIT_FOR_GONE',  // polls until selector disappears (confirms page transition)
  FIND_AI       : 'FIND_AI',
  EXTRACT       : 'EXTRACT',
  ENUMERATE     : 'ENUMERATE',      // v2.29.1 (E2-2) — capture N items into Scope as a list
  SELECT        : 'SELECT',
  BLUR          : 'BLUR',
  SCROLL_TO     : 'SCROLL_TO',      // v2.61.4 — scroll matched element into view (no DOM mutation)
  ENTER         : 'ENTER',          // v2.74.49 — simulate Enter keypress (with implicit form-submit fallback)
  KEY           : 'KEY',            // v2.74.308 — ACTION_SPEC § 3: send a named keyboard key (value = key name) to the resolved element
  ACTION_GATE   : 'ACTION_GATE',    // v2.74.156 — conditional container: header condition + negate + body[]; body runs only when condition is satisfied (XOR negate)
});

/**
 * Enumeration of Procedure Tree node types. A Procedure is either a flat
 * Step array (linear, the original shape) or a tree rooted at one of these
 * nodes. Bodies inside FOR_EACH/DETECT are themselves ProcedureNodes, which
 * may be flat arrays or nested tree nodes.
 *
 * @readonly
 */
export const NODE_TYPES = Object.freeze({
  FOR_EACH : 'FOR_EACH',
  DETECT   : 'DETECT',
  SEQUENCE : 'SEQUENCE',  // optional explicit wrapper; arrays are implicit SEQUENCEs
});

/**
 * Condition types evaluable at runtime in a DETECT branch.
 * @readonly
 */
export const CONDITION_TYPES = Object.freeze({
  SELECTOR_PRESENT  : 'selector_present',
  SELECTOR_ABSENT   : 'selector_absent',
  URL_MATCHES       : 'url_matches',
  TEXT_PRESENT      : 'text_present',
  ATTRIBUTE_EQUALS  : 'attribute_equals',
});

/**
 * Rules applied to every step object.
 * Each rule is an object with:
 *   - `field`    {string}   — the key being evaluated
 *   - `required` {boolean}  — whether the field must be present and non-null
 *   - `type`     {string}   — expected typeof result (skipped when value is null/undefined and !required)
 *   - `validate` {Function} — additional constraint returning { ok: boolean, reason: string }
 *
 * @type {Array<StepFieldRule>}
 */
const STEP_SCHEMA_RULES = [
  {
    field    : 'step',
    required : true,
    type     : 'number',
    validate : (v) => {
      if (!Number.isInteger(v) || v < 1) {
        return { ok: false, reason: `"step" must be a positive integer, got ${v}` };
      }
      return { ok: true };
    },
  },
  {
    field    : 'action',
    required : true,
    type     : 'string',
    validate : (v) => {
      const valid = Object.values(ACTION_TYPES);
      if (!valid.includes(v)) {
        return {
          ok     : false,
          reason : `"action" must be one of [${valid.join(', ')}], got "${v}"`,
        };
      }
      return { ok: true };
    },
  },
  {
    field    : 'selector',
    required : true,
    type     : 'string',
    validate : (v, step) => {
      // Actions that do not target a specific DOM element may have an empty selector.
      const selectorOptional = [
        ACTION_TYPES.NAVIGATE,      // targets a URL, not an element
        ACTION_TYPES.WAIT,          // time-based delay, no element needed
        ACTION_TYPES.FIND_AI,       // uses internal heuristics — selector is ignored
        ACTION_TYPES.BLUR,          // blurs active element when no selector given
        ACTION_TYPES.EXTRACT,       // empty selector = full document.body.innerText
        ACTION_TYPES.ENTER,         // v2.74.49 — empty selector = dispatch on active element
        ACTION_TYPES.KEY,           // v2.74.315 — like ENTER, operates on document.activeElement (selector field removed from authoring UI)
        ACTION_TYPES.ACTION_GATE,   // v2.74.156 — container; no selector of its own (the gate's CONDITION carries any selector if needed)
      ];
      // WAIT_FOR requires a non-empty selector (it IS the element to wait for)
      if (!selectorOptional.includes(step.action) && v.trim() === '') {
        return {
          ok     : false,
          reason : `"selector" cannot be empty for action "${step.action}"`,
        };
      }
      return { ok: true };
    },
  },
  {
    field    : 'value',
    required : true,          // field must be present; value itself may be empty string
    type     : 'string',
    validate : (v, step) => {
      // NAVIGATE requires a non-empty URL in "value"
      if (step.action === ACTION_TYPES.NAVIGATE && v.trim() === '') {
        return { ok: false, reason : '"value" must contain a URL for NAVIGATE action' };
      }
      // TYPE requires a value (may contain the {{USER_QUESTION}} placeholder)
      if (step.action === ACTION_TYPES.TYPE && v === '') {
        return {
          ok     : false,
          reason : '"value" must not be empty for TYPE action; use {{USER_QUESTION}} as placeholder',
        };
      }
      // v2.72.91 — CLICK_BY_LABEL requires a non-empty value (the label
      // text or {{LABEL}} placeholder). Container selector + label
      // together identify the option to click.
      if (step.action === ACTION_TYPES.CLICK_BY_LABEL && v === '') {
        return {
          ok     : false,
          reason : '"value" must not be empty for CLICK_BY_LABEL; use {{LABEL}} placeholder or a literal label',
        };
      }
      // WAIT: value should be a numeric string representing milliseconds
      if (step.action === ACTION_TYPES.WAIT) {
        const ms = Number(v);
        if (isNaN(ms) || ms < 0) {
          return { ok: false, reason: `"value" for WAIT must be a non-negative numeric string, got "${v}"` };
        }
      }
      // v2.74.308 — KEY requires a non-empty key name in "value"
      // (ACTION_SPEC § 3 — the { key } parameter). KeyboardEvent.key
      // values: "Enter", "Escape", "Tab", "ArrowDown", "a", " ", etc.
      if (step.action === ACTION_TYPES.KEY && v.trim() === '') {
        return { ok: false, reason: '"value" must be a key name for KEY action (e.g. "Enter", "Escape", "ArrowDown")' };
      }
      return { ok: true };
    },
  },
  {
    // v2.74.0 — Action chain branches. CLICK_BY_LABEL steps may carry a
    // `branches` array whose presence marks the step as the head of an
    // "action chain" — a head click + per-label dispatch into a body
    // action captured under the conditions that head established.
    //
    // Branch shape (v2.74.3):
    //   { label: string non-empty,
    //     action: 'CLICK_BY_LABEL' | 'WAIT' | 'WAIT_FOR',
    //     selector: string,
    //     value?: string,        // ONLY WAIT carries its own value (ms)
    //     pickedLabel?: string }
    //
    // CLICK_BY_LABEL branches no longer carry their own `value`. They
    // share the chain-level `bodyValue` (one slot per chain), guaranteeing
    // exactly one layer-2 param appears in the fragment's params list
    // regardless of branch count. WAIT_FOR branches also have no value;
    // their value field is meaningless. WAIT branches keep their `value`
    // for the millisecond duration.
    //
    // At runtime: the engine resolves the head's substituted value to a
    // literal layer-1 label, runs the head, finds the branch where
    // branch.label === resolvedLabel, runs that branch's action. For
    // CLICK_BY_LABEL branches, the engine substitutes the chain's
    // bodyValue as the click target.
    //
    // No-branches case: branches absent OR empty array → step is a plain
    // CLICK_BY_LABEL with no chain semantics. (Empty array is normalized
    // by save-time stripping; we accept both shapes for forward compat.)
    field    : 'branches',
    required : false,
    type     : 'object',  // arrays are typeof 'object' in JS; further validated below
    validate : (v, step) => {
      if (v == null) return { ok: true };
      if (!Array.isArray(v)) {
        return { ok: false, reason: '"branches" must be an array' };
      }
      // Empty array allowed — represents an in-progress authoring state.
      // Engine treats no-branches identically to empty-branches (plain CLICK_BY_LABEL).
      if (step.action !== ACTION_TYPES.CLICK_BY_LABEL) {
        return { ok: false, reason: `"branches" only allowed on CLICK_BY_LABEL actions, got "${step.action}"` };
      }
      const seenLabels = new Set();
      const allowedBranchActions = new Set([
        ACTION_TYPES.CLICK_BY_LABEL,
        ACTION_TYPES.WAIT,
        ACTION_TYPES.WAIT_FOR,
      ]);
      let hasCblBranch = false;
      for (let i = 0; i < v.length; i++) {
        const b = v[i];
        if (!b || typeof b !== 'object' || Array.isArray(b)) {
          return { ok: false, reason: `branches[${i}] must be an object` };
        }
        if (typeof b.label !== 'string' || b.label.trim() === '') {
          return { ok: false, reason: `branches[${i}]: "label" must be a non-empty string` };
        }
        if (seenLabels.has(b.label)) {
          return { ok: false, reason: `branches[${i}]: duplicate label "${b.label}"` };
        }
        seenLabels.add(b.label);
        if (!allowedBranchActions.has(b.action)) {
          return { ok: false, reason: `branches[${i}]: action must be CLICK_BY_LABEL, WAIT, or WAIT_FOR, got "${b.action}"` };
        }
        if (typeof b.selector !== 'string') {
          return { ok: false, reason: `branches[${i}]: "selector" must be a string` };
        }
        // Per-action sub-validation. v2.74.3 — CLICK_BY_LABEL branches
        // no longer carry their own value; reject if present to enforce
        // the chain-level bodyValue contract. WAIT requires numeric value.
        // WAIT_FOR has no value field.
        if (b.action === ACTION_TYPES.CLICK_BY_LABEL) {
          hasCblBranch = true;
          if (b.selector.trim() === '') {
            return { ok: false, reason: `branches[${i}]: CLICK_BY_LABEL "selector" cannot be empty` };
          }
          if (b.value !== undefined && b.value !== '') {
            return { ok: false, reason: `branches[${i}]: CLICK_BY_LABEL branches must not carry their own "value" — chain bodyValue is used instead` };
          }
        } else if (b.action === ACTION_TYPES.WAIT) {
          if (typeof b.value !== 'string') {
            return { ok: false, reason: `branches[${i}]: WAIT branch "value" must be a string` };
          }
          const ms = Number(b.value);
          if (isNaN(ms) || ms < 0) {
            return { ok: false, reason: `branches[${i}]: WAIT "value" must be a non-negative numeric string, got "${b.value}"` };
          }
        } else if (b.action === ACTION_TYPES.WAIT_FOR) {
          if (b.selector.trim() === '') {
            return { ok: false, reason: `branches[${i}]: WAIT_FOR "selector" cannot be empty` };
          }
        }
      }
      // v2.74.3 — When the chain has any CLICK_BY_LABEL branch, the
      // chain step MUST carry bodyValue. Without it, those branches have
      // no value to click at runtime. Validated here (rather than in the
      // bodyValue field's own validate) because the requirement is
      // conditional on branches' contents.
      if (hasCblBranch) {
        if (typeof step.bodyValue !== 'string' || step.bodyValue.trim() === '') {
          return { ok: false, reason: '"bodyValue" required on chain when any branch is CLICK_BY_LABEL' };
        }
      }
      return { ok: true };
    },
  },
  {
    // v2.74.3 — Chain bodyValue. The single layer-2 selection slot for
    // an action chain. Allowed only on CLICK_BY_LABEL steps; required
    // when the chain has any CLICK_BY_LABEL branch (validated in the
    // branches rule above for cross-field check). When present, must be
    // a non-empty string.
    field    : 'bodyValue',
    required : false,
    type     : 'string',
    validate : (v, step) => {
      if (v == null) return { ok: true };
      if (step.action !== ACTION_TYPES.CLICK_BY_LABEL) {
        return { ok: false, reason: `"bodyValue" only allowed on CLICK_BY_LABEL actions, got "${step.action}"` };
      }
      // bodyValue without branches is allowed but useless. Don't error;
      // schema accepts dormant fields. Empty string also allowed here —
      // the conditional requirement (when CLICK_BY_LABEL branches exist)
      // is enforced in the branches rule.
      return { ok: true };
    },
  },
  // v2.74.156 — ACTION_GATE shape rules. The gate carries:
  //   - condition: { type, ...per-type fields } — the header condition
  //   - negate:    boolean — when true, inverts the satisfaction check
  //   - body:      Step[] — sub-actions that run conditionally
  // Each is required on ACTION_GATE and forbidden on other action
  // types so a typo in the action field doesn't silently pull in
  // ignored fields.
  {
    field    : 'condition',
    required : false,
    type     : 'object',
    validate : (v, step) => {
      if (step.action !== ACTION_TYPES.ACTION_GATE) {
        if (v != null) return { ok: false, reason: `"condition" only allowed on ACTION_GATE actions, got "${step.action}"` };
        return { ok: true };
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, reason: 'ACTION_GATE "condition" must be an object' };
      }
      if (typeof v.type !== 'string' || v.type.trim() === '') {
        return { ok: false, reason: 'ACTION_GATE condition: "type" must be a non-empty string (e.g. "selector_present")' };
      }
      return { ok: true };
    },
  },
  {
    field    : 'negate',
    required : false,
    type     : 'boolean',
    validate : (v, step) => {
      if (v == null) return { ok: true };
      if (step.action !== ACTION_TYPES.ACTION_GATE) {
        return { ok: false, reason: `"negate" only allowed on ACTION_GATE actions, got "${step.action}"` };
      }
      return { ok: true };
    },
  },
  {
    field    : 'body',
    required : false,
    type     : 'object',  // arrays are typeof 'object' in JS
    validate : (v, step) => {
      if (step.action !== ACTION_TYPES.ACTION_GATE) {
        if (v != null) return { ok: false, reason: `"body" only allowed on ACTION_GATE actions, got "${step.action}"` };
        return { ok: true };
      }
      if (!Array.isArray(v)) {
        return { ok: false, reason: 'ACTION_GATE "body" must be an array' };
      }
      // Empty body is allowed (authoring-in-progress state). Each body
      // entry's full schema is NOT re-validated here — the rest of the
      // STEP_SCHEMA_RULES validate inner steps independently when the
      // runtime walks them. We just enforce shape sanity: each entry
      // must be an object with a string action field. Deeper checks
      // (selector requirements per action type) live where they belong
      // (those same rules apply to body entries at runtime).
      for (let i = 0; i < v.length; i++) {
        const b = v[i];
        if (!b || typeof b !== 'object' || Array.isArray(b)) {
          return { ok: false, reason: `body[${i}] must be an object` };
        }
        if (typeof b.action !== 'string') {
          return { ok: false, reason: `body[${i}]: "action" must be a string` };
        }
        if (!Object.values(ACTION_TYPES).includes(b.action)) {
          return { ok: false, reason: `body[${i}]: unknown action "${b.action}"` };
        }
        // Nested gates allowed — runtime evaluates them recursively.
      }
      return { ok: true };
    },
  },
  // v2.74.163 — Optional `frameUrl` field. When set, runtime resolves
  // the matching same-origin iframe at dispatch time and runs the
  // action there. Absent (or empty) on top-frame actions, which keeps
  // the existing rawJson shape unchanged for the common case. Any
  // action type may carry a frameUrl — the gate body sub-actions
  // included.
  {
    field    : 'frameUrl',
    required : false,
    type     : 'string',
    validate : (v) => {
      if (v == null || v === '') return { ok: true };
      if (typeof v !== 'string') {
        return { ok: false, reason: '"frameUrl" must be a string' };
      }
      // Light sanity check — non-empty, looks like a URL. Schema doesn't
      // validate origin against the top frame here; that lives at the
      // runtime resolver (TemplateWalker._resolveFrameId), where the
      // tab's current frames are enumerated and matched.
      return { ok: true };
    },
  },
  // v2.74.201 — Optional `waitTimeout` field on ACTION_GATE steps.
  // When > 0, the runtime retries the gate condition for that many ms
  // (TemplateWalker.checkConditions retry loop) before deciding.
  // Absent / 0 keeps one-shot behavior. Type check only — runtime
  // clamps to non-negative.
  {
    field    : 'waitTimeout',
    required : false,
    type     : 'number',
    validate : (v, step) => {
      if (v == null) return { ok: true };
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        return { ok: false, reason: `"waitTimeout" must be a non-negative number (ms), got ${JSON.stringify(v)}` };
      }
      if (step.action !== ACTION_TYPES.ACTION_GATE && v > 0) {
        return { ok: false, reason: `"waitTimeout" only meaningful on ACTION_GATE actions (got action="${step.action}")` };
      }
      return { ok: true };
    },
  },
  // v2.74.306 — Phase 2 of ACTION_SPEC compliance. Optional `effect`
  // annotation per § 5. Substrate-level browser effect declared on the
  // Action. Absent === { kind: 'none' } (the default). When present,
  // must be an object with a valid kind, and the structured parameter
  // (form / modalKind) must match the kind.
  {
    field    : 'effect',
    required : false,
    type     : 'object',
    validate : (v) => {
      if (v == null) return { ok: true };
      if (typeof v !== 'object' || Array.isArray(v)) {
        return { ok: false, reason: '"effect" must be an object { kind, form?, modalKind? }' };
      }
      const EFFECT_KINDS = ['none', 'opens-new-thread', 'triggers-navigation', 'triggers-modal', 'triggers-download'];
      if (typeof v.kind !== 'string' || !EFFECT_KINDS.includes(v.kind)) {
        return { ok: false, reason: `"effect.kind" must be one of ${EFFECT_KINDS.join(' | ')}, got ${JSON.stringify(v.kind)}` };
      }
      if (v.kind === 'opens-new-thread') {
        const FORMS = ['tab', 'window', 'popup', 'sidebar'];
        if (v.form != null && !FORMS.includes(v.form)) {
          return { ok: false, reason: `"effect.form" must be one of ${FORMS.join(' | ')} for opens-new-thread, got ${JSON.stringify(v.form)}` };
        }
      }
      if (v.kind === 'triggers-modal') {
        const MODAL_KINDS = ['alert', 'confirm', 'prompt'];
        if (v.modalKind != null && !MODAL_KINDS.includes(v.modalKind)) {
          return { ok: false, reason: `"effect.modalKind" must be one of ${MODAL_KINDS.join(' | ')} for triggers-modal, got ${JSON.stringify(v.modalKind)}` };
        }
      }
      return { ok: true };
    },
  },
  // v2.74.316 — Optional `repeat` count for KEY actions. Sends the key
  // N times (ArrowDown ×5, Tab ×3, …). Absent === 1. KEY-only; 1–50.
  {
    field    : 'repeat',
    required : false,
    type     : 'number',
    validate : (v, step) => {
      if (v == null) return { ok: true };
      if (!Number.isInteger(v) || v < 1 || v > 50) {
        return { ok: false, reason: `"repeat" must be an integer 1–50, got ${JSON.stringify(v)}` };
      }
      if (step.action !== ACTION_TYPES.KEY && v !== 1) {
        return { ok: false, reason: `"repeat" only applies to KEY actions (got action="${step.action}")` };
      }
      return { ok: true };
    },
  },
  // v2.74.306 — Optional `interactionPattern` (our DOM-level intel field,
  // separate from substrate effect). Open-ish vocabulary; absent === 'none'.
  {
    field    : 'interactionPattern',
    required : false,
    type     : 'string',
    validate : (v) => {
      if (v == null || v === '') return { ok: true };
      const PATTERNS = ['none', 'opens-menu', 'switches-tab', 'toggles-expansion', 'toggles-state', 'submits-in-place', 'mutates-page'];
      if (!PATTERNS.includes(v)) {
        return { ok: false, reason: `"interactionPattern" must be one of ${PATTERNS.join(' | ')}, got ${JSON.stringify(v)}` };
      }
      return { ok: true };
    },
  },
];

// ─── Types (JSDoc-only, no runtime overhead) ─────────────────────────────────

/**
 * @typedef {Object} StepObject
 * @property {number} step     - 1-based sequential step index.
 * @property {string} action   - One of ACTION_TYPES.
 * @property {string} selector - CSS selector or XPath targeting the DOM element.
 * @property {string} value    - Payload for the action (URL, text, wait duration, etc.).
 */

/**
 * @typedef {Object} StepFieldRule
 * @property {string}   field    - Name of the field on the step object.
 * @property {boolean}  required - Whether absence of this field is an error.
 * @property {string}   type     - Expected typeof value.
 * @property {Function} validate - (value: any, stepObject: StepObject) => { ok: boolean, reason?: string }
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean}        valid    - True only when every step passes all rules.
 * @property {StepObject[]|null} steps - The parsed, validated steps on success; null on failure.
 * @property {string|null}    error    - Human-readable error message on failure; null on success.
 * @property {number|null}    stepIndex - 0-based index of the failing step; null on success.
 */

// ─── SchemaValidator class ────────────────────────────────────────────────────

/**
 * @class SchemaValidator
 * @classdesc Stateless service that validates raw LLM-generated JSON against the
 * canonical step schema. All methods are static; no instantiation is required.
 *
 * Design decisions:
 * - **Fail-fast**: validation halts at the first invalid step so the error message
 *   pinpoints the exact problem without overwhelming the developer with every issue.
 * - **Contextual rules**: some field rules receive the full step object so they
 *   can enforce cross-field constraints (e.g. action-dependent value requirements).
 * - **No external dependencies**: runs entirely in V8 without any npm packages.
 */
export class SchemaValidator {

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Parses a raw JSON string into a JavaScript value, capturing parse errors.
   *
   * @private
   * @param {string} rawJson - The JSON string produced by the LLM.
   * @returns {{ parsed: any, error: string|null }}
   */
  static #parseJson(rawJson) {
    try {
      return { parsed: JSON.parse(rawJson), error: null };
    } catch (err) {
      return { parsed: null, error: `JSON parse failure: ${err.message}` };
    }
  }

  /**
   * Asserts that the parsed value is a non-empty array.
   *
   * @private
   * @param {any} parsed - The value returned by JSON.parse.
   * @returns {{ ok: boolean, reason: string|null }}
   */
  static #assertIsArray(parsed) {
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: `Expected a JSON array at root, got ${typeof parsed}` };
    }
    if (parsed.length === 0) {
      return { ok: false, reason: 'Step array must not be empty' };
    }
    return { ok: true, reason: null };
  }

  /**
   * Validates a single step object against STEP_SCHEMA_RULES.
   *
   * @private
   * @param {any}    step      - The raw step value from the parsed array.
   * @param {number} stepIndex - 0-based array index, used for error messages.
   * @returns {{ ok: boolean, reason: string|null }}
   */
  static #validateStep(step, stepIndex) {
    if (typeof step !== 'object' || step === null || Array.isArray(step)) {
      return {
        ok     : false,
        reason : `Step at index ${stepIndex} must be a plain object, got ${Array.isArray(step) ? 'array' : typeof step}`,
      };
    }

    for (const rule of STEP_SCHEMA_RULES) {
      const value = step[rule.field];

      // Presence check
      if (rule.required && (value === undefined || value === null)) {
        return {
          ok     : false,
          reason : `Step ${stepIndex + 1}: required field "${rule.field}" is missing or null`,
        };
      }

      // Skip further checks for optional absent fields
      if (value === undefined || value === null) continue;

      // Type check
      // eslint-disable-next-line valid-typeof
      if (typeof value !== rule.type) {
        return {
          ok     : false,
          reason : `Step ${stepIndex + 1}: field "${rule.field}" expected type "${rule.type}", got "${typeof value}"`,
        };
      }

      // Constraint check (receives full step for cross-field awareness)
      const constraint = rule.validate(value, step);
      if (!constraint.ok) {
        return {
          ok     : false,
          reason : `Step ${stepIndex + 1}: ${constraint.reason}`,
        };
      }
    }

    return { ok: true, reason: null };
  }

  /**
   * Validates that step numbers are sequential and start at 1.
   * This is a post-pass check run only after all individual steps are valid.
   *
   * @private
   * @param {StepObject[]} steps - The array of validated step objects.
   * @returns {{ ok: boolean, reason: string|null }}
   */
  static #assertSequentialSteps(steps) {
    for (let i = 0; i < steps.length; i++) {
      if (steps[i].step !== i + 1) {
        return {
          ok     : false,
          reason : `Step numbering is not sequential: expected step ${i + 1} at index ${i}, found step ${steps[i].step}`,
        };
      }
    }
    return { ok: true, reason: null };
  }

  // ── Tree node validators ────────────────────────────────────────────────────

  /**
   * Validates a FOR_EACH node. Required fields: selector, itemSelector, body.
   * Optional: binding (default 'item'), max (default 50).
   * @private
   */
  static #validateForEach(node, path) {
    if (typeof node.selector !== 'string' || !node.selector.trim()) {
      return { ok: false, reason: `${path}: FOR_EACH requires non-empty "selector" (container)` };
    }
    if (typeof node.itemSelector !== 'string' || !node.itemSelector.trim()) {
      return { ok: false, reason: `${path}: FOR_EACH requires non-empty "itemSelector"` };
    }
    if (!Array.isArray(node.body) && typeof node.body !== 'object') {
      return { ok: false, reason: `${path}: FOR_EACH "body" must be an array of steps or a ProcedureNode object` };
    }
    if (node.binding !== undefined && typeof node.binding !== 'string') {
      return { ok: false, reason: `${path}: FOR_EACH "binding" must be a string if provided` };
    }
    if (node.max !== undefined && (!Number.isInteger(node.max) || node.max < 1)) {
      return { ok: false, reason: `${path}: FOR_EACH "max" must be a positive integer` };
    }
    // Recursively validate body
    const bodyCheck = SchemaValidator.#validateNode(node.body, `${path}.body`);
    if (!bodyCheck.ok) return bodyCheck;
    return { ok: true };
  }

  /**
   * Validates a DETECT node. Required: branches (array). Optional: default.
   * Each branch needs label (string), condition (object), body (ProcedureNode).
   * @private
   */
  static #validateDetect(node, path) {
    if (!Array.isArray(node.branches) || node.branches.length === 0) {
      return { ok: false, reason: `${path}: DETECT requires non-empty "branches" array` };
    }
    for (let i = 0; i < node.branches.length; i++) {
      const b = node.branches[i];
      const branchPath = `${path}.branches[${i}]`;
      if (typeof b.label !== 'string' || !b.label.trim()) {
        return { ok: false, reason: `${branchPath}: branch requires non-empty "label"` };
      }
      const condCheck = SchemaValidator.#validateCondition(b.condition, branchPath);
      if (!condCheck.ok) return condCheck;
      if (!Array.isArray(b.body) && typeof b.body !== 'object') {
        return { ok: false, reason: `${branchPath}: branch "body" must be an array or ProcedureNode object` };
      }
      const bodyCheck = SchemaValidator.#validateNode(b.body, `${branchPath}.body`);
      if (!bodyCheck.ok) return bodyCheck;
    }
    if (node.default !== undefined && node.default !== null) {
      const defCheck = SchemaValidator.#validateNode(node.default, `${path}.default`);
      if (!defCheck.ok) return defCheck;
    }
    return { ok: true };
  }

  /**
   * Validates a DETECT branch condition. Five condition types supported.
   * @private
   */
  static #validateCondition(cond, path) {
    if (!cond || typeof cond !== 'object') {
      return { ok: false, reason: `${path}: condition must be an object` };
    }
    const validTypes = Object.values({
      SELECTOR_PRESENT  : 'selector_present',
      SELECTOR_ABSENT   : 'selector_absent',
      URL_MATCHES       : 'url_matches',
      TEXT_PRESENT      : 'text_present',
      ATTRIBUTE_EQUALS  : 'attribute_equals',
    });
    if (!validTypes.includes(cond.type)) {
      return { ok: false, reason: `${path}: condition.type must be one of [${validTypes.join(', ')}], got "${cond.type}"` };
    }
    switch (cond.type) {
      case 'selector_present':
      case 'selector_absent':
        if (typeof cond.selector !== 'string' || !cond.selector.trim()) {
          return { ok: false, reason: `${path}: ${cond.type} requires non-empty "selector"` };
        }
        break;
      case 'url_matches':
        if (typeof cond.pattern !== 'string' || !cond.pattern.trim()) {
          return { ok: false, reason: `${path}: url_matches requires non-empty "pattern"` };
        }
        break;
      case 'text_present':
        if (typeof cond.text !== 'string' || !cond.text) {
          return { ok: false, reason: `${path}: text_present requires non-empty "text"` };
        }
        break;
      case 'attribute_equals':
        if (typeof cond.selector !== 'string' || !cond.selector.trim()) {
          return { ok: false, reason: `${path}: attribute_equals requires non-empty "selector"` };
        }
        if (typeof cond.attribute !== 'string' || !cond.attribute.trim()) {
          return { ok: false, reason: `${path}: attribute_equals requires non-empty "attribute"` };
        }
        if (typeof cond.value !== 'string') {
          return { ok: false, reason: `${path}: attribute_equals requires string "value"` };
        }
        break;
    }
    return { ok: true };
  }

  /**
   * Validates any ProcedureNode — an array of steps (linear/implicit SEQUENCE),
   * or a tree node with type = FOR_EACH | DETECT | SEQUENCE.
   *
   * Steps inside an array (body of FOR_EACH, DETECT branch, or SEQUENCE) are
   * validated via #validateStep but NOT required to be sequentially numbered —
   * step numbers inside tree bodies are informational, not structural.
   * @private
   */
  static #validateNode(node, path = 'root') {
    // Linear case — an array of steps (possibly containing nested nodes)
    if (Array.isArray(node)) {
      if (node.length === 0) {
        return { ok: false, reason: `${path}: empty array is not a valid procedure body` };
      }
      for (let i = 0; i < node.length; i++) {
        const child = node[i];
        // Child can be a Step object OR a nested tree node
        if (child && typeof child === 'object' && !Array.isArray(child) && child.type) {
          const nodeCheck = SchemaValidator.#validateNode(child, `${path}[${i}]`);
          if (!nodeCheck.ok) return nodeCheck;
        } else {
          const stepCheck = SchemaValidator.#validateStep(child, i);
          if (!stepCheck.ok) return { ok: false, reason: `${path}: ${stepCheck.reason}` };
        }
      }
      return { ok: true };
    }

    // Tree node — dispatch on type
    if (!node || typeof node !== 'object') {
      return { ok: false, reason: `${path}: expected array or tree node object, got ${typeof node}` };
    }
    switch (node.type) {
      case 'FOR_EACH': return SchemaValidator.#validateForEach(node, path);
      case 'DETECT':   return SchemaValidator.#validateDetect(node, path);
      case 'SEQUENCE': {
        if (!Array.isArray(node.body)) {
          return { ok: false, reason: `${path}: SEQUENCE requires "body" array` };
        }
        return SchemaValidator.#validateNode(node.body, `${path}.body`);
      }
      default:
        return { ok: false, reason: `${path}: unknown node type "${node.type}" (expected FOR_EACH, DETECT, or SEQUENCE)` };
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Validates a raw JSON string produced by an LLM against the canonical step schema.
   *
   * The full validation pipeline:
   * 1. JSON parse the raw string.
   * 2. Assert the root value is a non-empty array.
   * 3. For each element, run all STEP_SCHEMA_RULES (fail-fast per step).
   * 4. Assert sequential, 1-based step numbering.
   *
   * @param {string} rawJson - Raw JSON string from the LLM response.
   * @returns {ValidationResult} Structured result indicating validity, parsed steps, and any error.
   *
   * @example
   * const raw = JSON.stringify([
   *   { step: 1, action: 'NAVIGATE', selector: '', value: 'https://example.com' },
   *   { step: 2, action: 'TYPE', selector: '#q', value: '{{USER_QUESTION}}' },
   *   { step: 3, action: 'CLICK', selector: 'button[type=submit]', value: '' },
   *   { step: 4, action: 'EXTRACT', selector: '#result', value: '' },
   * ]);
   *
   * const result = SchemaValidator.validate(raw);
   * if (!result.valid) {
   *   console.error(result.error); // e.g. 'Step 2: "selector" cannot be empty for action "CLICK"'
   * }
   */
  /**
   * Validates a raw JSON string produced by an LLM against the canonical
   * Procedure schema. Supports both linear (array of steps) and tree forms:
   *
   *   Linear:  [ {step:1, action:'NAVIGATE', ...}, ... ]
   *   Tree:    { type:'FOR_EACH', selector:..., body:[...] }
   *            { type:'DETECT', branches:[...], default:[...] }
   *            { type:'SEQUENCE', body:[...] }
   *
   * Linear Procedures retain their original validation — sequential 1-based
   * step numbering is enforced. Tree Procedures relax numbering because step
   * indices inside tree bodies are informational, not structural.
   *
   * On success, `result.steps` carries an array (linear) or the tree root
   * node (tree). Callers that historically expected an array can feature-
   * detect with `Array.isArray(result.steps)`.
   *
   * @param {string} rawJson - Raw JSON string from the LLM response.
   * @returns {ValidationResult}
   */
  static validate(rawJson) {
    Logger.info('SchemaValidator', `Validating payload (${rawJson?.length ?? 0} chars)`);

    // ── Stage 1: JSON Parse ──────────────────────────────────────────────────
    const { parsed, error: parseError } = SchemaValidator.#parseJson(rawJson);
    if (parseError) {
      Logger.warn('SchemaValidator', `Parse error: ${parseError}`);
      return { valid: false, steps: null, error: parseError, stepIndex: null };
    }

    // ── Stage 2: Dispatch on shape ───────────────────────────────────────────
    // Linear case: array of steps. Tree case: object with a type field.
    const isTreeRoot = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof parsed.type === 'string';

    if (isTreeRoot) {
      const nodeCheck = SchemaValidator.#validateNode(parsed, 'root');
      if (!nodeCheck.ok) {
        Logger.warn('SchemaValidator', `Tree validation failed: ${nodeCheck.reason}`);
        return { valid: false, steps: null, error: nodeCheck.reason, stepIndex: null };
      }
      Logger.info('SchemaValidator', `Validation passed — tree procedure (root type: ${parsed.type})`);
      return { valid: true, steps: parsed, error: null, stepIndex: null };
    }

    // ── Linear path — preserve original semantics ────────────────────────────
    const arrayCheck = SchemaValidator.#assertIsArray(parsed);
    if (!arrayCheck.ok) {
      Logger.warn('SchemaValidator', `Array check failed: ${arrayCheck.reason}`);
      return { valid: false, steps: null, error: arrayCheck.reason, stepIndex: null };
    }

    // A linear array may contain nested tree nodes as elements. Detect and
    // route via #validateNode; otherwise run the original per-step loop so
    // fail-fast error messages include stepIndex for the UI editor.
    const containsTreeNodes = parsed.some(el => el && typeof el === 'object' && !Array.isArray(el) && typeof el.type === 'string');
    if (containsTreeNodes) {
      const nodeCheck = SchemaValidator.#validateNode(parsed, 'root');
      if (!nodeCheck.ok) {
        Logger.warn('SchemaValidator', `Mixed-tree validation failed: ${nodeCheck.reason}`);
        return { valid: false, steps: null, error: nodeCheck.reason, stepIndex: null };
      }
      Logger.info('SchemaValidator', `Validation passed — ${parsed.length} element(s), contains tree nodes`);
      return { valid: true, steps: parsed, error: null, stepIndex: null };
    }

    // Pure linear — original pipeline (fail-fast with stepIndex)
    for (let i = 0; i < parsed.length; i++) {
      const { ok, reason } = SchemaValidator.#validateStep(parsed[i], i);
      if (!ok) {
        Logger.warn('SchemaValidator', `Step validation failed at index ${i}: ${reason}`);
        return { valid: false, steps: null, error: reason, stepIndex: i };
      }
    }

    const seqCheck = SchemaValidator.#assertSequentialSteps(parsed);
    if (!seqCheck.ok) {
      Logger.warn('SchemaValidator', `Sequence check failed: ${seqCheck.reason}`);
      return { valid: false, steps: null, error: seqCheck.reason, stepIndex: null };
    }

    Logger.info('SchemaValidator', `Validation passed — ${parsed.length} step(s) accepted (linear)`);
    return { valid: true, steps: parsed, error: null, stepIndex: null };
  }

  /**
   * Convenience wrapper that validates and throws on failure.
   * Prefer {@link SchemaValidator.validate} in non-throwing contexts (e.g. UI feedback loops).
   *
   * @param {string} rawJson - Raw JSON string from the LLM response.
   * @returns {StepObject[]} The validated, parsed step array.
   * @throws {TypeError} When the JSON is invalid or any step fails schema rules.
   *
   * @example
   * try {
   *   const steps = SchemaValidator.validateOrThrow(llmOutput);
   *   await executionEngine.enqueue(steps, question);
   * } catch (err) {
   *   reportService.recordError(err.message);
   * }
   */
  static validateOrThrow(rawJson) {
    const result = SchemaValidator.validate(rawJson);
    if (!result.valid) {
      throw new TypeError(`SchemaValidator: ${result.error}`);
    }
    return result.steps;
  }

  /**
   * Returns a human-readable summary of the schema rules for use in LLM system prompts.
   * Inject this into your prompt so the model knows exactly what to produce.
   *
   * @returns {string} Markdown-formatted schema description.
   */
  /**
   * Count the number of leaf steps in a ProcedureNode. A leaf is any Step
   * object. FOR_EACH contributes `max` × leaves-in-body because we can't
   * know runtime iteration count without executing (upper bound for progress).
   * DETECT contributes the max of its branches (pessimistic).
   *
   * Used by ExecutionEngine to report progress as a percentage during tree
   * walks. For linear procedures this matches today's `steps.length` exactly.
   *
   * @param {Array|Object} node - ProcedureNode (array or tree node)
   * @returns {number}
   */
  static countLeaves(node) {
    if (Array.isArray(node)) {
      return node.reduce((sum, child) => {
        if (child && typeof child === 'object' && typeof child.type === 'string') {
          return sum + SchemaValidator.countLeaves(child);
        }
        return sum + 1;
      }, 0);
    }
    if (!node || typeof node !== 'object') return 0;
    switch (node.type) {
      case 'FOR_EACH': {
        const bodyLeaves = SchemaValidator.countLeaves(node.body);
        const max = node.max ?? 50;
        return bodyLeaves * max;
      }
      case 'DETECT': {
        let mx = 0;
        for (const b of node.branches ?? []) {
          mx = Math.max(mx, SchemaValidator.countLeaves(b.body));
        }
        if (node.default) mx = Math.max(mx, SchemaValidator.countLeaves(node.default));
        return mx;
      }
      case 'SEQUENCE':
        return SchemaValidator.countLeaves(node.body);
      default:
        return 0;
    }
  }

  static describeSchema() {
    return `
## Expected JSON Schema

A Procedure is either:

### Linear (recommended for simple flows)
A JSON **array** of step objects. Each step contains:

| Field      | Type   | Constraints                                                                     |
|------------|--------|---------------------------------------------------------------------------------|
| \`step\`     | number | Positive integer, sequential starting at 1                                      |
| \`action\`   | string | One of: NAVIGATE, CLICK, TYPE, WAIT, WAIT_FOR, FIND_AI, EXTRACT                 |
| \`selector\` | string | CSS selector; may be empty for NAVIGATE, WAIT, and FIND_AI                     |
| \`value\`    | string | URL for NAVIGATE; ms for WAIT; timeout ms for WAIT_FOR/FIND_AI; {{USER_QUESTION}} for TYPE |

### Tree (for iteration or branching)
A JSON **object** with one of:

- \`{ "type": "FOR_EACH", "selector": "<container>", "itemSelector": "<item>", "body": <ProcedureNode>, "binding": "item", "max": 50 }\`
  Iterates the matching items. Body steps may reference \`$item\` in selectors.

- \`{ "type": "DETECT", "branches": [ { "label": "<name>", "condition": {...}, "body": <ProcedureNode> } ], "default": <ProcedureNode> }\`
  Evaluates branches in order; runs first matching body. Conditions:
    - \`{ "type": "selector_present", "selector": "..." }\`
    - \`{ "type": "selector_absent",  "selector": "..." }\`
    - \`{ "type": "url_matches",      "pattern": "..." }\`
    - \`{ "type": "text_present",     "text": "..." }\`
    - \`{ "type": "attribute_equals", "selector": "...", "attribute": "...", "value": "..." }\`

- \`{ "type": "SEQUENCE", "body": [...] }\` — optional explicit wrapper (arrays are implicit).

**Action reference:**
- \`NAVIGATE\` — load a URL. selector: "", value: "https://..."
- \`CLICK\`    — click an element. selector: required, value: ""
- \`TYPE\`     — type into an input. selector: required, value: "{{USER_QUESTION}}"
- \`WAIT\`     — unconditional pause. selector: "", value: milliseconds as string
- \`WAIT_FOR\` — poll DOM until selector appears (max value ms). selector: required, value: timeout ms
- \`FIND_AI\`  — heuristic scan for any AI assistant entry point and click it. selector: "", value: timeout ms
- \`EXTRACT\`  — read element text. selector: required (or empty for full page), value: ""

**Important**: For any TYPE action that represents the user's test input, use the literal
placeholder \`{{USER_QUESTION}}\` as the value. Do not hardcode example questions.
    `.trim();
  }
}
