/**
 * @file Core/groundDerivation.js
 * @description GROUND_SPEC § 5 derived-intent helpers. Pure, storage-free.
 *
 * A Ground's description is DERIVED from its constituent Perspectives' descriptions
 * (not authored). This module owns the cache-validation hash + the
 * staleness/effective-description logic so the background derivation pipeline
 * and the Studio surface agree without drifting.
 *
 * @module Core/groundDerivation
 * @version 2.74.329
 */

// Bump when the derivation prompt template changes so stored derivations are
// recognised as produced by an older prompt (surfaced as a refresh hint).
export const DERIVATION_VERSION = 1;

// Placeholder shown when a Ground has no Perspectives to derive from yet.
export const EMPTY_GROUND_PLACEHOLDER = 'Empty Ground — author a Perspective to begin.';

// Stable, cheap string hash (djb2/xor). Not cryptographic — only for
// change detection.
function _hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h) ^ str.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/**
 * Cache-validation hash of the derivation inputs: the constituent Perspectives'
 * UIDs + a per-Perspective version (updatedAt) + a content fingerprint of each
 * description. Order-independent (Perspectives sorted by id) so reordering alone
 * doesn't force a re-derivation. Includes DERIVATION_VERSION so a prompt
 * change invalidates every cache.
 *
 * @param {Array<{id?:string, updatedAt?:number, description?:string}>} perspectives
 * @returns {string}
 */
export function derivationInputsHash(perspectives) {
  const list = Array.isArray(perspectives) ? perspectives : [];
  const parts = list
    .map(l => `${l?.id ?? ''}:${Number(l?.updatedAt) || 0}:${(l?.description ?? '').trim().length}`)
    .sort();
  return _hash(`v${DERIVATION_VERSION}|${parts.join('|')}`);
}

/**
 * Is the Ground's cached derived description stale w.r.t. its current
 * Perspectives? True when there's no cached description, or the inputs hash /
 * prompt version changed. (An overridden Ground is never "stale" for display
 * purposes — the override wins — but this reflects the DERIVED cache.)
 *
 * @param {object} ground   Ground record (with derivationInputsHash, derivationVersion)
 * @param {Array}  perspectives  Constituent Perspective records
 * @returns {boolean}
 */
export function isDerivationStale(ground, perspectives) {
  const list = Array.isArray(perspectives) ? perspectives : [];
  if (list.length === 0) return false;                 // nothing to derive
  if (!ground?.derivedDescription) return true;        // never derived
  if ((ground.derivationVersion || 0) !== DERIVATION_VERSION) return true;
  return ground.derivationInputsHash !== derivationInputsHash(list);
}

/**
 * The description to display: the user override if set, else the derived
 * description, else the empty-Ground placeholder.
 * @param {object} ground
 * @param {Array}  [perspectives]
 * @returns {string}
 */
export function effectiveDescription(ground, perspectives) {
  if (typeof ground?.descriptionOverride === 'string' && ground.descriptionOverride.trim()) {
    return ground.descriptionOverride.trim();
  }
  if (ground?.derivedDescription) return ground.derivedDescription;
  const hasPerspectives = Array.isArray(perspectives) ? perspectives.length > 0 : (ground?.perspectiveIds?.length > 0);
  return hasPerspectives ? '' : EMPTY_GROUND_PLACEHOLDER;
}
