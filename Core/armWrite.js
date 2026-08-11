// Core/armWrite.js — v2.74.2200: PER-ITEM ACT over a branch arm. PURE (no chrome / DOM / LLM / clock).
//
// THE GAP THIS FILLS, stated exactly (gl 2026-08-11, v2.74.2199). The warranty arc reaches
// `BRANCH ▸ extracted — replacement needed 3` and then stops: `draft the replacements` routed to a single-shot
// `act` needing `customer_gid` + `line_items` typed by hand, and the `write` clause it should have reached reads
// `st.lastMisses` — a LOOKUP's unmatched rows. Three rows sorted into an ARM are not unmatched rows, so the
// composition branch-arm → per-item write did not exist at all. It was unreachable AND unbuilt.
//
// WHY THIS IS NOT AN UPSERT, which is why it is not `Core/upsert.js` with a different input. `runUpsert`'s whole
// contract is find → recheck → create: a duplicate guard for "make the record that is missing". A draft order is
// not missing — there is nothing to match it against, and re-running legitimately makes a second one. Bending the
// upsert around it would put a meaningless find() in front of every create and teach the next reader that a draft
// order has an identity it does not have.
//
// WHAT IT IS: resolve one leg's params from one item, N times. The item is richer than a row — it carries the
// row's fields, its contacts sidecar, AND the branch's per-item OUTCOME (arm, count, product, cause), which is
// derived and lives nowhere else. So this module adds exactly the three rung shapes an act needs and an upsert
// does not, and DELEGATES every scalar rung to `resolveWriteValue` so the contact/field/literal vocabulary has
// one implementation.
//
// DECLARATION-ONLY, no name-match fallback. `resolveWriteValue` ends with a "the row has a key shaped like this
// param" guess, which is right for filling a customer record from a row that plainly holds those fields. It is
// wrong here: this fires a WRITE per row, and a param nobody declared is a param nobody thought about. An
// undeclared param resolves to nothing and the row is reported unfillable — the same posture the writeMap header
// already states ("anything that does not resolve is reported per-row and never invented").

import { resolveWriteValue } from './writeMap.js';

/** Where the branch's per-item verdict rides on the item. Attached like the `__contacts` sidecar: the outcome is
 *  DERIVED (an LLM extraction), it is not a field of the record, and it must not be confused for one. */
export const OUTCOME_KEY = '__outcome';

const _str = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
const _isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A structured constant, copied one level deep so a declaration can never be mutated through a built payload. */
function _cloneConst(v) {
  if (Array.isArray(v)) return v.map((x) => (_isObj(x) ? { ...x } : x));
  if (_isObj(v)) return { ...v };
  return v;
}

/** `{outcome:'count'}` → the branch's verdict for THIS item. Numbers stay numbers: `quantity` is an integer on
 *  the wire, and stringifying it here would hand the server "6" for a field it validates as a number. */
function _fromOutcome(row, key) {
  const o = row && row[OUTCOME_KEY];
  if (!_isObj(o)) return undefined;
  const v = o[_str(key)];
  if (v == null || v === '') return undefined;
  return (typeof v === 'number' || typeof v === 'boolean') ? v : _str(v);
}

/** `{template:'… {AddressLine1} …'}` — a human-facing string (a draft's note) assembled from the item. Row fields
 *  first, then `outcome.<key>`. An unresolved placeholder makes the WHOLE template unusable rather than shipping a
 *  note with `{TaskNumber}` printed in it, which is the kind of detail a person reads and loses trust over. */
function _fromTemplate(row, tpl) {
  let missing = false;
  const out = _str(tpl).replace(/\{([\w.]+)\}/g, (_m, name) => {
    const n = _str(name);
    const v = n.startsWith('outcome.') ? _fromOutcome(row, n.slice(8)) : (row ? row[n] : undefined);
    if (v == null || v === '') { missing = true; return ''; }
    return _str(v);
  });
  return missing ? '' : out.trim();
}

/**
 * Resolve ONE param from ONE item. Returns `undefined` when nothing resolved — deliberately not `''`, because an
 * empty string is a legitimate value for some params and "absent" has to be distinguishable from "empty".
 */
export function resolveArmValue(row, name, declared) {
  const decl = (declared && Object.prototype.hasOwnProperty.call(declared, name)) ? declared[name] : undefined;
  if (decl === undefined) return undefined;                       // DECLARATION-ONLY — see the header
  if (_isObj(decl) && 'const' in decl) return _cloneConst(decl.const);
  if (_isObj(decl) && 'outcome' in decl) return _fromOutcome(row, decl.outcome);
  if (_isObj(decl) && 'template' in decl) { const t = _fromTemplate(row, decl.template); return t || undefined; }
  if (_isObj(decl) && _isObj(decl.each)) {
    // ONE element per item, by construction: this is "for each ROW, one line item", not "for each row, many".
    // A multi-line draft is a different composition (group N rows into one order) and is deliberately not this.
    const el = {};
    for (const [k, rung] of Object.entries(decl.each)) {
      const v = resolveArmValue(row, k, { [k]: rung });
      if (v === undefined || v === '') return undefined;          // a half-filled line item is worse than none
      el[k] = v;
    }
    return Object.keys(el).length ? [el] : undefined;
  }
  const s = resolveWriteValue(row, name, declared);               // contact rungs, field names, literals, address parts
  return s === '' ? undefined : s;
}

