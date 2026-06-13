#!/usr/bin/env node
'use strict';
// bridge/host.js — DB-1 (v2.74.972): the orchard dev-bridge NATIVE-MESSAGING HOST
// (docs/DESIGN_dev_bridge.md §3). Chrome spawns this per connectNative port; it speaks the framed
// native-messaging protocol on stdio and shells the Claude Code CLI against THIS repo.
//
// INVARIANTS (the spec's trust rules, enforced here):
//   • stdout is the PROTOCOL channel — host diagnostics go to logs/bridge/host.log + stderr, never stdout.
//   • The host writes ONLY under logs/ (trace attachments → logs/run/, journals/lock → logs/bridge/).
//   • User text NEVER touches a shell command line: the spawned `claude -p` command is a FIXED literal;
//     the prompt is written to the child's STDIN (print mode reads it), so there is no quoting/injection
//     surface no matter what the panel sends.
//   • DB-1 allowlist: Read, Grep, Glob, Edit, Write — no Bash, no git (commits stay human, spec §2/§6).
//   • Spawn + journal (§3.3): the run journals to logs/bridge/ and is tracked by a child-pid lock; a
//     fresh host reads active.json + the journal to catch up. Survival across host death is BEST-EFFORT
//     (v2.74.974: `detached` had to go — it silences the .cmd-shim chain's stdout on Windows entirely —
//     so port-close survival rests on Windows' children-outlive-parents default; DB-3 owns the guarantee).
//   • Protocol VERSIONED from message one ({v:1, ...}) — it is a future public protocol (§11).
//
// Node ≥16 (no deps, CommonJS — the repo has no package.json "type").

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const PROTOCOL_V = 1;
const REPO = path.resolve(__dirname, '..');
const BRIDGE_DIR = path.join(REPO, 'logs', 'bridge');
const RUN_DIR = path.join(REPO, 'logs', 'run');
const LOCK = path.join(BRIDGE_DIR, 'active.json');
const HOST_LOG = path.join(BRIDGE_DIR, 'host.log');
const MAX_IN_FRAME = 4 * 1024 * 1024;     // Chrome→host frames may carry a trace attachment (we cap at 2MB)
const MAX_ATTACHMENT = 2 * 1024 * 1024;   // spec §3.1
const MAX_OUT_EVENT = 200 * 1024;         // host→Chrome frames are capped at 1MB by Chrome; stay well under
// v2.74.979 — per-run turn budget (spec §8's runaway guard), FULLY user-controlled: this is the dev's
// own machine + API cost, so there is no artificial ceiling or floor — set it as high as you like. The
// ONLY constraint is the injection invariant: the value reaching the command line must be a clean integer
// WE parsed, never panel free text. A finite positive integer is used as-is; anything else (junk / ≤0 /
// non-number) falls back to the default. DEFAULT is the value when unset, not a clamp target.
const DEFAULT_MAX_TURNS = 25;
function turnsFor(n) {
  const x = Math.floor(Number(n));
  return Number.isFinite(x) && x >= 1 ? x : DEFAULT_MAX_TURNS;
}
// The FIXED base command (see invariant above — no user text is ever concatenated into this). The
// `--max-turns <n>` (clamped int) and `--model <id>` (frozen allowlist) flags are appended host-side.
const CLAUDE_CMD = 'claude -p --output-format stream-json --verbose'
  + ' --allowedTools Read Grep Glob Edit Write';

