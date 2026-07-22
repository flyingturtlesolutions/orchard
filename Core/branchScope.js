/**
 * Core/branchScope.js — PP-1 (v2.74.1661): the BRANCH reach, pure half.
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §1.1c (the predicate ceiling + the binding-granularity rule) ·
 * §2.0.1 (the adapter and its pre-check obligation) · §1.2 (the three-outcome contract).
 *
 * This is the ADAPTER between a per-item record and the canonical scope-side condition evaluator
 * (`Services/DataAssertion.js` → `evaluateDataCondition(cond, scope)`). PP-0 established that the reach is an
 * adapter and not a lowering layer: a scope-family predicate needs no tab, so the per-item pipeline calls the
 * existing evaluator directly rather than lowering into strategy nodes.
 *
 * ── Why this file is pure, and injects ──────────────────────────────────────────────────────────────────────
 * Like `Core/branchClause.js`, nothing here imports the evaluator or the Scope class. `planBindings` and
 * `precheckCondition` are pure functions over plain objects, and `makeBranchEvaluator` takes BOTH the evaluator
 * and the scope accessor as arguments. That keeps the whole contract unit-testable with no Services import, no
 * chrome API, and no DOM — and it is the same injection that let branchClause.js be built before PP-0 answered.
 *
 * ── THE TWO FINDINGS THIS FILE EXISTS TO ENCODE ─────────────────────────────────────────────────────────────
 *
 * 1. THE BINDING-GRANULARITY RULE (§1.1c). `orch_predicate` carries NO `fieldName` — it coerces the WHOLE
 *    binding, and a record coerces to `Object.values(fields).join(' ')`. So `contains` over a record binding
 *    searches every field at once and `gt` parses the first number out of a concatenated blob. A field that
 *    needs a rich predicate must therefore be bound SEPARATELY. `planBindings` is that rule, mechanized.
 *
 * 2. THE PRE-CHECK OBLIGATION (§2.0.1). `evaluateDataCondition` returns `{ok, reason}`, and EVERY failure path
 *    returns `ok:false` — unbound binding, wrong kind, missing field, empty needle, and a caught throw alike.
 *    FALSE and COULD-NOT-EVALUATE are already merged, separated only by prose in `reason`. Parsing `reason` to
 *    recover the distinction would pin routing to diagnostic text that is formatted for humans and free to
 *    change. So the adapter PRE-CHECKS and answers UNKNOWN itself; only a pre-check that passes lets a returned
 *    `ok:false` mean a genuine FALSE.
 *
 *    Without the pre-check this is the v1637 bug one layer down: a merely-absent field routes the item to
 *    `otherwise` exactly as an unreachable read once scored as a miss.
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

/** The record binding's reserved name. A field literally called this collides — reported, never silently shadowed. */
export const RECORD_BINDING = 'item';

/**
 * Strings at or above this length bind as `document` rather than `scalar`, so `document_contains` and
 * `orch_predicate contains` both reach them. Below it a value binds as `scalar`, where `scalar_equals` /
 * `scalar_in_set` / numeric comparison apply. This is a MECHANICAL default, not a semantic judgement — an
 * explicit `fieldKinds` declaration always wins (§1.3: catalog and workflow are authoritative).
 */
export const DOC_MIN_LENGTH = 200;

/** Ops `evaluatePredicate` actually implements. Read from the switch in Core/orchAnalyze.js, not inferred. */
export const ORCH_PREDICATE_OPS = Object.freeze([
  'exists', 'none', 'contains', 'not_contains', 'gt', 'gte', 'lt', 'lte', 'eq',
]);

/**
 * The kind each condition family requires of its binding, and whether a MISSING field is FALSE or UNKNOWN.
 *
 * The `absentField` column is the subtle one. `record_has_field` ASKS whether the field is there, so absent is a
 * legitimate FALSE — answering unknown would make the presence test unable to say "no". `record_field_non_empty`
 * asks whether a present field has content; if the field is absent there is nothing to judge, so it is UNKNOWN.
 * Collapsing that second case into FALSE is precisely what §2.0.1 forbids.
 */
