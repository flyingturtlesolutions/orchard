/**
 * @file Services/Storage/StoragePaths.js
 * @description Legacy chrome.storage keys ↔ Orchard logical paths (§19.2).
 */

/** @typedef {'ground'|'fragment'|'observation'|'analysis'|'assertion'|'perspective'|'landmark'|'strategy'|'workflow'|'locale'|'siteMap'|'chrome'|'goalMemory'|'canvas'} SyncKind */

/** @type {SyncKind[]} */
export const SYNCABLE_KINDS = [
  'ground',
  'fragment',
  'observation',
  'analysis',
  'assertion',
  'perspective',
  'landmark',
  'strategy',
  'workflow',
  'locale',
  'siteMap',
  'chrome',
  // AL-3 (v2.74.1192) — per-app goal memory. DECLARED syncable + path-registered HERE (the storage contract); cloud
  // sync stays OFF until ACTIVATED additively (no data/store change): KIND_ALIASES + loadRecord (Services/Sync/
  // SyncBridge.js) and isWorkspacePartitionKind (Services/Storage/WorkspacePartitionStore.js). SyncBridge early-returns
  // on any kind absent from KIND_ALIASES, so this entry is inert (local-only) until then — the safe default for the
  // user's learned work-beliefs.
  'goalMemory',
  // CA-3 (v2.74.1204) — per-anchor canvas docs (the app presentation layer, DESIGN_canvas.md §3). Same filter-gated
  // pattern as goalMemory: declared syncable + path-registered, but cloud sync stays OFF until additively activated
  // (KIND_ALIASES + loadRecord; isWorkspacePartitionKind). Inert/local-only until then.
  'canvas',
];

const LEGACY_PREFIX = {
  ground: 'grounds',
  fragment: 'fragments',
  observation: 'observations',
  analysis: 'analyses',
  assertion: 'assertions',
  perspective: 'perspectives',
  landmark: 'landmarks',
  strategy: 'strategies',
  workflow: 'workflows',
};

/**
 * @param {string} segment
 */
export function encodePathSegment(segment) {
  return encodeURIComponent(segment);
}

/**
 * @param {string} segment
 */
export function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * @param {SyncKind} kind
 * @param {string} id
 */
export function legacyStorageKey(kind, id) {
  const prefix = LEGACY_PREFIX[kind];
  if (!prefix) throw new Error(`Unknown sync kind: ${kind}`);
  return `${prefix}:${id}`;
}

/**
 * @param {SyncKind} kind
 * @param {Record<string, unknown>} record
 * @returns {string|null}
 */
export function logicalPathForRecord(kind, record) {
  const id = String(record.id || '');
  if (!id && kind !== 'siteMap' && kind !== 'chrome') return null;

  switch (kind) {
    case 'ground':
      return `workspace/grounds/${id}/ground.json`;
    case 'fragment':
      return `workspace/grounds/${record.groundId}/tier1/fragments/${id}.json`;
    case 'observation':
      return `workspace/grounds/${record.groundId}/tier1/observations/${id}.json`;
    case 'analysis':
      return `workspace/grounds/${record.groundId}/tier1/analyses/${id}.json`;
    case 'assertion':
      return `workspace/grounds/${record.groundId}/tier1/assertions/${id}.json`;
    case 'perspective':
      return `workspace/grounds/${record.groundId}/perspectives/${id}/perspective.json`;
    case 'landmark':
      return `workspace/grounds/${record.groundId}/substrate/landmarks/${record.uid || id}.json`;
    case 'strategy':
      return `workspace/grounds/${record.groundId}/workflows/${id}.json`;
    case 'workflow':
      return `workspace/strategies/${id}/strategy.json`;
    case 'locale': {
      const groundId = String(record.groundId || '');
      const localeKey = String(record.localeKey || record.id || '');
      if (!groundId || !localeKey) return null;
      return `workspace/grounds/${groundId}/locales/${encodePathSegment(localeKey)}/locale.json`;
    }
    case 'siteMap':
    case 'chrome': {
      const groundId = String(record.groundId || id || '');
      if (!groundId) return null;
      return kind === 'siteMap'
        ? `workspace/grounds/${groundId}/siteMap.json`
        : `workspace/grounds/${groundId}/chrome.json`;
    }
    case 'goalMemory': {
      // AL-3 — per-app goal memory lives OUTSIDE the per-ground tree (it's keyed by appId, not groundId).
      const appId = String(record.appId || id || '');
      if (!appId) return null;
      return `workspace/appMemory/${encodePathSegment(appId)}/goalMemory.json`;
    }
    case 'canvas': {
      // CA-3 — a per-anchor canvas doc lives under its owning app's memory area, keyed by canvasDocId.
      const appId = String(record.appId || '');
      const docId = String(record.docId || id || '');
      if (!appId || !docId) return null;
      return `workspace/appMemory/${encodePathSegment(appId)}/canvas/${encodePathSegment(docId)}.json`;
    }
    default:
      return null;
  }
}

