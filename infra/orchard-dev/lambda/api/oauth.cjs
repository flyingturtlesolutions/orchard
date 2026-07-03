// infra/orchard-dev/lambda/api/oauth.cjs — MP-3b (v2.74.1310). The proxy's OAuth half of the §5.2 link contract:
// exchange an authorization CODE (PKCE, danced client-side via launchWebAuthFlow) → refresh+access tokens, and
// refresh a vaulted refresh token → a short-lived access token. The client SECRET lives only here (Lambda env,
// `${PROVIDER}_OAUTH_CLIENT_ID/SECRET`) — it never touches the extension; the REFRESH token never leaves the vault
// path (index.js stores it at CONNLINK#{provider}); only derived ACCESS tokens travel, and only to curated endpoints.
//
// fetchImpl + env are injectable → the whole exchange is headless-testable (Core/lambdaOauth.test.js). CJS mirror
// note: nothing here mirrors Core (the token endpoints are server-side-only knowledge, like mcp.cjs's endpoint map).

'use strict';

// Curated, server-side-only token endpoints (anti-SSRF: never client-supplied).
const CONNECTOR_TOKEN_URLS = {
  google: 'https://oauth2.googleapis.com/token',
};

// v1342 — per-provider access-token cache (module lifetime; one Lambda container ≈ one user burst).
const _accessCache = new Map();

function _creds(provider, env) {
  const P = String(provider || '').toUpperCase();
  const clientId = env[`${P}_OAUTH_CLIENT_ID`];
  const clientSecret = env[`${P}_OAUTH_CLIENT_SECRET`];
  const tokenUrl = CONNECTOR_TOKEN_URLS[String(provider || '')];
  if (!tokenUrl || !clientId || !clientSecret) return null;
  return { tokenUrl, clientId, clientSecret };
}

async function _tokenPost(fetchImpl, tokenUrl, params) {
  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  let data = null;
  try { data = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok, data };
}

/**
 * Authorization code → { refreshToken, accessToken, scope }. The PKCE verifier rides along (the provider checks it
 * against the challenge from the authorize step). → { error } on any failure, never a throw.
 * @param {string} provider
 * @param {{ code:string, redirectUri:string, codeVerifier?:string }} p
 * @param {{ env?:object, fetchImpl?:Function }} [io]
 */
async function exchangeAuthCode(provider, { code, redirectUri, codeVerifier } = {}, { env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const c = _creds(provider, env);
  if (!c) return { error: 'connector-not-configured' };
  if (!code || !redirectUri) return { error: 'link-missing-fields' };
  try {
    const params = { client_id: c.clientId, client_secret: c.clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' };
    if (codeVerifier) params.code_verifier = codeVerifier;
    const { ok, data } = await _tokenPost(fetchImpl, c.tokenUrl, params);
    if (!ok || !data || !data.access_token) return { error: 'link-exchange-failed', hint: data && data.error ? String(data.error) : undefined };
    // Google only returns refresh_token on a consenting offline grant (access_type=offline&prompt=consent — the
    // client half sets those). No refresh token = the link won't survive the hour → treat as a failed link.
    if (!data.refresh_token) return { error: 'link-no-refresh-token', hint: 'authorize did not grant offline access — retry the link' };
    return { refreshToken: data.refresh_token, accessToken: data.access_token, scope: data.scope || '' };
  } catch { return { error: 'link-exchange-failed' }; }
}

/**
 * Vaulted refresh token → a short-lived access token. → { accessToken } | { error }.
 * @param {string} provider
 * @param {string} refreshToken
 * @param {{ env?:object, fetchImpl?:Function }} [io]
 */
async function refreshAccessToken(provider, refreshToken, { env = process.env, fetchImpl = globalThis.fetch, force = false } = {}) {
  const c = _creds(provider, env);
  if (!c) return { error: 'connector-not-configured' };
  if (!refreshToken) return { error: 'connector-not-linked' };
  // v1342 (review H) — cache short-lived access tokens (Google refresh quota + invoke latency).
  // v1343 (bcp catch) — keyed per provider+REFRESH TOKEN, not provider alone: a warm Lambda container serves
  // MULTIPLE users, and a provider-only key would hand user A's cached access token to user B's request.
  const cacheKey = `${String(provider || '')}:${refreshToken}`;
  const cached = _accessCache.get(cacheKey);
  if (!force && cached && cached.token && cached.expiresAt > Date.now() + 30_000) {
    return { accessToken: cached.token };
  }
  try {
    const { ok, data } = await _tokenPost(fetchImpl, c.tokenUrl, {
      client_id: c.clientId, client_secret: c.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token',
    });
    if (!ok || !data || !data.access_token) return { error: 'connector-refresh-failed', hint: data && data.error ? String(data.error) : undefined };
    const ttl = (Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600) * 1000;
    _accessCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + ttl });
    return { accessToken: data.access_token };
  } catch { return { error: 'connector-refresh-failed' }; }
}

module.exports = { CONNECTOR_TOKEN_URLS, exchangeAuthCode, refreshAccessToken, clearAccessTokenCache: () => _accessCache.clear() };
