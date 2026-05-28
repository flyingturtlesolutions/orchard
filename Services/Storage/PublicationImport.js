/**
 * @file Services/Storage/PublicationImport.js
 * @description Import-apply flow (STORAGE_SCHEMA §9 import side). Verifies a publication's
 *   signature, builds the import plan (Core/publicationImport), remaps references to fresh local
 *   ids, writes the bundled primitives into the workspace (StorageManager), and records lineage +
 *   an incoming-publication record. Consumes a publication package (from local outgoing today; from
 *   the registry once those endpoints land). The reconciliation/remap logic is the tested pure core;
 *   this is the thin I/O glue.
 *
 * @see ../../Core/publicationImport.js
 * @see ../../Core/OrchardIdentity.js  (verifyMessage)
 */

import { Logger } from '../../Core/Logger.js';
import { buildImportPlan, remapReferences } from '../../Core/publicationImport.js';
import { verifyMessage } from '../../Core/OrchardIdentity.js';
import { StorageManager } from '../StorageManager.js';
import { recordExternalUserEncounter } from './IdentityStore.js';
import { fetchPublicationUpdates, requestPublicationImport, fetchPublication } from '../Cloud/CloudClient.js';

const IN_INDEX_KEY = 'publications:incoming:index';
const inKey = (id) => `publications:incoming:${id}`;
const lineageKey = (id) => `refs:lineage:${id}`;

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

/** primitiveType → StorageManager saver (imported primitives are fresh local creations). */
const SAVERS = {
  ground: (b) => StorageManager.saveGround(b),
  fragment: (b) => StorageManager.saveFragment(b),
  observation: (b) => StorageManager.saveObservation(b),
  analysis: (b) => StorageManager.saveAnalysis(b),
  assertion: (b) => StorageManager.saveAssertion(b),
  perspective: (b) => StorageManager.savePerspective(b),
  landmark: (b) => StorageManager.saveLandmark(b),
  workflow: (b) => StorageManager.saveWorkflow(b),
  strategy: (b) => StorageManager.saveStrategy(b),
};

/** @param {string} id @returns {Promise<boolean>} */
async function landmarkPresent(id) {
  return !!(await StorageManager.getLandmark(id));
}

/** @param {string} pubRef @returns {Promise<boolean>} */
async function incomingPublicationPresent(pubRef) {
  return !!(await getKey(inKey(pubRef)));
}

/** Index the package's bundled bodies by their publisher id (id / uid / localeKey). */
function bundledBodyIndex(pkg) {
  /** @type {Map<string, Record<string, unknown>>} */
  const map = new Map();
  const add = (b) => {
    if (!b || typeof b !== 'object') return;
    const id = String(b.id ?? b.uid ?? b.localeKey ?? '');
    if (id) map.set(id, b);
  };
  add(pkg?.packages?.primary);
  for (const d of pkg?.packages?.dependencies || []) add(d);
  return map;
}

/**
 * Import a publication package into the local workspace.
 * @param {object} pkg   { publication, manifest, packages }
 * @param {{ targetGroundId?: string, requireSignature?: boolean }} [opts]
 *   targetGroundId required when the primary is NOT a ground (where to home the imported primitive).
 * @returns {Promise<{ ok: boolean, plan?: object, installedIds?: string[], error?: string,
 *   missingCanonical?: string[], missingPublications?: string[] }>}
 */
