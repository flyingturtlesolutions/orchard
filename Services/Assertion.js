/**
 * @file Services/Assertion.js
 * @description Canonical assertion shape, normalization, and evaluation for
 * all six condition callsites in the DSL.
 *
 * v2.41.0 (Pass M1) — Unifies six divergent condition surfaces:
 *   1. Fragment preconditions
 *   2. Fragment postconditions
 *   3. DETECT branch condition
 *   4. LOOP while condition
 *   5. WAIT until condition
 *   6. (TRY recover_when — reserved, not yet implemented)
 *
 * Today, each callsite reads slightly different inline shapes. After M1,
 * all six accept a Assertion:
 *
 *   Assertion = {
 *     match: 'all' | 'any',           // implicit AND across conditions; default 'all'
 *     conditions: [Condition, ...]
 *   }
 *
 *   Condition = {
 *     type: 'selector_present'  → uses .selector
 *        | 'selector_absent'    → uses .selector
 *        | 'url_matches'        → uses .pattern (regex)
 *        | 'text_present'       → uses .text (case-insensitive substring)
 *        | 'attribute_equals'   → uses .selector + .attribute + .value
 *   }
 *
 * Field names match the existing per-kind shape so we don't migrate every
 * stored strategy/fragment on disk. Reads are backward-compatible:
 *
 *   Old single-condition (DETECT/LOOP/WAIT):
 *     { type: 'selector_present', selector: '...' }
 *   →
 *     { match: 'all', conditions: [{ type: 'selector_present', selector: '...' }] }
 *
 *   Old condition list (fragment pre/post):
 *     [{ type, ... }, ...]
 *   →
 *     { match: 'all', conditions: [{ type, ... }, ...] }
 *
 *   New shape passes through unchanged.
 *
 * Evaluation reuses TemplateWalker.checkConditions's underlying CHECK_CONDITION
 * message but wraps with Assertion.match semantics ('all' AND-s, 'any' OR-s).
 *
 * @module Services/Assertion
 */

import { Logger } from '../Core/Logger.js';
import {
  CONDITION_TYPES,
  CONDITION_FIELDS,
  MATCH_MODES,
  getTypesByFamily,
  getFamily,
  getSubfamily,
  effectiveFamilies,
  parseValueSet,
  itemToRecord,
  wrapInAssertionEnvelope,
} from './ConditionVocabulary.js';

// v2.70.0 — Unified condition vocabulary. Assertion.js previously declared
// CONDITION_TYPES and CONDITION_FIELDS locally; they now live in
// ConditionVocabulary.js as the single source of truth, with each entry
// tagged by `family` ('page' | 'scope' | 'reference'). This file re-exports
// them so existing consumers (studio.js, TemplateWalker, ExecutionEngine)
// see no API change.

export {
  CONDITION_TYPES,
  CONDITION_FIELDS,
  MATCH_MODES,
  getTypesByFamily,
  getFamily,
  getSubfamily,
  effectiveFamilies,
  parseValueSet,
  itemToRecord,
  wrapInAssertionEnvelope,
};

/**
 * Build an empty default condition of a given type, with sensible empty fields.
 * Used by the studio when the user adds a new condition row.
 *
 * @param {string} type
 * @returns {Object}
 */
export function emptyCondition(type = 'selector_present') {
  const t = CONDITION_TYPES.includes(type) ? type : 'selector_present';
  // v2.45.0 — derived from CONDITION_FIELDS. Each field initialized to ''.
  // Adding a new type means adding it to CONDITION_FIELDS; this function
  // automatically supports it without modification.
  const out = { type: t };
  for (const f of CONDITION_FIELDS[t].fields) out[f] = '';
  return out;
}

/**
 * Normalize input into a canonical Assertion. Accepts:
 *   - A assertion-shaped object: { match, conditions: [...], count? }
 *   - A condition array: [{ type, ... }, ...]  → wrapped as { match: 'all', conditions }
 *   - A single condition: { type, ... }         → wrapped as { match: 'all', conditions: [it] }
 *   - null / undefined / {}                     → { match: 'all', conditions: [] }
 *
 * v2.47.0 (Pass O2) — when match='k_of_n', the assertion also carries a
 * `count` field: an integer K such that the assertion is satisfied if at
 * least K conditions hold. Out-of-range counts (negative, zero, > N) are
 * left as-is at normalize time and flagged at validate time.
 *
 * @param {*} input
 * @returns {{ match: 'all'|'any'|'k_of_n', conditions: Object[], count?: number }}
 */
