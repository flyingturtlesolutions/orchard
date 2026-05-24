/**
 * @file Services/ConditionVocabulary.js
 * @description Canonical schema for the unified assertion/condition vocabulary.
 *
 * v2.70.0 — Unification. Assertion.js and DataAssertion.js previously
 * carried two parallel schemas: page-side conditions (DOM state, URL,
 * cookies) and scope-side conditions (lists, records, scalars). This
 * file unifies them into one schema where each condition type carries
 * a `family` tag — `'page'` for content-script-evaluated, `'scope'` for
 * engine-evaluated against scope bindings.
 *
 * Both Assertion.js (page-side evaluator) and DataAssertion.js
 * (scope-side evaluator) re-export their public schema from this file.
 * Editors filter the type dropdown by the families a call-site allows.
 *
 * Migration: Analysis pre/post conditions, previously stored as flat
 * arrays of conditions, are now wrapped in the assertion envelope
 * (`{match, conditions}`) at read time. The unification lets a single
 * assertion envelope contain a mix of page and scope conditions; this
 * unlocks strategy-level data conditions (LOOP until OUTPUT.length >= N).
 *
 * Per-call-site family allowlists:
 *   Fragment pre/post              → ['page']
 *   Analysis pre/post              → ['scope']
 *   Strategy DETECT/LOOP/WAIT_FOR  → ['page', 'scope']
 *   Library assertion              → ['page', 'scope']
 *   Observation pre (future)       → ['page']
 *   Observation post (future)      → ['scope']
 *
 * @module Services/ConditionVocabulary
 */

/**
 * All condition types. Order is meaningful — editors render dropdown
 * options in this order within each family group.
 *
 * Adding a new type:
 *   1. Append to this list (in the appropriate family section).
 *   2. Add its schema to CONDITION_FIELDS with `family` tag.
 *   3. Add its evaluator branch in Assertion.js (page) or DataAssertion.js (scope).
 *   4. Add its describer branch in DataAssertion.js if scope-family.
 */
export const CONDITION_TYPES = Object.freeze([
  // ── Page family — DOM/URL/browser-signal conditions ─────────────────────
  'selector_present',
  'selector_absent',
  'url_matches',
  'text_present',
  'attribute_equals',
  'resource_loaded',
  'cookie_present',
  'meta_equals',

  // ── Scope family — list assertions ──────────────────────────────────────
  'binding_is_list',
  'binding_length_min',
  'binding_length_max',
  'binding_length_range',
  'binding_length_exactly',
  'every_record_has_field',
  'every_record_field_non_empty',
  'every_record_field_equals',
  'every_record_field_starts_with',
  'every_record_field_in_set',

  // ── Scope family — record assertions ────────────────────────────────────
  'binding_is_record',
  'record_has_field',
  'record_field_non_empty',

  // ── Scope family — scalar assertions ────────────────────────────────────
  'binding_is_scalar',
  'scalar_non_empty',
  'scalar_is_number',
  'scalar_equals',
  'scalar_number_range',
  'scalar_in_set',

  // ── Scope family — tagged-value kind checks (Pass 7c) ───────────────────
  // Defensive type checks for the newer typed scope kinds. Used in pre/post
  // contracts where the author wants to assert "this binding is a section,
  // image, or document" before using its sub-fields.
  'binding_is_section',
  'binding_is_image',
  'binding_is_document',

  // ── Scope family — document assertions (Pass 7c) ────────────────────────
  // Author-facing checks on composed document outputs. Useful for
  // postconditions on template-body Analyses.
  'document_min_length',
  'document_contains',

  // ── Scope family — record-field assertions (FOREACH iteration variable) ─
  // These predate Pass 3 and operate on a bound iteration variable's record.
  // Tagged 'scope' because they read scope; only meaningful when scope
  // contains the named variable (typically inside a FOREACH).
  'field_equals',
  'field_present',
  'field_gt',
  'field_lt',
  'field_gte',
  'field_lte',

  // ── Reference (cross-family) ────────────────────────────────────────────
  // assertion_ref points at a Ground-scoped library assertion. The
  // referenced assertion's effective family is the union of its
  // contained conditions' families. Resolved at evaluation time.
  // v2.72.29 (Pass 17) — perspective_ref points at a Ground-scoped Perspective.
  // Evaluation: at primitive entry, the perspective's landmarks are queried
  // against the live page; the condition holds if all landmarks match
  // ≥1 element. Effective family is page (DOM-touching).
  'assertion_ref',
  'perspective_ref',
]);

