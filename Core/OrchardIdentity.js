/**
 * @file Core/OrchardIdentity.js
 * @description Device-local Ed25519 identity for Orchard cloud bind (DD-01).
 * Derives client-side `orchardUserId` preview; canonical id assigned by server on bind.
 */

const STORAGE_KEY = 'orchard:identity:keypair';

/**
 * @param {ArrayBuffer} bytes
 * @returns {string}
 */
function bufferToBase64Url(bytes) {
  const bin = String.fromCharCode(...new Uint8Array(bytes));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * @param {string} base64url
 * @returns {Uint8Array}
 */
function base64UrlToBytes(base64url) {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/')
    + '==='.slice((base64url.length + 3) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * @param {ArrayBuffer} publicKeyRaw
 * @returns {Promise<string>}
 */
export async function deriveOrchardUserId(publicKeyRaw) {
  const hash = await crypto.subtle.digest('SHA-256', publicKeyRaw);
  return `pk_${bufferToBase64Url(hash).slice(0, 22)}`;
}

/**
 * @returns {Promise<{ publicKeyB64: string, privateKeyJwk: JsonWebKey, publicKeyRaw: ArrayBuffer }>}
 */
export async function getOrCreateKeyPair() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (stored[STORAGE_KEY]) {
    const { publicKeyB64, privateKeyJwk } = stored[STORAGE_KEY];
    const publicKeyRaw = base64UrlToBytes(publicKeyB64).buffer;
    return { publicKeyB64, privateKeyJwk, publicKeyRaw };
  }

  const keyPair = await crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  );

  const publicKeyRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
  const publicKeyB64 = bufferToBase64Url(publicKeyRaw);

  await chrome.storage.local.set({
    [STORAGE_KEY]: { publicKeyB64, privateKeyJwk },
  });

  return { publicKeyB64, privateKeyJwk, publicKeyRaw };
}

/**
 * @returns {Promise<{ publicKeyB64: string, orchardUserIdPreview: string }>}
 */
export async function getIdentitySummary() {
  const { publicKeyB64, publicKeyRaw } = await getOrCreateKeyPair();
  const orchardUserIdPreview = await deriveOrchardUserId(publicKeyRaw);
  return { publicKeyB64, orchardUserIdPreview };
}

/**
 * Sign a bind challenge from POST /identity/bind (P0).
 * @param {string} challengeB64url
 * @returns {Promise<string>} signature base64url
 */
export async function signBindChallenge(challengeB64url) {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  if (!stored[STORAGE_KEY]) throw new Error('No identity keypair — call getOrCreateKeyPair first');

  const { privateKeyJwk } = stored[STORAGE_KEY];
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'Ed25519' },
    false,
    ['sign'],
  );

  const message = base64UrlToBytes(challengeB64url);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message);
  return bufferToBase64Url(sig);
}
