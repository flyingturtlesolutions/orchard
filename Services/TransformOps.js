/**
 * @file Services/TransformOps.js
 * @description Operation registry for the Analysis "transform" body kind.
 *
 * The transform body is the third body kind for cache-tier Analyses
 * (alongside `operations` for list-pipeline reductions and `template`
 * for document composition). It takes declared named inputs, chains a
 * sequence of ops that read named bindings and write named bindings,
 * and exposes a declared set of outputs.
 *
 *   inputs:  [{ name: 'RAW',  expects: 'scalar' }]
 *   ops:     [{ op: 'replace', in: 'RAW', find: ' Jr.', replacement: '', out: 'TRIMMED' }, ...]
 *   outputs: [{ name: 'KEY',  expects: 'scalar' }]
 *
 * ── This module ──────────────────────────────────────────────────────
 *
 * The registry below is the single source of truth for:
 *   - what ops exist
 *   - what inputs each op accepts (kind contracts, fixed-arity or
 *     variadic)
 *   - what kind each op produces
 *   - what configurable fields each op takes (form schema)
 *   - the runtime function that actually transforms tagged values
 *
 * Consumers:
 *   - Studio/AnalysisForm.js — renders per-op field UIs from `fields`
 *   - ExecutionEngine.js — dispatches each op via `run`
 *   - validateTransformBody (below) — save-time check of input/output
 *     kind compatibility, binding references, duplicate `out` names,
 *     undeclared-output errors, etc.
 *
 * ── Adding a new op ──────────────────────────────────────────────────
 *
 * 1. Add an entry to `OPS` keyed by the op id (the value stored as
 *    `op.op` in the saved body).
 * 2. Declare inputs: an array of input slots (`{ key, kind, label }`)
 *    for fixed-arity ops, or `{ variadic: true, kind, minCount, label }`
 *    for variadic ops like concat.
 * 3. Declare output kind (and optional itemKind for list outputs).
 * 4. Declare fields (form schema): each has a `key`, `type`
 *    (`string` | `boolean`), `label`, `required`, `default`,
 *    `supportsParam` (whether {{PARAM}} placeholders are expanded in
 *    the value), and `hint`.
 * 5. Implement `run({ inputs, fields }) → TaggedValue`. Inputs are
 *    already-resolved tagged values; the function should produce a
 *    new tagged value of the declared output kind. Throw on invalid
 *    runtime conditions; the runtime translates throws into step
 *    failures with helpful messages.
 *
 * ── First ship: strings family ──────────────────────────────────────
 *
 * v2.74.132 ships just `replace` to prove the end-to-end architecture.
 * Other string ops (trim, lowercase, uppercase, concat, split) follow
 * in subsequent versions as registry entries — no architecture changes
 * needed. Number / coercion ops are an obvious follow-on family.
 *
 * @module Services/TransformOps
 */

import { scalar, list, isKind } from './Scope.js';

// ── Op registry ────────────────────────────────────────────────────────

/**
 * @typedef {Object} InputSlot
 * @property {string} key             - field name on the op object
 * @property {string} kind            - expected scope-binding kind
 * @property {string} [label]         - form display label
 * @property {boolean} [variadic]     - if true, key holds an array of binding names
 * @property {number} [minCount]      - min items for variadic (default 1)
 */

/**
 * @typedef {Object} FieldSchema
 * @property {string} key             - field name on the op object
 * @property {string} type            - 'string' | 'boolean'
 * @property {string} [label]         - form display label
 * @property {boolean} [required]     - default false
 * @property {*} [default]            - default value at form creation time
 * @property {boolean} [supportsParam] - if true, {{NAME}} placeholders substituted by AnalysisParams
 * @property {string} [hint]          - form help text
 */

