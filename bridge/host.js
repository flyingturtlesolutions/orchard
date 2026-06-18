#!/usr/bin/env node
'use strict';
// bridge/host.js — DB-1 (v2.74.972): the orchard dev-bridge NATIVE-MESSAGING HOST
// (docs/DESIGN_dev_bridge.md §3). Chrome spawns this per connectNative port; it speaks the framed
// native-messaging protocol on stdio and shells the Claude Code CLI against THIS repo.
//
// INVARIANTS (the spec's trust rules, enforced here):
//   • stdout is the PROTOCOL channel — host diagnostics go to logs/bridge/host.log + stderr, never stdout.
//   • The host writes ONLY under logs/ (trace attachments → logs/run/, journals/lock → logs/bridge/).
//   • The prompt is written to the child's STDIN (print mode reads it), so user *prompt* text has no
//     command-line quoting/injection surface no matter what the panel sends. claude's args are passed as
//     DISCRETE argv elements (never one concatenated string), so the host does NO shell interpolation; every
//     appended value is host-validated (settings path · clamped int · strict-UUID · frozen model id). The one
//     user-DERIVED value on the command line is the DBR-5 concern (--append-system-prompt), and only after
//     concern.cjs sanitizes it to an inert single-line label — i.e. "validated before reaching the command
//     line" (CLAUDE.md), not free panel text.
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
const gitOps = require('./gitOps.cjs');   // DBR-1 — the parameter-validated dev-branch git allowlist (§3)
const { buildConcernContract } = require('./concern.cjs');   // DBR-5 — the per-spawn scope-contract builder (§8.2)

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
// DB-2 (v2.74.988) — the scoped-Bash allowlist (npm test + node, so a fix can verify itself) lives in a
// GENERATED SETTINGS FILE, not on the command line. `--allowedTools "Bash(npm test:*)"` cannot survive
// Node's Windows arg-escaping: the embedded quotes become \" and cmd.exe mangles them (verified). A
// `--settings <relative path>` has no spaces/parens/quotes, threads through cmd.exe cleanly, and claude
// UNIONS its permissions.allow with the CLI --allowedTools. The path is relative to cwd=REPO so it can't
// pick up spaces from the user's home dir.
const SETTINGS_FILE = path.join(BRIDGE_DIR, 'db2-permissions.json');
const SETTINGS_REL = 'logs/bridge/db2-permissions.json';
// DB-3 permission relay (v2.74.1002) — a SECOND settings file that ALSO registers the PreToolUse hook
// (bridge/permhook.js). A `relay` run loads this instead of db2-permissions.json: the hook becomes the
// gate (auto-allow the safe tier, relay everything else to the panel for approve/deny — verified by
// bridge/permtest.cjs that a hook `allow` even grants a tool default mode would deny). The perm request/
// response files live under logs/bridge/perm/. Relay is opt-in; default runs keep the DB-2 allowlist.
const RELAY_SETTINGS_FILE = path.join(BRIDGE_DIR, 'db3-relay-settings.json');
const RELAY_SETTINGS_REL = 'logs/bridge/db3-relay-settings.json';
const PERM_DIR = path.join(BRIDGE_DIR, 'perm');
const PERMHOOK = path.join(REPO, 'bridge', 'permhook.js');

// DBR-P3-3b (v2.74.1057, DESIGN §8.1/U5) — the INERT `propose_split` MCP server (bridge/mcpProposeSplit.cjs) is
// exposed to claude via `--mcp-config`. The config is rewritten each launch (self-heal, like the settings files);
// the server declares ONE proposal-only tool that returns a static ack — no fs/git/network — so the PANEL alone
// seeds the branch on a human tap. `mcp__devbridge__propose_split` is added to the allowlist below so default mode
// (which auto-denies unlisted tools) lets claude call it. Trust: this exposes a typed PROPOSAL, never a mutation.
const MCP_SERVER = path.join(REPO, 'bridge', 'mcpProposeSplit.cjs');
const MCP_CONFIG_FILE = path.join(BRIDGE_DIR, 'mcp-config.json');
const MCP_CONFIG_REL = 'logs/bridge/mcp-config.json';
const PROPOSE_SPLIT_TOOL = 'mcp__devbridge__propose_split';

