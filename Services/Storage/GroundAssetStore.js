/**
 * @file Services/Storage/GroundAssetStore.js
 * @description Per-ground Locale, siteMap, and chrome artifacts (Explore / GROUND_SPEC).
 * Shared by background.js and the hybrid sync engine.
 */

import { maybeReadPartition } from './PartitionRead.js';
import {
  maybeWritePartitionPrimary,
  maybeRemovePartitionPrimary,
} from './PartitionWrite.js';
import {
  LOCALE_CACHE_KEY,
  siteMapStorageKey,
  chromeStorageKey,
  localeSyncRecord,
  siteMapSyncRecord,
  chromeSyncRecord,
} from './GroundAssetSyncRecords.js';

export const LOCALE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
export { LOCALE_CACHE_KEY, localeSyncRecord, siteMapSyncRecord, chromeSyncRecord };

const OUTCOMES_STREAM_KEY = 'outcomesStream';
const SITEMAP_CACHE_KEY = 'siteMapCache';
const _siteMapKey = siteMapStorageKey;
const _chromeKey = chromeStorageKey;

/** @param {string} url */
// v2.74.941 (CR-D1) — STAYS slash-keeping: these are PERSISTED Locale-cache keys; changing the bytes
// orphans every stored Locale. Comparison-time identity lives in Core/pageKey (slash-insensitive).
export function normalizeLocaleKey(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}

let _storageMigration = null;

/** One-time migration of legacy aggregate keys → per-ground keys. */
export function ensureStorageMigrated() {
  return (_storageMigration ??= _migrateAggregates());
}

async function _migrateAggregates() {
  try {
    const got = await chrome.storage.local.get([SITEMAP_CACHE_KEY, OUTCOMES_STREAM_KEY]);
    const _outcomesKey = (groundId) => `outcomes:${groundId}`;
    for (const [oldKey, keyFn] of [[SITEMAP_CACHE_KEY, _siteMapKey], [OUTCOMES_STREAM_KEY, _outcomesKey]]) {
      const blob = got?.[oldKey];
      if (!blob || typeof blob !== 'object') continue;
      const ids = Object.keys(blob);
      if (ids.length) {
        const existing = await chrome.storage.local.get(ids.map(keyFn));
        const writes = {};
        for (const id of ids) {
          const k = keyFn(id);
          if (existing[k] === undefined) writes[k] = blob[id];
        }
        if (Object.keys(writes).length) await chrome.storage.local.set(writes);
      }
      await chrome.storage.local.remove(oldKey);
    }
  } catch { /* best-effort */ }
}

/**
 * @param {string} groundId
 * @param {string} localeKey
 */
export async function readLocale(groundId, localeKey) {
  if (!groundId || !localeKey) return null;
  try {
    const fromPartition = await maybeReadPartition('locale', localeKey, { groundId });
    if (fromPartition?.model) {
      return {
        model: fromPartition.model,
        url: fromPartition.url,
        capturedAt: fromPartition.capturedAt,
      };
    }
    const got = await chrome.storage.local.get(LOCALE_CACHE_KEY);
    return got?.[LOCALE_CACHE_KEY]?.[groundId]?.[localeKey] ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {string} groundId
 * @param {string} localeKey
 * @param {{ model: unknown, url?: string, capturedAt?: number }} entry
 */
export async function writeLocale(groundId, localeKey, entry) {
  if (!groundId || !localeKey) return;
  await maybeWritePartitionPrimary('locale', localeSyncRecord(groundId, localeKey, entry));
  const got = await chrome.storage.local.get(LOCALE_CACHE_KEY);
  const map = got?.[LOCALE_CACHE_KEY] ?? {};
  if (!map[groundId]) map[groundId] = {};
  map[groundId][localeKey] = entry;
  await chrome.storage.local.set({ [LOCALE_CACHE_KEY]: map });
}

/**
 * @param {string} groundId
 * @param {string} localeKey
 */
export async function deleteLocale(groundId, localeKey) {
  if (!groundId || !localeKey) return;
  await maybeRemovePartitionPrimary('locale', { id: localeKey, groundId, localeKey });
  const got = await chrome.storage.local.get(LOCALE_CACHE_KEY);
  const map = got?.[LOCALE_CACHE_KEY] ?? {};
  if (map[groundId]) {
    delete map[groundId][localeKey];
    if (Object.keys(map[groundId]).length === 0) delete map[groundId];
  }
  await chrome.storage.local.set({ [LOCALE_CACHE_KEY]: map });
}

/**
 * @param {string} groundId
 * @returns {Promise<Array<{ localeKey: string, url?: string, capturedAt?: number, model: unknown }>>}
 */
export async function listLocales(groundId) {
  if (!groundId) return [];
  try {
    const got = await chrome.storage.local.get(LOCALE_CACHE_KEY);
    const byKey = got?.[LOCALE_CACHE_KEY]?.[groundId] ?? {};
    return Object.entries(byKey)
      .map(([localeKey, entry]) => ({
        localeKey,
        url: entry?.url,
        capturedAt: entry?.capturedAt,
        model: entry?.model,
      }))
      .filter((e) => e.model);
  } catch {
    return [];
  }
}

/** @param {string} groundId */
export async function readSiteMap(groundId) {
  if (!groundId) return null;
  await ensureStorageMigrated();
  try {
    const fromPartition = await maybeReadPartition('siteMap', groundId);
    if (fromPartition) {
      const rec = { ...fromPartition };
      delete rec.id;
      delete rec.groundId;
      return rec;
    }
    const k = _siteMapKey(groundId);
    const got = await chrome.storage.local.get(k);
    return got?.[k] ?? null;
  } catch {
    return null;
  }
}

/** @param {string} groundId @param {unknown} siteMap */
export async function writeSiteMap(groundId, siteMap) {
  if (!groundId || !siteMap) return;
  await ensureStorageMigrated();
  await maybeWritePartitionPrimary('siteMap', siteMapSyncRecord(groundId, siteMap));
  const k = _siteMapKey(groundId);
  await chrome.storage.local.set({ [k]: siteMap });
}

/** @param {string} groundId */
export async function deleteSiteMap(groundId) {
  if (!groundId) return;
  await ensureStorageMigrated();
  await maybeRemovePartitionPrimary('siteMap', { id: groundId, groundId });
  await chrome.storage.local.remove(_siteMapKey(groundId));
}

/** @param {string} groundId */
export async function readChrome(groundId) {
  if (!groundId) return null;
  try {
    const fromPartition = await maybeReadPartition('chrome', groundId);
    if (fromPartition) {
      const rec = { ...fromPartition };
      delete rec.id;
      delete rec.groundId;
      return rec;
    }
    const k = _chromeKey(groundId);
    const got = await chrome.storage.local.get(k);
    return got?.[k] ?? null;
  } catch {
    return null;
  }
}

/** @param {string} groundId @param {unknown} artifact */
export async function writeChrome(groundId, artifact) {
  if (!groundId || !artifact) return;
  await maybeWritePartitionPrimary('chrome', chromeSyncRecord(groundId, artifact));
  await chrome.storage.local.set({ [_chromeKey(groundId)]: artifact });
}

/** @param {string} groundId */
export async function deleteChrome(groundId) {
  if (!groundId) return;
  await maybeRemovePartitionPrimary('chrome', { id: groundId, groundId });
  await chrome.storage.local.remove(_chromeKey(groundId));
}
