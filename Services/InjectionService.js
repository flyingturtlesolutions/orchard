/**
 * @file Services/InjectionService.js
 * @description Variable-Injected Execution service. Responsible for cloning a validated
 * template step array and replacing every occurrence of the canonical placeholder
 * `{{USER_QUESTION}}` with the actual test question at runtime — immediately before
 * the steps are handed to the ExecutionEngine.
 *
 * Design principles:
 * - **Immutability**: The original template steps are never mutated. Each call
 *   produces a structurally independent deep-clone with replacements applied,
 *   enabling safe concurrent test runs against the same template.
 * - **Determinism**: The same (steps, question) input always produces identical output.
 * - **Auditability**: Every injection is logged with the step index and the sanitised
 *   question so the test report can trace exactly what was sent to the DOM.
 * - **Sanitisation gate**: The question is sanitised before injection to strip characters
 *   that could break CSS selectors or DOM manipulation calls if the string were ever
 *   accidentally interpreted as structured input.
 *
 * @module Services/InjectionService
 * @author Agent HUB
 */

import { Logger } from '../Core/Logger.js';

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * The canonical placeholder string that the LLM template must use inside any
 * TYPE step value to mark where the real test question will be injected.
 *
 * This is a "mustache-style" double-brace token chosen because:
 *  - It is visually distinct and unlikely to appear in natural text.
 *  - It matches the convention used in the LLM system prompt so the model
 *    reliably produces it without hallucinating alternative formats.
 *
 * @constant {string}
 */
export const INJECTION_PLACEHOLDER = '{{USER_QUESTION}}';

/**
 * Maximum length (characters) allowed for a question after sanitisation.
 * Matches the Ground configuration maximum to ensure consistency.
 *
 * @constant {number}
 */
const MAX_QUESTION_LENGTH = 100;

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} StepObject
 * @property {number} step     - 1-based sequential step index.
 * @property {string} action   - One of: NAVIGATE | CLICK | TYPE | WAIT | EXTRACT.
 * @property {string} selector - CSS selector or XPath targeting the DOM element.
 * @property {string} value    - Payload for the action.
 */

/**
 * @typedef {Object} InjectionResult
 * @property {boolean}       success  - True when injection completed without errors.
 * @property {StepObject[]|null} steps - The injected step array on success; null on failure.
 * @property {number}        injectionCount - How many placeholder occurrences were replaced.
 * @property {string}        sanitisedQuestion - The question value actually injected.
 * @property {string|null}   error    - Error message on failure; null on success.
 */

// ─── InjectionService class ───────────────────────────────────────────────────

/**
 * @class InjectionService
 * @classdesc Stateless service that performs variable injection on a validated
 * step template. All methods are static; no instantiation required.
 *
 * Typical usage:
 * ```js
 * const validated = SchemaValidator.validateOrThrow(llmJson);
 * const { success, steps } = InjectionService.inject(validated, userQuestion);
 * if (success) executionEngine.enqueue(steps);
 * ```
 */
export class InjectionService {

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Sanitises the raw question string before it is injected into step values.
   *
   * Sanitisation rules:
   * 1. Trim leading and trailing whitespace.
   * 2. Collapse internal runs of whitespace (including newlines) to a single space.
   * 3. Truncate to MAX_QUESTION_LENGTH characters.
   * 4. Remove null bytes and other non-printable control characters (U+0000–U+001F,
   *    U+007F) to prevent injection into contenteditable fields or terminal output.
   *
   * Note: This does NOT HTML-encode the question. The ContentScript already calls
   * `element.value = text` or `element.textContent = text`, which are safe assignment
   * APIs that never interpret the string as markup.
   *
   * @private
   * @param {string} rawQuestion - The user-supplied test question.
   * @returns {string} The sanitised question, safe for DOM injection.
   * @throws {RangeError} When the question is empty after sanitisation.
   */
  static #sanitise(rawQuestion) {
    if (typeof rawQuestion !== 'string') {
      throw new TypeError(
        `InjectionService: question must be a string, got ${typeof rawQuestion}`
      );
    }