/**
 * Build one item's invoke params for a declared leg. PURE.
 *
 * @param row        the item — row fields + `__contacts` sidecar + `__outcome` (the branch verdict)
 * @param declared   the writeMap entry for THIS target leg ({paramName: rung})
 * @param paramDefs  the leg's own param definitions ([{name, required}]) — what must be present to invoke
 * @returns {{params:object, missing:string[]}}  `missing` lists REQUIRED params that resolved to nothing
 */
export function armActParams(row, declared, paramDefs = []) {
  const params = {};
  const missing = [];
  const defs = Array.isArray(paramDefs) ? paramDefs : [];
  for (const pd of defs) {
    const name = _str(pd && (pd.name || pd));
    if (!name) continue;
    const v = resolveArmValue(row, name, declared);
    if (v === undefined) { if (pd && pd.required) missing.push(name); continue; }
    params[name] = v;
  }
  return { params, missing };
}

/**
 * Does this declaration read the branch's per-item OUTCOME? PURE.
 *
 * This one predicate is what keeps two write targets on one source from becoming ambiguous, and it is a fact
 * about the DATA rather than about the ask's wording. A declaration with an `outcome` rung can only be filled by
 * an item a branch classified — a lookup's unmatched row has no verdict attached — so:
 *   · the ARM act targets the declaration that READS an outcome (`pickArmTarget` below);
 *   · the MAP-MISS write excludes those targets entirely (`writePreflight`), which restores it to a single
 *     candidate and leaves its behaviour exactly as it was before a second target was declared.
 * Word-matching would have had to decide that "create the missing ones in shopify" means a customer and not a
 * draft order, from two ids that both contain "create" and "shopify". It cannot, and guessing there writes the
 * wrong kind of record — the precise failure `writePreflight`'s own v1683 note was added to prevent.
 */
export function declarationReadsOutcome(decl) {
  if (!_isObj(decl)) return false;
  for (const rung of Object.values(decl)) {
    if (!_isObj(rung)) continue;
    if ('outcome' in rung) return true;
    if (_isObj(rung.each) && Object.values(rung.each).some((r) => _isObj(r) && 'outcome' in r)) return true;
  }
  return false;
}

/**
 * The write target for a per-item ACT: the source's declaration that reads an outcome. PURE.
 * @returns {{ok:true, targetId, declared}|{ok:false, reason:'no-declaration'|'ambiguous', targets:string[]}}
 */
export function pickArmTarget(writeMap) {
  const map = _isObj(writeMap) ? writeMap : null;
  const ids = map ? Object.keys(map).filter((id) => declarationReadsOutcome(map[id])) : [];
  if (!ids.length) return { ok: false, reason: 'no-declaration', targets: map ? Object.keys(map) : [] };
  if (ids.length > 1) return { ok: false, reason: 'ambiguous', targets: ids };   // two per-item acts on one source: the ask must say which, and nothing here may guess
  return { ok: true, targetId: ids[0], declared: map[ids[0]] };
}

/**
 * Which items does this act run over? PURE.
 *
 * The arm is named when the caller knows it and INFERRED when it does not — inferred by what the declaration can
 * actually fill, never by matching arm text against the ask. That choice is deliberate: an arm label is authored
 * per run by the classifier ("needs replacement part" one run, "replacement needed" the next — the v2.74.1966
 * finding), so keying behaviour to its wording is keying to a string the model invented. What a row can FILL is a
 * property of the row and the declaration, and it is stable.
 *
 * Returns `{ use, skipped }` — `skipped` carries a reason per item so the caller can report the drop rather than
 * silently shrinking the batch (the repo's no-silent-caps rule).
 */
export function selectArmItems(items, { arm = '', declared = null, paramDefs = [] } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && _isObj(it.row));
  const want = _str(arm).trim().toLowerCase();
  const use = [];
  const skipped = [];
  for (const it of list) {
    const label = _str(it.arm);
    if (want && label.toLowerCase() !== want) { skipped.push({ item: it, why: `not in "${arm}"` }); continue; }
    if (!label) { skipped.push({ item: it, why: 'no arm matched this row' }); continue; }
    const { missing } = armActParams(it.row, declared, paramDefs);
    if (missing.length) { skipped.push({ item: it, why: `can’t fill ${missing.join(', ')}` }); continue; }
    use.push(it);
  }
  return { use, skipped };
}

/**
 * The one-line tally, so a run that acted on 3 of 5 says so. PURE.
 * v2.74.2205 (bug pass) — takes the bag and reads it, rather than destructuring in the signature: a parameter
 * default only fires on `undefined`, so `armActTally(null)` threw while every peer in this module tolerated the
 * same input. Found by fuzzing the module's exports, not by a call site — the call sites all pass a literal.
 */
export function armActTally(counts) {
  const c = _isObj(counts) ? counts : {};
  const created = Number(c.created) || 0;
  const queued = Number(c.queued) || 0;
  const failed = Number(c.failed) || 0;
  const skipped = Number(c.skipped) || 0;
  const total = Number(c.total) || 0;
  const bits = [];
  if (created) bits.push(`**${created}** created`);
  if (queued) bits.push(`**${queued}** queued for approval`);
  if (failed) bits.push(`**${failed}** failed`);
  if (skipped) bits.push(`**${skipped}** skipped`);
  if (!bits.length) bits.push('nothing to do');
  return `${bits.join(' · ')} — of ${total} item${total === 1 ? '' : 's'}.`;
}
