/**
 * @file Services/Sync/RebuildRefs.js
 * @description Client-only manifest rebuild (DD-06). Never uploaded standalone.
 */

import { StorageManager } from '../StorageManager.js';
import { manifestPath } from '../Storage/StoragePaths.js';
import { wrapEnvelope } from '../Storage/StoredEnvelope.js';

/**
 * @param {string} groundId
 * @param {{ orchardUserId?: string }} [opts]
 * @returns {Promise<{ path: string, envelope: import('../Storage/StoredEnvelope.js').StoredPrimitive<unknown> }|null>}
 */
export async function rebuildGroundManifest(groundId, opts = {}) {
  if (!groundId) return null;

  const [
    fragments,
    observations,
    assertions,
    analyses,
    perspectives,
    landmarks,
    strategies,
  ] = await Promise.all([
    StorageManager.listFragments(groundId).catch(() => []),
    StorageManager.listObservations(groundId).catch(() => []),
    StorageManager.listAssertions(groundId).catch(() => []),
    StorageManager.listAnalyses(groundId).catch(() => []),
    StorageManager.listPerspectives(groundId).catch(() => []),
    StorageManager.listLandmarksForGround(groundId).catch(() => []),
    StorageManager.listStrategies(groundId).catch(() => []),
  ]);

  const body = {
    groundId,
    localeIds: [],
    perspectiveIds: perspectives.map((p) => p.id),
    fragmentIds: fragments.map((f) => f.id),
    observationIds: observations.map((o) => o.id),
    assertionIds: assertions.map((a) => a.id),
    analysisIds: analyses.map((a) => a.id),
    workflowIds: strategies.map((s) => s.id),
    landmarkUids: landmarks.map((l) => l.uid || l.id),
    lastRebuiltAt: Date.now(),
  };

  const envelope = wrapEnvelope(body, `${groundId}-manifest`, {
    type: opts.orchardUserId ? 'external' : 'local',
    orchardUserId: opts.orchardUserId,
  });

  return {
    path: manifestPath(groundId),
    envelope,
  };
}

/**
 * @param {string|string[]} groundIds
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function rebuildRefs(groundIds, opts = {}) {
  const ids = Array.isArray(groundIds) ? groundIds : [groundIds];
  const manifests = [];
  for (const gid of ids) {
    const m = await rebuildGroundManifest(gid, opts);
    if (m) manifests.push(m);
  }
  return manifests;
}
