/**
 * @file Services/Storage/ChromeStorageAdapter.js
 * @description P0/P1 M1 adapter — delegates to legacy StorageManager with zero
 * behaviour change. Implements the StoragePort surface used by new cloud code;
 * expand delegation as callers migrate off direct StorageManager imports.
 */

import { StorageManager } from '../StorageManager.js';

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

  // ── Escape hatch (migrate callers incrementally) ──────────────────────────

  /** @returns {typeof StorageManager} */
  get legacy() {
    return StorageManager;
  }
}
