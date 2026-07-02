// Core/oauthLink.test.js — MP-3a (v2.74.1310): the pure client half of the broker link — PKCE (S256), the provider
// authorize-URL, the redirect parse (state VERIFIED), and the provider scope-union. node --test.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { pkcePair, authorizeUrl, parseAuthRedirect, PROVIDER_AUTH } from './oauthLink.js';
import { providerScopes } from './mcpServers.js';

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('oauthLink — pkcePair (RFC 7636 S256)', () => {
  it('verifier is 43 chars of base64url; challenge = b64url(sha256(verifier)) — recomputed independently', async () => {
    const { verifier, challenge, method } = await pkcePair();
    assert.equal(method, 'S256');
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(challenge, b64url(crypto.createHash('sha256').update(verifier).digest()));
  });
  it('two pairs are distinct (actually random)', async () => {
    const a = await pkcePair(); const b = await pkcePair();
    assert.notEqual(a.verifier, b.verifier);
  });
});

describe('oauthLink — authorizeUrl', () => {
  const base = { provider: 'google', clientId: 'cid.apps.googleusercontent.com', redirectUri: 'https://abc.chromiumapp.org/google', scopes: ['s1', 's2'], state: 'st9', codeChallenge: 'ch' };
  it('builds the Google authorize URL with PKCE + the offline-grant extras', () => {
    const u = new URL(authorizeUrl(base));
    assert.equal(u.origin + u.pathname, PROVIDER_AUTH.google.authUrl);
    assert.equal(u.searchParams.get('response_type'), 'code');
    assert.equal(u.searchParams.get('client_id'), base.clientId);
    assert.equal(u.searchParams.get('redirect_uri'), base.redirectUri);
    assert.equal(u.searchParams.get('scope'), 's1 s2');
    assert.equal(u.searchParams.get('state'), 'st9');
    assert.equal(u.searchParams.get('code_challenge'), 'ch');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(u.searchParams.get('access_type'), 'offline');    // no refresh token without these two
    assert.equal(u.searchParams.get('prompt'), 'consent');
  });
  it('unknown provider or a missing required field → null (fail-closed, no half-built URL)', () => {
    assert.equal(authorizeUrl({ ...base, provider: 'nope' }), null);
    assert.equal(authorizeUrl({ ...base, clientId: '' }), null);
    assert.equal(authorizeUrl({ ...base, state: '' }), null);
    assert.equal(authorizeUrl({ ...base, codeChallenge: '' }), null);
  });
});

describe('oauthLink — parseAuthRedirect (state verified, never ignored)', () => {
  const R = 'https://abc.chromiumapp.org/google';
  it('happy path → { ok, code }', () => {
    assert.deepEqual(parseAuthRedirect(`${R}?state=st9&code=4/xyz`, 'st9'), { ok: true, code: '4/xyz' });
  });
  it('provider error (user declined) surfaces as-is', () => {
    assert.equal(parseAuthRedirect(`${R}?error=access_denied&state=st9`, 'st9').error, 'access_denied');
  });
  it('state mismatch / missing → rejected', () => {
    assert.equal(parseAuthRedirect(`${R}?state=EVIL&code=4/xyz`, 'st9').error, 'state-mismatch');
    assert.equal(parseAuthRedirect(`${R}?code=4/xyz`, 'st9').error, 'state-mismatch');
  });
  it('no code / garbage URL → rejected, never a throw', () => {
    assert.equal(parseAuthRedirect(`${R}?state=st9`, 'st9').error, 'no-code');
    assert.equal(parseAuthRedirect('not a url', 'st9').error, 'bad-redirect-url');
  });
});

describe('mcpServers — providerScopes (one dance grants every server the provider fronts)', () => {
  it('google = the union across google-* servers, deduped, order-stable', () => {
    const scopes = providerScopes('google');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/calendar.events'));
    assert.equal(new Set(scopes).size, scopes.length);
  });
  it('GD-2: REST-channel servers (google-docs, catalog-only) join the union — one re-link grants Calendar + Docs', () => {
    const scopes = providerScopes('google');
    assert.ok(scopes.includes('https://www.googleapis.com/auth/documents'));
    assert.ok(scopes.includes('https://www.googleapis.com/auth/drive.file'));
  });
  it('unknown provider → []', () => {
    assert.deepEqual(providerScopes('nope'), []);
  });
});
