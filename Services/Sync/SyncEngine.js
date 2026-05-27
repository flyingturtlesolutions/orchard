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
  getMeta,
  setMeta,
} from '../Storage/IndexedDBStore.js';
import { logicalPathForRecord, recordMetaFromPath } from '../Storage/StoragePaths.js';
import { unwrapEnvelope, wrapEnvelope } from '../Storage/StoredEnvelope.js';
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
    updatedAt: Date.now(),
  });

  return { kind, id };
}

/** Clear bootstrap flag on sign-out so the next account can seed. */
export async function resetSyncBootstrap() {
  await setMeta('localWorkspaceSeeded', false);
}

/**
 * One-time scan: enqueue all local workspace records not yet in the cloud cache.
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
    if (cached?.etag) return;
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
  await setMeta('localWorkspaceSeeded', true);
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
            updatedAt: Date.now(),
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
  if (changes.length === 0) {
    if (feed.nextToken) await setLastSyncToken(feed.nextToken);
    return { pulled: 0, applied: [] };
  }

  const applied = [];
  for (const change of changes) {
    if (!change.path || change.path.endsWith('/_manifest.json')) continue;

    const cached = await getCachedObject(change.path);
    if (cached?.etag && change.etag && cached.etag === change.etag) continue;

    const { envelope, etag } = await fetchCloudObjectRaw(change.path);
    const result = await applyRemoteObject(change.path, envelope, etag || change.etag || '');
    if (result) applied.push(result);
  }

  if (feed.nextToken) await setLastSyncToken(feed.nextToken);

  const groundIds = [...new Set(changes.map((c) => c.groundId).filter(Boolean))];
  if (groundIds.length) {
    const session = await getCloudSession();
    await rebuildRefs(groundIds, { orchardUserId: session?.orchardUserId });
  }

  return { pulled: applied.length, applied };
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
    return { ok: true, error: 'sync_already_running' };
  }

  _syncInFlight = true;
  try {
    let bootstrapped = 0;
    if (!(await getMeta('localWorkspaceSeeded'))) {
      bootstrapped = await bootstrapLocalWorkspace();
    }
    const pushResult = await pushOutbox();
    const pullResult = await pullChanges();
    Logger.info('SyncEngine', `sync complete pushed=${pushResult.pushed} pulled=${pullResult.pulled} bootstrapped=${bootstrapped}`);
    return {
      ok: true,
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      bootstrapped,
      applied: pullResult.applied,
    };
  } catch (e) {
    const msg = e instanceof CloudClientError && e.status === 404
      ? 'Sync API not found — deploy P1 CDK stack (infra/orchard-dev) and reload'
      : e.message;
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
  if (settings.storageBackend === 'hybrid') return;
  await setCloudSettings({ storageBackend: 'hybrid' });
  scheduleSyncRun();
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
  return { ready: true };
}