export function normalizeAssertion(input) {
  // Already a Assertion-shaped object?
  if (input && typeof input === 'object' && Array.isArray(input.conditions)) {
    const match = MATCH_MODES.includes(input.match) ? input.match : 'all';
    const conditions = input.conditions.map(normalizeCondition).filter(Boolean);
    const out = { match, conditions };
    if (match === 'k_of_n') {
      // Coerce to integer; non-numeric becomes 0 (validate flags it).
      const n = parseInt(input.count, 10);
      out.count = Number.isFinite(n) ? n : 0;
    }
    return out;
  }

  // Condition array (old fragment pre/post shape)?
  if (Array.isArray(input)) {
    return { match: 'all', conditions: input.map(normalizeCondition).filter(Boolean) };
  }

  // Single condition (old DETECT/LOOP/WAIT shape)?
  if (input && typeof input === 'object' && typeof input.type === 'string') {
    const cond = normalizeCondition(input);
    return { match: 'all', conditions: cond ? [cond] : [] };
  }

  // null / undefined / unrecognized
  return { match: 'all', conditions: [] };
}

/**
 * Normalize a single condition. Returns null if unrecognized so callers can
 * filter it out. Stored data with unknown `type` values gets dropped rather
 * than silently coerced to `selector_present` (which was the bug in the old
 * StrategyTree.normalizeCondition).
 *
 * @param {*} cond
 * @returns {Object|null}
 */
export function normalizeCondition(cond) {
  if (!cond || typeof cond !== 'object') return null;
  const t = cond.type;
  if (!CONDITION_TYPES.includes(t)) return null;
  // v2.45.0 — generic copy of every field declared for this type, coerced
  // to string. Unknown extra fields on the input are dropped (forces the
  // shape to match the schema). This was previously six per-type if/else
  // branches that had to be kept in sync — and weren't.
  const out = { type: t };
  for (const f of CONDITION_FIELDS[t].fields) out[f] = String(cond[f] ?? '');
  return out;
}

