/**
 * @file Services/Sync/SyncEngine.js
 * @description Hybrid sync outbox push + poll pull (P1, DD-04 A).
 */

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../StorageManager.js';
import { getCloudSettings, setCloudSettings } from '../Cloud/CloudSettings.js';
import { isCloudSignedIn, getStoredSession } from '../Cloud/CloudTokenStore.js';
import {
  batchWriteCloudObjects,
  deleteCloudObject,
  fetchCloudObjectRaw,
  listCloudChanges,
  getIdentityMe,
  putCloudObjectAuto,
  objectBodyBytes,
  INLINE_OBJECT_MAX_BYTES,
  CloudClientError,
} from '../Cloud/CloudClient.js';
import {
  getCachedObject,
  getLastSyncToken,
  getOrCreateDeviceId,
  getPendingConflicts,
  listOutboxEntries,
  putCachedObject,
  removeCachedObject,
  listCachedObjectPaths,
  removeOutboxEntries,
  removeOutboxEntryIfUnchanged,
  setLastSyncToken,
  setPendingConflicts,
  setLastSyncResult,
  upsertOutboxEntry,
  clearAllSyncData,
  putTombstone,
  getTombstone,
  listTombstones,
  removeTombstone,
} from '../Storage/IndexedDBStore.js';
import { logicalPathForRecord, recordMetaFromPath } from '../Storage/StoragePaths.js';
import * as GroundAssetStore from '../Storage/GroundAssetStore.js';
import {
  mirrorToWorkspacePartition,
  mirrorEnvelopeToWorkspacePartition,
  removeFromWorkspacePartition,
  isWorkspacePartitionKind,
} from '../Storage/WorkspacePartitionStore.js';
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
 * @param {{ expectedEtag?: string, groundId?: string, op?: 'put'|'delete', deferSchedule?: boolean }} [opts]
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

  if (!opts.deferSchedule) scheduleSyncRun();
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
 * @param {{ orchardUserId?: string, deferSchedule?: boolean }} [opts]
 */
/**
 * Drop sync cache for a record and enqueue a fresh upload (fixes ghost cloud index / missing S3).
 * @param {import('../Storage/StoragePaths.js').SyncKind} kind
 * @param {Record<string, unknown>} record
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function forceResyncRecord(kind, record, opts = {}) {
  if (!(await isHybridSyncActive())) return;
  const path = logicalPathForRecord(kind, record);
  if (path) await removeCachedObject(path);
  await enqueueRecordWrite(kind, record, opts);
  scheduleSyncRun();
}

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
    deferSchedule: opts.deferSchedule,
  });

  const groundId = typeof record.groundId === 'string'
    ? record.groundId
    : (kind === 'ground' ? String(record.id) : null);
  if (groundId) {
    const manifests = await rebuildRefs(groundId, opts);
    for (const m of manifests) {
      await enqueueSyncWrite(m.path, m.envelope, {
        expectedEtag: '*',
        groundId,
        deferSchedule: opts.deferSchedule,
      });
    }
  }
}

/**
 * @param {import('../Storage/StoragePaths.js').SyncKind} kind
 * @param {Record<string, unknown>} record
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function enqueueRecordDelete(kind, record, opts = {}) {
  if (!(await isHybridSyncActive())) return;

  const path = logicalPathForRecord(kind, record);
  if (!path) return;

  await putTombstone(path, Date.now());   // record the delete so a stale concurrent edit can't resurrect it
  const cached = await getCachedObject(path);
  await enqueueSyncWrite(path, cached?.envelope ?? null, {
    op: 'delete',
    expectedEtag: cached?.etag ?? '*',
    groundId: typeof record.groundId === 'string'
      ? record.groundId
      : (kind === 'ground' ? String(record.id) : undefined),
  });

}

/**
 * Rebuild and enqueue ground manifest after a local delete (call after StorageManager delete).
 * @param {string} groundId
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function enqueueGroundManifestSync(groundId, opts = {}) {
  if (!(await isHybridSyncActive()) || !groundId) return;

  const manifests = await rebuildRefs(groundId, opts);
  for (const m of manifests) {
    await enqueueSyncWrite(m.path, m.envelope, { expectedEtag: '*', groundId });
  }
}

/**
 * @param {string} groundId
 * @param {{ orchardUserId?: string }} [opts]
 */
