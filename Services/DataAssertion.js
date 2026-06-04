/**
 * v2.64.0 (Pass 1 — pre/post on Analyses) — Data-side condition vocabulary.
 *
 * Where Assertion.js handles page-side conditions (DOM/URL/cookies/etc.),
 * this module is the engine-side evaluator for scope conditions.
 *
 * v2.70.0 (Unification) — The schema (CONDITION_TYPES, CONDITION_FIELDS) now
 * lives in ConditionVocabulary.js as a single source of truth, with each
 * condition type tagged by `family` ('page' | 'scope' | 'reference').
 * This module:
 *   - Re-exports DATA_CONDITION_TYPES = scope-family subset of canonical types,
 *     so existing imports (`import { DATA_CONDITION_TYPES } from './DataAssertion.js'`)
 *     continue to work and continue to mean "the scope-side vocabulary."
 *   - Re-exports DATA_CONDITION_FIELDS = the full canonical schema (consumers
 *     index by type name, which is unchanged).
 *   - Keeps the scope-side evaluator (evaluateDataCondition) and the
 *     describer (describeDataCondition).
 *
 * Page-side conditions are handled by Assertion.js. The unified evaluator
 * (used by call-sites that mix families, like strategy DETECT/LOOP) lives
 * elsewhere; this module remains scope-side-only by design.
 */

import {
  CONDITION_TYPES as ALL_CONDITION_TYPES,
  CONDITION_FIELDS as CANONICAL_CONDITION_FIELDS,
  parseValueSet,
  itemToRecord,
} from './ConditionVocabulary.js';

// v2.74.745 (converge) — the `orch_predicate` condition does NOT re-implement the gate's
// predicate; it calls the SAME evaluator the chat interpreter uses, so a promoted Strategy's
// DETECT and the ORCH walkPlan gate compute identical truth over the same bound value.
import { evaluatePredicate, predicateLabel } from '../Core/orchAnalyze.js';

// Flatten a tagged list ITEM to text, so a `contains` / value-threshold predicate works over a list whose items
// are record-tagged (the converge materializes list_of_records → ExecutionEngine wraps each match as
// record({value:'…'}); a naive String() would yield "[object Object]"). Count predicates only use length, so this
// is harmless for them. Handles scalar-tagged, record-tagged ({fields}), the OBSERVE_LIST {record} shape, and plain values.
function _itemText(it) {
  if (it == null) return '';
  if (typeof it !== 'object') return String(it);
  if (it.kind === 'scalar') return String(it.value ?? '');
  if (it.kind === 'record' && it.fields && typeof it.fields === 'object') return Object.values(it.fields).map((x) => String(x ?? '')).join(' ');
  if (it.record && typeof it.record === 'object') return Object.values(it.record).map((x) => String(x ?? '')).join(' ');
  const rec = itemToRecord(it);
  if (rec && typeof rec === 'object') return Object.values(rec).map((x) => String(x ?? '')).join(' ');
  if (it.value != null) return String(it.value);
  return String(it);
}

// Coerce a tagged scope value → the {count, items, value} shape evaluatePredicate expects.
//   list → count + items-as-text (so exists/none/count use length; contains/value-threshold read item text);
//   scalar/document → value (its _countFromValue parses "0 jobs"/"none" → 0);
//   record/section/image → PRESENT means count 1 (so exists is true / none is false for real data, not inverted),
//     with best-effort text for contains.
function _coerceForPredicate(v) {
  if (v == null) return null;
  if (v.kind === 'list')     { const items = (Array.isArray(v.items) ? v.items : []).map(_itemText); return { items, count: items.length }; }
  if (v.kind === 'scalar')   return { value: v.value };
  if (v.kind === 'document') return { value: v.content ?? '' };
  if (v.kind === 'record')   { const f = (v.fields && typeof v.fields === 'object') ? v.fields : {}; return { value: Object.values(f).map((x) => String(x ?? '')).join(' '), count: 1 }; }
  if (v.kind === 'section')  return { value: v.text ?? v.markdown ?? '', count: 1 };
  if (v.kind === 'image')    return { value: v.src ?? v.dataUrl ?? '', count: 1 };
  return { value: (v.value != null ? v.value : (v.content != null ? v.content : '')) };  // unknown kind → best-effort value
}

