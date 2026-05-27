/**
 * @file Core/localUser.js
 * @description The identity/ partition's user model — pure factories + defaults (STORAGE_SCHEMA §4).
 *   Model B (one explicit local user) with Model C readiness (external users tracked separately).
 *   Pure + I/O-free: no chrome.*, no crypto keygen — the cryptographic identity (Ed25519 keypair,
 *   orchardUserId derivation, bind signing) lives in Core/OrchardIdentity.js and is composed in here
 *   as `publicIdentity`. This module just shapes/normalizes the records an identity store persists.
 *
 * @see ./OrchardIdentity.js  (publicIdentity: keypair + orchardUserId + bind)
 * @see ../schemas/orchard/STORAGE_SCHEMA_REVISED.md §4
 */

/**
 * @typedef {Object} TrainingConsent
 * @property {'none'|'local-only'|'anonymous-aggregate'|'identified-share'} consentLevel
 * @property {{
 *   authoringConversations: boolean, executionTraces: boolean, outcomeJudgments: boolean,
 *   observationEvidence: boolean, landmarkSubstrate: boolean, derivedAnalytics: boolean
 * }} dataCategories
 * @property {number} consentTimestamp
 * @property {number} consentVersion
 */

/**
 * @typedef {Object} SharingPreferences
 * @property {'private'|'unlisted'|'public'} defaultVisibility
 * @property {string} defaultLicense
 * @property {boolean} autoSignPublications
 * @property {boolean} requireConfirmationForImports
 * @property {'never'|'verified-only'|'manual'} trustNewUsersByDefault
 */

/**
 * @typedef {Object} PublicIdentity
 * @property {string} publicKey
 * @property {string} publicKeyAlgorithm
 * @property {'local-secure'|'hardware'|'backend'} privateKeyStorage
 * @property {number} establishedAt
 */

/**
 * @typedef {Object} LocalUser
 * @property {string} userId                 'usr_<random>' — locally generated, stable
 * @property {string} displayName
 * @property {PublicIdentity} publicIdentity
 * @property {{ accountId: string, provider: string, authenticatedAt: number, refreshToken?: string }} [account]
 * @property {{ handle: string, profileUrl?: string, bio?: string }} [publicProfile]
 * @property {Record<string, unknown>} preferences
 * @property {TrainingConsent} trainingConsent
 * @property {SharingPreferences} sharingPreferences
 * @property {number} createdAt
 * @property {number} updatedAt
 */

/**
 * @typedef {Object} KnownExternalUser
 * @property {string} externalUserId         'ext_<local-uuid>'
 * @property {string} publicKey
 * @property {string} publicKeyAlgorithm
 * @property {{ handle?: string, profileUrl?: string, displayName?: string }} declaredProfile
 * @property {'unknown'|'unverified'|'verified'|'trusted'|'blocked'} trustLevel
 * @property {number} [trustEstablishedAt]
 * @property {'manual'|'auto-verified'|'web-of-trust'} trustEstablishedBy
 * @property {string} [userNotes]
 * @property {number} firstSeenAt
 * @property {string[]} publicationsImported
 * @property {number} lastInteractionAt
 * @property {string[]} alternateHandles
 * @property {string[]} alternateKeys
 */

/** @returns {TrainingConsent} consent OFF by default — capture is strictly opt-in (§4, §8). */
export function defaultTrainingConsent() {
  return {
    consentLevel: 'none',
    dataCategories: {
      authoringConversations: false,
      executionTraces: false,
      outcomeJudgments: false,
      observationEvidence: false,
      landmarkSubstrate: false,
      derivedAnalytics: false,
    },
    consentTimestamp: 0,
    consentVersion: 1,
  };
}

/** @returns {SharingPreferences} private-by-default, confirm imports, never auto-trust. */
export function defaultSharingPreferences() {
  return {
    defaultVisibility: 'private',
    defaultLicense: '',
    autoSignPublications: false,
    requireConfirmationForImports: true,
    trustNewUsersByDefault: 'never',
  };
}

/**
 * Generate a prefixed local id. Uses crypto.randomUUID when available (service worker / modern
 * node), else a non-crypto fallback — IDs are local handles, not security tokens.
 * @param {string} prefix
 * @returns {string}
 */