    // Step 1: Trim outer whitespace
    let clean = rawQuestion.trim();

    // Step 2: Collapse internal whitespace / newlines
    clean = clean.replace(/\s+/g, ' ');

    // Step 3: Strip control characters (keep printable ASCII + Unicode)
    // U+0000–U+001F: C0 controls (includes \t \n \r \0)
    // U+007F: DEL
    // We already collapsed whitespace above, so these are truly non-printable remnants.
    clean = clean.replace(/[\u0000-\u001F\u007F]/g, '');

    // Step 4: Enforce length cap
    if (clean.length > MAX_QUESTION_LENGTH) {
      Logger.warn(
        'InjectionService',
        `Question truncated from ${clean.length} to ${MAX_QUESTION_LENGTH} chars`
      );
      clean = clean.slice(0, MAX_QUESTION_LENGTH);
    }

    if (clean.length === 0) {
      throw new RangeError(
        'InjectionService: question is empty after sanitisation — cannot inject'
      );
    }

    return clean;
  }

  /**
   * Deep-clones the step array using structured serialisation.
   * Using JSON round-trip guarantees a truly independent copy with no shared
   * object references, making concurrent injection calls safe.
   *
   * @private
   * @param {StepObject[]} steps - The validated original step array.
   * @returns {StepObject[]} A fully independent clone.
   */
  static #deepClone(steps) {
    return JSON.parse(JSON.stringify(steps));
  }

  /**
   * Replaces ALL occurrences of `INJECTION_PLACEHOLDER` within a single string.
   * Uses a literal `split/join` strategy instead of RegExp.replace to avoid
   * any edge cases with special regex characters in the placeholder token.
   *
   * @private
   * @param {string} source      - The original string (the step's `value` field).
   * @param {string} replacement - The sanitised question to inject.
   * @returns {{ result: string, count: number }} The modified string and replacement count.
   */
  static #replacePlaceholders(source, replacement) {
    const parts = source.split(INJECTION_PLACEHOLDER);
    const count = parts.length - 1;           // n splits = n occurrences
    return {
      result : parts.join(replacement),
      count,
    };
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Clones the validated step array and replaces every `{{USER_QUESTION}}`
   * placeholder in every step's `value` field with the sanitised test question.
   *
   * Steps without the placeholder are copied unchanged. The original `steps`
   * array is never modified.
   *
   * @param {StepObject[]} steps       - Validated step array from SchemaValidator.
   * @param {string}       rawQuestion - The user-supplied test question (max 100 chars).
   * @returns {InjectionResult} Structured result with the injected step clone.
   *
   * @example
   * // Template step: { step: 2, action: 'TYPE', selector: '#q', value: '{{USER_QUESTION}}' }
   * const result = InjectionService.inject(validatedSteps, 'What is the capital of France?');
   * // Injected step: { step: 2, action: 'TYPE', selector: '#q', value: 'What is the capital of France?' }
   *
   * if (result.success) {
   *   console.log(`Injected into ${result.injectionCount} step(s)`);
   *   executionEngine.enqueue(result.steps);
   * }
   */
  static inject(steps, rawQuestion) {
    Logger.info(
      'InjectionService',
      `Beginning injection for ${steps.length} step(s) with question: "${rawQuestion}"`
    );

    // ── Sanitise ─────────────────────────────────────────────────────────────
    let sanitisedQuestion;
    try {
      sanitisedQuestion = InjectionService.#sanitise(rawQuestion);
    } catch (err) {
      Logger.error('InjectionService', `Sanitisation failed: ${err.message}`);
      return {
        success           : false,
        steps             : null,
        injectionCount    : 0,
        sanitisedQuestion : '',
        error             : err.message,
      };
    }

    // ── Clone ─────────────────────────────────────────────────────────────────
    const clonedSteps = InjectionService.#deepClone(steps);

    // ── Inject ────────────────────────────────────────────────────────────────
    let totalInjectionCount = 0;

    for (const step of clonedSteps) {
      // Only `value` fields carry the placeholder per schema contract.
      // We still guard against pathological templates by checking all string fields.
      for (const field of ['value', 'selector']) {
        if (typeof step[field] !== 'string') continue;
        if (!step[field].includes(INJECTION_PLACEHOLDER)) continue;

        const { result, count } = InjectionService.#replacePlaceholders(
          step[field],
          sanitisedQuestion
        );

        Logger.info(
          'InjectionService',
          `Step ${step.step} [${step.action}]: replaced ${count} placeholder(s) in field "${field}"`
        );

        step[field]        = result;
        totalInjectionCount += count;
      }
    }

    if (totalInjectionCount === 0) {
      // Non-fatal: template may legitimately have no TYPE steps with the placeholder
      // (e.g. a pure navigation test). Log a warning so developers can audit.
      Logger.warn(
        'InjectionService',
        `No occurrences of "${INJECTION_PLACEHOLDER}" found in ${steps.length} step(s). ` +
        `Returning cloned steps unchanged.`
      );
    }

    Logger.info(
      'InjectionService',
      `Injection complete — ${totalInjectionCount} total replacement(s) across ${clonedSteps.length} step(s)`
    );

    return {
      success           : true,
      steps             : clonedSteps,
      injectionCount    : totalInjectionCount,
      sanitisedQuestion,
      error             : null,
    };
  }

  /**
   * Convenience wrapper that injects and throws on any failure.
   * Use when calling code cannot handle a failed injection gracefully.
   *
   * @param {StepObject[]} steps       - Validated step array from SchemaValidator.
   * @param {string}       rawQuestion - The user-supplied test question.
   * @returns {StepObject[]} The injected step array, ready for execution.
   * @throws {Error} When sanitisation fails or the question is empty.
   *
   * @example
   * const executableSteps = InjectionService.injectOrThrow(validatedSteps, question);
   */
  static injectOrThrow(steps, rawQuestion) {
    const result = InjectionService.inject(steps, rawQuestion);
    if (!result.success) {
      throw new Error(`InjectionService: ${result.error}`);
    }
    return result.steps;
  }

  /**
   * Analyses a validated step array and returns which steps contain the
   * `{{USER_QUESTION}}` placeholder, enabling the UI to preview injection points
   * before a test run is committed.
   *
   * @param {StepObject[]} steps - Validated step array from SchemaValidator.
   * @returns {Array<{ stepNumber: number, action: string, field: string }>}
   *   Descriptors of every step and field that will be affected by injection.
   *
   * @example
   * const targets = InjectionService.findInjectionTargets(steps);
   * // [{ stepNumber: 2, action: 'TYPE', field: 'value' }]
   */
  static findInjectionTargets(steps) {
    /** @type {Array<{ stepNumber: number, action: string, field: string }>} */
    const targets = [];

    for (const step of steps) {
      for (const field of ['value', 'selector']) {
        if (
          typeof step[field] === 'string' &&
          step[field].includes(INJECTION_PLACEHOLDER)
        ) {
          targets.push({
            stepNumber : step.step,
            action     : step.action,
            field,
          });
        }
      }
    }

    Logger.info(
      'InjectionService',
      `Found ${targets.length} injection target(s) in ${steps.length} step(s)`
    );

    return targets;
  }

  /**
   * Returns true if the given step array contains at least one injection target.
   * Useful for quick pre-flight checks before starting a test run.
   *
   * @param {StepObject[]} steps - Validated step array.
   * @returns {boolean}
   */
  static hasInjectionTargets(steps) {
    return InjectionService.findInjectionTargets(steps).length > 0;
  }

  /**
   * Injects arbitrary {{PARAM_NAME}} parameters into a step array for task grounds.
   * @param {StepObject[]} steps  - Validated step array.
   * @param {Object} paramValues  - Map of PARAM_NAME → value
   * @returns {InjectionResult}
   */
  static injectParams(steps, paramValues = {}) {
    const clonedSteps   = InjectionService.#deepClone(steps);
    let totalInjections = 0;

    // v2.74.0 — Helper: substitute placeholders in a single field-bearing
    // object's selector + value. Used for both top-level steps and the
    // entries of a CLICK_BY_LABEL action chain's branches[].
    // v2.74.3 — Helper now also handles the bodyValue field on chain
    // steps (the chain-wide layer-2 slot).
    const substituteFields = (obj, fields = ['value', 'selector']) => {
      for (const field of fields) {
        if (typeof obj[field] !== 'string') continue;
        let val = obj[field];
        for (const [name, replacement] of Object.entries(paramValues)) {
          const placeholder = `{{${name}}}`;
          if (val.includes(placeholder)) {
            const parts = val.split(placeholder);
            totalInjections += parts.length - 1;
            val = parts.join(String(replacement ?? ''));
          }
        }
        // v2.74.809 — an UNFILLED param (its name absent from paramValues) must not be TYPED verbatim — a cross-Ground
        // workflow with an unstated optional input typed the literal "{{EDIT_LOCATION}}" into the search box. After
        // substituting known params, blank any REMAINING canonical {{PARAM_NAME}} token in a TYPED field so the unset
        // input is EMPTY. Selectors keep their token (a malformed selector fails loudly; emptying could match a wrong
        // node). USER_QUESTION is filled by a separate injection pass — exclude it.
        if (field !== 'selector') val = val.replace(/\{\{(?!USER_QUESTION\}\})[A-Z0-9_]+\}\}/g, '');
        obj[field] = val;
      }
    };

    for (const step of clonedSteps) {
      substituteFields(step);
      // v2.74.0 — Action-chain branches carry their own selector/value
      // pair per branch. Substitute those too so {{LAYER2}} resolves at
      // runtime the same way the head's {{LAYER1}} does.
      // v2.74.3 — Also substitute the chain-level bodyValue (one slot
      // shared by every CLICK_BY_LABEL branch in the chain).
      if (Array.isArray(step.branches)) {
        substituteFields(step, ['bodyValue']);
        for (const branch of step.branches) {
          if (branch && typeof branch === 'object') {
            substituteFields(branch);
          }
        }
      }
      // v2.74.158 — ACTION_GATE substitution. Tokens can live in two
      // places: (1) the header `condition` object's selector / pattern
      // / text / attribute / value fields (the dropdown-driven value
      // slots — e.g. `selector_present` carries selector; `url_matches`
      // carries pattern); (2) each body[] sub-action's selector /
      // value, same as a top-level action. Without these passes, a
      // gate with `selector_present` on `[data-id={{ID}}]` would probe
      // the literal token at runtime and the gate would never fire.
      if (step.action === 'ACTION_GATE') {
        if (step.condition && typeof step.condition === 'object') {
          substituteFields(step.condition, ['selector', 'pattern', 'text', 'attribute', 'value']);
        }
        if (Array.isArray(step.body)) {
          for (const sub of step.body) {
            if (sub && typeof sub === 'object') {
              substituteFields(sub);
            }
          }
        }
      }
    }

    Logger.info('InjectionService', `Injection complete — ${totalInjections} total replacement(s) across ${clonedSteps.length} step(s)`);
    return { success: true, steps: clonedSteps, injectionCount: totalInjections, error: null };
  }

  /**
   * Validates that all required parameters have non-empty values.
   * @param {string[]} requiredParams - PARAM_NAME strings from template.meta.params
   * @param {Object}   paramValues    - Runtime values map
   * @returns {{ valid: boolean, missing: string[] }}
   */
  static validateParams(requiredParams = [], paramValues = {}) {
    const missing = requiredParams.filter(name => {
      const val = paramValues[name];
      if (val === undefined || val === null) return true;
      const str = String(val).trim();
      if (str === '') return true;
      // Skip validation if the value is still a placeholder token
      if (/^\{\{[A-Z0-9_]+\}\}$/.test(str)) return false;
      return false;
    });
    return { valid: missing.length === 0, missing };
  }
}
