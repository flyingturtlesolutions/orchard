/**
 * @file Services/Sync/SyncEngine.js
 * @description Hybrid sync outbox push + poll pull (P1, DD-04 A).
 */

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../StorageManager.js';
import { getCloudSettings, setCloudSettings } from '../Cloud/CloudSettings.js';
import { isCloudSignedIn, getCloudSession } from '../Cloud/CloudTokenStore.js';
import {
  batchWriteCloudObjects,
  deleteCloudObject,
  fetchCloudObjectRaw,
  listCloudChanges,
  getIdentityMe,
  CloudClientError,
} from '../Cloud/CloudClient.js';
import {
  getCachedObject,
  getLastSyncToken,
  getOrCreateDeviceId,
  getPendingConflicts,
  listOutboxEntries,
  putCachedObject,
  removeOutboxEntries,
  setLastSyncToken,
  setPendingConflicts,
  upsertOutboxEntry,
  clearAllSyncData,
} from '../Storage/IndexedDBStore.js';
import { logicalPathForRecord, recordMetaFromPath } from '../Storage/StoragePaths.js';
import { unwrapEnvelope, wrapEnvelope, envelopeUpdatedAt } from '../Storage/StoredEnvelope.js';
import { rebuildRefs } from './RebuildRefs.js';
import {
  pickAutoResolvedEnvelope,
  resolveConflictAction,
  shouldQueueManualConflict,
} from './ConflictResolver.js';

const MAX_BATCH = 10;
let _syncInFlight = false;
let _syncQueued = false;

/** @returns {Promise<boolean>} */
export async function isHybridSyncActive() {
  const settings = await getCloudSettings();
  if (!settings.enabled) return false;
  if (settings.storageBackend !== 'hybrid') return false;
  return isCloudSignedIn();
}

/**
 * @param {string} path
 * @param {unknown} envelope
 * @param {{ expectedEtag?: string, groundId?: string, op?: 'put'|'delete' }} [opts]
 */
export async function enqueueSyncWrite(path, envelope, opts = {}) {
  if (!(await isHybridSyncActive())) return;

  const cached = await getCachedObject(path);
  const deviceId = await getOrCreateDeviceId();

  await upsertOutboxEntry({
    path,
    envelope,
    expectedEtag: opts.expectedEtag ?? cached?.etag ?? '*',
    deviceId,
    queuedAt: Date.now(),
    groundId: opts.groundId,
    op: opts.op || 'put',
  });

  scheduleSyncRun();
}

/** @type {ReturnType<typeof setTimeout>|null} */
let _debounceTimer = null;

export function scheduleSyncRun() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    runSync().catch((e) => Logger.warn('SyncEngine', e.message));
  }, 800);
}

/**
 * @param {import('../Storage/StoragePaths.js').SyncKind} kind
 * @param {Record<string, unknown>} record
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function enqueueRecordWrite(kind, record, opts = {}) {
  if (!(await isHybridSyncActive())) return;

  const path = logicalPathForRecord(kind, record);
  if (!path) return;

  const envelope = wrapEnvelope(record, String(record.id), {
    type: opts.orchardUserId ? 'external' : 'local',
    orchardUserId: opts.orchardUserId,
  });

  await enqueueSyncWrite(path, envelope, {
    groundId: typeof record.groundId === 'string' ? record.groundId : undefined,
  });

  const groundId = typeof record.groundId === 'string'
    ? record.groundId
    : (kind === 'ground' ? String(record.id) : null);
  if (groundId) {
    const manifests = await rebuildRefs(groundId, opts);
    for (const m of manifests) {
      await enqueueSyncWrite(m.path, m.envelope, { expectedEtag: '*', groundId });
    }
  }
}

/**
 * @param {string} path
 * @param {unknown} envelope
 * @param {string} etag
 */
