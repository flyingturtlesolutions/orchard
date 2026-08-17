#!/usr/bin/env node
'use strict';
/*
 * tools/updater/updater.cjs — the fleet UPDATER tick, node CLI (SU rung 3; DESIGN_self_update.md §3.2).
 * ONE recipe (no dual-shell drift): a thin schtasks/launchd launcher invokes `node updater.cjs` every ~10 min.
 * Runs from the installed COPY in the state dir, NEVER from the clone it hard-resets (ruling 15). Requires node
 * + git (both one-time installs; "no node on fleet" relaxed 2026-08-14, §7 ruling 22).
 *
 * Owns code ACQUISITION only, never Chrome. The whole body runs in a try/finally so EVERY exit stamps
 * updater-state.json and releases the lock (§12 finding 7 — no silent failure). Reuses promoteChecks.cjs.
 *
 * Hardened 2026-08-14 after an adversarial review (all confirmed findings folded):
 *   F1  a failed `git reset --hard` (Defender/indexer lock) now LEAVES the journal + refuses to stamp, so a
 *       later tick's recovery finishes it — was: cleared the journal unconditionally, defeating the self-heal.
 *   F2  the up-to-date fast-path now runs the untracked-`_` scan before stamping (was apply-path only).
 *   F3  control fails SAFE to hold on ANY non-{hold:...} read (missing blob, wrong key), not only unparseable.
 *   F4  refuse to reset over a clone that is AHEAD of fleet (unpushed local commits) instead of orphaning them.
 *   F6  the machine GUID is stamped INTO updater-state.json (the file the SW relays), not a dead sidecar file.
 *   F7  config.json is read BOM-tolerant, and a CLONE that isn't the extension fails LOUD (was: silent).
 *   F10 the untracked-`_` scan uses `-z` (NUL, unquoted) so paths with spaces/non-ASCII aren't missed.
 *
 * Config (env wins; else STATE_DIR/config.json which the launcher writes; else source-tree default):
 *   ORCHARD_UPDATER_CLONE / _STATE / _REMOTE / _FLEET / _CONTROL / _CADENCE_MIN / _GIT
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./promoteChecks.cjs');
const A = require('./attest.cjs');   // SU-6 provenance verify (opt-in)

function defaultStateDir() {
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'orchard-updater');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'orchard-updater');
  return path.join(os.homedir(), '.local', 'state', 'orchard-updater');
}
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return null; } }   // BOM-tolerant (F7)
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj) + '\n'); }

const STATE_DIR = process.env.ORCHARD_UPDATER_STATE || defaultStateDir();
const CFG = readJson(path.join(STATE_DIR, 'config.json')) || {};
const CLONE = process.env.ORCHARD_UPDATER_CLONE || CFG.clone || path.resolve(__dirname, '..', '..');
const REMOTE = process.env.ORCHARD_UPDATER_REMOTE || CFG.remote || 'origin';
const FLEET = process.env.ORCHARD_UPDATER_FLEET || CFG.fleet || 'fleet';
const CONTROL = process.env.ORCHARD_UPDATER_CONTROL || CFG.control || 'fleet-control';
const CADENCE_MIN = parseInt(process.env.ORCHARD_UPDATER_CADENCE_MIN || CFG.cadenceMin || '10', 10) || 10;
const GIT = process.env.ORCHARD_UPDATER_GIT || CFG.git || 'git';   // absolute path under launchd's minimal PATH (F5/§7)
const PUBKEY = process.env.ORCHARD_UPDATER_PUBKEY || CFG.pubkey || '';   // SU-6: pinned promote public key (opt-in); empty → provenance check skipped
const GUID = (() => { try { return fs.readFileSync(path.join(STATE_DIR, 'machine-guid'), 'utf8').trim(); } catch { return ''; } })();

const LOCK = path.join(STATE_DIR, 'lock');
const JOURNAL = path.join(STATE_DIR, 'apply-in-progress');
const READY = path.join(CLONE, 'update', 'ready.json');
const STATE_FILE = path.join(CLONE, 'update', 'updater-state.json');

function now() { return Math.floor(Date.now() / 1000); }
function git(args) { return execFileSync(GIT, ['-C', CLONE].concat(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function gitTry(args) { try { return { ok: true, out: git(args).trim() }; } catch (e) { return { ok: false, out: ((e.stdout || '') + (e.stderr || '')).toString().trim() }; } }
function lines(s) { return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean); }
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }

/** any untracked ENTRY at the clone ROOT whose name starts with `_` — Chrome refuses to load such a tree. Uses
 *  `-z` (NUL-delimited, UNQUOTED) so a name with a space / non-ASCII byte isn't hidden behind git's quoting (F10). */
