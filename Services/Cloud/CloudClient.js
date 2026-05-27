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
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  return cloudRequest('GET', `/objects/${encoded}`);
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
 * @returns {Promise<{ envelope: unknown, etag: string }>}
 */
export async function fetchCloudObjectRaw(logicalPath) {
  const settings = await getCloudSettings();
  const encoded = logicalPath.split('/').map(encodeURIComponent).join('/');
  const url = new URL(`objects/${encoded}`, settings.apiBaseUrl.endsWith('/')
    ? settings.apiBaseUrl
    : `${settings.apiBaseUrl}/`);

  const session = await getCloudSession();
  if (!session?.idToken) {
    throw new CloudClientError(401, 'Not signed in to Orchard cloud');
  }

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${session.idToken}`,
    },
  });

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
