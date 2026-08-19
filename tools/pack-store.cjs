#!/usr/bin/env node
'use strict';
/*
 * tools/pack-store.cjs — produce a clean, review-ready Chrome Web Store package from this no-build-step repo.
 * The repo root IS the unpacked extension, but it also carries dev tooling, tests, and docs the store must not
 * see. This stages ONLY the extension's runtime files, applies the store MANIFEST TRANSFORM (derived from the
 * live manifest.json so it can't drift), verifies every manifest reference resolves, and zips.
 *
 * The transform (grounded in the permission audit, 2026-08-18):
 *   - drop `key`               → the store assigns the extension ID (a `key` pins the unpacked-dev ID)
 *   - drop `debugger`          → UNUSED in the whole codebase; the #1 store-review scrutiny driver
 *   - drop `activeTab`         → redundant with the `<all_urls>` host permission + `scripting`
 *   - drop optional `nativeMessaging` → dev-bridge only (Services/Chat/devBridge.js), not an end-user feature
 * Everything else is a used feature (see docs — each permission is rationalized). host_permissions are left as-is;
 * swap the dev orchard endpoint for prod, and consider scoping `<all_urls>`, before a PUBLIC (not unlisted) release.
 *
 * Usage:  node tools/pack-store.cjs        (writes dist/orchard-store-v<version>[.zip])
 * Local dev toolchain only — never part of the shipped bundle.
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const C = require('./updater/promoteChecks.cjs');   // reuse the manifest reference-walk

const REPO = path.resolve(__dirname, '..');
const OUT = process.env.ORCHARD_STORE_OUT || path.join(REPO, 'dist');
const DROP_PERMISSIONS = new Set(['debugger', 'activeTab']);
const EXCLUDE_DIRS = /^(tools|bridge|docs|infra|specs|logs|update|dist|\.wt)\//;

function git(args) { return cp.execFileSync('git', ['-C', REPO].concat(args), { encoding: 'utf8' }); }

/** Is this tracked path part of the shipped extension? (dev dirs, tests, docs, dotfiles → out) */
function included(f) {
  if (EXCLUDE_DIRS.test(f)) return false;
  if (/\.test\.(c?js)$/.test(f)) return false;
  if (f === 'manifest.json') return false;                       // written separately (transformed)
  if (!f.includes('/')) {                                        // root files: keep only real extension assets
    const base = path.basename(f);
    if (/^[._]/.test(base)) return false;                        // dotfiles + _-prefixed
    if (/\.(md|txt|yml|yaml)$/i.test(base)) return false;        // README/CLAUDE/config cruft
    if (base === 'package.json' || base === 'package-lock.json') return false;
  }
  return true;
}

/** Derive the store manifest from the live one. */
function storeManifest(raw) {
  const m = JSON.parse(raw);
  delete m.key;
  if (Array.isArray(m.permissions)) m.permissions = m.permissions.filter((p) => !DROP_PERMISSIONS.has(p));
  delete m.optional_permissions;
  return m;
}

function main() {
  const files = git(['ls-files']).split('\n').filter(Boolean).filter(included);
  const pm = C.parseManifest(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));
  if (!pm.ok) throw new Error('repo manifest.json: ' + pm.error);
  const version = pm.manifest.version;
  const store = storeManifest(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8'));

  // stage a clean copy
  const stage = path.join(OUT, `orchard-store-v${version}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const f of files) {
    const dst = path.join(stage, f);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), dst);
  }
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(store, null, 2) + '\n');

  // verify: every manifest-referenced file made it into the package (brick tier + broken tier)
  const staged = new Set(files.concat('manifest.json'));
  const walk = C.walkRefs(C.collectRefs(store), staged);
  const missing = walk.missing.brick.concat(walk.missing.broken);
  if (missing.length) throw new Error('package is missing manifest-referenced files:\n  ' + missing.join('\n  '));

  // guardrails — nothing that fails a store load or a review sniff
  const leaked = files.filter((f) => /\.test\./.test(f) || (!f.includes('/') && path.basename(f).startsWith('_')));
  if (leaked.length) throw new Error('dev/test files leaked into the package: ' + leaked.slice(0, 8).join(', '));
  const rootUnderscore = git(['ls-tree', '--name-only', 'HEAD']).split('\n').filter((e) => e.startsWith('_'));
  if (rootUnderscore.length) throw new Error('_-prefixed root entries would break the load: ' + rootUnderscore.join(', '));

  console.log(`staged ${files.length} files → ${stage}`);
  console.log(`manifest transform: dropped key, [${[...DROP_PERMISSIONS].join(', ')}], optional_permissions`);
  console.log(`permissions (${store.permissions.length}): ${store.permissions.join(', ')}`);
  console.log(`host_permissions (${(store.host_permissions || []).length}): ${(store.host_permissions || []).join(', ')}`);

  // zip (manifest at the archive ROOT, as the store requires); best-effort via the platform tool
  const zip = `${stage}.zip`;
  fs.rmSync(zip, { force: true });
  try {
    if (process.platform === 'win32') cp.execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -Force`], { stdio: 'ignore' });
    else cp.execFileSync('zip', ['-rq', zip, '.'], { cwd: stage });
    console.log(`zipped → ${zip}  (upload this to the Web Store)`);
  } catch {
    console.log(`(auto-zip unavailable — zip the CONTENTS of ${stage} yourself; manifest.json must be at the zip root)`);
  }
  console.log('\nNEXT: load the staged folder as an unpacked extension once to confirm it runs before uploading.');
}
main();