/**
 * Validate a Assertion, returning a list of human-readable errors (empty list
 * means valid). Strict — empty fields, unknown types, malformed regex all
 * produce errors. Used by the studio at save time and by StrategyTree validation.
 *
 * Also returns a list of warnings — soft issues (deprecation, etc).
 *
 * @param {*} assertion
 * @param {string} [label='assertion'] - context label for error messages
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateAssertion(assertion, label = 'assertion') {
  const errors = [];
  const warnings = [];
  const p = normalizeAssertion(assertion);

  if (!MATCH_MODES.includes(p.match)) {
    errors.push(`${label}: unknown match mode "${p.match}"`);
  }
  if (!Array.isArray(p.conditions)) {
    errors.push(`${label}: conditions must be an array`);
    return { errors, warnings };
  }
  p.conditions.forEach((c, i) => {
    const cl = `${label} condition ${i + 1}`;
    if (!CONDITION_TYPES.includes(c.type)) {
      errors.push(`${cl}: unknown type "${c.type}"`);
      return;
    }
    // v2.45.0 — per-type field validation derived from CONDITION_FIELDS.
    // Each `required` field must be non-empty after trim. Each `regex` field
    // must compile as a JS RegExp. Adding a new condition type means adding
    // it to CONDITION_FIELDS; this validation block automatically supports it.
    const schema = CONDITION_FIELDS[c.type];
    if (schema) {
      for (const f of (schema.required ?? [])) {
        if (!c[f] || !String(c[f]).trim()) {
          errors.push(`${cl}: ${f} is required`);
        }
      }
      for (const f of (schema.regex ?? [])) {
        if (c[f] && String(c[f]).trim()) {
          try { new RegExp(c[f]); }
          catch (e) { errors.push(`${cl}: invalid regex "${c[f]}" — ${e.message}`); }
        }
      }
    }
  });

  // v2.47.0 (Pass O2) — k_of_n requires a `count` integer in [1, conditions.length].
  // count=0 is rejected (use match='any' for "at least 1") and count > N is
  // rejected (the assertion could never be satisfied).
  if (p.match === 'k_of_n') {
    const k = p.count;
    const n = p.conditions.length;
    if (!Number.isInteger(k)) {
      errors.push(`${label}: k_of_n requires an integer count`);
    } else if (k < 1) {
      errors.push(`${label}: k_of_n count must be >= 1 (got ${k})`);
    } else if (n > 0 && k > n) {
      errors.push(`${label}: k_of_n count (${k}) exceeds condition count (${n})`);
    }
  }
  return { errors, warnings };
}

/**
 * Evaluate a Assertion against the current state of a tab.
 *
 * Implementation re-uses TemplateWalker's CHECK_CONDITION content-script
 * message — one round-trip per condition. We evaluate them sequentially
 * and short-circuit:
 *   - match='all' → first failure → return false
 *   - match='any' → first success → return true
 *
 * Empty conditions list:
 *   - match='all' → vacuously true (matches existing fragment-no-conditions behavior)
 *   - match='any' → vacuously false (consistent with logic but worth flagging)
 *
 * @param {Object} opts
 * @param {number} opts.tabId
 * @param {Object} opts.assertion - normalized or normalize-able assertion
 * @param {(message: any, frameId?: number) => Promise<any>} opts.sendMessage
 *   - injected sender (allows testing without chrome.tabs)
 * @param {number} [opts.frameId=0]
 * @param {number} [opts.timeoutMs=0] - if >0, retry until match or timeout
 * @param {number} [opts.pollIntervalMs=100]
 * @returns {Promise<{
 *   ok: boolean,
 *   failures: Array<{ condition: Object, reason: string }>,
 *   passed: Array<Object>,
 *   elapsedMs: number,
 *   attempts: number,
 * }>}
 */
export async function evaluateAssertion({
  tabId, assertion, sendMessage, frameId = 0,
  timeoutMs = 0, pollIntervalMs = 100,
}) {
  const p = normalizeAssertion(assertion);
  const started = Date.now();

  const runOnce = async () => {
    const failures = [];
    const passed   = [];
    if (p.conditions.length === 0) {
      // Vacuous result. ALL=true, ANY=false. We follow that logic.
      return { failures: [], passed: [] };
    }

    for (const cond of p.conditions) {
      let matched = false;
      let reason  = '';
      try {
        const res = await sendMessage(
          { type: 'CHECK_CONDITION', payload: { condition: cond } },
          frameId,
        );
        matched = !!(res && res.matched === true);
        if (!matched) reason = res?.error ?? 'condition not met';
      } catch (err) {
        matched = false;
        reason  = err.message;
      }

      if (matched) {
        passed.push(cond);
        if (p.match === 'any') return { failures: [], passed }; // short-circuit OR
      } else {
        failures.push({ condition: cond, reason });
        if (p.match === 'all') return { failures, passed };       // short-circuit AND
      }
    }
    return { failures, passed };
  };

  let attempts = 0;
  let { failures, passed } = await runOnce();
  attempts++;

  // ok semantics: 'all' → no failures; 'any' → at least one passed
  let ok = (p.match === 'all') ? (failures.length === 0)
                                : (passed.length > 0);

  while (!ok && Date.now() - started < timeoutMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const res = await runOnce();
    failures = res.failures;
    passed   = res.passed;
    attempts++;
    ok = (p.match === 'all') ? (failures.length === 0)
                              : (passed.length > 0);
  }

  return { ok, failures, passed, elapsedMs: Date.now() - started, attempts };
}

/**
 * Returns the human-meaningful "value" string of a single condition for
 * display in compact contexts (e.g. log lines, summary chips).
 *
 * @param {Object} c
 * @returns {string}
 */
