/**
 * @file Services/Storage/ChromeStorageAdapter.js
 * @description P0/P1 M1 adapter — delegates to legacy StorageManager with zero
 * behaviour change. Implements the StoragePort surface used by new cloud code;
 * expand delegation as callers migrate off direct StorageManager imports.
 */

import { StorageManager } from '../StorageManager.js';
import {
  getOutboundReferences,
  getInboundReferences,
  analyzeDeletionImpact,
  detectCycles,
  findOrphans,
  rebuildReferenceGraph,
  invalidateReferenceGraph,
} from './ReferenceStore.js';
import {
  getLocalUser,
  updateLocalUser,
  getLocalUserRef,
  bindPublicIdentity,
  bindAccount,
  listKnownExternalUsers,
  getExternalUser,
  recordExternalUserEncounter,
  setUserTrust,
} from './IdentityStore.js';

/** @typedef {import('./StoragePort.js').StorageBackend} StorageBackend */
/** @typedef {import('./StoragePort.js').StorageAdapterKind} StorageAdapterKind */

export class ChromeStorageAdapter {
  /** @type {StorageBackend} */
  storageBackend = 'local';

  /** @type {StorageAdapterKind} */
  adapterKind = 'chrome-storage';

  /** @param {StorageBackend} [backend] */
  constructor(backend = 'local') {
    this.storageBackend = backend;
  }

  // ── Grounds ───────────────────────────────────────────────────────────────

  saveGround(ground) { return StorageManager.saveGround(ground); }
  getGround(groundId) { return StorageManager.getGround(groundId); }
  getAllGrounds() { return StorageManager.getAllGrounds(); }
  updateGround(groundId, patch) { return StorageManager.updateGround(groundId, patch); }
  deleteGround(groundId) { return StorageManager.deleteGround(groundId); }

  // ── Fragments ─────────────────────────────────────────────────────────────

  saveFragment(fragment) { return StorageManager.saveFragment(fragment); }
  getFragment(fragmentId) { return StorageManager.getFragment(fragmentId); }
  listFragments(groundId) { return StorageManager.listFragments(groundId); }
  deleteFragment(fragmentId) { return StorageManager.deleteFragment(fragmentId); }
  updateFragment(fragmentId, patch) { return StorageManager.updateFragment(fragmentId, patch); }

  // ── Strategies (legacy UI name; schema workflows) ─────────────────────────

  saveStrategy(strategy) { return StorageManager.saveStrategy(strategy); }
  getStrategy(strategyId) { return StorageManager.getStrategy(strategyId); }
  listStrategies(groundId) { return StorageManager.listStrategies(groundId); }
  deleteStrategy(strategyId) { return StorageManager.deleteStrategy(strategyId); }
  updateStrategy(strategyId, patch) { return StorageManager.updateStrategy(strategyId, patch); }

  // ── Workflows (legacy UI name; schema strategies) ─────────────────────────

  saveWorkflow(workflow) { return StorageManager.saveWorkflow(workflow); }
  getWorkflow(workflowId) { return StorageManager.getWorkflow(workflowId); }
  listWorkflows() { return StorageManager.listWorkflows(); }
  deleteWorkflow(workflowId) { return StorageManager.deleteWorkflow(workflowId); }

  // ── Perspectives & landmarks ──────────────────────────────────────────────

  savePerspective(perspective) { return StorageManager.savePerspective(perspective); }
  getPerspective(perspectiveId) { return StorageManager.getPerspective(perspectiveId); }
  listPerspectives(groundId) { return StorageManager.listPerspectives(groundId); }
  deletePerspective(perspectiveId) { return StorageManager.deletePerspective(perspectiveId); }
  updatePerspective(perspectiveId, patch) { return StorageManager.updatePerspective(perspectiveId, patch); }

  saveLandmark(landmark) { return StorageManager.saveLandmark(landmark); }
  getLandmark(uid) { return StorageManager.getLandmark(uid); }
  listLandmarksForGround(groundId) { return StorageManager.listLandmarksForGround(groundId); }

  // ── Soft-delete (STORAGE_SCHEMA §10) ──────────────────────────────────────
  // Default, reversible delete. Hard delete stays the explicit delete<Kind> path.

  /** @param {string} kind @param {string} id */
  deprecatePrimitive(kind, id) { return StorageManager.deprecatePrimitive(kind, id); }
  /** @param {string} kind @param {string} id */
  restorePrimitive(kind, id) { return StorageManager.restorePrimitive(kind, id); }
  /** @param {string} kind @param {string} id */
  getPrimitiveLifecycle(kind, id) { return StorageManager.getPrimitiveLifecycle(kind, id); }

  // ── Reference graph (STORAGE_SCHEMA §7/§10; rebuilt from workspace) ────────
  // refs are derived, never the source of truth. Hard delete should consult
  // analyzeDeletionImpact first (block when inboundRefs / blockers are present).

  /** @param {string} id @param {{ groundId?: string }} [opts] */
  getOutboundReferences(id, opts) { return getOutboundReferences(id, opts); }
  /** @param {string} id @param {{ groundId?: string }} [opts] */
  getInboundReferences(id, opts) { return getInboundReferences(id, opts); }
  /** @param {string} id @param {object} [opts] */
  analyzeDeletionImpact(id, opts) { return analyzeDeletionImpact(id, opts); }
  /** @param {object} [opts] */
  detectCycles(opts) { return detectCycles(opts); }
  /** @param {object} [opts] */
  findOrphans(opts) { return findOrphans(opts); }
  /** @param {{ groundId?: string, fresh?: boolean }} [opts] */
  rebuildRefs(opts) { return rebuildReferenceGraph(opts); }
  /** Drop the cached reference graph (call after external mutations). */
  invalidateRefs() { return invalidateReferenceGraph(); }

  // ── Identity (STORAGE_SCHEMA §4/§10) ──────────────────────────────────────
  // Local user record + known external users. publicIdentity/account are attached
  // by the C-P0 auth flow via bindPublicIdentity()/bindAccount().

  getLocalUser() { return getLocalUser(); }
  /** @param {object} patch */
  updateLocalUser(patch) { return updateLocalUser(patch); }
  getLocalUserRef() { return getLocalUserRef(); }
  /** @param {object} identity */
  bindPublicIdentity(identity) { return bindPublicIdentity(identity); }
  /** @param {object} account */
  bindAccount(account) { return bindAccount(account); }
  listKnownExternalUsers() { return listKnownExternalUsers(); }
  /** @param {string} externalUserId */
  getExternalUser(externalUserId) { return getExternalUser(externalUserId); }
  /** @param {string} publicKey @param {object} [metadata] */
  recordExternalUserEncounter(publicKey, metadata) { return recordExternalUserEncounter(publicKey, metadata); }
  /** @param {string} externalUserId @param {string} trustLevel @param {string} [by] */
  setUserTrust(externalUserId, trustLevel, by) { return setUserTrust(externalUserId, trustLevel, by); }

  // ── Escape hatch (migrate callers incrementally) ──────────────────────────

  /** @returns {typeof StorageManager} */
  get legacy() {
    return StorageManager;
  }
}
