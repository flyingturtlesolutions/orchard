/**
 * @file Services/Storage/StoragePaths.js
 * @description Legacy chrome.storage keys ↔ Orchard logical paths (§19.2).
 */

/** @typedef {'ground'|'fragment'|'observation'|'analysis'|'assertion'|'perspective'|'landmark'|'strategy'|'workflow'|'locale'|'siteMap'|'chrome'} SyncKind */

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
    default:
      return null;
  }
}

/**
 * @param {string} logicalPath
 * @returns {{ kind: SyncKind, id: string, groundId?: string }|null}
 */
export function recordMetaFromPath(logicalPath) {
  let m;
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
