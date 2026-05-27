/**
 * @file Services/Storage/WorkspacePartitionBackfill.js
 * @description One-time legacy → workspace partition mirror (static imports for MV3 SW).
 */

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../StorageManager.js';
import { getMeta, setMeta } from './IndexedDBStore.js';
import {
  LOCALE_CACHE_KEY,
  siteMapStorageKey,
  chromeStorageKey,
  localeSyncRecord,
  siteMapSyncRecord,
  chromeSyncRecord,
} from './GroundAssetSyncRecords.js';
import { mirrorToWorkspacePartition } from './WorkspacePartitionStore.js';

/** @typedef {import('./StoragePaths.js').SyncKind} SyncKind */

const BACKFILL_VERSION_KEY = 'workspacePartitionBackfillVersion';
const CURRENT_BACKFILL_VERSION = 3;

/**
 * Backfill from flat chrome.storage + ground assets into workspace partition store.
 * @returns {Promise<{ mirrored: number, skipped?: boolean }>}
 */
export async function backfillWorkspacePartitionFromLegacy() {
  const version = await getMeta(BACKFILL_VERSION_KEY);
  if (version === CURRENT_BACKFILL_VERSION) {
    return { mirrored: 0, skipped: true };
  }

  let mirrored = 0;

  /** @param {SyncKind} kind @param {Record<string, unknown>} record */
  async function mirrorOne(kind, record) {
    await mirrorToWorkspacePartition(kind, record);
    mirrored += 1;
  }

  for (const ground of await StorageManager.getAllGrounds()) {
    await mirrorOne('ground', /** @type {Record<string, unknown>} */ (ground));

    const groundId = String(ground.id);
    const [
      fragments,
      observations,
      analyses,
      assertions,
      perspectives,
      landmarks,
    ] = await Promise.all([
      StorageManager.listFragments(groundId),
      StorageManager.listObservations(groundId),
      StorageManager.listAnalyses(groundId),
      StorageManager.listAssertions(groundId),
      StorageManager.listPerspectives(groundId),
      StorageManager.listLandmarksForGround(groundId),
    ]);

    for (const r of fragments) await mirrorOne('fragment', r);
    for (const r of observations) await mirrorOne('observation', r);
    for (const r of analyses) await mirrorOne('analysis', r);
    for (const r of assertions) await mirrorOne('assertion', r);
    for (const r of perspectives) await mirrorOne('perspective', r);
    for (const r of landmarks) await mirrorOne('landmark', r);

    try {
      const localeGot = await chrome.storage.local.get(LOCALE_CACHE_KEY);
      const byKey = localeGot?.[LOCALE_CACHE_KEY]?.[groundId] ?? {};
      for (const [localeKey, entry] of Object.entries(byKey)) {
        if (!entry?.model) continue;
        await mirrorOne('locale', localeSyncRecord(groundId, localeKey, {
          model: entry.model,
          url: entry.url,
          capturedAt: entry.capturedAt,
        }));
      }
    } catch { /* best-effort */ }

    try {
      const smKey = siteMapStorageKey(groundId);
      const smGot = await chrome.storage.local.get(smKey);
      const siteMap = smGot?.[smKey];
      if (siteMap) await mirrorOne('siteMap', siteMapSyncRecord(groundId, siteMap));
    } catch { /* best-effort */ }

    try {
      const chKey = chromeStorageKey(groundId);
      const chGot = await chrome.storage.local.get(chKey);
      const chrome = chGot?.[chKey];
      if (chrome) await mirrorOne('chrome', chromeSyncRecord(groundId, chrome));
    } catch { /* best-effort */ }
  }

  await setMeta(BACKFILL_VERSION_KEY, CURRENT_BACKFILL_VERSION);
  Logger.info('WorkspacePartition', `backfill v${CURRENT_BACKFILL_VERSION} mirrored ${mirrored} record(s)`);
  return { mirrored };
}
