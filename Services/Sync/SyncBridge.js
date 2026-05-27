/**
 * @file Services/Sync/SyncBridge.js
 * @description Hook local storage writes into the sync outbox.
 */

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../StorageManager.js';
import { getCloudSession } from '../Cloud/CloudTokenStore.js';
import { SYNCABLE_KINDS, recordMetaFromPath } from '../Storage/StoragePaths.js';
import { listCachedObjectPaths } from '../Storage/IndexedDBStore.js';
import * as GroundAssetStore from '../Storage/GroundAssetStore.js';
import {
  enqueueRecordWrite,
  enqueueRecordDelete,
  enqueueGroundTreeDelete,
  isHybridSyncActive,
} from './SyncEngine.js';

/** @typedef {import('../Storage/StoragePaths.js').SyncKind} SyncKind */

/** @type {Record<string, SyncKind>} */
const KIND_ALIASES = {
  ground: 'ground',
  grounds: 'ground',
  fragment: 'fragment',
  fragments: 'fragment',
  observation: 'observation',
  observations: 'observation',
  analysis: 'analysis',
  analyses: 'analysis',
  assertion: 'assertion',
  assertions: 'assertion',
  perspective: 'perspective',
  perspectives: 'perspective',
  landmark: 'landmark',
  landmarks: 'landmark',
  strategy: 'strategy',
  strategies: 'strategy',
  workflow: 'workflow',
  workflows: 'workflow',
  locale: 'locale',
  locales: 'locale',
  siteMap: 'siteMap',
  sitemap: 'siteMap',
  chrome: 'chrome',
};

/**
 * @param {SyncKind} kind
 * @param {string} id
 * @param {{ groundId?: string }} [opts]
 */
async function loadRecord(kind, id, opts = {}) {
  switch (kind) {
    case 'ground': return StorageManager.getGround(id);
    case 'fragment': return StorageManager.getFragment(id);
    case 'observation': return StorageManager.getObservation(id);
    case 'analysis': return StorageManager.getAnalysis(id);
    case 'assertion': return StorageManager.getAssertion(id);
    case 'perspective': return StorageManager.getPerspective(id);
    case 'landmark': return StorageManager.getLandmark(id);
    case 'strategy': return StorageManager.getStrategy(id);
    case 'workflow': return StorageManager.getWorkflow(id);
    case 'locale': {
      if (!opts.groundId) return null;
      const entry = await GroundAssetStore.readLocale(opts.groundId, id);
      if (!entry?.model) return null;
      return GroundAssetStore.localeSyncRecord(opts.groundId, id, entry);
    }
    case 'siteMap': {
      const groundId = opts.groundId || id;
      const siteMap = await GroundAssetStore.readSiteMap(groundId);
      if (!siteMap) return null;
      return GroundAssetStore.siteMapSyncRecord(groundId, siteMap);
    }
    case 'chrome': {
      const groundId = opts.groundId || id;
      const chrome = await GroundAssetStore.readChrome(groundId);
      if (!chrome) return null;
      return GroundAssetStore.chromeSyncRecord(groundId, chrome);
    }
    default: return null;
  }
}

/**
 * @param {SyncKind} kind
 * @param {string} id
 * @param {{ groundId?: string }} [opts]
 * @returns {Promise<Record<string, unknown>|null>}
 */
async function resolveDeleteRecord(kind, id, opts = {}) {
  const existing = await loadRecord(kind, id, opts);
  if (existing) return /** @type {Record<string, unknown>} */ (existing);

  const paths = await listCachedObjectPaths();
  for (const path of paths) {
    const meta = recordMetaFromPath(path);
    if (meta?.kind === kind && meta.id === id) {
      return {
        id,
        groundId: meta.groundId,
        localeKey: kind === 'locale' ? id : undefined,
      };
    }
  }

  if (kind === 'ground') return { id, groundId: id };
  if (kind === 'workflow') return { id };
  if (kind === 'siteMap' || kind === 'chrome') return { id, groundId: id };
  if (kind === 'locale' && opts.groundId) return { id, groundId: opts.groundId, localeKey: id };
  return null;
}

/**
 * @param {string} kind
 * @param {string|null} id
 * @param {'saved'|'deleted'} action
 * @param {{ groundId?: string, orchardUserId?: string }} [opts]
 */
export async function syncBridgeOnStorageChange(kind, id, action, opts = {}) {
  if (!(await isHybridSyncActive())) return;
  if (!id) return;

  const normalized = KIND_ALIASES[kind];
  if (!normalized || !SYNCABLE_KINDS.includes(normalized)) return;

  try {
    const session = await getCloudSession();
    const syncOpts = { orchardUserId: session?.orchardUserId, groundId: opts.groundId };

    if (action === 'deleted') {
      if (normalized === 'ground') {
        await enqueueGroundTreeDelete(id, syncOpts);
        return;
      }
      const record = await resolveDeleteRecord(normalized, id, syncOpts);
      if (!record) {
        Logger.warn('SyncBridge', `delete sync skipped ${kind}/${id}: record not found`);
        return;
      }
      await enqueueRecordDelete(normalized, record, syncOpts);
      return;
    }

    if (action !== 'saved') return;

    const record = await loadRecord(normalized, id, syncOpts);
    if (!record) return;
    await enqueueRecordWrite(normalized, /** @type {Record<string, unknown>} */ (record), syncOpts);
  } catch (e) {
    Logger.warn('SyncBridge', `enqueue failed ${kind}/${id}: ${e.message}`);
  }
}