export function describeCondition(c) {
  if (!c || typeof c !== 'object') return '';
  if (c.type === 'selector_present')  return `selector ${c.selector ?? ''} appears`;
  if (c.type === 'selector_absent')   return `selector ${c.selector ?? ''} is absent`;
  if (c.type === 'url_matches')       return `url matches /${c.pattern ?? ''}/`;
  if (c.type === 'text_present') {
    // v2.74.170 — Mention the scoping selector when present so describe
    // matches the new optional behavior of the evaluator.
    const sel = (c.selector ?? '').toString().trim();
    return sel
      ? `text "${c.text ?? ''}" appears in ${sel}`
      : `text "${c.text ?? ''}" appears`;
  }
  if (c.type === 'attribute_equals')  return `${c.selector}[${c.attribute}] = "${c.value ?? ''}"`;
  if (c.type === 'assertion_ref')     return `@${c.assertionId ?? '?'}`;
  // v2.46.0 (Pass O1) — field-* conditions
  if (c.type === 'field_equals')      return `${c.variable ?? '?'}.${c.field ?? '?'} == "${c.value ?? ''}"`;
  if (c.type === 'field_present')     return `${c.variable ?? '?'}.${c.field ?? '?'} is present`;
  if (c.type === 'field_gt')          return `${c.variable ?? '?'}.${c.field ?? '?'} > ${c.value ?? '?'}`;
  if (c.type === 'field_lt')          return `${c.variable ?? '?'}.${c.field ?? '?'} < ${c.value ?? '?'}`;
  if (c.type === 'field_gte')         return `${c.variable ?? '?'}.${c.field ?? '?'} >= ${c.value ?? '?'}`;
  if (c.type === 'field_lte')        return `${c.variable ?? '?'}.${c.field ?? '?'} <= ${c.value ?? '?'}`;
  // v2.57.0 — infrastructure signals
  if (c.type === 'resource_loaded')  return `resource matches /${c.pattern ?? ''}/`;
  if (c.type === 'cookie_present')   return `cookie ${c.name ?? '?'} present`;
  if (c.type === 'meta_equals') {
    const key = c.httpEquiv ? `http-equiv:${c.httpEquiv}` : `name:${c.name ?? '?'}`;
    if (c.value)        return `meta ${key} == "${c.value}"`;
    if (c.valuePattern) return `meta ${key} matches /${c.valuePattern}/`;
    return `meta ${key} present`;
  }
  return c.type ?? '?';
}

/**
 * Compact summary of a Assertion for logs.
 *
 * @param {Object} assertion
 * @returns {string}
 */
export function describeAssertion(assertion) {
  const p = normalizeAssertion(assertion);
  if (p.conditions.length === 0) return '(no conditions)';
  if (p.conditions.length === 1) return describeCondition(p.conditions[0]);
  // v2.47.0 — k_of_n format: "K of [a, b, c, ...]"
  if (p.match === 'k_of_n') {
    return `${p.count ?? '?'} of [${p.conditions.map(describeCondition).join(', ')}]`;
  }
  const joiner = p.match === 'any' ? ' OR ' : ' AND ';
  return p.conditions.map(describeCondition).join(joiner);
}

/**
 * v2.42.0 (Pass M2) — Recursively resolve all `assertion_ref` conditions
 * into their referenced assertion bodies. The result is a Assertion that
 * contains only primitive conditions (no assertion_ref entries).
 *
 * Resolution rules:
 *
 *   - A assertion_ref expands to the conditions of its referenced assertion.
 *     If the referenced assertion has its own match mode, that mode wraps
 *     the expanded conditions as a single nested-assertion-shaped condition...
 *     wait — we don't have nesting in our shape. Conditions are flat.
 *
 *   So expansion semantics: when a assertion_ref appears in a parent
 *   assertion with `match='all'`, we splice the referenced assertion's
 *   conditions in place IF the referenced assertion is also `match='all'`.
 *   Otherwise we'd need nested assertions. To avoid the model getting
 *   complicated, we adopt a STRICT RULE: the referenced assertion's match
 *   mode must equal the parent's match mode, OR the referenced assertion
 *   must have only one condition. Otherwise flatten throws.
 *
 *   This is a deliberate constraint that keeps the data model flat. M3
 *   may relax this with proper compositional assertions if needed.
 *
 *   - Cycle detection: a `seen` set tracks assertion IDs along the recursion
 *     path. If a assertion_ref points to an id already in `seen`, throw.
 *
 *   - Missing assertion: if `getAssertion(id)` returns null, throw with a
 *     clear message. Caller is responsible for surfacing this to the user.
 *
 *   - Depth limit: hard cap of 16 levels. Defends against intentional or
 *     accidental deep recursion that wouldn't form a cycle but is still
 *     pathological.
 *
 * @param {Object} assertion - the input Assertion (may contain assertion_ref)
 * @param {(id: string) => Promise<Object|null>} getAssertion - resolver
 *   that returns the stored assertion record for a given id, or null.
 * @param {Object} [opts]
 * @param {Set<string>} [opts.seen=new Set()]
 * @param {number} [opts.depth=0]
 * @param {number} [opts.maxDepth=16]
 * @returns {Promise<{ match: 'all'|'any', conditions: Object[] }>}
 *   Flattened assertion containing only primitive conditions.
 * @throws {Error} if a cycle, missing assertion, depth overflow, or
 *   match-mode mismatch is encountered.
 */
