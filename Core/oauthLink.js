// Core/oauthLink.js — MP-3a (v2.74.1310). The PURE client half of linking a broker provider: PKCE pair + the
// provider authorize-URL. The impure half (chrome.identity.launchWebAuthFlow + the POST to the proxy) is the thin
// LINK_CONNECTOR glue in background/handlers/connector.js — per the §5.2 pinned contract the OAuth DANCE runs
// client-side, the code→token EXCHANGE runs server-side (the client secret never touches the extension), and the
// refresh token vaults at CONNLINK#{provider} on the proxy.
//
// PKCE (RFC 7636, S256) — WebCrypto, available in both the MV3 service worker and the node test harness.
// @module Core/oauthLink

// Per-provider authorize endpoints + the extras that make a REFRESH token come back. Client ids are PUBLIC
// (not secrets) but per-install/per-deploy → supplied by the caller, never hardcoded here.
export const PROVIDER_AUTH = Object.freeze({
  google: Object.freeze({
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    // access_type=offline + prompt=consent — Google only issues a refresh token on a consenting offline grant.
    extra: Object.freeze({ access_type: 'offline', prompt: 'consent' }),
  }),
});

const _B64URL = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  // btoa exists in the SW; node ≥16 has globalThis.btoa too. base64url = base64 minus padding, +/ → -_
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * A fresh PKCE verifier/challenge pair (S256). Async (WebCrypto digest).
 * @returns {Promise<{ verifier:string, challenge:string, method:'S256' }>}
 */
export async function pkcePair() {
  const raw = new Uint8Array(32);
  globalThis.crypto.getRandomValues(raw);
  const verifier = _B64URL(raw);                                   // 43 chars of base64url — inside RFC 7636's 43..128
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: _B64URL(new Uint8Array(digest)), method: 'S256' };
}

/**
 * Build the provider authorize URL for the link dance. PURE.
 * @param {{ provider:string, clientId:string, redirectUri:string, scopes:string[], state:string, codeChallenge:string }} p
 * @returns {string|null}  null when the provider is unknown or a required field is missing.
 */
export function authorizeUrl({ provider, clientId, redirectUri, scopes, state, codeChallenge } = {}) {
  const cfg = PROVIDER_AUTH[String(provider || '').trim()];
  if (!cfg || !clientId || !redirectUri || !state || !codeChallenge) return null;
  const u = new URL(cfg.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', (Array.isArray(scopes) ? scopes : []).join(' '));
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(cfg.extra || {})) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Parse the final redirect URL launchWebAuthFlow hands back → { code } (state VERIFIED here — a mismatched or
 * missing state is rejected, not ignored). PURE.
 * @param {string} redirectedTo   the full redirect URL
 * @param {string} expectedState
 * @returns {{ ok:true, code:string } | { ok:false, error:string }}
 */
export function parseAuthRedirect(redirectedTo, expectedState) {
  let u = null;
  try { u = new URL(String(redirectedTo || '')); } catch { return { ok: false, error: 'bad-redirect-url' }; }
  const err = u.searchParams.get('error');
  if (err) return { ok: false, error: err };                        // e.g. access_denied — the user said no
  if (!expectedState || u.searchParams.get('state') !== expectedState) return { ok: false, error: 'state-mismatch' };
  const code = u.searchParams.get('code');
  if (!code) return { ok: false, error: 'no-code' };
  return { ok: true, code };
}
