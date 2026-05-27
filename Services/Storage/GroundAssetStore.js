/**
 * @file Services/Storage/GroundAssetStore.js
 * @description Per-ground Locale, siteMap, and chrome artifacts (Explore / GROUND_SPEC).
 * Shared by background.js and the hybrid sync engine.
 */

export const LOCALE_CACHE_KEY = 'localeCache';
export const LOCALE_TTL_MS = 1000 * 60 * 60 * 24 * 7;

const OUTCOMES_STREAM_KEY = 'outcomesStream';
const SITEMAP_CACHE_KEY = 'siteMapCache';
const _siteMapKey = (groundId) => `siteMap:${groundId}`;
const _chromeKey = (groundId) => `chrome:${groundId}`;

/** @param {string} url */
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
  const k = _siteMapKey(groundId);
  await chrome.storage.local.set({ [k]: siteMap });
}

/** @param {string} groundId */
export async function deleteSiteMap(groundId) {
  if (!groundId) return;
  await ensureStorageMigrated();
  await chrome.storage.local.remove(_siteMapKey(groundId));
}

/** @param {string} groundId */
export async function readChrome(groundId) {
  if (!groundId) return null;
  try {
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
  await chrome.storage.local.set({ [_chromeKey(groundId)]: artifact });
}

/** @param {string} groundId */
export async function deleteChrome(groundId) {
  if (!groundId) return;
  await chrome.storage.local.remove(_chromeKey(groundId));
}

/**
 * Sync envelope body for a locale entry.
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
