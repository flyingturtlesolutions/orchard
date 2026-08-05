#!/usr/bin/env node
// tools/glf/testbus.cjs â€” the two-agent test bus (v2.74.2014; builder inbox v2.74.2017).
//
// WHAT THIS IS. The auto-glf loop's VALIDATE blocks lived in findings.md, which meant only THIS checkout's
// journal could carry a prediction and only this session's loop would ever grade it. The bus moves the open
// assertions to `../orchard-logs/tests/` (one file per test) and their grades to `../orchard-logs/results/`
// (append-only, one file per grading attempt) â€” a git-synced channel any builder session can write into and
// any grader session can answer through. findings.md keeps the narrative (symptom â†’ cause â†’ change, INCIDENT
// tags); the bus keeps the live QUESTIONS and their ANSWERS.
//
// ROLES ARE CLAIMED, NOT ASSIGNED.
//   BUILDER â€” causal. Whoever changes code writes the test for it, stamped with a lane tag the session minted
//   (`testbus.cjs lane`). Only the owner rewrites a test (rearm / retire). Builders never write results/.
//   When the grader lease is REFUSED, the same 5-minute tick becomes builder mode: pull â†’ inbox â†’ act oldest
//   unacked â†’ ack â†’ push tests/ if changed. No second cron.
//   GRADER â€” leased. Exactly one session grades; the lease (`logs/run/grader.lease`, git-ignored, local â€” all
//   sessions share this checkout today) is claimed per tick and expires after LEASE_TTL_MIN, so a dead grader
//   is replaceable and a duplicate grader is refused. Graders never write tests/. The same session may hold
//   both roles â€” integrity comes from the arms being pre-registered before the evidence exists, not from the
//   grader being a different agent â€” but a result whose grader lane equals the test's owner lane is stamped
//   `self-graded: true` and auto-acked as `seen` so the next tick does not re-act.
//
// LESSONS BUILT IN (each cost a real incident to learn):
//   - results are APPEND-ONLY, one file per attempt â€” the same block once graded â˜…PASS and FAIL five minutes
//     apart, both faithful; overwriting would have erased that disagreement instead of surfacing it.
//   - both write paths SCRUB (tools/glf/scrub.cjs) â€” orchard-logs syncs off-machine, and the journal has
//     already quoted customer names verbatim once.
//   - a test records its BUILD fingerprint at write; `rearm` recomputes it when the fix lands (fingerprints
//     move with every commit â€” two landed-but-unverified blocks froze exactly this way).
//   - an ORPHAN (stale build + untouched > ORPHAN_H hours) is flagged by grade-pending and answered with an
//     ORPHANED result, never silently adopted â€” adoption is a visible owner-field rewrite in git history.
//   - acks are LOCAL (`logs/run/builder-ack.jsonl`), never rewrite results/ or touch test mtimes (orphan
//     detection uses mtime).
//
// Pure functions take their inputs as arguments; only the CLI touches git and the filesystem.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const LEASE_FILE = 'logs/run/grader.lease';
const ACK_FILE = 'logs/run/builder-ack.jsonl';
const LEASE_TTL_MIN = 15;          // 3 missed 5-minute ticks; below this a live grader would have renewed
const ORPHAN_H = 24;               // stale build + this much silence â†’ the owner is presumed gone
const RESULT_VERDICTS = /^(PASS|FAIL|INCONCLUSIVE|UNMAPPED|ORPHANED)$/;
const RETIRE_VERDICTS = /^(PASS|FAIL|SUPERSEDED|WONTFIX)$/;   // same vocabulary as blocks.cjs
const ACK_DISPOSITIONS = /^(waiting-human|arm-repaired|rearmed|fixed|retired|adopted|seen)$/;
// Suggested next act for an unacked verdict â€” printed by inbox so the tick does not invent one.
const NEXT_BY_VERDICT = {
  PASS: 'retired', FAIL: 'fixed', UNMAPPED: 'arm-repaired',
  INCONCLUSIVE: 'waiting-human', ORPHANED: 'adopted',
};