export async function importPublicationPackage(pkg, opts = {}) {
  const publication = pkg?.publication;
  const manifest = pkg?.manifest;
  if (!publication || !manifest) return { ok: false, error: 'invalid package' };

  // 1. Verify signature (§9 step 1). Required when present; absent is allowed unless requireSignature.
  const signerKey = publication.publishedBy?.publicKey;
  if (publication.signature) {
    const valid = signerKey
      && await verifyMessage(signerKey, manifest.bundleHash, publication.signature);
    if (!valid) return { ok: false, error: 'signature verification failed' };
  } else if (opts.requireSignature) {
    return { ok: false, error: 'unsigned publication' };
  }

  // 2. Plan. buildImportPlan's idMap is presence-independent, so we build it plainly here and
  // recompute the dependency blockers just below with the real (async) local-state checks.
  const plan = buildImportPlan({ manifest });
  const canonicalIds = plan.items.filter((i) => i.action === 'match-canonical').map((i) => i.publicId);
  const pubRefs = (manifest.dependencies || [])
    .filter((d) => d.resolution === 'reference-publication')
    .map((d) => d.publicationReference).filter(Boolean);
  const missingCanonical = [];
  for (const id of canonicalIds) if (!(await landmarkPresent(id))) missingCanonical.push(id);
  const missingPublications = [];
  for (const ref of pubRefs) if (!(await incomingPublicationPresent(ref))) missingPublications.push(ref);
  if (missingCanonical.length || missingPublications.length) {
    return { ok: false, error: 'unsatisfied dependencies', missingCanonical, missingPublications };
  }

  // 3. Ground-id mapping for a non-ground primary (home the import in the chosen ground).
  const primaryIsGround = manifest.primary.primitiveType === 'ground';
  if (!primaryIsGround) {
    if (!opts.targetGroundId) return { ok: false, error: 'targetGroundId required for non-ground import' };
    const publisherGroundId = pkg.packages?.primary?.groundId;
    if (publisherGroundId) plan.idMap[String(publisherGroundId)] = opts.targetGroundId;
  }

  // 4. Write each installable primitive with remapped references + fresh local id.
  const bodyIndex = bundledBodyIndex(pkg);
  const installedIds = [];
  for (const item of plan.items) {
    if (item.action !== 'install') continue;          // match-canonical/require-publication: no write
    const src = bodyIndex.get(item.publisherId);
    if (!src) { Logger.warn('PublicationImport', `bundled body missing for ${item.publisherId}`); continue; }
    const saver = SAVERS[item.primitiveType];
    if (!saver) { Logger.warn('PublicationImport', `no saver for ${item.primitiveType}`); continue; }

    const remapped = remapReferences(item.primitiveType, src, plan.idMap);
    // Stamp the fresh local id (id, or uid for landmarks — though landmarks are canonical, not bundled).
    if (item.primitiveType === 'landmark') remapped.uid = item.localId;
    else remapped.id = item.localId;
    await saver(remapped);
    installedIds.push(item.localId);

    // 5. Lineage (§9 step 5 / refs/lineage).
    await setKey(lineageKey(item.localId), {
      primitiveId: item.localId,
      isImported: true,
      sourcePublicationId: publication.publicationId,
      sourcePublicId: item.publicId,
      sourceExternalUser: publication.publishedBy || null,
      importedAt: Date.now(),
    });
  }

  // 6. Record the publisher as a known external user (trust graph), best-effort.
  if (signerKey) {
    try { await recordExternalUserEncounter(signerKey, { declaredProfile: { } }); } catch { /* best-effort */ }
  }

  // 7. Incoming publication record + importedTo mapping.
  const importedTo = Object.fromEntries(
    plan.items.filter((i) => i.action === 'install').map((i) => [i.publisherId, i.localId]),
  );
  await setKey(inKey(publication.publicationId), {
    publication, importedTo, localModifications: {}, importedAt: Date.now(),
  });
  const idx = /** @type {string[]} */ ((await getKey(IN_INDEX_KEY)) || []);
  if (!idx.includes(publication.publicationId)) { idx.push(publication.publicationId); await setKey(IN_INDEX_KEY, idx); }

  Logger.info('PublicationImport',
    `imported ${publication.publicationId}: ${installedIds.length} primitive(s) installed`);
  return { ok: true, plan, installedIds };
}

/** @returns {Promise<object[]>} incoming publication metadata records */
export async function listIncomingPublications() {
  const idx = /** @type {string[]} */ ((await getKey(IN_INDEX_KEY)) || []);
  const out = [];
  for (const id of idx) {
    const rec = /** @type {any} */ (await getKey(inKey(id)));
    if (rec?.publication) out.push(rec.publication);
  }
  return out;
}

/** @param {string} primitiveId @returns {Promise<object|null>} lineage record */
export async function getLineage(primitiveId) {
  return /** @type {any} */ ((await getKey(lineageKey(primitiveId))) || null);
}

// ── Update flow (STORAGE_SCHEMA §9 / AWS_INTEGRATION §7.4, DD-12 B) ─────────────────────

/**
 * Check the registry for newer versions in this publication's lineage and stamp the result on
 * the incoming record's `updateNotifications`. Returns the newer versions (empty if up to date).
 * @param {string} publicationId   an imported (incoming) publication id
 * @returns {Promise<{ ok: boolean, updates?: object[], error?: string }>}
 */
export async function checkForUpdates(publicationId) {
  const rec = /** @type {any} */ (await getKey(inKey(publicationId)));
  if (!rec?.publication) return { ok: false, error: 'not an imported publication' };
  let res;
  try { res = await fetchPublicationUpdates(publicationId); }
  catch (e) { return { ok: false, error: e.message }; }
  const updates = Array.isArray(res?.updates) ? res.updates : [];
  rec.updateNotifications = { checkedAt: Date.now(), updates };
  await setKey(inKey(publicationId), rec);
  return { ok: true, updates };
}

/**
 * Apply an available update: fetch the newer publication (server-verified), import it as a fresh
 * incoming record (new local primitives per DD-12 B lineage), and clear the source record's
 * pending notifications. A field-level merge into the existing import is deferred (§9 future work).
 * @param {string} fromPublicationId   the currently-imported publication
 * @param {string} toPublicationId     the newer publication to apply
 * @param {{ targetGroundId?: string }} [opts]
 * @returns {Promise<{ ok: boolean, installedIds?: string[], error?: string }>}
 */
export async function applyUpdate(fromPublicationId, toPublicationId, opts = {}) {
  if (!toPublicationId) return { ok: false, error: 'toPublicationId required' };
  // Prefer the server-verified import endpoint; fall back to a plain fetch.
  let pkg;
  try { pkg = await requestPublicationImport(toPublicationId); }
  catch (e1) {
    try { pkg = await fetchPublication(toPublicationId); }
    catch (e2) { return { ok: false, error: `fetch ${toPublicationId}: ${e2.message}` }; }
  }
  if (!pkg?.manifest) return { ok: false, error: 'update package not found' };

  const result = await importPublicationPackage(pkg, { targetGroundId: opts.targetGroundId });
  if (!result.ok) return result;

  // Clear the source record's pending notifications now that a newer version is installed.
  const rec = /** @type {any} */ (await getKey(inKey(fromPublicationId)));
  if (rec) {
    rec.updateNotifications = { checkedAt: Date.now(), updates: [], appliedTo: toPublicationId };
    await setKey(inKey(fromPublicationId), rec);
  }
  Logger.info('PublicationImport', `applied update ${fromPublicationId} → ${toPublicationId}`);
  return result;
}