function hasUntrackedUnderscore() {
  const out = gitTry(['status', '--porcelain', '-z', '--untracked-files=all']).out;
  return out.split('\0').filter(Boolean).some((r) => r.startsWith('?? ') && r.slice(3).startsWith('_'));
}

function deriveState(s) {
  if (s.hold) return 'held';
  if (s.refuseReason) return 'refused:' + s.refuseReason;
  if (s.lastError) return 'error';
  return 'ok';
}
function stampState(s) {
  writeJson(STATE_FILE, {
    at: s.at, head: s.head, fetchOk: s.fetchOk, lastError: s.lastError, refuseReason: s.refuseReason,
    hold: s.hold, applied: s.applied, state: deriveState(s), guid: GUID || os.hostname(),   // F6: dedup key rides the heartbeat
  });
}
function stampReady(sha, version) {
  if (!version) { const pm = C.parseManifest(gitTry(['show', `${sha}:manifest.json`]).out); version = pm.ok ? pm.manifest.version : ''; }
  const cur = readJson(READY);
  const short = sha.slice(0, 7);
  if (cur && cur.version === version && cur.sha === short) return;
  writeJson(READY, { version, sha: short, at: now() });
}

function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  // F7 fail-LOUD: if CLONE isn't even a git work tree (a corrupt/BOM config resolved it to the wrong dir, e.g.
  // %LOCALAPPDATA%), a silent stamp to the wrong place reads as "never enrolled". Surface it and stop. (A valid
  // but not-yet-populated clone IS a work tree, so this permits the first reset to populate it.)
  if (!gitTry(['rev-parse', '--is-inside-work-tree']).ok) {
    try { writeJson(path.join(STATE_DIR, 'bootstrap-error.json'), { at: now(), fatal: 'bad-clone', clone: CLONE, hint: 'ORCHARD_UPDATER_CLONE / config.json.clone is not a git work tree (corrupt config.json?)' }); } catch { /* */ }
    process.stderr.write(`updater: CLONE is not a git work tree — ${CLONE}\n`);
    process.exit(1);
  }
  fs.mkdirSync(path.join(CLONE, 'update'), { recursive: true });

  // 1. LOCK — steal a dead/stale lock; yield to a live+fresh one (do NOT stamp on yield).
  const held = readJson(LOCK);
  if (held && held.pid && pidAlive(held.pid) && held.at && (now() - held.at) < CADENCE_MIN * 60 * 3) process.exit(0);
  writeJson(LOCK, { pid: process.pid, at: now(), host: os.hostname() });

  const s = { at: now(), head: '', fetchOk: false, lastError: '', refuseReason: '', hold: false, applied: false };
  try {
    // 2. RECOVER a torn apply. F1: if the reset can't complete (a file is STILL locked), LEAVE the journal so a
    // later tick retries — clearing it here is what wedged the very case this exists for.
    if (fs.existsSync(JOURNAL)) {
      const sha = fs.readFileSync(JOURNAL, 'utf8').trim();
      if (sha) { const r = gitTry(['reset', '--hard', sha]); if (!r.ok) { s.lastError = 'recovery-reset-failed'; return; } }
      fs.rmSync(JOURNAL, { force: true });
    }

    // 3. FETCH
    s.fetchOk = gitTry(['fetch', REMOTE, FLEET, CONTROL]).ok;
    if (!s.fetchOk) { s.lastError = 'fetch-failed'; return; }

    // 4. CONTROL — F3: fail SAFE to hold whenever it can't be read as a positive {hold:...}, not only when the
    // JSON is malformed (a missing blob or a `{"held":true}` typo must freeze, not apply).
    const ctl = gitTry(['show', `${REMOTE}/${CONTROL}:update/control.json`]);
    if (!ctl.ok) { s.hold = true; s.lastError = 'control-unreadable'; }
    else {
      let parsed = null; try { parsed = JSON.parse(ctl.out.replace(/^﻿/, '')); } catch { /* */ }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'hold' in parsed) s.hold = !!parsed.hold;
      else { s.hold = true; s.lastError = 'control-unparseable'; }
    }

    const targetRef = gitTry(['rev-parse', `${REMOTE}/${FLEET}`]);
    if (!targetRef.ok) { s.lastError = 'no-fleet-ref'; return; }
    const target = targetRef.out;
    s.head = target.slice(0, 7);
    if (s.hold) return;   // kill switch: fetched + will stamp (held), no apply

    // 5. up to date? catch a hand-pull — but still guard the tree the signal will point at (F2).
    const current = gitTry(['rev-parse', 'HEAD']).out;
    if (current === target) {
      if (hasUntrackedUnderscore()) { s.lastError = 'untracked-underscore'; return; }
      stampReady(target); return;
    }

    // F4: a genuine fleet machine is a fast-forward descendant of fleet, never AHEAD. If it holds commits fleet
    // does not, it is a working clone with unpushed work — refuse rather than orphan it with `reset --hard`.
    if (gitTry(['rev-list', '--count', `${target}..HEAD`]).out !== '0') { s.refuseReason = 'ahead'; return; }

    // 6. VALIDATE the target tree WITHOUT touching the live dir (the brick invariant)
    const rootEntries = lines(gitTry(['ls-tree', '--name-only', target]).out);
    if (rootEntries.some((e) => e.startsWith('_'))) { s.refuseReason = 'invalid'; s.lastError = 'underscore-root'; return; }
    const pm = C.parseManifest(gitTry(['show', `${target}:manifest.json`]).out);
    if (!pm.ok) { s.refuseReason = 'invalid'; s.lastError = 'manifest'; return; }
    const tree = new Set(lines(gitTry(['ls-tree', '-r', '--name-only', target]).out));
    const refs = C.collectRefs(pm.manifest);
    const walk = C.walkRefs({ brick: refs.brick, broken: [] }, tree);   // host mirror = brick tier (§3.2.6)
    if (!walk.ok) { s.refuseReason = 'invalid'; s.lastError = 'missing-ref:' + walk.missing.brick.join(','); return; }

    // 6a. PROVENANCE (SU-6, opt-in) — if a promote public key is pinned, the target must carry a valid signature
    // proving it came through promote.cjs, not a raw push that skipped the gate. attest.json rides fleet-control.
    // No pinned key → skip (backward-compatible). An attacker with fleet write can't forge a signature (no privkey).
    if (PUBKEY) {
      const att = gitTry(['show', `${REMOTE}/${CONTROL}:update/attest.json`]);
      let attest = null; try { attest = JSON.parse(att.out); } catch { /* */ }
      if (!att.ok || !attest || attest.sha !== target || !A.verifySha(target, attest.sig, PUBKEY)) { s.refuseReason = 'unattested'; return; }
    }

    // 7. APPLY guards — protect HUMAN dirt (the updater's own torn apply already healed at step 2).
    if (gitTry(['status', '--porcelain', '--untracked-files=no']).out) { s.refuseReason = 'dirty'; return; }
    if (fs.existsSync(path.join(CLONE, '.orchard-dev'))) { s.refuseReason = 'dev-marker'; return; }

    // apply: journal → reset → clear journal. F1: clear the journal ONLY if the reset actually completed.
    fs.writeFileSync(JOURNAL, target + '\n');
    const rr = gitTry(['reset', '--hard', target]);
    if (!rr.ok) { s.lastError = 'apply-failed'; return; }   // journal STAYS → next tick's step 2 finishes it
    fs.rmSync(JOURNAL, { force: true });

    // an untracked root `_` file is invisible to ls-tree yet bricks the load — never signal onto it
    if (hasUntrackedUnderscore()) { s.lastError = 'untracked-underscore'; return; }

    // 8. STAMP ready.json LAST (the signal)
    stampReady(target, pm.manifest.version);
    s.applied = true;
  } finally {
    stampState(s);
    fs.rmSync(LOCK, { force: true });
  }
}

if (require.main === module) main();
module.exports = { main, deriveState, pidAlive };
