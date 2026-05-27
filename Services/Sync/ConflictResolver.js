/**
 * @file Services/Sync/ConflictResolver.js
 * @description DD-03 tier-1 auto-LWW vs tier-2 manual merge.
 */

import { isAutoLwwPath } from '../Storage/StoragePaths.js';
import { envelopeUpdatedAt } from '../Storage/StoredEnvelope.js';

/**
 * @typedef {Object} ConflictPayload
 * @property {string} path
 * @property {unknown} server
 * @property {unknown} client
 * @property {string} [resolution]
 * @property {string} [suggestedAction]
 */

/**
 * @param {ConflictPayload} conflict
 * @returns {'auto-lww'|'manual'|'keep-theirs'}
 */
export function resolveConflictAction(conflict) {
  const { path, server, client } = conflict;
  if (conflict.resolution === 'manual-required') return 'manual';
  if (!isAutoLwwPath(path)) return 'manual';

  const clientAt = envelopeUpdatedAt(client);
  const serverAt = envelopeUpdatedAt(server);
  if (clientAt > serverAt) return 'auto-lww';
  return 'keep-theirs';
}

/**
 * @param {ConflictPayload} conflict
 * @returns {unknown|null}
 */
export function pickAutoResolvedEnvelope(conflict) {
  const action = resolveConflictAction(conflict);
  if (action === 'auto-lww') return conflict.client;
  if (action === 'keep-theirs') return conflict.server;
  return null;
}

/**
 * @param {ConflictPayload} conflict
 * @returns {boolean}
 */
export function shouldQueueManualConflict(conflict) {
  return resolveConflictAction(conflict) === 'manual';
}