/**
 * Per-type schema. Each entry has:
 *   - family:   'page' | 'scope' | 'reference' — drives editor filtering and
 *               evaluator dispatch.
 *   - fields:   ordered list of all fields the type carries.
 *   - required: subset of fields that must be non-empty at validation.
 *   - regex:    (optional) subset of fields whose value must compile as
 *               a JS RegExp.
 *
 * Numeric fields (min/max/count) are stored as strings because the editor
 * surfaces them as text inputs that accept param placeholders ("{{COUNT}}").
 * The evaluator coerces to number at evaluation time.
 *
 * Set-valued fields (`values`) store a comma-separated list as a string;
 * parsed at evaluate time. Whitespace around delimiters is stripped.
 */
export const CONDITION_FIELDS = Object.freeze({
  // ── Page family ─────────────────────────────────────────────────────────
  // v2.70.6 — Sub-grouped by 'dom' vs 'browser' for editor UX. DOM types
  // assert facts about the document tree (visible elements, text, attributes).
  // Browser types assert facts about non-DOM page state — URL bar, page
  // meta tags, cookies, and network history. The subfamily drives editor
  // optgroup organization; runtime evaluation is identical.
  selector_present: { family: 'page', subfamily: 'dom',     fields: ['selector'],                       required: ['selector'] },
  selector_absent:  { family: 'page', subfamily: 'dom',     fields: ['selector'],                       required: ['selector'] },
  url_matches:      { family: 'page', subfamily: 'browser', fields: ['pattern'],                        required: ['pattern'], regex: ['pattern'] },
  // v2.74.170 — Optional `selector` field scopes the text search to a
  // specific section of the page. When absent (back-compat default), the
  // evaluator searches the whole body's innerText. When present, it
  // queries that selector and searches only its innerText. `text` remains
  // required; `selector` is optional and not enforced by the validator.
  text_present:     { family: 'page', subfamily: 'dom',     fields: ['text', 'selector'],                required: ['text'] },
  attribute_equals: { family: 'page', subfamily: 'dom',     fields: ['selector', 'attribute', 'value'], required: ['selector', 'attribute'] },
  resource_loaded:  { family: 'page', subfamily: 'browser', fields: ['pattern'],                        required: ['pattern'], regex: ['pattern'] },
  cookie_present:   { family: 'page', subfamily: 'browser', fields: ['name'],                           required: ['name'] },
  meta_equals:      { family: 'page', subfamily: 'browser', fields: ['name', 'httpEquiv', 'value', 'valuePattern'], required: [], regex: ['valuePattern'] },

  // ── Scope family — lists ────────────────────────────────────────────────
  binding_is_list:                  { family: 'scope', subfamily: 'list',   fields: ['binding'],                          required: ['binding'] },
  binding_length_min:               { family: 'scope', subfamily: 'list',   fields: ['binding', 'min'],                   required: ['binding', 'min'] },
  binding_length_max:               { family: 'scope', subfamily: 'list',   fields: ['binding', 'max'],                   required: ['binding', 'max'] },
  binding_length_range:             { family: 'scope', subfamily: 'list',   fields: ['binding', 'min', 'max'],            required: ['binding', 'min', 'max'] },
  binding_length_exactly:           { family: 'scope', subfamily: 'list',   fields: ['binding', 'count'],                 required: ['binding', 'count'] },
  every_record_has_field:           { family: 'scope', subfamily: 'list',   fields: ['binding', 'fieldName'],             required: ['binding', 'fieldName'] },
  every_record_field_non_empty:     { family: 'scope', subfamily: 'list',   fields: ['binding', 'fieldName'],             required: ['binding', 'fieldName'] },
  every_record_field_equals:        { family: 'scope', subfamily: 'list',   fields: ['binding', 'fieldName', 'value'],    required: ['binding', 'fieldName', 'value'] },
  every_record_field_starts_with:   { family: 'scope', subfamily: 'list',   fields: ['binding', 'fieldName', 'value'],    required: ['binding', 'fieldName', 'value'] },
  every_record_field_in_set:        { family: 'scope', subfamily: 'list',   fields: ['binding', 'fieldName', 'values'],   required: ['binding', 'fieldName', 'values'] },

  // ── Scope family — records ──────────────────────────────────────────────
  binding_is_record:                { family: 'scope', subfamily: 'record', fields: ['binding'],                          required: ['binding'] },
  record_has_field:                 { family: 'scope', subfamily: 'record', fields: ['binding', 'fieldName'],             required: ['binding', 'fieldName'] },
  record_field_non_empty:           { family: 'scope', subfamily: 'record', fields: ['binding', 'fieldName'],             required: ['binding', 'fieldName'] },

  // ── Scope family — scalars ──────────────────────────────────────────────
  binding_is_scalar:                { family: 'scope', subfamily: 'scalar', fields: ['binding'],                          required: ['binding'] },
  scalar_non_empty:                 { family: 'scope', subfamily: 'scalar', fields: ['binding'],                          required: ['binding'] },
  scalar_is_number:                 { family: 'scope', subfamily: 'scalar', fields: ['binding'],                          required: ['binding'] },
  scalar_equals:                    { family: 'scope', subfamily: 'scalar', fields: ['binding', 'value'],                 required: ['binding', 'value'] },
  scalar_number_range:              { family: 'scope', subfamily: 'scalar', fields: ['binding', 'min', 'max'],            required: ['binding', 'min', 'max'] },
  scalar_in_set:                    { family: 'scope', subfamily: 'scalar', fields: ['binding', 'values'],                required: ['binding', 'values'] },

  // ── Scope family — tagged-value kind checks (Pass 7c) ───────────────────
  binding_is_section:               { family: 'scope', subfamily: 'tagged-value', fields: ['binding'],                    required: ['binding'] },
  binding_is_image:                 { family: 'scope', subfamily: 'tagged-value', fields: ['binding'],                    required: ['binding'] },
  binding_is_document:              { family: 'scope', subfamily: 'tagged-value', fields: ['binding'],                    required: ['binding'] },

  // ── Scope family — document assertions (Pass 7c) ────────────────────────
  document_min_length:              { family: 'scope', subfamily: 'document', fields: ['binding', 'min'],                 required: ['binding', 'min'] },
  document_contains:                { family: 'scope', subfamily: 'document', fields: ['binding', 'value'],               required: ['binding', 'value'] },

  // ── Scope family — record-field on iteration variable ───────────────────
  // These predate the list/record/scalar subfamilies. Tagged subfamily 'record-field'
  // because they look up fields on a named iteration variable's record. Editor
  // groups them separately for clarity.
  field_equals:     { family: 'scope', subfamily: 'record-field', fields: ['variable', 'field', 'value'],     required: ['variable', 'field'] },
  field_present:    { family: 'scope', subfamily: 'record-field', fields: ['variable', 'field'],              required: ['variable', 'field'] },
  field_gt:         { family: 'scope', subfamily: 'record-field', fields: ['variable', 'field', 'value'],     required: ['variable', 'field', 'value'] },
  field_lt:         { family: 'scope', subfamily: 'record-field', fields: ['variable', 'field', 'value'],     required: ['variable', 'field', 'value'] },
  field_gte:        { family: 'scope', subfamily: 'record-field', fields: ['variable', 'field', 'value'],     required: ['variable', 'field', 'value'] },
  field_lte:        { family: 'scope', subfamily: 'record-field', fields: ['variable', 'field', 'value'],     required: ['variable', 'field', 'value'] },

  // ── Reference ───────────────────────────────────────────────────────────
  assertion_ref:    { family: 'reference', fields: ['assertionId'],                required: ['assertionId'] },
  // v2.72.29 (Pass 17) — perspective_ref. Points at a Perspective on the same Ground.
  // Evaluation: query each landmark's selector against the live page;
  // condition holds if all landmarks match ≥1 element. Pure DOM check;
  // does NOT walk to the perspective's verification metadata (that's authoring
  // history, not runtime fact).
  perspective_ref:       { family: 'reference', fields: ['perspectiveId'],                   required: ['perspectiveId'] },
});

