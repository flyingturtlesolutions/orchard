// Core/lambdaOauth.test.js — MP-3b (v2.74.1310): the proxy's OAuth exchange (infra/…/lambda/api/oauth.cjs), driven
// headless with injected env + fetch — same pattern as mcpLambdaTransport. The client secret + token endpoints are
// SERVER-side-only knowledge (nothing to parity-lock against Core; the anti-SSRF property is the test). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import lambdaOauth from '../infra/orchard-dev/lambda/api/oauth.cjs';

const { exchangeAuthCode, refreshAccessToken, CONNECTOR_TOKEN_URLS, clearAccessTokenCache, clearSecretCache } = lambdaOauth;
const ENV = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'shh' };

function fakeToken(reply, calls = []) {
  return Object.assign(async (url, init) => { calls.push({ url, init }); return { ok: reply.ok !== false, json: async () => reply.data }; }, { calls });
}

describe('oauth.cjs — exchangeAuthCode (code → refresh+access, PKCE verifier rides along)', () => {
  it('happy path posts the grant to the CURATED token URL and returns the tokens', async () => {
    const fetchImpl = fakeToken({ data: { access_token: 'at', refresh_token: 'rt', scope: 's1' } });
    const r = await exchangeAuthCode('google', { code: '4/xyz', redirectUri: 'https://x.chromiumapp.org/google', codeVerifier: 'ver' }, { env: ENV, fetchImpl });
    assert.deepEqual(r, { refreshToken: 'rt', accessToken: 'at', scope: 's1' });
    assert.equal(fetchImpl.calls[0].url, CONNECTOR_TOKEN_URLS.google);          // never a client-supplied URL
    const params = new URLSearchParams(fetchImpl.calls[0].init.body);
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.get('code_verifier'), 'ver');
    assert.equal(params.get('client_secret'), 'shh');                            // secret used server-side only
  });
  it('no refresh_token in the grant → link-no-refresh-token (an hour-long link is a failed link)', async () => {
    const r = await exchangeAuthCode('google', { code: 'c', redirectUri: 'r' }, { env: ENV, fetchImpl: fakeToken({ data: { access_token: 'at' } }) });
    assert.equal(r.error, 'link-no-refresh-token');
  });
  it('missing env creds → connector-not-configured; missing fields → link-missing-fields', async () => {
    assert.equal((await exchangeAuthCode('google', { code: 'c', redirectUri: 'r' }, { env: {}, fetchImpl: fakeToken({ data: {} }) })).error, 'connector-not-configured');
    assert.equal((await exchangeAuthCode('google', { redirectUri: 'r' }, { env: ENV, fetchImpl: fakeToken({ data: {} }) })).error, 'link-missing-fields');
  });
  it('provider rejection / network throw → link-exchange-failed with the provider error as hint', async () => {
    const r = await exchangeAuthCode('google', { code: 'bad', redirectUri: 'r' }, { env: ENV, fetchImpl: fakeToken({ ok: false, data: { error: 'invalid_grant' } }) });
    assert.equal(r.error, 'link-exchange-failed');
    assert.equal(r.hint, 'invalid_grant');
    assert.equal((await exchangeAuthCode('google', { code: 'c', redirectUri: 'r' }, { env: ENV, fetchImpl: async () => { throw new Error('net'); } })).error, 'link-exchange-failed');
  });
});

describe('oauth.cjs — refreshAccessToken (vaulted refresh → short-lived access)', () => {
  it('happy path → { accessToken }; the refresh token goes only to the curated endpoint', async () => {
    clearAccessTokenCache();
    const fetchImpl = fakeToken({ data: { access_token: 'at2' } });
    const r = await refreshAccessToken('google', 'rt', { env: ENV, fetchImpl });
    assert.deepEqual(r, { accessToken: 'at2' });
    assert.equal(fetchImpl.calls[0].url, CONNECTOR_TOKEN_URLS.google);
    assert.equal(new URLSearchParams(fetchImpl.calls[0].init.body).get('grant_type'), 'refresh_token');
  });
  it('revoked/expired grant → connector-refresh-failed (the caller maps it to re-link)', async () => {
    clearAccessTokenCache();
    const r = await refreshAccessToken('google', 'rt', { env: ENV, fetchImpl: fakeToken({ ok: false, data: { error: 'invalid_grant' } }) });
    assert.equal(r.error, 'connector-refresh-failed');
    assert.equal(r.hint, 'invalid_grant');
  });
  it('no refresh token → connector-not-linked; unknown provider → connector-not-configured', async () => {
    clearAccessTokenCache();
    assert.equal((await refreshAccessToken('google', '', { env: ENV, fetchImpl: fakeToken({ data: {} }) })).error, 'connector-not-linked');
    assert.equal((await refreshAccessToken('zendesk', 'rt', { env: ENV, fetchImpl: fakeToken({ data: {} }) })).error, 'connector-not-configured');
  });
  it('v1342: caches access tokens within expires_in (one refresh POST per burst)', async () => {
    clearAccessTokenCache();
    let posts = 0;
    const fetchImpl = async (url, init) => {
      posts += 1;
      return { ok: true, json: async () => ({ access_token: 'at-cache', expires_in: 3600 }) };
    };
    const r1 = await refreshAccessToken('google', 'rt-cache', { env: ENV, fetchImpl });
    const r2 = await refreshAccessToken('google', 'rt-cache', { env: ENV, fetchImpl });
    assert.equal(r1.accessToken, 'at-cache');
    assert.equal(r2.accessToken, 'at-cache');
    assert.equal(posts, 1);
  });
  it('v1343 (bcp): the cache is per refresh token — user B NEVER gets user A\'s cached access token', async () => {
    clearAccessTokenCache();
    let posts = 0;
    const fetchImpl = async () => { posts += 1; return { ok: true, json: async () => ({ access_token: `at-${posts}`, expires_in: 3600 }) }; };
    const a = await refreshAccessToken('google', 'rt-user-a', { env: ENV, fetchImpl });
    const b = await refreshAccessToken('google', 'rt-user-b', { env: ENV, fetchImpl });   // same provider, other user
    assert.equal(a.accessToken, 'at-1');
    assert.equal(b.accessToken, 'at-2');   // a provider-only cache key would have returned at-1 here
    assert.equal(posts, 2);
  });
});

