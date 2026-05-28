/**
 * @file Services/Cloud/CloudClient.js
 * @description HTTP client for Orchard cloud API (P0 read + identity).
 */

import { Logger } from '../../Core/Logger.js';
import { getCloudSettings, normalizeApiBaseUrl } from './CloudSettings.js';
import { ensureFreshSession } from './CloudTokenStore.js';

export class CloudClientError extends Error {
  /** @param {number} status @param {string} message @param {unknown} [body] */
  constructor(status, message, body) {
    super(message);
    this.name = 'CloudClientError';
    this.status = status;
    this.body = body;
  }
}

/**
 * @param {string} method
 * @param {string} path  e.g. `/identity/me`
 * @param {{ body?: unknown, query?: Record<string, string>, auth?: boolean, ifMatch?: string }} [opts]
 */
export async function cloudRequest(method, path, opts = {}) {
  const settings = await getCloudSettings();
  const base = normalizeApiBaseUrl(settings.apiBaseUrl);
  const url = new URL(path.replace(/^\//, ''), `${base}/`);

  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) url.searchParams.set(k, v);
    }
  }

  /** @type {RequestInit} */
  const init = {
    method,
    headers: { Accept: 'application/json' },
  };

  if (opts.body !== undefined) {
    init.headers = { ...init.headers, 'Content-Type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }

  if (opts.ifMatch) {
    init.headers = { ...init.headers, 'If-Match': opts.ifMatch };
  }

  const useAuth = opts.auth !== false;
  if (useAuth) {
    const session = await ensureFreshSession();
    if (!session?.idToken) {
      throw new CloudClientError(401, 'Not signed in to Orchard cloud');
    }
    init.headers = { ...init.headers, Authorization: `Bearer ${session.idToken}` };
  }

  const res = await fetch(url.toString(), init);
  const text = await res.text();
  /** @type {unknown} */
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data
      ? String(data.error)
      : res.statusText || 'Request failed';
    Logger.warn('CloudClient', `${method} ${path} → ${res.status}: ${msg}`);
    throw new CloudClientError(res.status, msg, data);
  }

  return data;
}

/** @returns {Promise<{ orchardUserId: string, [key: string]: unknown }>} */
export async function getIdentityMe() {
  return /** @type {Promise<any>} */ (cloudRequest('GET', '/identity/me'));
}

/**
 * @param {string} publicKeyB64
 */
export async function requestBindChallenge(publicKeyB64) {
  return cloudRequest('POST', '/identity/bind/challenge', { body: { publicKey: publicKeyB64 } });
}

/**
 * @param {{ publicKey: string, signature: string, challenge: string }} body
 */
export async function completeIdentityBind(body) {
  return cloudRequest('POST', '/identity/bind', { body, auth: true });
}

/** @deprecated use completeIdentityBind */
export async function bindIdentity(body) {
  return completeIdentityBind(body);
}

// ── Publication registry (AWS_INTEGRATION §7.4) ──────────────────────────────
/** @param {{ publication: object, manifest: object, packages: object }} pkg */
export async function publishToRegistry(pkg) {
  return cloudRequest('POST', '/publications', { body: pkg });
}
/** @param {string} publicationId @returns {Promise<{ publication: object, manifest: object, packages: object }>} */
export async function fetchPublication(publicationId) {
  return /** @type {any} */ (cloudRequest('GET', `/publications/${encodeURIComponent(publicationId)}`));
}
/** @param {string} [query] @returns {Promise<{ publications: object[] }>} */
export async function searchPublications(query) {
  return /** @type {any} */ (cloudRequest('GET', '/publications', { query: query ? { query } : {} }));
}
/**
 * Newer versions in the publication's lineage (DD-12 B).
 * @param {string} publicationId
 * @returns {Promise<{ publicationId: string, lineageRootId: string, updates: object[] }>}
 */
export async function fetchPublicationUpdates(publicationId) {
  return /** @type {any} */ (cloudRequest('GET', `/publications/${encodeURIComponent(publicationId)}/updates`));
}
/**
 * Server-verified import plan: verifies the signature server-side and returns the package
 * ({ publication, manifest, packages, signatureValid }). Client still reconciles + installs locally.
 * @param {string} publicationId
 * @param {{ target?: 'personal' }} [opts]
 * @returns {Promise<{ publication: object, manifest: object, packages: object, signatureValid: boolean }>}
 */
export async function requestPublicationImport(publicationId, opts = {}) {
  return /** @type {any} */ (cloudRequest('POST', `/publications/${encodeURIComponent(publicationId)}/import`, {
    body: { target: opts.target || 'personal' },
  }));
}

