#!/usr/bin/env node
'use strict';
/* tools/updater/attest.test.cjs — standalone self-test (run: `node tools/updater/attest.test.cjs`).
 * SU-6 provenance crypto: Ed25519 sign/verify round-trip + the negative cases the updater's refusal relies on. */

const A = require('./attest.cjs');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

const kp = A.generateKeypair();
ok(/BEGIN PUBLIC KEY/.test(kp.publicPem), 'generateKeypair: public PEM');
ok(/BEGIN PRIVATE KEY/.test(kp.privatePem), 'generateKeypair: private PEM');
ok(A.isPublicKey(kp.publicPem), 'isPublicKey: true for a real public key');
ok(!A.isPublicKey('not a key'), 'isPublicKey: false for garbage');

const sha = '9079f232d303157acfa6548dab77d0d6f907e5f2';
const sig = A.signSha(sha, kp.privatePem);
ok(typeof sig === 'string' && sig.length > 40, 'signSha: produces a base64 signature');
ok(A.verifySha(sha, sig, kp.publicPem) === true, 'verifySha: valid signature verifies');
ok(A.verifySha('deadbeef' + sha.slice(8), sig, kp.publicPem) === false, 'verifySha: a different sha fails (integrity)');
ok(A.verifySha(sha, 'AAAA' + sig.slice(4), kp.publicPem) === false, 'verifySha: a tampered signature fails');

const other = A.generateKeypair();
ok(A.verifySha(sha, sig, other.publicPem) === false, 'verifySha: a signature from another key fails (authenticity)');
ok(A.verifySha(sha, sig, 'garbage-not-a-pem') === false, 'verifySha: a bad public key returns false, never throws');
ok(A.verifySha(sha, '', kp.publicPem) === false, 'verifySha: empty signature fails cleanly');

console.log(`\nattest.test.cjs: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
