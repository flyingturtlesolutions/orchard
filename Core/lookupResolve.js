// Core/lookupResolve.js — the LOOKUP resolver (the family's fourth MATCH member), RC-0. PURE.
//
// DESIGN_resolve.md §1-§3: `resolve` filters a params-free GET corpus in memory; `lookup` is the missing kind
// that invokes a SEARCH leg with a human phrase, ranks its rows under a DECLARED candidate-quality gate, and
// extracts the (possibly nested) gid to assemble into a write's param. This module is the PURE ranker + the
// envelope/strip primitives only — RC-0 wires NOTHING live (the invoke/seam/act-door branches are RC-1+, in the
// contended chat.js). It reuses rideParamResolve.getPath verbatim and mirrors resolveRideParam's verdict posture:
// exact-match required, never silently pick.
//
// The `lookup` grammar (per DESTINATION param, on the leg — leg.tool.lookup; hop-sealed like `resolve`/`drill`):
//   SCALAR (customer_gid):
//     { from:'email', viaLeg:'shopify_customer_by_email', valueParam:'email',
//       rows:'customers.edges[].node', match:['email'], id:'id', label:['firstName','lastName','email'], exact:true }
//   ELEMENT/array (line_items):
//     { each:'line_items_request', from:'product', quantityFrom:'quantity',
//       viaLeg:['shopify_product_by_sku','shopify_search_products'], valueParam:['sku','query'],
//       rows:'products.edges[].node', pick:'variants.edges[].node', id:'id', label:['title','sku','price'],
//       require:[{field:'status',equals:'ACTIVE',fail:'inactive'},{field:'inventoryQuantity',op:'>',value:0,fail:'outOfStock'}],
//       into:{ variantId:'$pick.id', quantity:'$each.quantity' } }
//
// `require` is a flat AND-list of DECLARED clauses over the returned row (§2): the field names live ONLY in the
// catalog entry — this resolver reads "the declared clauses passed", never a Shopify field name. Ops: equals · !=
// · > < >= <= · in · exists. A clause may carry a `fail` label (what the require-failed verdict names) and a
// `relaxable` flag (a value-policy exception the CALLER may honor — the ranker still reports the failure).
//
// v2.74.2064 — RC-0 (pure, no behavior). The live invoke/rank loop, the confirm/picker card, the goalMemory
// recall key and the headless recall-or-park pipeline are RC-1..RC-7.

import { getPath } from './rideParamResolve.js';

const _norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const _asArray = (v) => (v === undefined || v === null) ? [] : (Array.isArray(v) ? v : [v]);
const _str = (x) => (typeof x === 'string' && x.trim() !== '') ? x : '';

// A candidate is {node, parent}: `node` is the row the id is read from (a variant when `pick` descends), `parent`
// the row it was picked from (the product) — so a require clause / label field may reference EITHER (getPath on
// node, then parent). This is what makes `require` on a parent-product field and `id` on a nested variant coexist.
function _fieldVal(c, path) {
  let v = getPath(c.node, path);
  if (v === undefined && c.parent) v = getPath(c.parent, path);
  return v;
}

function _label(c, spec) {
  const fields = Array.isArray(spec.label) ? spec.label : (spec.label ? [spec.label] : []);
  const parts = fields.map((f) => _fieldVal(c, f)).filter((v) => v != null && v !== '');
  if (parts.length) return parts.map(String).join(' · ');
  const id = getPath(c.node, spec.id);
  return String(id != null ? id : '');
}

function _cand(c, spec) {
  const id = getPath(c.node, spec.id);
  return { id, label: _label(c, spec), node: c.node, ...(c.parent ? { parent: c.parent } : {}) };
}