// ── Shared workspaces (DD-05 C / AWS_INTEGRATION §7.2) ───────────────────────
/** @param {string} name @returns {Promise<{ workspaceId: string, name: string, role: string }>} */
export async function createWorkspace(name) {
  return /** @type {any} */ (cloudRequest('POST', '/workspaces', { body: { name } }));
}
/** @returns {Promise<{ workspaces: Array<{ workspaceId: string, name: string, role: string, createdAt: number }> }>} */
export async function listWorkspaces() {
  return /** @type {any} */ (cloudRequest('GET', '/workspaces'));
}
/** @param {string} wsId @returns {Promise<{ workspaceId: string, name: string, role: string, members: object[] }>} */
export async function getWorkspace(wsId) {
  return /** @type {any} */ (cloudRequest('GET', `/workspaces/${encodeURIComponent(wsId)}`));
}
/** @param {string} wsId @param {string} name */
export async function renameWorkspace(wsId, name) {
  return cloudRequest('PATCH', `/workspaces/${encodeURIComponent(wsId)}`, { body: { name } });
}
/** @param {string} wsId @param {string} orchardUserId @param {'viewer'|'editor'|'admin'} [role] */
export async function addWorkspaceMember(wsId, orchardUserId, role = 'editor') {
  return cloudRequest('POST', `/workspaces/${encodeURIComponent(wsId)}/members`, { body: { orchardUserId, role } });
}
/** @param {string} wsId @param {string} orchardUserId */
export async function removeWorkspaceMember(wsId, orchardUserId) {
  return cloudRequest('DELETE', `/workspaces/${encodeURIComponent(wsId)}/members/${encodeURIComponent(orchardUserId)}`);
}

/**
 * @param {string} logicalPath
 * @returns {Promise<unknown>}
 */
export async function getCloudObject(logicalPath) {
  const { envelope } = await fetchCloudObjectRaw(logicalPath);
  return envelope;
}

/**
 * @param {string} [sinceToken]
 * @returns {Promise<{ changes: Array<{ path: string, etag?: string, updatedAt?: number, groundId?: string }>, nextToken?: string }>}
 */
export async function listCloudChanges(sinceToken) {
  return /** @type {Promise<any>} */ (cloudRequest('GET', '/objects', {
    query: sinceToken ? { since: sinceToken } : {},
  }));
}

/**
 * @param {string} logicalPath
 * @param {string} [routePrefix]  'objects' (personal) or 'workspaces/{wsId}/objects' (team)
 * @returns {Promise<Response>}
 */
