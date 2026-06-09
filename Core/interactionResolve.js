// Core/interactionResolve.js — C3 (L1): RawInteraction → ResolvedInteraction
// (DESIGN_interaction_monitoring.md §5). PURE — no chrome/DOM.
//
// The content script's capture-phase `closest(selector)` match (C2b) IS the L1 reverse hit-test:
// it already knows which demand landmark(s) the event target hit (carried in raw `matches` with the
// perspectiveId/role the START handler stamped on each target). So C3 doesn't re-resolve — it ASSEMBLES
// the §5.2 ResolvedInteraction: dedup the matches, set resolutionStatus, and attach groundId +
// activePerspectiveIds (the classifier's context). This is what first FEEDS C0 (classifyResolved).

import { RESOLUTION_STATUSES } from './interactionClassification.js';   // share the status vocabulary

export const RESOLVE_SCHEMA = 1;

/**
 * Assemble a ResolvedInteraction from a RawInteraction + the demand-landmark matches the content
 * script already computed. PURE.
 * @param {object} raw  a RawInteraction (Core/interactionCapture.makeRawInteraction)
 * @param {{ matches?:Array<{landmarkUid:string, perspectiveId?:string, role?:string, selector?:string, selectorUsed?:string, confidence?:number}>,
 *          activePerspectiveIds?:string[], groundId?:string|null, sensitive?:boolean }} [ctx]
 * @returns {{ raw:object, groundId:string|null, resolutionStatus:string, matches:Array, activePerspectiveIds:string[], schema:number }}
 */
export function resolveInteraction(raw, { matches = [], activePerspectiveIds = [], groundId = null, sensitive = false } = {}) {
  const seen = new Set();
  const dedup = [];
  for (const m of Array.isArray(matches) ? matches : []) {
    const uid = m && typeof m.landmarkUid === 'string' ? m.landmarkUid.trim() : '';
    if (!uid || seen.has(uid)) continue;
    seen.add(uid);
    const row = {
      landmarkUid: uid,
      perspectiveId: (m.perspectiveId != null ? String(m.perspectiveId) : null),
      selectorUsed: String(m.selectorUsed || m.selector || ''),
      confidence: Number.isFinite(m.confidence) ? m.confidence : 1,   // a closest-selector hit is high-confidence STRUCTURAL (not intent)
    };
    if (m.role) row.role = String(m.role);
    dedup.push(row);
  }

  let resolutionStatus;
  if (sensitive) resolutionStatus = 'suppressed';        // sensitive field / policy block (§5.1)
  else if (dedup.length === 0) resolutionStatus = 'miss';
  else if (dedup.length > 1) resolutionStatus = 'ambiguous';
  else resolutionStatus = 'hit';
  // (RESOLUTION_STATUSES is the canonical set; resolutionStatus is always one of it.)
  void RESOLUTION_STATUSES;

  return {
    raw,
    groundId: groundId != null ? groundId : null,
    resolutionStatus,
    matches: resolutionStatus === 'suppressed' ? [] : dedup,   // suppressed surfaces no landmark detail
    activePerspectiveIds: Array.isArray(activePerspectiveIds) ? activePerspectiveIds.filter((x) => typeof x === 'string' && x) : [],
    schema: RESOLVE_SCHEMA,
  };
}
