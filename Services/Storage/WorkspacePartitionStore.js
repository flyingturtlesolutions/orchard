/**
 * @file Services/Storage/WorkspacePartitionStore.js
 * @description M2 workspace partition in IndexedDB (write-primary + read-primary when hybrid).
 * Writes and reads prefer IndexedDB workspace partition when hybrid sync is active;
 * chrome.storage is the compatibility backup.
 */

import { Logger } from '../../Core/Logger.js';
import { logicalPathForRecord } from './StoragePaths.js';
import { wrapEnvelope, envelopeUpdatedAt, unwrapEnvelope } from './StoredEnvelope.js';
import {
  putWorkspaceRecord,
  removeWorkspaceRecord,
  getWorkspaceByLookup,
  getWorkspaceRecord,
  listWorkspaceRecordsForGround,
  hasWorkspaceRecordsForGround,
  countWorkspaceRecords,
} from './IndexedDBStore.js';

/** @typedef {import('./StoragePaths.js').SyncKind} SyncKind */

/** All ground-scoped workspace kinds mirrored in M2 (excludes global workflows). */
export const WORKSPACE_PARTITION_KINDS = /** @type {const} */ ([
  'ground',
  'fragment',
  'observation',
  'analysis',
  'assertion',
  'perspective',
  'landmark',
  'locale',
  'siteMap',
  'chrome',
]);

/**
 * @param {SyncKind} kind
 */
export function isWorkspacePartitionKind(kind) {
  return WORKSPACE_PARTITION_KINDS.includes(/** @type {typeof WORKSPACE_PARTITION_KINDS[number]} */ (kind));
}

/**
 * @param {SyncKind} kind
 * @param {Record<string, unknown>} record
 */
function partitionRecordId(kind, record) {
  if (kind === 'locale') return String(record.localeKey || record.id || '');
  if (kind === 'landmark') return String(record.uid || record.id || '');
  if (kind === 'siteMap' || kind === 'chrome') return String(record.groundId || record.id || '');
  return String(record.id || '');
}

/**
 * @param {SyncKind} kind
 * @param {string} recordId
 */
function makeLookupKey(kind, recordId) {
  return `${kind}:${recordId}`;
}

/**
 * @param {SyncKind} kind
 * @param {Record<string, unknown>} record
 */
function partitionGroundId(kind, record) {
  if (kind === 'ground') return String(record.id);
  return String(record.groundId || record.id || '');
}

/**
 * @param {SyncKind} kind
 * @param {string} recordId
 * @param {{ groundId?: string }} [opts]
 * @returns {Promise<Record<string, unknown>|null>}
 */
export async function readPartitionRecord(kind, recordId, opts = {}) {
  if (!recordId) return null;

  let row = await getWorkspaceByLookup(makeLookupKey(kind, recordId));
  if (!row && opts.groundId) {
    const path = logicalPathForRecord(kind, {
      id: recordId,
      groundId: opts.groundId,
      localeKey: kind === 'locale' ? recordId : undefined,
      uid: kind === 'landmark' ? recordId : undefined,
    });
    if (path) row = await getWorkspaceRecord(path);
  }
  if (!row?.envelope) return null;
  return /** @type {Record<string, unknown>} */ (unwrapEnvelope(row.envelope) || null);
}

/**
 * @param {SyncKind} kind
 * @param {string} groundId
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listPartitionRecordsForGround(kind, groundId) {
  const rows = await listWorkspaceRecordsForGround(groundId);
  return rows
    .filter((row) => row.kind === kind)
    .map((row) => /** @type {Record<string, unknown>} */ (unwrapEnvelope(row.envelope) || {}))
    .filter((body) => body && typeof body === 'object');
}

/** @param {string} groundId */
export async function hasPartitionDataForGround(groundId) {
  return hasWorkspaceRecordsForGround(groundId);
}

/**
 * @param {SyncKind} kind
 * @param {Record<string, unknown>} record
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function mirrorToWorkspacePartition(kind, record, opts = {}) {
  if (!isWorkspacePartitionKind(kind)) return;

  const path = logicalPathForRecord(kind, record);
  if (!path) return;

  const recordId = partitionRecordId(kind, record);
  const envelope = wrapEnvelope(record, recordId, {
    type: opts.orchardUserId ? 'external' : 'local',
    orchardUserId: opts.orchardUserId,
  });

  await putWorkspaceRecord({
    path,
    groundId: partitionGroundId(kind, record),
    kind,
    recordId,
    lookupKey: makeLookupKey(kind, recordId),
    envelope,
    updatedAt: envelopeUpdatedAt(envelope) || Date.now(),
  });
}

/**
 * Mirror from a pulled/stored envelope (ensures id/localeKey/groundId on record body).
 * @param {SyncKind} kind
 * @param {unknown} envelope
 * @param {{ id: string, groundId?: string }} meta
 */
export async function mirrorEnvelopeToWorkspacePartition(kind, envelope, meta) {
  if (!isWorkspacePartitionKind(kind)) return;
  const body = /** @type {Record<string, unknown>} */ (unwrapEnvelope(envelope) || {});
  const record = {
    ...body,
    id: meta.id,
    ...(meta.groundId ? { groundId: meta.groundId } : {}),
  };
  if (kind === 'locale') record.localeKey = meta.id;
  await mirrorToWorkspacePartition(kind, record);
}

/**
 * @param {SyncKind} kind
 * @param {Record<string, unknown>} record
 */
export async function removeFromWorkspacePartition(kind, record) {
  if (!isWorkspacePartitionKind(kind)) return;
  const path = logicalPathForRecord(kind, record);
  if (!path) return;
  await removeWorkspaceRecord(path);
}

/** @returns {Promise<number>} */
export async function getWorkspacePartitionCount() {
  return countWorkspaceRecords();
}

/** @param {string} groundId */
export async function clearWorkspacePartitionForGround(groundId) {
  if (!groundId) return;
  const rows = await listWorkspaceRecordsForGround(groundId);
  for (const row of rows) {
    await removeWorkspaceRecord(row.path);
  }
}
