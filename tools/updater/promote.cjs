#!/usr/bin/env node
'use strict';
/*
 * tools/updater/promote.cjs — the fleet-update PROMOTION GATE (BUILD_ARC_self_update rung 2;
 * DESIGN_self_update.md §3.1, §3.1a, §3.2a). Run on the DEV machine (where node + the toolchain live).
 *
 * It NEVER trusts the working tree it sits in — this repo's steady state is a dirty, LIVE-on-reload checkout,
 * so "run npm test here" would gate a tree the fleet never sees. Instead it builds and tests the exact
 * artifact it ships: candidate = origin/main, materialized in a throwaway detached worktree OUTSIDE the repo,
 * gated THERE, and pushed to `fleet` as exactly that sha.
 *
 * Subcommands:
 *   promote            fetch origin/main → temp worktree → manifest-ref walk + version-movement + node --check
 *                      + npm test → push fleet to the verified sha.  (default)
 *   hold | release     flip update/control.json on the dedicated `fleet-control` ref, NO test gate, instant —
 *                      the kill switch that lives OFF the payload branch (§3.2a).
 *
 * Test/CI knobs (env): ORCHARD_PROMOTE_TEST_CMD (default "npm test") · ORCHARD_PROMOTE_DRY_RUN (skip push) ·
 *   ORCHARD_PROMOTE_SKIP_NODECHECK · ORCHARD_PROMOTE_{REMOTE,MAIN,FLEET,CONTROL}. The fixture suite in
 *   promote.test.cjs drives every refusal through these against a bare throwaway repo.
 *
 * Local dev toolchain only — never part of the shipped extension bundle (it runs git + node + npm).
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./promoteChecks.cjs');

const REMOTE = process.env.ORCHARD_PROMOTE_REMOTE || 'origin';
const MAIN = process.env.ORCHARD_PROMOTE_MAIN || 'main';
const FLEET = process.env.ORCHARD_PROMOTE_FLEET || 'fleet';
const CONTROL = process.env.ORCHARD_PROMOTE_CONTROL || 'fleet-control';
const CONTROL_PATH = 'update/control.json';
const TEST_CMD = process.env.ORCHARD_PROMOTE_TEST_CMD || 'npm test';
const DRY_RUN = !!process.env.ORCHARD_PROMOTE_DRY_RUN;
const SKIP_NODECHECK = !!process.env.ORCHARD_PROMOTE_SKIP_NODECHECK;

const CWD = process.cwd();

// ---- git helpers -----------------------------------------------------------------------------------------

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: CWD, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}
/** git that is ALLOWED to fail — returns { ok, out } instead of throwing (for "does this ref exist?"). */
function gitTry(args, opts = {}) {
  try { return { ok: true, out: git(args, opts) }; }
  catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString().trim() }; }
}

function log(msg) { process.stdout.write(msg + '\n'); }
function fail(msg) { process.stderr.write('promote: REFUSED — ' + msg + '\n'); process.exit(1); }

// ---- the promote gate ------------------------------------------------------------------------------------