/**
 * Scope-family condition types. Subset of the canonical CONDITION_TYPES.
 * Existing consumers (studio.js, ExecutionEngine, BuiltinAnalyses validation)
 * use this to assert "this is a scope-side condition" or to filter dropdowns.
 *
 * Note: `field_*` (record-field on iteration variable) types and `assertion_ref`
 * are NOT included here — they're scope-related but historically belonged to
 * Assertion.js's vocabulary. If a future caller needs them in a scope-only
 * context, expose them here too.
 */
export const DATA_CONDITION_TYPES = Object.freeze(
  ALL_CONDITION_TYPES.filter(t => {
    const fam = CANONICAL_CONDITION_FIELDS[t]?.family;
    const sub = CANONICAL_CONDITION_FIELDS[t]?.subfamily;
    // Scope family, but not record-field subfamily (record-field types
    // belong to Assertion.js's vocabulary historically and aren't part of
    // Analysis pre/post vocabulary).
    return fam === 'scope' && sub !== 'record-field';
  })
);

/**
 * Full canonical schema. Re-exported under the legacy name. Indexed by type
 * name; consumers don't care about the family/subfamily field unless they're
 * doing editor grouping (which now uses getSubfamily()).
 */
export const DATA_CONDITION_FIELDS = CANONICAL_CONDITION_FIELDS;


/**
 * Build an empty data-condition of a given type, with sensible empty fields.
 * Used by the studio when the user adds a new pre/post row.
 */
export function emptyDataCondition(type = 'binding_is_list') {
  const t = DATA_CONDITION_TYPES.includes(type) ? type : 'binding_is_list';
  const out = { type: t };
  for (const f of DATA_CONDITION_FIELDS[t].fields) out[f] = '';
  return out;
}

/**
 * Normalize a data-condition. Drops unknown types and unknown fields,
 * coerces field values to strings, and fills in any missing declared fields
 * with empty string. Returns null if the type is unrecognized.
 */
export function normalizeDataCondition(cond) {
  if (!cond || typeof cond !== 'object') return null;
  const t = cond.type;
  if (!DATA_CONDITION_TYPES.includes(t)) return null;
  const out = { type: t };
  for (const f of DATA_CONDITION_FIELDS[t].fields) {
    out[f] = String(cond[f] ?? '');
  }
  return out;
}

/**
 * Normalize a list of data-conditions (used for pre/post arrays). Drops
 * unrecognized entries; preserves order.
 */
export function normalizeDataConditionList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(normalizeDataCondition).filter(Boolean);
}

/**
 * Validate a list of data-conditions. Returns an array of error strings
 * (empty if valid). Used by the studio at save time and by the engine's
 * static checks.
 */
export function validateDataConditionList(arr, label = 'conditions') {
  const errors = [];
  if (!Array.isArray(arr)) {
    errors.push(`${label}: must be an array`);
    return errors;
  }
  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    const ctxt = `${label}[${i + 1}]`;
    if (!c || typeof c !== 'object') {
      errors.push(`${ctxt}: not an object`);
      continue;
    }
    // v2.70.3 — Accept assertion_ref alongside scope-family types. Both have
    // schemas in DATA_CONDITION_FIELDS (canonical), so the required-field
    // check works for both. Anything else is rejected as unknown.
    const isAllowedType =
      DATA_CONDITION_TYPES.includes(c.type) || c.type === 'assertion_ref';
    if (!isAllowedType) {
      errors.push(`${ctxt}: unknown type "${c.type}"`);
      continue;
    }
    const schema = DATA_CONDITION_FIELDS[c.type];
    for (const reqField of schema.required) {
      const v = c[reqField];
      if (v == null || String(v).trim() === '') {
        errors.push(`${ctxt} (${c.type}): required field "${reqField}" is empty`);
      }
    }
  }
  return errors;
}