export async function enqueueGroundTreeDelete(groundId, opts = {}) {
  if (!(await isHybridSyncActive()) || !groundId) return;

  const prefix = `workspace/grounds/${groundId}/`;
  const paths = new Set(await listCachedObjectPaths());
  paths.add(`${prefix}ground.json`);

  for (const path of paths) {
    if (path.startsWith(prefix)) {
      const cached = await getCachedObject(path);
      await enqueueSyncWrite(path, cached?.envelope ?? null, {
        op: 'delete',
        expectedEtag: cached?.etag ?? '*',
        groundId,
      });
    }
  }
}

/**
 * @param {string} path
 * @param {string} etag
 */
async function applyRemoteDelete(path) {
  const meta = recordMetaFromPath(path);
  if (!meta) {
    await removeCachedObject(path);
    return null;
  }

  const { kind, id } = meta;
  if (await localRecordExists(kind, id)) {
    switch (kind) {
      case 'ground':
        await StorageManager.deleteGround(id);
        break;
      case 'fragment':
        await StorageManager.deleteFragment(id);
        break;
      case 'observation':
        await StorageManager.deleteObservation(id);
        break;
      case 'analysis':
        await StorageManager.deleteAnalysis(id);
        break;
      case 'assertion':
        await StorageManager.deleteAssertion(id);
        break;
      case 'perspective':
        await StorageManager.deletePerspective(id);
        break;
      case 'landmark':
        await StorageManager.deleteLandmark(id);
        break;
      case 'strategy':
        await StorageManager.deleteStrategy(id);
        break;
      case 'workflow':
        await StorageManager.deleteWorkflow(id);
        break;
      case 'locale':
        if (meta.groundId) await GroundAssetStore.deleteLocale(meta.groundId, id);
        break;
      case 'siteMap':
        await GroundAssetStore.deleteSiteMap(id);
        break;
      case 'chrome':
        await GroundAssetStore.deleteChrome(id);
        break;
      default:
        break;
    }
  }

  await putTombstone(path, Date.now());   // tombstone the remote delete locally (bootstrap won't resurrect it)
  await removeCachedObject(path);
  if (meta && isWorkspacePartitionKind(meta.kind)) {
    await removeFromWorkspacePartition(meta.kind, {
      id: meta.id,
      groundId: meta.groundId,
      ...(meta.kind === 'locale' ? { localeKey: meta.id } : {}),
    });
  }
  return { kind, id, groundId: meta.groundId, deleted: true };
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

  // fromRemote: preserve the pulled record's updatedAt (don't bump to now) so bootstrap's
  // isLocalRecordDirty doesn't see it as locally-newer and re-push it (the pull→push ping-pong).
  const fromRemote = { fromRemote: true };
  switch (kind) {
    case 'ground':
      await StorageManager.saveGround(/** @type {any} */ (body));   // preserves updatedAt already
      break;
    case 'fragment':
      await StorageManager.saveFragment(/** @type {any} */ (body), fromRemote);
      break;
    case 'observation':
      await StorageManager.saveObservation(/** @type {any} */ (body), fromRemote);
      break;
    case 'analysis':
      await StorageManager.saveAnalysis(/** @type {any} */ (body), fromRemote);
      break;
    case 'assertion':
      await StorageManager.saveAssertion(/** @type {any} */ (body), fromRemote);
      break;
    case 'perspective':
      await StorageManager.savePerspective(/** @type {any} */ (body), fromRemote);
      break;
    case 'landmark':
      await StorageManager.saveLandmark(/** @type {any} */ (body), fromRemote);
      break;
    case 'strategy':
      await StorageManager.saveStrategy(/** @type {any} */ (body), fromRemote);
      break;
    case 'workflow':
      await StorageManager.saveWorkflow(/** @type {any} */ (body), fromRemote);
      break;
    case 'locale': {
      const rec = /** @type {any} */ (body);
      if (meta.groundId && rec?.model) {
        await GroundAssetStore.writeLocale(meta.groundId, id, {
          model: rec.model,
          url: rec.url,
          capturedAt: rec.capturedAt,
        });
      }
      break;
    }
    case 'siteMap': {
      const rec = { ...(/** @type {Record<string, unknown>} */ (body)) };
      const syncedAt = envelopeUpdatedAt(envelope);
      delete rec.id;
      delete rec.groundId;
      if (syncedAt) rec.updatedAt = syncedAt;
      await GroundAssetStore.writeSiteMap(id, rec);
      break;
    }
    case 'chrome': {
      const rec = { ...(/** @type {Record<string, unknown>} */ (body)) };
      const syncedAt = envelopeUpdatedAt(envelope);
      delete rec.id;
      delete rec.groundId;
      if (syncedAt) rec.updatedAt = syncedAt;
      await GroundAssetStore.writeChrome(id, rec);
      break;
    }
    default:
      break;
  }

  await putCachedObject({
    path,
    envelope,
    etag,
    updatedAt: envelopeUpdatedAt(envelope) || Date.now(),
  });

  if (isWorkspacePartitionKind(kind)) {
    await mirrorEnvelopeToWorkspacePartition(kind, envelope, { id, groundId: meta.groundId });
  }

  return { kind, id };
}