export function generateLocalId(prefix) {
  let raw;
  try {
    raw = (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function')
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  } catch {
    raw = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
  return `${prefix}_${String(raw).replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Build a fresh LocalUser (Model B). publicIdentity is supplied from OrchardIdentity.
 * @param {{
 *   userId?: string, displayName?: string,
 *   publicKey?: string, publicKeyAlgorithm?: string,
 *   privateKeyStorage?: PublicIdentity['privateKeyStorage'],
 *   preferences?: Record<string, unknown>, now?: number,
 * }} [opts]
 * @returns {LocalUser}
 */
export function createLocalUser(opts = {}) {
  const now = opts.now ?? Date.now();
  return normalizeLocalUser({
    userId: opts.userId || generateLocalId('usr'),
    displayName: opts.displayName || 'You',
    publicIdentity: {
      publicKey: opts.publicKey || '',
      publicKeyAlgorithm: opts.publicKeyAlgorithm || 'Ed25519',
      privateKeyStorage: opts.privateKeyStorage || 'local-secure',
      establishedAt: now,
    },
    preferences: opts.preferences || {},
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * Fill defaults / coerce a (possibly-partial or legacy) stored record into a valid LocalUser.
 * Safe to run on every read; never drops unknown extension fields.
 * @param {Record<string, unknown>} raw
 * @returns {LocalUser}
 */
export function normalizeLocalUser(raw) {
  const r = (raw && typeof raw === 'object') ? raw : {};
  const now = Date.now();
  const pi = /** @type {Record<string, unknown>} */ (r.publicIdentity && typeof r.publicIdentity === 'object' ? r.publicIdentity : {});
  const consent = /** @type {Record<string, unknown>} */ (r.trainingConsent && typeof r.trainingConsent === 'object' ? r.trainingConsent : {});
  const baseConsent = defaultTrainingConsent();
  return {
    ...r,
    userId: typeof r.userId === 'string' && r.userId ? r.userId : generateLocalId('usr'),
    displayName: typeof r.displayName === 'string' && r.displayName ? r.displayName : 'You',
    publicIdentity: {
      publicKey: typeof pi.publicKey === 'string' ? pi.publicKey : '',
      publicKeyAlgorithm: typeof pi.publicKeyAlgorithm === 'string' ? pi.publicKeyAlgorithm : 'Ed25519',
      privateKeyStorage: /** @type {PublicIdentity['privateKeyStorage']} */ (pi.privateKeyStorage || 'local-secure'),
      establishedAt: Number(pi.establishedAt) || now,
    },
    preferences: (r.preferences && typeof r.preferences === 'object') ? r.preferences : {},
    trainingConsent: {
      ...baseConsent,
      ...consent,
      dataCategories: { ...baseConsent.dataCategories, ...(consent.dataCategories && typeof consent.dataCategories === 'object' ? consent.dataCategories : {}) },
    },
    sharingPreferences: { ...defaultSharingPreferences(), ...(r.sharingPreferences && typeof r.sharingPreferences === 'object' ? r.sharingPreferences : {}) },
    createdAt: Number(r.createdAt) || now,
    updatedAt: Number(r.updatedAt) || now,
  };
}

/**
 * Structured attribution for the local user (§4 UserRef). publicKey included when known.
 * @param {LocalUser} user
 * @returns {{ type: 'local', userId: string, publicKey?: string }}
 */
export function localUserRef(user) {
  /** @type {{ type: 'local', userId: string, publicKey?: string }} */
  const ref = { type: 'local', userId: user?.userId || '' };
  if (user?.publicIdentity?.publicKey) ref.publicKey = user.publicIdentity.publicKey;
  return ref;
}

/**
 * Build a KnownExternalUser record on first encounter.
 * @param {{ publicKey: string, publicKeyAlgorithm?: string, declaredProfile?: object, externalUserId?: string, now?: number }} opts
 * @returns {KnownExternalUser}
 */
export function createKnownExternalUser(opts) {
  const now = opts.now ?? Date.now();
  return {
    externalUserId: opts.externalUserId || generateLocalId('ext'),
    publicKey: opts.publicKey,
    publicKeyAlgorithm: opts.publicKeyAlgorithm || 'Ed25519',
    declaredProfile: /** @type {KnownExternalUser['declaredProfile']} */ (opts.declaredProfile || {}),
    trustLevel: 'unknown',
    trustEstablishedBy: 'manual',
    firstSeenAt: now,
    publicationsImported: [],
    lastInteractionAt: now,
    alternateHandles: [],
    alternateKeys: [],
  };
}

/**
 * Pure trust-level update (returns a new record).
 * @param {KnownExternalUser} user
 * @param {KnownExternalUser['trustLevel']} trustLevel
 * @param {KnownExternalUser['trustEstablishedBy']} [by]
 * @param {number} [now]
 * @returns {KnownExternalUser}
 */
export function setExternalUserTrust(user, trustLevel, by = 'manual', now = Date.now()) {
  return { ...user, trustLevel, trustEstablishedBy: by, trustEstablishedAt: now, lastInteractionAt: now };
}
