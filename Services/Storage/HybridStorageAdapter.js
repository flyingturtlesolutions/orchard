/**
 * @file Services/Storage/HybridStorageAdapter.js
 * @description P1 M3 — local chrome.storage + cloud sync outbox.
 */

import { ChromeStorageAdapter } from './ChromeStorageAdapter.js';

/** @typedef {import('./StoragePort.js').StorageAdapterKind} StorageAdapterKind */

export class HybridStorageAdapter extends ChromeStorageAdapter {
  /** @type {StorageAdapterKind} */
  adapterKind = 'hybrid';

  constructor() {
    super('hybrid');
  }
}