describe('oauth.cjs — v1344 (review Batch 0): client secret from Secrets Manager', () => {
  const SM_ENV = { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_SECRET_ARN: 'arn:aws:secretsmanager:us-east-1:1:secret:orchard/google-oauth-client-secret' };
  const _reset = () => { clearAccessTokenCache(); clearSecretCache(); };

  it('resolves the secret via getSecretImpl — NO env secret needed; the token POST carries it', async () => {
    _reset();
    const asked = [];
    const getSecretImpl = async (id) => { asked.push(id); return 'GOCSPX-rotated'; };
    const fetchImpl = fakeToken({ data: { access_token: 'at-sm' } });
    const r = await refreshAccessToken('google', 'rt', { env: SM_ENV, fetchImpl, getSecretImpl });
    assert.deepEqual(r, { accessToken: 'at-sm' });
    assert.deepEqual(asked, [SM_ENV.GOOGLE_OAUTH_SECRET_ARN]);
    assert.equal(new URLSearchParams(fetchImpl.calls[0].init.body).get('client_secret'), 'GOCSPX-rotated');
  });

  it('accepts a JSON-wrapped secret string ({ clientSecret })', async () => {
    _reset();
    const getSecretImpl = async () => '{"clientSecret":"GOCSPX-json"}';
    const fetchImpl = fakeToken({ data: { access_token: 'at-j' } });
    await refreshAccessToken('google', 'rt', { env: SM_ENV, fetchImpl, getSecretImpl });
    assert.equal(new URLSearchParams(fetchImpl.calls[0].init.body).get('client_secret'), 'GOCSPX-json');
  });

  it('caches the secret per container — one GetSecretValue across calls', async () => {
    _reset();
    let gets = 0;
    const getSecretImpl = async () => { gets += 1; return 'GOCSPX-once'; };
    const fetchImpl = fakeToken({ data: { access_token: 'at-c' } });
    await refreshAccessToken('google', 'rt-1', { env: SM_ENV, fetchImpl, getSecretImpl });
    await refreshAccessToken('google', 'rt-2', { env: SM_ENV, fetchImpl, getSecretImpl });   // distinct rt → distinct access-cache slot
    assert.equal(gets, 1);
  });

  it('a FAILED secret fetch falls back to the env secret when present; else connector-not-configured', async () => {
    _reset();
    const boom = async () => { throw new Error('sm down'); };
    const withFallback = { ...SM_ENV, GOOGLE_OAUTH_CLIENT_SECRET: 'shh-env' };
    const fetchImpl = fakeToken({ data: { access_token: 'at-fb' } });
    const ok = await refreshAccessToken('google', 'rt', { env: withFallback, fetchImpl, getSecretImpl: boom });
    assert.deepEqual(ok, { accessToken: 'at-fb' });
    assert.equal(new URLSearchParams(fetchImpl.calls[0].init.body).get('client_secret'), 'shh-env');
    _reset();
    const bad = await refreshAccessToken('google', 'rt', { env: SM_ENV, fetchImpl: fakeToken({ data: {} }), getSecretImpl: boom });
    assert.equal(bad.error, 'connector-not-configured');
  });

  it('exchangeAuthCode resolves via Secrets Manager too', async () => {
    _reset();
    const getSecretImpl = async () => 'GOCSPX-x';
    const fetchImpl = fakeToken({ data: { access_token: 'at', refresh_token: 'rt', scope: 's' } });
    const r = await exchangeAuthCode('google', { code: 'c', redirectUri: 'https://r' }, { env: SM_ENV, fetchImpl, getSecretImpl });
    assert.equal(r.refreshToken, 'rt');
    assert.equal(new URLSearchParams(fetchImpl.calls[0].init.body).get('client_secret'), 'GOCSPX-x');
  });
});