async function applyRemoteObject(path, envelope, etag) {
  const meta = recordMetaFromPath(path);
  if (!meta) {
    await putCachedObject({ path, envelope, etag, updatedAt: Date.now() });
    return null;
  }

  const body = unwrapEnvelope(envelope);
  const { kind, id } = meta;

  switch (kind) {
    case 'ground':
      await StorageManager.saveGround(/** @type {any} */ (body));
      break;
    case 'fragment':
      await StorageManager.saveFragment(/** @type {any} */ (body));
      break;
    case 'observation':
      await StorageManager.saveObservation(/** @type {any} */ (body));
      break;
    case 'analysis':
      await StorageManager.saveAnalysis(/** @type {any} */ (body));
      break;
    case 'assertion':
      await StorageManager.saveAssertion(/** @type {any} */ (body));
      break;
    case 'perspective':
      await StorageManager.savePerspective(/** @type {any} */ (body));
      break;
    case 'landmark':
      await StorageManager.saveLandmark(/** @type {any} */ (body));
      break;
    case 'strategy':
      await StorageManager.saveStrategy(/** @type {any} */ (body));
      break;
    case 'workflow':
      await StorageManager.saveWorkflow(/** @type {any} */ (body));
      break;
    default:
      break;
  }

  await putCachedObject({
    path,
    envelope,
    etag,
    updatedAt: envelopeUpdatedAt(envelope) || Date.now(),
  });

  return { kind, id };
}

/**
 * @param {import('../Storage/StoragePaths.js').SyncKind} kind
 * @param {string} id
 */
async function localRecordExists(kind, id) {
  switch (kind) {
    case 'ground': return !!(await StorageManager.getGround(id));
    case 'fragment': return !!(await StorageManager.getFragment(id));
    case 'observation': return !!(await StorageManager.getObservation(id));
    case 'analysis': return !!(await StorageManager.getAnalysis(id));
    case 'assertion': return !!(await StorageManager.getAssertion(id));
    case 'perspective': return !!(await StorageManager.getPerspective(id));
    case 'landmark': return !!(await StorageManager.getLandmark(id));
    case 'strategy': return !!(await StorageManager.getStrategy(id));
    case 'workflow': return !!(await StorageManager.getWorkflow(id));
    default: return false;
  }
}

/** Clear sync cache/outbox on sign-out so the next account can seed cleanly. */
export async function resetSyncBootstrap() {
  await clearAllSyncData();
}

/**
 * @param {Record<string, unknown>} record
 * @param {import('../Storage/IndexedDBStore.js').CachedObject|undefined} cached
 */
function isLocalRecordDirty(record, cached) {
  if (!cached?.etag) return true;
  const localAt = Number(record.updatedAt || record.createdAt || 0);
  const syncedAt = envelopeUpdatedAt(cached.envelope);
  return localAt > syncedAt;
}

/**
 * Scan local workspace and enqueue records not yet synced (or locally newer than cache).
 * Runs on every sync so saves that happened before hybrid was active still upload.
 * @returns {Promise<number>} records enqueued
 */
async function bootstrapLocalWorkspace() {
  if (!(await isHybridSyncActive())) return 0;

  const session = await getCloudSession();
  const opts = { orchardUserId: session?.orchardUserId };
  let enqueued = 0;

  /** @param {import('../Storage/StoragePaths.js').SyncKind} kind @param {Record<string, unknown>} record */
  async function maybeEnqueue(kind, record) {
    const path = logicalPathForRecord(kind, record);
    if (!path) return;
    const cached = await getCachedObject(path);
    if (!isLocalRecordDirty(record, cached)) return;
    await enqueueRecordWrite(kind, record, opts);
    enqueued += 1;
  }

  const grounds = await StorageManager.getAllGrounds();
  for (const ground of grounds) {
    await maybeEnqueue('ground', /** @type {Record<string, unknown>} */ (ground));

    const [fragments, observations, analyses, assertions, perspectives, landmarks, strategies] =
      await Promise.all([
        StorageManager.listFragments(ground.id),
        StorageManager.listObservations(ground.id),
        StorageManager.listAnalyses(ground.id),
        StorageManager.listAssertions(ground.id),
        StorageManager.listPerspectives(ground.id),
        StorageManager.listLandmarksForGround(ground.id),
        StorageManager.listStrategies(ground.id),
      ]);

    for (const r of fragments) await maybeEnqueue('fragment', r);
    for (const r of observations) await maybeEnqueue('observation', r);
    for (const r of analyses) await maybeEnqueue('analysis', r);
    for (const r of assertions) await maybeEnqueue('assertion', r);
    for (const r of perspectives) await maybeEnqueue('perspective', r);
    for (const r of landmarks) await maybeEnqueue('landmark', r);
    for (const r of strategies) await maybeEnqueue('strategy', r);
  }

  for (const wf of await StorageManager.listWorkflows()) {
    await maybeEnqueue('workflow', wf);
  }

  if (enqueued > 0) {
    Logger.info('SyncEngine', `bootstrap enqueued ${enqueued} local record(s)`);
  }
  return enqueued;
}

