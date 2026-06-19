// bridge/mergeVersion.test.js — unit tests for the manifest version merge driver's PURE core (DESIGN dogfooding fix).
// ESM (the harness force-loads .js as ESM); default-imports the CJS module. PURE — no git, no filesystem.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import mv from './mergeVersion.cjs';
const { cmpSemver, resolveVersionBlock, resolveVersionConflicts } = mv;

describe('mergeVersion — semver compare', () => {
  it('orders patch/minor/major; equal; missing/non-numeric components', () => {
    assert.equal(cmpSemver('2.74.1064', '2.74.1063'), 1);
    assert.equal(cmpSemver('2.74.1063', '2.74.1064'), -1);
    assert.equal(cmpSemver('2.74.1063', '2.74.1063'), 0);
    assert.equal(cmpSemver('2.75.0', '2.74.9999'), 1);
    assert.equal(cmpSemver('3.0.0', '2.99.99'), 1);
    assert.equal(cmpSemver('2.74', '2.74.1'), -1);          // missing component = 0
    assert.equal(cmpSemver('x', 'y'), 0);
  });
});

describe('mergeVersion — resolveVersionBlock', () => {
  it('picks the higher version line when both sides are a single version line', () => {
    assert.equal(resolveVersionBlock('  "version": "2.74.1064",', '  "version": "2.74.1063",'), '  "version": "2.74.1064",');
    assert.equal(resolveVersionBlock('  "version": "2.74.1063",', '  "version": "2.74.1065",'), '  "version": "2.74.1065",');
  });
  it('returns null when a side is NOT a lone version line (→ leave the real conflict)', () => {
    assert.equal(resolveVersionBlock('  "name": "Orchard",', '  "name": "AHuB",'), null);
    assert.equal(resolveVersionBlock('  "version": "2.74.1064",\n  "extra": 1', '  "version": "2.74.1063",'), null);  // multi-line
  });
});

describe('mergeVersion — resolveVersionConflicts (the driver core)', () => {
  it('auto-resolves a version-only conflict to the higher version, no conflict left', () => {
    const merged = [
      '{', '  "manifest_version": 3,', '  "name": "Orchard",',
      '<<<<<<< ours', '  "version": "2.74.1064",', '=======', '  "version": "2.74.1063",', '>>>>>>> theirs',
      '  "description": "x"', '}',
    ].join('\n');
    const { text, conflict } = resolveVersionConflicts(merged);
    assert.equal(conflict, false);
    assert.ok(text.includes('"version": "2.74.1064"'));            // the higher one
    assert.equal(/<<<<<<<|=======|>>>>>>>/.test(text), false);     // markers gone
  });

  it('leaves a NON-version conflict intact (and flags conflict=true)', () => {
    const merged = ['<<<<<<< ours', '  "name": "Orchard",', '=======', '  "name": "AHuB",', '>>>>>>> theirs'].join('\n');
    const { text, conflict } = resolveVersionConflicts(merged);
    assert.equal(conflict, true);
    assert.ok(/<<<<<<</.test(text));                               // untouched
  });

  it('resolves the version block but still flags a co-occurring real conflict', () => {
    const merged = [
      '<<<<<<< ours', '  "version": "2.74.1064",', '=======', '  "version": "2.74.1063",', '>>>>>>> theirs',
      '<<<<<<< ours', '  "name": "Orchard",', '=======', '  "name": "AHuB",', '>>>>>>> theirs',
    ].join('\n');
    const { text, conflict } = resolveVersionConflicts(merged);
    assert.equal(conflict, true);                                 // the name conflict remains
    assert.ok(text.includes('"version": "2.74.1064"'));           // …but the version is already resolved
    assert.equal((text.match(/<<<<<<</g) || []).length, 1);       // only the name block left
  });

  it('a clean file (no markers) passes through unchanged, conflict=false', () => {
    const clean = '{\n  "version": "2.74.1067"\n}';
    assert.deepEqual(resolveVersionConflicts(clean), { text: clean, conflict: false });
  });
});
