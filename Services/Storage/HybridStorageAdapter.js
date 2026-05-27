/**
 * @file Services/Storage/HybridStorageAdapter.js
 * @description P1 M3 — chrome.storage primary + workspace partition + cloud sync.
 */

import { IndexedDBAdapter } from './IndexedDBAdapter.js';

/** @typedef {import('./StoragePort.js').StorageAdapterKind} StorageAdapterKind */

export class HybridStorageAdapter extends IndexedDBAdapter {
  /** @type {StorageAdapterKind} */
  adapterKind = 'hybrid';

  constructor() {
    super('hybrid');
  }
}
