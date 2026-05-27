/**
 * @file Services/Storage/StoragePort.js
 * @description Storage abstraction seam (Orchard §17 M0–M1). Callers should
 * prefer `getStoragePort()` over direct `StorageManager` access so hybrid /
 * IndexedDB adapters can replace the legacy chrome.storage backend in P1.
 *
 * @see ../../schemas/orchard/STORAGE_SCHEMA_REVISED.md
 * @see ../../schemas/orchard/AWS_INTEGRATION.md §17.8
 */

/** @typedef {'local'|'hybrid'|'cloud-primary'} StorageBackend */

/** @typedef {'chrome-storage'|'indexeddb'|'hybrid'} StorageAdapterKind */

/**
 * @typedef {Object} StoragePortMeta
 * @property {StorageBackend} storageBackend
 * @property {StorageAdapterKind} adapterKind
 */

let _port = null;

/**
 * Returns the active storage port singleton (ChromeStorageAdapter in P0/P1 M1).
 * @returns {import('./ChromeStorageAdapter.js').ChromeStorageAdapter}
 */
export function getStoragePort() {
  if (!_port) {
    throw new Error('StoragePort not initialized — call initStoragePort() from background startup');
  }
  return _port;
}

/**
 * @param {import('./ChromeStorageAdapter.js').ChromeStorageAdapter} adapter
 */
export function initStoragePort(adapter) {
  _port = adapter;
}

/**
 * @returns {StoragePortMeta}
 */
export function getStoragePortMeta() {
  const port = getStoragePort();
  return {
    storageBackend: port.storageBackend,
    adapterKind: port.adapterKind,
  };
}