/**
 * @param {import('../Storage/StoragePaths.js').SyncKind} kind
 * @param {string} id
 * @param {string} [groundId]
 */
async function localRecordExists(kind, id, groundId) {
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
    case 'locale':
      return !!(groundId && (await GroundAssetStore.readLocale(groundId, id))?.model);
    case 'siteMap':
      return !!(await GroundAssetStore.readSiteMap(id));
    case 'chrome':
      return !!(await GroundAssetStore.readChrome(id));
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

  const session = await getStoredSession();
  const opts = { orchardUserId: session?.orchardUserId, deferSchedule: true };
  const outboxPaths = new Set((await listOutboxEntries()).map((e) => e.path));
  const conflictPaths = new Set((await getPendingConflicts()).map((p) => p.path));
  let enqueued = 0;

  /** @param {import('../Storage/StoragePaths.js').SyncKind} kind @param {Record<string, unknown>} record */
  async function maybeEnqueue(kind, record) {
    const path = logicalPathForRecord(kind, record);
    if (!path) return;
    if (outboxPaths.has(path) || conflictPaths.has(path)) return;
    const cached = await getCachedObject(path);
    if (!isLocalRecordDirty(record, cached)) return;
    // Don't resurrect a deleted record: if a tombstone is at-or-newer than this record's last
    // edit, the delete wins. (A genuine re-creation has updatedAt > tombstone → still enqueues.)
    const tomb = await getTombstone(path);
    if (tomb && tomb >= Number(record.updatedAt || record.createdAt || 0)) return;
    await enqueueRecordWrite(kind, record, opts);
    outboxPaths.add(path);
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

    const locales = await GroundAssetStore.listLocales(ground.id);
    for (const loc of locales) {
      await maybeEnqueue('locale', GroundAssetStore.localeSyncRecord(ground.id, loc.localeKey, loc));
    }
    const siteMap = await GroundAssetStore.readSiteMap(ground.id);
    if (siteMap) {
      await maybeEnqueue('siteMap', GroundAssetStore.siteMapSyncRecord(ground.id, siteMap));
    }
    const chrome = await GroundAssetStore.readChrome(ground.id);
    if (chrome) {
      await maybeEnqueue('chrome', GroundAssetStore.chromeSyncRecord(ground.id, chrome));
    }
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

  const conflictPaths = new Set((await getPendingConflicts()).map((p) => p.path));
  const putEntries = entries.filter((e) => e.op !== 'delete' && !conflictPaths.has(e.path));
  const deleteEntries = entries.filter((e) => e.op === 'delete');

  let pushed = 0;

  if (deleteEntries.length) {
    Logger.info('SyncEngine', `push: ${deleteEntries.length} delete(s), ${putEntries.length} put(s)`);
  }

  // Tombstones first — a failed manifest PUT must not block delete propagation.
  for (const entry of deleteEntries) {
    try {
      await deleteCloudObject(entry.path);
      await removeOutboxEntryIfUnchanged(entry.path, entry.queuedAt);  // race-safe: keep ops queued mid-push
      await removeCachedObject(entry.path);
      pushed += 1;
      Logger.info('SyncEngine', `pushed delete ${entry.path}`);
    } catch (err) {
      Logger.warn('SyncEngine', `delete failed ${entry.path}: ${err.message}`);
    }
  }

  const largePuts = putEntries.filter((e) => objectBodyBytes(e.envelope) > INLINE_OBJECT_MAX_BYTES);
  const smallPuts = putEntries.filter((e) => objectBodyBytes(e.envelope) <= INLINE_OBJECT_MAX_BYTES);

  if (largePuts.length) {
    Logger.info('SyncEngine', `push: ${largePuts.length} large put(s) via presigned S3`);
  }

  for (const entry of largePuts) {
    try {
      const res = await putCloudObjectAuto(entry.path, entry.envelope, entry.expectedEtag || '*');
      if (!res?.etag) {
        Logger.warn('SyncEngine', `large put returned no etag: ${entry.path}`);
        continue;
      }
      await putCachedObject({
        path: entry.path,
        envelope: entry.envelope,
        etag: res.etag,
        updatedAt: envelopeUpdatedAt(entry.envelope) || res.updatedAt || Date.now(),
      });
      await removeOutboxEntryIfUnchanged(entry.path, entry.queuedAt);  // race-safe: keep ops queued mid-push
      pushed += 1;
    } catch (e) {
      if (e instanceof CloudClientError && e.status === 409 && e.body && typeof e.body === 'object') {
        await handleConflict(/** @type {any} */ (e.body));
      } else {
        Logger.warn('SyncEngine', `large put failed ${entry.path}: ${e.message}`);
      }
    }
  }

  for (let i = 0; i < smallPuts.length; i += MAX_BATCH) {
    const chunk = smallPuts.slice(i, i + MAX_BATCH);
    pushed += await pushBatchChunk(chunk);
  }

  return { pushed };
}

/**
 * @param {Array<{ path: string, envelope: unknown, expectedEtag?: string }>} chunk
 */
async function pushBatchChunk(chunk) {
  let remaining = chunk;
  let pushed = 0;

  while (remaining.length > 0) {
    const items = remaining.map((e) => ({
      path: e.path,
      envelope: e.envelope,
      expectedEtag: e.expectedEtag || '*',
    }));

    try {
      const res = await batchWriteCloudObjects({ items });
      const uploaded = [];
      for (const entry of remaining) {
        const etag = res.etags?.[entry.path];
        if (!etag) {
          Logger.warn('SyncEngine', `batch put missing etag: ${entry.path}`);
          continue;
        }
        await putCachedObject({
          path: entry.path,
          envelope: entry.envelope,
          etag,
          updatedAt: envelopeUpdatedAt(entry.envelope) || Date.now(),
        });
        uploaded.push(entry);
      }
      if (uploaded.length !== remaining.length) {
        Logger.warn('SyncEngine', `batch incomplete: ${uploaded.length}/${remaining.length} etags`);
      }
      if (uploaded.length) {
        // race-safe removal: keep any op re-queued on this path during the batch push
        for (const e of uploaded) await removeOutboxEntryIfUnchanged(e.path, e.queuedAt);
        pushed += uploaded.length;
      }
      break;
    } catch (e) {
      if (e instanceof CloudClientError && e.status === 409 && e.body && typeof e.body === 'object') {
        const conflict = /** @type {{ path?: string }} */ (e.body);
        await handleConflict(/** @type {any} */ (e.body));
        if (!conflict.path) break;
        remaining = remaining.filter((entry) => entry.path !== conflict.path);
        if (remaining.length === 0) break;
        continue;
      }
      throw e;
    }
  }

  return pushed;
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
    if (!pending.some((p) => p.path === conflict.path)) {
      pending.push({ path: conflict.path, conflict });
      await setPendingConflicts(pending);
      Logger.warn('SyncEngine', `Manual conflict queued: ${conflict.path}`);
    }
    await removeOutboxEntries([conflict.path]);
  }
}

