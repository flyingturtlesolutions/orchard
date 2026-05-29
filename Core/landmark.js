// Core/landmark.js — SG-LM-2. Turn a Locale feature into a PROTO-LANDMARK: the recoverable identity the
// trial binds to and replay re-resolves by, instead of a frozen CSS string.
//
// PURE — built ONLY from fields Explore already captured (selector, a11yRole, label/accName, kind). No
// LLM, no DOM, no INSPECT round-trip. The full generateLandmarkProfile is paid later, at Accept (SG-LM-4),
// and only for capabilities that passed the trial — so the trial stays cheap.
//
// The descriptor's shape matches what ContentScripts/contentScript.js LANDMARK_PROBE_OR_RECOVER consumes:
//   probe `selector`; on miss, recover via the fallback `{ role, accessibleName, hierarchicalContext }`
//   → _findLandmarkCandidatesByDescription re-finds the element by role + accessible name and
//   re-synthesizes a fresh selector. That recovery REQUIRES a role, and most plain <button>/<input>/<a>
//   elements carry no explicit role attribute, so we derive the implicit ARIA role HTML-AAM would assign.
//
// @module Core/landmark
// @version 2.74.599

// Implicit ARIA role from the Locale `kind` (+ optional fill `fieldType`) when no explicit role was
// captured. Conservative: only the cases where the role is unambiguous; otherwise null (recovery then
// falls back to selector-only, which is still better than a hard fail).
function _roleFromKind(kind, fieldType) {
  switch (kind) {
    case 'submit': case 'action': case 'button': case 'disclosure': return 'button';
    case 'navigation': return 'link';
    case 'select':   return 'combobox';
    case 'file':     return null;                 // file inputs have no stable recoverable role
    case 'input':
      if (fieldType === 'select') return 'combobox';
      if (fieldType === 'file')   return null;
      return 'textbox';                            // text/email/tel/… all expose textbox
    default:         return null;                  // collection / region / unknown → recover by selector only
  }
}

/**
 * Build a proto-landmark from a Locale feature. PURE.
 * @param {object} feature  a Locale feature: { selector, a11yRole, label(=accName), kind, ... }.
 * @param {string} [fieldType]  the bound role's fill kind ('select'|'file'|'text'), to refine 'input'.
 * @returns {{ selector:string|null, role:string|null, accessibleName:string|null,
 *             hierarchicalContext:null, kind:string|null, candidates:string[] } | null}
 */
export function featureToProtoLandmark(feature, fieldType = null) {
  if (!feature || typeof feature !== 'object') return null;
  const selector = feature.selector || null;
  const accessibleName = (typeof feature.label === 'string' && feature.label.trim()) ? feature.label.trim() : null;
  const explicitRole = (typeof feature.a11yRole === 'string' && feature.a11yRole.trim()) ? feature.a11yRole.trim() : null;
  const role = explicitRole || _roleFromKind(feature.kind, fieldType);
  return {
    selector,
    role: role || null,
    accessibleName,
    // Not captured by enumeratePage yet (no DOM-ancestor context) → null. Recovery matches by role+name;
    // a later capture enrichment can populate this for extra disambiguation.
    hierarchicalContext: feature.hierarchicalContext || null,
    kind: feature.kind || null,
    candidates: selector ? [selector] : [],
  };
}

/**
 * The fallback descriptor LANDMARK_PROBE_OR_RECOVER expects ({ role, accessibleName, hierarchicalContext }).
 * Returns null when there's nothing to recover with (no role) — caller then resolves selector-only.
 * @param {object|null} lm  a proto-landmark from featureToProtoLandmark.
 */
export function protoLandmarkFallback(lm) {
  if (!lm || !lm.role) return null;   // recovery needs a role; without it, don't offer a fallback
  return {
    role: lm.role,
    accessibleName: lm.accessibleName || null,
    hierarchicalContext: lm.hierarchicalContext || null,
  };
}
