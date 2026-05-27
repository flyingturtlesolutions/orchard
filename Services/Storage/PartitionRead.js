/**
 * @file Services/Storage/PartitionRead.js
 * @description Read path: IndexedDB workspace partition first when hybrid sync is active.
 */

import { getCloudSettings } from '../Cloud/CloudSettings.js';
import {
  readPartitionRecord,
  listPartitionRecordsForGround,
  hasPartitionDataForGround,
  isWorkspacePartitionKind,
} from './WorkspacePartitionStore.js';

/** @typedef {import('./StoragePaths.js').SyncKind} SyncKind */

/**
 * Whether local reads/writes route through the IndexedDB workspace partition as primary.
 *
 * Fresh-start model (no migration / no flat→partition backfill): the partition IS the primary
 * local store from the moment the hybrid backend is selected. There is nothing to migrate and no
 * backfill to complete, so gating on a backfill-version flag (which is now never written) would
 * keep the partition permanently dead — every read/write would silently bypass IndexedDB and stay
 * on flat chrome.storage. Gate purely on the hybrid backend being selected.
 *
 * IMPORTANT: this gates LOCAL STORAGE ROUTING, so it must NOT depend on live auth/token state — a
 * token expiry must not re-shadow the partition. `settings.storageBackend` is a persisted choice,
 * not live auth, so it is safe. Reads remain safe even before the partition is populated:
 * maybeReadPartition falls back to flat when a record is absent, and maybeListPartition guards on
 * hasPartitionDataForGround; writes dual-write flat as a backup.
 *
 * @returns {Promise<boolean>}
 */
export async function isPartitionReadEnabled() {
  const settings = await getCloudSettings();
  return Boolean(settings.enabled && settings.storageBackend === 'hybrid');
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
