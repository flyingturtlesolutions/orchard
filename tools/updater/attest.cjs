'use strict';
/*
 * tools/updater/attest.cjs — SU-6 promote-provenance (DESIGN_self_update.md §7 "Push protection"). The one real
 * residual the Rung 7 security red-team named: promote.cjs is the ONLY intended writer of `fleet`, but nothing
 * host-side PROVES the fleet tip came through it — a raw `git push <sha>:fleet` that skipped the gate would be
 * applied. Branch protection is the primary control, but may be unavailable on a GitHub-Free private repo, so this
 * adds a cryptographic belt: promote SIGNS the pushed sha with a private key the DEV machine holds; each fleet
 * machine pins the PUBLIC key at enrollment and refuses any fleet tip without a valid signature.
 *
 * Ed25519 via Node's native crypto (no deps). OPT-IN + backward-compatible: the updater verifies only when a
 * public key is pinned (config.pubkey); absent → it skips, exactly as before. An attacker with fleet/fleet-control
 * write can push a malicious sha + a forged attest.json, but cannot forge a signature valid under the locally-
 * pinned public key (they lack the private key), so verify fails → refused. The pinned key can't be rewritten by a
 * fleet-branch push (it's local, set by the installer). Local dev toolchain only — never the shipped bundle.
 */

const crypto = require('crypto');

/** Generate an Ed25519 keypair. → { publicPem, privatePem } (PEM strings). */
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/** Sign a 40-hex sha with the PEM private key. → base64 signature. Throws on a bad key. */
function signSha(sha, privatePem) {
  return crypto.sign(null, Buffer.from(String(sha)), crypto.createPrivateKey(privatePem)).toString('base64');
}

/** Verify a base64 signature over a sha with the PEM public key. → boolean (never throws). */
function verifySha(sha, sigB64, publicPem) {
  try {
    return crypto.verify(null, Buffer.from(String(sha)), crypto.createPublicKey(publicPem), Buffer.from(String(sigB64 || ''), 'base64'));
  } catch { return false; }
}

/** Is `pem` a usable public key? (cheap shape check so a mangled config value fails loud, not silently.) */
function isPublicKey(pem) {
  try { crypto.createPublicKey(pem); return true; } catch { return false; }
}

module.exports = { generateKeypair, signSha, verifySha, isPublicKey };