/**
 * @typedef {Object} OpDef
 * @property {string} id              - registry key + saved `op.op` value
 * @property {string} label           - form display label
 * @property {string} hint            - one-line description
 * @property {InputSlot[]} inputs     - input slot declarations
 * @property {{ kind: string, itemKind?: string }} output - output kind contract
 * @property {FieldSchema[]} fields   - op-specific field schemas
 * @property {(args: { inputs: Object, fields: Object }) => Object} run
 */

/** @type {Object<string, OpDef>} */
export const OPS = Object.freeze({

  // ── String ops ──────────────────────────────────────────────────────

  replace: {
    id: 'replace',
    label: 'replace',
    hint: 'Replace occurrences of a substring or regex match.',
    inputs: [
      { key: 'in', kind: 'scalar', label: 'Input' },
    ],
    output: { kind: 'scalar' },
    fields: [
      { key: 'find',        type: 'string',  label: 'Find',        required: true,  supportsParam: true,
        hint: 'Literal substring (or regex pattern when "Regex" is on)' },
      { key: 'replacement', type: 'string',  label: 'Replacement', required: false, supportsParam: true,
        default: '', hint: 'String to substitute. Empty deletes the matches.' },
      { key: 'regex',       type: 'boolean', label: 'Regex',       default: false,
        hint: 'Treat Find as a regular expression' },
      { key: 'flags',       type: 'string',  label: 'Flags',       required: false, supportsParam: true,
        default: 'g', hint: 'Regex flags (g, i, m, …). Ignored when Regex is off (literal mode is always global).' },
    ],
    run: ({ inputs, fields }) => {
      const str = String(inputs.in?.value ?? '');
      const find = String(fields.find ?? '');
      const replacement = String(fields.replacement ?? '');
      if (!find) {
        // Empty find would produce undefined behavior (replace at every
        // position). Refuse explicitly — the validator should catch this
        // at save time, but defensive against bypasses.
        throw new Error('replace: "Find" is empty');
      }
      if (fields.regex) {
        const flags = String(fields.flags ?? 'g');
        const re = new RegExp(find, flags);
        return scalar(str.replace(re, replacement));
      }
      // Literal mode: always global (replaceAll). Avoids the surprise
      // of replace() doing only the first match.
      return scalar(str.replaceAll(find, replacement));
    },
  },

  // Future ops slot in here:
  //
  //   trim:      { inputs: [{key:'in', kind:'scalar'}], output:{kind:'scalar'}, fields: [], run: ... }
  //   lowercase: same shape
  //   uppercase: same shape
  //   concat:    { inputs: [{key:'inputs', kind:'scalar', variadic:true, minCount:2}],
  //                output:{kind:'scalar'},
  //                fields: [{key:'separator', type:'string', default:''}], run: ... }
  //   split:     { inputs: [{key:'in', kind:'scalar'}],
  //                output:{kind:'list', itemKind:'scalar'},
  //                fields: [{key:'delimiter', type:'string', required:true},
  //                         {key:'limit', type:'string'}], run: ... }
});

/** True if `id` is a registered op. */
export function isKnownOp(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(OPS, id);
}

/** Lookup an op definition, or null. */
export function getOpDef(id) {
  return isKnownOp(id) ? OPS[id] : null;
}

/** List all op ids, sorted by label for stable UI ordering. */
export function listOpIds() {
  return Object.keys(OPS).sort((a, b) => (OPS[a].label ?? a).localeCompare(OPS[b].label ?? b));
}

// ── Save-time validator ────────────────────────────────────────────────