async function pushOutbox() {
  const entries = await listOutboxEntries();
  if (entries.length === 0) return { pushed: 0 };

  const putEntries = entries.filter((e) => e.op !== 'delete');
  const deleteEntries = entries.filter((e) => e.op === 'delete');

  let pushed = 0;

  for (let i = 0; i < putEntries.length; i += MAX_BATCH) {
    const chunk = putEntries.slice(i, i + MAX_BATCH);
    const items = chunk.map((e) => ({
      path: e.path,
      envelope: e.envelope,
      expectedEtag: e.expectedEtag || '*',
    }));

    try {
      const res = await batchWriteCloudObjects({ items });
      for (const entry of chunk) {
        const etag = res.etags?.[entry.path];
        if (etag) {
          await putCachedObject({
            path: entry.path,
            envelope: entry.envelope,
            etag,
            updatedAt: envelopeUpdatedAt(entry.envelope) || Date.now(),
          });
        }
      }
      await removeOutboxEntries(chunk.map((e) => e.path));
      pushed += chunk.length;
    } catch (e) {
      if (e instanceof CloudClientError && e.status === 409 && e.body && typeof e.body === 'object') {
        await handleConflict(/** @type {any} */ (e.body));
      } else {
        throw e;
      }
    }
  }

  for (const entry of deleteEntries) {
    try {
      await deleteCloudObject(entry.path);
      await removeOutboxEntries([entry.path]);
      pushed += 1;
    } catch (err) {
      Logger.warn('SyncEngine', `delete failed ${entry.path}: ${err.message}`);
    }
  }

  return { pushed };
}

/**
 * @param {any} conflict
 */
async function handleConflict(conflict) {
  const action = resolveConflictAction(conflict);

  if (action === 'auto-lww') {
    const envelope = pickAutoResolvedEnvelope(conflict);
    if (envelope) {
      await enqueueSyncWrite(conflict.path, envelope, { expectedEtag: '*' });
      scheduleSyncRun();
    }
    return;
  }

  if (action === 'keep-theirs') {
    const server = conflict.server;
    if (server) {
      await applyRemoteObject(conflict.path, server, '*');
    }
    await removeOutboxEntries([conflict.path]);
    return;
  }

  if (shouldQueueManualConflict(conflict)) {
    const pending = await getPendingConflicts();
    pending.push({ path: conflict.path, conflict });
    await setPendingConflicts(pending);
    Logger.warn('SyncEngine', `Manual conflict queued: ${conflict.path}`);
  }
}

async function pullChanges() {
  const since = await getLastSyncToken();
  const feed = await listCloudChanges(since || undefined);
  const changes = feed.changes || [];
  const session = await getCloudSession();
  if (changes.length === 0) {
    Logger.info('SyncEngine', `pull: 0 changes (orchardUserId=${session?.orchardUserId || 'none'}, since=${since || 'start'})`);
    if (feed.nextToken) await setLastSyncToken(feed.nextToken);
    return { pulled: 0, applied: [], remoteChangeCount: 0 };
  }

  const applied = [];
  let skippedCached = 0;
  for (const change of changes) {
    if (!change.path || change.path.endsWith('/_manifest.json')) continue;

    const cached = await getCachedObject(change.path);
    if (cached?.etag && change.etag && cached.etag === change.etag) {
      const meta = recordMetaFromPath(change.path);
      if (meta && await localRecordExists(meta.kind, meta.id)) {
        skippedCached += 1;
        continue;
      }
    }

    const { envelope, etag } = await fetchCloudObjectRaw(change.path);
    const result = await applyRemoteObject(change.path, envelope, etag || change.etag || '');
    if (result) applied.push(result);
  }

  if (feed.nextToken) await setLastSyncToken(feed.nextToken);

  const groundIds = [...new Set(changes.map((c) => c.groundId).filter(Boolean))];
  if (groundIds.length) {
    await rebuildRefs(groundIds, { orchardUserId: session?.orchardUserId });
  }

  Logger.info('SyncEngine', `pull: ${applied.length} applied, ${changes.length} remote, ${skippedCached} skipped (cached)`);
  return { pulled: applied.length, applied, remoteChangeCount: changes.length };
}

