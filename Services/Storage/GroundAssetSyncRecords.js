/**
 * @file Services/Storage/GroundAssetSyncRecords.js
 * @description Sync envelope builders for per-ground assets (no storage/partition deps).
 */

export const LOCALE_CACHE_KEY = 'localeCache';

/** @param {string} groundId */
export const siteMapStorageKey = (groundId) => `siteMap:${groundId}`;

/** @param {string} groundId */
export const chromeStorageKey = (groundId) => `chrome:${groundId}`;

/**
 * @param {string} groundId
 * @param {string} localeKey
 * @param {{ model: unknown, url?: string, capturedAt?: number }} entry
 */
export function localeSyncRecord(groundId, localeKey, entry) {
  const updatedAt = entry.capturedAt || Date.now();
  return {
    id: localeKey,
    groundId,
    localeKey,
    url: entry.url,
    capturedAt: entry.capturedAt,
    model: entry.model,
    updatedAt,
  };
}

/**
 * @param {string} groundId
 * @param {unknown} siteMap
 */
export function siteMapSyncRecord(groundId, siteMap) {
  const sm = /** @type {Record<string, unknown>} */ (siteMap || {});
  return {
    id: groundId,
    groundId,
    ...sm,
    updatedAt: Number(sm.updatedAt || sm.builtAt || Date.now()),
  };
}

/**
 * @param {string} groundId
 * @param {unknown} artifact
 */
export function chromeSyncRecord(groundId, artifact) {
  const a = /** @type {Record<string, unknown>} */ (artifact || {});
  return {
    id: groundId,
    groundId,
    ...a,
    updatedAt: Number(a.builtAt || a.updatedAt || Date.now()),
  };
}