/**
 * Validate a transform-body draft for save.
 *
 * Returns `{ ok, errors }` where errors is an array of human-readable
 * strings. Each error names the offending construct (op index, declared
 * input/output name) so the form can show them inline.
 *
 * Checks:
 *   - inputs[] entries are well-formed (name + expects)
 *   - outputs[] entries are well-formed (name + expects)
 *   - no duplicate names across inputs (would collide in scope)
 *   - no duplicate names across outputs (form ambiguity)
 *   - no overlap between input names and output names (the Analysis
 *     can't both consume and produce a binding under the same name)
 *   - ops[] is an array
 *   - each op has a known `op` id
 *   - each op's input slot references a name that's either a declared
 *     input or an earlier op's `out`
 *   - the kind of each referenced binding matches the input slot's
 *     expected kind
 *   - each op has a non-empty `out` that doesn't duplicate an earlier
 *     `out` and doesn't shadow a declared input name
 *   - each declared output name is produced by an op (or is a
 *     pass-through of a declared input — also acceptable)
 *   - per-op field validation (required fields present, non-empty
 *     where the contract demands)
 *
 * @param {{ inputs?:any, ops?:any, outputs?:any }} body
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateTransformBody(body) {
  const errors = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['transform body is missing or not an object'] };
  }

  const inputs  = Array.isArray(body.inputs)  ? body.inputs  : [];
  const ops     = Array.isArray(body.ops)     ? body.ops     : [];
  const outputs = Array.isArray(body.outputs) ? body.outputs : [];

  // ── inputs ───────────────────────────────────────────────────────────
  const inputNames = new Set();
  const inputKinds = new Map();   // name → expects
  inputs.forEach((inp, i) => {
    const tag = `inputs[${i}]`;
    if (!inp || typeof inp !== 'object') {
      errors.push(`${tag} must be an object with name + expects`);
      return;
    }
    if (typeof inp.name !== 'string' || !inp.name.trim()) {
      errors.push(`${tag}.name required (non-empty)`);
      return;
    }
    if (typeof inp.expects !== 'string' || !inp.expects.trim()) {
      errors.push(`${tag}.expects required (e.g. 'scalar', 'list')`);
      return;
    }
    if (inputNames.has(inp.name)) {
      errors.push(`${tag}: duplicate input name "${inp.name}"`);
      return;
    }
    inputNames.add(inp.name);
    inputKinds.set(inp.name, inp.expects);
  });

  // ── outputs (basic checks; produced-by-ops check after walking ops) ──
  const outputNames = new Set();
  const outputKinds = new Map();
  outputs.forEach((out, i) => {
    const tag = `outputs[${i}]`;
    if (!out || typeof out !== 'object') {
      errors.push(`${tag} must be an object with name + expects`);
      return;
    }
    if (typeof out.name !== 'string' || !out.name.trim()) {
      errors.push(`${tag}.name required (non-empty)`);
      return;
    }
    if (typeof out.expects !== 'string' || !out.expects.trim()) {
      errors.push(`${tag}.expects required (e.g. 'scalar', 'list')`);
      return;
    }
    if (outputNames.has(out.name)) {
      errors.push(`${tag}: duplicate output name "${out.name}"`);
      return;
    }
    if (inputNames.has(out.name)) {
      errors.push(`${tag}: output name "${out.name}" collides with a declared input (rename one)`);
      return;
    }
    outputNames.add(out.name);
    outputKinds.set(out.name, out.expects);
  });

  // ── ops chain ────────────────────────────────────────────────────────
  // Track which names are "available" (declared input + produced by an
  // earlier op). Each op's input must reference an available name; each
  // op's `out` adds itself to the available set.
  const available = new Map(inputKinds);  // name → kind
  const producedByOps = new Set();         // names written by ops; used for declared-output check

  ops.forEach((op, i) => {
    const tag = `ops[${i}]`;
    if (!op || typeof op !== 'object') {
      errors.push(`${tag} must be an object`);
      return;
    }
    if (typeof op.op !== 'string' || !op.op.trim()) {
      errors.push(`${tag}.op required (e.g. 'replace')`);
      return;
    }
    const def = getOpDef(op.op);
    if (!def) {
      errors.push(`${tag}: unknown op "${op.op}"`);
      return;
    }

    // Input slot validation.
    for (const slot of def.inputs) {
      if (slot.variadic) {
        const arr = op[slot.key];
        if (!Array.isArray(arr) || arr.length < (slot.minCount ?? 1)) {
          errors.push(`${tag}.${slot.key} must be an array of at least ${slot.minCount ?? 1} binding name(s)`);
          continue;
        }
        arr.forEach((bindingName, vi) => {
          if (typeof bindingName !== 'string' || !bindingName.trim()) {
            errors.push(`${tag}.${slot.key}[${vi}]: binding name required`);
            return;
          }
          if (!available.has(bindingName)) {
            errors.push(`${tag}.${slot.key}[${vi}]: "${bindingName}" is not a declared input or earlier op output`);
            return;
          }
          if (available.get(bindingName) !== slot.kind) {
            errors.push(`${tag}.${slot.key}[${vi}]: "${bindingName}" has kind "${available.get(bindingName)}", expected "${slot.kind}"`);
          }
        });
      } else {
        const bindingName = op[slot.key];
        if (typeof bindingName !== 'string' || !bindingName.trim()) {
          errors.push(`${tag}.${slot.key}: binding name required (non-empty string)`);
          continue;
        }
        if (!available.has(bindingName)) {
          errors.push(`${tag}.${slot.key}: "${bindingName}" is not a declared input or earlier op output`);
          continue;
        }
        if (available.get(bindingName) !== slot.kind) {
          errors.push(`${tag}.${slot.key}: "${bindingName}" has kind "${available.get(bindingName)}", expected "${slot.kind}"`);
        }
      }
    }

    // Op-field validation. Required fields must be present (and non-empty
    // for strings; booleans pass if present at all). Param-supported
    // fields with {{PARAM}} placeholders are accepted as "present" —
    // runtime substitution resolves them.
    for (const fieldSchema of def.fields) {
      if (!fieldSchema.required) continue;
      const v = op[fieldSchema.key];
      if (fieldSchema.type === 'string') {
        if (typeof v !== 'string' || v.trim().length === 0) {
          errors.push(`${tag}.${fieldSchema.key} required (${fieldSchema.label})`);
        }
      } else if (fieldSchema.type === 'boolean') {
        if (typeof v !== 'boolean') {
          errors.push(`${tag}.${fieldSchema.key} must be boolean`);
        }
      }
    }

    // out validation: present, non-empty, not duplicated, not shadowing
    // a declared input.
    if (typeof op.out !== 'string' || !op.out.trim()) {
      errors.push(`${tag}.out required (non-empty string)`);
    } else if (available.has(op.out) && !producedByOps.has(op.out)) {
      // op.out collides with a declared input — disallow (an op can't
      // overwrite a declared input).
      errors.push(`${tag}.out: "${op.out}" collides with a declared input name (use a different name)`);
    } else if (producedByOps.has(op.out)) {
      errors.push(`${tag}.out: "${op.out}" duplicates an earlier op's output`);
    } else {
      available.set(op.out, def.output.kind);
      producedByOps.add(op.out);
    }
  });

  // ── outputs must be produced (or pass-through of declared inputs) ────
  for (const [name, expects] of outputKinds) {
    if (!available.has(name)) {
      errors.push(`outputs: "${name}" is not produced by any op (declare it as a pass-through input or add an op writing to it)`);
      continue;
    }
    const actualKind = available.get(name);
    if (actualKind !== expects) {
      errors.push(`outputs: "${name}" expects kind "${expects}", but the producing op writes kind "${actualKind}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Runtime kernel ─────────────────────────────────────────────────────

/**
 * Execute a transform-body chain. Returns { ok, outputs, error? } where
 * outputs is a `{ [name]: TaggedValue }` map of declared outputs.
 *
 * The caller (ExecutionEngine.#executeSieveTransform) is responsible for:
 *   - Resolving declared inputs from the live scope before calling here
 *     (and passing them in via `inputBindings`).
 *   - Substituting {{PARAM}} placeholders in op fields before calling
 *     here (existing AnalysisParams substitutor handles this).
 *   - Pre/post condition evaluation.
 *   - Writing the returned outputs back into the live scope under their
 *     declared names.
 *
 * The kernel just walks the ops, applies each, and projects declared
 * outputs. Throws on contract violations (unknown op, unresolved
 * binding, kind mismatch); the caller converts these into step failures.
 *
 * @param {{
 *   inputs:  Array<{name: string, expects: string}>,
 *   ops:     Array<Object>,
 *   outputs: Array<{name: string, expects: string}>,
 * }} body          - the transform body
 * @param {Object<string, Object>} inputBindings  - { name → TaggedValue }
 * @returns {{ ok: boolean, outputs?: Object<string, Object>, error?: string }}
 */
