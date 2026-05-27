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

export const DEFAULT_API_BASE_URL = 'https://jfi0z80zyg.execute-api.us-east-1.amazonaws.com/v1';

/**
 * Normalize API base URL (empty or missing /v1 stage → default dev endpoint).
 * @param {string} [url]
 */
export function normalizeApiBaseUrl(url) {
  const trimmed = (url || '').trim();
  if (!trimmed) return DEFAULT_API_BASE_URL;
  const noTrail = trimmed.replace(/\/+$/, '');
  // Common misconfig: API Gateway host without the /v1 stage → API Gateway 404.
  if (/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/i.test(noTrail)) {
    return `${noTrail}/v1`;
  }
  return noTrail;
}

/** @returns {CloudSettings} */
export function defaultCloudSettings() {
  return {
    enabled: false,
    apiBaseUrl: DEFAULT_API_BASE_URL,
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
  const merged = { ...defaultCloudSettings(), ...(data[SETTINGS_KEY] || {}) };
  merged.apiBaseUrl = normalizeApiBaseUrl(merged.apiBaseUrl);
  if (!merged.cognitoDomain?.trim()) merged.cognitoDomain = defaultCloudSettings().cognitoDomain;
  if (!merged.cognitoClientId?.trim()) merged.cognitoClientId = defaultCloudSettings().cognitoClientId;
  return merged;
}

/** @param {Partial<CloudSettings>} patch */
export async function setCloudSettings(patch) {
  const current = await getCloudSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}