// v2.74.976 — model selection WITHOUT breaking the no-user-text-on-the-command-line invariant: the panel
// sends a short ALIAS, and ONLY a value from this fixed table is ever appended to the command (`--model
// <id>`). An alias not in the table is ignored → the run uses Claude Code's configured default, exactly
// as before. So the model is host-controlled data, never panel-supplied free text. Aliases + ids per the
// CLI's own --model vocabulary; 'default' (or absent) appends nothing.
const ALLOWED_MODELS = Object.freeze({
  default: null,
  fable:   'claude-fable-5',
  opus:    'claude-opus-4-8',
  sonnet:  'claude-sonnet-4-6',
  haiku:   'claude-haiku-4-5',
});
function modelFlag(alias) {
  const id = Object.prototype.hasOwnProperty.call(ALLOWED_MODELS, String(alias)) ? ALLOWED_MODELS[String(alias)] : null;
  return id ? ` --model ${id}` : '';   // id comes from the frozen table — safe to interpolate
}

for (const d of [BRIDGE_DIR, RUN_DIR]) { try { fs.mkdirSync(d, { recursive: true }); } catch { /* */ } }

function log(line) {
  const msg = `${new Date().toISOString()} ${line}\n`;
  try { fs.appendFileSync(HOST_LOG, msg); } catch { /* */ }
  try { process.stderr.write(msg); } catch { /* */ }
}

// ── framing ──────────────────────────────────────────────────────────────────────────────────────
function send(obj) {
  let body = Buffer.from(JSON.stringify(obj), 'utf8');
  if (body.length > 950 * 1024) {
    body = Buffer.from(JSON.stringify({ v: PROTOCOL_V, type: 'error', code: 'frame-too-large', dropped: obj.type }), 'utf8');
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let inBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  for (;;) {
    if (inBuf.length < 4) break;
    const len = inBuf.readUInt32LE(0);
    if (len > MAX_IN_FRAME) { log(`FATAL inbound frame ${len}B > cap`); process.exit(1); }
    if (inBuf.length < 4 + len) break;
    const json = inBuf.slice(4, 4 + len).toString('utf8');
    inBuf = inBuf.slice(4 + len);
    let msg = null;
    try { msg = JSON.parse(json); } catch { send({ v: PROTOCOL_V, type: 'error', code: 'bad-json' }); continue; }
    Promise.resolve(handle(msg)).catch((e) => {
      log(`handler error: ${e && e.stack || e}`);
      send({ v: PROTOCOL_V, type: 'error', code: 'internal', message: String((e && e.message) || e) });
    });
  }
});
// The port closed (panel closed / extension reloaded / Chrome quit). A detached child keeps running
// and journaling; a fresh host instance reattaches via the lock + journal (status verb, DB-3 replay).
process.stdin.on('end', () => { log('port closed — host exiting (detached child, if any, continues)'); process.exit(0); });

