/**
 * @file Services/Storage/PartitionRead.js
 * @description Read path: IndexedDB workspace partition first when hybrid sync is active.
 */

import { getCloudSettings } from '../Cloud/CloudSettings.js';
import { isCloudSignedIn } from '../Cloud/CloudTokenStore.js';
import {
  readPartitionRecord,
  listPartitionRecordsForGround,
  hasPartitionDataForGround,
  isWorkspacePartitionKind,
} from './WorkspacePartitionStore.js';

/** @typedef {import('./StoragePaths.js').SyncKind} SyncKind */

/** @returns {Promise<boolean>} */
export async function isPartitionReadEnabled() {
  const settings = await getCloudSettings();
  if (!settings.enabled || settings.storageBackend !== 'hybrid') return false;
  return isCloudSignedIn();
}

/**
 * @param {SyncKind} kind
 * @param {string} recordId
 * @param {{ groundId?: string }} [opts]
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function maybeReadPartition(kind, recordId, opts = {}) {
  if (!isWorkspacePartitionKind(kind)) return null;
  if (!(await isPartitionReadEnabled())) return null;
  return readPartitionRecord(kind, recordId, opts);
}

/**
 * Returns null when partition read is off or ground has no partition rows yet.
 * @param {SyncKind} kind
 * @param {string} groundId
 * @returns {Promise<Record<string, unknown>[]|null>}
 */
export async function maybeListPartition(kind, groundId) {
  if (!isWorkspacePartitionKind(kind) || !groundId) return null;
  if (!(await isPartitionReadEnabled())) return null;
  if (!(await hasPartitionDataForGround(groundId))) return null;
  return listPartitionRecordsForGround(kind, groundId);
}
