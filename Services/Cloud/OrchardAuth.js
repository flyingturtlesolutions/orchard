/**
 * @file Services/Cloud/OrchardAuth.js
 * @description Cognito hosted UI sign-in via chrome.identity (P0).
 */

import { Logger } from '../../Core/Logger.js';
import { getCloudSettings } from './CloudSettings.js';
import { setCloudSession, getCloudSession } from './CloudTokenStore.js';
import { CloudClientError, completeIdentityBind, requestBindChallenge } from './CloudClient.js';
import { getIdentitySummary, signBindChallenge } from '../../Core/OrchardIdentity.js';

/**
 * Parse tokens from implicit-grant redirect URL hash.
 * @param {string} redirectUrl
 */
function parseTokensFromRedirect(redirectUrl) {
  const hash = new URL(redirectUrl).hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  const idToken = params.get('id_token');
  const accessToken = params.get('access_token');
  const expiresIn = Number(params.get('expires_in') || '3600');
  if (!idToken) {
    throw new Error('Cognito redirect missing id_token — check app client OAuth flows');
  }
  return {
    idToken,
    accessToken: accessToken || undefined,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

/** @returns {Promise<{ signedIn: boolean, orchardUserId?: string }>} */
export async function getCloudAuthStatus() {
  const session = await getCloudSession();
  const settings = await getCloudSettings();
  const { orchardUserIdPreview } = await getIdentitySummary();
  return {
    signedIn: !!session,
    orchardUserId: session?.orchardUserId,
    orchardUserIdPreview,
    cloudEnabled: settings.enabled,
    storageBackend: settings.storageBackend,
    oauthRedirectUri: getOAuthRedirectUri(),
    extensionId: chrome.runtime.id,
  };
}

/** Stable OAuth redirect for Cognito hosted UI (must match app client callback URLs). */
export function getOAuthRedirectUri() {
  return chrome.identity.getRedirectURL('orchard');
}

/** Build hosted UI authorize URL (implicit grant). */
function buildAuthorizeUrl(settings) {
  const redirectUri = getOAuthRedirectUri();
  const domain = settings.cognitoDomain.replace(/\/$/, '');
  const scope = encodeURIComponent(settings.cognitoScope || 'openid email');
  return `${domain}/oauth2/authorize`
    + `?client_id=${encodeURIComponent(settings.cognitoClientId)}`
    + `&response_type=token`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${scope}`
    + `&prompt=login`;
}

/** Build hosted UI URL that clears the Cognito session cookie only. */
function buildSignOutUrl(settings) {
  const redirectUri = getOAuthRedirectUri();
  const domain = settings.cognitoDomain.replace(/\/$/, '');
  return `${domain}/logout`
    + `?client_id=${encodeURIComponent(settings.cognitoClientId)}`
    + `&logout_uri=${encodeURIComponent(redirectUri)}`;
}

/**
 * @param {string} url
 * @returns {Promise<{ redirectUrl: string|null, error?: string }>}
 */
function launchAuthFlow(url) {
  return new Promise((resolve) => {
    chrome.identity.launchWebAuthFlow(
      { url, interactive: true },
      (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          resolve({
            redirectUrl: null,
            error: chrome.runtime.lastError?.message || 'Auth flow cancelled',
          });
          return;
        }
        resolve({ redirectUrl });
      },
    );
  });
}

/** @returns {Promise<{ success: boolean, error?: string }>} */
export async function signInToCloud() {
  const settings = await getCloudSettings();
  if (!settings.cognitoDomain || !settings.cognitoClientId) {
    return {
      success: false,
      error: 'Cognito not configured — set cognitoDomain and cognitoClientId in cloud settings',
    };
  }

  const authUrl = buildAuthorizeUrl(settings);
  const redirectUri = getOAuthRedirectUri();

  // Clear any Cognito browser cookie so prompt=login shows credentials (ignore cancel).
  await launchAuthFlow(buildSignOutUrl(settings));

  const { redirectUrl, error } = await launchAuthFlow(authUrl);
  if (!redirectUrl) {
    const base = error || 'Sign-in cancelled';
    const hint = `Register this redirect URI in Cognito (callback + sign-out URLs): ${redirectUri}`;
    Logger.warn('OrchardAuth', `${base} — ${hint}`);
    return { success: false, error: `${base}. ${hint}` };
  }

  try {
    const tokens = parseTokensFromRedirect(redirectUrl);
    await setCloudSession({ ...tokens });
    const bindResult = await tryBindIdentity();
    return { success: true, bind: bindResult };
  } catch (e) {
    Logger.error('OrchardAuth', e.message);
    return { success: false, error: e.message };
  }
}

/**
 * POST /identity/bind with publicKey proof (P0).
 * @returns {Promise<{ bound: boolean, orchardUserId?: string, skipped?: boolean }>}
 */
export async function tryBindIdentity() {
  const settings = await getCloudSettings();
  if (!settings.enabled) return { bound: false, skipped: true };

  try {
    const { publicKeyB64 } = await getIdentitySummary();
    const challengeResp = /** @type {{ challenge: string }} */ (
      await requestBindChallenge(publicKeyB64)
    );
    if (!challengeResp?.challenge) {
      return { bound: true, skipped: true };
    }
    const signature = await signBindChallenge(challengeResp.challenge);
    const result = /** @type {{ orchardUserId: string }} */ (
      await completeIdentityBind({
        publicKey: publicKeyB64,
        challenge: challengeResp.challenge,
        signature,
      })
    );
    const session = await getCloudSession();
    if (session && result?.orchardUserId) {
      await setCloudSession({ ...session, orchardUserId: result.orchardUserId });
    }
    return { bound: true, orchardUserId: result?.orchardUserId };
  } catch (e) {
    if (e instanceof CloudClientError && (e.status === 404 || e.status === 501)) {
      Logger.info('OrchardAuth', 'Bind endpoint not available yet (P0 dev)');
      return { bound: false, skipped: true };
    }
    throw e;
  }
}

/** @returns {Promise<void>} */
export async function signOutOfCloud() {
  const settings = await getCloudSettings();
  await setCloudSession(null);

  if (!settings.cognitoDomain || !settings.cognitoClientId) return;

  const logoutUrl = buildSignOutUrl(settings);
  const { error } = await launchAuthFlow(logoutUrl);
  if (error) {
    Logger.warn('OrchardAuth', `Cognito logout: ${error}`);
  }
}
