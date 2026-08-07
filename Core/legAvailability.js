// DORMANT (stamped 2026-08-07, dead-code audit) — tri-leg Drive/Ride/Broker availability assessor: built,
// tested, zero live callers, named in no doc. Revive trigger: wiring leg selection (palette / interpret
// candidate assembly) to a availability pre-check; else delete after the broker (VT-7) ships without it.
// Core/legAvailability.js — v2.74.1304. Given a Ground's EVIDENCE, assess which of the three legs (Drive / Ride /
// Broker) are POSSIBLE for that site, why, and which is recommended. This is the whole point of the tri-class palette
// made EXPLICIT + per-site: pick the leg that actually works for THIS site instead of discovering it by failure.
//
// Google forced the failure modes into the open, empirically:
//   • DRIVE dies on obfuscated / positional selectors (a control with no stable a11y identity → brittle replay).
//   • RIDE can't template binary gRPC/protobuf write bodies (0-param, un-fillable recipes).
//   • so the answer for a Google-class app is the BROKER (its official API + OAuth).
// A clean-REST app is the opposite: Ride is available (fillable JSON writes), Drive works, Broker usually absent.
//
// PURE: evidence in, verdict out. The CALLER gathers the evidence (Ground readiness + landmark stability; the ride
// recipes' shapes + whether a session token is captured; the connector/MCP registry). This just classifies it.
//
// @module Core/legAvailability

export const LEG_STATUS = Object.freeze({ available: 'available', degraded: 'degraded', none: 'none' });
const S = LEG_STATUS;

// DRIVE — page-drive works iff the site is grounded AND its controls have STABLE identity (role/name), not obfuscated
// or positional selectors that don't survive a re-render (Google's `div.VKy0Ic:nth-of-type(40)`). landmarkStability =
// fraction (0..1) of landmarks with a durable a11y anchor; the caller derives it from the Landmark/Locale registry.
function _drive(evidence) {
  const g = (evidence && evidence.ground) || null;
  const readiness = g && g.readiness;
  if (!readiness || readiness === 'empty') return { status: S.none, reason: 'not grounded yet — Explore / Ground the site first' };
  const stab = (g && typeof g.landmarkStability === 'number') ? g.landmarkStability : null;
  if (stab != null && stab < 0.4) return { status: S.degraded, reason: 'grounded, but most controls lack a stable identity (obfuscated / positional selectors) — replay is brittle' };
  return { status: S.available, reason: 'grounded with stable landmarks — page-drive replays reliably' };
}

// RIDE — session-ride works iff the app has REPLAYABLE recipes: a fillable WRITE (params > 0) or a READ, riding the
// captured login. Recipes that exist but are all hollow (0-param / binary bodies) → degraded (captured, not runnable).
function _ride(evidence) {
  const rd = (evidence && evidence.ride) || {};
  const recipes = Array.isArray(rd.recipes) ? rd.recipes : [];
  const isGet = (x) => { const m = String((x && x.method) || 'GET').toUpperCase(); return m === 'GET' || m === 'HEAD'; };
  const fillableWrite = recipes.some((x) => !isGet(x) && Array.isArray(x.params) && x.params.length > 0);
  const anyRead = recipes.some(isGet);
  if (fillableWrite) return { status: S.available, reason: 'a fillable write recipe rides the login — the app’s API is replayable' };
  if (anyRead) return rd.tokenCaptured === false
    ? { status: S.degraded, reason: 'read recipes exist but no session token captured yet — arm Forage on the app tab' }
    : { status: S.available, reason: 'read recipes ride the login — the app’s API is replayable' };
  if (recipes.length) return { status: S.degraded, reason: 'recipes captured but none are fillable (binary / opaque bodies, e.g. gRPC / protobuf) — not replayable' };
  return { status: S.none, reason: 'no session-ride recipes — forage the reads, or demonstrate a write once' };
}

// BROKER — the official API leg: available iff a connected OAuth/MCP connector serves this host. The most robust leg
// where it exists (scoped creds, a stable API contract) — the right answer for Google-class apps.
function _broker(evidence) {
  const b = (evidence && evidence.broker) || {};
  const c = b.connector && String(b.connector).trim();
  if (c) return { status: S.available, reason: `official API via ${c} (OAuth / MCP) — scoped + stable, the most robust leg` };
  return { status: S.none, reason: 'no connected official API / MCP for this host' };
}

const _RANK = { available: 2, degraded: 1, none: 0 };
// preference order when statuses tie: Broker (official, scoped) > Ride (API, no DOM) > Drive (brittle to layout).
const _PREFERENCE = ['broker', 'ride', 'drive'];

/**
 * Assess the three legs for a site from its evidence. PURE.
 * @param {{ ground?:{readiness?:string, landmarkStability?:number},
 *           ride?:{recipes?:Array<{method?:string, params?:Array}>, tokenCaptured?:boolean},
 *           broker?:{connector?:string} }} [evidence]
 * @returns {{ drive:{status,reason}, ride:{status,reason}, broker:{status,reason}, recommended:('drive'|'ride'|'broker'|null) }}
 */
export function assessLegAvailability(evidence = {}) {
  const legs = { drive: _drive(evidence), ride: _ride(evidence), broker: _broker(evidence) };
  let recommended = null, best = 0;
  for (const k of _PREFERENCE) {                       // iterate in preference order — a tie goes to the earlier (more robust) leg
    const rank = _RANK[legs[k].status] || 0;
    if (rank > best) { best = rank; recommended = k; }
  }
  return { ...legs, recommended };
}
