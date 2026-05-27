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

// ── §10 operation surface (the locked target contract) ───────────────────────────────
// This typedef is the single source of truth for the operations runtime/authoring code may use
// against the storage seam, mirroring STORAGE_SCHEMA §10. Concrete adapters implement a GROWING
// SUBSET — the phase tag on each group marks when it lands. Until then the method may be absent;
// callers gate on capability, not presence-by-assumption. Keeping the full surface here (rather
// than scattered across adapter classes) lets a reviewer diff the contract against §10 directly.

/**
 * @typedef {Object} DeleteOptions
 * @property {boolean} [confirmCascade]   required when inboundRefs.length > 0
 * @property {boolean} [hard]             default false → prefer deprecatePrimitive (soft delete)
 */

/**
 * @typedef {Object} ImpactReport
 * @property {string} primitiveId
 * @property {unknown[]} inboundRefs
 * @property {string[]} [cascadeTargets]   auto-delete set when confirmCascade
 * @property {string[]} [blockers]         active execution / publication primary / canonical import
 */

/**
 * @typedef {Object} ListScope
 * @property {string} [groundId]
 * @property {string} [primitiveType]
 * @property {'draft'|'active'|'deprecated'|'retired'} [lifecycle]
 */

/**
 * The full §10 surface. Operations are grouped by phase availability:
 *   • [S1] primitive CRUD + manifest          — local IndexedDB partition remodel
 *   • [S2] reference graph + transaction()     — refs/ + transactional integrity
 *   • [S3] identity                            — identity/ partition
 *   • [C-P2] publications                      — shared workspaces / registry
 *   • [C-P3] training + privacy                — managed proxy + training pipeline
 *   • [—] events                               — outcome/event stream (Core/outcomes seam)
 *
 * @typedef {Object} StoragePortContract
 *
 * // Primitive — read [S1]
 * @property {(primitiveId: string, options?: object) => Promise<unknown>} getPrimitive
 * @property {(scope: ListScope) => Promise<unknown[]>} listPrimitives
 * @property {(query: object) => Promise<unknown[]>} findPrimitivesBy
 * @property {(groundId: string) => Promise<unknown>} getGroundManifest   // rebuild if _manifest.json missing
 *
 * // Primitive — write [S1]
 * @property {(primitive: unknown, options?: object) => Promise<void>} savePrimitive   // create or update
 * @property {(primitiveId: string, options?: DeleteOptions) => Promise<void>} deletePrimitive  // hard; see ImpactReport
 * @property {(primitiveId: string) => Promise<void>} deprecatePrimitive   // soft delete (default path)
 * @property {(primitiveId: string) => Promise<void>} restorePrimitive     // un-deprecate
 *
 * // References [S2] — workspace-derived graph (ReferenceStore); not synced (DD-06)
 * @property {(primitiveId: string, opts?: { groundId?: string }) => Promise<unknown[]>} getOutboundReferences
 * @property {(primitiveId: string, opts?: { groundId?: string }) => Promise<unknown[]>} getInboundReferences
 * @property {(primitiveId: string, opts?: object) => Promise<ImpactReport>} analyzeDeletionImpact
 * @property {(opts?: { groundId?: string }) => Promise<string[][]>} detectCycles
 * @property {(opts?: { groundId?: string }) => Promise<string[]>} findOrphans
 * @property {(scope?: { groundId?: string, fresh?: boolean }) => Promise<unknown>} rebuildRefs   // returns the rebuilt graph
 *
 * // Transactions [S2 — pending]
 * @property {(operations: unknown[]) => Promise<void>} transaction        // atomic multi-write
 *
 * // Identity [S3] — IdentityStore (chrome.storage); publicIdentity/account attached at C-P0
 * @property {() => Promise<unknown>} getLocalUser
 * @property {(updates: object) => Promise<unknown>} updateLocalUser
 * @property {() => Promise<{ type: 'local', userId: string, publicKey?: string }>} getLocalUserRef
 * @property {(identity: { publicKey: string, publicKeyAlgorithm?: string }) => Promise<unknown>} bindPublicIdentity
 * @property {(account: { accountId: string, provider: string }) => Promise<unknown>} bindAccount
 * @property {() => Promise<unknown[]>} listKnownExternalUsers
 * @property {(externalUserId: string) => Promise<unknown>} getExternalUser
 * @property {(publicKey: string, metadata?: object) => Promise<unknown>} recordExternalUserEncounter
 * @property {(externalUserId: string, trustLevel: string, by?: string) => Promise<unknown>} setUserTrust
 */

let _port = null;

/**
 * Returns the active storage port singleton (ChromeStorageAdapter in P0/P1 M1).
 * @returns {import('./ChromeStorageAdapter.js').ChromeStorageAdapter|import('./IndexedDBAdapter.js').IndexedDBAdapter}
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