/**
 * Allowed match modes for a assertion envelope.
 *   'all'    — AND across all conditions.
 *   'any'    — OR across all conditions (at least one must hold).
 *   'k_of_n' — at least `assertion.count` of N conditions must hold.
 *              Requires the envelope to carry a numeric `count` field.
 *
 * Used by the assertion evaluator (TemplateWalker, ExecutionEngine) to
 * decide combination semantics. Editors filter the dropdown to these
 * three values.
 */
export const MATCH_MODES = Object.freeze(['all', 'any', 'k_of_n']);

/**
 * Return condition types whose family is in the allowed list. Used by
 * editors to filter the dropdown per call-site.
 *
 * Examples:
 *   getTypesByFamily(['page'])           → page conditions (Fragments)
 *   getTypesByFamily(['scope'])          → scope conditions (Analyses)
 *   getTypesByFamily(['page','scope'])   → both (strategies, library)
 *
 * `assertion_ref` is included in any non-empty allowlist — references
 * are valid anywhere assertions are, with family compatibility checked
 * separately (the referenced assertion's contents must be a subset of
 * the call-site's allowlist).
 */
export function getTypesByFamily(allowedFamilies) {
  if (!Array.isArray(allowedFamilies) || allowedFamilies.length === 0) return [];
  const allowed = new Set(allowedFamilies);
  return CONDITION_TYPES.filter(t => {
    const fam = CONDITION_FIELDS[t]?.family;
    if (fam === 'reference') return true;
    return allowed.has(fam);
  });
}

