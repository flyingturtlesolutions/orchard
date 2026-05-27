/**
 * @file Core/referenceExtraction.js
 * @description Type-specific outbound-reference extraction (STORAGE_SCHEMA §7, §10 reference ops).
 *   Turns a stored primitive into the OutboundRef[] that Core/referenceGraph.js inverts into the
 *   integrity graph. Pure + I/O-free so it runs identically on the local synchronous-rebuild path
 *   and a cloud worker rebuild (DD-06: refs are client-rebuilt, not synced).
 *
 *   Every emit predicate keys off an UNAMBIGUOUS field (`type:'assertion_ref'`, `landmarkRef.uid`,
 *   `fragmentId`, …), so the deep-walk can't fabricate edges regardless of how a primitive nests.
 *   Edge shapes mirror the authoritative Services/LandmarkImpactAnalysis.js so inbound-landmark
 *   results stay identical.
 *
 *   Covered edges:
 *     • ALL primitives — pre/post condition refs → perspective ('perspective-ref') / assertion ('assertion-ref')
 *     • assertion     — body condition refs (named assertion → assertion/perspective)
 *     • ground        — perspectiveIds[] → perspective ('composition')
 *     • fragment      — rawJson actions: landmarkRef.uid → landmark ('action-target'); gate conditions → assertion/perspective
 *     • observation   — extracts: landmarkRef.uid → landmark ('extraction-target'); extract gates → assertion/perspective
 *     • perspective   — landmarkRefs[] → landmark ('composition')
 *     • strategy      — fragmentSteps tree: fragmentId ('fragment-invoke'), observationId ('observation-ref'),
 *                       analysisId ('analysis-ref'), strategyId ('invoke')  [analysis/strategy are forward-safe]
 *     • workflow      — steps[]: strategyId ('invoke')  [future-safe; steps[] empty today]
 *
 *   Deliberate NON-edges (verified absent as id refs; never invented): Ground→Locale,
 *   Perspective→Locale, Workflow→Strategy-by-default (steps[] is empty until cross-Ground composition ships).
 *
 * @see ./referenceGraph.js
 * @see ../Services/LandmarkImpactAnalysis.js
 * @see ../schemas/orchard/STORAGE_SCHEMA_REVISED.md §7
 */

/** @typedef {import('./referenceGraph.js').OutboundRef} OutboundRef */

const MAX_WALK_DEPTH = 24;

/**
 * Visit every object node within `root` (recursing arrays + object values), invoking
 * `visit(node, path)`. Bounded depth; shape-agnostic.
 * @param {unknown} root
 * @param {string} viaBase   path prefix (e.g. 'pre', 'rawJson')
 * @param {(node: Record<string, unknown>, path: string) => void} visit
 */