/**
 * @returns {Promise<{ ok: boolean, pushed?: number, pulled?: number, applied?: Array<{kind:string,id:string}>, error?: string }>}
 */
export async function runSync() {
  const settings = await getCloudSettings();
  if (!settings.enabled) {
    return { ok: false, error: 'cloud_disabled' };
  }
  if (!(await isCloudSignedIn())) {
    return { ok: false, error: 'not_signed_in' };
  }
  if (settings.storageBackend !== 'hybrid') {
    await enableHybridSync();
  }

  if (_syncInFlight) {
    _syncQueued = true;
    return { ok: false, error: 'sync_already_running' };
  }

  _syncInFlight = true;
  try {
    const bootstrapped = await bootstrapLocalWorkspace();
    const pushResult = await pushOutbox();
    const pullResult = await pullChanges();
    const outboxPending = (await listOutboxEntries()).length;
    Logger.info('SyncEngine', `sync complete pushed=${pushResult.pushed} pulled=${pullResult.pulled} bootstrapped=${bootstrapped} outbox=${outboxPending}`);
    return {
      ok: true,
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      bootstrapped,
      outboxPending,
      remoteChangeCount: pullResult.remoteChangeCount ?? 0,
      applied: pullResult.applied,
    };
  } catch (e) {
    let msg = e.message;
    if (e instanceof CloudClientError) {
      if (e.status === 404) {
        msg = 'Sync API not found — deploy P1 CDK stack (infra/orchard-dev) and reload';
      } else if (e.status === 403) {
        msg = 'Cloud identity not bound — sign out and sign in again';
      }
    }
    Logger.warn('SyncEngine', `sync failed: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    _syncInFlight = false;
    if (_syncQueued) {
      _syncQueued = false;
      scheduleSyncRun();
    }
  }
}

/** @returns {Promise<Array<{ path: string, conflict: unknown }>>} */
export async function getSyncConflicts() {
  return getPendingConflicts();
}

/**
 * @param {string} path
 * @param {'keep-mine'|'keep-theirs'} resolution
 */
export async function resolveSyncConflict(path, resolution) {
  const pending = await getPendingConflicts();
  const row = pending.find((p) => p.path === path);
  if (!row) return { ok: false, error: 'conflict_not_found' };

  const conflict = /** @type {any} */ (row.conflict);
  if (resolution === 'keep-mine' && conflict.client) {
    await enqueueSyncWrite(path, conflict.client, { expectedEtag: '*' });
  } else if (resolution === 'keep-theirs' && conflict.server) {
    await applyRemoteObject(path, conflict.server, '*');
  }

  await setPendingConflicts(pending.filter((p) => p.path !== path));
  scheduleSyncRun();
  return { ok: true };
}

export async function enableHybridSync() {
  const settings = await getCloudSettings();
  if (!settings.enabled) return;
  if (settings.storageBackend === 'hybrid') return;
  await setCloudSettings({ storageBackend: 'hybrid' });
  scheduleSyncRun();
}

/** Revert to local-only storage when cloud is disabled. */
export async function disableHybridSync() {
  const settings = await getCloudSettings();
  if (settings.storageBackend === 'local') return;
  await setCloudSettings({ storageBackend: 'local' });
}

/** @returns {Promise<{ ready: boolean, error?: string }>} */
export async function ensureHybridSyncReady() {
  const settings = await getCloudSettings();
  if (!settings.enabled) {
    return { ready: false, error: 'Enable Orchard Cloud in settings first' };
  }
  if (!(await isCloudSignedIn())) {
    return { ready: false, error: 'Sign in to Orchard Cloud first' };
  }
  if (settings.storageBackend !== 'hybrid') {
    await enableHybridSync();
  }
  try {
    const me = await getIdentityMe();
    if (me && me.bound === false) {
      return { ready: false, error: 'Identity not bound — sign out and sign in again' };
    }
  } catch (e) {
    if (e instanceof CloudClientError && e.status === 403) {
      return { ready: false, error: 'Identity not bound — sign out and sign in again' };
    }
  }
  return { ready: true };
}
