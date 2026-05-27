/**
 * @file Core/publicationImport.js
 * @description Publication import — pure reconciliation logic (STORAGE_SCHEMA §9 import side).
 *   Given a publication Manifest, decide how each entry lands locally:
 *     • bundled            → install as a NEW local primitive (fresh local id; lineage tracked)
 *     • reference-canonical→ match an existing local primitive by canonical UID (landmarks)
 *     • reference-publication → require that the referenced publication is already imported
 *   …and remap references inside bundled bodies from the publisher's local ids to the importer's
 *   new local ids. I/O-free + deterministic (id generation + presence checks are injected) so it's
 *   fully unit-testable; signature verification (OrchardIdentity.verifyMessage) and the actual
 *   writes/lineage records are the thin Services layer that consumes this.
 *
 * @see ./publication.js
 * @see ../schemas/orchard/STORAGE_SCHEMA_REVISED.md §9
 */

/**
 * @typedef {'install'|'match-canonical'|'require-publication'} ImportAction
 */

/**
 * @typedef {Object} ImportItem
 * @property {string} publisherId    the publisher's local id (manifest primitiveId)
 * @property {string} localId        the id this becomes in the importer's workspace
 * @property {string} primitiveType
 * @property {string} publicId
 * @property {ImportAction} action
 */

/**
 * @typedef {Object} ImportPlan
 * @property {ImportItem[]} items
 * @property {Record<string, string>} idMap        publisherId → importer localId (for remapping)
 * @property {string[]} missingCanonical           canonical deps not present locally (block import)
 * @property {string[]} missingPublications        reference-publication deps not imported (block)
 * @property {boolean} installable                 true when nothing blocks the import
 */

const TYPE_PREFIX = {
  ground: 'gnd', fragment: 'frag', observation: 'obs', analysis: 'ana',
  assertion: 'ast', perspective: 'persp', landmark: 'lmk', workflow: 'wfl', strategy: 'strat',
};

/** Default new-id generator: `<prefix>_imp_<rand>`. Deterministic generator can be injected for tests. */
function defaultNewId(primitiveType) {
  const p = TYPE_PREFIX[primitiveType] || 'prm';
  const rand = (globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 12);
  return `${p}_imp_${rand}`;
}

/**
 * Build the import plan from a manifest.
 * @param {{
 *   manifest: import('./publication.js').Manifest,
 *   isCanonicalPresent?: (publicId: string) => boolean,
 *   isPublicationPresent?: (publicationReference: string) => boolean,
 *   newId?: (primitiveType: string, publisherId: string) => string,
 * }} args
 * @returns {ImportPlan}
 */
export function buildImportPlan(args) {
  const { manifest } = args;
  const isCanonicalPresent = args.isCanonicalPresent || (() => false);
  const isPublicationPresent = args.isPublicationPresent || (() => false);
  const newId = args.newId || defaultNewId;

  /** @type {ImportItem[]} */ const items = [];
  /** @type {Record<string, string>} */ const idMap = {};
  /** @type {string[]} */ const missingCanonical = [];
  /** @type {string[]} */ const missingPublications = [];

  // The primary is always installed as a fresh local primitive.
  const primaryLocal = newId(manifest.primary.primitiveType, manifest.primary.primitiveId);
  idMap[manifest.primary.primitiveId] = primaryLocal;
  items.push({
    publisherId: manifest.primary.primitiveId,
    localId: primaryLocal,
    primitiveType: manifest.primary.primitiveType,
    publicId: manifest.primary.publicId,
    action: 'install',
  });

  for (const dep of manifest.dependencies || []) {
    if (dep.resolution === 'reference-canonical') {
      // Match an existing local primitive by canonical UID — id is unchanged across users.
      idMap[dep.primitiveId] = dep.publicId;
      if (!isCanonicalPresent(dep.publicId)) missingCanonical.push(dep.publicId);
      items.push({
        publisherId: dep.primitiveId, localId: dep.publicId,
        primitiveType: dep.primitiveType, publicId: dep.publicId, action: 'match-canonical',
      });
    } else if (dep.resolution === 'reference-publication') {
      const ref = dep.publicationReference || '';
      if (!ref || !isPublicationPresent(ref)) missingPublications.push(ref);
      // localId resolution happens once the referenced publication is imported; leave unmapped.
      items.push({
        publisherId: dep.primitiveId, localId: '', primitiveType: dep.primitiveType,
        publicId: dep.publicId, action: 'require-publication',
      });
    } else {
      // bundled → fresh local id
      const local = newId(dep.primitiveType, dep.primitiveId);
      idMap[dep.primitiveId] = local;
      items.push({
        publisherId: dep.primitiveId, localId: local,
        primitiveType: dep.primitiveType, publicId: dep.publicId, action: 'install',
      });
    }
  }

  return {
    items,
    idMap,
    missingCanonical,
    missingPublications: missingPublications.filter(Boolean),
    installable: missingCanonical.length === 0 && missingPublications.filter(Boolean).length === 0,
  };
}

/**
 * Rewrite references inside a bundled body from publisher ids to importer local ids (via idMap).
 * Covers the reference fields the extractor knows about: pre/post (and an assertion's `body`)
 * condition trees (`assertion_ref.assertionId`, `perspective_ref.perspectiveId`), `ground.perspectiveIds`,
 * plus the body's own `id`/`groundId`. Returns a NEW object (does not mutate input). Ids absent from
 * idMap are left as-is (e.g. canonical landmark uids map to themselves).
 * @param {string} kind
 * @param {Record<string, unknown>} body
 * @param {Record<string, string>} idMap
 * @returns {Record<string, unknown>}
 */
export function remapReferences(kind, body, idMap) {
  const map = (id) => (id != null && Object.prototype.hasOwnProperty.call(idMap, id) ? idMap[id] : id);

  /** Deep-clone + rewrite condition-tree id fields. */
  const remapConditions = (node) => {
    if (node == null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(remapConditions);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === 'assertionId' && typeof v === 'string') out[k] = map(v);
      else if (k === 'perspectiveId' && typeof v === 'string') out[k] = map(v);
      else out[k] = remapConditions(v);
    }
    return out;
  };

  /** @type {Record<string, unknown>} */
  const next = { ...body };

  if (typeof next.id === 'string') next.id = map(next.id);
  if (typeof next.groundId === 'string') next.groundId = map(next.groundId);

  if ('pre' in next) next.pre = remapConditions(next.pre);
  if ('post' in next) next.post = remapConditions(next.post);
  if (kind === 'assertion' && 'body' in next) next.body = remapConditions(next.body);

  if (kind === 'ground' && Array.isArray(next.perspectiveIds)) {
    next.perspectiveIds = next.perspectiveIds.map((pid) => map(pid));
  }

  return next;
}
