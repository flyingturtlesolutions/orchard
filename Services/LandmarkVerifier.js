/**
 * @file Services/LandmarkVerifier.js
 * @description Phase 9 of the landmark substrate spec. On-demand
 * re-verification of landmark realization against the live page.
 *
 * ── PROBLEM THIS CLOSES ──────────────────────────────────────────────
 *
 * Phases 3 + 8 together create a one-way lifecycle:
 *
 *   fresh → verified → stale-suspected → stale-confirmed
 *
 * TemplateWalker's runtime recovery moves landmarks INTO stale-
 * suspected (the cached selector failed; heuristic recovery found a
 * replacement for the current step). It NEVER moves them back out.
 * A landmark that was a one-time false alarm — e.g. the page was
 * mid-transition when recovery ran — would sit in stale-suspected
 * forever, polluting Studio sidebars and biasing AI authoring against
 * a perfectly fine landmark.
 *
 * The verifier provides the inverse transition: probe a landmark
 * against the current page; if it resolves cleanly via the cached
 * selector, the previous suspicion was wrong → flip back to verified.
 *
 * ── POLICY (decisions explicitly confirmed by user, 2026-05-21) ──────
 *
 * 1. Heuristic confirmation auto-updates the stored selector AND
 *    flips lifecycle to verified. Rationale: the substrate's three-
 *    layer model commits to "realization is replaceable while identity
 *    stays stable." Heuristic recovery proved the new selector
 *    resolves the same role + accessibleName + hierarchicalContext —
 *    that's two independent observations of the same identity (Phase 3
 *    runtime + this verify call) so we promote.
 *
 * 2. No automatic trigger. The verifier is a substrate PRIMITIVE.
 *    UI surfaces (Studio "verify all" button) and future automation
 *    (webNavigation.onCompleted reactor) decide when to invoke. This
 *    file exposes the functions; background.js exposes them via
 *    VERIFY_LANDMARK and VERIFY_STALE_SUSPECTED_ON_GROUND handlers.
 *
 * ── VERIFICATION OUTCOMES ────────────────────────────────────────────
 *
 *   via: 'selector'   — cached selector resolves cleanly
 *                       → lifecycle = verified; selector unchanged
 *                       → emit LANDMARK_RESOLUTION_OK
 *
 *   via: 'heuristic'  — cached failed; recovery found single match
 *                       → lifecycle = verified; selector UPDATED
 *                       → emit LANDMARK_RESOLUTION_DEGRADED + OK
 *                          (degraded carries the selector swap;
 *                           OK marks the lifecycle promotion)
 *
 *   via: 'fail'       — cached failed AND recovery failed
 *                       → lifecycle = stale-confirmed
 *                       → emit LANDMARK_RESOLUTION_FAILED
 *
 *   skipped           — landmark has no description layer (legacy
 *                       pre-Phase-1), or no tabId provided. Returns
 *                       { success: true, skipped: true, reason }.
 *                       Lifecycle untouched.
 *
 * @module Services/LandmarkVerifier
 */

import { StorageManager }                  from './StorageManager.js';
import { emit as emitGroundEvent, EVENT_KIND } from './GroundEventBus.js';
import { Logger }                          from '../Core/Logger.js';

const TOP_FRAME_ID = 0;

function _send(tabId, message, frameId = TOP_FRAME_ID) {
  return new Promise(resolve => {
    try {
      chrome.tabs.sendMessage(tabId, message, { frameId }, response => {
        if (chrome.runtime.lastError) {
          Logger.debug('LandmarkVerifier', `send to frame ${frameId} failed: ${chrome.runtime.lastError.message}`);
          return resolve(null);
        }
        resolve(response);
      });
    } catch (e) {
      Logger.debug('LandmarkVerifier', `send threw: ${e.message}`);
      resolve(null);
    }
  });
}

async function _resolveFrameId(tabId, frameUrl) {
  if (!frameUrl) return TOP_FRAME_ID;
  let frames;
  try {
    frames = await new Promise(resolve => {
      chrome.webNavigation.getAllFrames({ tabId }, fs => resolve(fs ?? []));
    });
  } catch {
    return TOP_FRAME_ID;
  }
  if (!Array.isArray(frames) || frames.length === 0) return TOP_FRAME_ID;
  const exact = frames.find(f => f && f.url === frameUrl);
  if (exact) return exact.frameId;
  let savedOrigin = null;
  try { savedOrigin = new URL(frameUrl).origin; } catch { /* leave null */ }
  if (savedOrigin) {
    const origMatch = frames.find(f => {
      if (!f?.url) return false;
      try { return new URL(f.url).origin === savedOrigin; } catch { return false; }
    });
    if (origMatch) return origMatch.frameId;
  }
  return TOP_FRAME_ID;
}

