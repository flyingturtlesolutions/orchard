/**
 * @file Services/Storage/StoredEnvelope.js
 * @description StoredPrimitive wrapper for Orchard sync (STORAGE_SCHEMA §5).
 */

/**
 * @typedef {Object} UserRef
 * @property {'local'|'external'|'system'} type
 * @property {string} [userId]
 * @property {string} [orchardUserId]
 * @property {string} [publicKey]
 */

/**
 * @template T
 * @typedef {Object} StoredPrimitive
 * @property {number} schemaVersion
 * @property {string} id
 * @property {number} updatedAt
 * @property {UserRef} updatedBy
 * @property {'draft'|'active'|'deprecated'|'retired'} lifecycle
 * @property {T} body
 */

/**
 * @param {unknown} body
 * @param {string} id
 * @param {UserRef} [updatedBy]
 * @param {number} [schemaVersion]   per-primitive-type version (STORAGE §3/§11); default 1
 * @returns {StoredPrimitive<unknown>}
 */
export function wrapEnvelope(body, id, updatedBy, schemaVersion = 1) {
  const record = /** @type {Record<string, unknown>} */ (body || {});
  const now = Date.now();
  const updatedAt = typeof record.updatedAt === 'number'
    ? record.updatedAt
    : typeof record.lastRebuiltAt === 'number'
      ? record.lastRebuiltAt
      : now;
  const lifecycle = /** @type {StoredPrimitive<unknown>['lifecycle']} */ (
    record.metadata && typeof record.metadata === 'object' && record.metadata.lifecycle
      ? record.metadata.lifecycle
      : (record.lifecycle || 'active')
  );

  return {
    schemaVersion: schemaVersion ?? 1,
    id,
    updatedAt,
    updatedBy: updatedBy || { type: 'local' },
    lifecycle,
    body: record,
  };
}

/** @param {StoredPrimitive<unknown>|unknown} envelope @returns {number} */
export function envelopeSchemaVersion(envelope) {
  if (envelope && typeof envelope === 'object' && 'schemaVersion' in envelope) {
    return Number(/** @type {StoredPrimitive<unknown>} */ (envelope).schemaVersion) || 0;
  }
  return 0;   // 0 = un-enveloped legacy body
}

/**
 * @param {StoredPrimitive<unknown>|unknown} envelope
 * @returns {unknown}
 */
export function unwrapEnvelope(envelope) {
  if (envelope && typeof envelope === 'object' && 'body' in envelope) {
    return /** @type {StoredPrimitive<unknown>} */ (envelope).body;
  }
  return envelope;
}

/**
 * @param {StoredPrimitive<unknown>|unknown} envelope
 * @returns {number}
 */
export function envelopeUpdatedAt(envelope) {
  if (envelope && typeof envelope === 'object') {
    const env = /** @type {StoredPrimitive<unknown>} */ (envelope);
    if ('updatedAt' in env) return Number(env.updatedAt) || 0;
    // Un-enveloped legacy body, or envelope whose timestamp lives on the body.
    const body = /** @type {{ updatedAt?: number, lastRebuiltAt?: number }} */ (env.body ?? env);
    if (typeof body.updatedAt === 'number') return body.updatedAt;
    if (typeof body.lastRebuiltAt === 'number') return body.lastRebuiltAt;
  }
  return 0;
}