async function pullChanges() {
  const session = await getStoredSession();
  let since = await getLastSyncToken();
  const applied = [];
  let skippedCached = 0;
  let skippedMissing = 0;
  let totalRemote = 0;
  let pages = 0;

  while (pages < 20) {
    const feed = await listCloudChanges(since || undefined);
    const changes = feed.changes || [];
    pages += 1;

    if (changes.length === 0) {
      if (pages === 1) {
        Logger.info('SyncEngine', `pull: 0 changes (orchardUserId=${session?.orchardUserId || 'none'}, since=${since || 'start'})`);
      }
      if (feed.nextToken && feed.nextToken !== since) {
        await setLastSyncToken(feed.nextToken);
      }
      break;
    }

    totalRemote += changes.length;

    for (const change of changes) {
      if (!change.path || change.path.endsWith('/_manifest.json')) continue;

      if (change.deleted) {
        const result = await applyRemoteDelete(change.path);
        if (result) {
          applied.push(result);
          Logger.info('SyncEngine', `pull delete ${change.path}`);
        }
        continue;
      }

      const cached = await getCachedObject(change.path);
      if (cached?.etag && change.etag && cached.etag === change.etag) {
        const meta = recordMetaFromPath(change.path);
        if (meta && await localRecordExists(meta.kind, meta.id, meta.groundId)) {
          skippedCached += 1;
          continue;
        }
      }

      try {
        const { envelope, etag } = await fetchCloudObjectRaw(change.path);
        const result = await applyRemoteObject(change.path, envelope, etag || change.etag || '');
        if (result) applied.push(result);
      } catch (e) {
        const missing = e instanceof CloudClientError && e.status === 404
          && typeof e.body === 'object' && e.body && /** @type {{ error?: string }} */ (e.body).error === 'not_found';
        if (missing) {
          skippedMissing += 1;
          Logger.warn('SyncEngine', `pull skip missing cloud object: ${change.path}`);
          continue;
        }
        throw e;
      }
    }

    if (feed.nextToken) {
      since = feed.nextToken;
      await setLastSyncToken(feed.nextToken);
    }

    if (changes.length < 100 || !feed.nextToken) break;
  }

  const deletedGroundIds = [...new Set(
    applied.filter((a) => a.deleted && a.groundId).map((a) => a.groundId)
  )];
  for (const gid of deletedGroundIds) {
    await enqueueGroundManifestSync(gid, { orchardUserId: session?.orchardUserId });
  }

  Logger.info('SyncEngine',
    `pull: ${applied.length} applied, ${totalRemote} remote, ${skippedCached} skipped (cached), ${skippedMissing} missing (ghost index)`);
  return { pulled: applied.length, applied, remoteChangeCount: totalRemote, skippedMissing };
}

