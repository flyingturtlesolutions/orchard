/**
 * @file Core/publication.js
 * @description Publication packaging — pure logic (STORAGE_SCHEMA §9). Given a root primitive and
 *   the reference graph, compute the dependency closure, classify each dependency
 *   (bundled / reference-canonical / reference-publication), and assemble the §9 Manifest +
 *   Publication metadata. I/O-free and deterministic so it's fully unit-testable; the publish flow
 *   (registry upload), the Ed25519 signature (Core/OrchardIdentity), and the import/lineage side
 *   are separate slices that consume this.
 *
 * @see ./referenceGraph.js
 * @see ../schemas/orchard/STORAGE_SCHEMA_REVISED.md §9
 */

import { getOutboundReferences } from './referenceGraph.js';

/** @typedef {import('./referenceGraph.js').ReferenceGraph} ReferenceGraph */

/**
 * @typedef {'bundled'|'reference-canonical'|'reference-publication'} DependencyResolution
 */

/**
 * @typedef {Object} ManifestDependency
 * @property {string} primitiveId
 * @property {string} primitiveType
 * @property {string} publicId
 * @property {DependencyResolution} resolution
 * @property {string} [publicationReference]   set when resolution === 'reference-publication'
 */

/**
 * @typedef {Object} Manifest
 * @property {string} publicationId
 * @property {{ primitiveId: string, primitiveType: string, publicId: string }} primary
 * @property {ManifestDependency[]} dependencies
 * @property {number} totalSize     byte length of the bundled set (primary + bundled deps)
 * @property {string} bundleHash    deterministic fingerprint of the bundled set
 */

/**
 * Transitive dependency closure of `rootId` over outbound reference edges (BFS, cycle-safe).
 * Returns dependency ids in discovery order, excluding the root itself.
 * @param {string} rootId
 * @param {ReferenceGraph} graph
 * @returns {string[]}
 */
export function computeDependencyClosure(rootId, graph) {
  const seen = new Set([rootId]);
  /** @type {string[]} */
  const order = [];
  const queue = [rootId];
  while (queue.length) {
    const id = /** @type {string} */ (queue.shift());
    for (const ref of getOutboundReferences(graph, id)) {
      if (seen.has(ref.to)) continue;
      seen.add(ref.to);
      order.push(ref.to);
      queue.push(ref.to);
    }
  }
  return order;
}

/** Best-effort primitive type from an id prefix (publish flow should pass an exact resolveDep). */
const TYPE_PREFIXES = [
  ['gnd_', 'ground'], ['grounds_', 'ground'],
  ['frag_', 'fragment'], ['frg_', 'fragment'],
  ['obs_', 'observation'], ['ana_', 'analysis'], ['anl_', 'analysis'],
  ['ast_', 'assertion'], ['pred_', 'assertion'],
  ['persp_', 'perspective'], ['perspective_', 'perspective'], ['loc_', 'perspective'],
  ['lmk_', 'landmark'], ['wfl_', 'workflow'], ['strat_', 'strategy'], ['stg_', 'strategy'],
];

/** @param {string} id */
function inferType(id) {
  for (const [prefix, type] of TYPE_PREFIXES) if (String(id).startsWith(prefix)) return type;
  return 'unknown';
}

/**
 * Default dependency descriptor: bundle everything, infer type from id, publicId = local id.
 * The publish flow overrides this with workspace knowledge (canonical-landmark detection →
 * 'reference-canonical'; imported-via-lineage → 'reference-publication').
 * @param {string} id
 * @returns {{ primitiveType: string, publicId: string, resolution: DependencyResolution, publicationReference?: string }}
 */
export function defaultResolveDep(id) {
  return { primitiveType: inferType(id), publicId: id, resolution: 'bundled' };
}

/**
 * Deterministic JSON (object keys sorted) so the bundle fingerprint is stable across runs/devices.
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  const seen = new WeakSet();
  const walk = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return null;       // guard against cycles
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = walk(/** @type {any} */ (v)[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Deterministic non-crypto fingerprint (FNV-1a, 32-bit → 8-hex). Authenticity is the Ed25519
 *  signature added by the publish flow; this is a content/dedup fingerprint only. */
export function fingerprint(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Assemble the §9 Manifest for publishing `root`.
 * @param {{
 *   publicationId: string,
 *   root: { id: string, type: string, publicId?: string },
 *   graph: ReferenceGraph,
 *   bodies: Map<string, unknown>,                       // id → primitive body (for bundling/size)
 *   resolveDep?: (id: string) => ReturnType<typeof defaultResolveDep>,
 *   hashFn?: (s: string) => string,
 * }} args
 * @returns {Manifest}
 */
export function buildManifest(args) {
  const { publicationId, root, graph, bodies } = args;
  const resolveDep = args.resolveDep || defaultResolveDep;
  const hashFn = args.hashFn || fingerprint;

  const depIds = computeDependencyClosure(root.id, graph);
  /** @type {ManifestDependency[]} */
  const dependencies = depIds.map((id) => {
    const d = resolveDep(id);
    /** @type {ManifestDependency} */
    const entry = {
      primitiveId: id,
      primitiveType: d.primitiveType,
      publicId: d.publicId,
      resolution: d.resolution,
    };
    if (d.resolution === 'reference-publication' && d.publicationReference) {
      entry.publicationReference = d.publicationReference;
    }
    return entry;
  });

  // The bundled set is the primary plus every 'bundled' dependency.
  const bundledIds = [root.id, ...dependencies.filter((d) => d.resolution === 'bundled').map((d) => d.primitiveId)];
  const bundle = bundledIds.map((id) => bodies.get(id)).filter((b) => b !== undefined);
  const canonical = stableStringify(bundle);

  return {
    publicationId,
    primary: { primitiveId: root.id, primitiveType: root.type, publicId: root.publicId || root.id },
    dependencies,
    totalSize: canonical.length,
    bundleHash: hashFn(canonical),
  };
}

/**
 * Assemble §9 Publication metadata (without the signature — the publish flow signs the bundleHash
 * via OrchardIdentity and sets `signature`/`signatureAlgorithm`).
 * @param {{
 *   manifest: Manifest,
 *   publishedBy: object,                                  // UserRef
 *   details: { title: string, description?: string, tags?: string[], version?: string,
 *              visibility?: 'public'|'unlisted'|'private-link', license?: string,
 *              registry?: string, previousVersionId?: string },
 *   schemaVersions?: Record<string, number>,
 *   architectureVersion?: string,
 *   now?: number,
 * }} args
 * @returns {object} Publication (sans signature)
 */
export function buildPublication(args) {
  const { manifest, publishedBy, details } = args;
  const now = args.now ?? Date.now();
  return {
    publicationId: manifest.publicationId,
    publishedPrimitiveType: manifest.primary.primitiveType,
    publishedPrimitiveId: manifest.primary.primitiveId,
    publishedAt: now,
    publishedBy,
    visibility: details.visibility || 'unlisted',
    license: details.license || 'CC-BY-4.0',
    title: details.title,
    description: details.description || '',
    tags: Array.isArray(details.tags) ? details.tags : [],
    version: details.version || '1.0.0',
    ...(details.previousVersionId ? { previousVersionId: details.previousVersionId } : {}),
    registry: details.registry || '',
    schemaVersions: args.schemaVersions || {},
    architectureVersion: args.architectureVersion || '',
    bundleHash: manifest.bundleHash,
  };
}