/**
 * @param {string} logicalPath
 * @returns {{ kind: SyncKind|'manifest', id: string, groundId?: string }|null}
 */
export function recordMetaFromPath(logicalPath) {
  let m;
  // Manifest: a derived per-ground index. Not a savable primitive (pull skips it), but it must
  // reverse-map to its groundId so write-routing (e.g. team-ground wsId derivation on a keep-mine
  // conflict re-push) doesn't lose the ground association and mis-route to the personal namespace.
  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/_manifest\.json$/);
  if (m) return { kind: 'manifest', id: m[1], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/ground\.json$/);
  if (m) return { kind: 'ground', id: m[1], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/siteMap\.json$/);
  if (m) return { kind: 'siteMap', id: m[1], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/chrome\.json$/);
  if (m) return { kind: 'chrome', id: m[1], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/locales\/([^/]+)\/locale\.json$/);
  if (m) return { kind: 'locale', id: decodePathSegment(m[2]), groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/tier1\/fragments\/([^/]+)\.json$/);
  if (m) return { kind: 'fragment', id: m[2], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/tier1\/observations\/([^/]+)\.json$/);
  if (m) return { kind: 'observation', id: m[2], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/tier1\/analyses\/([^/]+)\.json$/);
  if (m) return { kind: 'analysis', id: m[2], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/tier1\/assertions\/([^/]+)\.json$/);
  if (m) return { kind: 'assertion', id: m[2], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/perspectives\/([^/]+)\/perspective\.json$/);
  if (m) return { kind: 'perspective', id: m[2], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/substrate\/landmarks\/([^/]+)\.json$/);
  if (m) return { kind: 'landmark', id: m[2], groundId: m[1] };

  m = logicalPath.match(/^workspace\/grounds\/([^/]+)\/workflows\/([^/]+)\.json$/);
  if (m) return { kind: 'strategy', id: m[2], groundId: m[1] };

  m = logicalPath.match(/^workspace\/strategies\/([^/]+)\/strategy\.json$/);
  if (m) return { kind: 'workflow', id: m[1] };

  m = logicalPath.match(/^workspace\/appMemory\/([^/]+)\/goalMemory\.json$/);   // AL-3 — per-app goal memory
  if (m) return { kind: 'goalMemory', id: decodePathSegment(m[1]), appId: decodePathSegment(m[1]) };

  m = logicalPath.match(/^workspace\/appMemory\/([^/]+)\/canvas\/([^/]+)\.json$/);   // CA-3 — per-anchor canvas doc
  if (m) return { kind: 'canvas', id: decodePathSegment(m[2]), appId: decodePathSegment(m[1]) };

  return null;
}

/**
 * @param {string} groundId
 */
export function manifestPath(groundId) {
  return `workspace/grounds/${groundId}/_manifest.json`;
}

/**
 * @param {string} logicalPath
 * @returns {number}
 */
export function conflictTierForPath(logicalPath) {
  if (logicalPath.endsWith('/_manifest.json')) return 2;
  if (logicalPath.endsWith('/siteMap.json') || logicalPath.endsWith('/chrome.json')) return 2;
  if (logicalPath.includes('/workflows/') && logicalPath.endsWith('.json')) return 2;
  if (logicalPath.includes('workspace/strategies/')) return 3;
  if (logicalPath.endsWith('/ground.json')) return 2;
  if (logicalPath.includes('/intents/')) return 2;
  return 1;
}

/**
 * Tier-1 paths eligible for silent auto-LWW (DD-03).
 * @param {string} logicalPath
 */
export function isAutoLwwPath(logicalPath) {
  if (conflictTierForPath(logicalPath) >= 2) return false;
  return (
    /\/tier1\/(fragments|observations|assertions|analyses)\/[^/]+\.json$/.test(logicalPath)
    || /\/substrate\/landmarks\/[^/]+\.json$/.test(logicalPath)
    || /\/perspectives\/[^/]+\/perspective\.json$/.test(logicalPath)
    || /\/locales\/[^/]+\/locale\.json$/.test(logicalPath)
  );
}
