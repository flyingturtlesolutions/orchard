/**
 * @file Services/Storage/IdentityStore.js
 * @description The identity/ partition persistence (STORAGE_SCHEMA §4, §10 identity ops). Owns the
 *   single local user record + known external users, persisted to chrome.storage (mirrors how
 *   Core/OrchardIdentity.js stores the device keypair). Pure record shaping lives in Core/localUser.js.
 *
 *   Decoupled from the cloud-auth seam by design: this never generates keys or talks to the backend.
 *   The cryptographic identity (Core/OrchardIdentity) and the cloud account are attached via the
 *   explicit bindPublicIdentity() / bindAccount() hooks, which the C-P0 auth flow calls after a key
 *   is established / a bind succeeds. Until then publicIdentity.publicKey is '' and account is unset —
 *   a valid Model B local user.
 *
 * @see ../../Core/localUser.js
 * @see ../../Core/OrchardIdentity.js  (key material; attached via bindPublicIdentity at C-P0)
 * @see ../../schemas/orchard/STORAGE_SCHEMA_REVISED.md §4
 */

import {
  createLocalUser,
  normalizeLocalUser,
  createKnownExternalUser,
  setExternalUserTrust,
  localUserRef,
} from '../../Core/localUser.js';

/** @typedef {import('../../Core/localUser.js').LocalUser} LocalUser */
/** @typedef {import('../../Core/localUser.js').KnownExternalUser} KnownExternalUser */

const LOCAL_USER_KEY = 'orchard:identity:localUser';
const EXTERNAL_USERS_KEY = 'orchard:identity:knownExternalUsers';

/** @param {string} key @returns {Promise<unknown>} */
function getKey(key) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(r[key]);
    });
  });
}

/** @param {string} key @param {unknown} value @returns {Promise<void>} */
function setKey(key, value) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

// ── Local user (§4) ──────────────────────────────────────────────────────────────────

/**
 * The device's local user, created on first access (Model B). Always returns a normalized record.
 * @returns {Promise<LocalUser>}
 */
export async function getLocalUser() {
  const stored = await getKey(LOCAL_USER_KEY);
  if (stored && typeof stored === 'object') {
    return normalizeLocalUser(/** @type {Record<string, unknown>} */ (stored));
  }
  const fresh = createLocalUser();
  await setKey(LOCAL_USER_KEY, fresh);
  return fresh;
}

/**
 * Partial update with careful nested-merge (preferences / trainingConsent / sharingPreferences are
 * merged, not replaced). userId, createdAt, publicIdentity, and account are immutable here — use the
 * bind* hooks for identity/account. updatedAt is bumped.
 * @param {Partial<LocalUser>} patch
 * @returns {Promise<LocalUser>}
 */
export async function updateLocalUser(patch = {}) {
  const cur = await getLocalUser();
  const p = /** @type {Record<string, unknown>} */ (patch);
  const consentPatch = /** @type {any} */ (p.trainingConsent);
  const next = {
    ...cur,
    ...p,
    userId: cur.userId,
    createdAt: cur.createdAt,
    publicIdentity: cur.publicIdentity,         // immutable here (use bindPublicIdentity)
    account: cur.account,                       // immutable here (use bindAccount)
    preferences: { ...cur.preferences, ...(p.preferences && typeof p.preferences === 'object' ? p.preferences : {}) },
    trainingConsent: consentPatch && typeof consentPatch === 'object'
      ? {
        ...cur.trainingConsent,
        ...consentPatch,
        dataCategories: { ...cur.trainingConsent.dataCategories, ...(consentPatch.dataCategories || {}) },
      }
      : cur.trainingConsent,
    sharingPreferences: { ...cur.sharingPreferences, ...(p.sharingPreferences && typeof p.sharingPreferences === 'object' ? p.sharingPreferences : {}) },
    updatedAt: Date.now(),
  };
  const normalized = normalizeLocalUser(next);
  await setKey(LOCAL_USER_KEY, normalized);
  return normalized;
}

