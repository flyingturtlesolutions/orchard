#!/usr/bin/env node
// tools/glf/tick.cjs — the auto-glf loop's own instrumentation (v2.74.1981).
//
// Two facts the loop could not previously state about itself, both discovered by auditing its artifacts:
//
// 1. DID IT FIRE? The loop had no record of its own firings, so "nothing happened" and "the loop was not running"
//    were indistinguishable — and they correlate, because both follow the human walking away. Measured over
//    2026-08-02T15:00Z → 08-03T12:19Z: 91 ticks fired against 257 expected, a 35.4% duty cycle, with 943 minutes
//    lost across 16 gaps and two gaps of 314 and 450 minutes. Every prior analysis of "wasted QUIET ticks" used
//    the expected count as its denominator and was therefore wrong by ~3x. A gap is now a FIRST-CLASS VERDICT.
//
// 2. WHICH BUILD? CLAUDE.md designates the manifest version as the join key between the trace, the journal and
//    the commit. In a checkout shared with a second session that stopped being true: a graded window carried
//    `v 2.74.1977` while manifest.json already read 1978 under the other lane and the fix under test was in
//    neither number. It has since blocked one grade outright (a reload landed on the sibling's 1979 while the fix
//    sat uncommitted). The build identity is therefore HEAD + a hash of the working diff, which changes exactly
//    when the loaded code changes — Chrome loads the repo root, so uncommitted IS live.
//
// Pure enough to test: `gapMinutes`, `fingerprint` and `contended` take their inputs as arguments. Only `main`
// touches git and the filesystem.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LOG = 'logs/run/loop-ticks.jsonl';
const GAP_MIN = 15;   // > one missed 5-minute tick plus slack; below this, jitter is not news.

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────
function gapMinutes(nowIso, lastIso) {
  if (!lastIso) return null;                       // first row ever — a gap cannot be computed, not a gap of 0
  const a = Date.parse(nowIso), b = Date.parse(lastIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((a - b) / 60000));
}

function fingerprint(headSha, diffText, manifestVersion) {
  const dirty = String(diffText || '');
  const hash = dirty ? crypto.createHash('sha256').update(dirty).digest('hex').slice(0, 8) : 'clean';
  return `${String(headSha || '?').slice(0, 7)}+${hash}@${manifestVersion || '?'}`;
}

// A tick is CONTENDED when the working tree carries changes the open block does not claim — the condition under
// which "stage files BY NAME" silently fails, because two authors can share one file. `claimed` is the block's
// own file list; anything dirty and unclaimed is somebody else's work in flight.
function contended(dirtyFiles, claimedFiles) {
  const claimed = new Set((claimedFiles || []).map((f) => f.replace(/\\/g, '/')));
  return (dirtyFiles || []).map((f) => f.replace(/\\/g, '/')).filter((f) => !claimed.has(f));
}

// ── impure ──────────────────────────────────────────────────────────────────────────────────────────────────
// NOTE the trailing-newline-only trim. A full .trim() strips the LEADING SPACE off porcelain's first line
// (" M Core/x.js" -> "M Core/x.js"), which shifts every subsequent column by one and silently renames the first
// dirty file — caught on this tool's own first live run, which reported `ore/decisionMarkers.js`.
function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\n+$/, ''); }
  catch { return ''; }
}

// porcelain v1: two status columns, a space, then the path. `->` appears for renames; take the destination.
function dirtyPaths(porcelain) {
  return String(porcelain || '').split('\n').filter(Boolean)
    .map((l) => l.slice(3).trim())
    .map((p) => (p.includes(' -> ') ? p.slice(p.indexOf(' -> ') + 4) : p))
    .map((p) => p.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function lastRow(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = raw.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* skip a torn line rather than lose the file */ }
  }
  return null;
}

function main() {
  const repo = process.cwd();
  const nowIso = new Date().toISOString();
  const file = path.join(repo, LOG);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const prev = lastRow(file);
  const gap = gapMinutes(nowIso, prev && prev.ts);

  const headSha = git(['rev-parse', 'HEAD'], repo);
  const diff = git(['diff'], repo);
  const dirty = dirtyPaths(git(['status', '--porcelain', '-uall'], repo));   // -uall: expand untracked DIRS to files
  let manifestVersion = '?';
  try { manifestVersion = JSON.parse(fs.readFileSync(path.join(repo, 'manifest.json'), 'utf8')).version; } catch { /* */ }

  const fp = fingerprint(headSha, diff, manifestVersion);
  const row = { ts: nowIso, build: fp, head: headSha.slice(0, 7), manifest: manifestVersion, dirty, gapMin: gap };
  fs.appendFileSync(file, JSON.stringify(row) + '\n');

  // The tick's own report. Printed for the agent to quote; the row on disk is the durable record.
  if (gap == null) console.log('LOOP FIRST ▸ no prior tick row — the ledger starts here');
  else if (gap > GAP_MIN) console.log(`LOOP GAP ${gap}min ▸ previous tick ${prev.ts} — the loop was not running, which is NOT the same as quiet`);
  else console.log(`LOOP OK ▸ ${gap}min since previous tick`);
  console.log(`BUILD ▸ ${fp}${dirty.length ? ` · dirty: ${dirty.join(' ')}` : ' · tree clean'}`);
  if (dirty.length) console.log('BUILD ▸ uncommitted files are LIVE (Chrome loads the repo root) — grade the FINGERPRINT, not the manifest number');
}

module.exports = { gapMinutes, fingerprint, contended, dirtyPaths, GAP_MIN, LOG };
if (require.main === module) main();
