/**
 * @file Services/Storage/IndexedDBStore.js
 * @description IndexedDB cache, outbox, and sync metadata (P1 M2).
 */

const DB_NAME = 'orchard-storage';
const DB_VERSION = 3;

/** @returns {Promise<IDBDatabase>} */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = req.transaction;
      if (!db.objectStoreNames.contains('objects')) {
        db.createObjectStore('objects', { keyPath: 'path' });
      }
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'path' });
        outbox.createIndex('queuedAt', 'queuedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('workspace')) {
        const workspace = db.createObjectStore('workspace', { keyPath: 'path' });
        workspace.createIndex('groundId', 'groundId', { unique: false });
        workspace.createIndex('lookupKey', 'lookupKey', { unique: true });
      } else if (event.oldVersion < 3 && tx) {
        const workspace = tx.objectStore('workspace');
        if (!workspace.indexNames.contains('lookupKey')) {
          workspace.createIndex('lookupKey', 'lookupKey', { unique: true });
        }
      }
    };
  });
}

/**
 * @param {string} store
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest<unknown>} fn
 */
function idbRequest(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    const req = fn(os);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  }));
}

/**
 * @typedef {Object} CachedObject
 * @property {string} path
 * @property {unknown} envelope
 * @property {string} [etag]
 * @property {number} [updatedAt]
 */

/** @param {CachedObject} obj */
export async function putCachedObject(obj) {
  await idbRequest('objects', 'readwrite', (os) => os.put(obj));
}

/** @param {string} path */
export async function getCachedObject(path) {
  return /** @type {Promise<CachedObject|undefined>} */ (
    idbRequest('objects', 'readonly', (os) => os.get(path))
  );
}

/** @returns {Promise<string[]>} */
export async function listCachedObjectPaths() {
  return /** @type {Promise<string[]>} */ (
    idbRequest('objects', 'readonly', (os) => os.getAllKeys())
  );
}

/** @param {string} path */
export async function removeCachedObject(path) {
  await idbRequest('objects', 'readwrite', (os) => os.delete(path));
}

/**
 * @typedef {Object} OutboxEntry
 * @property {string} path
 * @property {unknown} envelope
 * @property {string} expectedEtag
 * @property {string} deviceId
 * @property {number} queuedAt
 * @property {string} [groundId]
 * @property {'put'|'delete'} [op]
 */

/** @param {OutboxEntry} entry */
export async function upsertOutboxEntry(entry) {
  await idbRequest('outbox', 'readwrite', (os) => os.put(entry));
}

/** @returns {Promise<OutboxEntry[]>} */
export async function listOutboxEntries() {
  return /** @type {Promise<OutboxEntry[]>} */ (
    idbRequest('outbox', 'readonly', (os) => os.getAll())
  );
}

/** @param {string[]} paths */
export async function removeOutboxEntries(paths) {
  if (paths.length === 0) return;
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('outbox', 'readwrite');
    const os = tx.objectStore('outbox');
    for (const p of paths) os.delete(p);
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {string} key @param {unknown} value */
export async function setMeta(key, value) {
  await idbRequest('meta', 'readwrite', (os) => os.put({ key, value }));
}

/** @param {string} key */
export async function getMeta(key) {
  const row = await idbRequest('meta', 'readonly', (os) => os.get(key));
  return row?.value;
}

/** @returns {Promise<string>} */
export async function getOrCreateDeviceId() {
  const existing = await getMeta('deviceId');
  if (typeof existing === 'string' && existing) return existing;
  const id = `dev_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await setMeta('deviceId', id);
  return id;
}

/** @returns {Promise<string>} */
export async function getLastSyncToken() {
  const token = await getMeta('lastSyncToken');
  return typeof token === 'string' ? token : '';
}

/** @param {string} token */
export async function setLastSyncToken(token) {
  await setMeta('lastSyncToken', token);
  await setMeta('lastSyncAt', Date.now());
}

/** @returns {Promise<number>} */
export async function getLastSyncAt() {
  const at = await getMeta('lastSyncAt');
  return typeof at === 'number' ? at : 0;
}

/** @param {Record<string, unknown>} result */
export async function setLastSyncResult(result) {
  await setMeta('lastSyncResult', result);
}

/** @returns {Promise<Record<string, unknown>|null>} */
export async function getLastSyncResult() {
  const row = await getMeta('lastSyncResult');
  return row && typeof row === 'object' ? /** @type {Record<string, unknown>} */ (row) : null;
}

/** @returns {Promise<number>} */
export async function getOutboxCount() {
  return (await listOutboxEntries()).length;
}

/** @returns {Promise<Array<{ path: string, conflict: unknown }>>} */
export async function getPendingConflicts() {
  try {
    const rows = await getMeta('pendingConflicts');
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** @param {Array<{ path: string, conflict: unknown }>} rows */
export async function setPendingConflicts(rows) {
  await setMeta('pendingConflicts', rows);
}

export async function clearAllSyncData() {
  const db = await openDb();
  await Promise.all(['objects', 'outbox', 'meta', 'workspace'].map((store) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve(undefined);
    tx.onerror = () => reject(tx.error);
  })));
}

/**
 * @typedef {Object} WorkspaceRecord
 * @property {string} path
 * @property {string} groundId
 * @property {string} kind
 * @property {string} recordId
 * @property {string} lookupKey
 * @property {unknown} envelope
 * @property {number} updatedAt
 */

/** @param {WorkspaceRecord} row */
export async function putWorkspaceRecord(row) {
  await idbRequest('workspace', 'readwrite', (os) => os.put(row));
}

/** @param {string} path */
export async function getWorkspaceRecord(path) {
  return /** @type {Promise<WorkspaceRecord|undefined>} */ (
    idbRequest('workspace', 'readonly', (os) => os.get(path))
  );
}

/** @param {string} path */
export async function removeWorkspaceRecord(path) {
  await idbRequest('workspace', 'readwrite', (os) => os.delete(path));
}

/** @param {string} lookupKey */
export async function getWorkspaceByLookup(lookupKey) {
  return /** @type {Promise<WorkspaceRecord|undefined>} */ (
    idbRequest('workspace', 'readonly', (os) => os.index('lookupKey').get(lookupKey))
  );
}

/** @param {string} groundId */
export async function hasWorkspaceRecordsForGround(groundId) {
  const rows = await listWorkspaceRecordsForGround(groundId);
  return rows.length > 0;
}

/** @param {string} groundId */
export async function listWorkspaceRecordsForGround(groundId) {
  return /** @type {Promise<WorkspaceRecord[]>} */ (
    idbRequest('workspace', 'readonly', (os) => {
      const idx = os.index('groundId');
      return idx.getAll(groundId);
    })
  );
}

/** @returns {Promise<number>} */
export async function countWorkspaceRecords() {
  return /** @type {Promise<number>} */ (
    idbRequest('workspace', 'readonly', (os) => os.count())
  );
}
