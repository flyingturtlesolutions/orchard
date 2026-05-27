/**
 * @file Services/Storage/PartitionWrite.js
 * @description Write-primary path: IndexedDB workspace partition first when hybrid sync is active.
 * chrome.storage remains the compatibility backup written immediately after.
 */

import { isPartitionReadEnabled } from './PartitionRead.js';
import {
  mirrorToWorkspacePartition,
  removeFromWorkspacePartition,
  clearWorkspacePartitionForGround,
  isWorkspacePartitionKind,
} from './WorkspacePartitionStore.js';

/** @typedef {import('./StoragePaths.js').SyncKind} SyncKind */

/** Same gate as partition reads — hybrid sync signed in and backfilled. */
export { isPartitionReadEnabled as isPartitionWriteEnabled };

/**
 * Write record to workspace partition before chrome.storage backup.
 * @param {SyncKind} kind
 * @param {Record<string, unknown>} record
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function maybeWritePartitionPrimary(kind, record, opts = {}) {
  if (!isWorkspacePartitionKind(kind)) return;
  if (!(await isPartitionReadEnabled())) return;
  await mirrorToWorkspacePartition(kind, record, opts);
}

/**
 * Remove record from workspace partition before chrome.storage delete.
 * @param {SyncKind} kind
 * @param {Record<string, unknown>} record
 */
export async function maybeRemovePartitionPrimary(kind, record) {
  if (!isWorkspacePartitionKind(kind)) return;
  if (!(await isPartitionReadEnabled())) return;
  await removeFromWorkspacePartition(kind, record);
}

/** @param {string} groundId */
export async function maybeClearGroundPartitionPrimary(groundId) {
  if (!groundId) return;
  if (!(await isPartitionReadEnabled())) return;
  await clearWorkspacePartitionForGround(groundId);
}
