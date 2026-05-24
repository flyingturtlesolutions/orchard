/**
 * @file Services/LandmarkResolver.js
 * @description Wave 3 of the landmark SSOT project — resolve landmark
 * references (`{perspectiveId, role}`) to concrete selectors at runtime, and
 * list landmarks for a ground filtered by allowed operations so
 * authoring dropdowns can show only the landmarks a given action /
 * shape can actually use.
 *
 * Two surfaces:
 *   - resolveLandmarkRef(ref)        runtime — pre-dispatch resolution
 *   - listLandmarksForGround(...)    authoring — dropdown population
 *
 * Pure I/O helpers wrapping StorageManager. No DOM, no UI.
 *
 * @module Services/LandmarkResolver
 * @version 2.74.236
 */

import { StorageManager }                from './StorageManager.js';
import { Logger }                        from '../Core/Logger.js';
// v2.74.247 — Phase 7c: active-perspective filtering when looking up
// iframe contexts. Per spec § 5 "use the first-active Perspective's
// declaration". When a runtime context (tabUrl) is supplied, we
// narrow the candidate perspectives to those whose predicates evaluate
// active for that context.
import { listActivePerspectives, isPerspectiveActive } from './PerspectivePredicates.js';

/**
 * Resolve a landmark reference to its current selector + frame.
 *
 * @param {{perspectiveId:string, role:string}} ref
 * @returns {Promise<{selector:string, frameUrl:string|null, landmark:object, perspective:object}>}
 * @throws when ref is malformed or the landmark can't be found.
 */
export async function resolveLandmarkRef(ref) {
  if (!ref || typeof ref !== 'object') {
    throw new Error('landmarkRef invalid (not an object)');
  }
  // v2.74.275 — Legacy { perspectiveId, role } ref shape REMOVED. All refs
  // must carry { uid } pointing into the per-Ground registry. Spec-
  // aligned (Phase 2). See SPEC_DEV entry [2026-05-21] — Legacy
  // shape removal — for rationale.
  if (typeof ref.uid !== 'string' || !ref.uid) {
    throw new Error('landmarkRef requires { uid }; legacy { perspectiveId, role } shape removed in v2.74.275');
  }
  const lm = await StorageManager.getLandmark(ref.uid);
  if (!lm) throw new Error(`Landmark ref unresolvable: uid "${ref.uid}" not found in registry`);
  if (!lm.selector || !lm.selector.trim()) {
    throw new Error(`Landmark "${lm.accessibleName ?? lm.alias ?? ref.uid}" has no selector`);
  }
  return {
    selector: lm.selector,
    frameUrl: lm.frameUrl ?? null,
    landmark: lm,
    perspective  : null,
  };
}

/**
 * Mutate a fragment action / observation extract in place: if it has
 * a landmarkRef, resolve it to selector + frameUrl. Idempotent — calling
 * this on an already-resolved step is a no-op (the inline selector is
 * left alone if no ref is present).
 *
 * Used by ExecutionEngine right before dispatching. Errors propagate
 * so the engine can surface them as step failures rather than silently
 * running with a stale or missing selector.
 *
 * @param {object} step  fragment action OR observation extract
 * @returns {Promise<object>} the step (mutated), for chaining
 */
export async function applyLandmarkRefToStep(step) {
  if (!step || typeof step !== 'object') return step;
  const ref = step.landmarkRef;
  if (!ref) return step;   // nothing to resolve
  const { selector, frameUrl, landmark } = await resolveLandmarkRef(ref);
  step.selector = selector;
  if (frameUrl) step.frameUrl = frameUrl;
  else if ('frameUrl' in step) delete step.frameUrl;
  // Annotate for debug logs — the source of truth for this step's
  // selector right now. Engine logs include this so an author can
  // trace "where did this selector come from?"
  // v2.74.241 — Phase 3: also stash the description layer so the
  // engine can invoke heuristic recovery (LANDMARK_PROBE_OR_RECOVER)
  // without a second registry round-trip. The landmark record is
  // already loaded; pass through the fields needed for recovery.
  // v2.74.245 — Phase 7a: also stash iframeContext name so the
  // engine can route to the iframe (instead of relying on
  // frameUrl-equality). The perspective providing the iframeContexts
  // declaration is not known to the resolver yet — that's the
  // Phase 7b runtime work. For now, downstream consumers can use
  // the contextName to look up the perspective's iframeContexts and
  // evaluate the predicate themselves.
  step._resolvedFromLandmark = {
    uid              : landmark.uid ?? ref.uid ?? null,
    // v2.74.275 — perspectiveId removed (legacy ref shape gone). Alias is
    // the renamed nickname formerly called "role" in this stash.
    alias            : landmark.alias ?? null,
    landmarkSelector : landmark.selector,
    // Description layer for heuristic recovery.
    a11yRole         : landmark.a11yRole ?? null,
    accessibleName   : landmark.accessibleName ?? null,
    hierarchicalContext: landmark.hierarchicalContext ?? null,
    // iframe context (Phase 7a). Resolver in Phase 7b will use this
    // alongside the perspective's iframeContexts[] to route through the
    // right iframe document at dispatch time.
    iframeContext    : landmark.iframeContext ?? null,
    // v2.74.249 — Phase 8: ground id passed through so the recovery
    // emission sites can route landmark-resolution-degraded events
    // to the right ground's event bus without a second registry read.
    groundId         : landmark.groundId ?? null,
    // v2.74.305 — Spec-aligned per ACTION_SPEC § 5. Carries `effect`
    // (substrate-level browser effect, object shape) AND
    // `interactionPattern` (DOM-level interaction shape, string). Pre-
    // v2.74.305 a single `proposedEffect` string carried both concepts
    // conflated; legacy field still emitted for transitional consumers
    // that haven't migrated.
    effect             : landmark.effect ?? null,
    interactionPattern : landmark.interactionPattern ?? null,
    // Back-compat: derive proposedEffect from effect.kind for any
    // downstream code still reading the legacy field. Removed in a
    // follow-up version once consumers migrate.
    proposedEffect     : landmark.effect?.kind ?? landmark.proposedEffect ?? null,
    // v2.74.305 — actionEffect kept for transitional back-compat. Same
    // back-compat note as proposedEffect — will be removed.
    actionEffect       : landmark.actionEffect ?? null,
  };
  return step;
}