// â”€â”€ pure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/** Minimal front-matter doc: `---` fence, `key: value` lines, `---` fence, body. PURE.
 * CRLF-tolerant: git autocrlf rewrites the working copy at checkout/rebase, so a file this tool wrote with LF
 * comes back with `---\r` fences â€” caught live on the channel's FIRST result, whose test read as ownerless. */
function parseDoc(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0] !== '---') return { meta: {}, body: String(text || '') };
  const meta = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i] === '---') { i++; break; }
    const m = /^([a-z][a-z0-9-]*):\s*(.*)$/.exec(lines[i]);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: lines.slice(i).join('\n').replace(/^\n+/, '') };
}

function formatDoc(meta, body) {
  const fm = Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${fm}\n---\n\n${String(body || '').replace(/^\n+/, '')}`.replace(/\n*$/, '\n');
}

/** v2.74.2022 â€” the FILE-SCOPED fingerprint: hash over the test's declared `files` (path + content, order-
 * independent). The whole-tree fingerprint stales every open test whenever EITHER lane touches ANY file â€” live
 * 2026-08-05: v2.74.2015-map-prior-binds-source sat ungraded through five tree moves (2016â†’2020) with both its
 * files byte-identical, while the other lane's tests stayed gradeable only because its grader tick rearms as it
 * goes. Scoping staleness to the claimed files makes STALE mean "a file this claim depends on actually changed";
 * a missing file hashes as its own marker so a deletion (or a typo'd path) reads as a change, never as clean.
 * PURE â€” entries: [{ path, text|null }]. */
function filesFingerprint(entries) {
  const h = crypto.createHash('sha256');
  for (const e of [...(entries || [])].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    h.update(String(e.path)); h.update('\u0000');
    h.update(e.text == null ? '<MISSING>' : String(e.text)); h.update('\u0000');
  }
  return h.digest('hex').slice(0, 8);
}

/** free | live | expired â€” a lease with a torn/absent timestamp is free, not an error. PURE. */
function leaseState(nowIso, lease, ttlMin = LEASE_TTL_MIN) {
  if (!lease || !lease.lane || !lease.ts) return 'free';
  const age = Date.parse(nowIso) - Date.parse(lease.ts);
  if (!Number.isFinite(age)) return 'free';
  return age > ttlMin * 60000 ? 'expired' : 'live';
}

/** A test whose recorded build can no longer occur AND whose owner has gone quiet. PURE.
 * v2.74.2022 â€” `filesLive` (the claimed files still match the recorded files-fp) counts as gradeable exactly
 * like a tree match: a test whose subject is untouched is waiting, not abandoned. */
function isOrphan(meta, mtimeMs, nowMs, currentFp, orphanH = ORPHAN_H, filesLive = false) {
  if ((meta.status || 'open') !== 'open') return false;
  if (meta.build === currentFp || filesLive) return false;   // still gradeable â€” not abandoned, just waiting
  return (nowMs - mtimeMs) > orphanH * 3600000;
}

/** results/<id>--<stamp>--<verdict>.md â€” the name alone tells the builder what happened. PURE. */
function resultFileName(id, whenIso, verdict) {
  const stamp = String(whenIso).replace(/[-:]/g, '').slice(0, 13) + 'Z';
  return `${id}--${stamp}--${verdict}.md`;
}

/** Basenames this lane has already acknowledged. Torn lines are skipped, not fatal. PURE. */
function ackedSet(ledgerText, lane) {
  const out = new Set();
  for (const line of String(ledgerText || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.lane === lane && row.result) out.add(row.result);
    } catch { /* skip a torn line rather than lose the ledger */ }
  }
  return out;
}

/**
 * Unacked results for tests owned by `lane`, oldest first.
 * `tests` â€” [{ meta: { id, owner, status } }]
 * `results` â€” [{ file, meta: { test, verdict, graded, grader, note } }]  (file = basename)
 * PURE â€” never mutates inputs; never touches mtimes.
 */
function inboxRows(tests, results, acked, lane) {
  const owned = new Map();
  for (const t of tests || []) {
    if ((t.meta && t.meta.owner) === lane) owned.set(t.meta.id, t.meta);
  }
  const rows = [];
  for (const r of results || []) {
    const basename = r.file || '';
    if (!basename || (acked && acked.has(basename))) continue;
    const meta = r.meta || {};
    const testMeta = owned.get(meta.test);
    if (!testMeta) continue;                                    // not mine (or unknown id)
    if ((testMeta.status || 'open') === 'retired') continue;    // question closed â€” late grade is noise
    rows.push({
      file: basename,
      test: meta.test,
      verdict: meta.verdict || '?',
      graded: meta.graded || '',
      grader: meta.grader || '?',
      note: meta.note || '',
      next: NEXT_BY_VERDICT[meta.verdict] || 'seen',
    });
  }
  rows.sort((a, b) => String(a.graded).localeCompare(String(b.graded)));
  return rows;
}

/** One JSONL ack row. PURE â€” the CLI appends. */
function ackRow({ ts, lane, result, test, verdict, disposition }) {
  return {
    ts: ts || new Date().toISOString(),
    lane, result, test,
    verdict: verdict || '?',
    disposition: disposition || 'seen',
  };
}

module.exports = {
  parseDoc, formatDoc, leaseState, isOrphan, resultFileName,
  ackedSet, inboxRows, ackRow, NEXT_BY_VERDICT, filesFingerprint,
  LEASE_TTL_MIN, ORPHAN_H, ACK_FILE, ACK_DISPOSITIONS,
};

// â”€â”€ impure â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function busRoot() {
  const root = process.env.ORCHARD_LOGS || path.resolve(process.cwd(), '..', 'orchard-logs');
  if (!fs.existsSync(root)) { console.error(`testbus â–¸ bus repo not found at ${root} (set ORCHARD_LOGS)`); process.exit(2); }
  return root;
}
const testsDir = () => path.join(busRoot(), 'tests');
const resultsDir = () => path.join(busRoot(), 'results');

function currentFingerprint() {
  const { fingerprint } = require('./tick.cjs');
  const git = (a) => { try { return execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\n+$/, ''); } catch { return ''; } };
  let mv = '?'; try { mv = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version; } catch { /* */ }
  return fingerprint(git(['rev-parse', 'HEAD']), git(['diff']), mv);
}

// v2.74.2022 â€” the working-tree contents of a test's declared files (extension-repo cwd, the tree Chrome loads).
function currentFilesFp(filesStr) {
  const paths = String(filesStr || '').split(/\s+/).filter(Boolean);
  if (!paths.length) return null;
  return filesFingerprint(paths.map((p) => {
    let text = null; try { text = fs.readFileSync(p, 'utf8'); } catch { /* missing hashes as its own marker */ }
    return { path: p, text };
  }));
}

// Every byte that reaches the bus goes through the scrubber â€” orchard-logs leaves this machine.
function scrubbedWrite(file, text) {
  const { scrub, residual } = require('./scrub.cjs');
  const { text: clean, counts } = scrub(text);
  const kinds = Object.keys(counts);
  if (kinds.length) console.log(`testbus â–¸ scrubbed on write: ${kinds.map((k) => `${k} x${counts[k]}`).join(' Â· ')}`);
  const left = residual(clean);
  if (Object.keys(left).length) { console.error(`testbus â–¸ REFUSING write â€” residual PII after scrub: ${Object.keys(left).join(' ')}`); process.exit(3); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, clean);
}

function readTest(id) {
  const file = path.join(testsDir(), `${id}.md`);
  if (!fs.existsSync(file)) { console.error(`testbus â–¸ no test '${id}' in ${testsDir()}`); process.exit(3); }
  const { meta, body } = parseDoc(fs.readFileSync(file, 'utf8'));
  return { file, meta, body };
}

function listTests() {
  const dir = testsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').map((f) => {
    const file = path.join(dir, f);
    const { meta, body } = parseDoc(fs.readFileSync(file, 'utf8'));
    return { file, meta, body, mtimeMs: fs.statSync(file).mtimeMs };
  }).sort((a, b) => String(a.meta.created || '').localeCompare(String(b.meta.created || '')));
}

function listResults() {
  const dir = resultsDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => {
    const { meta } = parseDoc(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { file: f, meta };
  });
}

function readAckLedger() {
  try { return fs.readFileSync(ACK_FILE, 'utf8'); } catch { return ''; }
}

function appendAck(row) {
  fs.mkdirSync(path.dirname(ACK_FILE), { recursive: true });
  fs.appendFileSync(ACK_FILE, JSON.stringify(row) + '\n');
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

// â”€â”€ cli â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const nowIso = new Date().toISOString();

  if (cmd === 'lane') {
    console.log(`lane-${crypto.randomBytes(2).toString('hex')}`);
    process.exit(0);
  }

  if (cmd === 'lease') {
    const [sub, lane] = rest;
    let lease = null;
    try { lease = JSON.parse(fs.readFileSync(LEASE_FILE, 'utf8')); } catch { /* free */ }
    const state = leaseState(nowIso, lease);
    if (sub === 'status') {
      console.log(state === 'free' ? 'LEASE â–¸ free' : `LEASE â–¸ ${state} â€” held by ${lease.lane} since ${lease.ts}`);
      process.exit(0);
    }
    if (sub === 'claim') {
      if (!lane) { console.error('usage: testbus.cjs lease claim <lane>'); process.exit(2); }
      if (state === 'live' && lease.lane !== lane) {
        console.log(`LEASE â–¸ REFUSED â€” held by ${lease.lane} since ${lease.ts} (ttl ${LEASE_TTL_MIN}min). This session is builder-only.`);
        process.exit(1);
      }
      fs.mkdirSync(path.dirname(LEASE_FILE), { recursive: true });
      fs.writeFileSync(LEASE_FILE, JSON.stringify({ lane, ts: nowIso }));
      console.log(`LEASE â–¸ claimed by ${lane}${state === 'expired' ? ` (previous holder ${lease.lane} expired)` : ''}`);
      process.exit(0);
    }
    if (sub === 'release') {
      if (!lane) { console.error('usage: testbus.cjs lease release <lane>'); process.exit(2); }
      if (state !== 'free' && lease.lane !== lane) { console.error(`LEASE â–¸ not yours to release (held by ${lease.lane})`); process.exit(1); }
      try { fs.unlinkSync(LEASE_FILE); } catch { /* already gone */ }
      console.log('LEASE â–¸ released');
      process.exit(0);
    }
    console.error('usage: testbus.cjs lease status|claim <lane>|release <lane>'); process.exit(2);
  }

  // BUILDER â€” write a new test. The body (ACTION checklist + PREDICT arms) comes from a file to dodge shell
  // quoting; the fingerprint is computed here so the test records the build its prediction is about.
  if (cmd === 'write') {
    const id = flag(rest, 'id'), owner = flag(rest, 'owner'), claim = flag(rest, 'claim');
    const files = flag(rest, 'files') || '', bodyFile = flag(rest, 'body-file');
    if (!id || !owner || !claim || !bodyFile) { console.error('usage: testbus.cjs write --id <id> --owner <lane> --claim "<one assertion>" --files "<a b c>" --body-file <path>'); process.exit(2); }
    if (!/^[A-Za-z0-9._-]+$/.test(id)) { console.error(`testbus â–¸ id '${id}' â€” letters, digits, dot, dash, underscore only (it becomes a filename)`); process.exit(2); }
    const file = path.join(testsDir(), `${id}.md`);
    if (fs.existsSync(file)) { console.error(`testbus â–¸ test '${id}' already exists â€” rearm or retire it, never overwrite`); process.exit(2); }
    let body; try { body = fs.readFileSync(bodyFile, 'utf8'); } catch (e) { console.error(`testbus â–¸ cannot read body: ${e.message}`); process.exit(2); }
    const meta = { id, claim, status: 'open', owner, build: currentFingerprint(), files, created: nowIso };
    const ffp = currentFilesFp(files);   // v2.74.2022 â€” staleness scoped to the claimed files, not the whole tree
    if (ffp) meta['files-fp'] = ffp;
    scrubbedWrite(file, formatDoc(meta, body));
    console.log(`TESTBUS â–¸ wrote tests/${id}.md [${meta.build}${ffp ? ` files:${ffp}` : ''}] owner ${owner}`);
    process.exit(0);
  }

  if (cmd === 'list' || !cmd) {
    const all = listTests();
    const open = all.filter((t) => (t.meta.status || 'open') === 'open');
    console.log(`TESTBUS â–¸ ${all.length} test(s) Â· ${open.length} open`);
    for (const t of all) console.log(`  ${(t.meta.status || 'open').toUpperCase().padEnd(7)} ${t.meta.id} â€” ${String(t.meta.claim || '').slice(0, 90)}`);
    process.exit(0);
  }

  // GRADER â€” the tick's view: which open tests are answerable on THIS build, and which are abandoned.
  // v2.74.2022 â€” LIVE* : the tree moved but every file the test CLAIMS is byte-identical to its stamp. In a
  // shared two-lane checkout the whole-tree fingerprint moves on every save by either lane, which staled tests
  // whose subject never changed; LIVE* is gradeable exactly like LIVE (the result records files-match for audit).
  if (cmd === 'grade-pending') {
    const fp = currentFingerprint();
    const now = Date.now();
    const open = listTests().filter((t) => (t.meta.status || 'open') === 'open');
    console.log(`TESTBUS â–¸ build ${fp} Â· ${open.length} open test(s)`);
    if (!open.length) { console.log('TESTBUS â–¸ none open â€” the bus has no live question'); process.exit(0); }
    for (const t of open) {
      const filesLive = !!(t.meta['files-fp'] && currentFilesFp(t.meta.files) === t.meta['files-fp']);
      const orphan = isOrphan(t.meta, t.mtimeMs, now, fp, ORPHAN_H, filesLive);
      const state = t.meta.build === fp ? 'LIVE ' : filesLive ? 'LIVE*' : orphan ? 'ORPHAN' : 'STALE';
      console.log(`  ${state.padEnd(6)} ${t.meta.id} [${t.meta.build}] owner ${t.meta.owner} â€” ${String(t.meta.claim || '').slice(0, 80)}`);
    }
    console.log('TESTBUS â–¸ grade the OLDEST LIVE/LIVE* test (LIVE* = its claimed files are unchanged, only the shared tree moved); STALE means a claimed file actually changed â€” its owner rearms or retires; ORPHAN gets an ORPHANED result, never a silent adoption.');
    process.exit(0);
  }

  if (cmd === 'show') {
    const t = readTest(rest[0] || '');
    console.log(fs.readFileSync(t.file, 'utf8'));
    process.exit(0);
  }

  // GRADER â€” append one result file per attempt. Never rewrites: two attempts that disagree are DATA.
  if (cmd === 'result') {
    const [id, verdict] = rest;
    const grader = flag(rest, 'grader'), evFile = flag(rest, 'evidence-file'), note = flag(rest, 'note') || '';
    if (!id || !RESULT_VERDICTS.test(verdict || '') || !grader) {
      console.error('usage: testbus.cjs result <id> <PASS|FAIL|INCONCLUSIVE|UNMAPPED|ORPHANED> --grader <lane> [--evidence-file <path>] [--note "â€¦"]'); process.exit(2);
    }
    const t = readTest(id);
    let evidence = '';
    if (evFile) { try { evidence = fs.readFileSync(evFile, 'utf8'); } catch (e) { console.error(`testbus â–¸ cannot read evidence: ${e.message}`); process.exit(2); } }
    const meta = {
      test: id, verdict, graded: nowIso, grader,
      'self-graded': String(grader === t.meta.owner),
      'build-tick': currentFingerprint(), 'build-test': t.meta.build || '?',
      note,
    };
    // v2.74.2022 â€” the audit line for a LIVE* grade: whether the test's claimed files still matched at grade time.
    if (t.meta['files-fp']) meta['files-match'] = String(currentFilesFp(t.meta.files) === t.meta['files-fp']);
    const body = evidence ? `EVIDENCE (scrubbed, quoted from the window graded):\n\n${evidence}` : '(no evidence quoted)';
    const basename = resultFileName(id, nowIso, verdict);
    const file = path.join(resultsDir(), basename);
    scrubbedWrite(file, formatDoc(meta, body));
    console.log(`TESTBUS â–¸ result ${verdict} â†’ results/${basename}${meta['self-graded'] === 'true' ? ' (self-graded)' : ''}`);
    // v2.74.2017 â€” self-grade auto-acks as `seen` so the next tick does not re-diagnose the same result.
    // Retirement / arm-repair stay explicit owner acts; this only keeps the inbox from looping on ourselves.
    if (meta['self-graded'] === 'true') {
      appendAck(ackRow({ ts: nowIso, lane: grader, result: basename, test: id, verdict, disposition: 'seen' }));
      console.log(`TESTBUS â–¸ auto-acked ${basename} as seen (self-graded)`);
    }
    console.log('TESTBUS â–¸ now commit+push orchard-logs â€” a result that only exists locally was never delivered.');
    process.exit(0);
  }

  // BUILDER â€” unacked results for my lane. Pull is the caller's job (STEP 1 / STEP 0b).
  if (cmd === 'inbox') {
    const owner = flag(rest, 'owner') || rest[0];
    if (!owner) { console.error('usage: testbus.cjs inbox --owner <lane>'); process.exit(2); }
    const rows = inboxRows(listTests(), listResults(), ackedSet(readAckLedger(), owner), owner);
    if (!rows.length) { console.log(`INBOX â–¸ empty â€” nothing new for ${owner}`); process.exit(0); }
    console.log(`INBOX â–¸ ${rows.length} unacked for ${owner} â€” act the OLDEST; one per tick`);
    for (const r of rows) {
      console.log(`  ${String(r.verdict).padEnd(12)} ${r.test}  ${r.graded}  by ${r.grader}`);
      if (r.note) console.log(`            note: ${r.note.slice(0, 140)}`);
      console.log(`            file: results/${r.file}`);
      console.log(`            next: ${r.next}`);
    }
    process.exit(0);
  }

  // BUILDER â€” record that this lane has handled (or deliberately deferred) a result. Idempotent.
  if (cmd === 'ack') {
    // Normalize to basename — inbox compares basenames; a `results/…` arg used to ack forever-unacked (live 18:05Z).
    const basename = path.basename(String(rest[0] || '').replace(/\\/g, '/'));
    const owner = flag(rest, 'owner');
    const disposition = flag(rest, 'disposition') || 'seen';
    if (!basename || !owner || !ACK_DISPOSITIONS.test(disposition)) {
      console.error('usage: testbus.cjs ack <result-basename> --owner <lane> [--disposition waiting-human|arm-repaired|rearmed|fixed|retired|adopted|seen]');
      process.exit(2);
    }
    const already = ackedSet(readAckLedger(), owner);
    if (already.has(basename)) { console.log(`ACK â–¸ already â€” ${basename}`); process.exit(0); }
    // Prefer the result file's meta when present; a missing file still acks (builder may ack after a prune).
    let test = '?', verdict = '?';
    const rf = path.join(resultsDir(), basename);
    if (fs.existsSync(rf)) {
      const { meta } = parseDoc(fs.readFileSync(rf, 'utf8'));
      test = meta.test || '?';
      verdict = meta.verdict || '?';
    } else {
      const m = /^(.+)--\d{8}T\d{4}Z--([A-Z]+)\.md$/.exec(basename);
      if (m) { test = m[1]; verdict = m[2]; }
    }
    appendAck(ackRow({ ts: nowIso, lane: owner, result: basename, test, verdict, disposition }));
    console.log(`ACK â–¸ ${basename} â†’ ${disposition}`);
    process.exit(0);
  }

  // BUILDER â€” cold-start view: my open tests + latest result each (or no result yet).
  if (cmd === 'mine') {
    const owner = flag(rest, 'owner') || rest[0];
    if (!owner) { console.error('usage: testbus.cjs mine --owner <lane>'); process.exit(2); }
    const mine = listTests().filter((t) => t.meta.owner === owner);
    const open = mine.filter((t) => (t.meta.status || 'open') === 'open');
    console.log(`MINE â–¸ ${mine.length} test(s) Â· ${open.length} open Â· owner ${owner}`);
    const byTest = new Map();
    for (const r of listResults()) {
      const id = r.meta && r.meta.test;
      if (!id) continue;
      const prev = byTest.get(id);
      if (!prev || String(r.meta.graded || '') > String(prev.meta.graded || '')) byTest.set(id, r);
    }
    for (const t of mine) {
      const st = (t.meta.status || 'open').toUpperCase().padEnd(7);
      const latest = byTest.get(t.meta.id);
      const summary = latest
        ? `${latest.meta.verdict} @ ${latest.meta.graded}${latest.meta['self-graded'] === 'true' ? ' (self)' : ''}`
        : 'no result yet';
      console.log(`  ${st} ${t.meta.id} â€” ${summary}`);
    }
    process.exit(0);
  }

  // BUILDER â€” the read path: what did the grader say about my test?
  if (cmd === 'results') {
    const id = rest[0];
    if (!id) { console.error('usage: testbus.cjs results <id>'); process.exit(2); }
    const dir = resultsDir();
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(`${id}--`)).sort() : [];
    if (!files.length) { console.log(`TESTBUS â–¸ no results yet for '${id}'`); process.exit(0); }
    for (const f of files) {
      const { meta } = parseDoc(fs.readFileSync(path.join(dir, f), 'utf8'));
      console.log(`  ${meta.verdict.padEnd(12)} ${meta.graded} by ${meta.grader}${meta['self-graded'] === 'true' ? ' (self)' : ''}${meta.note ? ` â€” ${meta.note}` : ''}  (results/${f})`);
    }
    process.exit(0);
  }

  // BUILDER (owner only) â€” the fix landed, HEAD and the diff moved, the recorded fingerprint can never match
  // again. Same append-a-fact discipline as blocks.cjs rearm, except here the build field IS the live fact,
  // so it updates in place and the old fingerprint is preserved as history in the body.
  if (cmd === 'rearm') {
    const [id, ...note] = rest;
    const t = readTest(id || '');
    const fp = currentFingerprint();
    const old = t.meta.build;
    t.meta.build = fp;
    const ffp = currentFilesFp(t.meta.files);   // v2.74.2022 â€” the files-fp re-stamps with the build
    if (ffp) t.meta['files-fp'] = ffp;
    const hist = `REARM ${nowIso} â€” ${old} â†’ ${fp}${note.length ? ` â€” ${note.join(' ')}` : ''}`;
    scrubbedWrite(t.file, formatDoc(t.meta, `${t.body.replace(/\n*$/, '')}\n\n${hist}\n`));
    console.log(`TESTBUS â–¸ re-armed ${id} on ${fp}${ffp ? ` files:${ffp}` : ''}`);
    process.exit(0);
  }

  if (cmd === 'retire') {
    const [id, verdict, ...note] = rest;
    if (!id || !RETIRE_VERDICTS.test(verdict || '')) { console.error('usage: testbus.cjs retire <id> <PASS|FAIL|SUPERSEDED|WONTFIX> [noteâ€¦]'); process.exit(2); }
    const t = readTest(id);
    t.meta.status = 'retired';
    t.meta.verdict = verdict;
    if (note.length) t.meta.note = note.join(' ');
    t.meta.retired = nowIso;
    scrubbedWrite(t.file, formatDoc(t.meta, t.body));
    console.log(`TESTBUS â–¸ retired ${id} as ${verdict}`);
    process.exit(0);
  }

  console.error('usage: testbus.cjs lane | lease status|claim|release <lane> | write --id â€¦ | list | grade-pending | show <id> | result <id> <verdict> --grader <lane> â€¦ | results <id> | inbox --owner <lane> | ack <basename> --owner <lane> [--disposition â€¦] | mine --owner <lane> | rearm <id> [noteâ€¦] | retire <id> <verdict> [noteâ€¦]');
  process.exit(2);
}
