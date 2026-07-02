// Core/lambdaOauth.test.js — MP-3b (v2.74.1310): the proxy's OAuth exchange (infra/…/lambda/api/oauth.cjs), driven
// headless with injected env + fetch — same pattern as mcpLambdaTransport. The client secret + token endpoints are
// SERVER-side-only knowledge (nothing to parity-lock against Core; the anti-SSRF property is the test). node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import lambdaOauth from '../infra/orchard-dev/lambda/api/oauth.cjs';

const { exchangeAuthCode, refreshAccessToken, CONNECTOR_TOKEN_URLS } = lambdaOauth;
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
    const fetchImpl = fakeToken({ data: { access_token: 'at2' } });
    const r = await refreshAccessToken('google', 'rt', { env: ENV, fetchImpl });
    assert.deepEqual(r, { accessToken: 'at2' });
    assert.equal(fetchImpl.calls[0].url, CONNECTOR_TOKEN_URLS.google);
    assert.equal(new URLSearchParams(fetchImpl.calls[0].init.body).get('grant_type'), 'refresh_token');
  });
  it('revoked/expired grant → connector-refresh-failed (the caller maps it to re-link)', async () => {
    const r = await refreshAccessToken('google', 'rt', { env: ENV, fetchImpl: fakeToken({ ok: false, data: { error: 'invalid_grant' } }) });
    assert.equal(r.error, 'connector-refresh-failed');
    assert.equal(r.hint, 'invalid_grant');
  });
  it('no refresh token → connector-not-linked; unknown provider → connector-not-configured', async () => {
    assert.equal((await refreshAccessToken('google', '', { env: ENV, fetchImpl: fakeToken({ data: {} }) })).error, 'connector-not-linked');
    assert.equal((await refreshAccessToken('zendesk', 'rt', { env: ENV, fetchImpl: fakeToken({ data: {} }) })).error, 'connector-not-configured');
  });
});
