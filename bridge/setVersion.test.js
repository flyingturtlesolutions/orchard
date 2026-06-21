// bridge/setVersion.test.js — unit tests for the version-at-land stamp's PURE core (docs/DESIGN_surfaces.md §4.2).
// ESM (the harness force-loads .js as ESM); default-imports the CJS module. PURE — no git, no filesystem.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import sv from './setVersion.cjs';
const { parseVersion, bumpPatch, stampVersionLine } = sv;

describe('setVersion — parseVersion', () => {
  it('extracts the version from a manifest blob', () => {
    const mf = '{\n  "manifest_version": 3,\n  "name": "Orchard",\n  "version": "2.74.1137",\n  "description": "x"\n}';
    assert.equal(parseVersion(mf), '2.74.1137');
  });
  it('null when there is no version line', () => {
    assert.equal(parseVersion('{\n  "name": "Orchard"\n}'), null);
    assert.equal(parseVersion(''), null);
    assert.equal(parseVersion(null), null);
  });
});

describe('setVersion — bumpPatch (the land assigns current + 1)', () => {
  it('bumps the last (patch) component', () => {
    assert.equal(bumpPatch('2.74.1137'), '2.74.1138');
    assert.equal(bumpPatch('2.74.999'), '2.74.1000');     // multi-digit carry within the component
    assert.equal(bumpPatch('2.74.1999'), '2.74.2000');
    assert.equal(bumpPatch('0.0.0'), '0.0.1');
  });
  it('monotonic + unique when applied repeatedly (the funnel: 1137→1138→1139)', () => {
    let v = '2.74.1137';
    const seen = [];
    for (let i = 0; i < 3; i++) { v = bumpPatch(v); seen.push(v); }
    assert.deepEqual(seen, ['2.74.1138', '2.74.1139', '2.74.1140']);
  });
  it('null on a malformed patch (→ the land aborts rather than writing garbage)', () => {
    assert.equal(bumpPatch('2.74.x'), null);
    assert.equal(bumpPatch('2.74.10a'), null);
    assert.equal(bumpPatch('abc'), null);
    assert.equal(bumpPatch(''), null);
    assert.equal(bumpPatch(null), null);
  });
});

describe('setVersion — stampVersionLine', () => {
  it('replaces ONLY the version line, preserving indent + trailing comma + the rest of the file', () => {
    const mf = '{\n  "manifest_version": 3,\n  "name": "Orchard",\n  "version": "2.74.1137",\n  "description": "x"\n}';
    const r = stampVersionLine(mf, '2.74.1138');
    assert.equal(r.from, '2.74.1137');
    assert.ok(r.text.includes('  "version": "2.74.1138",'));      // indent + comma preserved
    assert.ok(r.text.includes('"manifest_version": 3'));          // untouched
    assert.ok(r.text.includes('"description": "x"'));             // untouched
    assert.equal(/2\.74\.1137/.test(r.text), false);              // old version gone
  });
  it('works without a trailing comma', () => {
    const r = stampVersionLine('{\n  "version": "2.74.1067"\n}', '2.74.1068');
    assert.ok(r.text.includes('"version": "2.74.1068"'));
    assert.equal(r.from, '2.74.1067');
  });
  it('null when there is no version line', () => {
    assert.equal(stampVersionLine('{\n  "name": "Orchard"\n}', '2.74.1'), null);
  });
  it('null on a malformed target version (refuse to write nonsense)', () => {
    assert.equal(stampVersionLine('{\n  "version": "2.74.1"\n}', 'nope'), null);
    assert.equal(stampVersionLine('{\n  "version": "2.74.1"\n}', ''), null);
  });
  it('end-to-end: parse → bump → stamp lands current+1', () => {
    const mf = '{\n  "version": "2.74.1137",\n  "key": "abc"\n}';
    const next = bumpPatch(parseVersion(mf));
    const r = stampVersionLine(mf, next);
    assert.equal(next, '2.74.1138');
    assert.ok(r.text.includes('"version": "2.74.1138"'));
    assert.ok(r.text.includes('"key": "abc"'));                  // a key value containing digits is NOT touched
  });
});
