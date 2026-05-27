/**
 * @file Services/Cloud/CloudTokenStore.js
 * @description Cognito session tokens for Orchard API calls (PKCE auth-code + refresh token).
 *   Owns the token-endpoint exchange so it has no dependency on CloudClient (avoids a cycle:
 *   CloudClient → ensureFreshSession lives here, here → only CloudSettings + fetch).
 */

import { getCloudSettings } from './CloudSettings.js';

const TOKEN_KEY = 'orchard:cloud:session';
const EXPIRY_SKEW_MS = 60_000;   // refresh a minute early so in-flight requests don't race expiry

/**
 * @typedef {Object} CloudSession
 * @property {string} idToken
 * @property {string} [accessToken]
 * @property {string} [refreshToken]
 * @property {number} expiresAt  ms epoch
 * @property {string} [orchardUserId]
 */

/** Valid (non-expired) session, or null. Use ensureFreshSession() to auto-refresh. */
export async function getCloudSession() {
  const session = await getStoredSession();
  if (!session?.idToken) return null;
  if (session.expiresAt && Date.now() > session.expiresAt) return null;
  return session;
}

/** Raw stored session regardless of expiry (so refresh can read the refreshToken). */
export async function getStoredSession() {
  const data = await chrome.storage.local.get(TOKEN_KEY);
  return data[TOKEN_KEY] || null;
}

/** @param {CloudSession|null} session */
export async function setCloudSession(session) {
  if (!session) {
    await chrome.storage.local.remove(TOKEN_KEY);
    return;
  }
  await chrome.storage.local.set({ [TOKEN_KEY]: session });
}

/**
 * Signed in if we hold a usable session: either a still-valid id token, or a refresh token we can
 * exchange for one. Stays true across id-token expiry (~1h) so sync isn't paused needlessly.
 * @returns {Promise<boolean>}
 */
export async function isCloudSignedIn() {
  const s = await getStoredSession();
  if (!s) return false;
  if (s.refreshToken) return true;
  return !!(s.idToken && (!s.expiresAt || Date.now() < s.expiresAt));
}

/**
 * Return a session with a fresh id token, refreshing via the refresh token when the current one is
 * expired/near-expiry. Null when there's no usable session.
 * @returns {Promise<CloudSession|null>}
 */
export async function ensureFreshSession() {
  const s = await getStoredSession();
  if (!s?.idToken) return null;
  if (!s.expiresAt || Date.now() < s.expiresAt - EXPIRY_SKEW_MS) return s;
  return refreshCloudSession();
}

/** @returns {Promise<string>} `${cognitoDomain}/oauth2/token` */
async function tokenEndpoint() {
  const settings = await getCloudSettings();
  return `${settings.cognitoDomain.replace(/\/+$/, '')}/oauth2/token`;
}

/**
 * POST the Cognito token endpoint (public client; no secret). x-www-form-urlencoded.
 * @param {Record<string, string>} params  grant-specific params (client_id is added)
 * @returns {Promise<Record<string, any>>} token response
 */
async function postToken(params) {
  const settings = await getCloudSettings();
  const body = new URLSearchParams({ client_id: settings.cognitoClientId, ...params });
  const res = await fetch(await tokenEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `token endpoint ${res.status}`);
  }
  return data;
}

/**
 * @param {Record<string, any>} t   token response
 * @param {CloudSession|null} [prev]
 * @returns {CloudSession}
 */
function sessionFromTokenResponse(t, prev) {
  if (!t.id_token) throw new Error('token response missing id_token');
  return {
    idToken: t.id_token,
    accessToken: t.access_token || prev?.accessToken,
    // Cognito does not rotate the refresh token on refresh — keep the prior one if absent.
    refreshToken: t.refresh_token || prev?.refreshToken,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
    orchardUserId: prev?.orchardUserId,
  };
}

/**
 * Exchange a PKCE authorization code for tokens and persist the session.
 * @param {{ code: string, redirectUri: string, codeVerifier: string }} args
 * @returns {Promise<CloudSession>}
 */
export async function exchangeAuthCode({ code, redirectUri, codeVerifier }) {
  const t = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const session = sessionFromTokenResponse(t, null);
  await setCloudSession(session);
  return session;
}

/**
 * Exchange the stored refresh token for a fresh id/access token. Returns null (and leaves the
 * stored session in place) on failure — the caller treats that as "needs re-auth".
 * @returns {Promise<CloudSession|null>}
 */
export async function refreshCloudSession() {
  const prev = await getStoredSession();
  if (!prev?.refreshToken) return null;
  try {
    const t = await postToken({ grant_type: 'refresh_token', refresh_token: prev.refreshToken });
    const session = sessionFromTokenResponse(t, prev);
    await setCloudSession(session);
    return session;
  } catch {
    return null;
  }
}