/**
 * Verify a single landmark against the live page. The landmark must
 * carry a description layer (a11yRole + accessibleName) for heuristic
 * recovery to work. Legacy landmarks without description layer skip
 * with reason='no-description-layer'.
 *
 * @param {string} uid
 * @param {number} tabId
 * @returns {Promise<{
 *   success: boolean,
 *   uid: string,
 *   via?: 'selector'|'heuristic'|'fail',
 *   lifecycleBefore?: string,
 *   lifecycleAfter?: string,
 *   selectorChanged?: boolean,
 *   skipped?: boolean,
 *   reason?: string,
 *   error?: string,
 * }>}
 */
export async function verifyLandmark(uid, tabId) {
  if (!uid || typeof uid !== 'string') {
    return { success: false, uid, error: 'uid required' };
  }
  if (typeof tabId !== 'number') {
    return { success: true, uid, skipped: true, reason: 'no-tabId' };
  }
  const landmark = await StorageManager.getLandmark(uid);
  if (!landmark) {
    return { success: false, uid, error: 'landmark not found' };
  }
  const hasDescLayer = !!(landmark.a11yRole && landmark.accessibleName);
  if (!hasDescLayer) {
    return { success: true, uid, skipped: true, reason: 'no-description-layer' };
  }

  const frameId = await _resolveFrameId(tabId, landmark.frameUrl ?? landmark.realization?.frameUrl);
  const cachedSelector = landmark.selector ?? landmark.realization?.selector ?? null;
  if (!cachedSelector) {
    return { success: true, uid, skipped: true, reason: 'no-cached-selector' };
  }

  const probe = await _send(tabId, {
    type   : 'LANDMARK_PROBE_OR_RECOVER',
    payload: {
      selector: cachedSelector,
      fallback: {
        role               : landmark.a11yRole,
        accessibleName     : landmark.accessibleName,
        hierarchicalContext: landmark.hierarchicalContext,
      },
    },
  }, frameId);

  if (!probe) {
    return { success: false, uid, error: 'probe dispatch failed (content script unreachable?)' };
  }

  const lifecycleBefore = landmark.lifecycle ?? 'fresh';
  const groundId        = landmark.groundId ?? null;

  // ── via: 'selector' — cached works cleanly ───────────────────────
  if (probe.via === 'selector') {
    const patch = { lifecycle: 'verified', lastVerifiedTs: Date.now() };
    try {
      await StorageManager.updateLandmark(uid, patch);
    } catch (e) {
      Logger.warn('LandmarkVerifier', `updateLandmark(${uid}) failed: ${e.message}`);
    }
    if (groundId) {
      emitGroundEvent(groundId, {
        kind   : EVENT_KIND.LANDMARK_RESOLUTION_OK,
        uid,
        details: {
          via             : 'selector',
          lifecycleBefore,
          lifecycleAfter  : 'verified',
          trigger         : 'verifier',
        },
      }).catch(() => {});
    }
    return {
      success         : true,
      uid,
      via             : 'selector',
      lifecycleBefore,
      lifecycleAfter  : 'verified',
      selectorChanged : false,
    };
  }

  // ── via: 'heuristic' — recovery found a replacement ──────────────
  if (probe.via === 'heuristic') {
    const newSelector = probe.selector;
    // v2.74.270 — Match method (exact/substring/fuzzy/role-only) from
    // the content-script recovery. When fuzzy/substring, also persist
    // the new accessibleName so next recovery hits the exact-match
    // fast path.
    const matchMethod = probe.matchMethod ?? 'unknown';
    const patch = {
      lifecycle      : 'verified',
      selector       : newSelector,
      lastVerifiedTs : Date.now(),
      lastRecoveredTs: Date.now(),
    };
    if ((matchMethod === 'fuzzy' || matchMethod === 'substring') && probe.matchedName) {
      patch.accessibleName = probe.matchedName;
    }
    try {
      await StorageManager.updateLandmark(uid, patch);
    } catch (e) {
      Logger.warn('LandmarkVerifier', `updateLandmark(${uid}) failed: ${e.message}`);
    }
    if (groundId) {
      // Two events: degraded (carries the selector swap) + ok
      // (carries the lifecycle promotion). Two events makes the
      // history grep-friendly — degraded means "something changed",
      // ok means "verified". Consumers that only watch lifecycle
      // need only OK; consumers tracking realization drift need
      // both.
      emitGroundEvent(groundId, {
        kind   : EVENT_KIND.LANDMARK_RESOLUTION_DEGRADED,
        uid,
        details: {
          cachedSelector  : cachedSelector,
          recoveredSelector: newSelector,
          a11yRole        : landmark.a11yRole,
          accessibleName  : landmark.accessibleName,
          recoveryReason  : 'verifier-recovery',
          newLifecycle    : 'verified',
          trigger         : 'verifier',
          // v2.74.270 — Match method + drift detail.
          matchMethod,
          authoredName    : probe.authoredName,
          matchedName     : probe.matchedName,
          nameSimilarity  : probe.nameSimilarity,
        },
      }).catch(() => {});
      emitGroundEvent(groundId, {
        kind   : EVENT_KIND.LANDMARK_RESOLUTION_OK,
        uid,
        details: {
          via             : 'heuristic',
          lifecycleBefore,
          lifecycleAfter  : 'verified',
          selectorChanged : true,
          trigger         : 'verifier',
          matchMethod,
        },
      }).catch(() => {});
    }
    return {
      success         : true,
      uid,
      via             : 'heuristic',
      lifecycleBefore,
      lifecycleAfter  : 'verified',
      selectorChanged : true,
      matchMethod,
      authoredName    : probe.authoredName,
      matchedName     : probe.matchedName,
      nameSimilarity  : probe.nameSimilarity,
    };
  }

  // ── via: 'fail' — both selector and heuristic failed ─────────────
  const patch = { lifecycle: 'stale-confirmed' };
  try {
    await StorageManager.updateLandmark(uid, patch);
  } catch (e) {
    Logger.warn('LandmarkVerifier', `updateLandmark(${uid}) failed: ${e.message}`);
  }
  if (groundId) {
    emitGroundEvent(groundId, {
      kind   : EVENT_KIND.LANDMARK_RESOLUTION_FAILED,
      uid,
      details: {
        cachedSelector: cachedSelector,
        a11yRole      : landmark.a11yRole,
        accessibleName: landmark.accessibleName,
        reason        : probe.error ?? probe.reason ?? 'unknown',
        newLifecycle  : 'stale-confirmed',
        trigger       : 'verifier',
      },
    }).catch(() => {});
  }
  return {
    success         : true,
    uid,
    via             : 'fail',
    lifecycleBefore,
    lifecycleAfter  : 'stale-confirmed',
    selectorChanged : false,
    error           : probe.error ?? probe.reason ?? 'unknown',
  };
}