function deepWalkObjects(root, viaBase, visit) {
  /** @param {unknown} node @param {string} path @param {number} depth */
  function walk(node, path, depth) {
    if (!node || typeof node !== 'object' || depth > MAX_WALK_DEPTH) return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`, depth + 1));
      return;
    }
    const obj = /** @type {Record<string, unknown>} */ (node);
    visit(obj, path);
    for (const key of Object.keys(obj)) {
      walk(obj[key], path ? `${path}.${key}` : key, depth + 1);
    }
  }
  walk(root, viaBase, 0);
}

/**
 * Emit refs for `perspective_ref` / `assertion_ref` condition nodes anywhere within `root`.
 * @param {unknown} root @param {string} viaBase @param {OutboundRef[]} out
 */
export function extractConditionRefs(root, viaBase, out) {
  deepWalkObjects(root, viaBase, (obj, path) => {
    if (obj.type === 'perspective_ref' && obj.perspectiveId) {
      out.push({ to: String(obj.perspectiveId), kind: 'perspective-ref', via: [path] });
    } else if (obj.type === 'assertion_ref' && obj.assertionId) {
      out.push({ to: String(obj.assertionId), kind: 'assertion-ref', via: [path] });
    }
  });
}

/**
 * Emit landmark refs for embedded `{ landmarkRef: { uid } }` nodes anywhere within `root`.
 * @param {unknown} root @param {string} viaBase @param {string} kind  e.g. 'action-target' @param {OutboundRef[]} out
 */
export function extractLandmarkRefs(root, viaBase, kind, out) {
  deepWalkObjects(root, viaBase, (obj, path) => {
    const ref = /** @type {{ uid?: unknown }} */ (obj.landmarkRef);
    if (ref && typeof ref === 'object' && ref.uid) {
      out.push({ to: String(ref.uid), kind, via: [path] });
    }
  });
}

/**
 * Emit invoke refs for composition-tree nodes carrying a primitive id field.
 * @param {unknown} root @param {string} viaBase @param {OutboundRef[]} out
 */
export function extractInvokeRefs(root, viaBase, out) {
  deepWalkObjects(root, viaBase, (obj, path) => {
    if (obj.fragmentId)    out.push({ to: String(obj.fragmentId), kind: 'fragment-invoke', via: [path] });
    if (obj.observationId) out.push({ to: String(obj.observationId), kind: 'observation-ref', via: [path] });
    if (obj.analysisId)    out.push({ to: String(obj.analysisId), kind: 'analysis-ref', via: [path] });
    if (obj.strategyId)    out.push({ to: String(obj.strategyId), kind: 'invoke', via: [path] });
  });
}

/** Parse a fragment's rawJson (string|array) into an actions array. @returns {unknown[]} */
function parseActions(rawJson) {
  if (Array.isArray(rawJson)) return rawJson;
  if (typeof rawJson === 'string') {
    try { const v = JSON.parse(rawJson); return Array.isArray(v) ? v : []; } catch { return []; }
  }
  return [];
}

/**
 * Extract every outbound reference from one stored primitive.
 * @param {string} kind        SyncKind ('ground'|'fragment'|'observation'|'analysis'|'assertion'|'perspective'|'landmark'|'workflow'|'strategy'|…)
 * @param {Record<string, unknown>} primitive   the domain body (unwrapped, not the envelope)
 * @returns {OutboundRef[]}
 */
export function extractOutboundRefs(kind, primitive) {
  /** @type {OutboundRef[]} */
  const out = [];
  if (!primitive || typeof primitive !== 'object') return out;

  // Cross-cutting: every primitive's contract may carry pre/post condition refs.
  if ('pre' in primitive) extractConditionRefs(primitive.pre, 'pre', out);
  if ('post' in primitive) extractConditionRefs(primitive.post, 'post', out);

  switch (kind) {
    case 'assertion':
      // Named assertion's condition tree lives in `body`.
      if ('body' in primitive) extractConditionRefs(primitive.body, 'body', out);
      break;

    case 'ground':
      if (Array.isArray(primitive.perspectiveIds)) {
        primitive.perspectiveIds.forEach((pid, i) => {
          if (pid) out.push({ to: String(pid), kind: 'composition', via: [`perspectiveIds[${i}]`] });
        });
      }
      break;

    case 'fragment': {
      // rawJson actions reference landmarks by uid; gate actions may carry condition refs.
      const actions = parseActions(primitive.rawJson);
      extractLandmarkRefs(actions, 'rawJson', 'action-target', out);
      extractConditionRefs(actions, 'rawJson', out);
      break;
    }

    case 'observation':
      // extracts reference landmarks by uid; extract gates may carry condition refs.
      extractLandmarkRefs(primitive.extracts, 'extracts', 'extraction-target', out);
      extractConditionRefs(primitive.extracts, 'extracts', out);
      break;

    case 'perspective':
      if (Array.isArray(primitive.landmarkRefs)) {
        primitive.landmarkRefs.forEach((uid, i) => {
          if (uid) out.push({ to: String(uid), kind: 'composition', via: [`landmarkRefs[${i}]`] });
        });
      }
      break;

    case 'strategy':
      // Canonical composition tree under implementations[].body.tree.fragmentSteps; legacy flat mirror.
      if (Array.isArray(primitive.implementations) && primitive.implementations.length) {
        extractInvokeRefs(primitive.implementations, 'implementations', out);
      } else if (Array.isArray(primitive.fragmentSteps)) {
        extractInvokeRefs(primitive.fragmentSteps, 'fragmentSteps', out);
      }
      break;

    case 'workflow':
      // steps[] is empty until cross-Ground strategy composition ships; future-safe.
      if (Array.isArray(primitive.steps)) extractInvokeRefs(primitive.steps, 'steps', out);
      break;

    default:
      break;
  }

  return dedupeRefs(out);
}

/**
 * Build the PrimitiveRefs entry the graph builder consumes.
 * @param {string} kind
 * @param {Record<string, unknown>} primitive   must carry an id (or uid/localeKey) + groundId
 * @returns {import('./referenceGraph.js').PrimitiveRefs|null}
 */
export function primitiveRefsFor(kind, primitive) {
  if (!primitive || typeof primitive !== 'object') return null;
  const id = String(primitive.id || primitive.uid || primitive.localeKey || '');
  if (!id) return null;
  const groundId = primitive.groundId ? String(primitive.groundId) : undefined;
  return { primitiveId: id, groundId, references: extractOutboundRefs(kind, primitive) };
}

/** Collapse identical (to,kind,via) edges. @param {OutboundRef[]} refs @returns {OutboundRef[]} */
function dedupeRefs(refs) {
  const seen = new Set();
  /** @type {OutboundRef[]} */
  const out = [];
  for (const r of refs) {
    const key = `${r.to} ${r.kind} ${(r.via || []).join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
