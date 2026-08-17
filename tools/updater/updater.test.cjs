#!/usr/bin/env node
'use strict';
/*
 * tools/updater/updater.test.cjs — standalone self-test (run: `node tools/updater/updater.test.cjs`).
 * Drives the WHOLE updater recipe against a throwaway bare-remote + clone, asserting the on-disk effects of
 * every drill the arc (BUILD_ARC_self_update rung 3) names: apply+stamp, no-op-when-current, hold,
 * unparseable-control→hold, dirty-refusal, torn-apply journal recovery, stale-lock steal vs live-lock yield,
 * brick-tree refusal, fetch-failure, and stamp-on-every-exit.
 */

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPDATER = path.join(__dirname, 'updater.cjs');
const ATT = require('./attest.cjs');   // SU-6 provenance
let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'orchard-updater-fixture-'));
const REMOTE = path.join(ROOT, 'remote.git');
const WORK = path.join(ROOT, 'work');       // the authoring clone (pushes fleet)
const FLEETCLONE = path.join(ROOT, 'fleetclone');  // the "fleet machine" the updater manages
const STATE = path.join(ROOT, 'state');
const G = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function writeExtension(dir, version, opts) {
  opts = opts || {};
  const manifest = {
    manifest_version: 3, name: 'Fixture', version,
    background: { service_worker: 'background.js', type: 'module' },
    side_panel: { default_path: 'chat.html' },
    content_scripts: [{ matches: ['<all_urls>'], js: ['ContentScripts/contentScript.js'] }],
    icons: { 16: 'assets/icon16.png' },
  };
  fs.mkdirSync(path.join(dir, 'ContentScripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'background.js'), `// sw v${version}\nconst hb = ${opts.bg || 1};\n`);
  fs.writeFileSync(path.join(dir, 'ContentScripts', 'contentScript.js'), '// cs\n');
  fs.writeFileSync(path.join(dir, 'chat.html'), '<!doctype html>');
  fs.writeFileSync(path.join(dir, 'assets', 'icon16.png'), 'png');
}
function commitPushMain(dir, version, msg) { writeExtension(dir, version, { bg: version.replace(/\D/g, '') }); G(['add', '-A'], dir); G(['commit', '-m', msg], dir); G(['push', 'origin', 'main'], dir); }
function setFleet(sha) { G(['push', 'origin', `+${sha}:refs/heads/fleet`], WORK); }
function setControl(holdJsonOrRaw) {
  const raw = typeof holdJsonOrRaw === 'string' ? holdJsonOrRaw : JSON.stringify({ hold: holdJsonOrRaw }, null, 2) + '\n';
  const ctl = path.join(ROOT, 'ctl');
  G(['worktree', 'add', '-B', 'fleet-control', ctl, 'origin/fleet-control'], WORK);
  fs.mkdirSync(path.join(ctl, 'update'), { recursive: true });
  fs.writeFileSync(path.join(ctl, 'update', 'control.json'), raw);
  G(['add', 'update/control.json'], ctl);
  if (G(['status', '--porcelain'], ctl)) { G(['commit', '-m', 'control'], ctl); G(['push', 'origin', 'fleet-control'], ctl); }
  G(['worktree', 'remove', '--force', ctl], WORK);
}
function runUpdater(extraEnv) {
  const env = Object.assign({}, process.env, {
    ORCHARD_UPDATER_CLONE: FLEETCLONE, ORCHARD_UPDATER_STATE: STATE,
    ORCHARD_UPDATER_REMOTE: 'origin', ORCHARD_UPDATER_FLEET: 'fleet', ORCHARD_UPDATER_CONTROL: 'fleet-control',
  }, extraEnv || {});
  const r = spawnSync(process.execPath, [UPDATER], { cwd: FLEETCLONE, env, encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const readyVer = () => { try { return JSON.parse(fs.readFileSync(path.join(FLEETCLONE, 'update', 'ready.json'), 'utf8')).version; } catch { return null; } }
const stateFile = () => { try { return JSON.parse(fs.readFileSync(path.join(FLEETCLONE, 'update', 'updater-state.json'), 'utf8')); } catch { return null; } }
const headVer = () => JSON.parse(G(['show', 'HEAD:manifest.json'], FLEETCLONE)).version;

let ran = false;
try {
  // --- fixture: remote with main+fleet at v1.0.0 and a fleet-control(hold=false); a "fleet machine" clone at v1.0.0 ---
  fs.mkdirSync(REMOTE, { recursive: true });
  G(['init', '--bare', REMOTE], ROOT);
  G(['init', WORK], ROOT);
  G(['symbolic-ref', 'HEAD', 'refs/heads/main'], WORK);
  for (const k of [['user.email', 'f@x.io'], ['user.name', 'F'], ['commit.gpgsign', 'false']]) G(['config', k[0], k[1]], WORK);
  G(['remote', 'add', 'origin', REMOTE], WORK);
  commitPushMain(WORK, '1.0.0', 'v1.0.0');
  setFleet('main');
  // seed fleet-control (orphan)
  const ctl0 = path.join(ROOT, 'ctl0');
  G(['worktree', 'add', '--detach', ctl0, 'HEAD'], WORK);
  G(['checkout', '--orphan', 'fleet-control'], ctl0);
  G(['rm', '-rf', '.'], ctl0);
  fs.mkdirSync(path.join(ctl0, 'update'), { recursive: true });
  fs.writeFileSync(path.join(ctl0, 'update', 'control.json'), JSON.stringify({ hold: false }, null, 2) + '\n');
  G(['add', 'update/control.json'], ctl0); G(['commit', '-m', 'control init'], ctl0); G(['push', 'origin', 'fleet-control'], ctl0);
  G(['worktree', 'remove', '--force', ctl0], WORK);
  // the fleet machine clones at v1.0.0
  G(['clone', REMOTE, FLEETCLONE], ROOT);
  for (const k of [['user.email', 'm@x.io'], ['user.name', 'M'], ['commit.gpgsign', 'false']]) G(['config', k[0], k[1]], FLEETCLONE);
  G(['checkout', '-B', 'fleet', 'origin/fleet'], FLEETCLONE);   // mimic the installer: land on a dedicated fleet branch (F11)
  ran = true;

  // Case 1 — APPLY: fleet advances to v1.0.1, updater converges the clone + stamps ready + state=ok.
  commitPushMain(WORK, '1.0.1', 'v1.0.1'); setFleet('main');
  const r1 = runUpdater();
  ok(r1.code === 0, 'updater exits 0 on apply');
  ok(headVer() === '1.0.1', 'apply: clone HEAD converged to fleet tip v1.0.1');
  ok(readyVer() === '1.0.1', 'apply: ready.json stamped v1.0.1');
  ok(stateFile() && stateFile().state === 'ok' && stateFile().applied === true, 'apply: updater-state state=ok applied=true');
  ok(!fs.existsSync(path.join(STATE, 'lock')), 'apply: lock released');
  ok(!fs.existsSync(path.join(STATE, 'apply-in-progress')), 'apply: journal cleared');

  // Case 2 — NO-OP when current: HEAD already == fleet.
  const r2 = runUpdater();
  ok(r2.code === 0 && headVer() === '1.0.1' && stateFile().state === 'ok', 'no-op when current: stays v1.0.1, state=ok');

  // Case 3 — HOLD: control hold=true, fleet advances to v1.0.2 → updater must NOT apply.
  setControl(true);
  commitPushMain(WORK, '1.0.2', 'v1.0.2'); setFleet('main');
  runUpdater();
  ok(headVer() === '1.0.1', 'hold: clone did NOT advance to v1.0.2');
  ok(stateFile().state === 'held' && stateFile().hold === true, 'hold: state=held, visible in the heartbeat');
  ok(readyVer() === '1.0.1', 'hold: ready.json not advanced');

  // Case 4 — unparseable control → fail-safe hold.
  setControl('{ this is not json ');
  runUpdater();
  ok(headVer() === '1.0.1' && stateFile().state === 'held' && stateFile().lastError === 'control-unparseable', 'unparseable control → held + lastError');
  setControl(false);   // release for later cases

  // Case 5 — dirty working tree → refuse (protect human edits).
  fs.appendFileSync(path.join(FLEETCLONE, 'background.js'), '// a human hand-edit\n');
  runUpdater();
  ok(headVer() === '1.0.1', 'dirty: refused, clone unchanged');
  ok(stateFile().state === 'refused:dirty', 'dirty: state=refused:dirty (visible, not silent)');
  G(['checkout', '--', 'background.js'], FLEETCLONE);   // drop the dirt

  // Case 6 — torn-apply recovery: a journal + dirty tree from an interrupted reset self-heals, bypassing the dirty guard.
  const tip = G(['rev-parse', 'origin/fleet'], FLEETCLONE);   // v1.0.2 tip
  fs.writeFileSync(path.join(STATE, 'apply-in-progress'), tip + '\n');
  fs.appendFileSync(path.join(FLEETCLONE, 'background.js'), '// torn half-write\n');   // simulate the interrupted reset's dirt
  runUpdater();
  ok(headVer() === '1.0.2', 'torn-apply: recovery force-reset to the journal sha (v1.0.2), dirty guard bypassed');
  ok(!fs.existsSync(path.join(STATE, 'apply-in-progress')), 'torn-apply: journal cleared after recovery');
  ok(readyVer() === '1.0.2' && stateFile().state === 'ok', 'torn-apply: converged + ready stamped v1.0.2');

  // Case 7 — stale-lock steal vs live-lock yield.
  commitPushMain(WORK, '1.0.3', 'v1.0.3'); setFleet('main');
  fs.writeFileSync(path.join(STATE, 'lock'), JSON.stringify({ pid: 2147480000, at: Math.floor(Date.now() / 1000) - 99999, host: 'ghost' }));
  runUpdater();
  ok(headVer() === '1.0.3', 'stale-lock (dead pid, old): stolen → applied v1.0.3');
  // a LIVE, fresh lock (this test process is alive) must make the updater yield
  commitPushMain(WORK, '1.0.4', 'v1.0.4'); setFleet('main');
  fs.writeFileSync(path.join(STATE, 'lock'), JSON.stringify({ pid: process.pid, at: Math.floor(Date.now() / 1000), host: 'live' }));
  runUpdater();
  ok(headVer() === '1.0.3', 'live-lock: updater yielded (did NOT apply v1.0.4)');
  fs.rmSync(path.join(STATE, 'lock'), { force: true });

  // Case 8 — brick-tree refusal: fleet points at a tree whose manifest references a missing file.
  fs.rmSync(path.join(WORK, 'ContentScripts', 'contentScript.js'));
  const m = JSON.parse(fs.readFileSync(path.join(WORK, 'manifest.json'), 'utf8')); m.version = '1.0.5';
  fs.writeFileSync(path.join(WORK, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
  G(['add', '-A'], WORK); G(['commit', '-m', 'v1.0.5 dangling ref'], WORK); G(['push', 'origin', 'main'], WORK); setFleet('main');
  runUpdater();
  ok(headVer() === '1.0.3', 'brick-tree (dangling ref): refused, clone stays v1.0.3');
  ok(stateFile().state === 'refused:invalid' && /missing-ref/.test(stateFile().lastError), 'brick-tree: state=refused:invalid + missing-ref');

  // Case 9 — fetch failure surfaces as state=error, still stamps (heartbeat never goes silent).
  const r9 = runUpdater({ ORCHARD_UPDATER_REMOTE: 'nosuchremote' });
  ok(r9.code === 0 && stateFile().state === 'error' && stateFile().fetchOk === false, 'fetch-fail: state=error, fetchOk=false, still stamped');

  // ===== review-fix drills (adversarial review 2026-08-14) =====
  // restore a healthy base (case 8 deleted the content script); converge the clone to a clean v1.0.6.
  commitPushMain(WORK, '1.0.6', 'v1.0.6 healthy'); setFleet('main');
  runUpdater();
  ok(headVer() === '1.0.6', 'base restored: clone converged to clean v1.0.6');

  // F1 — a FAILED reset (bogus journal sha) must LEAVE the journal for a later tick, not clear it + stamp.
  fs.writeFileSync(path.join(STATE, 'apply-in-progress'), 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n');
  runUpdater();
  ok(fs.existsSync(path.join(STATE, 'apply-in-progress')), 'F1: failed recovery reset LEAVES the journal (self-heal preserved)');
  ok(stateFile().lastError === 'recovery-reset-failed', 'F1: recovery-reset-failed surfaced in the heartbeat');
  fs.rmSync(path.join(STATE, 'apply-in-progress'), { force: true });

  // F2 + F10 — up-to-date fast-path catches an untracked root `_` file, incl. a space-named one (needs -z).
  fs.writeFileSync(path.join(FLEETCLONE, '_my probe.mjs'), 'x');
  runUpdater();
  ok(stateFile().lastError === 'untracked-underscore', 'F2/F10: fast-path scan catches a space-named untracked _ file (via -z)');
  fs.rmSync(path.join(FLEETCLONE, '_my probe.mjs'), { force: true });

  // F6 — the machine GUID rides the heartbeat file the extension relays.
  fs.writeFileSync(path.join(STATE, 'machine-guid'), 'GUID-abc123\n');
  commitPushMain(WORK, '1.0.7', 'v1.0.7'); setFleet('main');
  runUpdater();
  ok(headVer() === '1.0.7' && stateFile().guid === 'GUID-abc123', 'F6: machine GUID stamped into updater-state.json');

  // F4 — a clone AHEAD of fleet (unpushed local commit) is refused, not reset over.
  fs.appendFileSync(path.join(FLEETCLONE, 'background.js'), '// unpushed local\n');
  G(['commit', '-am', 'local unpushed'], FLEETCLONE);
  commitPushMain(WORK, '1.0.8', 'v1.0.8'); setFleet('main');
  runUpdater();
  ok(stateFile().refuseReason === 'ahead', 'F4: a clone ahead of fleet is refused');
  ok(/unpushed local/.test(fs.readFileSync(path.join(FLEETCLONE, 'background.js'), 'utf8')), 'F4: the unpushed commit survived (not orphaned)');
  G(['reset', '--hard', 'origin/fleet'], FLEETCLONE);   // clean up → HEAD at fleet v1.0.8

  // F3a — valid-JSON wrong-key control (`{"held":true}`) fails SAFE to hold.
  setControl('{ "held": true }\n');
  commitPushMain(WORK, '1.0.9', 'v1.0.9'); setFleet('main');
  runUpdater();
  ok(headVer() === '1.0.8' && stateFile().state === 'held' && stateFile().lastError === 'control-unparseable', 'F3a: wrong-key control → held (fail-safe)');

  // F3b — a MISSING control.json blob (ref present) fails SAFE to hold.
  const ctlrm = path.join(ROOT, 'ctlrm');
  G(['worktree', 'add', '-B', 'fleet-control', ctlrm, 'origin/fleet-control'], WORK);
  G(['rm', 'update/control.json'], ctlrm); G(['commit', '-m', 'remove control'], ctlrm); G(['push', 'origin', 'fleet-control'], ctlrm);
  G(['worktree', 'remove', '--force', ctlrm], WORK);
  runUpdater();
  ok(stateFile().state === 'held' && stateFile().lastError === 'control-unreadable', 'F3b: missing control blob → held (control-unreadable)');
  setControl(false);   // restore control for the BOM case

  // F7 — a BOM-prefixed config.json (Windows PS 5.1 default) still parses; the clone converges.
  const STATE2 = path.join(ROOT, 'state2');
  fs.mkdirSync(STATE2, { recursive: true });
  fs.writeFileSync(path.join(STATE2, 'config.json'), '﻿' + JSON.stringify({ clone: FLEETCLONE, remote: 'origin', fleet: 'fleet', control: 'fleet-control' }));
  const env2 = Object.assign({}, process.env, { ORCHARD_UPDATER_STATE: STATE2 });
  for (const k of ['ORCHARD_UPDATER_CLONE', 'ORCHARD_UPDATER_REMOTE', 'ORCHARD_UPDATER_FLEET', 'ORCHARD_UPDATER_CONTROL']) delete env2[k];
  const r16 = spawnSync(process.execPath, [UPDATER], { cwd: FLEETCLONE, env: env2, encoding: 'utf8' });
  ok(r16.status === 0, 'F7: BOM-prefixed config.json parses (updater runs)');
  ok(headVer() === '1.0.9', 'F7: config-driven CLONE converged to v1.0.9 despite the BOM');

  // ===== SU-6 provenance drills =====
  const kp = ATT.generateKeypair();
  const PUB = kp.publicPem;
  function setAttest(sha, sig) {
    const at = path.join(ROOT, 'att');
    G(['worktree', 'add', '-B', 'fleet-control', at, 'origin/fleet-control'], WORK);
    fs.mkdirSync(path.join(at, 'update'), { recursive: true });
    fs.writeFileSync(path.join(at, 'update', 'attest.json'), JSON.stringify({ sha, sig, alg: 'ed25519' }, null, 2) + '\n');
    G(['add', 'update/attest.json'], at);
    if (G(['status', '--porcelain'], at)) { G(['commit', '-m', 'attest'], at); G(['push', 'origin', 'fleet-control'], at); }
    G(['worktree', 'remove', '--force', at], WORK);
  }

  // SU6a — an attested target applies with a pinned pubkey.
  commitPushMain(WORK, '1.1.0', 'v1.1.0'); setFleet('main');
  const tip110 = G(['rev-parse', 'origin/fleet'], WORK);
  setAttest(tip110, ATT.signSha(tip110, kp.privatePem));
  runUpdater({ ORCHARD_UPDATER_PUBKEY: PUB });
  ok(headVer() === '1.1.0', 'SU-6: attested target applies with a pinned pubkey');

  // SU6b — a new fleet tip with only a STALE attestation (for the prior sha) is refused.
  commitPushMain(WORK, '1.1.1', 'v1.1.1'); setFleet('main');
  runUpdater({ ORCHARD_UPDATER_PUBKEY: PUB });
  ok(headVer() === '1.1.0', 'SU-6: un-attested new tip refused (stale attest for the prior sha)');
  ok(stateFile().refuseReason === 'unattested', 'SU-6: state=refused:unattested');

  // SU6c — an attestation with a TAMPERED signature is refused.
  const tip111 = G(['rev-parse', 'origin/fleet'], WORK);
  setAttest(tip111, 'AAAA' + ATT.signSha(tip111, kp.privatePem).slice(4));
  runUpdater({ ORCHARD_UPDATER_PUBKEY: PUB });
  ok(headVer() === '1.1.0' && stateFile().refuseReason === 'unattested', 'SU-6: a tampered signature is refused');

  // SU6d — a corrected valid attestation applies.
  setAttest(tip111, ATT.signSha(tip111, kp.privatePem));
  runUpdater({ ORCHARD_UPDATER_PUBKEY: PUB });
  ok(headVer() === '1.1.1', 'SU-6: a corrected valid attestation applies');

  // SU6e — NO pinned pubkey → provenance check skipped (backward-compatible).
  commitPushMain(WORK, '1.1.2', 'v1.1.2'); setFleet('main');
  runUpdater();
  ok(headVer() === '1.1.2', 'SU-6: no pinned pubkey → provenance skipped (backward-compatible)');

} catch (err) {
  fail++;
  console.error('  ✗ threw: ' + (err && err.message));
  if (err && err.stderr) console.error('    ' + String(err.stderr).split('\n').slice(0, 6).join('\n    '));
} finally {
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}

console.log(`\nupdater.test.cjs: ${pass} passed, ${fail} failed${ran ? '' : ' (SETUP FAILED)'}`);
process.exit(fail ? 1 : 0);