const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;   // GC delete tombstones after 30d — server has long propagated

/** Drop tombstones past the TTL so the store stays bounded. Best-effort. */
async function gcTombstones() {
  try {
    const now = Date.now();
    for (const t of await listTombstones()) {
      if (t && typeof t.deletedAt === 'number' && (now - t.deletedAt) > TOMBSTONE_TTL_MS) {
        await removeTombstone(t.path);
      }
    }
  } catch (e) { Logger.warn('SyncEngine', `tombstone GC failed: ${e.message}`); }
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
    await gcTombstones();
    Logger.info('SyncEngine', `sync complete pushed=${pushResult.pushed} pulled=${pullResult.pulled} bootstrapped=${bootstrapped} outbox=${outboxPending}`);
    await setLastSyncResult({
      ok: true,
      at: Date.now(),
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      bootstrapped,
      outboxPending,
      remoteChangeCount: pullResult.remoteChangeCount ?? 0,
    });
    const skippedMissing = pullResult.skippedMissing ?? 0;
    return {
      ok: true,
      pushed: pushResult.pushed,
      pulled: pullResult.pulled,
      bootstrapped,
      outboxPending,
      remoteChangeCount: pullResult.remoteChangeCount ?? 0,
      skippedMissing,
      applied: pullResult.applied,
      ...(skippedMissing > 0 ? {
        warning: `${skippedMissing} cloud index entr${skippedMissing === 1 ? 'y' : 'ies'} had no object body — re-sync on the source device`,
      } : {}),
    };
  } catch (e) {
    let msg = e.message;
    if (e instanceof CloudClientError) {
      if (e.status === 404) {
        const body = /** @type {{ error?: string, path?: string, message?: string }} */ (
          e.body && typeof e.body === 'object' ? e.body : {}
        );
        if (body.error === 'not_found') {
          msg = `Cloud object missing (${body.path || 'unknown path'}) — re-sync on the source device`;
        } else {
          const settings = await getCloudSettings();
          msg = `Sync API not found — API base URL must end with /v1 (current: ${settings.apiBaseUrl}). Reload extension after saving Cloud config.`;
        }
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
    await removeOutboxEntries([path]);
    await enqueueSyncWrite(path, conflict.client, { expectedEtag: '*' });
  } else if (resolution === 'keep-theirs' && conflict.server) {
    await applyRemoteObject(path, conflict.server, '*');
  }

  await setPendingConflicts(pending.filter((p) => p.path !== path));
  if (resolution === 'keep-theirs') {
    await removeOutboxEntries([path]);
  }
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