async function fetchObjectResponse(logicalPath, routePrefix = 'objects') {
  const settings = await getCloudSettings();
  const base = normalizeApiBaseUrl(settings.apiBaseUrl);
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`${routePrefix}/${encoded}`, `${base}/`);

  const session = await ensureFreshSession();
  if (!session?.idToken) {
    throw new CloudClientError(401, 'Not signed in to Orchard cloud');
  }

  return fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${session.idToken}`,
    },
    redirect: 'manual',
  });
}

/**
 * @param {string} logicalPath
 * @param {string} [routePrefix]
 * @returns {Promise<{ envelope: unknown, etag: string }>}
 */
export async function fetchCloudObjectRaw(logicalPath, routePrefix = 'objects') {
  const res = await fetchObjectResponse(logicalPath, routePrefix);

  if (res.status === 302 || res.status === 301 || res.status === 307 || res.status === 308) {
    const downloadUrl = res.headers.get('location');
    if (!downloadUrl) {
      throw new CloudClientError(502, 'Large object redirect missing location URL');
    }
    const etag = (res.headers.get('x-orchard-etag') || '').replace(/^"|"$/g, '');
    const s3Res = await fetch(downloadUrl, { method: 'GET' });
    const text = await s3Res.text();
    if (!s3Res.ok) {
      throw new CloudClientError(s3Res.status, 'Presigned S3 download failed', text);
    }
    /** @type {unknown} */
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    const s3Etag = (s3Res.headers.get('etag') || '').replace(/^"|"$/g, '');
    return { envelope: data, etag: etag || s3Etag };
  }

  const text = await res.text();
  /** @type {unknown} */
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }

  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data
      ? String(data.error)
      : res.statusText || 'Request failed';
    throw new CloudClientError(res.status, msg, data);
  }

  const etag = (res.headers.get('etag') || '').replace(/^"|"$/g, '');
  return { envelope: data, etag };
}

/**
 * @param {string} logicalPath
 * @param {unknown} envelope
 * @param {string} [expectedEtag]
 */
export async function putCloudObject(logicalPath, envelope, expectedEtag = '*') {
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  return cloudRequest('PUT', `/objects/${encoded}`, {
    body: envelope,
    ifMatch: expectedEtag,
  });
}

/** Inline API Gateway body limit — larger objects use presigned S3 upload. */
export const INLINE_OBJECT_MAX_BYTES = 256 * 1024;

/**
 * @param {unknown} envelope
 */
export function objectBodyBytes(envelope) {
  return new TextEncoder().encode(JSON.stringify(envelope)).length;
}

/**
 * @param {string} logicalPath
 * @param {string} [expectedEtag]
 */
export async function presignPutCloudObject(logicalPath, expectedEtag = '*') {
  return /** @type {Promise<any>} */ (cloudRequest('POST', '/objects/presign-put', {
    body: { path: logicalPath, expectedEtag },
  }));
}

/**
 * @param {string} logicalPath
 * @param {string} uploadId
 * @param {string} [expectedEtag]
 */
export async function completePutCloudObject(logicalPath, uploadId, expectedEtag = '*') {
  return /** @type {Promise<any>} */ (cloudRequest('POST', '/objects/complete-put', {
    body: { path: logicalPath, uploadId, expectedEtag },
  }));
}

/**
 * Upload via presigned staging key + complete (bypasses API Gateway body limit).
 * @param {string} logicalPath
 * @param {unknown} envelope
 * @param {string} [expectedEtag]
 */
export async function putCloudObjectDirect(logicalPath, envelope, expectedEtag = '*') {
  const presign = await presignPutCloudObject(logicalPath, expectedEtag);
  const bodyStr = JSON.stringify(envelope);
  /** @type {Record<string, string>} */
  const headers = { 'Content-Type': 'application/json', ...(presign.headers || {}) };

  const res = await fetch(presign.uploadUrl, {
    method: presign.method || 'PUT',
    headers,
    body: bodyStr,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new CloudClientError(res.status, 'Presigned S3 upload failed', text);
  }

  return completePutCloudObject(logicalPath, presign.uploadId, expectedEtag);
}

/**
 * Inline PUT when small enough; presigned direct upload when over threshold.
 * @param {string} logicalPath
 * @param {unknown} envelope
 * @param {string} [expectedEtag]
 */
export async function putCloudObjectAuto(logicalPath, envelope, expectedEtag = '*') {
  if (objectBodyBytes(envelope) <= INLINE_OBJECT_MAX_BYTES) {
    return putCloudObject(logicalPath, envelope, expectedEtag);
  }
  return putCloudObjectDirect(logicalPath, envelope, expectedEtag);
}

/**
 * @param {{ groundId?: string, items: Array<{ path: string, envelope: unknown, expectedEtag?: string }> }} body
 * @returns {Promise<{ etags: Record<string, string>, updatedAt: number, count: number }>}
 */
export async function batchWriteCloudObjects(body) {
  return /** @type {Promise<any>} */ (cloudRequest('POST', '/objects/batch', { body }));
}

/**
 * @param {string} logicalPath
 */
export async function deleteCloudObject(logicalPath) {
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  return cloudRequest('DELETE', `/objects/${encoded}`);
}

// ── Team workspace object I/O (DD-05 C / §7.2) ───────────────────────────────
// Mirror the personal object calls against /workspaces/{wsId}/objects. Inline only — team large
// objects (presigned blobs) are deferred; the sync engine routes only small JSON here.
function wsObjectsBase(wsId) { return `/workspaces/${encodeURIComponent(wsId)}/objects`; }

/** @param {string} wsId @param {string} [sinceToken] */
export async function listWorkspaceChanges(wsId, sinceToken) {
  return /** @type {Promise<any>} */ (cloudRequest('GET', wsObjectsBase(wsId), {
    query: sinceToken ? { since: sinceToken } : {},
  }));
}

/** @param {string} wsId @param {string} logicalPath @returns {Promise<{ envelope: unknown, etag: string }>} */
export async function fetchWorkspaceObjectRaw(wsId, logicalPath) {
  return fetchCloudObjectRaw(logicalPath, `workspaces/${encodeURIComponent(wsId)}/objects`);
}

/** @param {string} wsId @param {string} logicalPath @param {unknown} envelope @param {string} [expectedEtag] */
export async function putWorkspaceObject(wsId, logicalPath, envelope, expectedEtag = '*') {
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  return cloudRequest('PUT', `${wsObjectsBase(wsId)}/${encoded}`, { body: envelope, ifMatch: expectedEtag });
}

/** @param {string} wsId @param {string} logicalPath */
export async function deleteWorkspaceObject(wsId, logicalPath) {
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  return cloudRequest('DELETE', `${wsObjectsBase(wsId)}/${encoded}`);
}

/** @param {string} wsId @param {{ items: Array<{ path: string, envelope: unknown, expectedEtag?: string }> }} body */
export async function batchWriteWorkspaceObjects(wsId, body) {
  return /** @type {Promise<any>} */ (cloudRequest('POST', `${wsObjectsBase(wsId)}/batch`, { body }));
}
