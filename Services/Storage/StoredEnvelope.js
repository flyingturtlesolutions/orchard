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
 * @returns {StoredPrimitive<unknown>}
 */
export function wrapEnvelope(body, id, updatedBy) {
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
    schemaVersion: 1,
    id,
    updatedAt,
    updatedBy: updatedBy || { type: 'local' },
    lifecycle,
    body: record,
  };
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
  if (envelope && typeof envelope === 'object' && 'updatedAt' in envelope) {
    return Number(/** @type {StoredPrimitive<unknown>} */ (envelope).updatedAt) || 0;
  }
  if (envelope && typeof envelope === 'object' && 'updatedAt' in /** @type {object} */ (envelope)) {
    return Number(/** @type {{ updatedAt?: number }} */ (envelope).updatedAt) || 0;
  }
  return 0;
}
