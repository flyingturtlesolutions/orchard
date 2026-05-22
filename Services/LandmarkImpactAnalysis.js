/**
 * @file Services/LandmarkImpactAnalysis.js
 * @description Phase 5 of the landmark SSOT project. Compute the
 * "blast radius" of a landmark — which Locales, Fragments, and
 * Observations reference it — so authors can see the impact before
 * removing or deprecating.
 *
 * Per spec § Reference integrity:
 *   - Don't allow silent dangling references
 *   - Surface impact to user before deletion
 *   - Either: replace references with another landmark, or accept
 *     that those primitives become broken
 *
 * v1 scope:
 *   - Locales referencing the UID (modern `landmarkRefs[]` OR legacy
 *     embedded `landmarks[]` with matching uid).
 *   - Fragments containing actions with `landmarkRef.uid === target`.
 *     Legacy `{ localeId, role }` refs are also counted when the
 *     landmark's role matches and the localeId references the same
 *     landmark UID at lookup time.
 *   - Observations: same as fragments.
 *
 * @module Services/LandmarkImpactAnalysis
 * @version 2.74.243
 */

import { StorageManager } from './StorageManager.js';
import { Logger }         from '../Core/Logger.js';

/**
 * Walk a fragment's rawJson actions and count references to the
 * target UID. v2.74.275 — Legacy `{ localeId, role }` ref counting
 * REMOVED; only canonical `{ uid }` refs exist.
 */
function _countRefsInFragmentActions(actions, targetUid) {
  if (!Array.isArray(actions)) return 0;
  let count = 0;
  for (const a of actions) {
    if (!a || typeof a !== 'object') continue;
    if (a.landmarkRef && a.landmarkRef.uid === targetUid) count++;
    if (Array.isArray(a.branches)) count += _countRefsInFragmentActions(a.branches, targetUid);
    if (Array.isArray(a.body))     count += _countRefsInFragmentActions(a.body, targetUid);
  }
  return count;
}

function _countRefsInObservationExtracts(extracts, targetUid) {
  if (!Array.isArray(extracts)) return 0;
  let count = 0;
  for (const ex of extracts) {
    if (!ex || typeof ex !== 'object') continue;
    if (ex.landmarkRef && ex.landmarkRef.uid === targetUid) count++;
    if (Array.isArray(ex.body)) count += _countRefsInObservationExtracts(ex.body, targetUid);
  }
  return count;
}

/**
 * Analyze the impact of removing or deprecating a landmark.
 *
 * @param {string} uid       Target landmark UID
 * @param {string} groundId  Ground scope (landmarks are per-Ground in v1)
 * @returns {Promise<{
 *   uid: string,
 *   landmark: object|null,
 *   locales: Array<{id, name}>,
 *   fragments: Array<{id, name, refCount}>,
 *   observations: Array<{id, name, refCount}>,
 *   totalConsumers: number,
 *   orphanIfRemoved: boolean,
 * }>}
 */
export async function analyzeLandmarkImpact(uid, groundId) {
  if (!uid || !groundId) {
    return { uid, landmark: null, locales: [], fragments: [], observations: [], totalConsumers: 0, orphanIfRemoved: true };
  }

  const landmark = await StorageManager.getLandmark(uid).catch(() => null);

  // (1) Locales — landmarkRefs[] only. v2.74.275: embedded path removed.
  let locales = [];
  try {
    const allLocales = await StorageManager.listLocales(groundId);
    for (const locale of allLocales ?? []) {
      if (Array.isArray(locale.landmarkRefs) && locale.landmarkRefs.includes(uid)) {
        locales.push({ id: locale.id, name: locale.name ?? locale.id });
      }
    }
  } catch (e) {
    Logger.warn('LandmarkImpactAnalysis', `listLocales failed: ${e.message}`);
  }

  // (2) Fragments — parse rawJson and count refs across all action
  // surfaces (top-level actions, chain branches, gate body subs).
  const fragments = [];
  try {
    const allFragments = await StorageManager.listFragments(groundId);
    for (const frag of allFragments ?? []) {
      let actions;
      try {
        actions = typeof frag.rawJson === 'string' ? JSON.parse(frag.rawJson) : (Array.isArray(frag.rawJson) ? frag.rawJson : []);
      } catch {
        actions = [];
      }
      const refCount = _countRefsInFragmentActions(actions, uid);
      if (refCount > 0) {
        fragments.push({ id: frag.id, name: frag.name ?? frag.id, refCount });
      }
    }
  } catch (e) {
    Logger.warn('LandmarkImpactAnalysis', `listFragments failed: ${e.message}`);
  }

  // (3) Observations — landmarks in extracts (and extract_gate body subs).
  const observations = [];
  try {
    const allObs = await StorageManager.listObservations(groundId);
    for (const obs of allObs ?? []) {
      const extracts = Array.isArray(obs.extracts) ? obs.extracts : [];
      const refCount = _countRefsInObservationExtracts(extracts, uid);
      if (refCount > 0) {
        observations.push({ id: obs.id, name: obs.name ?? obs.id, refCount });
      }
    }
  } catch (e) {
    Logger.warn('LandmarkImpactAnalysis', `listObservations failed: ${e.message}`);
  }

  const totalConsumers = locales.length + fragments.length + observations.length;
  // If only ONE locale references this landmark, removing it from that
  // locale orphans the registry record (no other locale references it).
  const orphanIfRemoved = locales.length <= 1 && fragments.length === 0 && observations.length === 0;

  return { uid, landmark, locales, fragments, observations, totalConsumers, orphanIfRemoved };
}