/**
 * Get the family of a condition type. Returns null if unknown.
 */
export function getFamily(conditionType) {
  return CONDITION_FIELDS[conditionType]?.family ?? null;
}

/**
 * Get the subfamily (within the scope family) of a condition type.
 * Returns null for non-scope types or scope types without a subfamily tag.
 *
 * Subfamilies group scope conditions by what they operate on:
 *   'list'         — list-binding assertions (binding_is_list, binding_length_*, every_record_*).
 *   'record'       — record-binding assertions (binding_is_record, record_has_field, record_field_*).
 *   'scalar'       — scalar-binding assertions (binding_is_scalar, scalar_*).
 *   'record-field' — assertions that look up fields on a named iteration variable's record.
 *
 * The editor uses these to render <optgroup>s within the scope dropdown.
 */
export function getSubfamily(conditionType) {
  return CONDITION_FIELDS[conditionType]?.subfamily ?? null;
}

/**
 * Compute the effective families a assertion's contents touch. Walks
 * conditions and returns a Set of families. Used for assertion_ref
 * compatibility checks: if a library assertion's effective families
 * aren't a subset of the call-site's allowlist, the reference is
 * flagged as incompatible.
 *
 * Note: this does NOT recursively resolve assertion_ref entries — the
 * caller passes already-resolved assertions, or accepts that nested
 * references contribute 'reference' to the result.
 */
export function effectiveFamilies(assertion) {
  const families = new Set();
  const conds = Array.isArray(assertion?.conditions) ? assertion.conditions : [];
  for (const c of conds) {
    const fam = getFamily(c?.type);
    if (fam) families.add(fam);
  }
  return families;
}

/**
 * Parse a comma-separated value list into an array of trimmed non-empty
 * strings. Used by *_in_set assertions whose `values` field is stored
 * as a comma-separated string in the editor.
 *
 * Examples:
 *   "active,inactive,pending"  → ['active', 'inactive', 'pending']
 *   " yes , no "               → ['yes', 'no']
 *   "a,,b"                     → ['a', 'b']
 *   ""                         → []
 */
export function parseValueSet(raw) {
  if (raw == null) return [];
  return String(raw).split(',').map(s => s.trim()).filter(s => s.length > 0);
}

/**
 * Extract a record from a list item.
 *
 * Items can come in three shapes:
 *   - Element-tagged: { kind: 'element', record: {...}, ... }     ← cache output
 *   - Record-tagged:  { kind: 'record',  fields: {...} }          ← Scope record
 *   - Bare object:    { fieldA: ..., fieldB: ... }                ← T3 list output
 *
 * Returns the field-bearing object, or null if the item has no
 * record-shape (a scalar list item, a primitive, etc.).
 */
export function itemToRecord(item) {
  if (!item || typeof item !== 'object') return null;
  if (item.record && typeof item.record === 'object') return item.record;
  if (item.fields && typeof item.fields === 'object') return item.fields;
  if (typeof item.kind === 'string') return null;
  return item;
}

/**
 * Wrap a flat-array preconditions/postconditions value into the
 * assertion envelope shape. Used by storage read-time migration to
 * normalize legacy Analysis pre/post arrays into the unified shape.
 *
 * Idempotent — already-wrapped envelopes pass through unchanged.
 */
export function wrapInAssertionEnvelope(value) {
  if (!value) return { match: 'all', conditions: [] };
  // Already a assertion envelope.
  if (typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.conditions)) {
    return {
      match: value.match === 'any' ? 'any' : 'all',
      conditions: value.conditions,
    };
  }
  // Legacy flat array of conditions.
  if (Array.isArray(value)) {
    return { match: 'all', conditions: value };
  }
  // Anything else — empty envelope.
  return { match: 'all', conditions: [] };
}
