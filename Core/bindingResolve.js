// Core/bindingResolve.js — CR-D4 (v2.74.943): THE paramBinding resolver. The same authored binding shape
// ({kind:'literal'|'strategy_param'|'iteration_variable', name, value?, field?}) was resolved by FOUR
// hand-rolled copies with divergent semantics — an unbound strategy_param left `{{TOKEN}}` visible in a
// fragment, became '' in a sieve, and hard-failed a NAVIGATE; the v2.50 `field` feature existed only in
// the fragment copy. One implementation; the per-site SEMANTICS stay explicit as a `policy` object at the
// call sites (no behavior change in this slice — consolidation only).
//
// Sources are abstracted as `lookupRaw(name) → raw tagged value | undefined` so a Scope (duck-typed via
// .get), a plain dict, or a custom chain (WorkflowExecutor's paramValues→workflowScope→iterStack — which
// keeps its own resolver for that reason, see its pairing comment) can all feed the same coercion table.
//
// Tagged-value coercion (Scope vocabulary): string → itself · scalar → value · element → selector ·
// list → policy.list ('join' = items joined ', ' | 'empty' = '' | 'error') · record → policy.record
// ('json' = JSON.stringify(fields) | 'string' = String(tagged) — the fragment legacy | 'empty') ·
// anything else → String(tagged).
//
// PURE. @module Core/bindingResolve

/** Coerce one raw tagged value per policy. Returns { ok, value } or { ok:false, error }. */
export function coerceTagged(tagged, { list = 'join', record = 'string' } = {}) {
  if (tagged === undefined) return { ok: true, value: undefined };
  if (typeof tagged === 'string') return { ok: true, value: tagged };
  if (tagged && tagged.kind === 'scalar') return { ok: true, value: String(tagged.value ?? '') };
  if (tagged && tagged.kind === 'element') return { ok: true, value: String(tagged.selector ?? '') };
  if (tagged && tagged.kind === 'list') {
    if (list === 'join') return { ok: true, value: (tagged.items || []).map((x) => x?.value ?? '').join(', ') };
    if (list === 'empty') return { ok: true, value: '' };
    return { ok: false, error: 'list binding not usable here' };
  }
  if (tagged && tagged.kind === 'record') {
    if (record === 'json') return { ok: true, value: JSON.stringify(tagged.fields ?? {}) };
    if (record === 'empty') return { ok: true, value: '' };
    return { ok: true, value: String(tagged) };
  }
  return { ok: true, value: String(tagged) };
}

/**
 * Resolve ONE binding. PURE.
 * @param {object|string|null} binding  authored binding (a bare string = literal when policy allows)
 * @param {(name:string) => any} lookupRaw  returns the RAW tagged value for a name (Scope.get or dict read)
 * @param {object} [policy]
 * @param {'unset'|'empty'|'error'} [policy.onMissing='unset']  unresolvable name / absent field
 * @param {'join'|'empty'|'error'}  [policy.list='join']
 * @param {'json'|'string'|'empty'} [policy.record='string']
 * @param {boolean} [policy.plainStringIsLiteral=false]  sieve back-compat: a bare string binding = literal
 * @returns {{ok:true, value:(string|undefined)} | {ok:false, error:string}}  value undefined = left unset
 */
export function resolveBinding(binding, lookupRaw, policy = {}) {
  const { onMissing = 'unset', plainStringIsLiteral = false } = policy;
  const miss = (what) => onMissing === 'error' ? { ok: false, error: what }
    : { ok: true, value: onMissing === 'empty' ? '' : undefined };

  if (!binding || typeof binding !== 'object') {
    if (plainStringIsLiteral) return { ok: true, value: String(binding ?? '') };
    return { ok: true, value: undefined };   // fragment legacy: non-object bindings are skipped
  }
  const kind = binding.kind ?? 'literal';
  if (kind === 'literal') return { ok: true, value: String(binding.value ?? '') };
  if (kind !== 'strategy_param' && kind !== 'iteration_variable') {
    return onMissing === 'empty' ? { ok: true, value: '' } : miss(`unknown binding kind "${kind}"`);
  }

  const name = binding.name ?? '';
  const raw = name ? lookupRaw(name) : undefined;
  if (raw === undefined || raw === null) return miss(`${kind} "${name}" not found in scope`);

  // v2.50.0 — iteration record field access (was fragment-only; now every adopter has it).
  if (kind === 'iteration_variable' && binding.field && typeof binding.field === 'string') {
    if (raw && typeof raw === 'object') {
      const rec = (raw.record && typeof raw.record === 'object') ? raw.record : null;
      const fv = rec ? rec[binding.field] : undefined;
      if (fv !== undefined && fv !== null) return { ok: true, value: String(fv) };
    }
    return miss(`field "${binding.field}" not on the iteration record for "${name}"`);
  }

  const co = coerceTagged(raw, policy);
  if (!co.ok) return { ok: false, error: `${kind} "${name}": ${co.error}` };
  return { ok: true, value: co.value };
}

/**
 * Resolve a whole paramBindings map. Unset values are OMITTED from `values` (the fragment contract);
 * 'empty' policy writes ''. The first error (onMissing/list 'error') is surfaced in `errors`.
 * @returns {{values: Record<string,string>, errors: Array<{name:string, error:string}>}}
 */
export function resolveBindings(paramBindings, lookupRaw, policy = {}) {
  const values = {};
  const errors = [];
  for (const [paramName, binding] of Object.entries(paramBindings ?? {})) {
    const r = resolveBinding(binding, lookupRaw, policy);
    if (!r.ok) { errors.push({ name: paramName, error: r.error }); continue; }
    if (r.value !== undefined) values[paramName] = r.value;
  }
  return { values, errors };
}

/** The standard lookup for a Scope-or-dict source (the duck-typing the engine used inline). */
export function scopeLookup(source) {
  const isScope = source && typeof source.get === 'function';
  return (name) => (isScope ? source.get(name) : source?.[name]);
}