/**
 * v2.74.246 — Phase 7b of substrate spec: find the iframe context
 * declaration for a landmark + contextName, by searching perspectives in
 * the landmark's ground.
 *
 * Per spec § 5: "use the first-active Perspective's declaration
 * (deterministic order; document ordering)." We don't have Perspective
 * activation evaluation yet (that's a future phase), so we pick the
 * first perspective that BOTH references this landmark AND declares the
 * named context. Falls back to any perspective declaring the context if
 * no referrer is found (handles cross-perspective shared contexts that
 * could happen during transition).
 *
 * Returns: { perspective, context } or null when unresolvable.
 *
 * @param {string} landmarkUid
 * @param {string} contextName
 * @param {string} groundId
 */
export async function findPerspectiveIframeContext(landmarkUid, contextName, groundId, runtimeContext = null) {
  if (!contextName || !groundId) return null;
  let perspectives;
  try {
    perspectives = await StorageManager.listPerspectives(groundId);
  } catch (e) {
    Logger.warn('LandmarkResolver', `findPerspectiveIframeContext listPerspectives failed: ${e.message}`);
    return null;
  }
  if (!Array.isArray(perspectives) || perspectives.length === 0) return null;

  // v2.74.247 — Phase 7c: narrow to active perspectives when a runtime
  // context is supplied. Per spec § 5, the first-ACTIVE perspective's
  // declaration wins. Without a runtime context (legacy callers),
  // fall back to all perspectives as before.
  const candidatePool = [];
  for (const perspective of perspectives) {
    if (runtimeContext) {
      try {
        const active = await isPerspectiveActive(perspective, runtimeContext);
        if (!active) continue;
      } catch { continue; }
    }
    candidatePool.push(perspective);
  }
  // If active-filter ruled out everything but candidates exist
  // overall, fall back to the unfiltered pool — graceful degradation
  // for perspectives whose predicates can't be evaluated synchronously yet.
  const pool = candidatePool.length > 0 ? candidatePool : perspectives;

  // First pass: perspectives that reference this landmark AND declare the
  // named context. This is the canonical "in the active Perspective at
  // resolution time" semantic, approximated.
  const referrers = [];
  for (const perspective of pool) {
    const hasContext = Array.isArray(perspective.iframeContexts)
      && perspective.iframeContexts.some(c => c?.contextName === contextName);
    if (!hasContext) continue;
    const referencesIt = (Array.isArray(perspective.landmarkRefs) && perspective.landmarkRefs.includes(landmarkUid)) ||
      (Array.isArray(perspective.landmarks) && perspective.landmarks.some(l =>
        (l && l.ref === landmarkUid) || (l && l.uid === landmarkUid)
      ));
    if (referencesIt) referrers.push(perspective);
  }
  // Deterministic ordering for first-match: sort by perspective id.
  referrers.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  if (referrers.length > 0) {
    const perspective = referrers[0];
    return {
      perspective,
      context: perspective.iframeContexts.find(c => c.contextName === contextName),
    };
  }
  // Second pass: any perspective declaring the context. Handles edge cases
  // where the landmark→perspective link is via legacy form.
  for (const perspective of pool) {
    if (Array.isArray(perspective.iframeContexts)) {
      const ctx = perspective.iframeContexts.find(c => c?.contextName === contextName);
      if (ctx) return { perspective, context: ctx };
    }
  }
  return null;
}