/**
 * Verify all landmarks on a ground that are currently in
 * `stale-suspected`. Runs sequentially (one content-script round-trip
 * per landmark) to avoid hammering the page. Returns a summary of
 * outcomes.
 *
 * Callers that want to verify ALL landmarks (not just stale-
 * suspected) pass `{ scope: 'all' }`. Default scope is the smallest
 * useful: just stale-suspected.
 *
 * @param {string} groundId
 * @param {number} tabId
 * @param {{ scope?: 'stale-suspected' | 'all' | Array<string> }} [opts]
 * @returns {Promise<{
 *   success: boolean,
 *   groundId: string,
 *   scanned: number,
 *   promoted: number,
 *   degraded: number,
 *   failed: number,
 *   skipped: number,
 *   outcomes: Array<object>,
 * }>}
 */
export async function verifyStaleSuspectedOnGround(groundId, tabId, opts = {}) {
  if (!groundId) return { success: false, groundId, error: 'groundId required', scanned: 0 };
  if (typeof tabId !== 'number') return { success: false, groundId, error: 'tabId required', scanned: 0 };

  let landmarks;
  try {
    landmarks = await StorageManager.listLandmarksForGround(groundId);
  } catch (e) {
    return { success: false, groundId, error: `list failed: ${e.message}`, scanned: 0 };
  }

  // Filter to scope
  const scope = opts.scope ?? 'stale-suspected';
  let pool;
  if (Array.isArray(scope)) {
    const set = new Set(scope);
    pool = landmarks.filter(l => set.has(l?.uid));
  } else if (scope === 'all') {
    pool = landmarks;
  } else {
    pool = landmarks.filter(l => l?.lifecycle === 'stale-suspected');
  }

  let promoted = 0, degraded = 0, failed = 0, skipped = 0;
  const outcomes = [];
  for (const lm of pool) {
    const outcome = await verifyLandmark(lm.uid, tabId);
    outcomes.push(outcome);
    if (outcome.skipped) skipped++;
    else if (outcome.via === 'selector') promoted++;
    else if (outcome.via === 'heuristic') { promoted++; degraded++; }
    else if (outcome.via === 'fail') failed++;
  }

  return {
    success : true,
    groundId,
    scanned : pool.length,
    promoted,
    degraded,
    failed,
    skipped,
    outcomes,
  };
}