export function runTransformBody(body, inputBindings) {
  if (!body || typeof body !== 'object') {
    return { ok: false, error: 'transform body missing' };
  }
  const ops = Array.isArray(body.ops) ? body.ops : [];
  const declaredOutputs = Array.isArray(body.outputs) ? body.outputs : [];

  // Local scope mirrors the validator's `available` map.
  const local = new Map();
  for (const inp of (body.inputs ?? [])) {
    if (inp?.name && Object.prototype.hasOwnProperty.call(inputBindings, inp.name)) {
      local.set(inp.name, inputBindings[inp.name]);
    }
  }

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const def = getOpDef(op?.op);
    if (!def) return { ok: false, error: `op ${i + 1}: unknown op "${op?.op ?? '?'}"` };

    // Resolve inputs.
    const resolvedInputs = {};
    for (const slot of def.inputs) {
      if (slot.variadic) {
        const names = op[slot.key];
        if (!Array.isArray(names)) {
          return { ok: false, error: `op ${i + 1} (${op.op}): ${slot.key} must be an array` };
        }
        resolvedInputs[slot.key] = names.map((n) => {
          if (!local.has(n)) {
            throw new Error(`op ${i + 1} (${op.op}): binding "${n}" is unbound`);
          }
          const v = local.get(n);
          if (!isKind(v, slot.kind)) {
            throw new Error(`op ${i + 1} (${op.op}): binding "${n}" expected kind "${slot.kind}", got "${v?.kind ?? typeof v}"`);
          }
          return v;
        });
      } else {
        const name = op[slot.key];
        if (typeof name !== 'string' || !local.has(name)) {
          return { ok: false, error: `op ${i + 1} (${op.op}): ${slot.key} "${name ?? ''}" is unbound` };
        }
        const v = local.get(name);
        if (!isKind(v, slot.kind)) {
          return { ok: false, error: `op ${i + 1} (${op.op}): ${slot.key} "${name}" expected kind "${slot.kind}", got "${v?.kind ?? typeof v}"` };
        }
        resolvedInputs[slot.key] = v;
      }
    }

    // Run the op. Throws are surface-level — caller logs them as the
    // step's error.
    let result;
    try {
      result = def.run({ inputs: resolvedInputs, fields: op });
    } catch (e) {
      return { ok: false, error: `op ${i + 1} (${op.op}): ${e.message}` };
    }

    // Validate output kind.
    if (!result || typeof result !== 'object' || result.kind !== def.output.kind) {
      return { ok: false, error: `op ${i + 1} (${op.op}): produced kind "${result?.kind ?? typeof result}", expected "${def.output.kind}"` };
    }

    if (typeof op.out !== 'string' || !op.out.trim()) {
      return { ok: false, error: `op ${i + 1} (${op.op}): out name missing` };
    }
    local.set(op.out, result);
  }

  // Project declared outputs.
  const out = {};
  for (const dec of declaredOutputs) {
    if (!local.has(dec.name)) {
      return { ok: false, error: `declared output "${dec.name}" was not produced by any op` };
    }
    out[dec.name] = local.get(dec.name);
  }
  return { ok: true, outputs: out };
}