/**
 * Attach the cryptographic identity (C-P0 hook). Called once a device keypair is established
 * (Core/OrchardIdentity.getOrCreateKeyPair). Idempotent.
 * @param {{ publicKey: string, publicKeyAlgorithm?: string, privateKeyStorage?: LocalUser['publicIdentity']['privateKeyStorage'] }} identity
 * @returns {Promise<LocalUser>}
 */
export async function bindPublicIdentity(identity) {
  const cur = await getLocalUser();
  const next = normalizeLocalUser({
    ...cur,
    publicIdentity: {
      ...cur.publicIdentity,
      publicKey: identity.publicKey,
      publicKeyAlgorithm: identity.publicKeyAlgorithm || cur.publicIdentity.publicKeyAlgorithm || 'Ed25519',
      privateKeyStorage: identity.privateKeyStorage || cur.publicIdentity.privateKeyStorage || 'local-secure',
      establishedAt: cur.publicIdentity.establishedAt || Date.now(),
    },
    updatedAt: Date.now(),
  });
  await setKey(LOCAL_USER_KEY, next);
  return next;
}

/**
 * Attach a backend account binding (C-P0 hook), after a successful cloud bind.
 * @param {{ accountId: string, provider: string, authenticatedAt?: number, refreshToken?: string }} account
 * @returns {Promise<LocalUser>}
 */
export async function bindAccount(account) {
  const cur = await getLocalUser();
  const next = normalizeLocalUser({
    ...cur,
    account: {
      accountId: account.accountId,
      provider: account.provider,
      authenticatedAt: account.authenticatedAt || Date.now(),
      ...(account.refreshToken ? { refreshToken: account.refreshToken } : {}),
    },
    updatedAt: Date.now(),
  });
  await setKey(LOCAL_USER_KEY, next);
  return next;
}

/** @returns {Promise<{ type: 'local', userId: string, publicKey?: string }>} */
export async function getLocalUserRef() {
  return localUserRef(await getLocalUser());
}

// ── Known external users (§4) ──────────────────────────────────────────────────────────

/** @returns {Promise<Record<string, KnownExternalUser>>} */
async function readExternalMap() {
  const m = await getKey(EXTERNAL_USERS_KEY);
  return (m && typeof m === 'object') ? /** @type {Record<string, KnownExternalUser>} */ (m) : {};
}

/** @returns {Promise<KnownExternalUser[]>} */
export async function listKnownExternalUsers() {
  return Object.values(await readExternalMap());
}

/** @param {string} externalUserId @returns {Promise<KnownExternalUser|null>} */
export async function getExternalUser(externalUserId) {
  return (await readExternalMap())[externalUserId] || null;
}

/**
 * Record (or refresh) an external user encountered via import/reference. Deduped by publicKey.
 * @param {string} publicKey
 * @param {{ publicKeyAlgorithm?: string, declaredProfile?: object }} [metadata]
 * @returns {Promise<KnownExternalUser>}
 */
export async function recordExternalUserEncounter(publicKey, metadata = {}) {
  const map = await readExternalMap();
  const existing = Object.values(map).find((u) => u.publicKey === publicKey);
  if (existing) {
    existing.lastInteractionAt = Date.now();
    if (metadata.declaredProfile) {
      existing.declaredProfile = { ...existing.declaredProfile, ...metadata.declaredProfile };
    }
    map[existing.externalUserId] = existing;
    await setKey(EXTERNAL_USERS_KEY, map);
    return existing;
  }
  const created = createKnownExternalUser({ publicKey, ...metadata });
  map[created.externalUserId] = created;
  await setKey(EXTERNAL_USERS_KEY, map);
  return created;
}

/**
 * @param {string} externalUserId
 * @param {KnownExternalUser['trustLevel']} trustLevel
 * @param {KnownExternalUser['trustEstablishedBy']} [by]
 * @returns {Promise<KnownExternalUser|null>}
 */
export async function setUserTrust(externalUserId, trustLevel, by = 'manual') {
  const map = await readExternalMap();
  const u = map[externalUserId];
  if (!u) return null;
  map[externalUserId] = setExternalUserTrust(u, trustLevel, by);
  await setKey(EXTERNAL_USERS_KEY, map);
  return map[externalUserId];
}
