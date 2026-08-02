// Core/identifierShapes.js — SG-1 (v2.74.1947): THE ANY-SLOT SHAPE GUARD.
//
// Live 2026-08-02 15:46, twice, with the palette at 118 (the UPS legs absent from the conversation):
//     INTERPRET_ASK "track 1Z27691W0233595715" → act leg=me.shopify.shopify_order@admin.shopify.com
//     INVOKE ▸ admin.shopify.com POST [shopify_order] → ok object{2} keys:[data,extensions]
// A UPS tracking number went into a Shopify order-id slot and the call returned 200. Three known problems met:
//   · reachability is a SAFETY property — an unnameable capability doesn't fail closed, it makes the router reach
//     for the nearest namable one (the "unreachable clause → the router substitutes a wrong act" ruling);
//   · nothing checked that the VALUE's shape belongs to the leg's SITE;
//   · a 200 with an empty envelope banks as act-ok, so the wrong route self-reinforces (open incident
//     `learned-banks-a-wrong-but-successful-route`) while the right-but-blocked one is abandoned after 3 fails.
// This module closes the middle one. It is the cheapest of the three and it fails CLOSED.
//
// SCOPE — deliberately narrow, because the false positive here is worse than the miss:
//   1. Only IDENTIFIER-CLASS params (the slot that names the record) are checked, via the same classifier the
//      provenance gate uses. A `1Z…` in an `order` slot is a mis-bind; a `1Z…` in a `trackingNumber` slot is
//      CORRECT — Shopify fulfillments carry carrier tracking numbers, and blanket-matching would break that.
//   2. Only shapes actually OBSERVED in this codebase's traces are registered. A speculative pattern that
//      mis-fires refuses a legitimate act, which is a worse failure than the one being fixed. Add on evidence.
//   3. Ownership is matched on HOST, not on an `app` field — the projected leg carries appHost/origin, not app.

import { identifierClassParam } from './connectorLeg.js';

// Each shape: a value pattern precise enough that a match is near-certainly THAT identifier, plus the host family
// that legitimately owns it. Anchored on both ends — a substring match would catch ids embedded in other ids.
const SHAPES = Object.freeze([
  Object.freeze({
    id: 'ups-tracking',
    label: 'a UPS tracking number',
    owner: 'UPS',
    ownerHost: /(^|\.)ups\.com$/i,
    re: /^1Z[0-9A-Z]{16}$/i,           // observed: 1Z27691W0233595715 (2 + 16)
    slotRe: /track/,                   // a `trackingNumber` slot holds one on ANY site — see slotExpects below
  }),
  Object.freeze({
    id: 'shopify-gid',
    label: 'a Shopify resource id',
    owner: 'Shopify',
    ownerHost: /(^|\.)shopify\.com$/i,
    re: /^gid:\/\/shopify\/[A-Za-z]+\/\d+$/,
    slotRe: /gid/,
  }),
]);

/**
 * Does the SLOT NAME itself declare it holds this shape? Then the value is right wherever the leg rides.
 *
 * This is the correction the test suite forced (v1947, caught before shipping): `trackingNumber` IS
 * identifier-class, so judging by value+host alone refused a Shopify fulfillment write that legitimately carries
 * a carrier's tracking number. The rule is not "a UPS id may only appear on UPS" — it is "a UPS id may not
 * IMPERSONATE the record key of another site". A named tracking slot isn't impersonating anything.
 */
function _slotExpects(shape, normName) {
  return !!(shape.slotRe && shape.slotRe.test(normName));
}

/** Same normalization the identifier classifier uses, so the two agree on what a name is. */
function _norm(name) {
  return String(name || '').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** The registered shape a value matches, or null. PURE. */
export function identifierShape(value) {
  if (value == null || typeof value === 'object' || typeof value === 'boolean') return null;
  const v = String(value).trim();
  if (!v) return null;
  for (const s of SHAPES) if (s.re.test(v)) return s;
  return null;
}

function _legHost(legOrRecipe) {
  const o = (legOrRecipe && typeof legOrRecipe === 'object') ? legOrRecipe : null;
  if (!o) return '';
  const tool = (o.tool && typeof o.tool === 'object') ? o.tool : o;
  const raw = tool.appHost || tool.origin || o.appHost || o.origin || '';
  return String(raw).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
}

/**
 * Identifier-class params whose VALUE carries a recognized shape owned by a DIFFERENT site than this leg's.
 * Returns [{ name, value, shape, label, owner, host }]; empty when every value fits its slot. PURE.
 *
 * Note it is silent on unrecognized values by design — this is a guard against known mis-binds, not a whitelist.
 * A whitelist would refuse every id shape we haven't catalogued yet, which is most of them.
 */
export function misboundIdentifierParams(legOrRecipe, params = {}) {
  const o = (legOrRecipe && typeof legOrRecipe === 'object') ? legOrRecipe : null;
  if (!o || !params || typeof params !== 'object') return [];
  const host = _legHost(o);
  if (!host) return [];                       // no host to judge against — say nothing rather than guess
  const out = [];
  for (const [name, raw] of Object.entries(params)) {
    if (!identifierClassParam(name)) continue;
    const nn = _norm(name);
    const vals = (Array.isArray(raw) ? raw : [raw]);
    for (const v of vals) {
      const shape = identifierShape(v);
      if (!shape) continue;
      if (shape.ownerHost.test(host)) continue;          // right shape, right site
      if (_slotExpects(shape, nn)) continue;             // the slot NAMES this shape — legitimate on any site
      out.push({ name, value: String(v).trim(), shape: shape.id, label: shape.label, owner: shape.owner, host });
      break;                                              // one finding per param is enough to refuse
    }
  }
  return out;
}
