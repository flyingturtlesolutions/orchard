#!/usr/bin/env node
// tools/glf/precheck.cjs — the FREE gate in front of the paid grader (v2.74.2146).
//
// ── WHY ──────────────────────────────────────────────────────────────────────────────────────────────────────
// `orchard-auto-glf` fires `claude -p` every 5 minutes. Measured over the last 10 firings (2026-08-10): ~30 API
// calls and ~1.65M tokens each, 97% of it cache-read — the grader re-reads HEADLESS_PROMPT -> CRON_PROMPT (19KB)
// -> testbus.cjs (35KB) -> the fleet hour-files on every call. At 285 firings/day that is ~469M tokens/day.
//
// Almost all of it buys nothing. A verdict can only move when the EVIDENCE moves, and on 2026-08-10 the fleet
// logs held 2,022 SyncEngine + 51 VITALS + 43 CloudClient + 34 SGV lines and ZERO CHAT / BRANCH / PIPELINE /
// TARGET / INTERPRET lines. Every firing that day re-derived the same verdict from the same heartbeat.
//
// So: decide for free whether anything a verdict depends on has changed, and only pay when it has.
//
// ── FAIL-OPEN BY CONSTRUCTION ────────────────────────────────────────────────────────────────────────────────
// The costly failure is skipping a tick that had real signal; the cheap failure is running one that did not.
// Every ambiguity therefore resolves toward RUN:
//   · Signal is counted as "lines that are NOT heartbeat" — an unrecognised line shape counts as signal, so a
//     new marker nobody added here still wakes the grader. (An allow-list would do the opposite, and that is
//     exactly the invariant-#1 failure mode: a marker missing from a list is structurally invisible.)
//   · Any error — unreadable dir, bad state file, git unavailable — returns RUN, never SKIP.
//   · A heartbeat run every `--max-skips` firings (default 12 ≈ 1h) bounds how long a wrong gate can stay quiet,
//     and keeps a proof-of-life line in cron.out so a silent gate and a dead task still look different.
//
// EXIT 0 = RUN (pay for the grader) · EXIT 1 = SKIP. One line printed either way; it lands in cron.out.
// Zero tokens, zero network: local filesystem + git only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE = path.join(REPO_ROOT, 'logs', 'run', 'precheck-state.json');
const DEFAULT_MAX_SKIPS = 12;          // ≈ 1 hour at 5-minute spacing
const FLEET_DAYS = 2;                  // the archive is a ~48h ring; older dirs cannot gain lines

// Lines that CANNOT change any verdict: the service worker's own idle chatter, plus each hour-file's `#` header
// block. The headers matter because they are the ONLY non-heartbeat lines an idle hour contains — measured over
// 2026-08-09T14Z..08-10T10Z, every idle hour read exactly `194 total / 3 signal`, and all 3 were headers. Their
// third line carries `· N event(s) · exported <ts>`, which changes on every export; the digest counts lines
// rather than hashing content, so that never moved the gate — but excluding them makes "0 signal" mean what it
// says. Everything else counts, including line shapes nobody listed here.
const HEARTBEAT = /^\s*#|SyncEngine|CloudClient|VITALS \S* (tick|presence|csrf|prewarm)|SGV \S* tick|presence-gate/i;

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Signal lines in one file's text = non-blank lines that are not heartbeat. Unknown shapes count as signal. */
function signalCount(text) {
  let n = 0;
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    if (HEARTBEAT.test(line)) continue;
    n++;
  }
  return n;
}

/** RUN unless every component of the digest is byte-identical to last firing's. */
function decide(prev, now, skips, maxSkips) {
  if (!prev) return { run: true, why: 'first run — no prior state' };
  if (skips >= maxSkips) return { run: true, why: `heartbeat (${skips} skips since last run)` };
  const changed = Object.keys(now).filter((k) => prev[k] !== now[k]);
  if (changed.length) return { run: true, why: `changed: ${changed.join(', ')}` };
  return { run: false, why: 'no new signal — fleet quiet, build unchanged, bus unchanged' };
}

// ── impure ──────────────────────────────────────────────────────────────────────────────────────────────────
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n+$/, '');
  } catch { return ''; }
}