export async function flattenAssertion(assertion, getAssertion, opts = {}) {
  const seen      = opts.seen      ?? new Set();
  const depth     = opts.depth     ?? 0;
  const maxDepth  = opts.maxDepth  ?? 16;
  // v2.72.29 (Pass 17) — locale_ref expansion. If a getLocale resolver is
  // provided, locale_ref conditions expand to selector_present conditions
  // (one per landmark). If not provided, they expand to a permanent-fail
  // synthetic to match the assertion_ref fail-soft behavior.
  const getLocale = opts.getLocale ?? null;

  if (depth > maxDepth) {
    throw new Error(`Assertion depth limit exceeded (${maxDepth}) — possible misconfiguration`);
  }

  const p = normalizeAssertion(assertion);
  const flatConditions = [];
  // v2.72.30 (Pass 17.1, B4) — locale_ref expansion requires the parent
  // envelope's match mode to be 'all'. A locale's "satisfied" semantic is
  // "all of its landmarks match"; expanding into a parent envelope with
  // match='any' would mean any single landmark satisfies the parent (wrong)
  // and 'k_of_n' would mean each landmark counts separately toward k
  // (wrong). Until we add proper nested-assertion wrapping, fail-soft on
  // misuse rather than producing incorrect semantics silently.
  const parentMatchAllowsLocale = (p.match === 'all');

  for (const cond of p.conditions) {
    // ── locale_ref expansion ──────────────────────────────────────────
    if (cond.type === 'locale_ref') {
      const localeId = cond.localeId;
      if (!localeId) {
        // Empty localeId — same fail-soft as empty assertionId.
        flatConditions.push({ type: 'selector_absent', selector: 'body' });
        continue;
      }
      if (!getLocale) {
        // Locale resolver wasn't passed; can't expand. Fail-soft.
        flatConditions.push({ type: 'selector_absent', selector: 'body' });
        continue;
      }
      if (!parentMatchAllowsLocale) {
        // Misuse: locale_ref inside a non-'all' envelope. The expanded
        // landmark conditions would be combined wrongly with siblings.
        // Log the misuse and treat as unmet rather than producing
        // incorrect semantics.
        Logger.warn('Assertion', `flattenAssertion: locale_ref "${localeId}" used inside a parent envelope with match="${p.match}". locale_ref currently requires match="all" to expand correctly. Treating as unmet — restructure the envelope or wrap the locale_ref alone.`);
        flatConditions.push({ type: 'selector_absent', selector: 'body' });
        continue;
      }
      let locale;
      try {
        locale = await getLocale(localeId);
      } catch {
        locale = null;
      }
      if (!locale || !Array.isArray(locale.landmarks) || locale.landmarks.length === 0) {
        // Stale or empty locale — fail-soft.
        flatConditions.push({ type: 'selector_absent', selector: 'body' });
        continue;
      }
      // Expand each landmark into a selector_present condition. The
      // implicit AND piggybacks on the parent envelope's match='all'
      // (guarded above). Each landmark must individually match for the
      // locale to be considered satisfied.
      // v2.74.198 — Carry the landmark's iframe routing through the
      // expansion. Locale-capture's picker can land in iframes, and
      // the saved landmark carries `frameUrl`. Without copying it to
      // the synthetic selector_present condition, the downstream
      // TemplateWalker.checkConditions probe routes to the top frame
      // (per its per-condition frame resolver at v2.74.177) and the
      // iframe-scoped selector misses. Symmetric to the fragment-
      // action / observation-extract iframe fixes; locale picks were
      // missed because the picker write path silently dropped frameUrl.
      for (const lm of locale.landmarks) {
        if (typeof lm?.selector === 'string' && lm.selector.trim()) {
          const expanded = { type: 'selector_present', selector: lm.selector };
          if (typeof lm.frameUrl === 'string' && lm.frameUrl.trim()) {
            expanded.frameUrl = lm.frameUrl;
          }
          flatConditions.push(expanded);
        }
      }
      continue;
    }

    if (cond.type !== 'assertion_ref') {
      flatConditions.push(cond);
      continue;
    }

    const refId = cond.assertionId;
    if (!refId) {
      // v2.43.1 — Tolerate dangling assertion_ref. An empty assertionId
      // happens when a "named assertion" branch was authored but the
      // picker was never set. Old behavior (throw) made the engine log
      // ERROR every evaluation, but the strategy semantics for AND/OR
      // are identical: a missing assertion is unmet. Push a synthetic
      // always-false condition and continue. The branch / loop / wait
      // sees the assertion as failed and falls through cleanly.
      flatConditions.push({ type: 'selector_absent', selector: 'body' });
      continue;
    }
    if (seen.has(refId)) {
      throw new Error(`Assertion cycle detected: ${[...seen, refId].join(' → ')}`);
    }

    const referenced = await getAssertion(refId);
    if (!referenced) {
      // v2.43.1 — Same fail-soft as empty-id: a stale reference (assertion
      // was deleted or renamed) shouldn't crash the engine. Treat as unmet.
      flatConditions.push({ type: 'selector_absent', selector: 'body' });
      continue;
    }
    if (!referenced.body) {
      flatConditions.push({ type: 'selector_absent', selector: 'body' });
      continue;
    }

    // Recurse into the referenced assertion's body
    const innerSeen = new Set(seen);
    innerSeen.add(refId);
    const inner = await flattenAssertion(referenced.body, getAssertion, {
      seen: innerSeen, depth: depth + 1, maxDepth, getLocale,
    });

    // Match-mode constraint check.
    // v2.47.0 (Pass O2) — k_of_n is stricter than all/any: even when both
    // sides are k_of_n, splicing a multi-condition reference would change
    // the semantics (parent's K applies to N+M conditions instead of N or M
    // separately). So k_of_n parent or k_of_n child with multiple conditions
    // is rejected.
    if (inner.conditions.length > 1) {
      if (p.match === 'k_of_n' || inner.match === 'k_of_n') {
        throw new Error(
          `Assertion ${refId} (match=${inner.match}, ${inner.conditions.length} conditions) cannot be inlined into a match=${p.match} context. ` +
          `k_of_n assertions do not support multi-condition references — author the referenced assertion as a single primitive, or restructure.`
        );
      }
      if (inner.match !== p.match) {
        throw new Error(
          `Assertion ${refId} uses match=${inner.match} but is referenced inside a match=${p.match} context. ` +
          `Mixed-match references are not supported in this version. ` +
          `Consider authoring the referenced assertion with the same match mode, or inlining its single condition.`
        );
      }
    }

    flatConditions.push(...inner.conditions);
  }

  // v2.47.0 — preserve `count` for k_of_n assertions through the flatten.
  const result = { match: p.match, conditions: flatConditions };
  if (p.match === 'k_of_n' && Number.isInteger(p.count)) {
    result.count = p.count;
  }
  return result;
}