// Strict-ish equality: numeric when either side is numeric, else case-insensitive string (Shopify enums are
// uppercase but a declaration shouldn't have to match case). PURE.
function _eq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Evaluate ONE require clause against a candidate. PURE. Unknown op → treated as an `equals` on `value`. */
function _clausePass(c, clause) {
  if (!clause || typeof clause !== 'object' || !_str(clause.field)) return true;   // a malformed clause never blocks
  const v = _fieldVal(c, clause.field);
  if (clause.exists === true) return v !== undefined && v !== null && v !== '';
  if ('equals' in clause) return _eq(v, clause.equals);
  const op = clause.op;
  if (op === '!=') return !_eq(v, clause.value);
  if (op === 'in') return Array.isArray(clause.values) && clause.values.some((x) => _eq(v, x));
  if (op === '>' || op === '<' || op === '>=' || op === '<=') {
    const a = Number(v), b = Number(clause.value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    return op === '>' ? a > b : op === '<' ? a < b : op === '>=' ? a >= b : a <= b;
  }
  if ('value' in clause) return _eq(v, clause.value);
  return true;
}

// The first failing require clause, as a NAMED descriptor (the verdict says which — "inactive"/"outOfStock"/a
// generic label), or null when all pass. PURE.
function _firstRequireFail(c, require) {
  const clauses = Array.isArray(require) ? require : [];
  for (const clause of clauses) {
    if (!_clausePass(c, clause)) {
      return {
        field: _str(clause.field) || null,
        fail: _str(clause.fail) || _str(clause.field) || 'unusable',
        ...(clause.relaxable === true ? { relaxable: true } : {}),
      };
    }
  }
  return null;
}

/**
 * Rank a search leg's rows against a `lookup` spec + a human phrase. PURE — no invoke, no clock, no DOM.
 * The caller has already extracted `rows` (via getPath(response, spec.rows)); this decides the verdict.
 *
 * Six row-based outcomes (a seventh, `unreachable`, is the CALLER's when the search leg errors —
 * headlessMap.js's lookup-failed-≠-miss rule — never produced here):
 *   { verdict:'blank' }                                  the phrase is empty — nothing to resolve
 *   { verdict:'none', candidates:[] }                    the search returned zero rows
 *   { verdict:'resolved', id, label, node, parent? }     exactly one EXACT-match candidate, every require clause passes → AUTO
 *   { verdict:'ambiguous', candidates:[…] }              more than one exact-match candidate → ask / picker
 *   { verdict:'require-failed', clause:{field,fail,relaxable?}, candidates:[…] }
 *                                                        the one exact candidate matched but failed a clause → names it, never auto
 *   { verdict:'no-exact', candidates:[…] }               rows exist but NONE exactly matches (near-matches only) → ask;
 *                                                        the confidently-wrong "smart switch → Smart Switch Wall Plate" guard (§3)
 * `never silently pick`: only `resolved` is auto-fillable. Exact match is required for products too, not just customers.
 */
export function rankLookupCandidates(rows, spec, humanKey) {
  if (!spec || typeof spec !== 'object' || !_str(spec.id)) return { verdict: 'none', candidates: [] };
  const key = _norm(humanKey);
  if (!key) return { verdict: 'blank' };

  const src = (Array.isArray(rows) ? rows : _asArray(rows)).filter((r) => r && typeof r === 'object');
  // `pick` descends into nested candidate sub-rows (product → its variants), carrying the parent for require/label.
  let candidates;
  if (_str(spec.pick)) {
    candidates = [];
    for (const parent of src) for (const node of _asArray(getPath(parent, spec.pick))) {
      if (node && typeof node === 'object') candidates.push({ node, parent });
    }
  } else {
    candidates = src.map((r) => ({ node: r, parent: null }));
  }
  if (!candidates.length) return { verdict: 'none', candidates: [] };

  const matchFields = (Array.isArray(spec.match) && spec.match.length) ? spec.match : [spec.id];
  // A match field may live on the NODE (variant sku) OR the PARENT (product title) — and a variant carries its
  // OWN `title` (the option name), so first-defined-wins would shadow the product title. Check BOTH sides.
  const _matchVals = (c, f) => {
    const out = [];
    const nv = getPath(c.node, f); if (nv !== undefined && nv !== null) out.push(_norm(nv));
    if (c.parent) { const pv = getPath(c.parent, f); if (pv !== undefined && pv !== null) out.push(_norm(pv)); }
    return out;
  };
  const exact = [];
  for (const c of candidates) {
    if (matchFields.some((f) => _matchVals(c, f).some((v) => v === key))) exact.push(c);
  }

  if (!exact.length) {
    // no exact hit — surface near candidates (a match field contains-or-contained the phrase), so the ask-back is
    // useful, never auto. The "smart switch → Smart Switch Gen 2" near-match lands HERE, not `resolved` (§3 safety).
    const near = candidates
      .filter((c) => matchFields.some((f) => _matchVals(c, f).some((v) => v && (v.includes(key) || key.includes(v)))))
      .slice(0, 8).map((c) => _cand(c, spec));
    return { verdict: 'no-exact', candidates: near };
  }
  if (exact.length > 1) return { verdict: 'ambiguous', candidates: exact.map((c) => _cand(c, spec)) };

  const only = exact[0];
  const failed = _firstRequireFail(only, spec.require);
  if (failed) return { verdict: 'require-failed', clause: failed, candidates: [_cand(only, spec)] };
  return { verdict: 'resolved', ..._cand(only, spec) };
}

/**
 * The RESOLVED-ENVELOPE (DESIGN_resolve.md §6): a recalled/confirmed pick rides the headless pin bindings as a
 * code-minted envelope, NOT a bare gid, so the `literalSafeParams` strip can pass it by PROVENANCE (the shape),
 * never by a gid-looking VALUE. A model binding or a pin binding can never mint `__resolved` — only the recall
 * path, reading a confirmed belief, does (RC-4/RC-6). `fillBody`/`coerceParams` unwrap it to `value` at assembly
 * (RC-1+). PURE. RC-0 lands the shape + the strip rule; nothing mints an envelope yet.
 */
export function mintResolvedEnvelope(param, value, from) {
  return { __resolved: true, param: String(param), value, ...(from != null ? { from: String(from) } : {}) };
}

export function isResolvedEnvelope(x) {
  return !!(x && typeof x === 'object' && x.__resolved === true && typeof x.param === 'string' && ('value' in x));
}

/**
 * The destination param names a leg's `lookup` marker fills (keys of leg.tool.lookup / record.lookup). PURE.
 * RC-1 uses this at the RESOLVE SEAM to exempt a lookup destination from `missingRequiredParams` (the model
 * binds the human phrase, the resolver fills the id) — deliberately NOT in the shared reader, so the honest
 * "no call spent" clarify survives for every non-lookup param.
 */
export function lookupDestParams(legOrRecordOrTool) {
  const src = legOrRecordOrTool || null;
  const lk = src && (src.lookup || (src.tool && src.tool.lookup));
  return (lk && typeof lk === 'object' && !Array.isArray(lk)) ? Object.keys(lk) : [];
}