// parseValueSet and itemToRecord are imported from ConditionVocabulary.js
// (v2.70.0 unification). Their definitions previously lived here.

/**
 * Evaluate a single data-condition against a Scope. Returns
 * { ok: boolean, reason: string }. Reason is a short human-readable
 * description of why the condition failed (used in error messages).
 *
 * The Scope is whatever object the engine uses for binding storage —
 * exposes a `.get(name)` method returning a tagged value of kind
 * 'list' | 'scalar' | 'element' | 'record' | undefined.
 */
export function evaluateDataCondition(cond, scope) {
  if (!cond || typeof cond !== 'object') {
    return { ok: false, reason: 'condition is missing or not an object' };
  }
  const t = cond.type;
  switch (t) {
    case 'binding_is_list': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list` };
      return { ok: true, reason: '' };
    }

    case 'binding_is_scalar': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'scalar') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected scalar` };
      return { ok: true, reason: '' };
    }

    case 'binding_length_min': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list (length checks require lists)` };
      const len = Array.isArray(v.items) ? v.items.length : 0;
      const min = parseInt(cond.min, 10);
      if (!Number.isFinite(min)) return { ok: false, reason: `condition min "${cond.min}" is not a number` };
      if (len < min) return { ok: false, reason: `binding "${cond.binding}" has length ${len}, minimum is ${min}` };
      return { ok: true, reason: '' };
    }

    case 'binding_length_max': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list (length checks require lists)` };
      const len = Array.isArray(v.items) ? v.items.length : 0;
      const max = parseInt(cond.max, 10);
      if (!Number.isFinite(max)) return { ok: false, reason: `condition max "${cond.max}" is not a number` };
      if (len > max) return { ok: false, reason: `binding "${cond.binding}" has length ${len}, maximum is ${max}` };
      return { ok: true, reason: '' };
    }

    case 'binding_length_range': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list` };
      const len = Array.isArray(v.items) ? v.items.length : 0;
      const min = parseInt(cond.min, 10);
      const max = parseInt(cond.max, 10);
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { ok: false, reason: `condition range [${cond.min}..${cond.max}] is not numeric` };
      }
      if (len < min || len > max) {
        return { ok: false, reason: `binding "${cond.binding}" has length ${len}, expected ${min}..${max}` };
      }
      return { ok: true, reason: '' };
    }

    case 'every_record_has_field': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list` };
      const items = Array.isArray(v.items) ? v.items : [];
      const fname = String(cond.fieldName);
      // Iteration items can be element-tagged (with .record sub-field),
      // record-tagged, or scalar-tagged. Field presence checks look in
      // .record for elements, .fields for records, and fail for scalars.
      // Empty list passes trivially (no items to violate).
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const record = itemToRecord(item);
        if (!record || typeof record !== 'object') {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} has no record/fields` };
        }
        if (!Object.prototype.hasOwnProperty.call(record, fname)) {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} missing field "${fname}"` };
        }
      }
      return { ok: true, reason: '' };
    }

    case 'every_record_field_non_empty': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list` };
      const items = Array.isArray(v.items) ? v.items : [];
      const fname = String(cond.fieldName);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const record = itemToRecord(item);
        if (!record || typeof record !== 'object') {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} has no record/fields` };
        }
        const fv = record[fname];
        if (fv == null || String(fv).trim() === '') {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} field "${fname}" is empty` };
        }
      }
      return { ok: true, reason: '' };
    }

    // ── List assertions (v2.69.0 additions) ────────────────────────────────

    case 'binding_length_exactly': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list (length checks require lists)` };
      const len = Array.isArray(v.items) ? v.items.length : 0;
      const count = parseInt(cond.count, 10);
      if (!Number.isFinite(count)) return { ok: false, reason: `condition count "${cond.count}" is not a number` };
      if (len !== count) return { ok: false, reason: `binding "${cond.binding}" has length ${len}, expected exactly ${count}` };
      return { ok: true, reason: '' };
    }

    case 'every_record_field_equals': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list` };
      const items = Array.isArray(v.items) ? v.items : [];
      const fname = String(cond.fieldName);
      const expected = String(cond.value);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const record = itemToRecord(item);
        if (!record || typeof record !== 'object') {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} has no record/fields` };
        }
        const actual = record[fname];
        if (String(actual ?? '') !== expected) {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} field "${fname}" is "${actual}", expected "${expected}"` };
        }
      }
      return { ok: true, reason: '' };
    }

    case 'every_record_field_starts_with': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list` };
      const items = Array.isArray(v.items) ? v.items : [];
      const fname = String(cond.fieldName);
      const prefix = String(cond.value);
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const record = itemToRecord(item);
        if (!record || typeof record !== 'object') {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} has no record/fields` };
        }
        const actual = String(record[fname] ?? '');
        if (!actual.startsWith(prefix)) {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} field "${fname}" is "${actual}", expected to start with "${prefix}"` };
        }
      }
      return { ok: true, reason: '' };
    }

    case 'every_record_field_in_set': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'list') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected list` };
      const items = Array.isArray(v.items) ? v.items : [];
      const fname = String(cond.fieldName);
      const allowed = parseValueSet(cond.values);
      if (allowed.length === 0) return { ok: false, reason: `condition values "${cond.values}" is empty after parsing` };
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const record = itemToRecord(item);
        if (!record || typeof record !== 'object') {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} has no record/fields` };
        }
        const actual = String(record[fname] ?? '');
        if (!allowed.includes(actual)) {
          return { ok: false, reason: `binding "${cond.binding}" item ${i + 1} field "${fname}" is "${actual}", expected one of [${allowed.join(', ')}]` };
        }
      }
      return { ok: true, reason: '' };
    }

    // ── Record assertions (v2.69.0 — new family) ───────────────────────────

    case 'binding_is_record': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'record') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected record` };
      return { ok: true, reason: '' };
    }

    case 'record_has_field': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'record') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected record` };
      const fname = String(cond.fieldName);
      const fields = v.fields ?? {};
      if (!Object.prototype.hasOwnProperty.call(fields, fname)) {
        return { ok: false, reason: `binding "${cond.binding}" missing field "${fname}"` };
      }
      return { ok: true, reason: '' };
    }

    case 'record_field_non_empty': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'record') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected record` };
      const fname = String(cond.fieldName);
      const fields = v.fields ?? {};
      const fv = fields[fname];
      if (fv == null || String(fv).trim() === '') {
        return { ok: false, reason: `binding "${cond.binding}" field "${fname}" is empty` };
      }
      return { ok: true, reason: '' };
    }

    // ── Scalar assertions (v2.69.0 additions) ──────────────────────────────

    case 'scalar_non_empty': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'scalar') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected scalar` };
      if (String(v.value ?? '').trim() === '') {
        return { ok: false, reason: `binding "${cond.binding}" is empty` };
      }
      return { ok: true, reason: '' };
    }

    case 'scalar_is_number': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'scalar') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected scalar` };
      // Accept either explicit subtype 'number' or string-coerces-to-number.
      if (v.subtype === 'number') return { ok: true, reason: '' };
      const n = Number(v.value);
      if (!Number.isFinite(n)) {
        return { ok: false, reason: `binding "${cond.binding}" value "${v.value}" is not a number` };
      }
      return { ok: true, reason: '' };
    }

    case 'scalar_equals': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'scalar') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected scalar` };
      const expected = String(cond.value);
      if (String(v.value ?? '') !== expected) {
        return { ok: false, reason: `binding "${cond.binding}" is "${v.value}", expected "${expected}"` };
      }
      return { ok: true, reason: '' };
    }

    case 'scalar_number_range': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'scalar') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected scalar` };
      const n = Number(v.value);
      if (!Number.isFinite(n)) {
        return { ok: false, reason: `binding "${cond.binding}" value "${v.value}" is not a number` };
      }
      const min = parseFloat(cond.min);
      const max = parseFloat(cond.max);
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { ok: false, reason: `condition range [${cond.min}..${cond.max}] is not numeric` };
      }
      if (n < min || n > max) {
        return { ok: false, reason: `binding "${cond.binding}" is ${n}, expected ${min}..${max}` };
      }
      return { ok: true, reason: '' };
    }

    case 'scalar_in_set': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'scalar') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected scalar` };
      const allowed = parseValueSet(cond.values);
      if (allowed.length === 0) return { ok: false, reason: `condition values "${cond.values}" is empty after parsing` };
      const actual = String(v.value ?? '');
      if (!allowed.includes(actual)) {
        return { ok: false, reason: `binding "${cond.binding}" is "${actual}", expected one of [${allowed.join(', ')}]` };
      }
      return { ok: true, reason: '' };
    }

    // ── Tagged-value kind checks (Pass 7c) ────────────────────────────────
    // Defensive type checks for typed scope kinds. The pattern parallels
    // binding_is_list / binding_is_record / binding_is_scalar above.

    case 'binding_is_section': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'section') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected section` };
      return { ok: true, reason: '' };
    }

    case 'binding_is_image': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'image') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected image` };
      return { ok: true, reason: '' };
    }

    case 'binding_is_document': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'document') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected document` };
      return { ok: true, reason: '' };
    }

    // ── Document assertions (Pass 7c) ──────────────────────────────────────
    // Check properties of a composed document. Useful in postconditions on
    // template-body Analyses.

    case 'document_min_length': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'document') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected document (length checks require documents)` };
      const len = (v.content ?? '').length;
      const min = parseInt(cond.min, 10);
      if (!Number.isFinite(min)) return { ok: false, reason: `condition min "${cond.min}" is not a number` };
      if (len < min) return { ok: false, reason: `binding "${cond.binding}" has content length ${len}, minimum is ${min}` };
      return { ok: true, reason: '' };
    }

    case 'document_contains': {
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound` };
      if (v.kind !== 'document') return { ok: false, reason: `binding "${cond.binding}" is kind=${v.kind}, expected document` };
      const needle = String(cond.value ?? '');
      if (!needle) return { ok: false, reason: `condition value is empty` };
      const content = v.content ?? '';
      if (!content.includes(needle)) {
        const preview = needle.length > 40 ? needle.slice(0, 40) + '…' : needle;
        return { ok: false, reason: `binding "${cond.binding}" content does not contain "${preview}"` };
      }
      return { ok: true, reason: '' };
    }

    case 'orch_predicate': {
      // The converge gate: parse the JSON-encoded predicate spec and run the SAME evaluatePredicate
      // the chat interpreter uses. Fails CLOSED — unbound binding, bad JSON, or a throw → ok:false —
      // so a promoted Strategy never opens a gate the ORCH matcher would have kept shut (R5).
      const v = scope?.get?.(cond.binding);
      if (v == null) return { ok: false, reason: `binding "${cond.binding}" is unbound (orch_predicate fails closed)` };
      let spec;
      try { spec = JSON.parse(cond.specJson || '{}'); }
      catch { return { ok: false, reason: `orch_predicate specJson is not valid JSON (fails closed)` }; }
      const input = _coerceForPredicate(v);
      try {
        const held = !!evaluatePredicate(spec, input);
        return { ok: held, reason: held ? '' : `orch_predicate(${spec && spec.op ? spec.op : '?'}) did not hold over "${cond.binding}"` };
      } catch (e) {
        return { ok: false, reason: `orch_predicate threw: ${e && e.message ? e.message : e} (fails closed)` };
      }
    }

    default:
      return { ok: false, reason: `unknown data-condition type "${t}"` };
  }
}

/**
 * Evaluate a list of data-conditions; AND semantics. Short-circuits on
 * first failure. Returns { ok, failures: [{cond, reason}, ...] }.
 *
 * Used by the engine for pre/post evaluation. Empty list always passes.
 */
export function evaluateDataConditionList(conditions, scope) {
  if (!Array.isArray(conditions) || conditions.length === 0) {
    return { ok: true, failures: [] };
  }
  const failures = [];
  for (const cond of conditions) {
    const result = evaluateDataCondition(cond, scope);
    if (!result.ok) {
      failures.push({ cond, reason: result.reason });
      // Short-circuit — first failure suffices for pre/post.
      return { ok: false, failures };
    }
  }
  return { ok: true, failures: [] };
}

/**
 * v2.70.3 — Resolve assertion_ref entries in a scope-context envelope by
 * inlining the referenced library assertion's conditions.
 *
 * Mirrors flattenAssertion in Assertion.js but tailored for scope context:
 *   - Fallback for missing/dangling references is a synthetic always-false
 *     scope condition (binding_is_list with binding='__missing_ref__'),
 *     not a page-side selector_absent.
 *   - Verifies the referenced assertion's conditions are scope-family OR
 *     other assertion_ref entries (which recurse). Page-family conditions
 *     in a referenced library assertion are dropped with a fallback —
 *     authors should be using scope-only library assertions from Analysis
 *     pre/post (enforced at save time by checkAssertionRefFamilies).
 *
 * Cycle detection via `seen` set; depth limit defaults to 16.
 *
 * @param envelope - {match, conditions, count?}
 * @param getAssertion - async fn(assertionId) → library assertion or null
 * @param opts - {seen?, depth?, maxDepth?}
 * @returns Promise<{match, conditions, count?}> with flat conditions
 */
export async function flattenScopeAssertionRefs(envelope, getAssertion, opts = {}) {
  const seen     = opts.seen     ?? new Set();
  const depth    = opts.depth    ?? 0;
  const maxDepth = opts.maxDepth ?? 16;

  if (depth > maxDepth) {
    throw new Error(`Assertion depth limit exceeded (${maxDepth}) — possible misconfiguration`);
  }

  const conditions = Array.isArray(envelope?.conditions) ? envelope.conditions : [];
  const flat = [];

  // Synthetic always-false scope condition used for missing/incompatible refs.
  // binding_is_list against an unbound name resolves to {ok: false, reason:
  // 'binding "__missing_ref__" is unbound'}, which fails the parent assertion
  // cleanly with a descriptive message.
  const FALLBACK = { type: 'binding_is_list', binding: '__missing_ref__' };

  for (const cond of conditions) {
    if (cond?.type !== 'assertion_ref') {
      flat.push(cond);
      continue;
    }
    const refId = cond.assertionId;
    if (!refId) {
      flat.push(FALLBACK);
      continue;
    }
    if (seen.has(refId)) {
      throw new Error(`Assertion cycle detected: ${[...seen, refId].join(' → ')}`);
    }
    let referenced = null;
    try {
      referenced = await getAssertion(refId);
    } catch (_) { referenced = null; }
    if (!referenced || !referenced.body) {
      flat.push(FALLBACK);
      continue;
    }

    // Recurse — referenced.body is itself an envelope.
    const innerSeen = new Set(seen);
    innerSeen.add(refId);
    const inner = await flattenScopeAssertionRefs(referenced.body, getAssertion, {
      seen: innerSeen, depth: depth + 1, maxDepth,
    });

    // For Analysis pre/post (and any scope-only call-site), referenced
    // assertions must be scope-only. If we encounter a non-scope, non-ref
    // condition in the referenced assertion, that's a family-compat
    // violation that should have been caught at save time. Substitute
    // fallback rather than evaluating against a context that can't.
    for (const ic of inner.conditions) {
      const t = ic?.type;
      if (!t) continue;
      // Accept: any type whose schema is in DATA_CONDITION_FIELDS as a
      // scope condition. The schema is the canonical map; checking
      // family === 'scope' would be cleaner but DATA_CONDITION_FIELDS
      // is the full canonical and entries carry family. Use the type
      // list as a coarse filter — DATA_CONDITION_TYPES is scope-family
      // subset.
      if (DATA_CONDITION_TYPES.includes(t)) {
        flat.push(ic);
      } else {
        // Page-family or unknown — substitute fallback.
        flat.push(FALLBACK);
      }
    }

    // Match-mode constraint: same restriction as Assertion.js's flattener.
    // If inner has multiple conditions and parent or inner match modes
    // differ in a way that changes semantics, throw.
    const parentMatch = envelope?.match ?? 'all';
    if (inner.conditions.length > 1) {
      if (parentMatch === 'k_of_n' || inner.match === 'k_of_n') {
        throw new Error(
          `Assertion ${refId} (match=${inner.match}, ${inner.conditions.length} conditions) cannot be inlined into a match=${parentMatch} context. ` +
          `k_of_n assertions do not support multi-condition references — author the referenced assertion as a single primitive, or restructure.`
        );
      }
      if (inner.match !== parentMatch) {
        throw new Error(
          `Assertion ${refId} (match=${inner.match}) cannot be inlined into a match=${parentMatch} context — match modes must agree.`
        );
      }
    }
  }

  return {
    match: envelope?.match ?? 'all',
    conditions: flat,
    ...(typeof envelope?.count === 'number' ? { count: envelope.count } : {}),
  };
}

/**
 * v2.70.0 — Evaluate a assertion envelope (the unified shape used by all
 * call-sites). The envelope is `{match: 'all' | 'any' | 'k_of_n', conditions: [...], count?: number}`.
 *
 * Returns `{ok, failures}` with failure semantics that respect match mode:
 *   - 'all'    → first failure short-circuits; ok=false if any condition fails.
 *   - 'any'    → all conditions evaluated; ok=true if any one passes;
 *                if all fail, failures list contains all conditions' failures.
 *   - 'k_of_n' → all conditions evaluated; ok=true if at least `count`
 *                pass; otherwise failures list contains the failing
 *                conditions.
 *
 * Empty conditions list passes trivially regardless of match mode.
 *
 * This evaluator only handles scope-family conditions. Page-family conditions
 * (selector_present, etc.) require a content-script round-trip and are not
 * evaluated here. A unified evaluator that mixes both lives in a future
 * consolidation; for now Analysis pre/post is scope-only via this function.
 */
export function evaluateDataAssertionEnvelope(envelope, scope) {
  if (!envelope || typeof envelope !== 'object') {
    return { ok: true, failures: [] };
  }
  const conditions = Array.isArray(envelope.conditions) ? envelope.conditions : [];
  if (conditions.length === 0) return { ok: true, failures: [] };

  const matchMode = envelope.match === 'any' ? 'any' :
                    envelope.match === 'k_of_n' ? 'k_of_n' : 'all';

  if (matchMode === 'all') {
    return evaluateDataConditionList(conditions, scope);
  }

  // 'any' or 'k_of_n' — evaluate all conditions, count passes.
  const failures = [];
  let passCount = 0;
  for (const cond of conditions) {
    const result = evaluateDataCondition(cond, scope);
    if (result.ok) {
      passCount++;
    } else {
      failures.push({ cond, reason: result.reason });
    }
  }

  if (matchMode === 'any') {
    return passCount > 0 ? { ok: true, failures: [] } : { ok: false, failures };
  }

  // k_of_n
  const k = Number.isInteger(envelope.count) ? envelope.count : 1;
  return passCount >= k
    ? { ok: true, failures: [] }
    : { ok: false, failures };
}

/**
 * Human-readable description of a data-condition. Used by the studio's
 * editor for the condition row label and by the engine for failure
 * messages.
 */
export function describeDataCondition(cond) {
  if (!cond || typeof cond !== 'object') return 'invalid condition';
  // v2.70.4 — assertion_ref handled here as defense-in-depth. Runtime
  // call-sites flatten before describing; this branch covers any future
  // path that hands an unflattened envelope to the describer.
  if (cond.type === 'assertion_ref') {
    return cond.assertionId
      ? `references library assertion "${cond.assertionId}"`
      : 'references an unset library assertion';
  }
  if (!DATA_CONDITION_TYPES.includes(cond.type)) {
    return 'invalid condition';
  }
  switch (cond.type) {
    // List
    case 'binding_is_list':                return `${cond.binding || '?'} is a list`;
    case 'binding_length_min':             return `${cond.binding || '?'}.length >= ${cond.min || '?'}`;
    case 'binding_length_max':             return `${cond.binding || '?'}.length <= ${cond.max || '?'}`;
    case 'binding_length_range':           return `${cond.binding || '?'}.length in [${cond.min || '?'}..${cond.max || '?'}]`;
    case 'binding_length_exactly':         return `${cond.binding || '?'}.length == ${cond.count || '?'}`;
    case 'every_record_has_field':         return `every record in ${cond.binding || '?'} has field "${cond.fieldName || '?'}"`;
    case 'every_record_field_non_empty':   return `every record in ${cond.binding || '?'} has non-empty "${cond.fieldName || '?'}"`;
    case 'every_record_field_equals':      return `every record in ${cond.binding || '?'}.${cond.fieldName || '?'} == "${cond.value || '?'}"`;
    case 'every_record_field_starts_with': return `every record in ${cond.binding || '?'}.${cond.fieldName || '?'} starts with "${cond.value || '?'}"`;
    case 'every_record_field_in_set':      return `every record in ${cond.binding || '?'}.${cond.fieldName || '?'} in [${cond.values || '?'}]`;

    // Record
    case 'binding_is_record':              return `${cond.binding || '?'} is a record`;
    case 'record_has_field':               return `${cond.binding || '?'} has field "${cond.fieldName || '?'}"`;
    case 'record_field_non_empty':         return `${cond.binding || '?'}.${cond.fieldName || '?'} is non-empty`;

    // Scalar
    case 'binding_is_scalar':              return `${cond.binding || '?'} is a scalar`;
    case 'scalar_non_empty':               return `${cond.binding || '?'} is non-empty`;
    case 'scalar_is_number':               return `${cond.binding || '?'} is a number`;
    case 'scalar_equals':                  return `${cond.binding || '?'} == "${cond.value || '?'}"`;
    case 'scalar_number_range':            return `${cond.binding || '?'} in [${cond.min || '?'}..${cond.max || '?'}]`;
    case 'scalar_in_set':                  return `${cond.binding || '?'} in [${cond.values || '?'}]`;

    // Tagged-value kind checks (Pass 7c)
    case 'binding_is_section':             return `${cond.binding || '?'} is a section`;
    case 'binding_is_image':               return `${cond.binding || '?'} is an image`;
    case 'binding_is_document':            return `${cond.binding || '?'} is a document`;

    // Document assertions (Pass 7c)
    case 'document_min_length':            return `${cond.binding || '?'}.content.length >= ${cond.min || '?'}`;
    case 'document_contains':              return `${cond.binding || '?'}.content contains "${cond.value || '?'}"`;

    // ORCH predicate (converge) — render via the same label the chat surface shows
    case 'orch_predicate': {
      let spec = null; try { spec = JSON.parse(cond.specJson || '{}'); } catch { /* fall through */ }
      const lbl = spec ? predicateLabel(spec) : (cond.specJson || '?');
      return `${cond.binding || '?'}: ${lbl}`;
    }

    default: return cond.type;
  }
}
