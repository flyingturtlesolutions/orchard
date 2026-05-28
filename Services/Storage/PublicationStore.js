/**
 * @file Services/Storage/PublicationStore.js
 * @description Publish flow (STORAGE_SCHEMA §9, outgoing side). Packages a primitive + its
 *   dependency closure (Core/publication over ReferenceStore), signs the bundle with the device
 *   Ed25519 key (Core/OrchardIdentity), and persists an outgoing publication record locally
 *   (workspace/publications/outgoing/). Registry upload is a later slice (needs the lambda
 *   /publications endpoints); this produces a complete, signed, importable package locally.
 *
 * @see ../../Core/publication.js
 * @see ./ReferenceStore.js
 * @see ../../Core/OrchardIdentity.js
 */

import { Logger } from '../../Core/Logger.js';
import { buildManifest, buildPublication } from '../../Core/publication.js';
import { rebuildReferenceGraph, collectWorkspacePrimitives } from './ReferenceStore.js';
import { getLocalUserRef } from './IdentityStore.js';
import { signMessage } from '../../Core/OrchardIdentity.js';
import { publishToRegistry } from '../Cloud/CloudClient.js';
import { tryBindIdentity } from '../Cloud/OrchardAuth.js';

const OUT_INDEX_KEY = 'publications:outgoing:index';
const outKey = (id) => `publications:outgoing:${id}`;

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

// ── Pure helpers (exported for unit tests) ───────────────────────────────────────────

/**
 * Index { kind, body } primitives by their graph id (id, or uid for landmarks / localeKey for
 * locales) → { bodies, kinds } maps. Keys MUST match the reference graph's node ids so the
 * dependency closure resolves bodies correctly.
 * @param {Array<{ kind: string, body: Record<string, unknown> }>} primitives
 * @returns {{ bodies: Map<string, unknown>, kinds: Map<string, string> }}
 */
export function indexPrimitives(primitives) {
  /** @type {Map<string, unknown>} */ const bodies = new Map();
  /** @type {Map<string, string>} */ const kinds = new Map();
  for (const { kind, body } of primitives || []) {
    const id = String(body?.id ?? body?.uid ?? body?.localeKey ?? '');
    if (!id) continue;
    bodies.set(id, body);
    kinds.set(id, kind);
  }
  return { bodies, kinds };
}

/**
 * Resolution policy for publishing (§9): landmarks are canonical (shared by UID, matched on import)
 * → reference-canonical; everything else is bundled. (reference-publication via lineage is a later
 * slice — it needs the import/lineage records.)
 * @param {Map<string, string>} kinds
 * @returns {(id: string) => { primitiveType: string, publicId: string, resolution: 'bundled'|'reference-canonical' }}
 */
export function publishResolveDep(kinds) {
  return (id) => {
    const kind = kinds.get(id) || 'unknown';
    if (kind === 'landmark') {
      return { primitiveType: 'landmark', publicId: id, resolution: 'reference-canonical' };
    }
    return { primitiveType: kind, publicId: id, resolution: 'bundled' };
  };
}

/** @returns {string} */
function newPublicationId() {
  const rand = (crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16);
  return `pub_${rand}`;
}

// ── Publish flow ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} PublicationPackage
 * @property {object} publication   §9 Publication metadata (signed after signPackage)
 * @property {object} manifest      §9 Manifest
 * @property {{ primary: unknown, dependencies: unknown[] }} packages   bundled bodies
 */

/**
 * Build the signed-ready package for `kind`/`id` (does not persist). Gathers the full workspace,
 * computes the dependency closure from the reference graph, and bundles the reachable bodies.
 * @param {string} kind
 * @param {string} id
 * @param {object} [details]   { title, description?, tags?, version?, visibility?, license?, registry? }
 * @returns {Promise<PublicationPackage>}
 */