// The FIXED base command (see invariant above — no user text is ever concatenated into this). The
// `--settings`, `--max-turns <n>` (clamped int) and `--model <id>` (frozen allowlist) flags are appended
// host-side in startRun. v2.74.988 — `--permission-mode default` makes the gate actually BIND (without it
// a bypassPermissions global default silently disables it). In -p mode default never hangs: an unlisted
// tool is auto-denied (or, with relay on, routed to the PreToolUse hook) and the agent adapts.
const CLAUDE_CMD = 'claude -p --output-format stream-json --verbose --permission-mode default'
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
// DB-2 (v2.74.988) — (re)write the scoped-Bash allowlist the run loads via --settings. Static content;
// rewritten on every host launch so a deleted/edited file self-heals. permissions.allow UNIONS with the
// CLI --allowedTools, adding exactly `npm test …` and `node …` — still no git, no network, no plain shell.
try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ permissions: { allow: ['Bash(npm test:*)', 'Bash(node:*)', PROPOSE_SPLIT_TOOL] } }, null, 2)); } catch { /* */ }
// DB-3 (v2.74.1002) — the relay settings file: same allowlist PLUS the PreToolUse hook that routes every
// non-safe tool to the panel for approval. Quoted absolute path (handles spaces); forward slashes so the
// JSON has no backslash-escaping surprises and the shell runs node fine on Windows.
try { fs.writeFileSync(RELAY_SETTINGS_FILE, JSON.stringify({
  permissions: { allow: ['Bash(npm test:*)', 'Bash(node:*)', PROPOSE_SPLIT_TOOL] },
  hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node "${PERMHOOK.replace(/\\/g, '/')}"` }] }] },
}, null, 2)); } catch { /* */ }
// DBR-P3-3b (v2.74.1057) — the MCP config exposing the inert propose_split server (rewritten each launch, self-heal).
// `command:'node' args:[<abs forward-slashed path>]` — claude spawns the server shell-free, so a path with spaces is
// fine; the `--mcp-config` path itself is relative to cwd=REPO (no spaces). The server is dependency-free + inert.
try { fs.writeFileSync(MCP_CONFIG_FILE, JSON.stringify({
  mcpServers: { devbridge: { type: 'stdio', command: 'node', args: [MCP_SERVER.replace(/\\/g, '/')] } },
}, null, 2)); } catch { /* */ }
try { fs.mkdirSync(PERM_DIR, { recursive: true }); } catch { /* */ }

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
// v2.74.999 — bound the pid-reuse footgun. pidAlive() asks `process.kill(pid,0)`, but on Windows a dead
// run's pid can be REUSED by an unrelated process, so a stale lock reads as "alive" and refuses every new
// run as `busy` forever (observed: a lock from an abandoned run blocked the next run until deleted by
// hand). An age cap reclaims a lock older than any sane run, independent of the pid check — and it never
// taskkills, so it can't hit the innocent reused-pid process.
const MAX_LOCK_AGE_MS = 6 * 60 * 60 * 1000;   // 6h — far longer than any real run; just bounds the footgun
function activeLock() {
  const l = readLock();
  if (!l) return null;
  if (l.startedAt && (Date.now() - l.startedAt) > MAX_LOCK_AGE_MS) { try { fs.unlinkSync(LOCK); } catch { /* */ } return null; }   // stale by age → reclaim
  if (!pidAlive(l.pid)) { try { fs.unlinkSync(LOCK); } catch { /* */ } return null; }   // dead pid → reclaim
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

// DB-3 (v2.74.999) — REATTACH. Answer the status probe AND, if a run is still alive, re-tail its journal
// from the top so a FRESH host (panel reopened / extension reloaded) replays the whole run and then
// catches up live. activeLock() already reclaims a stale lock (dead pid) → a dead run reports inactive and
// no tail starts. tailJournal is _tailing-guarded, so this is a no-op when this host already owns the run.
function handleStatus() {
  send(statusReply());
  const l = activeLock();
  if (l && l.journal) { log(`reattach: re-tailing pid=${l.pid} journal=${path.basename(l.journal)}`); tailJournal(l.journal, l.pid); }
}

// DB-3 permission relay (v2.74.1002) — watch logs/bridge/perm for hook-written requests and forward each
// to the panel as an `approval` frame; the panel's `approval-decision` is written back as a resp file the
// hook is polling. Runs continuously while the host is alive (the hook only writes requests on relay runs,
// so this is idle otherwise). One pending request at a time in practice (claude awaits the hook).
const _seenPerm = new Set();
function watchPerm() {
  let files = [];
  try { files = fs.readdirSync(PERM_DIR).filter((f) => f.endsWith('.req.json')); } catch { return; }
  for (const rf of files) {
    const id = rf.slice(0, -('.req.json'.length));
    if (_seenPerm.has(id)) continue;
    _seenPerm.add(id);
    let req = null;
    try { req = JSON.parse(fs.readFileSync(path.join(PERM_DIR, rf), 'utf8')); } catch { continue; }
    log(`perm request ${id} tool=${req && req.tool_name}`);
    send({ v: PROTOCOL_V, type: 'approval', id, tool: req ? req.tool_name : '?', input: req ? req.tool_input : {}, ts: req ? req.ts : Date.now() });
  }
  if (_seenPerm.size > 200) { for (const id of _seenPerm) { if (!files.includes(`${id}.req.json`)) _seenPerm.delete(id); } }   // GC resolved ids
}
function writePermResp(msg) {
  const id = String(msg.id || '');
  if (!/^[0-9_]+$/.test(id)) return;   // ids are `${Date.now()}_${pid}` — reject anything else (no path traversal)
  const decision = msg.decision === 'allow' ? 'allow' : 'deny';
  // v2.74.1025 (DB-4) — the panel may attach a `reason` (the user's AskUserQuestion answer); pass it through
  // so the hook returns it to Claude. Cap length; the hook feeds it back as the deny reason / answer.
  const reason = (typeof msg.reason === 'string' && msg.reason.trim()) ? msg.reason.trim().slice(0, 2000) : 'panel';
  try { fs.writeFileSync(path.join(PERM_DIR, `${id}.resp.json`), JSON.stringify({ id, decision, reason })); log(`perm decision ${id} → ${decision}`); } catch { /* */ }
}
setInterval(watchPerm, 250).unref?.();

// DB-3 run history (v2.74.1000) — cheap peek at a journal: model + first assistant text from the head,
// the result summary from the tail. Read-only, bounded reads (journals can be hundreds of KB).
function peekJournal(journal) {
  const out = { model: null, firstText: null, sawResult: false, result: null };
  try {
    const size = fs.statSync(journal).size;
    const fd = fs.openSync(journal, 'r');
    try {
      const headLen = Math.min(size, 16 * 1024);
      const head = Buffer.alloc(headLen); fs.readSync(fd, head, 0, headLen, 0);
      for (const ln of head.toString('utf8').split(/\r?\n/)) {
        const t = ln.trim(); if (!t) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        if (ev.type === 'system' && ev.subtype === 'init' && !out.model) out.model = ev.model ?? null;
        if (ev.type === 'assistant' && !out.firstText) { for (const b of (ev.message && ev.message.content) || []) { if (b.type === 'text' && b.text && b.text.trim()) { out.firstText = b.text.trim().slice(0, 120); break; } } }
        if (out.model && out.firstText) break;
      }
      const tailStart = Math.max(0, size - 32 * 1024);
      const tail = Buffer.alloc(size - tailStart); fs.readSync(fd, tail, 0, tail.length, tailStart);
      const tlines = tail.toString('utf8').split(/\r?\n/);
      for (let i = tlines.length - 1; i >= 0; i--) {
        const t = tlines[i].trim(); if (!t) continue;
        let ev; try { ev = JSON.parse(t); } catch { continue; }
        if (ev.type === 'result') { out.sawResult = true; out.result = { subtype: ev.subtype ?? null, costUsd: ev.total_cost_usd ?? null, durationMs: ev.duration_ms ?? null, numTurns: ev.num_turns ?? null }; break; }
      }
    } finally { fs.closeSync(fd); }
  } catch { /* unreadable → minimal entry */ }
  return out;
}

// `history` — the last N runs, newest first, as lightweight summaries (verb/model/preview from the meta
// sidecar when present, else recovered from the journal; result from the journal tail).
function historyReply(limit = 20) {
  let journals = [];
  try { journals = fs.readdirSync(BRIDGE_DIR).filter((f) => /^\d+\.jsonl$/.test(f)); } catch { /* */ }
  journals.sort().reverse();   // ts filenames are equal-length numerics → lexical sort = chronological
  const runs = [];
  for (const jf of journals.slice(0, limit)) {
    const ts = parseInt(jf, 10);
    const peek = peekJournal(path.join(BRIDGE_DIR, jf));
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(BRIDGE_DIR, `${ts}.meta.json`), 'utf8')); } catch { /* pre-meta run */ }
    runs.push({
      ts, journal: jf,
      verb: (meta && meta.verb) || '?',
      model: (meta && meta.model) || peek.model || 'default',
      promptPreview: (meta && meta.promptPreview) || peek.firstText || '',
      startedAt: (meta && meta.startedAt) || ts,
      subtype: peek.result ? peek.result.subtype : (peek.sawResult ? 'done' : 'incomplete'),
      costUsd: peek.result ? peek.result.costUsd : null,
      numTurns: peek.result ? peek.result.numTurns : null,
      durationMs: peek.result ? peek.result.durationMs : null,
    });
  }
  return { v: PROTOCOL_V, type: 'history', runs };
}

// `history-open` — replay a finished journal read-only: stream every event, then a `done`. Reuses the
// panel's normal event/done render path (the panel sets up a replay bubble first). Never marks active.
function replayJournal(journalBase) {
  const base = path.basename(String(journalBase || ''));
  if (!/^\d+\.jsonl$/.test(base)) { send({ v: PROTOCOL_V, type: 'error', code: 'bad-journal' }); return; }
  let content = '';
  try { content = fs.readFileSync(path.join(BRIDGE_DIR, base), 'utf8'); } catch { send({ v: PROTOCOL_V, type: 'error', code: 'journal-missing' }); return; }
  let result = null;
  for (const ln of content.split(/\r?\n/)) {
    const t = ln.trim(); if (!t) continue;
    let ev; try { ev = JSON.parse(t); } catch { continue; }
    if (JSON.stringify(ev).length > MAX_OUT_EVENT) ev = { type: ev.type || 'event', truncated: true };
    send({ v: PROTOCOL_V, type: 'event', ev });
    if (ev.type === 'result') result = ev;
  }
  send({ v: PROTOCOL_V, type: 'done', result: result
    ? { subtype: result.subtype ?? null, costUsd: result.total_cost_usd ?? null, durationMs: result.duration_ms ?? null, numTurns: result.num_turns ?? null, sessionId: result.session_id ?? null }
    : { subtype: 'incomplete' } });
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

// DBR-1 (docs/DESIGN_dev_branches.md §3) — the dev-branch git surface. Unlike the FIXED-string diffstat calls
// above, these ops carry caller params, so they go through gitOps.buildGitArgs (parameter-validated → argv) and
// run with `shell:false` (no quoting/injection surface). The host adds the commit current-branch guard:
// `commitWip` carries no branch arg, so we verify HEAD is a dev/… branch here before letting it land.
const GIT_TIMEOUT = 15000;
function runGit(argv) {
  const r = spawnSync('git', argv, { cwd: REPO, shell: false, timeout: GIT_TIMEOUT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim(), err: r.error ? String(r.error.message || r.error) : null };
}
function currentBranchName() {
  const r = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return r.code === 0 ? r.stdout : null;
}
// DBR-P2-1 (DESIGN §3/§6) — one-time CONFIRM TOKENS for the W-gated converge ops (mergeSquash / commitMerge /
// branchDelete). The PANEL mints one via {type:'git-confirm'} ONLY after the human taps confirm in chat, then
// echoes it on the gated op; the host validates + CONSUMES it (single-use, short TTL). Claude can't reach this
// (its allowlist is git-free), so a gated op cannot run without a fresh human confirm routed through the panel.
const CONFIRM_TTL = 120000;                 // 2 min — a token is used immediately after the tap
const _confirmTokens = new Map();           // token → expiry (ms since epoch)
const GATED_GIT_OPS = new Set(['mergeSquash', 'commitMerge', 'branchDelete']);
function mintConfirmToken(msg) {
  const now = Date.now();
  for (const [t, exp] of _confirmTokens) if (exp < now) _confirmTokens.delete(t);   // opportunistic GC
  const token = crypto.randomBytes(18).toString('hex');
  _confirmTokens.set(token, now + CONFIRM_TTL);
  return { v: PROTOCOL_V, type: 'git-confirm-result', reqId: (msg && msg.reqId), token };   // DBR-P2-4 — echo reqId for panel correlation
}
function consumeConfirmToken(token) {
  if (typeof token !== 'string' || !_confirmTokens.has(token)) return false;
  const exp = _confirmTokens.get(token);
  _confirmTokens.delete(token);             // single-use — delete whether or not it had expired
  return exp >= Date.now();
}

function handleGit(msg) {
  const op = msg && msg.op;
  const params = (msg && msg.params) || {};
  const built = gitOps.buildGitArgs(op, params);
  const refuse = (error) => { log(`git: REFUSED ${op} — ${error}`); return { v: PROTOCOL_V, type: 'git-result', op, reqId: (msg && msg.reqId), ok: false, error }; };
  if (!built.ok) return { v: PROTOCOL_V, type: 'git-result', op, reqId: (msg && msg.reqId), ok: false, error: built.error };
  // ── write guards (current-branch). `commitWip`/`syncMain` may only run ON a dev/… branch (never main);
  //    the merge LAND (`mergeSquash`/`commitMerge`) may only run ON main (the panel switches there first). ──
  if (op === 'commitWip' || op === 'syncMain') {
    const cur = currentBranchName();
    if (!cur || !gitOps.validateBranchName(cur)) return refuse(`${op === 'syncMain' ? 'sync' : 'commit'}-guard: not on a dev branch`);
  }
  if (op === 'mergeSquash' || op === 'commitMerge') {
    if (currentBranchName() !== 'main') return refuse('merge-guard: not on main');
  }
  // ── confirm-token gate LAST (so a guard miss above doesn't burn the one-time token). ──
  if (GATED_GIT_OPS.has(op) && !consumeConfirmToken(params.confirmToken)) return refuse('confirm-required');
  const r = runGit(built.argv);
  const ok = r.code === 0 && !r.err;
  log(`DEVBR ▸ git ${op} [${built.argv.join(' ')}] → ${ok ? 'ok' : `FAIL(${r.code})`}${r.err ? ' ' + r.err : ''}`);
  // DBR-4 (v2.74.1036, DESIGN §4) — the panel flags the `lt` switch with params.lt so the live-test action gets
  // its own decision marker (the underlying git op also logs DEVBR ▸ above). LT ▸ is in _DECISION_RE (INVARIANT #1).
  if (op === 'switch' && params.lt) {
    log(`LT ▸ live-test → switch ${params.branch} → ${ok ? 'reloading' : `FAIL(${r.code})`}`);
  }
  // DBR-P2-1 (DESIGN §6/§7) — decision markers for the converge ops (all registered in _DECISION_RE, INVARIANT #1).
  if (op === 'syncMain')     log(`SYNC ▸ merge main into current branch → ${ok ? 'synced' : `FAIL(${r.code})`}`);
  if (op === 'mergeSquash')  log(`MERGE ▸ squash ${params.branch} onto main → ${ok ? 'staged' : `FAIL(${r.code})`}`);
  if (op === 'commitMerge')  log(`MERGE ▸ commit squash-merge on main → ${ok ? 'landed' : `FAIL(${r.code})`}`);
  if (op === 'branchDelete') log(`ABANDON ▸ delete branch ${params.branch} → ${ok ? 'deleted' : `FAIL(${r.code})`}`);
  return { v: PROTOCOL_V, type: 'git-result', op, reqId: (msg && msg.reqId), ok, code: r.code, stdout: r.stdout, ...(ok ? {} : { stderr: r.stderr, error: r.err || r.stderr || 'git failed' }) };
}

// DBR-P2-3 (DESIGN §6 step 3) — the merge TEST GATE: run `npm test` in the loaded tree (= the branch, post-sync).
// ASYNC spawn so it never blocks the host message loop; result via a reqId-correlated `test-result`. The command
// is FIXED (`npm test`, no params) → zero injection surface. Same cmd.exe wrapper as the claude run, but with
// piped capture (no journal) — and NO `detached` (the .cmd-shim stdout caveat, §startRun) so the pipes are live.
function runTest(msg) {
  const reqId = msg && msg.reqId;
  let child;
  try {
    child = spawn('cmd.exe', ['/d', '/s', '/c', 'npm', 'test'], { cwd: REPO, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    send({ v: PROTOCOL_V, type: 'test-result', reqId, ok: false, error: 'spawn-failed: ' + e.message });
    return;
  }
  let buf = '';
  const cap = (b) => { buf += b.toString(); if (buf.length > 65536) buf = buf.slice(-65536); };   // keep the tail
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  child.on('error', (e) => send({ v: PROTOCOL_V, type: 'test-result', reqId, ok: false, error: String((e && e.message) || e) }));
  child.on('close', (code) => {
    const tail = buf.split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
    log(`MERGE ▸ test gate → ${code === 0 ? 'PASS' : `FAIL(${code})`}`);
    send({ v: PROTOCOL_V, type: 'test-result', reqId, ok: code === 0, code, tail });
  });
}

// DB-3 (v2.74.992, spec §7.1) — PAUSE: kill the run's process tree but leave the session recoverable.
// The kill is the same forceful taskkill (Edit/Write are atomic between turns — a kill lands in the gap;
// the journal + git working tree always show exactly what landed). The session_id the run streamed is
// persisted in claude's own store, so `--resume <id>` (the panel's `dev: <redirect>`) continues it. Hence
// the honest framing is PAUSE, not abort — nothing the agent already wrote is lost. `cancel` is a kept
// alias for the same operation (older panel builds send it).
function pauseRun() {
  const l = activeLock();
  if (!l) return { v: PROTOCOL_V, type: 'status', active: false, cancelled: false };
  try { spawnSync(`taskkill /pid ${l.pid} /t /f`, { shell: true, timeout: 10000 }); } catch { /* */ }
  clearLock();
  log(`paused run pid=${l.pid} (session survives for --resume)`);
  return { v: PROTOCOL_V, type: 'status', active: false, cancelled: true };
}

// DB-2 (v2.74.988) — the manifest version, host-read, for the `bug:` prompt's version line (so a fix run
// records which build the report came from). Host-side read keeps the panel dumb; '?' if unreadable.
function repoVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(REPO, 'manifest.json'), 'utf8')).version || '?'; } catch { return '?'; }
}

// Sanitize a panel-supplied attachment filename: basename only, must look like an orchard trace, else a
// generated name. The host writes attachments ONLY into logs/run/.
function traceFileName(requested) {
  const base = path.basename(String(requested || ''));
  if (/^orchard-logs[A-Za-z0-9._-]*\.txt$/.test(base)) return base;
  if (/^orchard-chats[A-Za-z0-9._-]*\.txt$/.test(base)) return base;   // v2.74.1022 — `gch` ships chats
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
  // v2.74.1022 — gc (decisions) + gch (chats) join gl as trace-shipping verbs.
  if (verb !== 'gl' && verb !== 'gc' && verb !== 'gch' && verb !== 'dev' && verb !== 'bug') { send({ v: PROTOCOL_V, type: 'error', code: 'bad-verb' }); return; }
  // gl/gc/gch + bug ship a trace attachment — write it to logs/run/ once, here. v2.74.1022 — accept the
  // three attachment kinds (full-trace / decisions-trace / chats); pre-.1022 only decisions-trace existed.
  let traceRel = null;
  if (verb === 'gl' || verb === 'gc' || verb === 'gch' || verb === 'bug') {
    const att = Array.isArray(msg.attachments) ? msg.attachments[0] : null;
    if (att && typeof att.content === 'string' && (att.kind === 'full-trace' || att.kind === 'decisions-trace' || att.kind === 'chats')) {
      if (Buffer.byteLength(att.content, 'utf8') > MAX_ATTACHMENT) { send({ v: PROTOCOL_V, type: 'error', code: 'attachment-too-large' }); return; }
      const fname = traceFileName(att.filename);
      try { fs.writeFileSync(path.join(RUN_DIR, fname), att.content, 'utf8'); log(`${verb} attachment → logs/run/${fname}`); traceRel = `logs/run/${fname}`; }
      catch (e) { send({ v: PROTOCOL_V, type: 'error', code: 'attachment-write-failed', message: e.message }); return; }
    }
  }
  let prompt = null;
  if (verb === 'gl' || verb === 'gc' || verb === 'gch') {
    prompt = verb;   // the repo's standing convention does the rest (memory: read findings first, analyze newest, append one entry)
  } else if (verb === 'bug') {
    // DB-2 (v2.74.988) — `bug:` composes the user's report + a pointer to the trace just written + the
    // version line, then asks for a VERIFIED fix (the DB-2 allowlist now lets the run do `npm test`).
    // Still STDIN-fed — no user text on the command line, so the injection invariant is intact.
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text || text.length > 4000) { send({ v: PROTOCOL_V, type: 'error', code: 'bad-text' }); return; }
    const traceLine = traceRel ? `\n\nThe newest decisions trace is at ${traceRel} — read it first for the runtime story behind this report.` : '';
    prompt = `${text}${traceLine}\n\n(dev-bridge bug report · AHuB v${repoVersion()}. Diagnose the cause, apply a fix, then run the suite with \`npm test\` and confirm it is green before finishing. Do NOT commit — the human reviews the diff and runs cp/bcp.)`;
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
  // v2.74.1002 — a `relay` run loads the relay settings file (PreToolUse hook → panel approval) instead of
  // the static DB-2 allowlist. Both are host-built relative paths; no panel text on the command line.
  const settingsRel = msg.relay ? RELAY_SETTINGS_REL : SETTINGS_REL;
  // DBR-5 (v2.74.1037, DESIGN §8.2) — re-pass the dev conversation's scope contract on EVERY spawn (initial
  // AND --resume — the system prompt is rebuilt per-invocation, so without this the guardrail lapses after
  // turn 1). The concern is USER-DERIVED: concern.cjs sanitizes it to an inert single-line label, and it is
  // passed as a DISCRETE argv element (below), never concatenated into a command string.
  const contract = buildConcernContract(msg.concern);
  // Build claude's args as DISCRETE argv ELEMENTS, not one concatenated string. cmd.exe /d /s /c re-parses the
  // line, so a multi-word value packed into a single command string gets split on spaces with literal \"
  // fragments (the .988 --allowedTools mangling — verified); discrete elements survive intact AND remove all
  // host-side shell interpolation, which is what lets --append-system-prompt carry the (sanitized) concern
  // safely. The base tokens are space-free so splitting CLAUDE_CMD is safe; every appended value is host-
  // validated (settings path · clamped int · strict-UUID · frozen model id · sanitized concern).
  const claudeArgv = CLAUDE_CMD.split(' ').filter(Boolean);
  claudeArgv.push('--settings', settingsRel, '--max-turns', String(turns));
  claudeArgv.push('--mcp-config', MCP_CONFIG_REL);                   // DBR-P3-3b — expose the inert propose_split tool (relative to cwd=REPO)
  if (resumeFlag) claudeArgv.push('--resume', _sid);                 // _sid: strict-UUID validated above
  const _mf = modelFlag(msg.model).trim();                           // '--model <id>' (frozen table) or ''
  if (_mf) claudeArgv.push(..._mf.split(' '));
  if (contract) { claudeArgv.push('--append-system-prompt', contract); log(`CONCERN ▸ scope contract injected (${Buffer.byteLength(contract, 'utf8')}B)`); }
  let child;
  try {
    // cmd.exe /d /s /c claude … — args as DISCRETE elements (Node escapes each); the prompt still goes to
    // STDIN, never the command line. v2.74.974 — NO `detached`: on Windows, DETACHED_PROCESS gives cmd no
    // console and the .cmd-shim chain (claude.cmd → node) loses its redirected stdout ENTIRELY — the first
    // live gl run journaled 0 bytes and died as `host-lost` (flag matrix: plain ✓, windowsHide ✓, detached ✗).
    // Survival on port-close is therefore BEST-EFFORT (Windows children outlive parents unless Chrome's job
    // object says otherwise) — the DB-3 reattach slice owns making that a guarantee.
    child = spawn('cmd.exe', ['/d', '/s', '/c', ...claudeArgv], {
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
  // v2.74.1000 (DB-3 run history) — a per-run meta sidecar that OUTLIVES the lock (cleared on completion),
  // so `history` can show verb + prompt preview + model for past runs. The journal itself holds only
  // stream-json OUTPUT, never the prompt (fed via stdin), so the preview has to come from here.
  try { fs.writeFileSync(path.join(BRIDGE_DIR, `${ts}.meta.json`), JSON.stringify({ ts, verb, model: _modelId, maxTurns: turns, promptPreview: prompt.slice(0, 120), startedAt: ts, resumed: _resumed }, null, 2)); } catch { /* */ }
  log(`run started verb=${verb} model=${_modelId} maxTurns=${turns}${_resumed ? ` resume=${_resumed.slice(0, 8)}` : ''} pid=${child.pid} journal=${path.basename(journal)}`);
  send({ v: PROTOCOL_V, type: 'started', pid: child.pid, journal: path.basename(journal), startedAt: ts, model: _modelId, maxTurns: turns, resumed: _resumed });
  tailJournal(journal, child.pid);
}

// Poll-tail the journal, forwarding each stream-json line as an event frame. Poll (not fs.watch) — it is
// portable and the cadence is humane for a CLI run. Ends on the `result` line or child death.
// v2.74.999 (DB-3 reattach) — _tailing guards against streaming the same journal twice in ONE host: a
// status re-probe during a run this host already started must NOT spawn a second tail (would double every
// event). Reattach from a FRESH host is fine — that host isn't tailing the journal yet.
const _tailing = new Set();
function tailJournal(journal, pid) {
  if (_tailing.has(journal)) return;
  _tailing.add(journal);
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
          _tailing.delete(journal);
          log(`run done pid=${pid} (${ev.subtype || 'result'})`);
          send({ v: PROTOCOL_V, type: 'done', result: { subtype: ev.subtype ?? null, costUsd: ev.total_cost_usd ?? null, durationMs: ev.duration_ms ?? null, numTurns: ev.num_turns ?? null, sessionId: ev.session_id ?? null } });
          return;
        }
      }
    }
    if (!pidAlive(pid)) {
      clearInterval(timer);
      clearLock();
      _tailing.delete(journal);
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
    case 'status':    handleStatus(); break;
    case 'diffstat':  send(diffstatReply()); break;
    case 'pause':     send(pauseRun()); break;
    case 'cancel':    send(pauseRun()); break;   // back-compat alias (DB-3, v2.74.992)
    case 'history':   send(historyReply()); break;                 // DB-3 run history (v2.74.1000)
    case 'history-open': replayJournal(msg.journal); break;        // replay one journal read-only
    case 'approval-decision': writePermResp(msg); break;           // DB-3 permission relay (v2.74.1002)
    case 'git':       send(handleGit(msg)); break;                 // DBR-1 dev-branch git allowlist (§3)
    case 'git-confirm': send(mintConfirmToken(msg)); break;        // DBR-P2-1 — mint a one-time confirm token (§3/§6)
    case 'test':      runTest(msg); break;                         // DBR-P2-3 — the merge test gate (`npm test`, async)
    case 'run':       startRun(msg); break;
    default:          send({ v: PROTOCOL_V, type: 'error', code: 'unknown-type', got: msg.type });
  }
}

log(`host up (node ${process.version}, repo ${REPO})`);