/** Every *.txt under the newest FLEET_DAYS day-dirs. Missing/unreadable → empty, and the caller fails open. */
function fleetFiles(busRoot) {
  const out = [];
  try {
    const root = path.join(busRoot, 'logs');
    const days = fs.readdirSync(root).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(-FLEET_DAYS);
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.txt')) out.push(p);
      }
    };
    for (const d of days) walk(path.join(root, d));
  } catch { /* fail open — an empty list yields a constant digest, and `build`/`bus` still gate */ }
  return out;
}

function main() {
  const argv = process.argv.slice(2);
  const mi = argv.indexOf('--max-skips');
  const maxSkips = mi >= 0 ? Math.max(1, parseInt(argv[mi + 1], 10) || DEFAULT_MAX_SKIPS) : DEFAULT_MAX_SKIPS;
  const busRoot = process.env.ORCHARD_LOGS || path.resolve(REPO_ROOT, '..', 'orchard-logs');

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { /* first run */ }
  const skips = (prev && Number(prev._skips)) || 0;

  const now = {};

  // 1. BUILD — HEAD + working-diff hash + manifest, exactly tick.cjs's identity. Changes when the loaded code
  //    changes, which re-arms tests and can flip any verdict.
  try {
    const { fingerprint } = require('./tick.cjs');   // require is side-effect free: tick.cjs only runs main() as __main__
    let mv = '?';
    try { mv = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'manifest.json'), 'utf8')).version; } catch { /* */ }
    const head = git(['rev-parse', 'HEAD'], REPO_ROOT);
    // A git failure is the one way this component fails CLOSED rather than open: `fingerprint('','',mv)` returns
    // the perfectly stable `?+clean@<version>`, so a machine that lost git would match its own previous state and
    // skip every firing until the heartbeat. tick.cjs already treats this as first-class (`FP DEGRADED ▸ … do not
    // grade against it`); here it must force the paid run, because a build identity we cannot compute is exactly
    // when we least deserve to assume nothing changed.
    now.build = head ? fingerprint(head, git(['diff'], REPO_ROOT), mv) : `nogit-${Date.now()}`;
  } catch { now.build = `err-${Date.now()}`; }        // unique => RUN

  // 2. FLEET — how many non-heartbeat lines exist across the live window. Heartbeat growth (the SW pulling every
  //    minute) deliberately does NOT move this, which is the whole point: byte size would change every tick.
  try {
    const files = fleetFiles(busRoot);
    let total = 0;
    const h = crypto.createHash('sha256');
    for (const f of files.sort()) {
      let c = 0;
      try { c = signalCount(fs.readFileSync(f, 'utf8')); } catch { c = -1; }   // unreadable => digest moves => RUN
      total += Math.max(0, c);
      h.update(`${path.basename(path.dirname(f))}/${path.basename(f)}:${c}\n`);
    }
    now.fleet = `${files.length}f/${total}s/${h.digest('hex').slice(0, 12)}`;
  } catch { now.fleet = `err-${Date.now()}`; }

  // 3. BUS — tests/ + results/ contents, plus anything undelivered. A rearmed test or an unpushed result is work
  //    the grader owes regardless of what the fleet did.
  try {
    const ls = git(['ls-files', '-s', 'tests', 'results'], busRoot);
    const dirty = git(['status', '--porcelain', '--', 'tests', 'results'], busRoot);
    now.bus = crypto.createHash('sha256').update(`${ls}\n--\n${dirty}`).digest('hex').slice(0, 12);
    if (dirty.trim()) now.bus += '+undelivered';
  } catch { now.bus = `err-${Date.now()}`; }

  const { run, why } = decide(prev, now, skips, maxSkips);

  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(STATE, JSON.stringify({ ...now, _skips: run ? 0 : skips + 1, _at: new Date().toISOString(), _lastDecision: run ? 'RUN' : 'SKIP' }, null, 2));
  } catch { /* a state write that fails means the next firing sees no prior state and RUNs — fail open */ }

  console.log(run
    ? `PRECHECK ▸ RUN — ${why}`
    : `PRECHECK ▸ SKIP — ${why} (${skips + 1}/${maxSkips} to heartbeat) · no LLM call, 0 tokens`);
  process.exit(run ? 0 : 1);
}

module.exports = { signalCount, decide, HEARTBEAT };
if (require.main === module) main();