export async function buildPackage(kind, id, details = {}) {
  const graph = await rebuildReferenceGraph({ fresh: true });
  const primitives = await collectWorkspacePrimitives({});
  const { bodies, kinds } = indexPrimitives(primitives);

  const rootBody = bodies.get(id);
  if (!rootBody) throw new Error(`publish: ${kind} ${id} not found in workspace`);

  const publicationId = newPublicationId();
  const manifest = buildManifest({
    publicationId,
    root: { id, type: kind },
    graph,
    bodies,
    resolveDep: publishResolveDep(kinds),
  });

  const publishedBy = await getLocalUserRef();
  const publication = buildPublication({
    manifest,
    publishedBy,
    details: { title: details.title || id, ...details },
  });

  const bundledDepIds = manifest.dependencies
    .filter((d) => d.resolution === 'bundled')
    .map((d) => d.primitiveId);
  const packages = {
    primary: rootBody,
    dependencies: bundledDepIds.map((bid) => bodies.get(bid)).filter((b) => b !== undefined),
  };

  return { publication, manifest, packages };
}

/**
 * Sign the package's bundleHash with the device key (§9 trust). Importers verify against
 * publication.publishedBy.publicKey. Mutates + returns the package.
 * @param {PublicationPackage} pkg
 * @returns {Promise<PublicationPackage>}
 */
export async function signPackage(pkg) {
  const signature = await signMessage(pkg.manifest.bundleHash);
  pkg.publication.signature = signature;
  pkg.publication.signatureAlgorithm = 'Ed25519';
  return pkg;
}

/** Persist an outgoing publication package to the local publications partition. */
export async function persistOutgoing(pkg) {
  const id = pkg.publication.publicationId;
  await setKey(outKey(id), pkg);
  const idx = /** @type {string[]} */ ((await getKey(OUT_INDEX_KEY)) || []);
  if (!idx.includes(id)) { idx.push(id); await setKey(OUT_INDEX_KEY, idx); }
}

/** @returns {Promise<object[]>} */
export async function listOutgoingPublications() {
  const idx = /** @type {string[]} */ ((await getKey(OUT_INDEX_KEY)) || []);
  const out = [];
  for (const id of idx) {
    const pkg = /** @type {any} */ (await getKey(outKey(id)));
    if (pkg?.publication) out.push(pkg.publication);
  }
  return out;
}

/** @param {string} publicationId @returns {Promise<PublicationPackage|null>} */
export async function getOutgoingPublication(publicationId) {
  return /** @type {any} */ ((await getKey(outKey(publicationId))) || null);
}

/**
 * Publish a primitive: build → sign → persist locally. Registry upload is a later slice.
 * @param {string} kind @param {string} id @param {object} [details]
 * @returns {Promise<object>} the signed Publication metadata
 */
export async function publishPrimitive(kind, id, details = {}) {
  const pkg = await buildPackage(kind, id, details);
  await signPackage(pkg);
  await persistOutgoing(pkg);

  // Ensure the current device key is registered with the cloud before upload. The registry's
  // anti-impersonation check requires the package signer key to be a bound device key; the cloud
  // bind otherwise only runs on explicit sign-in, so a key established/rotated since the last bind
  // would 403 (publisher_key_mismatch). tryBindIdentity is idempotent and best-effort (offline /
  // signed-out → skipped, falls through to the local-only save below).
  try { await tryBindIdentity(); }
  catch (e) { Logger.warn('PublicationStore', `pre-publish bind: ${e.message}`); }

  // Best-effort registry upload (AWS_INTEGRATION §7.4). Requires cloud sign-in + the deployed
  // /publications endpoint; on failure the signed local copy is kept and can be re-uploaded later.
  let registry = null;
  try {
    registry = await publishToRegistry(pkg);
    Logger.info('PublicationStore', `uploaded ${pkg.publication.publicationId} to registry ${registry?.registry ?? '?'}`);
  } catch (e) {
    Logger.warn('PublicationStore', `registry upload deferred (${e.message}); local copy saved`);
  }

  Logger.info(
    'PublicationStore',
    `published ${kind} ${id} → ${pkg.publication.publicationId} `
    + `(${pkg.packages.dependencies.length} bundled dep(s); ${registry ? 'uploaded' : 'local-only'})`,
  );
  return { ...pkg.publication, uploaded: !!registry };
}