// ── lock (one bridge run at a time; the lock tracks the CHILD pid, not the host's) ────────────────
function readLock() {
  try { return JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  if (typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function activeLock() {
  const l = readLock();
  if (!l) return null;
  if (!pidAlive(l.pid)) { try { fs.unlinkSync(LOCK); } catch { /* */ } return null; }   // stale → reclaim
  return l;
}
function clearLock() { try { fs.unlinkSync(LOCK); } catch { /* */ } }

// ── verbs ─────────────────────────────────────────────────────────────────────────────────────────
function preflight() {
  let claudeVersion = null;
  try {
    const r = spawnSync('claude --version', { shell: true, timeout: 15000, encoding: 'utf8' });
    claudeVersion = (r.stdout || '').trim().split(/\r?\n/)[0] || null;
  } catch { /* */ }
  const ok = !!claudeVersion && fs.existsSync(path.join(REPO, 'manifest.json'));
  return {
    v: PROTOCOL_V, type: 'preflight', ok,
    nodeVersion: process.version, claudeVersion, repoRoot: REPO,
    error: ok ? null : (!claudeVersion ? 'claude CLI not found on PATH' : 'repo root looks wrong (no manifest.json)'),
  };
}

function statusReply() {
  const l = activeLock();
  return { v: PROTOCOL_V, type: 'status', active: !!l, pid: l ? l.pid : null, startedAt: l ? l.startedAt : null, journal: l ? path.basename(l.journal || '') : null };
}

// DB-2 (v2.74.975, spec §3.4) — read-only working-tree diffstat so the panel's reload icon can light
// when a bridge run (or a terminal edit) changed repo files. git is run BY THE HOST, read-only — this
// does NOT relax the trust rule that the spawned `claude` child has no git in its allowlist (that rule
// is about the agent committing; computing a diffstat enables nothing). Empty/erroring → no files.
// DB-2 fix (v2.74.980) — a CONTENT signature of the working tree vs HEAD, so the panel's reload icon can
// mean "changed SINCE the last reload" (the spec §5 / chat.html intent: "since this load") rather than the
// useless "tree is dirty" — which, because bridge runs never commit, stays true forever and so never
// clears after a reload. Tracked changes ride the full `git diff HEAD` patch (content-precise); untracked
// files contribute path:size:mtime (mtime bumps on any rewrite, a cheap content-change proxy). A clean
// tree hashes the empty string — harmless, since the icon is gated on files.length anyway.
function workingTreeSig() {
  const parts = [];
  try {
    const diff = spawnSync('git diff HEAD', { cwd: REPO, shell: true, timeout: 10000, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    parts.push(String(diff.stdout || ''));
    const unt = spawnSync('git ls-files --others --exclude-standard', { cwd: REPO, shell: true, timeout: 10000, encoding: 'utf8' });
    for (const f of String(unt.stdout || '').split(/\r?\n/)) {
      const name = f.trim();
      if (!name) continue;
      let tag = `${name}:?`;
      try { const s = fs.statSync(path.join(REPO, name)); tag = `${name}:${s.size}:${Math.round(s.mtimeMs)}`; } catch { /* */ }
      parts.push(tag);
    }
  } catch { /* git missing / not a repo → empty (stable) signature */ }
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex');
}

function diffstatReply() {
  const files = [];
  try {
    const counts = {};
    const ns = spawnSync('git diff --numstat HEAD', { cwd: REPO, shell: true, timeout: 10000, encoding: 'utf8' });
    for (const line of String(ns.stdout || '').split(/\r?\n/)) {
      const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
      if (m) counts[m[3]] = { plus: m[1] === '-' ? 0 : Number(m[1]), minus: m[2] === '-' ? 0 : Number(m[2]) };
    }
    // porcelain status = the full dirty set, tracked + untracked (numstat above only covers tracked).
    const st = spawnSync('git status --porcelain=v1 --untracked-files=all', { cwd: REPO, shell: true, timeout: 10000, encoding: 'utf8' });
    for (const line of String(st.stdout || '').split(/\r?\n/)) {
      if (!line.trim()) continue;
      let p = line.slice(3).trim();
      const arrow = p.indexOf(' -> ');                  // rename: "old -> new" — report the new path
      if (arrow !== -1) p = p.slice(arrow + 4);
      p = p.replace(/^"|"$/g, '');
      const c = counts[p] || { plus: 0, minus: 0 };
      files.push({ path: p, plus: c.plus, minus: c.minus });
    }
  } catch { /* git missing / not a repo → report nothing changed */ }
  return { v: PROTOCOL_V, type: 'diffstat', files, sig: workingTreeSig() };
}

function cancelRun() {
  const l = activeLock();
  if (!l) return { v: PROTOCOL_V, type: 'status', active: false, cancelled: false };
  try { spawnSync(`taskkill /pid ${l.pid} /t /f`, { shell: true, timeout: 10000 }); } catch { /* */ }
  clearLock();
  log(`cancelled run pid=${l.pid}`);
  return { v: PROTOCOL_V, type: 'status', active: false, cancelled: true };
}

// Sanitize a panel-supplied attachment filename: basename only, must look like an orchard trace, else a
// generated name. The host writes attachments ONLY into logs/run/.
function traceFileName(requested) {
  const base = path.basename(String(requested || ''));
  if (/^orchard-logs[A-Za-z0-9._-]*\.txt$/.test(base)) return base;
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `orchard-logs-bridge-${ts}.txt`;
}

function startRun(msg) {
  if (activeLock()) {
    const l = readLock();
    send({ v: PROTOCOL_V, type: 'error', code: 'busy', pid: l ? l.pid : null });
    return;
  }
  // ---- schema guard (spec §3.4) ----
  const verb = msg.verb;
  if (verb !== 'gl' && verb !== 'dev') { send({ v: PROTOCOL_V, type: 'error', code: 'bad-verb' }); return; }
  let prompt = null;
  if (verb === 'gl') {
    const att = Array.isArray(msg.attachments) ? msg.attachments[0] : null;
    if (att && att.kind === 'decisions-trace' && typeof att.content === 'string') {
      if (Buffer.byteLength(att.content, 'utf8') > MAX_ATTACHMENT) { send({ v: PROTOCOL_V, type: 'error', code: 'attachment-too-large' }); return; }
      const fname = traceFileName(att.filename);
      try { fs.writeFileSync(path.join(RUN_DIR, fname), att.content, 'utf8'); log(`gl attachment → logs/run/${fname}`); }
      catch (e) { send({ v: PROTOCOL_V, type: 'error', code: 'attachment-write-failed', message: e.message }); return; }
    }
    prompt = 'gl';   // the repo's standing convention does the rest (memory: read findings first, analyze newest, append one entry)
  } else {
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text || text.length > 4000) { send({ v: PROTOCOL_V, type: 'error', code: 'bad-text' }); return; }
    prompt = text;
  }

  // ---- detached spawn + journal (spec §3.3) ----
  const ts = Date.now();
  const journal = path.join(BRIDGE_DIR, `${ts}.jsonl`);
  const errLog = path.join(BRIDGE_DIR, `${ts}.err.log`);
  let outFd, errFd;
  try { outFd = fs.openSync(journal, 'a'); errFd = fs.openSync(errLog, 'a'); }
  catch (e) { send({ v: PROTOCOL_V, type: 'error', code: 'journal-open-failed', message: e.message }); return; }
  // v2.74.976 — append `--model <id>` ONLY from the frozen allowlist (see modelFlag); an unknown/absent
  // alias adds nothing → the CLI's configured default. The command stays a host-built literal.
  const turns = turnsFor(msg.maxTurns);   // v2.74.978 — clamped int; the only number that reaches the command
  // v2.74.985 — conversational bridge: a `dev:` run RESUMES the prior session by default (the panel sends
  // its last session_id as resumeSessionId), so the bridge is a continuing conversation, not a string of
  // amnesiac one-shots. Injection invariant holds: the id is FORMAT-CHECKED to a strict UUID before it
  // touches the command line — a non-UUID is ignored (fresh run), never interpolated.
  const _sid = String(msg.resumeSessionId ?? '');
  const resumeFlag = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(_sid) ? ` --resume ${_sid}` : '';
  const cmd = CLAUDE_CMD + ` --max-turns ${turns}` + resumeFlag + modelFlag(msg.model);
  let child;
  try {
    // cmd /d /s /c <FIXED literal> — the prompt goes to STDIN, never the command line (see header).
    // v2.74.974 — NO `detached`: on Windows, DETACHED_PROCESS gives cmd no console and the .cmd-shim
    // chain (claude.cmd → node) loses its redirected stdout ENTIRELY — the first live gl run journaled
    // 0 bytes and died as `host-lost` (flag matrix: plain ✓, windowsHide ✓, detached ✗). Survival on
    // port-close is therefore BEST-EFFORT (Windows children outlive parents unless Chrome's job object
    // says otherwise) — the DB-3 reattach slice owns making that a guarantee.
    child = spawn('cmd.exe', ['/d', '/s', '/c', cmd], {
      cwd: REPO, windowsHide: true,
      stdio: ['pipe', outFd, errFd],
    });
  } catch (e) {
    send({ v: PROTOCOL_V, type: 'error', code: 'spawn-failed', message: e.message });
    try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* */ }
    return;
  }
  try { child.stdin.write(prompt); child.stdin.end(); } catch (e) { log(`stdin write failed: ${e.message}`); }
  try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* */ }   // the child holds its own copies
  child.unref();
  try {
    fs.writeFileSync(LOCK, JSON.stringify({ v: PROTOCOL_V, pid: child.pid, startedAt: ts, journal, verb, maxTurns: turns, promptPreview: prompt.slice(0, 100) }, null, 2));
  } catch { /* */ }
  const _modelId = (modelFlag(msg.model).match(/--model (\S+)/) || [])[1] || 'default';
  const _resumed = resumeFlag ? _sid : null;
  log(`run started verb=${verb} model=${_modelId} maxTurns=${turns}${_resumed ? ` resume=${_resumed.slice(0, 8)}` : ''} pid=${child.pid} journal=${path.basename(journal)}`);
  send({ v: PROTOCOL_V, type: 'started', pid: child.pid, journal: path.basename(journal), startedAt: ts, model: _modelId, maxTurns: turns, resumed: _resumed });
  tailJournal(journal, child.pid);
}

// Poll-tail the journal, forwarding each stream-json line as an event frame. Poll (not fs.watch) — it is
// portable and the cadence is humane for a CLI run. Ends on the `result` line or child death.
function tailJournal(journal, pid) {
  let offset = 0;
  let partial = '';
  const timer = setInterval(() => {
    let size = 0;
    try { size = fs.statSync(journal).size; } catch { /* not yet */ }
    if (size > offset) {
      let delta = '';
      try {
        const fd = fs.openSync(journal, 'r');
        const buf = Buffer.alloc(size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset);
        fs.closeSync(fd);
        delta = buf.toString('utf8');
        offset = size;
      } catch (e) { log(`tail read failed: ${e.message}`); }
      const lines = (partial + delta).split(/\r?\n/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let ev = null;
        try { ev = JSON.parse(line); } catch { continue; }   // non-JSON noise stays in the journal
        if (JSON.stringify(ev).length > MAX_OUT_EVENT) ev = { type: ev.type || 'event', truncated: true };
        send({ v: PROTOCOL_V, type: 'event', ev });
        if (ev && ev.type === 'result') {
          clearInterval(timer);
          clearLock();
          log(`run done pid=${pid} (${ev.subtype || 'result'})`);
          send({ v: PROTOCOL_V, type: 'done', result: { subtype: ev.subtype ?? null, costUsd: ev.total_cost_usd ?? null, durationMs: ev.duration_ms ?? null, numTurns: ev.num_turns ?? null, sessionId: ev.session_id ?? null } });
          return;
        }
      }
    }
    if (!pidAlive(pid)) {
      clearInterval(timer);
      clearLock();
      log(`run pid=${pid} exited without a result event`);
      send({ v: PROTOCOL_V, type: 'done', result: { subtype: 'host-lost' } });
    }
  }, 300);
  timer.unref?.();
}

// ── dispatch ─────────────────────────────────────────────────────────────────────────────────────
async function handle(msg) {
  if (!msg || msg.v !== PROTOCOL_V || typeof msg.type !== 'string') {
    send({ v: PROTOCOL_V, type: 'error', code: 'bad-envelope' });
    return;
  }
  switch (msg.type) {
    case 'preflight': send(preflight()); break;
    case 'status':    send(statusReply()); break;
    case 'diffstat':  send(diffstatReply()); break;
    case 'cancel':    send(cancelRun()); break;
    case 'run':       startRun(msg); break;
    default:          send({ v: PROTOCOL_V, type: 'error', code: 'unknown-type', got: msg.type });
  }
}

log(`host up (node ${process.version}, repo ${REPO})`);