const _COND_KIND = Object.freeze({
  binding_is_list: { kind: null }, binding_is_scalar: { kind: null }, binding_is_record: { kind: null },
  binding_is_section: { kind: null }, binding_is_image: { kind: null }, binding_is_document: { kind: null },

  binding_length_min: { kind: 'list' }, binding_length_max: { kind: 'list' },
  binding_length_range: { kind: 'list' }, binding_length_exactly: { kind: 'list' },

  every_record_has_field: { kind: 'list' }, every_record_field_non_empty: { kind: 'list' },
  every_record_field_equals: { kind: 'list' }, every_record_field_starts_with: { kind: 'list' },
  every_record_field_in_set: { kind: 'list' },

  record_has_field: { kind: 'record', absentField: 'false' },
  record_field_non_empty: { kind: 'record', absentField: 'unknown' },

  scalar_non_empty: { kind: 'scalar' }, scalar_is_number: { kind: 'scalar' },
  scalar_equals: { kind: 'scalar' }, scalar_number_range: { kind: 'scalar' }, scalar_in_set: { kind: 'scalar' },

  document_min_length: { kind: 'document' }, document_contains: { kind: 'document' },

  orch_predicate: { kind: null },
});

/** A `binding_is_<kind>` condition is a KIND TEST — a mismatch is the ANSWER (false), never an unknown. */
const _isKindTest = (t) => typeof t === 'string' && t.startsWith('binding_is_');

/**
 * Decide how each of an item's fields binds. PURE.
 *
 * This is §1.1c's binding-granularity rule mechanized: the record binds whole (for `record_has_field` /
 * `record_field_non_empty`, which DO take a `fieldName`), and EVERY field additionally binds on its own, because
 * `orch_predicate` has no `fieldName` and would otherwise flatten the record.
 *
 * Binding every field is deliberate. The declaration question (§1.3) is which PREDICATE is right for a field —
 * deterministic for structured, model classification for free text. Which bindings EXIST is mechanical: a field
 * you cannot address is a field you cannot test, and inferring that set would reintroduce the guessing §1.3
 * removes.
 *
 * @param {Object} item                      the per-item record (plain field map)
 * @param {Object} [opts]
 * @param {Object} [opts.fieldKinds]         explicit `{ fieldName: 'document'|'scalar'|'number' }` — always wins
 * @param {number} [opts.docMinLength]       override the mechanical string-length threshold
 * @returns {{bindings:Array<{name:string,kind:string,field:string|null,value:*}>, collisions:string[]}}
 */
export function planBindings(item, { fieldKinds = null, docMinLength = DOC_MIN_LENGTH } = {}) {
  const rec = (item && typeof item === 'object') ? item : {};
  const declared = (fieldKinds && typeof fieldKinds === 'object') ? fieldKinds : {};
  const bindings = [{ name: RECORD_BINDING, kind: 'record', field: null, value: { ...rec } }];
  const collisions = [];

  for (const [field, raw] of Object.entries(rec)) {
    if (field === RECORD_BINDING) { collisions.push(field); continue; }   // reported, not silently shadowed

    const want = _str(declared[field]).toLowerCase();
    let kind;
    let value = raw;

    if (want === 'document') kind = 'document';
    else if (want === 'number') { kind = 'scalar'; value = raw; }
    else if (want === 'scalar') kind = 'scalar';
    else if (typeof raw === 'string' && raw.length >= docMinLength) kind = 'document';
    else kind = 'scalar';

    bindings.push({ name: field, kind, field, value, subtype: want === 'number' ? 'number' : undefined });
  }
  return { bindings, collisions };
}

/**
 * Pre-check one condition against a binding lookup, BEFORE the real evaluator sees it. PURE.
 *
 * @param {Object} cond                 a scope-family condition ({type, binding, fieldName?, specJson?, ...})
 * @param {(name:string) => *} lookup   returns the tagged value bound under `name`, or undefined
 * @returns {{verdict:'pass'|'false'|'unknown', why:string}}
 *          'pass'    → safe to delegate; a returned ok:false now means a genuine FALSE
 *          'false'   → answerable here, and the answer is NO (kind tests, absent field on record_has_field)
 *          'unknown' → could not evaluate; the caller must NOT treat this as false
 */
