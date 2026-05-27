/**
 * @file Services/Cloud/CloudClient.js
 * @description HTTP client for Orchard cloud API (P0 read + identity).
 */

import { Logger } from '../../Core/Logger.js';
import { getCloudSettings } from './CloudSettings.js';
import { getCloudSession } from './CloudTokenStore.js';

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
  const url = new URL(path.replace(/^\//, ''), settings.apiBaseUrl.endsWith('/')
    ? settings.apiBaseUrl
    : `${settings.apiBaseUrl}/`);

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
    const session = await getCloudSession();
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
 * @returns {Promise<Response>}
 */
async function fetchObjectResponse(logicalPath) {
  const settings = await getCloudSettings();
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`objects/${encoded}`, settings.apiBaseUrl.endsWith('/')
    ? settings.apiBaseUrl
    : `${settings.apiBaseUrl}/`);

  const session = await getCloudSession();
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
 * @returns {Promise<{ envelope: unknown, etag: string }>}
 */
export async function fetchCloudObjectRaw(logicalPath) {
  const res = await fetchObjectResponse(logicalPath);

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
