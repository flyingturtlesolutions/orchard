// Core/interactionDemand.js — C1: the interaction DEMAND SET (monitoring / Track phase).
//
// PURE (no chrome / DOM / Services): given a Ground's ACCEPTED Perspectives, derive which
// landmarks to watch and for which interaction kinds — the demand-driven gate that bounds
// capture to |demand set| per tab, not |all DOM nodes| (DESIGN_interaction_monitoring.md §4.3).
// The role→kinds map mirrors the classifier's ROLE_SEMANTIC_VERB_MAP so capture (C2), resolution
// (C3), and classification (C0) share ONE role vocabulary. Consumed by C2 (which landmarks get
// listeners) + C3 (the reverse hit-test is scoped to this set).

export const DEMAND_SCHEMA = 1;

/**
 * Interaction kinds to WATCH per landmark role (DATA, not LLM). A landmark whose role isn't here
 * falls back to DEFAULT_KINDS. Intentionally covers BOTH role taxonomies so the registry can feed
 * whichever is available:
 *   • Layer-2 SEMANTIC roles (from the Perspective composition; aligns with the classifier's
 *     ROLE_SEMANTIC_VERB_MAP so demand + classification share one vocabulary), and
 *   • a11y roles (the reliably-present field on the landmark registry record today).
 * The mapping is about INPUT-NESS (typeable → focus/type) vs CLICKABILITY (click/submit), which
 * both taxonomies express — not about the semantic LABEL (that's the classifier's job).
 */
export const ROLE_INTERACTION_KINDS = Object.freeze({
  // Layer-2 semantic roles
  'search-query':     Object.freeze(['focus', 'type']),
  'email-input':      Object.freeze(['focus', 'type']),
  'quantity-input':   Object.freeze(['focus', 'type']),
  'password-input':   Object.freeze(['focus', 'type']),   // C2 emits the interaction, NEVER the value
  'search-submit':    Object.freeze(['click', 'submit']),
  'primary-action':   Object.freeze(['click']),
  'secondary-action': Object.freeze(['click']),
  'add-to-cart':      Object.freeze(['click']),
  'result-link':      Object.freeze(['click']),
  'navigation-link':  Object.freeze(['click']),
  // a11y roles (landmark registry)
  'textbox':          Object.freeze(['focus', 'type']),
  'searchbox':        Object.freeze(['focus', 'type']),
  'combobox':         Object.freeze(['focus', 'type']),
  'spinbutton':       Object.freeze(['focus', 'type']),
  'button':           Object.freeze(['click']),
  'link':             Object.freeze(['click']),
  'checkbox':         Object.freeze(['click']),
  'radio':            Object.freeze(['click']),
  'menuitem':         Object.freeze(['click']),
  'menuitemcheckbox': Object.freeze(['click']),
  'tab':              Object.freeze(['click']),
  'option':           Object.freeze(['click']),
  'switch':           Object.freeze(['click']),
});

/** Unknown / roleless landmark → watch clicks (the dominant interaction). */
export const DEFAULT_KINDS = Object.freeze(['click']);

export const DEMAND_REASONS = Object.freeze(['accepted-perspective', 'explicit-opt-in', 'debug']);

/** Interaction kinds for a landmark role. Unknown / empty → a copy of DEFAULT_KINDS. */
export function interactionKindsForRole(role) {
  const r = role != null && String(role).trim() ? String(role).trim().toLowerCase() : '';
  return (r && ROLE_INTERACTION_KINDS[r] ? ROLE_INTERACTION_KINDS[r] : DEFAULT_KINDS).slice();
}

/**
 * Build the interaction demand set for a Ground from its ACCEPTED Perspectives. PURE + deterministic.
 * @param {Array<object>} perspectives  accepted Perspectives, each exposing its landmark composition
 *        as `landmarks: Array<{ landmarkUid:string, role?:string }>` (caller normalizes the store shape).
 * @param {{ groundId:string, reason?:string }} [opts]
 * @returns {Array<{ groundId:string, landmarkUid:string, interactionKinds:string[], reason:string }>}
 *          ONE row per DISTINCT landmark (kinds UNIONED across perspectives), sorted by landmarkUid.
 */
export function buildInteractionDemand(perspectives, { groundId, reason = 'accepted-perspective' } = {}) {
  if (!groundId || typeof groundId !== 'string') return [];
  const rsn = DEMAND_REASONS.includes(reason) ? reason : 'accepted-perspective';
  const byLandmark = new Map();   // landmarkUid → Set(kind)
  for (const p of Array.isArray(perspectives) ? perspectives : []) {
    const lms = p && Array.isArray(p.landmarks) ? p.landmarks : [];
    for (const lm of lms) {
      const uid = lm && typeof lm.landmarkUid === 'string' ? lm.landmarkUid.trim() : '';
      if (!uid) continue;
      let set = byLandmark.get(uid);
      if (!set) { set = new Set(); byLandmark.set(uid, set); }
      for (const k of interactionKindsForRole(lm.role)) set.add(k);
    }
  }
  return [...byLandmark.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([landmarkUid, kinds]) => ({ groundId, landmarkUid, interactionKinds: [...kinds].sort(), reason: rsn }));
}