/**
 * List landmarks across all perspectives for a ground. Used by authoring
 * dropdowns. Optionally filter to landmarks whose `operationsAllowed`
 * (from Wave 1 verification) includes the requested operation — that's
 * how the fragment CLICK dropdown shows only clickable landmarks, the
 * observation TYPE shape shows only typable landmarks, etc.
 *
 * Returns flat entries keyed for direct rendering:
 *   { perspectiveId, perspectiveName, role, selector, frameUrl, description,
 *     aliases, operationsAllowed, operationsCommon, score }
 *
 * @param {string} groundId
 * @param {{filterOp?: string, includeMismatch?: boolean}} [opts]
 * @returns {Promise<Array<object>>}
 */
export async function listLandmarksForGround(groundId, opts = {}) {
  const { filterOp = null, includeMismatch = false } = opts;
  // v2.74.240 — Phase 2 of substrate spec: pull from the per-Ground
  // landmark registry as the primary source. Perspectives are still
  // walked for `landmarks[]` (legacy embedded) AND for landmarkRefs
  // → registry hydration mapping. Registry-direct landmarks always
  // appear; legacy embedded landmarks de-duplicate by UID when they
  // overlap (registry wins).
  let perspectives = [];
  let registryLandmarks = [];
  try {
    perspectives = await StorageManager.listPerspectives(groundId);
  } catch (e) {
    Logger.warn('LandmarkResolver', `listLandmarksForGround(${groundId}) listPerspectives failed: ${e.message}`);
  }
  try {
    registryLandmarks = await StorageManager.listLandmarksForGround(groundId);
  } catch (e) {
    Logger.warn('LandmarkResolver', `listLandmarksForGround(${groundId}) registry list failed: ${e.message}`);
  }
  // Build a uid → perspective-name map so registry landmarks know which
  // perspective(s) they're referenced from. A landmark may be in multiple
  // perspectives — we surface the first reference for the dropdown label
  // (UID is the SSOT; perspective name is display sugar).
  const uidToPerspectiveMeta = new Map();
  for (const perspective of perspectives ?? []) {
    const refs = Array.isArray(perspective.landmarkRefs) ? perspective.landmarkRefs : [];
    for (const uid of refs) {
      if (!uidToPerspectiveMeta.has(uid)) {
        uidToPerspectiveMeta.set(uid, { perspectiveId: perspective.id, perspectiveName: perspective.name ?? perspective.id });
      }
    }
  }
  const seenUids = new Set();
  const out = [];
  // (1) Registry landmarks — the new SSOT path.
  for (const lm of registryLandmarks) {
    if (!lm || !lm.uid || !lm.selector) continue;
    const score = lm.verified?.score ?? null;
    if (!includeMismatch && score === 'mismatch') continue;
    const opsAllowed = lm.verified?.operationsAllowed ?? [];
    if (filterOp && opsAllowed.length > 0 && !opsAllowed.includes(filterOp)) continue;
    seenUids.add(lm.uid);
    const perspectiveMeta = uidToPerspectiveMeta.get(lm.uid) ?? { perspectiveId: null, perspectiveName: '(unlinked)' };
    out.push({
      uid              : lm.uid,
      isCanonical      : lm.isCanonical === true,
      perspectiveId         : perspectiveMeta.perspectiveId,
      perspectiveName       : perspectiveMeta.perspectiveName,
      alias            : lm.alias || lm.a11yRole || '(no alias)',
      a11yRole         : lm.a11yRole ?? null,
      accessibleName   : lm.accessibleName ?? null,
      selector         : lm.selector,
      frameUrl         : lm.frameUrl ?? null,
      description      : lm.description ?? '',
      aliases          : Array.isArray(lm.aliases) ? lm.aliases : [],
      operationsAllowed: opsAllowed,
      operationsCommon : Array.isArray(lm.operationsCommon) ? lm.operationsCommon : [],
      score,
      pitfalls         : Array.isArray(lm.pitfalls) ? lm.pitfalls : [],
    });
  }
  // v2.74.275 — Legacy embedded landmarks path REMOVED. Registry is
  // the sole source of truth; perspectives reference via landmarkRefs[]
  // only. See SPEC_DEV entry [2026-05-21] — Legacy shape removal.
  // Sort: ready landmarks first, then by perspective name → alias.
  out.sort((a, b) => {
    const sa = a.score === 'ready' ? 0 : 1;
    const sb = b.score === 'ready' ? 0 : 1;
    if (sa !== sb) return sa - sb;
    const ln = (a.perspectiveName ?? '').localeCompare(b.perspectiveName ?? '');
    if (ln !== 0) return ln;
    return (a.alias ?? '').localeCompare(b.alias ?? '');
  });
  return out;
}
