/**
 * @file Services/Storage/ReferenceStore.js
 * @description The refs/ partition, rebuilt on demand from the workspace (STORAGE_SCHEMA §7, §10
 *   reference ops; DD-06). The reference graph is DERIVED — never a source of truth and not synced —
 *   so this service collects every workspace primitive via StorageManager, extracts outbound refs
 *   (Core/referenceExtraction), and builds the queryable graph (Core/referenceGraph).
 *
 *   Rebuild-on-demand (no persisted refs store, no write-path hooks) is the deliberate fresh-start
 *   choice: it's always consistent with the workspace and adds zero transactional coupling. A short
 *   in-memory memo avoids rebuilding on back-to-back queries; mutators call invalidateReferenceGraph()
 *   (or pass { fresh:true }). For very large workspaces a persisted refs store is a later optimization
 *   — the §7 contract explicitly permits eventual-consistency rebuilds.
 *
 * @see ../../Core/referenceGraph.js
 * @see ../../Core/referenceExtraction.js
 */

import { StorageManager } from '../StorageManager.js';
import { primitiveRefsFor } from '../../Core/referenceExtraction.js';
import {
  buildReferenceGraph,
  getOutboundReferences as graphOutbound,
  getInboundReferences as graphInbound,
  detectCycles as graphDetectCycles,
  findOrphans as graphFindOrphans,
  analyzeDeletionImpact as graphAnalyzeImpact,
} from '../../Core/referenceGraph.js';

/** @typedef {import('../../Core/referenceGraph.js').ReferenceGraph} ReferenceGraph */
/** @typedef {{ kind: string, body: Record<string, unknown> }} KindedPrimitive */

const MEMO_TTL_MS = 1500;   // coalesce bursts of queries from one user action

/** @type {{ key: string, at: number, graph: ReferenceGraph }|null} */
let _memo = null;

/** Drop the cached graph (call after any primitive write/deprecate/delete). */
export function invalidateReferenceGraph() {
  _memo = null;
}

/**
 * Collect every workspace primitive (optionally scoped to one Ground) as { kind, body } pairs,
 * with the correct §7 kind label so extraction can dispatch type-specific walks.
 * @param {{ groundId?: string }} [scope]
 * @returns {Promise<KindedPrimitive[]>}
 */
export async function collectWorkspacePrimitives(scope = {}) {
  const grounds = await StorageManager.getAllGrounds();
  /** @type {KindedPrimitive[]} */
  const out = [];

  for (const ground of grounds) {
    if (scope.groundId && ground.id !== scope.groundId) continue;
    out.push({ kind: 'ground', body: /** @type {Record<string, unknown>} */ (ground) });
    const gid = ground.id;
    const [fragments, observations, analyses, assertions, perspectives, landmarks, strategies] =
      await Promise.all([
        StorageManager.listFragments(gid),
        StorageManager.listObservations(gid),
        StorageManager.listAnalyses(gid),
        StorageManager.listAssertions(gid),
        StorageManager.listPerspectives(gid),
        StorageManager.listLandmarksForGround(gid),
        StorageManager.listStrategies(gid),
      ]);
    for (const r of fragments)    out.push({ kind: 'fragment', body: r });
    for (const r of observations) out.push({ kind: 'observation', body: r });
    for (const r of analyses)     out.push({ kind: 'analysis', body: r });
    for (const r of assertions)   out.push({ kind: 'assertion', body: r });
    for (const r of perspectives) out.push({ kind: 'perspective', body: r });
    for (const r of landmarks)    out.push({ kind: 'landmark', body: r });
    for (const r of strategies)   out.push({ kind: 'strategy', body: r });
  }

  // Workflows are global (not Ground-scoped). Include them on a full rebuild only.
  if (!scope.groundId) {
    try {
      const workflows = await StorageManager.listWorkflows();
      for (const r of workflows) out.push({ kind: 'workflow', body: r });
    } catch { /* listWorkflows may be absent in some builds */ }
  }

  return out;
}

/**
 * Build the reference graph from a set of { kind, body } primitives. Pure composition of the two
 * Core helpers — separated for unit-testing without StorageManager/IndexedDB.
 * @param {KindedPrimitive[]} primitives
 * @returns {ReferenceGraph}
 */
export function buildGraphFromPrimitives(primitives) {
  const refsList = (primitives || [])
    .map(({ kind, body }) => primitiveRefsFor(kind, body))
    .filter(Boolean);
  return buildReferenceGraph(/** @type {any} */ (refsList));
}

/**
 * Rebuild (or return memoized) the reference graph from the live workspace.
 * @param {{ groundId?: string, fresh?: boolean }} [opts]
 * @returns {Promise<ReferenceGraph>}
 */
export async function rebuildReferenceGraph(opts = {}) {
  const key = opts.groundId || '*';
  if (!opts.fresh && _memo && _memo.key === key && (Date.now() - _memo.at) < MEMO_TTL_MS) {
    return _memo.graph;
  }
  const primitives = await collectWorkspacePrimitives({ groundId: opts.groundId });
  const graph = buildGraphFromPrimitives(primitives);
  _memo = { key, at: Date.now(), graph };
  return graph;
}

// ── §10 reference operations (workspace-backed) ──────────────────────────────────────

/** @param {string} id @param {{ groundId?: string }} [opts] */
export async function getOutboundReferences(id, opts = {}) {
  return graphOutbound(await rebuildReferenceGraph(opts), id);
}

/** @param {string} id @param {{ groundId?: string }} [opts] */
export async function getInboundReferences(id, opts = {}) {
  return graphInbound(await rebuildReferenceGraph(opts), id);
}

/** @param {{ groundId?: string }} [opts] */
export async function detectCycles(opts = {}) {
  return graphDetectCycles(await rebuildReferenceGraph(opts));
}

/**
 * @param {{ groundId?: string, isRoot?: (id: string) => boolean }} [opts]
 *   isRoot defaults to treating Grounds (gnd_ / grounds) as roots so they're never "orphans".
 */
export async function findOrphans(opts = {}) {
  const isRoot = opts.isRoot || ((id) => String(id).startsWith('gnd_'));
  return graphFindOrphans(await rebuildReferenceGraph(opts), { isRoot });
}

/**
 * "What breaks if I delete this?" — §10 analyzeDeletionImpact. Pass predicates for blockers
 * (active execution / publication primary / canonical import) as those live outside the ref graph.
 * @param {string} id
 * @param {{
 *   groundId?: string, computeCascade?: boolean,
 *   isCanonicalImport?: (id: string) => boolean,
 *   hasActiveExecution?: (id: string) => boolean,
 *   isPublicationPrimary?: (id: string) => boolean,
 * }} [opts]
 */
export async function analyzeDeletionImpact(id, opts = {}) {
  // Always rebuild fresh: this gates destructive deletes, so it must reflect the live workspace.
  const graph = await rebuildReferenceGraph({ groundId: opts.groundId, fresh: true });
  return graphAnalyzeImpact(graph, id, {
    computeCascade: opts.computeCascade ?? true,
    isCanonicalImport: opts.isCanonicalImport,
    hasActiveExecution: opts.hasActiveExecution,
    isPublicationPrimary: opts.isPublicationPrimary,
  });
}