// ─── v2.46.0 (Pass O1) — record-field condition evaluation ────────────────

/**
 * Set of condition types that read from in-memory iteration records rather
 * than the page DOM. These are evaluated engine-side and never sent to the
 * content script. Centralized so callers (TemplateWalker.checkConditions)
 * can split a assertion's conditions into "DOM-bound" vs "record-bound"
 * without per-type if/else.
 */
/**
 * Set of condition types that evaluate engine-side (against scope and
 * iteration records), not via the content script. Used by
 * splitConditionsByEvaluator to route conditions to the right evaluator.
 *
 * v2.70.0 — Expanded from FIELD_CONDITION_TYPES (field_* only) to include
 * the full scope-family vocabulary (binding_is_list, every_record_*,
 * record_*, scalar_*, etc.). Strategy DETECT/LOOP/WAIT_FOR/TRY can now
 * evaluate scope conditions inline.
 *
 * Derived from CONDITION_FIELDS by family tag — a single source of truth.
 */
export const SCOPE_CONDITION_TYPES = Object.freeze(new Set(
  Object.entries(CONDITION_FIELDS)
    .filter(([_, schema]) => schema.family === 'scope')
    .map(([type, _]) => type)
));

/**
 * v2.46.0 alias retained for backward compatibility. Pre-v2.70.0 callers
 * imported FIELD_CONDITION_TYPES; that name is now misleading (the set
 * includes more than field_*) but kept as an export to avoid breaking
 * anyone who imported it. Prefer SCOPE_CONDITION_TYPES going forward.
 */
