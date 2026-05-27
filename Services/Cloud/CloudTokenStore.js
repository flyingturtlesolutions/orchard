/**
 * @file Services/Cloud/CloudTokenStore.js
 * @description Cognito session tokens for Orchard API calls.
 */

const TOKEN_KEY = 'orchard:cloud:session';

/**
 * @typedef {Object} CloudSession
 * @property {string} idToken
 * @property {string} [accessToken]
 * @property {string} [refreshToken]
 * @property {number} expiresAt  ms epoch
 * @property {string} [orchardUserId]
 */

/** @returns {Promise<CloudSession|null>} */
export async function getCloudSession() {
  const data = await chrome.storage.local.get(TOKEN_KEY);
  const session = data[TOKEN_KEY];
  if (!session?.idToken) return null;
  if (session.expiresAt && Date.now() > session.expiresAt) return null;
  return session;
}

/** @param {CloudSession|null} session */
export async function setCloudSession(session) {
  if (!session) {
    await chrome.storage.local.remove(TOKEN_KEY);
    return;
  }
  await chrome.storage.local.set({ [TOKEN_KEY]: session });
}

/** @returns {Promise<boolean>} */
export async function isCloudSignedIn() {
  return !!(await getCloudSession());
}
