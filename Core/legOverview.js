// Core/legOverview.js — OV-1 (v2.74.1413, DESIGN_overview.md): the cross-Ground LEG INVENTORY for the Overview
// workbench. PURE. Aggregates every ground's tri-class tool surface (groundToolSurface: Drive / Ride / Broker) into
// ONE flat leg list + rollups + a work queue (what needs the developer). The Overview home renders this; Add / Test /
// Verify operate over it. No chrome / storage — the background gathers each ground's drive/ride/broker and passes them.
//
// A leg is VERIFIED (ready for an app to consume) when it's armed (§18) + reviewed (not pending) + enabled — the same
// predicate the app setup catalog (AS-5) will gate on. The workbench's job is to move legs from `pending` → verified.
//
// @module Core/legOverview

import { groundToolSurface } from './groundToolSurface.js';

// verified = armed (§18 arm guard) + reviewed (not pending) + enabled. The rideRecipe.armable() already folds
// enabled + reviewState==='accepted'; drive/broker entries default armable/enabled true, reviewState 'accepted'.
const _verified = (e) => !!(e.armable && e.reviewState !== 'pending' && e.enabled);

// Normalize ANY class entry into the uniform overview leg. Ride entries are already recipeRow-shaped (full lifecycle);
// drive/broker entries are surface-specific → sensible lifecycle defaults (a curated broker tool / a live drive cap is
// 'accepted'). The workbench's Add/Test/Verify target RIDE (the authored tail); drive/broker ride along for the glance.
function _legEntry(raw, cls, g) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const provDefault = cls === 'broker' ? 'broker' : cls === 'drive' ? 'observed' : 'curated';
  const e = {
    groundId: g.groundId || null,
    host: g.host || null,
    label: g.label || g.host || null,
    class: cls,
    id: String(r.id || r.key || r.name || ''),
    name: String(r.name || r.label || r.id || 'leg'),
    does: String(r.does || ''),
    method: r.method ? String(r.method).toUpperCase() : null,
    endpoint: r.endpoint ? String(r.endpoint) : null,
    params: Array.isArray(r.params) ? r.params : [],
    provenance: String(r.provenance || provDefault),
    safetyClass: String(r.safetyClass || 'auto'),
    reviewState: String(r.reviewState || 'accepted'),
    trust: (typeof r.trust === 'number') ? r.trust : null,
    enabled: r.enabled !== false,
  };
  // armable (§18) = enabled AND reviewed-accepted. A STORED recipe never carries an `armable` field (armable is a
  // function, not persisted), so DERIVE it here — reading r.armable would default a rejected/disabled leg to armable and
  // it would read as VERIFIED. A drive/broker entry defaults reviewState 'accepted' + enabled, so it's armable, as a
  // curated tool / live cap should be.
  e.armable = !!(e.enabled && e.reviewState === 'accepted');
  e.verified = _verified(e);
  return e;
}

/**
 * Build the cross-Ground leg overview. PURE.
 * @param {object} [inp]
 *   @param {Array} [inp.grounds]  per-ground bundles: { groundId, host, label, driveSections[], recipes[], brokerSections[] }
 *          — the SAME inputs groundToolSurface takes, one entry per ground/connector.
 * @returns {{ legs:Array, grounds:Array, counts:object, queue:Array }}
 *   legs      — every leg, uniform-shaped, tagged with class + ground.
 *   grounds   — per-ground summary { groundId, host, label, byClass, count, pending }.
 *   counts    — rollups { total, byClass, byState, bySafety, verified, unverified }.
 *   queue     — the work queue: legs that are pending OR unverified, pending-first then riskiest-first.
 */
export function buildLegOverview({ grounds = [] } = {}) {
  const legs = [];
  const groundSummaries = [];
  for (const g0 of (Array.isArray(grounds) ? grounds : [])) {
    const g = (g0 && typeof g0 === 'object') ? g0 : {};
    const surface = groundToolSurface({ driveSections: g.driveSections, recipes: g.recipes, brokerSections: g.brokerSections });
    const byClass = { drive: 0, ride: 0, broker: 0 };
    let pending = 0;
    for (const c of surface.classes) {
      const cls = c.key;
      for (const sec of (Array.isArray(c.sections) ? c.sections : [])) {
        for (const raw of (Array.isArray(sec.entries) ? sec.entries : [])) {
          const e = _legEntry(raw, cls, g);
          legs.push(e);
          if (byClass[cls] !== undefined) byClass[cls] += 1;
          if (e.reviewState === 'pending') pending += 1;
        }
      }
    }
    groundSummaries.push({ groundId: g.groundId || null, host: g.host || null, label: g.label || g.host || null, byClass, count: byClass.drive + byClass.ride + byClass.broker, pending });
  }

  const byClass = { drive: 0, ride: 0, broker: 0 };
  const byState = { pending: 0, accepted: 0, rejected: 0 };
  const bySafety = { auto: 0, gated: 0, destructive: 0, forbidden: 0 };
  let verified = 0;
  for (const e of legs) {
    if (byClass[e.class] !== undefined) byClass[e.class] += 1;
    if (e.reviewState === 'pending') byState.pending += 1;
    else if (e.reviewState === 'rejected') byState.rejected += 1;   // rejected is terminal — NOT lumped into accepted
    else byState.accepted += 1;
    if (bySafety[e.safetyClass] !== undefined) bySafety[e.safetyClass] += 1;
    if (e.verified) verified += 1;
  }

  // The work queue — what the developer must act on: pending review first, then unverified/disabled; riskiest first
  // within a tier (a destructive write pending review is more urgent than an unverified read).
  const _safetyRank = (s) => s === 'forbidden' ? 0 : s === 'destructive' ? 1 : s === 'gated' ? 2 : 3;
  const queue = legs
    .filter((e) => e.reviewState === 'pending' || !e.verified)
    .sort((a, b) => (a.reviewState === 'pending' ? 0 : 1) - (b.reviewState === 'pending' ? 0 : 1)
      || _safetyRank(a.safetyClass) - _safetyRank(b.safetyClass)
      || String(a.name).localeCompare(String(b.name)));

  return {
    legs,
    grounds: groundSummaries,
    counts: { total: legs.length, byClass, byState, bySafety, verified, unverified: legs.length - verified },
    queue,
  };
}