function promote() {
  // 1. candidate = origin/main tip (never the local checkout — it may be dirty or ahead of origin).
  const f = gitTry(['fetch', REMOTE, MAIN, FLEET]);   // FLEET may not exist yet; fetch of a missing ref is tolerated below
  if (!f.ok && !/couldn't find remote ref|fatal: couldn't find/i.test(f.out)) {
    // a hard fetch failure (offline, bad remote) — but a missing FLEET ref alone is fine, so retry MAIN only
    const fm = gitTry(['fetch', REMOTE, MAIN]);
    if (!fm.ok) fail(`git fetch ${REMOTE} ${MAIN} failed:\n${fm.out}`);
  }
  const candidate = git(['rev-parse', `${REMOTE}/${MAIN}`]);
  const fleetRef = gitTry(['rev-parse', `${REMOTE}/${FLEET}`]);
  const fleetTip = fleetRef.ok ? fleetRef.out : null;
  log(`candidate ${candidate.slice(0, 7)} (${REMOTE}/${MAIN})` + (fleetTip ? ` · fleet ${fleetTip.slice(0, 7)}` : ' · fleet: none yet'));

  // 2. materialize the candidate in a throwaway worktree OUTSIDE the repo root (a worktree at root would
  //    itself trip the `_`-prefix load refusal; scratch-outside-root already governs).
  const wt = path.join(os.tmpdir(), `orchard-promote-${candidate.slice(0, 7)}-${process.pid}-${Date.now()}`);
  let pushed = false;
  try {
    git(['worktree', 'add', '--detach', wt, candidate]);

    // --- cheap checks first, fail fast ---
    const manifestPath = path.join(wt, 'manifest.json');
    if (!fs.existsSync(manifestPath)) fail('candidate has no manifest.json at root');
    const pm = C.parseManifest(fs.readFileSync(manifestPath, 'utf8'));
    if (!pm.ok) fail(pm.error);
    const candidateVersion = pm.manifest.version;

    // manifest-reference walk (§3.1a) against the candidate tree's file listing
    const treeFiles = new Set(git(['ls-tree', '-r', '--name-only', candidate]).split('\n').filter(Boolean));
    const refs = C.collectRefs(pm.manifest);
    const walk = C.walkRefs(refs, treeFiles);
    if (!walk.ok) {
      const b = walk.missing.brick.length ? `\n  brick (won't load): ${walk.missing.brick.join(', ')}` : '';
      const k = walk.missing.broken.length ? `\n  broken (loads, fails at use): ${walk.missing.broken.join(', ')}` : '';
      fail(`manifest references files absent from the tree:${b}${k}`);
    }

    // version-movement (§3.1 step 4)
    let fleetVersion = null;
    if (fleetTip) {
      const fm = C.parseManifest(git(['show', `${fleetTip}:manifest.json`]));
      fleetVersion = fm.ok ? fm.manifest.version : null;
    }
    const filesDiffer = fleetTip ? !gitTry(['diff', '--quiet', fleetTip, candidate]).ok : true;
    const vm = C.versionMoved({ candidateVersion, fleetVersion, filesDiffer });
    if (!vm.ok && vm.code === 'nothing-to-promote') { log(`nothing to promote — ${vm.reason}`); return; }
    if (!vm.ok) fail(`${vm.code}: ${vm.reason}`);
    log(`version ✓ ${vm.reason}`);

    // node --check every shipped .js (ESM-aware) — syntax gate before the heavier npm test
    if (!SKIP_NODECHECK) {
      const bad = syntaxCheckTree(wt, candidate);
      if (bad.length) fail(`node --check failed on ${bad.length} file(s):\n  ${bad.slice(0, 20).join('\n  ')}`);
      log('node --check ✓');
    }

    // npm test IN THE WORKTREE — the only tree that gets executed, byte-identical to what the fleet resets onto
    log(`running gate: ${TEST_CMD} (in ${wt})`);
    try {
      execSync(TEST_CMD, { cwd: wt, stdio: 'inherit' });
    } catch (e) {
      fail(`gate command failed (${TEST_CMD}) — the artifact does not pass its own tests`);
    }
    log('gate ✓');

    // 5. push fleet to EXACTLY the verified sha
    if (DRY_RUN) { log(`DRY-RUN: would push ${candidate.slice(0, 7)} → ${REMOTE}/${FLEET}`); pushed = true; return; }
    git(['push', REMOTE, `${candidate}:refs/heads/${FLEET}`]);
    pushed = true;
    log(`PROMOTED v${candidateVersion} — ${candidate.slice(0, 7)} → ${REMOTE}/${FLEET}`);
  } finally {
    gitTry(['worktree', 'remove', '--force', wt]);   // 6. always remove the worktree
    if (!pushed && !DRY_RUN) log('fleet unchanged.');
  }
}

/** Run node --check across every checkable .js in the candidate tree; returns the list that FAILED. */
function syntaxCheckTree(wt, sha) {
  const files = git(['ls-tree', '-r', '--name-only', sha]).split('\n').filter((p) => C.isCheckableJs(p));
  const bad = [];
  for (const rel of files) {
    const abs = path.join(wt, rel);
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    try {
      if (C.looksLikeEsm(src)) {
        execFileSync(process.execPath, ['--input-type=module', '--check'], { input: src, stdio: ['pipe', 'ignore', 'ignore'] });
      } else {
        execFileSync(process.execPath, ['--check', abs], { stdio: ['ignore', 'ignore', 'ignore'] });
      }
    } catch { bad.push(rel); }
  }
  return bad;
}

// ---- the kill switch (off the payload branch, §3.2a) -----------------------------------------------------

function setHold(value) {
  const cf = gitTry(['fetch', REMOTE, CONTROL]);
  if (!cf.ok) fail(`the ${CONTROL} branch does not exist yet — create it (rung 1 / SU-0) before using hold/release.\n${cf.out}`);
  const controlTip = git(['rev-parse', `${REMOTE}/${CONTROL}`]);
  const wt = path.join(os.tmpdir(), `orchard-control-${process.pid}-${Date.now()}`);
  try {
    git(['worktree', 'add', '-B', CONTROL, wt, controlTip]);
    const cpAbs = path.join(wt, CONTROL_PATH);
    fs.mkdirSync(path.dirname(cpAbs), { recursive: true });
    fs.writeFileSync(cpAbs, JSON.stringify({ hold: value }, null, 2) + '\n');
    git(['add', CONTROL_PATH], { cwd: wt });
    // nothing staged (already at this value) → no-op commit is fine to skip
    if (!gitTry(['diff', '--cached', '--quiet'], { cwd: wt }).ok) {
      git(['commit', '-m', `control: hold=${value}`], { cwd: wt });
      if (DRY_RUN) { log(`DRY-RUN: would push ${CONTROL} with hold=${value}`); }
      else { git(['push', REMOTE, CONTROL], { cwd: wt }); log(`${value ? 'HELD' : 'RELEASED'} — ${CONTROL}.control.hold=${value}`); }
    } else {
      log(`control already hold=${value} — nothing to push.`);
    }
  } finally {
    gitTry(['worktree', 'remove', '--force', wt]);
  }
}

// ---- entry -----------------------------------------------------------------------------------------------

function main(argv) {
  const cmd = argv[2] || 'promote';
  switch (cmd) {
    case 'promote': return promote();
    case 'hold': return setHold(true);
    case 'release': return setHold(false);
    default:
      process.stderr.write(`usage: promote.cjs [promote|hold|release]\n`);
      process.exit(2);
  }
}

if (require.main === module) main(process.argv);
module.exports = { promote, setHold, main };
