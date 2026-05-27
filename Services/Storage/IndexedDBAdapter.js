/**
 * @file Services/Storage/IndexedDBAdapter.js
 * @description P1 M2 adapter — partition read path + chrome.storage write primary.
 */

import { ChromeStorageAdapter } from './ChromeStorageAdapter.js';
import { maybeReadPartition, maybeListPartition } from './PartitionRead.js';

/** @typedef {import('./StoragePort.js').StorageAdapterKind} StorageAdapterKind */

export class IndexedDBAdapter extends ChromeStorageAdapter {
  /** @type {StorageAdapterKind} */
  adapterKind = 'indexeddb';

  /** @param {import('./StoragePort.js').StorageBackend} [backend] */
  constructor(backend = 'local') {
    super(backend);
  }

  saveGround(ground) { return super.saveGround(ground); }
  getGround(groundId) {
    return maybeReadPartition('ground', groundId).then((p) => p || super.getGround(groundId));
  }

  saveFragment(fragment) { return super.saveFragment(fragment); }
  getFragment(fragmentId) {
    return maybeReadPartition('fragment', fragmentId).then((p) => p || super.getFragment(fragmentId));
  }
  listFragments(groundId) {
    return maybeListPartition('fragment', groundId).then((p) => (
      p !== null ? p : super.listFragments(groundId)
    ));
  }

  savePerspective(perspective) { return super.savePerspective(perspective); }
  getPerspective(perspectiveId) {
    return maybeReadPartition('perspective', perspectiveId).then((p) => p || super.getPerspective(perspectiveId));
  }
  listPerspectives(groundId) {
    return maybeListPartition('perspective', groundId).then((p) => (
      p !== null ? p : super.listPerspectives(groundId)
    ));
  }

  saveLandmark(landmark) { return super.saveLandmark(landmark); }
  getLandmark(uid) {
    return maybeReadPartition('landmark', uid).then((p) => p || super.getLandmark(uid));
  }
  listLandmarksForGround(groundId) {
    return maybeListPartition('landmark', groundId).then((p) => (
      p !== null ? p : super.listLandmarksForGround(groundId)
    ));
  }
}
