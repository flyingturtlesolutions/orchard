// Core/writeDispatch.js — CX-8 (v2.74.1397, DESIGN_connectors.md §20). The prefer-ride-fallback-drive cascade for a
// connector WRITE: pick the cheapest WORKING lane per call, and degrade gracefully when the fast lane goes stale.
//
// Two lanes acquired from ONE demonstration (§20.2):
//   • RIDE  — replay the app's own persisted-op POST. Fast + headless, but its hash rotates on the app's deploys
//             (HASH_STALE) — a fingerprint of the app's client code, uncapturable-as-data (§20.1).
//   • DRIVE — replay the recorded DOM steps (navigate → type → click Save). Durable — the app's OWN client supplies
//             whatever hash it currently holds, so the drive is IMMUNE to rotation — but it needs a driveable tab.
//
// The policy (§20.3, §20.8): PREFER the ride; on a hash-STALE or UNPRIMED ride, FALL BACK to the drive — which also
// RE-PRIMES the ride (the tee sees the fresh hash the Save click fires). The one gap: a HEADLESS caller (the
// unattended sweep) must never drive a tab (H-1a no-screen-steal), so a stale ride there PARKS for the human, whose
// approval click runs the drive interactively and re-primes autonomy.
//
// The load-bearing SAFETY property (§20.8): a HASH_STALE / op-not-captured rejection is PRE-EXECUTION — the server
// ran nothing, so re-driving creates the record for the FIRST time (never a duplicate). Only these pre-execution
// ride failures are drive-recoverable; a failure the drive would ALSO hit (auth, validation, a non-hash error) is
// NOT — falling back there would just re-fail (or, worse for a post-execution failure, double-write).
//
// PURE: no chrome / DOM / LLM / storage. The live connector dispatch consults these decisions.

/** A ride reply signalling the banked persisted-op hash is stale (the app deployed a new document). PURE.
 * connector.js maps the endpoint's 404/406 to `op-hash-stale`; this reads that verdict. */
export function isHashStale(reply) {
  return !!(reply && reply.error === 'op-hash-stale');
}

/** A ride reply signalling no persisted-op was ever captured for this store (nothing banked yet). PURE. */
export function isRideUnprimed(reply) {
  return !!(reply && reply.error === 'op-not-captured');
}

/**
 * Is a ride FAILURE one a DRIVE fallback can fix? True ONLY for the pre-execution hash failures (stale / unprimed) —
 * the operation never ran, so re-driving is safe (no duplicate) AND a drive re-captures the fresh hash. False for
 * everything else (auth, validation, graphql userErrors, non-json): a hash-agnostic failure the drive would re-hit.
 * PURE.
 */
export function isRideRecoverable(reply) {
  return isHashStale(reply) || isRideUnprimed(reply);
}

const _lane = (l) => (l && l.available === true && l.armable === true);
const _ridePrimed = (ride) => _lane(ride) && ride.primed === true;   // a ride is runnable only with a banked hash

/**
 * The UPFRONT execution plan for a write over a Ground's available artifacts. PURE.
 * @param {{ ride?: {available?:boolean,armable?:boolean,primed?:boolean}|null,
 *           drive?: {available?:boolean,armable?:boolean}|null }} artifacts
 * @param {{ headless?: boolean }} [ctx]  headless (the sweep) can't drive a tab (H-1a) → drive lane unavailable now
 * @returns {{ lanes: Array<'ride'|'drive'>, driveFallbackAvailable: boolean, note: string }}
 *   `lanes` = the ordered lanes to try (ride first when runnable, else drive as primary). `driveFallbackAvailable`
 *   = a drive can run NOW (armable ∧ not headless). `note` names an empty/degraded plan for the trace.
 */
export function planWrite({ ride = null, drive = null } = {}, { headless = false } = {}) {
  const driveNow = _lane(drive) && !headless;                 // a drive can actually run in this context
  const lanes = [];
  if (_ridePrimed(ride)) lanes.push('ride');
  if (driveNow) lanes.push('drive');
  let note = '';
  if (!lanes.length) {
    note = (_lane(drive) && headless) ? 'drive-blocked-headless'   // a drive exists but the sweep can't run it → park path
      : (_ridePrimed(ride) ? 'ride-only' : 'no-runnable-lane');    // (ride-only reached only when driveNow false but ride primed — already in lanes; kept for exhaustiveness)
  }
  return { lanes, driveFallbackAvailable: driveNow, note };
}

/**
 * The REACTIVE decision after a ride attempt FAILED: fall back to the drive, park for the human, or stop. PURE.
 * @param {object} reply                the ride executor's failure reply
 * @param {{ drive?: {available?:boolean,armable?:boolean}|null, headless?: boolean }} [ctx]
 * @returns {{ action: 'drive'|'park'|'stop', reason: string }}
 *   'drive' → run the DOM drive now (interactive, re-primes the hash). 'park' → headless + a drive exists but can't
 *   run here: park the write for the human (their approval click drives + re-primes, §20.8). 'stop' → surface: either
 *   the failure isn't a hash problem (a drive would re-hit it) or there is no drive artifact to fall back to.
 */
export function recoverAfterRide(reply, { drive = null, headless = false } = {}) {
  if (!isRideRecoverable(reply)) return { action: 'stop', reason: 'ride-failure-not-hash' };
  if (!_lane(drive)) return { action: 'stop', reason: 'no-drive-to-fall-back' };   // dead-end: teach the write (CX-8 dual-capture bakes the drive)
  if (headless) return { action: 'park', reason: 'headless-cannot-drive' };        // the sweep parks; the human's approve-click re-primes
  return { action: 'drive', reason: isHashStale(reply) ? 'hash-stale' : 'op-unprimed' };
}
