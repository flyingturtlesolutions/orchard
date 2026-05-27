/**
 * @file Services/Sync/SyncBridge.js
 * @description Hook local storage writes into the sync outbox.
 */

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../StorageManager.js';
import { getCloudSession } from '../Cloud/CloudTokenStore.js';
import { SYNCABLE_KINDS } from '../Storage/StoragePaths.js';
import { enqueueRecordWrite, isHybridSyncActive } from './SyncEngine.js';

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
};

/**
 * @param {SyncKind} kind
 * @param {string} id
 */
async function loadRecord(kind, id) {
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
    default: return null;
  }
}

/**
 * @param {string} kind
 * @param {string|null} id
 * @param {'saved'|'deleted'} action
 */
export async function syncBridgeOnStorageChange(kind, id, action) {
  if (!(await isHybridSyncActive())) return;
  if (!id || action !== 'saved') return;

  const normalized = KIND_ALIASES[kind];
  if (!normalized || !SYNCABLE_KINDS.includes(normalized)) return;

  try {
    const record = await loadRecord(normalized, id);
    if (!record) return;
    const session = await getCloudSession();
    await enqueueRecordWrite(normalized, /** @type {Record<string, unknown>} */ (record), {
      orchardUserId: session?.orchardUserId,
    });
  } catch (e) {
    Logger.warn('SyncBridge', `enqueue failed ${kind}/${id}: ${e.message}`);
  }
}
