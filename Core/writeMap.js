/**
 * Core/writeMap.js — PM-6 (v2.74.1639): the WRITE half of the per-item map.
 *
 * The read half (Core/peritemMap.js) fans one leg across N rows and reports hit / no-match / unreachable. This
 * turns the NO-MATCH rows into PROPOSALS — the fleet queue's existing reviewable unit — so a bulk write reuses
 * the whole proven approval spine rather than inventing a second one:
 *
 *     map misses ─▶ buildWriteProposals ─▶ addProposals ─▶ renderProposalCards (review)
 *                                                       ─▶ canBulkApprove ─▶ _approveMany
 *                                                            └─ per item: staleness CAS ─▶ confirmed:true ─▶ ledger
 *
 * Three properties this file is responsible for, none of which are conveniences:
 *
 * 1. NOTHING IS INVENTED. A write param resolves from the row by DECLARATION first (the recipe's `writeMap`,
 *    same rung vocabulary as `joinKey`), then by matching the param's own name against the row's real keys.
 *    A required param that resolves to nothing makes the row UNPROPOSABLE — reported by name, never guessed.
 *    Writing a fabricated last name into a customer record is worse than writing nothing.
 * 2. THE PREVIEW IS THE TRUTH. Every proposal carries the exact params it will send, so the review card shows
 *    real values, not a summary of them. The user approves what will actually happen.
 * 3. THE MISS IS RE-CHECKED AT EXECUTION, not here. Each proposal carries readLeg/basedOn so _approveProposal's
 *    staleness CAS re-runs the lookup immediately before creating — an approval that sat for ten minutes cannot
 *    duplicate a record someone created in the meantime. For a CREATE that guard is the difference between
 *    "no-op" and "permanent duplicate", so it is mandatory, not optional (see requireStalenessGuard).
 */

import { ladderValues, normalizeRungs, pickFieldPath, extractValue } from './peritemMap.js';
import { legParamDefs } from './connectorLeg.js';

const _str = (v) => (typeof v === 'string' ? v.trim() : (v === 0 || v === false ? String(v) : (v == null ? '' : String(v).trim())));

/** Cap the reviewable batch. A list nobody can actually read is a rubber stamp, not an approval. */
export const WRITE_BATCH_CAP = 25;

// The enrich sidecar peritemMap attaches per row (its _CONTACTS_KEY). Role-structured, so never fallback-resolvable.
const _CONTACTS_PREFIX = '__contacts';

/**
 * Is this leg allowed to run as a reviewed BATCH at all? PURE.
 * Mirrors canBulkApprove's policy at the point of PROPOSING, so an ineligible leg never reaches a review card
 * offering an approve-all button it cannot honor. Destructive/gated stays one-at-a-time with a human watching;
 * money and inventory never batch regardless of class (the standing human-click-only rule).
 */
export function writeMapPreflight(leg) {
  const tool = (leg && leg.tool) || {};
  if (!leg || !tool.id) return { ok: false, reason: 'no write target' };
  if (!tool.write) return { ok: false, reason: 'that is a read, not a write' };
  if (leg.safety === 'gated' || leg.safety === 'destructive' || tool.destructive) {
    return { ok: false, reason: 'destructive changes run one at a time, with you watching each one' };
  }
  if (_MONEY_RE.test(`${tool.id} ${tool.name || ''}`)) {
    return { ok: false, reason: 'anything that moves money or inventory stays a human click' };
  }
  return { ok: true };
}
// Money/inventory verbs — the standing "human click only" class, matched on the leg's own identity.
const _MONEY_RE = /(refund|charge|payment|pay_|_pay\b|capture|void|invoice|payout|transfer|purchase|checkout|complete_order|fulfill|inventory|adjust_stock|price)/i;

/**
 * Resolve ONE write param's value from a source row. PURE. Returns '' when nothing resolves — the caller
 * decides whether that is fatal (required) or fine (optional).
 *
 * Order is declaration-first, deliberately: the recipe author knows that a warranty record's homeowner lives
 * under a contact role, and no amount of name-matching recovers that. Name-matching is the fallback for the
 * ordinary case where the row simply has a field called what the param is called.
 */
