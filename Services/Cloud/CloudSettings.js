/**
 * @file Services/Cloud/CloudSettings.js
 * @description Orchard cloud configuration (AWS_INTEGRATION.md §14).
 */

const SETTINGS_KEY = 'orchard:cloud:settings';

/**
 * @typedef {Object} CloudSettings
 * @property {boolean} enabled
 * @property {string} apiBaseUrl
 * @property {string} registryId
 * @property {'local'|'hybrid'|'cloud-primary'} storageBackend
 * @property {number} syncIntervalSec
 * @property {'poll'|'poll+ws'} [syncTransport]
 * @property {boolean} uploadTraining
 * @property {string} [cognitoDomain]   e.g. https://orchard-dev.auth.us-east-1.amazoncognito.com
 * @property {string} [cognitoClientId]
 * @property {string} [cognitoScope]    default openid email
 */

/** @returns {CloudSettings} */
export function defaultCloudSettings() {
  return {
    enabled: false,
    apiBaseUrl: 'https://jfi0z80zyg.execute-api.us-east-1.amazonaws.com/v1',
    registryId: 'orchard-public',
    storageBackend: 'local',
    syncIntervalSec: 30,
    syncTransport: 'poll',
    uploadTraining: false,
    cognitoDomain: 'https://orchard-dev-orchardp.auth.us-east-1.amazoncognito.com',
    cognitoClientId: 'qp5tn5fsmgfruvjs20hcs3hkg',
    cognitoScope: 'openid email',
  };
}

/** @returns {Promise<CloudSettings>} */
export async function getCloudSettings() {
  const data = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...defaultCloudSettings(), ...(data[SETTINGS_KEY] || {}) };
}

/** @param {Partial<CloudSettings>} patch */
export async function setCloudSettings(patch) {
  const current = await getCloudSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
