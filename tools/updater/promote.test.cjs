#!/usr/bin/env node
'use strict';
/*
 * tools/updater/promote.test.cjs — standalone self-test (run: `node tools/updater/promote.test.cjs`).
 * Not part of the ESM `npm test` gate (tools/ is outside the glob); mirrors the tools/progress-digest idiom.
 *
 * Two halves:
 *   1. UNIT — the pure checks in promoteChecks.cjs (semver, manifest parse, ref collection/walk, version-move).
 *   2. INTEGRATION — drives promote.cjs against a bare throwaway remote + clone, proving every refusal the
 *      arc (BUILD_ARC_self_update rung 2) lists: candidate-is-origin/main-not-the-dirty-checkout, failing gate,
 *      dangling manifest reference, version-not-bumped, node --check, nothing-to-promote, and hold/release on
 *      the dedicated fleet-control ref.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./promoteChecks.cjs');

const PROMOTE = path.join(__dirname, 'promote.cjs');
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

// ============================================================ 1. UNIT ============================================================

// semver
ok(C.cmpSemver('2.74.2224', '2.74.2223') === 1, 'cmpSemver: patch greater');
ok(C.cmpSemver('2.74.2224', '2.74.2224') === 0, 'cmpSemver: equal');
ok(C.cmpSemver('2.74.9', '2.74.10') === -1, 'cmpSemver: numeric, not lexical (9 < 10)');
ok(C.cmpSemver('3.0.0', '2.99.99') === 1, 'cmpSemver: major dominates');

// parseManifest
ok(C.parseManifest('{"version":"1.2.3"}').ok, 'parseManifest: good');
ok(!C.parseManifest('{bad json').ok, 'parseManifest: refuses invalid JSON');
ok(!C.parseManifest('{"name":"x"}').ok, 'parseManifest: refuses missing version');
ok(!C.parseManifest('{"version":1}').ok, 'parseManifest: refuses non-string version');

// collectRefs on the REAL shipped manifest shape (read the actual repo manifest)
const realManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'manifest.json'), 'utf8'));
const refs = C.collectRefs(realManifest);
ok(refs.brick.includes('background.js'), 'collectRefs: service worker is brick tier');
ok(refs.brick.includes('ContentScripts/contentScript.js'), 'collectRefs: content script js is brick tier');
ok(refs.brick.includes('assets/icon16.png'), 'collectRefs: icons are brick tier');
ok(refs.broken.includes('chat.html'), 'collectRefs: side_panel.default_path is broken tier');
ok(refs.globsSkipped > 0, 'collectRefs: glob WAR entries (assets/*) are skipped, and counted');
ok(!refs.brick.some((p) => p.includes('*')) && !refs.broken.some((p) => p.includes('*')), 'collectRefs: no globs leak into either tier');

// walkRefs
const treeSet = new Set(['background.js', 'ContentScripts/contentScript.js', 'assets/icon16.png', 'assets/icon128.png', 'chat.html']);
ok(C.walkRefs({ brick: ['background.js'], broken: ['chat.html'] }, treeSet).ok, 'walkRefs: all present → ok');
const w1 = C.walkRefs({ brick: ['background.js', 'missing.js'], broken: [] }, treeSet);
ok(!w1.ok && w1.missing.brick.includes('missing.js'), 'walkRefs: missing brick file → not ok, named');
const w2 = C.walkRefs({ brick: [], broken: ['gone.html'] }, treeSet);
ok(!w2.ok && w2.missing.broken.includes('gone.html'), 'walkRefs: missing broken file → not ok (refuse on any tier)');

// versionMoved
ok(C.versionMoved({ candidateVersion: '1.0.1', fleetVersion: null, filesDiffer: true }).ok, 'versionMoved: no fleet → first promotion ok');
ok(C.versionMoved({ candidateVersion: '1.0.1', fleetVersion: '1.0.0', filesDiffer: true }).ok, 'versionMoved: bumped → ok');
ok(C.versionMoved({ candidateVersion: '1.0.0', fleetVersion: '1.0.0', filesDiffer: true }).code === 'version-not-bumped', 'versionMoved: same version + file diff → REFUSE');
ok(C.versionMoved({ candidateVersion: '1.0.0', fleetVersion: '1.0.0', filesDiffer: false }).code === 'nothing-to-promote', 'versionMoved: same version, no diff → no-op');
ok(C.versionMoved({ candidateVersion: '1.0.0', fleetVersion: '1.0.1', filesDiffer: true }).code === 'downgrade-forbidden', 'versionMoved: older candidate → REFUSE (fix-forward only)');

// looksLikeEsm / isCheckableJs
ok(C.looksLikeEsm("import { x } from './y.js';"), 'looksLikeEsm: import');
ok(C.looksLikeEsm('export const z = 1;'), 'looksLikeEsm: export');
ok(!C.looksLikeEsm("const y = require('./y.js');"), 'looksLikeEsm: require is not ESM');
ok(C.isCheckableJs('Core/foo.js') && !C.isCheckableJs('node_modules/x/a.js') && !C.isCheckableJs('update/ready.json'), 'isCheckableJs: js yes, node_modules/update no');

// ============================================================ 2. INTEGRATION ============================================================

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-promote-fixture-'));
const REMOTE = path.join(ROOT, 'remote.git');
const WORK = path.join(ROOT, 'work');
const G = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function baseEnv(extra) {
  return Object.assign({}, process.env, { ORCHARD_PROMOTE_DRY_RUN: '', ORCHARD_PROMOTE_SKIP_NODECHECK: '1', ORCHARD_PROMOTE_TEST_CMD: 'node -e "process.exit(0)"' }, extra || {});
}
function runPromote(args, extraEnv) {
  const r = spawnSync(process.execPath, [PROMOTE].concat(args), { cwd: WORK, env: baseEnv(extraEnv), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + '', err: (r.stderr || '') + '' };
}
function writeExtension(dir, version, opts) {
  opts = opts || {};
  const manifest = {
    manifest_version: 3, name: 'Fixture', version,
    background: { service_worker: 'background.js', type: 'module' },
    side_panel: { default_path: 'chat.html' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['ContentScripts/contentScript.js'] }],
    web_accessible_resources: [{ resources: ['assets/*', 'chat.html'], matches: ['<all_urls>'] }],
    icons: { 16: 'assets/icon16.png', 128: 'assets/icon128.png' },
  };
  fs.mkdirSync(path.join(dir, 'ContentScripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'background.js'), `// sw v${version}\nconst hb = ${opts.bg || 1};\n`);
  fs.writeFileSync(path.join(dir, 'ContentScripts', 'contentScript.js'), '// cs\n');
  fs.writeFileSync(path.join(dir, 'chat.html'), '<!doctype html><title>fixture</title>');
  fs.writeFileSync(path.join(dir, 'assets', 'icon16.png'), 'png16');
  fs.writeFileSync(path.join(dir, 'assets', 'icon128.png'), 'png128');
}
function commitPush(version, msg) {
  G(['add', '-A'], WORK);
  G(['commit', '-m', msg], WORK);
  G(['push', 'origin', 'main'], WORK);
}
function setFleetToMain() { G(['push', 'origin', '+main:refs/heads/fleet'], WORK); }
function controlValue() { return JSON.parse(G(['show', 'origin/fleet-control:update/control.json'], WORK)).hold; }

let integrationRan = false;
try {
  // --- fixture: bare remote + clone with an initial extension at v1.0.0, fleet pinned there ---
  fs.mkdirSync(REMOTE, { recursive: true });
  G(['init', '--bare', REMOTE], ROOT);
  G(['init', WORK], ROOT);
  G(['symbolic-ref', 'HEAD', 'refs/heads/main'], WORK);
  G(['config', 'user.email', 'fixture@example.com'], WORK);
  G(['config', 'user.name', 'Fixture'], WORK);
  G(['config', 'commit.gpgsign', 'false'], WORK);
  G(['remote', 'add', 'origin', REMOTE], WORK);
  writeExtension(WORK, '1.0.0', { bg: 1 });
  commitPush('1.0.0', 'v1.0.0');
  setFleetToMain();                                  // fleet = v1.0.0
  integrationRan = true;

  // Case A — SUCCESS, and candidate is origin/main NOT the dirty checkout.
  // Bump to v1.0.1 on main, THEN dirty the working tree with a test-breaking edit that is never committed.
  writeExtension(WORK, '1.0.1', { bg: 2 });
  commitPush('1.0.1', 'v1.0.1');
  fs.writeFileSync(path.join(WORK, 'background.js'), 'this is ( not valid javascript {{{');   // uncommitted dirt
  const a = runPromote(['promote'], { ORCHARD_PROMOTE_DRY_RUN: '1' });
  ok(a.code === 0 && /DRY-RUN: would push/.test(a.out), 'promote: bumped candidate passes (dry-run would push)');
  ok(/v1\.0\.0 → v1\.0\.1/.test(a.out), 'promote: version line shows the movement');
  ok(a.code === 0, 'promote: DIRTY working-tree dirt did NOT fail the gate — it gated origin/main, not the checkout (F1)');
  G(['checkout', '--', 'background.js'], WORK);       // drop the dirt

  // Case B — failing gate command → refusal, fleet unmoved.
  const b = runPromote(['promote'], { ORCHARD_PROMOTE_DRY_RUN: '1', ORCHARD_PROMOTE_TEST_CMD: 'node -e "process.exit(1)"' });
  ok(b.code === 1 && /gate command failed/.test(b.err), 'promote: failing gate → REFUSED');

  // Case C — dangling manifest reference (delete a referenced content script) → refusal before the gate runs.
  fs.rmSync(path.join(WORK, 'ContentScripts', 'contentScript.js'));
  writeExtensionBumpKeepingDeletion('1.0.2');
  commitPush('1.0.2', 'v1.0.2 with dangling ref');
  const c = runPromote(['promote'], { ORCHARD_PROMOTE_DRY_RUN: '1' });
  ok(c.code === 1 && /references files absent/.test(c.err) && /contentScript\.js/.test(c.err), 'promote: dangling manifest ref → REFUSED (brick tier)');
  // restore the content script for later cases
  fs.mkdirSync(path.join(WORK, 'ContentScripts'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'ContentScripts', 'contentScript.js'), '// cs\n');
  writeExtension(WORK, '1.0.3', { bg: 3 });
  commitPush('1.0.3', 'v1.0.3 healthy');
  setFleetToMain();                                  // fleet = v1.0.3

  // Case D — file changed but version NOT bumped → refusal.
  writeExtension(WORK, '1.0.3', { bg: 4 });          // same version, different background.js
  commitPush('1.0.3', 'behavior change, forgot the bump');
  const d = runPromote(['promote'], { ORCHARD_PROMOTE_DRY_RUN: '1' });
  ok(d.code === 1 && /version-not-bumped/.test(d.err), 'promote: unbumped behavior change → REFUSED');

  // Case E — node --check catches a syntactically broken (non-referenced) tracked file.
  writeExtension(WORK, '1.0.4', { bg: 5 });
  fs.writeFileSync(path.join(WORK, 'broken.js'), 'function ( {{{ not js');
  commitPush('1.0.4', 'v1.0.4 with a broken file');
  const e = runPromote(['promote'], { ORCHARD_PROMOTE_SKIP_NODECHECK: '' });   // nodecheck ON
  ok(e.code === 1 && /node --check failed/.test(e.err) && /broken\.js/.test(e.err), 'promote: node --check catches broken syntax → REFUSED');
  G(['rm', 'broken.js'], WORK);
  writeExtension(WORK, '1.0.5', { bg: 6 });
  commitPush('1.0.5', 'v1.0.5 clean');
  setFleetToMain();                                  // fleet = v1.0.5

  // Case F — nothing to promote (fleet == main, identical) → clean exit 0, not a refusal.
  const f = runPromote(['promote'], { ORCHARD_PROMOTE_DRY_RUN: '1' });
  ok(f.code === 0 && /nothing to promote/.test(f.out), 'promote: fleet already current → clean no-op (exit 0)');

  // Case G — hold / release on the dedicated fleet-control ref.
  // create fleet-control (rung 1 / SU-0 does this; the fixture creates it so hold/release have a branch)
  G(['worktree', 'add', '--detach', path.join(ROOT, 'ctl'), 'HEAD'], WORK);
  const CTL = path.join(ROOT, 'ctl');
  G(['checkout', '--orphan', 'fleet-control'], CTL);
  G(['rm', '-rf', '.'], CTL);
  fs.mkdirSync(path.join(CTL, 'update'), { recursive: true });
  fs.writeFileSync(path.join(CTL, 'update', 'control.json'), JSON.stringify({ hold: false }, null, 2) + '\n');
  G(['add', 'update/control.json'], CTL);
  G(['commit', '-m', 'control: init'], CTL);
  G(['push', 'origin', 'fleet-control'], CTL);
  G(['worktree', 'remove', '--force', CTL], WORK);

  ok(controlValue() === false, 'fleet-control seeded with hold=false');
  const h = runPromote(['hold'], {});
  ok(h.code === 0 && /HELD/.test(h.out), 'promote hold → exit 0, HELD');
  G(['fetch', 'origin', 'fleet-control'], WORK);
  ok(controlValue() === true, 'hold flipped fleet-control.control.hold=true (payload branch untouched)');
  const rel = runPromote(['release'], {});
  ok(rel.code === 0 && /RELEASED/.test(rel.out), 'promote release → exit 0, RELEASED');
  G(['fetch', 'origin', 'fleet-control'], WORK);
  ok(controlValue() === false, 'release flipped fleet-control.control.hold=false');

  // hold/release must NOT have moved the payload fleet ref (v1.0.5)
  const fleetManifestV = JSON.parse(G(['show', 'origin/fleet:manifest.json'], WORK)).version;
  ok(fleetManifestV === '1.0.5', 'hold/release left the payload fleet branch at v1.0.5 (kill switch is off the payload)');

} catch (err) {
  fail++;
  console.error('  ✗ INTEGRATION threw: ' + (err && err.message));
  if (err && err.stderr) console.error('    ' + String(err.stderr).split('\n').slice(0, 6).join('\n    '));
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}

// helper hoisted for Case C — bump the manifest version while leaving the deleted content script deleted
function writeExtensionBumpKeepingDeletion(version) {
  const m = JSON.parse(fs.readFileSync(path.join(WORK, 'manifest.json'), 'utf8'));
  m.version = version;
  fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
}

// ============================================================ REPORT ============================================================
console.log(`\npromote.test.cjs: ${pass} passed, ${fail} failed${integrationRan ? '' : ' (INTEGRATION SKIPPED — setup failed)'}`);
process.exit(fail ? 1 : 0);