export function precheckCondition(cond, lookup) {
  const c = (cond && typeof cond === 'object') ? cond : null;
  if (!c) return { verdict: 'unknown', why: 'condition is not an object' };

  const t = _str(c.type);
  if (!t) return { verdict: 'unknown', why: 'condition has no type' };

  const spec = _COND_KIND[t];
  if (!spec) return { verdict: 'unknown', why: `unknown condition type "${t}"` };

  const name = _str(c.binding);
  if (!name) return { verdict: 'unknown', why: `condition "${t}" names no binding` };

  const v = typeof lookup === 'function' ? lookup(name) : undefined;
  if (v == null) return { verdict: 'unknown', why: `binding "${name}" is unbound` };

  const kind = v && typeof v === 'object' ? v.kind : null;

  // A kind TEST answers itself — `binding_is_record` over a scalar is FALSE, not undecidable.
  if (_isKindTest(t)) {
    const want = t.slice('binding_is_'.length);
    return kind === want ? { verdict: 'pass', why: '' } : { verdict: 'false', why: '' };
  }

  if (spec.kind && kind !== spec.kind) {
    return { verdict: 'unknown', why: `binding "${name}" is kind=${kind}, condition "${t}" needs ${spec.kind}` };
  }

  // Field presence — the §2.0.1 case. Absent means UNKNOWN except where presence IS the question.
  if (spec.absentField) {
    const fname = _str(c.fieldName);
    if (!fname) return { verdict: 'unknown', why: `condition "${t}" names no fieldName` };
    const fields = (v && v.fields && typeof v.fields === 'object') ? v.fields : {};
    const present = Object.prototype.hasOwnProperty.call(fields, fname);
    if (!present) {
      return spec.absentField === 'false'
        ? { verdict: 'false', why: '' }
        : { verdict: 'unknown', why: `record has no field "${fname}"` };
    }
  }

  // orch_predicate — validate the spec HERE, because the evaluator's own default arm fails OPEN under negate.
  //
  // `evaluatePredicate` sets `r = false` for an unrecognized op and then applies `spec.negate ? !r : r`
  // unconditionally, so `{op:'typo', negate:true}` returns TRUE. In a branch that means a typo'd arm matches
  // EVERY item. Validating the op before delegating closes the hole from this side; see the standalone fix for
  // the evaluator itself.
  if (t === 'orch_predicate') {
    let parsed;
    try { parsed = JSON.parse(c.specJson || '{}'); }
    catch { return { verdict: 'unknown', why: 'orch_predicate specJson is not valid JSON' }; }
    const op = parsed && typeof parsed === 'object' ? _str(parsed.op) : '';
    if (!op) return { verdict: 'unknown', why: 'orch_predicate spec names no op' };
    if (!ORCH_PREDICATE_OPS.includes(op)) {
      return { verdict: 'unknown', why: `orch_predicate op "${op}" is not implemented (fails closed here; the evaluator would fail OPEN under negate)` };
    }
  }

  return { verdict: 'pass', why: '' };
}

/**
 * Build the evaluator `evalBranch` injects. PURE given pure inputs.
 *
 * Returns `(assertion, item) => true | false | undefined`, which is exactly the contract
 * `Core/branchClause.js#evalBranch` documents: TRUE matched · FALSE did not match · UNDEFINED could not tell.
 *
 * @param {Object} deps
 * @param {(cond:Object, scope:Object) => ({ok:boolean, reason?:string}|boolean)} deps.evaluate
 *        the real evaluator — `evaluateDataCondition` in production, a stub in tests
 * @param {Object} deps.scope           passed straight through to `evaluate`
 * @param {(name:string) => *} deps.lookup  binding accessor used by the pre-check (`scope.get.bind(scope)`)
 * @param {(line:string) => void} [deps.onUnknown]  optional disposition sink — §5.5 logs unknowns LOUDLY
 * @returns {(assertion:Object) => (boolean|undefined)}
 */
export function makeBranchEvaluator({ evaluate, scope, lookup, onUnknown = null } = {}) {
  return function evaluateAssertion(assertion) {
    const pre = precheckCondition(assertion, lookup);
    if (pre.verdict === 'false') return false;
    if (pre.verdict === 'unknown') {
      if (onUnknown) { try { onUnknown(pre.why); } catch { /* a logging failure must never change a verdict */ } }
      return undefined;
    }
    if (typeof evaluate !== 'function') {
      if (onUnknown) { try { onUnknown('no evaluator supplied'); } catch { /* see above */ } }
      return undefined;
    }

    let r;
    try { r = evaluate(assertion, scope); }
    catch (e) {
      const why = `evaluator threw: ${(e && e.message) || e}`;
      if (onUnknown) { try { onUnknown(why); } catch { /* see above */ } }
      return undefined;   // a throw is UNKNOWN, never FALSE
    }

    // The pre-check passed, so ok:false is now a genuine negative rather than a merged could-not-evaluate.
    if (typeof r === 'boolean') return r;
    if (r && typeof r === 'object' && typeof r.ok === 'boolean') return r.ok;
    const why = `evaluator returned ${r === null ? 'null' : typeof r}, expected {ok} or boolean`;
    if (onUnknown) { try { onUnknown(why); } catch { /* see above */ } }
    return undefined;
  };
}
