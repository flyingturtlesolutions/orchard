#!/usr/bin/env node
// tools/exercise/exercise.test.cjs — EX-2 (v2.74.1949). Standalone (like tools/progress-digest/digest.test.cjs);
// the npm gate only runs Core/ + Services/, so run this directly:  node tools/exercise/exercise.test.cjs
//
// Only one thing here is worth testing and it is worth testing a lot: the extension-id derivation. It is the
// harness's ENTIRE allow-list — the guarantee that a CDP evaluate lands in Orchard's panel and never in a banking
// tab. And its failure mode is quiet: a wrong id matches no targets, so the harness reports "extension not
// loaded" and a human goes looking at chrome://extensions instead of at this function.
//
// The vector is INDEPENDENT ground truth, not a restatement of the algorithm: `pnihglgmdjgdckddleipneompomedioc`
// is the id hardcoded in infra/orchard-dev/lib/p0-stack.js (the deployed dev stack, written long before this
// harness). Deriving it from manifest.key and getting the same 32 chars proves the derivation against a value
// nothing here produced.

'use strict';

const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const { extensionIdFromKey } = require('./exercise.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));

const KNOWN_ID = 'pnihglgmdjgdckddleipneompomedioc';   // infra/orchard-dev/lib/p0-stack.js — independent source

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`ok  - ${name}`); } catch (e) { console.error(`FAIL- ${name}\n     ${e.message}`); process.exitCode = 1; } };

t('derives the REAL extension id from manifest.key (vector from the deployed dev stack)', () => {
  assert.equal(extensionIdFromKey(MANIFEST.key), KNOWN_ID);
});

t('the id is 32 chars in Chrome\'s a-p alphabet', () => {
  const id = extensionIdFromKey(MANIFEST.key);
  assert.equal(id.length, 32);
  assert.match(id, /^[a-p]{32}$/);
});

t('is deterministic', () => {
  assert.equal(extensionIdFromKey(MANIFEST.key), extensionIdFromKey(MANIFEST.key));
});

t('a DIFFERENT key yields a different id (the allow-list actually discriminates)', () => {
  // If this ever passed, every extension would share one id and the allow-list would be worthless.
  const other = Buffer.from('a different public key entirely').toString('base64');
  assert.notEqual(extensionIdFromKey(other), KNOWN_ID);
  assert.match(extensionIdFromKey(other), /^[a-p]{32}$/);
});

t('junk input still produces a well-formed id rather than throwing', () => {
  // A malformed manifest must fail as "no targets matched", never as an unhandled crash mid-drive.
  for (const junk of ['', null, undefined, 'not-base64!!']) {
    assert.match(extensionIdFromKey(junk), /^[a-p]{32}$/);
  }
});

t('the empty-key id is NOT the real id (a missing key cannot silently match)', () => {
  assert.notEqual(extensionIdFromKey(''), KNOWN_ID);
});

console.log(`\n${pass} passing${process.exitCode ? ' — WITH FAILURES' : ''}`);