export const FIELD_CONDITION_TYPES = SCOPE_CONDITION_TYPES;

/**
 * Evaluate a single field-* condition against an iteration record.
 *
 * The record is the iteration variable's value — a `{selector, ...fields}`
 * object produced by ENUMERATE with `fields`. If the record is null (the
 * variable isn't bound or has no record shape), the condition is unmet.
 * Same if the field is missing, except for field_present which returns
 * false (correct semantics — "is the field present? no").
 *
 * Comparison semantics:
 *
 *   field_equals  — `==` after String() coercion of both sides. Boolean true/false
 *                   compare equal to string 'true'/'false' (intentional — captured
 *                   booleans serialize as strings via String()).
 *   field_present — true if record[field] is not null/undefined and not empty string
 *   field_gt/gte/lt/lte — Number coercion via parseFloat. If either side is NaN
 *                   after coercion, returns false (cannot compare non-numerics).
 *
 * @param {Object} cond - the field-* condition
 * @param {Object|null} record - the iteration record, or null
 * @returns {boolean}
 */
export function evaluateFieldCondition(cond, record) {
  if (!cond || typeof cond !== 'object') return false;
  if (!FIELD_CONDITION_TYPES.has(cond.type)) return false;
  if (!record || typeof record !== 'object') return false;

  // v2.46.0 — Iteration items from ENUMERATE+fields have shape
  //   { kind, selector, baseSelector, index, ..., record: { name: value, ... } }
  // Field-* conditions look up `cond.field` against the nested record IF present,
  // otherwise against the top-level (allowing tests / other shapes to pass plain
  // records without the iteration-item wrapping).
  const source = (record.record && typeof record.record === 'object')
    ? record.record : record;
  const actual = source[cond.field];

  if (cond.type === 'field_present') {
    return actual !== null && actual !== undefined && String(actual) !== '';
  }

  if (cond.type === 'field_equals') {
    // Normalize both sides to strings for stable comparison. Boolean record
    // values become 'true'/'false'; numeric become '22' etc. Author-typed
    // expected values are already strings.
    return String(actual ?? '') === String(cond.value ?? '');
  }

  // Numeric comparators
  const a = parseFloat(actual);
  const b = parseFloat(cond.value);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (cond.type === 'field_gt')  return a >  b;
  if (cond.type === 'field_lt')  return a <  b;
  if (cond.type === 'field_gte') return a >= b;
  if (cond.type === 'field_lte') return a <= b;

  return false;
}

/**
 * Split a Assertion's conditions into two arrays: those that read from
 * iteration records (engine-evaluated) and those that need DOM access
 * (content-script-evaluated). Used by TemplateWalker.checkConditions to
 * route each group through the right evaluator.
 *
 * @param {{match: string, conditions: Array}} assertion
 * @returns {{ fieldConditions: Array, domConditions: Array }}
 */
export function splitConditionsByEvaluator(assertion) {
  const fieldConditions = [];
  const domConditions = [];
  for (const c of (assertion.conditions ?? [])) {
    if (c && FIELD_CONDITION_TYPES.has(c.type)) fieldConditions.push(c);
    else domConditions.push(c);
  }
  return { fieldConditions, domConditions };
}