/**
 * VendorSuite's `CityStateZip` is one string ("Cumming, GA 30040" / "ABERDEEN, NC 28315"). Shopify's
 * MailingAddressInput wants the parts. PURE — returns {} when unparseable (caller omits those fields).
 */
export function parseCityStateZip(raw) {
  const s = _str(raw);
  if (!s) return {};
  let m = s.match(/^(.+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!m) m = s.match(/^(.+?)\s+([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)$/);
  if (!m) return {};
  return { city: m[1].trim(), province: m[2].toUpperCase(), zip: m[3] };
}

/**
 * Shopify Admin rejects a non-E.164 phone at GraphQL variable coercion ("Variable $customerInput of type
 * CustomerInput! was provided invalid value") — not as a userError. US 10-digit (and 11-digit leading 1)
 * numbers normalize to +1…; anything else is dropped (omit > send garbage). PURE.
 */
export function normalizeShopifyPhone(raw) {
  const s = _str(raw);
  if (!s) return '';
  if (/^\+[1-9]\d{7,14}$/.test(s.replace(/[\s()-]/g, ''))) return s.replace(/[\s()-]/g, '');
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

/**
 * Finish a shopify_create_customer param bag before fillBody. PURE.
 * Live 14:05:30Z: writeMap always stamped country:'US' + address1, never city/zip → addresses:[{address1,countryCode}]
 * which CustomerInput rejected as a whole. Incomplete addresses are dropped (contact-only create still works);
 * phones are normalized or omitted.
 */
export function prepareShopifyCustomerCreateParams(filled) {
  const out = { ...(filled && typeof filled === 'object' ? filled : {}) };
  if (out.phone != null) {
    const p = normalizeShopifyPhone(out.phone);
    if (p) out.phone = p; else delete out.phone;
  }
  const hasStreet = !!_str(out.address1);
  const hasLocality = !!(_str(out.city) || _str(out.zip));
  if (!hasStreet || !hasLocality) {
    for (const k of ['address1', 'address2', 'city', 'province', 'country', 'zip', 'company']) delete out[k];
  }
  return out;
}

export function resolveWriteValue(row, paramName, declared) {
  if (!row || typeof row !== 'object') return '';
  const decl = declared && Object.prototype.hasOwnProperty.call(declared, paramName) ? declared[paramName] : undefined;
  if (decl && typeof decl === 'object' && decl.literal !== undefined) return _str(decl.literal);   // a declared constant (e.g. country 'US')
  // v2.74.2020 — CityStateZip → city / province / zip for Shopify MailingAddressInput.
  if (decl && typeof decl === 'object' && decl.cityStateZip && decl.part) {
    const parts = parseCityStateZip(extractValue(row, decl.cityStateZip));
    return _str(parts[decl.part]);
  }
  if (decl && typeof decl === 'object') {                          // a contact rung — same vocabulary as joinKey
    // normalizeRungs FIRST: ladderValues matches the type against lower-cased keys and does NOT normalize its
    // input, so a declaration written the natural way ({type:'FirstName'}) resolves to nothing silently. A
    // caught-by-test near-miss — an unnormalized rung would have written a customer with no name at all.
    const got = ladderValues(row, normalizeRungs([decl]));
    if (got.length && _str(got[0].value)) return _str(got[0].value);
    return '';                                                     // DECLARED but absent on this row → honest empty, no fallback guess
  }
  if (typeof decl === 'string' && decl) return _str(extractValue(row, decl));
  const fp = pickFieldPath([row], paramName);                      // fallback: the row's own key matching this param's name
  // The fallback stops at the ROW's own fields. pickFieldPath will happily descend into the contacts sidecar and
  // return whichever contact sits FIRST in the array — incidental ordering, not a rule. On a read that costs a
  // wasted lookup; on a WRITE it silently stamps the wrong person's phone or email onto a customer record, and
  // "primary homeowner" and "homeowner" are different people. Which contact is meant is exactly the thing only a
  // declaration can say, so an undeclared contact-shaped param resolves to nothing and the row reports it.
  if (!fp || String(fp.path).startsWith(_CONTACTS_PREFIX)) return '';
  return _str(extractValue(row, fp.path));
}

/**
 * Build the reviewable write batch from the map's no-match rows. PURE.
 *
 * Returns { proposals, unproposable, capped, dropped }:
 *   proposals   — ready to hand to addProposals(); each carries exact params + the staleness guard
 *   unproposable— rows that could NOT be filled, each with the required params that resolved to nothing
 *   capped/dropped — honest truncation (never silent; the caller must say so)
 */
export function buildWriteProposals(missRows, {
  leg, declared = null, sourceName = 'record', why = '', cap = WRITE_BATCH_CAP,
  readLeg = null, readParamName = '', basedOnPath = '',
} = {}) {
  const rows = (Array.isArray(missRows) ? missRows : []).filter((r) => r && typeof r === 'object');
  const tool = (leg && leg.tool) || {};
  // v2.74.2021 — legParamDefs: projected legs have NO tool.params (recipeToLeg → leg.params + paramSchema).
  const params = legParamDefs(leg);
  const use = rows.slice(0, Math.max(0, cap));
  const proposals = [];
  const unproposable = [];

  for (const entry of use) {
    const row = entry && entry.row ? entry.row : entry;             // accept either a raw row or a map result entry
    const label = _str(entry && entry.label) || _str(row && (row.__label || row.Title || row.Name)) || sourceName;
    const filled = {};
    const missing = [];
    for (const p of params) {
      const name = _str(p && p.name); if (!name) continue;
      const v = resolveWriteValue(row, name, declared);
      if (v) filled[name] = v;
      else if (p && p.required) missing.push(name);
    }
    if (missing.length) { unproposable.push({ label, missing }); continue; }
    // v2.74.2020 — shopify_create_customer: normalize phone + drop incomplete addresses before the proposal
    // freezes the params the human will approve (the preview IS the truth).
    const send = (tool.id === 'shopify_create_customer' || tool.recipeId === 'shopify_create_customer')
      ? prepareShopifyCustomerCreateParams(filled) : filled;
    const prop = {
      name: _str(tool.name) || 'Create record',
      targets: [label],
      leg,
      params: send,
      safety: leg.safety || 'confirm',
      why: _str(why) || `no match found for ${label}`,
    };
    // The duplicate guard. Without a readLeg the CAS in _approveProposal is skipped entirely, so an approval
    // that ages could create a record that now exists — see requireStalenessGuard.
    if (readLeg && readParamName && _str(entry && entry.value)) {
      prop.readLeg = readLeg;
      prop.readParams = { [readParamName]: _str(entry.value) };
      prop.basedOn = { path: _str(basedOnPath), value: '' };        // '' = "nothing matched when proposed"; anything now → stale
    }
    proposals.push(prop);
  }
  return { proposals, unproposable, capped: rows.length > use.length, dropped: Math.max(0, rows.length - use.length) };
}

/**
 * A CREATE batch without a re-check is a duplicate factory. PURE — the caller fails closed on false.
 * Separate from buildWriteProposals so the requirement is a visible gate rather than an implicit field check.
 */
export function requireStalenessGuard(proposals) {
  const list = (Array.isArray(proposals) ? proposals : []).filter(Boolean);
  const bare = list.filter((p) => !p.readLeg || !p.basedOn);
  return { ok: bare.length === 0, bare: bare.map((p) => (p.targets || [])[0] || p.name) };
}

/** One honest line for the batch that will be reviewed. PURE. */
export function writeBatchSummary({ proposals = [], unproposable = [], capped = false, dropped = 0, system = 'the target' } = {}) {
  const bits = [`${proposals.length} to create in ${system}`];
  if (unproposable.length) bits.push(`${unproposable.length} I can't fill`);
  if (capped) bits.push(`${dropped} beyond the reviewable batch`);
  return bits.join(' · ');
}
