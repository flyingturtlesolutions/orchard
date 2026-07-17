// Services/Chat/devBridge.js — DB-1b (v2.74.973): the PANEL half of the dev bridge
// (docs/DESIGN_dev_bridge.md §3-§7, §11). One strippable module: everything dev-bridge in the panel
// lives here, behind the 'devBridge' setting + the OPTIONAL nativeMessaging permission, so the release
// posture (§11) is a configuration decision — drop this module + the optional permission and the
// feature never existed.
//
// TRUST RULES (§5), enforced here:
//   • Verbs are USER-TYPED only (`dev: on|off`, `dev: <ask>`, `gl`) — nothing composes or auto-sends a
//     bridge prompt; the module is unreachable from the ask pipeline when disabled.
//   • Everything the host streams back renders as PLAIN TEXT (never markdown/html) — a run's output can
//     echo page-derived strings, and this surface must not interpret them.
//   • The permission is requested ONLY on `dev: on`, first thing, while the user-gesture token is live.
//   • Commits stay human: the host's allowlist has no git; this module offers no such verb either.
//
// Protocol: versioned {v:N} envelopes (§11) — Chrome's native-messaging port does the framing.

import { ConversationStore, devResumeSession } from '../ConversationStore.js';   // v2.74.1022 `gch`; v2.74.1034 (DBR-2) per-conversation resume
import { createMergeLock } from './mergeLock.js';   // DBR-P4-6 (§7.2) — the merge land-only lock + FIFO queue
import { gcPlan, parseWorktreeList } from './worktreeGc.js';   // DBR-P4-7 (§9) — worktree GC: reconcile + actuate

// DBR-P4-2 (v2.74.1062, §10) — the v:2 run-multiplex protocol. MUST match bridge/protocol.cjs PROTO_V (the host's
// single source). It's duplicated here because the panel is browser ESM and can't `require` a `.cjs`. The cutover
// is HARD: a v:1 host's frames fail the `m.v === PROTOCOL_V` check below and are dropped — reload host + panel together.
const PROTOCOL_V = 2;
const HOST_NAME = 'com.orchard.devbridge';
const SETTING_KEY = 'settings:devBridge';
const MODEL_SETTING_KEY = 'settings:devBridgeModel';   // v2.74.976 — which model the bridge's claude runs as
const MODEL_ALIASES = ['default', 'fable', 'opus', 'sonnet', 'haiku'];   // MUST stay ⊆ the host's ALLOWED_MODELS table
const TURNS_SETTING_KEY = 'settings:devBridgeTurns';   // v2.74.978 — per-run --max-turns budget (the runaway guard)
const TURNS_DEFAULT = 25;   // v2.74.979 — the value when unset; NO artificial ceiling/floor (the host only checks it's a positive int)
const APPLIED_SIG_KEY = 'settings:devBridgeAppliedSig';   // v2.74.980 — the working-tree signature as of the last reload (the "applied" baseline)
const LAST_SESSION_KEY = 'settings:devBridgeLastSession';   // v2.74.985 — the prior run's claude session id; `dev:` resumes it (conversation by default)
const RELAY_SETTING_KEY = 'settings:devBridgeRelay';   // v2.74.1002 — DB-3 permission relay opt-in (PreToolUse hook → inline approve/deny)
const REVIEW_GATE_KEY = 'settings:devReviewGate';   // v2.74.1139 — surfaces-§4.3 review gate: auto-offer Review (Approve/Preview/Discard) on a dev run's done. Default ON (only `=== false` disables).

// The decisions filter — VERBATIM from studio.js _DECISION_RE (the source of truth; keep in sync until
// a shared extraction). Filters the session's log entries down to the signal-only story view that the
// gl convention prefers. v2.74.1022 — re-synced to studio.js (added FOCUS ▸ / CLARIFY ▸ / CLOSE_TABS ▸).
const DECISION_RE = /(▶ RUN |[✓✗] RUN |COMPREHEND_CROSS_GROUND ▸|T3X resolve ▸|T3X bind ▸|_bind ▸|GROUNDS ▸|ROUTE ▸|HANDOFF ▸|postcond ▸|ORCH_MATCH ▸|ORCH_MATCH_GLOBAL ▸|DETECT_DUPLICATE_GROUNDS ▸|MERGE_GROUNDS ▸|mergeGround |Ground saved:|Ground deleted:|→ (?:auto|propose|miss)\/|RUN_OBSERVATION|RUN_BEST_OBSERVATION|ORCH_RECORD_ALIAS|ORCH_ADMIN ▸|REPLAY_SG_CAPABILITY —|— bindings:|CLICK caused navigation|WALK ▸|LOOP ▸|ORCH_PLAN ▸|OPEN_URL_NEW_TAB —|REVERIFY_SG_CAPABILITY —|ROUTE_ASK "|bindClauseParams →|locale-fresh-skip|locale-trust:|EXPLORE_PAGE_STRUCTURE done|RUN_SG_TRIAL|INTERACTION_MONITOR_START|INTENT_MENU ▸|RICH_INTENTS ▸|ACCEPT_SG_TRIAL|INTERACTION_OUTCOMES ▸|proposeRichIntents —|ensureGroundForUrl|EXPLORE ▸|STOP ▸|FOCUS ▸|CLARIFY ▸|CLOSE_TABS ▸|DEVBR ▸|LT ▸|CONCERN ▸|TARGET ▸|INVOKE ▸|HEAL ▸|VITALS ▸|CONN ▸)/;

function _fmtEntry(entry) {
  const time = entry.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })
    : '—';
  let line = `${time} ${String(entry.level ?? '').padEnd(5)} ${String(entry.source ?? '').padEnd(20)} ${entry.message ?? ''}`;
  if (entry.data !== null && entry.data !== undefined) {
    try {
      const dataStr = typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data, null, 2);
      line += `\n  ${dataStr.replace(/\n/g, '\n  ')}`;
    } catch { /* skip */ }
  }
  return line;
}

function _stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// v2.74.1022 — chat transcript formatter for `gch` — mirrors studio.js formatConversationAsText.
function _fmtConv(conv) {
  const when = (ts) => ts ? new Date(ts).toLocaleString('en-US', { hour12: false }) : '—';
  const lines = [`# ${conv.title ?? 'Untitled'}`, `created ${when(conv.createdAt)} · updated ${when(conv.updatedAt)} · ${(conv.messages ?? []).length} message(s)`, ''];
  for (const m of (conv.messages ?? [])) {
    lines.push(`## ${String(m.role ?? '?')} — ${when(m.ts)}`);
    lines.push(String(m.body ?? ''));
    if (m.outcome && m.outcome.label) lines.push(`_outcome: ${m.outcome.label}${m.outcome.detail ? ' — ' + m.outcome.detail : ''}_`);
    lines.push('');
  }
  return lines.join('\n');
}

function _short(s, n = 60) { const t = String(s ?? ''); return t.length > n ? `…${t.slice(-(n - 1))}` : t; }

// DBR-4 (v2.74.1036, DESIGN §4) — the `lt` live-test verb matcher. PURE + exported for unit tests. Matches on
// the WHOLE trimmed message (case-insensitive, inner whitespace collapsed): only the bare tokens fire, so a
// longer sentence merely CONTAINING "live test" (e.g. "can you live test the search box?") is NOT a match and
// flows to Claude as a normal prompt. Whole-message-only is what makes the trigger safe (DESIGN §4, the `lt`
// keyword decision). The caller gates this on a dev conversation — non-dev conversations never intercept.
export function isLiveTest(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return t === 'lt' || t === 'live' || t === 'live test' || t === 'livetest';
}

// v2.74.1043 (DESIGN §4 guardrail) — the FORCE variant: a bare lt token with a trailing `!` or ` force`
// ("lt!", "lt force", "live test!", …). It means "switch anyway, past the behind-main warning" (single-tree
// `lt` reloads the WHOLE extension onto the branch, so a branch behind main reverts the panel itself — the
// default `lt` warns + refuses; this is the explicit override). Same whole-message discipline as isLiveTest:
// a sentence merely containing "force"/"!" does NOT match. PURE + exported for unit tests. Disjoint from
// isLiveTest (the bare tokens never carry the suffix), so the caller can OR the two safely.
export function isLiveTestForce(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const m = t.match(/^(.*?)\s*(?:!|force)$/);   // strip a trailing `!` or the word `force`
  if (!m) return false;
  const base = m[1].trim();
  return base === 'lt' || base === 'live' || base === 'live test' || base === 'livetest';
}

// DBR-P2-2 (DESIGN §5/§6.2) — the `sync` verb matcher: pull current `main` into THIS dev conversation's branch.
// Whole-message only (a sentence merely containing "sync" flows to Claude), dev-conversation gated by the
// caller — same discipline as isLiveTest. PURE + exported for unit tests.
export function isSync(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'sync';
}

// DBR-P2-2 (DESIGN §6.2) — classify a `syncMain` (merge main → branch) git result into the sub-flow outcome.
// PURE + exported. `clean` → proceed; `conflict` → §6.2 sub-flow (the auto-resolution run is P2-2b — for now we
// hand the conflicted files to the human); `error` → a non-conflict merge failure. Reads only the result envelope.
export function planSync(result) {
  const r = result || {};
  if (r.ok) return { status: 'clean', files: [], detail: '' };
  const out = `${r.stdout || ''}\n${r.stderr || ''}\n${r.error || ''}`;
  if (/conflict|automatic merge failed|fix conflicts|unmerged/i.test(out)) {
    const files = [];
    const re = /Merge conflict in (.+?)\s*$/gim;   // git: "CONFLICT (content): Merge conflict in <file>"
    let m; while ((m = re.exec(out))) { const f = m[1].trim(); if (f && !files.includes(f)) files.push(f); }
    return { status: 'conflict', files, detail: 'merge conflicts' };
  }
  return { status: 'error', files: [], detail: String(r.error || r.stderr || 'merge failed').split('\n')[0].slice(0, 200) };
}

// DBR-P2-3 (DESIGN §6) — the `merge` verb matcher (the PREPARE half: WIP → sync → test → diff; the squash-land
// is P2-4). Whole-message only, dev-conversation gated by the caller. PURE + exported.
export function isMerge(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'merge';
}

// DBR-P2-3 (DESIGN §6 steps 2–4) — PURE sequencing of the merge PREPARE half from each stage's outcome:
// sync (clean|conflict|error) → test gate (pass|fail, ONE retry — U14) → diff. A red-after-retry aborts BEFORE
// the diff (no merge). Returns where it stopped + whether it reached the diff (i.e. is ready to confirm-land).
export function planMergePrepare({ sync, test1, test2 } = {}) {
  if (sync !== 'clean') return { outcome: 'stopped', stoppedAt: 'sync', ranDiff: false, retried: false };
  if (test1 === 'pass') return { outcome: 'ready', stoppedAt: null, ranDiff: true, retried: false };
  if (test2 === 'pass') return { outcome: 'ready', stoppedAt: null, ranDiff: true, retried: true };   // green on the retry
  return { outcome: 'stopped', stoppedAt: 'test', ranDiff: false, retried: true };                     // still red → stop
}

// DBR-P2-4 fix (v2.74.1048; live-test) — a branch with NO changes vs main makes `git merge --squash` stage
// nothing, so the land's commit fails "nothing to commit". The prepare step must NOT offer to land an empty
// diff. PURE + exported: true iff the diff-stat has any content. (The diff-stat is empty exactly when there's
// nothing to merge.)
export function mergeHasChanges(diffStat) {
  return !!String(diffStat == null ? '' : diffStat).trim();
}

// DBR-P2-5 (DESIGN §7.2) — freshness: did `main` move since the branch synced onto it? PURE. Stale (→ re-sync +
// re-test before the land) when the synced-onto commit differs from the current `main` HEAD — OR when the
// synced-onto commit is unknown (can't confirm freshness → re-sync to be safe). If `main`'s HEAD can't be read
// at all, NOT stale (don't force a re-sync; the gated land's current=main + token guards still apply).
export function isMainStale(syncedMain, currentMain) {
  const b = String(currentMain == null ? '' : currentMain).trim();
  if (!b) return false;                                   // can't read current main → don't block
  return String(syncedMain == null ? '' : syncedMain).trim() !== b;
}

// DBR-P2-6 (DESIGN §5/U13) — abandon verbs. `abandon` = SOFT (archive the conversation, KEEP the branch —
// recoverable). `delete branch` = HARD (irreversible — gated branchDelete after an in-chat confirm). Whole-message
// only, dev-conversation gated by the caller. PURE + exported.
export function isAbandon(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'abandon';
}
export function isDeleteBranch(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'delete branch';
}

// DBR-P2-7 (DESIGN §5/§7) — the `drift` verb matcher (check this branch's overlap with main's recent changes).
// Whole-message only, dev-conversation gated by the caller. PURE + exported.
export function isDrift(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'drift';
}

// DBR-P2-7 (DESIGN §7.1) — a FOUNDATIONAL/SHARED file: lives in a shared layer (Core/, Services/) OR is imported
// by ≥ minImporters modules. PURE — the importer count comes from a (separate) static import scan; here it's the
// threshold logic + the cheap directory prior. Layers + threshold are config, not magic numbers in code.
export function isFoundationalFile(path, { layers = ['Core/', 'Services/'], minImporters = 3, importerCount = 0 } = {}) {
  const p = String(path == null ? '' : path).replace(/^\.?[\\/]/, '').replace(/\\/g, '/');
  if (layers.some((L) => p.startsWith(L))) return true;
  return (Number(importerCount) || 0) >= minImporters;
}

// DBR-P2-7 (DESIGN §7.1) — DRIFT = files that BOTH `main` (since the branch forked) and the branch modified — a
// `git diff --name-only` set-intersection. PURE: returns the branch's drifted files (deduped, in branch order).
export function computeDrift(mainFiles, branchFiles) {
  const inMain = new Set((Array.isArray(mainFiles) ? mainFiles : []).map((f) => String(f == null ? '' : f).trim()).filter(Boolean));
  const out = [];
  for (const f of (Array.isArray(branchFiles) ? branchFiles : [])) {
    const s = String(f == null ? '' : f).trim();
    if (s && inMain.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// DBR-P4-7 (DESIGN §7) — the post-merge cross-branch drift BROADCAST set. After a land moves `main` by `mergedFiles`,
// every OTHER live dev branch that ALSO touched any of those files has drifted and should be nudged to `sync`. PURE:
// composes computeDrift per branch; returns only the branches with non-empty drift, each with its drifted files +
// whether any are foundational (a stronger "definitely sync" nudge). `branches` is [{ convId, branch, files }] where
// `files` is that branch's own changes vs its merge-base. The caller excludes the just-merged branch + dead ones.
export function driftBroadcastSet(mergedFiles, branches, opts = {}) {
  const out = [];
  for (const b of (Array.isArray(branches) ? branches : [])) {
    if (!b || !b.branch) continue;
    const drift = computeDrift(mergedFiles, b.files);
    if (!drift.length) continue;
    out.push({
      convId: b.convId == null ? null : b.convId,
      branch: b.branch,
      drift,
      foundational: drift.some((f) => isFoundationalFile(f, opts)),
    });
  }
  return out;
}

// DBR-P4-5 (§10) — the PREVIEW worktree: a fixed DETACHED checkout (`.wt/preview`) Chrome loads (instead of the repo
// root) at cap>1, so `lt` can flip ANY branch's tip into view without disturbing the repo-root `main` OR a branch's
// own worktree (a detached checkout is legal even while that branch is checked out elsewhere — §4).
export const PREVIEW_WT = '.wt/preview';

// lt-target selection: the preview path is used ONLY under worktree mode (cap>1); at cap=1 `lt` keeps switching the
// repo root (legacy, unchanged). PURE.
export function ltUsesPreview(cap) { return Number(cap) > 1; }

// The ordered gitOps to (re-)point the preview worktree at `branch`'s tip: REMOVE the old detached checkout (if any),
// then ADD it back detached at the branch. PURE — returns op descriptors the panel runs in order; the remove is
// best-effort (`optional` — absent on first use). Returns null for a non-`dev/` branch (the preview only ever shows a
// dev branch's tip). Reuses the P4-1 worktree ops (gitOps validates the `.wt/`-scoped path + the ref) — no new host op.
export function previewRepointPlan(branch) {
  const b = String(branch == null ? '' : branch).trim();
  if (!/^dev\/[^\s]/.test(b)) return null;
  return [
    { op: 'worktreeRemove', params: { path: PREVIEW_WT, force: true }, optional: true },   // best-effort: nothing to remove on first use
    { op: 'worktreeAdd', params: { path: PREVIEW_WT, detach: b } },                          // re-create detached at the branch's tip
  ];
}

// DBR (regress, v2.74.1133) — the ordered gitOps to point the preview worktree at `main`'s tip (the post-`regress`
// home). `previewRepointPlan` is DEV-only by design (the preview shows a dev branch's tip), so reverting the live
// build to `main` needs its own un-gated plan. Same remove-then-detached-add shape. PURE.
export function previewToMainPlan() {
  return [
    { op: 'worktreeRemove', params: { path: PREVIEW_WT, force: true }, optional: true },
    { op: 'worktreeAdd', params: { path: PREVIEW_WT, detach: 'main' } },
  ];
}

// DBR-P3-1 (DESIGN §8.1) — the manual `split:` corrective verb: extract out-of-scope work into its own dev branch
// + conversation. Prefix form (`split: <concern>`) — unambiguous vs a coding task that merely mentions "split".
// PURE + exported.
export function isSplit(text) {
  return /^split:\s*\S/i.test(String(text == null ? '' : text).trim());
}

// DBR-P3-1 — a collision-resistant `dev/<slug>-<shortid>` branch name from a concern. PURE (the shortid is passed
// in — the caller mints it). Always `validateBranchName`-valid: starts alphanumeric, only [A-Za-z0-9._-].
export function splitSlug(concern, shortid) {
  const base = String(concern == null ? '' : concern).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '') || 'split';
  const sid = String(shortid == null ? '' : shortid).replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'x';
  return `dev/${base}-${sid}`;
}

// DBR-P3-1 (DESIGN §8.1) — the seed prompt for a split-out branch (the deterministic default; the `propose_split`
// tool lets Claude write a richer one in P3-3). Embeds the concern + a provenance line to the parent. PURE.
export function buildSeedPrompt({ concern, parentConcern } = {}) {
  const c = String(concern == null ? '' : concern).replace(/\s+/g, ' ').trim() || 'the split-out work';
  return parentConcern ? `${c}\n\n(Split out from: ${String(parentConcern).replace(/\s+/g, ' ').trim()}.)` : c;
}

// DBR-P3-5 (DESIGN §6.1/U12) — the `fork` verb (whole-message; dev-conversation gated by the caller). PURE + exported.
export function isFork(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'fork';
}

// DBR (regress, v2.74.1133) — the `regress` verb (whole-message; dev-conversation gated by the caller): abandon
// this conversation's change AND snap the live build back to `main` (preview → main + reload + archive). Distinct
// from `abandon`, which keeps the branch but leaves the preview where it is — `regress` is abandon + revert. PURE.
export function isRegress(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return t === 'regress' || t === 'discard';
}

// surfaces-§4.3 (the review gate) — the PURE predicate for "offer a Review card now". A dev RUN that finished
// successfully, on a still-open dev conversation (branch-backed, not merged/abandoned), that actually CHANGED files
// → surface Approve/Preview/Discard so the verbs become buttons at the right moment. Replay/paused runs and
// no-change / non-dev-conversation runs never offer (the signal/noise guard the findings flagged). PURE + tested.
export function shouldOfferReview({ ok, replay, pausing, conversationId, status, fileCount } = {}) {
  if (ok !== true) return false;                                   // a failed/ended run isn't a result to land
  if (replay === true || pausing === true) return false;          // a replay bubble isn't a run; a pause is resumable
  if (!conversationId) return false;                              // gl/replay/unbound run → not a reviewable task
  if (status === 'merged' || status === 'abandoned') return false; // archived conversation → nothing to land
  if (!(Number(fileCount) > 0)) return false;                    // the run changed nothing → no review
  return true;
}

// surfaces-§4.3 — parse `git status --porcelain=v1 --branch` stdout → the changed file paths. Drops the `## branch`
// header + blank lines; a rename "old -> new" reports the NEW path; surrounding quotes stripped. (Porcelain v1: two
// status chars + a space + the path, so the path starts at index 3 — same slice the host's diffstat uses.) PURE + tested.
export function parsePorcelainFiles(stdout) {
  const out = [];
  for (const raw of String(stdout == null ? '' : stdout).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.startsWith('##')) continue;
    let p = line.slice(3).trim();
    const arrow = p.indexOf(' -> ');
    if (arrow !== -1) p = p.slice(arrow + 4);
    p = p.replace(/^"|"$/g, '');
    if (p) out.push(p);
  }
  return out;
}

// surfaces-§4.4 — does a landed change touch HOST code (`bridge/`)? Panel code (chat.js, devBridge.js, studio.js…) is
// live on the preview reload, but the native host is a SEPARATE process: it exits on port-close (host.js stdin 'end'),
// and Chrome's native messaging spawns a FRESH host from repo-root `bridge/host.js` — which is on `main` post-land — on
// the next connect. So a `bridge/` land goes live automatically when the panel reopens; no respawn capability is needed.
// The auto-deploy uses this only to SURFACE that refresh (so it's legible, not silent). PURE + tested.
export function landTouchedHost(files) {
  return (Array.isArray(files) ? files : []).some((f) => /^bridge\//.test(String(f == null ? '' : f).trim()));
}

// keystone K3 (docs/DESIGN_surfaces.md §2.2/§8) — parse the `surface` verb that sets/shows THIS dev conversation's
// surface (the unified runtime's altitude): `surface` shows it; `surface high|low|design|dev` (or bare `design`) sets
// it. `design`→high, `dev`→low. Returns { show:true } | { set:'high'|'low' } | null (not a surface verb). PURE + tested.
// (The panel can't `require` the CJS registry — browser ESM — so the two ids live here too, in lockstep with surfaces.cjs.)
export function parseSurfaceVerb(text) {
  const t = String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (t === 'surface') return { show: true };
  const norm = (w) => (w === 'design' ? 'high' : w === 'dev' ? 'low' : w);
  const m = t.match(/^surface (high|low|design|dev)$/);
  if (m) return { set: norm(m[1]) };
  if (t === 'design') return { set: 'high' };
  return null;
}

// DBR-P3-5 (DESIGN §6.1) — the seed prompt for "fork from here": continue a (usually merged/abandoned) parent on a
// FRESH branch+conversation off `main`. Claude Code sessions are LINEAR (no fork-a-session primitive), so the seed
// carries the parent's concern + an optional summary + a continue cue as text; the new run starts a fresh session.
// PURE + exported.
export function buildForkSeedPrompt({ parentConcern, parentTitle, parentSummary } = {}) {
  const concern = String(parentConcern || parentTitle || '').replace(/\s+/g, ' ').trim();
  const summary = String(parentSummary == null ? '' : parentSummary).replace(/\s+/g, ' ').trim();
  const head = concern ? `Continue the work on: ${concern}.` : 'Continue from the previous dev conversation.';
  const ctx = summary ? `\n\nWhere it left off: ${summary}` : '';
  return `${head}${ctx}\n\n(Forked from a previous dev conversation — pick up from here.)`;
}

// DBR-P4 (post-dogfooding guardrail, §6.1) — a MERGED or ABANDONED conversation's branch is DONE: its work is on
// `main` (squash-landed) or dropped. Reusing it via `lt`/`sync`/`merge` is the exact trap that left a squash-merged
// branch reading "behind main" (the squash isn't in the branch's ancestry) and then chasing a phantom `sync` into a
// version conflict. So for an archived conversation, steer to `fork` (a fresh branch off the NEW main) instead of the
// misleading behind/on-main messages. Returns the steer text, or null when the conversation is still active. PURE.
export function archivedSteer(conv, verb = 'that') {
  const st = conv && conv.status;
  if (st === 'merged') {
    const at = conv.mergeCommit ? ` (as \`${String(conv.mergeCommit).slice(0, 7)}\`)` : '';
    return `✓ \`${verb}\` — this conversation is already **merged**${at}; its work is on \`main\`. A squash-merge leaves the old branch reading "behind main" by design, so don't \`${verb}\` it. To keep going, type \`fork\` (continues on a fresh branch off the new \`main\`) or start a new dev conversation.`;
  }
  if (st === 'abandoned') {
    return `✓ \`${verb}\` — this conversation was **abandoned**, so its branch is closed. To revive the work, type \`fork\` (a fresh branch off \`main\`) or start a new dev conversation.`;
  }
  return null;
}

// ── DBR-P3-2 (DESIGN §8/§8.1 layer 2) — the deterministic split BACKSTOP: no-LLM, always-on scope detection that
// "catches what Claude forgets to flag." Structural signals over a branch's changed-file set: a SPLIT-CLUSTER (the
// diff's import graph falls into ≥2 disconnected components — unrelated work bundled together) and a FOUNDATIONAL
// file edited ALONGSIDE leaf work (§7.1). All PURE; the live glue (`_scopeCheck`) feeds them the changed-file list
// (host `diffNames`) + an import map (panel-side `fetch` of the loaded tree — read-only, no host capability). A
// NUDGE, never a block. The SEMANTIC concern-creep check (an LLM second opinion) is P3-7 (`scope?`), layer 3.

// `scope` verb matcher — whole-message only, dev-conversation gated by the caller. (`scope?` is the P3-7 semantic
// variant — deliberately NOT matched here.) PURE + exported.
export function isScope(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'scope';
}

// scanImports — the module specifiers a JS/ESM/CJS source imports. PURE (text → specifiers). Covers static
// `import … from 'x'` / re-export `export … from 'x'`, side-effect `import 'x'`, dynamic `import('x')`, and CJS
// `require('x')`. A structural heuristic (not a parser) — good enough to build a changed-file import graph.
export function scanImports(text) {
  const src = String(text == null ? '' : text);
  const out = [];
  const push = (s) => { if (s && !out.includes(s)) out.push(s); };
  let m;
  const reFrom = /\bfrom\s*['"]([^'"]+)['"]/g;                       // import … from 'x' / export … from 'x'
  while ((m = reFrom.exec(src))) push(m[1]);
  const reCall = /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g; // import('x') / require('x')
  while ((m = reCall.exec(src))) push(m[1]);
  const reBare = /(?:^|[\n;])\s*import\s+['"]([^'"]+)['"]/g;          // side-effect import 'x'
  while ((m = reBare.exec(src))) push(m[1]);
  return out;
}

// resolveImport — a RELATIVE specifier (`./x`, `../y`) resolved against the importing file's dir → a repo-relative
// POSIX path. Bare/external specifiers (npm packages, absolute URLs) → null (not a repo file). PURE.
export function resolveImport(fromFile, spec) {
  const s = String(spec == null ? '' : spec);
  if (!/^\.\.?\//.test(s)) return null;
  const norm = String(fromFile == null ? '' : fromFile).replace(/\\/g, '/');
  const slash = norm.lastIndexOf('/');
  const parts = slash >= 0 ? norm.slice(0, slash).split('/').filter(Boolean) : [];
  for (const seg of s.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length) parts.pop(); continue; }
    parts.push(seg);
  }
  return parts.join('/');
}

// buildImportGraph — `{path: text}` → `{path: [repo-relative import targets]}` (relative imports only). PURE.
export function buildImportGraph(fileTexts) {
  const graph = {};
  for (const [path, text] of Object.entries(fileTexts || {})) {
    const targets = [];
    for (const spec of scanImports(text)) {
      const r = resolveImport(path, spec);
      if (r && !targets.includes(r)) targets.push(r);
    }
    graph[path] = targets;
  }
  return graph;
}

// splitClusters — partition the changed CODE files into import-connected components (undirected: an edge when one
// changed file imports another changed file). ≥2 components ⇒ the diff bundles import-disconnected work. PURE;
// deterministic (files + components sorted). `fileImports` is keyed by the importing file (changed-file → targets).
export function splitClusters(changedFiles, fileImports) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).filter((f) => typeof f === 'string' && f))].sort();
  const inSet = new Set(files);
  const parent = new Map(files.map((f) => [f, f]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const f of files) {
    for (const t of (fileImports && fileImports[f]) || []) { if (t !== f && inSet.has(t)) union(f, t); }
  }
  const groups = new Map();
  for (const f of files) { const r = find(f); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(f); }
  return [...groups.values()].map((g) => g.sort()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

// foundationalAlongsideLeaf — does the diff touch ≥1 foundational/shared file AND ≥1 leaf file? (Mixing surgery on
// shared code with leaf work is a split candidate — §7.1.) `isFoundational` is an injected predicate (the live
// glue passes `isFoundationalFile`); PURE here.
export function foundationalAlongsideLeaf(changedFiles, isFoundational) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).filter((f) => typeof f === 'string' && f))];
  const fn = typeof isFoundational === 'function' ? isFoundational : () => false;
  const foundational = files.filter((f) => { try { return !!fn(f); } catch { return false; } }).sort();
  const leaf = files.filter((f) => !foundational.includes(f)).sort();
  return { flagged: foundational.length >= 1 && leaf.length >= 1, foundational, leaf };
}

// assessSplit — combine the structural signals into a nudge decision. Split-cluster needs ≥2 import-disconnected
// components AND ≥ minFilesForCluster changed files (don't nag a 2-file branch). foundational-alongside-leaf runs
// over ALL changed files (path heuristic — no import data needed); split-cluster runs over the files we have import
// data for (`fileImports` keys). PURE.
export function assessSplit({ changedFiles = [], fileImports = {}, isFoundational = () => false, minFilesForCluster = 3 } = {}) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).filter((f) => typeof f === 'string' && f))];
  const codeFiles = files.filter((f) => Object.prototype.hasOwnProperty.call(fileImports || {}, f));
  const components = splitClusters(codeFiles, fileImports || {});
  const isCluster = components.length >= 2 && files.length >= minFilesForCluster;
  const fal = foundationalAlongsideLeaf(files, isFoundational);
  const reasons = [];
  if (isCluster) reasons.push('split-cluster');
  if (fal.flagged) reasons.push('foundational-alongside-leaf');
  return { shouldNudge: reasons.length > 0, reasons, components, foundational: fal.foundational, leaf: fal.leaf };
}

// buildSplitNudge — render the §8.1 nudge ("⚠ … consider `split:`"). Null when there's nothing to flag. PURE.
export function buildSplitNudge({ concern, reasons = [], components = [], foundational = [] } = {}) {
  const parts = [];
  if (reasons.includes('foundational-alongside-leaf') && foundational.length) {
    const names = foundational.slice(0, 3).map((f) => '`' + f + '`').join(', ');
    parts.push(`now edits ${names}${foundational.length > 3 ? ' …' : ''} (foundational/shared) alongside leaf work`);
  }
  if (reasons.includes('split-cluster') && components.length >= 2) {
    parts.push(`spans ${components.length} import-disconnected areas`);
  }
  if (!parts.length) return null;
  const c = concern ? ` (concern: \`${String(concern).replace(/\s+/g, ' ').trim().slice(0, 60)}\`)` : '';
  return `⚠ scope — this branch${c} ${parts.join('; ')}. Consider \`split: <the separable part>\` to keep it focused — a nudge, not a block (§8).`;
}

// ── DBR-P3-7 (DESIGN §8.1 layer 3) — the OPTIONAL semantic scope check: `scope?` asks the panel's LLM for a second
// opinion on scope creep (beyond P3-2's deterministic, no-LLM `scope`). On-demand + metered (one model call). The
// PROMPT builder + the VERDICT normalizer are PURE + tested; the model call is live-only (the panel LLM path).

// `scope?` verb matcher — whole-message; distinct from P3-2's bare `scope` (deterministic). PURE + exported.
export function isScopeSemantic(text) {
  return String(text ?? '').trim().toLowerCase().replace(/\s+/g, ' ') === 'scope?';
}

// buildScopeCheckPrompt — the {system, user} for the scope-creep call from a concern + the branch's diff (file list
// + diffstat). PURE; capped so a huge diff can't blow the prompt. The model replies JSON-only (normalized below).
export function buildScopeCheckPrompt({ concern, diffStat = '', changedFiles = [] } = {}) {
  const c = String(concern || '').replace(/\s+/g, ' ').trim() || '(no concern set)';
  const files = (Array.isArray(changedFiles) ? changedFiles : []).filter((f) => typeof f === 'string' && f).slice(0, 60).join('\n');
  const stat = String(diffStat || '').slice(0, 4000);
  const system = 'You are a code-review scope auditor. Given a branch\'s STATED CONCERN and its DIFF (changed-file list + diffstat), decide whether the branch has SCOPE CREEP — separable work outside the stated concern that belongs on its own branch. Be conservative: a focused branch is the norm; only flag genuinely separable work. Reply ONLY with JSON: {"creep":<bool>,"summary":"<one sentence>","suggestions":[{"concern":"<separable concern, imperative>","reason":"<why split>"}]}. Use an empty suggestions array when there is no creep.';
  const user = `STATED CONCERN: ${c}\n\nCHANGED FILES:\n${files || '(none)'}\n\nDIFFSTAT:\n${stat || '(none)'}`;
  return { system, user };
}

// normalizeScopeVerdict — coerce the model's reply (raw text with JSON, or an object) into a safe verdict shape.
// PURE; defends against malformed / prose-wrapped / partial output (the first {…} block is parsed).
export function normalizeScopeVerdict(raw) {
  let o = raw;
  if (typeof raw === 'string') { const m = raw.match(/\{[\s\S]*\}/); try { o = m ? JSON.parse(m[0]) : null; } catch { o = null; } }
  if (!o || typeof o !== 'object') return { creep: false, summary: '', suggestions: [] };
  const suggestions = (Array.isArray(o.suggestions) ? o.suggestions : [])
    .map((s) => ({ concern: String((s && s.concern) || '').replace(/\s+/g, ' ').trim(), reason: String((s && s.reason) || '').replace(/\s+/g, ' ').trim() }))
    .filter((s) => s.concern)
    .slice(0, 6);
  return { creep: !!o.creep, summary: String(o.summary || '').replace(/\s+/g, ' ').trim().slice(0, 280), suggestions };
}

// ── DBR-P3-3 (DESIGN §8.1/U5) — the `propose_split` typed-tool payload validator. Claude (the spawned `claude -p`)
// calls the proposal-only `propose_split` MCP tool (wired host-side in P3-3b); its `tool_use` block streams to the
// panel, which validates the input HERE — typed by construction, no prose parsing — and renders an approve/decline
// card. The tool NEVER mutates git/fs; the panel alone seeds the branch, on a human tap (§2.1/§3). PURE + exported.
// `{ ok:true, value }` for a well-formed proposal; `{ ok:false, error }` otherwise. The branch NAME is derived at
// seed time (`splitSlug`), so a junk `suggestedName` can't yield an invalid branch — but a malformed `branchBase`
// (not `main`, not a `dev/…` ref) is REJECTED: a split forks off `main` or the parent branch, never an arbitrary ref.
export function validateProposeSplit(input) {
  const o = input && typeof input === 'object' ? input : {};
  const concern = String(o.concern == null ? '' : o.concern).replace(/\s+/g, ' ').trim();
  if (!concern) return { ok: false, error: 'missing concern' };
  let branchBase = String(o.branchBase == null ? '' : o.branchBase).trim() || 'main';
  if (branchBase !== 'main' && !/^dev\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(branchBase)) return { ok: false, error: 'bad branchBase' };
  const reason = String(o.reason == null ? '' : o.reason).replace(/\s+/g, ' ').trim();
  const seedPrompt = String(o.seedPrompt == null ? '' : o.seedPrompt).trim();
  const suggestedName = String(o.suggestedName == null ? '' : o.suggestedName).replace(/\s+/g, ' ').trim();
  return { ok: true, value: { concern, reason, branchBase, seedPrompt, suggestedName } };
}

// DBR-P2-4 (DESIGN §6.1) — the merge-SUMMARY (deterministic v1; an LLM-rich {learned, newInvariant} can refine
// later). Subject ← the conversation's concern (its stated scope) or title; files ← the diff-stat lines. PURE.
export function buildMergeSummary({ concern, title, diffStat } = {}) {
  const subject = String(concern || title || 'merge dev branch').replace(/[\r\n]+/g, ' ').trim().slice(0, 72) || 'merge dev branch';
  const files = String(diffStat || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return { subject, files };
}

// DBR-P2-4 (DESIGN §6.1/§6.3) — the squash-merge COMMIT MESSAGE: subject + the changed-file list + an optional
// `Learned:` line + the `Dev-conversation:<id>` trailer (links the one squash commit back to the archived
// conversation, since the branch's WIP history is discarded). PURE — the host commits it verbatim (it's the one
// allowed `main` mutation). Newlines are intentional (multi-line message); NULs stripped, length capped.
export function buildMergeCommitMessage(summary, convId) {
  const s = summary || {};
  const subject = (s.subject && String(s.subject).replace(/[\r\n]+/g, ' ').trim()) || 'merge dev branch';
  const lines = [subject, ''];
  if (Array.isArray(s.files) && s.files.length) { lines.push('Changes:'); for (const f of s.files) lines.push('  ' + String(f).trim()); lines.push(''); }
  if (s.learned) lines.push('Learned: ' + String(s.learned).replace(/[\r\n]+/g, ' ').trim(), '');
  lines.push(`Dev-conversation:${String(convId || '').trim()}`);
  return lines.join('\n').replace(/\0/g, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000);
}

// v2.74.1099 — the dev-conversation drawer LABEL: a compact role/category derived from the conversation's scope
// (concern / first task), replacing the opaque session shortid. Information-dense yet short. Ordered keyword map,
// first match wins — specific DOMAINS/activities before generic ones, so "fix the UX layout" reads as UX (not Bug
// fix) and "add tests" as QA (not Feature). No keyword match → a compact summary of the scope. PURE (tested).
const _SCOPE_CATEGORIES = [
  [/\b(ux|ui|design|layout|css|styl|theme|visual|animation|responsive|spacing|colou?r|font|a11y|accessib|usabilit)/i, 'UX designer'],
  [/\b(tests?|testing|spec|coverage|\bqa\b|assert|harness|e2e|regression)/i, 'QA engineer'],
  [/\b(docs?|documentation|readme|comment|jsdoc|guide|tutorial|changelog)/i, 'Docs writer'],
  [/\b(security|auth|authenticat|authoriz|injection|\bxss\b|csrf|\bcsp\b|token|credential|permission|sanitiz|escap|vuln)/i, 'Security eng'],
  [/\b(aws|azure|\bgcp\b|\bcloud\b|lambda|\bs3\b|\bec2\b|dynamo|cloudformation|terraform|kubernetes|\bk8s\b|serverless|\binfra\b|infrastructure|cloudwatch|cognito|\biam\b|\becs\b|\beks\b|fargate)/i, 'Cloud Engineer'],   // v2.74.1101
  [/\b(perf|performance|optimi|latency|speed|faster|slow|memory|leak|throughput|cache|debounce|throttle)/i, 'Performance'],
  [/\b(database|schema|storage|indexeddb|sqlite|\bsql\b|migration|persist|\bdb\b)/i, 'Data engineer'],
  [/\b(backend|back-end|server|\bapi\b|endpoint|handler|service.?worker|background|webhook|\brpc\b)/i, 'Backend eng'],
  [/\b(frontend|front-end|react|vue|svelte|component|widget|\bdom\b|render|sidepanel|drawer|chat ui|panel ui)/i, 'Frontend eng'],
  [/\b(\bci\b|\bcd\b|deploy|pipeline|bundle|webpack|rollup|\bmanifest\b|release|\blint\b|docker|devops)/i, 'Build/DevOps'],
  [/\b(refactor|cleanup|clean.?up|rename|dedup|deduplicat|simplif|extract|consolidat|reorganiz|tidy)/i, 'Refactoring'],
  [/\b(fix|bug|broken|crash|regression|defect|fault|incorrect|fails?|failing|error)/i, 'Bug fix'],
  [/\b(add|implement|build|create|introduce|enable|support|new)\b/i, 'Feature dev'],
];
// v2.74.1101 — leading filler/stopwords stripped from the no-keyword fallback so a phrase like "lets work on aws"
// surfaces its MEANINGFUL term, not "Lets work on" (the reported bug). (The aws case now hits Cloud Engineer above;
// this hardens the tail for any other unmatched scope.)
const _SCOPE_STOP = new Set(['lets', 'let', 'please', 'can', 'could', 'would', 'you', 'your', 'i', 'im', 'we', 'our', 'should', 'shall', 'need', 'want', 'wanna', 'gonna', 'to', 'the', 'a', 'an', 'of', 'for', 'on', 'in', 'into', 'with', 'help', 'me', 'my', 'go', 'now', 'just', 'try', 'make', 'do', 'set', 'up', 'work', 'working', 'this', 'that', 'it', 'and', 'or', 'get', 'use', 'using', 'some', 'also', 'then', 'start', 'begin', 'continue']);
export function scopeCategory(text) {
  const t = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  for (const [re, label] of _SCOPE_CATEGORIES) if (re.test(t)) return label;
  // no keyword → a compact summary: drop leading filler/stopwords, surface the first meaningful term(s).
  const meaningful = t.split(' ').filter((w) => { const k = w.toLowerCase().replace(/[^a-z0-9]/g, ''); return k && !_SCOPE_STOP.has(k); });
  const picked = (meaningful.length ? meaningful : t.split(' ')).slice(0, 2).join(' ');
  const compact = picked.length > 22 ? picked.slice(0, 21).replace(/\s\S*$/, '') + '…' : picked;
  return compact ? compact.charAt(0).toUpperCase() + compact.slice(1) : 'Dev task';
}

/**
 * Factory — chat.js hands in its rendering helpers (avoids any import cycle into the panel).
 * @param {{appendMessage: Function, setMessageBody: Function, mkBtn: Function, persistMessage?: Function, decorateBubble?: Function, renderMarkdown?: Function, wireCodeCopyButtons?: Function}} deps
 */
export function createDevBridge({ appendMessage, setMessageBody, mkBtn, persistMessage, decorateBubble, renderMarkdown, wireCodeCopyButtons, getScrollContainer, refreshHistory, currentConversationId, scopeCheckLLM, categorizeScopeLLM }) {
  let port = null;
  let run = null;   // { msgEl, lines: string[], bar: Element|null, sessionId: string|null }
  let _lastPool = null;   // DBR-P4-3b (§10) — the latest run-pool snapshot {running:[{runId,pid}], cap} from the host; P4-4 renders it.
  const runs = new Map();   // DBR-P4-3b step 5 (§10) — runId → run handle. At cap=1 it holds ≤1 (= `run`, the foreground); the frame handler demuxes by runId so a cap>1 background run streams into ITS bubble, not the foreground.
  const _lastRunOutcome = new Map();   // v2.74.1096 — conversationId → { ok, at }: the last COMPLETED run's outcome, so the drawer can show "✓ done" / "✗ failed". Cleared when a new run starts or the conversation is opened (in-memory; a reload starts clean).

  // DBR-P4-6 (§7.2) — the single in-panel merge LAND lock. Prepare (sync+test+confirm) runs lock-free; only the
  // land step (switch main → squash → commit) holds it, so concurrent lands queue FIFO + each re-checks freshness
  // against the `main` the one ahead produced. At cap=1 / one land at a time, acquire is immediate (no behavior change).
  const _mergeLock = createMergeLock();
  function _ordinal(n) { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`; }

  // DBR-P4-4 (§10) — concurrent-dispatch bookkeeping. The host's `preflight`/`started` frames carry NO runId (the
  // host mints the runId only at spawn), so the panel correlates them to the right run handle by ARRIVAL ORDER:
  // the native-messaging port preserves message order, so the Nth `preflight`-ok answers the Nth dispatch, and the
  // Nth `started` the Nth posted payload. These two FIFO queues hold the in-flight handles between those hops. At
  // cap=1 each holds ≤1 entry, so every shift() returns the one foreground `run` — byte-identical to the old
  // `run.pendingPayload` path. The cap comes from the host's `pool` snapshot (`_lastPool`), default 1.
  const _pendingPreflight = [];   // dispatched → awaiting preflight-ok
  const _pendingStarted = [];     // payload posted → awaiting `started`
  const _capNow = () => Math.max(1, (_lastPool && _lastPool.cap) || 1);
  const _activeRuns = () => runs.size + _pendingPreflight.length + _pendingStarted.length;
  const _canDispatch = () => _activeRuns() < _capNow();
  const _liveForConv = (cid) => cid != null && [...runs.values(), ..._pendingPreflight, ..._pendingStarted].some((r) => r && r.conversationId === cid);

  // DB-2 (v2.74.975) — reload-icon state (spec §5). The header icon (owned by chat.js) subscribes via
  // onReloadState; we push it `enabled` (dev mode on/off → show/hide) and `available` (changes are PENDING
  // a reload → light the dot).
  //
  // v2.74.980 fix — `available` means "changed SINCE the last reload", not "tree is dirty". The original
  // code lit the dot from `files.length > 0`, on the (wrong) assumption that a reload would reset it: but
  // a reload doesn't commit, so the tree stays dirty and onReloadState's startup diffstat re-arms the dot
  // immediately — the icon looked identical before and after a reload and never cleared. The fix gates the
  // dot on `sig !== appliedSig`, where `appliedSig` (persisted) is the tree signature stamped at the last
  // reload. After a reload the post-reload signature matches the baseline → dot clears; the next edit
  // changes the signature → dot re-arms. `sig` is carried in state so reloadExtension can stamp it.
  let reloadListener = null;
  let reloadState = { enabled: false, available: false, files: [], sig: '' };
  function emitReload(patch) {
    reloadState = { ...reloadState, ...patch };
    try { reloadListener?.({ ...reloadState }); } catch { /* a UI throw must not break the bridge */ }
  }

  const getEnabled = async () => {
    try { return (await chrome.storage.local.get(SETTING_KEY))[SETTING_KEY] === true; } catch { return false; }
  };
  const setEnabled = async (v) => { try { await chrome.storage.local.set({ [SETTING_KEY]: v === true }); } catch { /* */ } };
  // v2.74.976 — the bridge model preference (an ALIAS; the host maps it to a real id via its own
  // allowlist — the panel never sends a model NAME, so there is no command-line surface here either).
  const getModel = async () => {
    try { const v = (await chrome.storage.local.get(MODEL_SETTING_KEY))[MODEL_SETTING_KEY]; return MODEL_ALIASES.includes(v) ? v : 'default'; } catch { return 'default'; }
  };
  const setModel = async (v) => { try { await chrome.storage.local.set({ [MODEL_SETTING_KEY]: v }); } catch { /* */ } };
  // v2.74.978 — the per-run turn budget. Any positive integer; the default applies only when unset/invalid.
  const getTurns = async () => {
    try { const v = Math.floor(Number((await chrome.storage.local.get(TURNS_SETTING_KEY))[TURNS_SETTING_KEY])); return (Number.isFinite(v) && v >= 1) ? v : TURNS_DEFAULT; } catch { return TURNS_DEFAULT; }
  };
  const setTurns = async (n) => { try { await chrome.storage.local.set({ [TURNS_SETTING_KEY]: n }); } catch { /* */ } };
  // v2.74.1002 — DB-3 permission relay opt-in. When on, runs load the relay settings file (PreToolUse hook
  // → the panel approves/denies each non-safe tool); when off, the proven DB-2 static allowlist is used.
  const getRelay = async () => { try { return (await chrome.storage.local.get(RELAY_SETTING_KEY))[RELAY_SETTING_KEY] === true; } catch { return false; } };
  // surfaces-§4.3 — the review gate is ON unless explicitly disabled (`settings:devReviewGate === false`), so a fresh
  // install gets the contextual Approve/Preview/Discard offer; a user who finds it noisy can switch it off in storage.
  const getReviewGate = async () => { try { return (await chrome.storage.local.get(REVIEW_GATE_KEY))[REVIEW_GATE_KEY] !== false; } catch { return true; } };
  const setRelay = async (v) => { try { await chrome.storage.local.set({ [RELAY_SETTING_KEY]: v === true }); } catch { /* */ } };
  // v2.74.985 — the last run's session id, so `dev:` CONTINUES the conversation by default. Persisted so
  // it survives a panel close. `dev: new` / `dev: reset` clear it to start a fresh thread.
  const getLastSession = async () => {
    try { const v = (await chrome.storage.local.get(LAST_SESSION_KEY))[LAST_SESSION_KEY]; return /^[0-9a-f-]{36}$/i.test(v) ? v : null; } catch { return null; }
  };
  const setLastSession = async (s) => { try { await chrome.storage.local.set({ [LAST_SESSION_KEY]: String(s ?? '') }); } catch { /* */ } };
  const clearLastSession = async () => { try { await chrome.storage.local.remove(LAST_SESSION_KEY); } catch { /* */ } };
  // v2.74.1034 (DBR-2) — the resume target for a dev conversation is its OWN session (per-conversation), via
  // devResumeSession on the conversation record; falls back to null if the conversation/session is gone.
  const _convResume = async (id) => { try { return devResumeSession(await ConversationStore.load(id)); } catch { return null; } };
  // DBR-5 (v2.74.1037, DESIGN §8.2) — trim an ask to a one-line concern LABEL (collapse whitespace, cap length).
  const _conciseConcern = (ask) => String(ask ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  // DBR-5 fix (v2.74.1038) — a QUESTION/STATUS ask ("is the build complete?", "what's left?") is a query, not a
  // scope of work. Defaulting a concern from one pins the conversation to "assess", and since the host re-injects
  // that concern as a "work ONLY on …" guardrail on EVERY spawn, it then OVERRIDES later BUILD asks — the
  // dev-bridge looped on itself, re-reporting "DBR-6 not built" and never building it (even on an explicit "yes").
  // So an interrogative first ask does NOT seed a concern: the run stays unconstrained (pre-DBR-5 behaviour) until
  // a real task or an explicit `dev: concern <scope>`. A false-skip is safe — it just means no scope guardrail for
  // that run. See logs/run/findings.md.
  const _looksLikeQuestion = (ask) => {
    const s = String(ask ?? '').trim();
    return /\?\s*$/.test(s)
      || /^(is|are|was|were|do|does|did|can|could|should|would|will|has|have|what|which|who|whose|when|where|why|how)\b/i.test(s);
  };
  // DBR-5 — the concern DEFAULTS to the first real (non-question) ask. Capture it on the dev conversation once
  // (never overwrite an existing/edited concern), and return the EFFECTIVE concern for THIS spawn so the run
  // payload carries it. Pass `ask` for a real task (sets it if unset & not a question); null just reads it.
  // The host builds the scope contract from this and re-injects on every spawn (initial + resume).
  const _ensureConcern = async (id, ask = null) => {
    if (!id) return null;
    try {
      const conv = await ConversationStore.load(id);
      if (!conv || conv.kind !== 'dev') return null;
      let concern = typeof conv.concern === 'string' ? conv.concern.trim() : '';
      if (!concern && ask && !_looksLikeQuestion(ask)) {
        concern = _conciseConcern(ask);
        if (concern) await ConversationStore.patchMeta(id, { concern }).catch(() => { /* */ });
      }
      if (concern) {
        _applyScopeTitle(conv, concern);                      // v2.74.1099 — instant keyword label (fallback / pre-LLM)
        if (!conv.titledByLlm) _llmCategorize(id, concern);   // v2.74.1102 — then have Claude pick the role (once per conversation; overrides)
      }
      return concern || null;
    } catch { return null; }
  };
  // v2.74.1099 — the dev-conversation drawer LABEL = its scope category (scopeCategory of the concern), replacing the
  // session shortid. INSTANT keyword fallback; skipped once Claude has set the label (`titledByLlm`) so it can't clobber
  // the LLM result. Sets only when it differs (no rewrite every dispatch). Best-effort.
  function _applyScopeTitle(conv, scopeText) {
    if (!conv || conv.kind !== 'dev' || conv.titledByLlm) return;
    const category = scopeCategory(scopeText);
    if (!category || conv.title === category) return;
    ConversationStore.patchMeta(conv.id, { title: category })
      .then(() => { try { refreshHistory && refreshHistory(); } catch { /* */ } })
      .catch(() => { /* */ });
  }
  // v2.74.1102 — have CLAUDE (not the keyword map) pick the role label: one tiny structured call (background
  // DEV_CATEGORIZE_SCOPE → AnthropicService). On success it OVERRIDES the keyword label + marks `titledByLlm` so it
  // runs once per conversation and the keyword can't clobber it. No-op without the LLM dep / API key (keyword stands).
  const _sanitizeRole = (r) => String(r == null ? '' : r).replace(/[\r\n]+/g, ' ').replace(/[^\w /+&.-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 28);
  async function _llmCategorize(id, scopeText) {
    if (typeof categorizeScopeLLM !== 'function' || !id || !scopeText) return;
    let res; try { res = await categorizeScopeLLM({ scope: scopeText }); } catch { return; }
    const role = _sanitizeRole(res && res.success && res.role);
    if (!role) return;
    try {
      const conv = await ConversationStore.load(id);
      if (!conv || conv.kind !== 'dev' || conv.title === role) { if (conv && conv.kind === 'dev' && !conv.titledByLlm) ConversationStore.patchMeta(id, { titledByLlm: true }).catch(() => { /* */ }); return; }
      await ConversationStore.patchMeta(id, { title: role, titledByLlm: true });
      try { refreshHistory && refreshHistory(); } catch { /* */ }
    } catch { /* */ }
  }
  // v2.74.980 — the working-tree signature stamped at the last reload (the "applied" baseline). Persisted
  // so it survives the chrome.runtime.reload() that the reload icon triggers — that survival is the whole
  // point: the post-reload diffstat compares against it to decide whether anything is still pending.
  const getAppliedSig = async () => {
    try { const v = (await chrome.storage.local.get(APPLIED_SIG_KEY))[APPLIED_SIG_KEY]; return typeof v === 'string' ? v : ''; } catch { return ''; }
  };
  const setAppliedSig = async (s) => { try { await chrome.storage.local.set({ [APPLIED_SIG_KEY]: String(s ?? '') }); } catch { /* */ } };

  // ── Run-follow scroll (v2.74.995) ────────────────────────────────────────────────────────────────
  // The chat's near-bottom heuristic (96px) breaks for the bridge: a single streamed block (a long
  // text / tool / thinking block) is routinely TALLER than that, so right after one big block the view
  // is no longer "near bottom" and following silently stops — which is why auto-scroll appeared dead.
  // Instead we keep our own follow flag: it stays true while the view sits at the bottom and only flips
  // off when the USER scrolls up; on every streamed block we re-anchor the run footer (the working…/
  // Pause line, which is the last element in the bubble) into view by pinning the scroll to the bottom.
  let _follow = true;
  let _scrollWired = false;
  const _scroller = () => { try { return getScrollContainer ? getScrollContainer() : null; } catch { return null; } };
  const _atBottom = (c) => !c || (c.scrollHeight - c.scrollTop - c.clientHeight) <= 140;
  function _wireFollow() {
    if (_scrollWired) return;
    const c = _scroller();
    if (!c) return;
    _scrollWired = true;
    // A user scroll recomputes follow; a programmatic scroll-to-bottom lands at the bottom so follow
    // stays true (no feedback loop). Appending a block does NOT fire 'scroll', so big blocks can't flip it.
    c.addEventListener('scroll', () => { _follow = _atBottom(c); }, { passive: true });
  }
  function _anchor() {
    if (!_follow) return;
    const c = _scroller();
    if (c) c.scrollTop = c.scrollHeight;   // footer bar is the last child → pins working…/Pause at the bottom
  }

  // DBR-P4-4 step 5 (§10) — the multi-run RUNNING-BAR. A sticky strip at the top of the thread that, at cap>1, names
  // how many dev runs are in flight against the slot cap — the one cross-conversation signal a per-bubble footer
  // can't give (each bubble only knows its own run; a background run in ANOTHER conversation is otherwise invisible).
  // DEAD at cap=1: the bar only renders when cap>1 AND ≥1 run is active, so the default single-run panel is unchanged
  // (no element is ever created). Counts `_activeRuns()` (dispatched + started across all conversations), refreshed
  // on every run start/end and on each host `pool` snapshot. Best-effort + cosmetic — wrapped so it never throws.
  let _runBarEl = null;
  function _renderRunningBar() {
    try {
      const cap = _capNow();
      const active = _activeRuns();
      if (cap <= 1 || active <= 0) { if (_runBarEl) _runBarEl.style.display = 'none'; return; }
      const c = _scroller();
      if (!c) return;
      if (!_runBarEl) {
        _runBarEl = document.createElement('div');
        _runBarEl.className = 'dev-running-bar';
        _runBarEl.dataset.devBridge = '1';
        // Inline so it works without a CSS change; position:sticky pins it at the top of the scrolling thread.
        _runBarEl.style.cssText = 'position:sticky;top:0;z-index:5;padding:4px 10px;margin:0 0 6px;font-size:12px;font-weight:600;color:#c9a227;background:rgba(201,162,39,0.12);border:1px solid rgba(201,162,39,0.35);border-radius:6px;';
      }
      if (_runBarEl.parentNode !== c) { try { c.insertBefore(_runBarEl, c.firstChild); } catch { /* */ } }
      _runBarEl.style.display = '';
      _runBarEl.textContent = `▶ ${active} dev run${active === 1 ? '' : 's'} running · ${cap} slots`;
    } catch { /* */ }
  }

  // ── Rich rendering (v2.74.993) — mirror Claude Code's desktop formatting ──────────────────────────
  // Each stream event becomes a styled BLOCK in the bubble's .message-body, instead of the old plain-text
  // line dump: assistant prose → markdown (code fences, lists, bold — via the SAME injection-safe
  // renderMarkdown the chat uses; it HTML-escapes first, so a run echoing page-derived strings still
  // can't inject), tool calls → compact chips (glyph · name · arg), thinking → a dim aside, run meta →
  // subtle lines, the result → a footer. Persistence serializes the blocks back to markdown (stored with
  // { markdown:true, devBridge:true }) so a reloaded run re-renders with the same look via the existing
  // pm.markdown rehydrate branch. The on-disk journal stays the full record; the bubble caps its history.
  const MAX_BLOCKS = 80;
  const TOOL_GLYPH = { Read: '▤', Edit: '✎', MultiEdit: '✎', Write: '✎', NotebookEdit: '✎', Bash: '▶', Grep: '⌕', Glob: '⌕', Task: '⛬', WebFetch: '⤓', WebSearch: '⌕' };
  const _glyph = (name) => TOOL_GLYPH[name] || '▸';

  function _blockNode(b) {
    const el = document.createElement('div');
    el.className = `dev-blk dev-blk-${b.kind}`;
    if (b.kind === 'text') {
      el.innerHTML = renderMarkdown ? renderMarkdown(b.text || '') : '';
      if (!renderMarkdown) el.textContent = b.text || '';   // defensive: no renderer injected
      try { wireCodeCopyButtons?.(el); } catch { /* */ }
    } else if (b.kind === 'tool') {
      const g = document.createElement('span'); g.className = 'dev-tool-icon'; g.textContent = _glyph(b.name);
      const n = document.createElement('span'); n.className = 'dev-tool-name'; n.textContent = b.name || 'tool';
      el.appendChild(g); el.appendChild(n);
      if (b.arg) { const a = document.createElement('span'); a.className = 'dev-tool-arg'; a.textContent = b.arg; el.appendChild(a); }
    } else if (b.kind === 'result') {
      el.classList.add(b.ok ? 'ok' : 'err');
      el.textContent = b.text || '';
    } else {            // meta · thinking — plain text, styled dim
      el.textContent = b.text || '';
    }
    return el;
  }

  // Serialize blocks → markdown for persistence (tool chips become inline-code; meta/thinking dim italic).
  function _blocksToMarkdown(blocks) {
    return (blocks || []).map((b) => {
      if (b.kind === 'text') return b.text || '';
      if (b.kind === 'tool') return '`' + _glyph(b.name) + ' ' + (b.name || 'tool') + '`' + (b.arg ? ' `' + b.arg + '`' : '');
      if (b.kind === 'result') return '**' + (b.text || '') + '**';
      return '_' + (b.text || '') + '_';   // meta · thinking
    }).map((s) => String(s).trim()).filter(Boolean).join('\n\n');
  }

  // v2.74.1035 (DBR-3, DESIGN §9) — `conversationId` PINS the write to the run's originating dev conversation.
  // A run streams over time; if the user switches conversations mid-run, the unpinned path persisted its blocks
  // into whatever was active (the leak). Run-path callers pass run.conversationId; standalone bubbles (created
  // synchronously in the active conversation) omit it and use the active conversation.
  function _persistBlocks(msg, blocks, conversationId = null) {
    if (!persistMessage) return;
    const fields = { role: 'assistant', body: _blocksToMarkdown(blocks), markdown: true, devBridge: true };
    if (conversationId) fields.conversationId = conversationId;
    try { persistMessage(msg, fields)?.catch?.(() => { /* */ }); } catch { /* */ }
  }

  // Create a dev bubble. `initial` (if any) renders as a markdown text block. Returns the handle the run
  // streams into; standalone status/error bubbles just use it once.
  function devBubble(initial, { persist = true } = {}) {
    const msg = appendMessage({ role: 'assistant', body: '' });
    const bodyEl = msg.querySelector('.message-body');
    // .md-rendered on the body makes the chat's markdown CSS apply to the text blocks rendered inside it.
    if (bodyEl) { bodyEl.textContent = ''; bodyEl.classList.add('md-rendered'); }
    // v2.74.990 — shared decorator: amber identity + the collapse header. Live bubbles start expanded
    // (you watch them stream); rehydrate is what collapses long past runs. Falls back to the inline
    // amber border if no decorator was injected (older host wiring).
    if (decorateBubble) decorateBubble(msg, { collapsed: false });
    else { try { msg.style.borderLeft = '3px solid #c9a227'; msg.dataset.devBridge = '1'; } catch { /* */ } }
    const blocks = [];
    if (initial) { const b = { kind: 'text', text: initial }; blocks.push(b); bodyEl?.appendChild(_blockNode(b)); }
    if (persist) _persistBlocks(msg, blocks);   // v2.74.1000 — history replay bubbles are transient (not persisted)
    try { _anchor(); } catch { /* */ }   // v2.74.995 — keep the new bubble's tail in view
    return { msg, bodyEl, blocks };
  }

  // Append a streamed block to the active run. Caps the rendered history (journal on disk is the full record).
  const _PERSIST_THROTTLE_MS = 2000;
  // DBR-P4-3b step 5 — render a streamed block into a run's bubble. `rh` defaults to the FOREGROUND run, so every
  // existing caller is unchanged (cap=1 identical); the frame handler passes a specific `rh` to demux a cap>1
  // background run into its own bubble.
  function _emit(b, rh = run) {
    if (!rh || !rh.bodyEl) return;
    rh.blocks.push(b);
    // v2.74.1093 — a BACKGROUNDED run (its conversation isn't the one on screen) has a DETACHED bubble after a
    // conversation switch wiped #messages. Keep accumulating blocks (+ persist below) but skip the DOM work; the
    // re-attach on switch-back re-renders rh.blocks into a fresh bubble. Attached (the normal/foreground case) is
    // unchanged → cap=1 byte-identical.
    const _attached = rh.bodyEl.isConnected;
    if (_attached) rh.bodyEl.appendChild(_blockNode(b));
    while (rh.blocks.length > MAX_BLOCKS) {
      rh.blocks.shift();
      if (_attached && rh.bodyEl.firstChild) rh.bodyEl.removeChild(rh.bodyEl.firstChild);
    }
    // v2.74.999 (DB-3) — persist a snapshot AS the run streams (throttled), not only at endRun. The
    // child does NOT survive a panel close / extension reload on Windows (verified — see findings), so
    // live-reattach can't continue a run; instead a mid-run close now leaves a useful PARTIAL transcript
    // in the conversation (rehydrated on reopen), and `dev:` resumes the session from there. Throttled so
    // a fast run doesn't hammer chrome.storage; endRun still does the final, complete persist.
    const now = Date.now();
    if (!rh.replay && (!rh._lastPersist || (now - rh._lastPersist) >= _PERSIST_THROTTLE_MS)) {
      rh._lastPersist = now;
      _persistBlocks(rh.msg, rh.blocks, rh.conversationId);   // v2.74.1035 (DBR-3) — pin to the originating conversation
    }
    // v2.74.995 — re-anchor the run footer (working…/Pause) so the latest block stays in view, unless
    // the user has scrolled up. Block-size-agnostic (unlike the chat's 96px near-bottom heuristic).
    if (_attached) { try { _anchor(); } catch { /* */ } }
  }

  // End the run. `final` may be a block object or a string (→ an error result block).
  function endRun(final, rh = run) {
    if (!rh) return;
    // v2.74.1096/.1098 — record the last-run OUTCOME for the drawer status: paused / done / failed. A PAUSED run
    // (Pause button or delete-cancel — rh.pausing) is resumable, not a completion; a REPLAY bubble isn't a run; a
    // string `final` is always an error. Cleared when a new run starts or the conversation is opened.
    if (rh.conversationId && !rh.replay) {
      const kind = rh.pausing ? 'paused'
        : (final ? (((typeof final === 'object') ? (final.ok !== false) : false) ? 'done' : 'failed') : null);
      if (kind) _lastRunOutcome.set(rh.conversationId, { kind, at: Date.now() });
    }
    if (rh.tick) { try { clearInterval(rh.tick); } catch { /* */ } rh.tick = null; }   // v2.74.989 — stop the elapsed ticker
    if (final) _emit(typeof final === 'string' ? { kind: 'result', ok: false, text: final } : final, rh);
    try { rh.bar?.remove(); } catch { /* */ }
    if (!rh.replay) _persistBlocks(rh.msg, rh.blocks, rh.conversationId);   // v2.74.987/.993 terminal blocks; .1035 pinned
    if (rh.runId) runs.delete(rh.runId);   // DBR-P4-3b step 5 — drop from the run registry
    // DBR-P4-4 — purge from the dispatch FIFOs too: a run that ends mid-handshake (host died after preflight-ok but
    // before `started`, or an unreachable-host dispatch) must NOT linger and get shift()'d as a LATER run's handle.
    // No-op in the normal flow (the run is shifted out of both queues before it ends).
    const _ip = _pendingPreflight.indexOf(rh); if (_ip >= 0) _pendingPreflight.splice(_ip, 1);
    const _is = _pendingStarted.indexOf(rh); if (_is >= 0) _pendingStarted.splice(_is, 1);
    if (rh === run) run = null;             // clear the FOREGROUND pointer iff this was it (a cap>1 background run leaves `run` alone)
    _renderRunningBar();                    // DBR-P4-4 step 5 — a run ended; refresh / hide the multi-run indicator
    try { refreshHistory && refreshHistory(); } catch { /* */ }   // v2.74.1094 — a run ended → refresh the drawer's per-conversation status
  }

  function disconnect() {
    try { port?.disconnect(); } catch { /* */ }
    port = null;
  }

  function ensurePort() {
    if (port) return port;
    port = chrome.runtime.connectNative(HOST_NAME);
    port.onMessage.addListener(onHostMsg);
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message || '';
      port = null;
      _failPendingGit('bridge port closed');   // v2.74.1034 (DBR-2) — don't leave git RPCs hanging on disconnect
      // v2.74.1097 — end EVERY live run, not just the foreground. The host owns the ONE port, so its death closes it
      // for ALL runs; pre-fix only `run` was ended, leaving cap>1 BACKGROUND runs (in `runs`) + still-PENDING runs (in
      // the dispatch FIFOs) as zombies — shown "running" forever in the drawer and miscounting the slot cap (so the
      // dispatch guard refused new runs until reload). Snapshot first (endRun mutates `runs`/the FIFOs as it goes).
      const msg = /not found|forbidden/i.test(err)
        ? `✗ bridge host not reachable (${err}). Run bridge/install.ps1 once, then reload the extension.`
        : `✗ bridge port closed${err ? ` — ${err}` : ''} (a started run continues detached; journal in logs/bridge/).`;
      for (const rh of new Set([...runs.values(), ..._pendingPreflight, ..._pendingStarted, ...(run ? [run] : [])])) {
        try { endRun(msg, rh); } catch { /* */ }
      }
    });
    return port;
  }

  // v2.74.1034 (DBR-2) — panel→host git RPC. Posts {type:'git', op, params, reqId}; resolves on the matching
  // git-result. The host enforces the §3 allowlist (parameter-validated argv → spawn shell-free; dev-branch
  // write guard) — the panel only relays. Correlated by reqId and safety-timed so a dead host can't hang a caller.
  let _gitSeq = 0;
  const _gitPending = new Map();
  function _failPendingGit(reason) { for (const resolve of _gitPending.values()) { try { resolve({ ok: false, error: reason }); } catch { /* */ } } _gitPending.clear(); }
  function gitOp(op, params = {}, opts = {}) {   // DBR-#1 — opts.worktree (a dev branch) → host runs this op in that branch's .wt/ worktree (cap>1 prepare); omitted → repo-root main
    return new Promise((resolve) => {
      const reqId = 'g' + (++_gitSeq);
      _gitPending.set(reqId, resolve);
      const done = (r) => { if (_gitPending.has(reqId)) { _gitPending.delete(reqId); resolve(r); } };
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'git', op, params, reqId, ...(opts.worktree ? { worktree: opts.worktree } : {}) }); }
      catch (e) { done({ ok: false, error: 'host unreachable: ' + ((e && e.message) || e) }); return; }
      setTimeout(() => done({ ok: false, error: 'git op timed out' }), 20000);
    });
  }

  // DBR-P2-3 — panel→host TEST GATE. Posts {type:'test', reqId}; resolves on the matching `test-result`. The host
  // runs `npm test` ASYNC (fixed command, no params). Long safety-timer — a full suite + a cold start takes a while.
  let _testSeq = 0;
  const _testPending = new Map();
  function hostTest(opts = {}) {   // DBR-#1 — opts.worktree → npm test runs in that branch's worktree (cap>1); omitted → repo root
    return new Promise((resolve) => {
      const reqId = 't' + (++_testSeq);
      _testPending.set(reqId, resolve);
      const done = (r) => { if (_testPending.has(reqId)) { _testPending.delete(reqId); resolve(r); } };
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'test', reqId, ...(opts.worktree ? { worktree: opts.worktree } : {}) }); }
      catch (e) { done({ ok: false, error: 'host unreachable: ' + ((e && e.message) || e) }); return; }
      setTimeout(() => done({ ok: false, error: 'test gate timed out' }), 300000);
    });
  }

  // DBR-P2-4 — mint a one-time CONFIRM TOKEN for a gated converge op. Called by the panel only AFTER the human
  // taps the merge-confirm button; the host returns a fresh single-use nonce the gated op then carries (P2-1).
  let _confirmSeq = 0;
  const _confirmPending = new Map();
  function hostConfirmToken() {
    return new Promise((resolve) => {
      const reqId = 'c' + (++_confirmSeq);
      _confirmPending.set(reqId, resolve);
      const done = (r) => { if (_confirmPending.has(reqId)) { _confirmPending.delete(reqId); resolve(r); } };
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'git-confirm', reqId }); }
      catch (e) { done({ token: null, error: 'host unreachable: ' + ((e && e.message) || e) }); return; }
      setTimeout(() => done({ token: null, error: 'confirm-token mint timed out' }), 15000);
    });
  }

  // Version-at-land (docs/DESIGN_surfaces.md §4.2) — panel→host STAMP. Posts {type:'stamp-version'}; resolves on the
  // matching `stamp-result` ({ ok, version, from }). Fired in the land between the staged squash and the commit, so the
  // landed manifest version is main-current+1 regardless of what the branch bumped to. Safety-timed like the others.
  let _stampSeq = 0;
  const _stampPending = new Map();
  function hostStampVersion() {
    return new Promise((resolve) => {
      const reqId = 's' + (++_stampSeq);
      _stampPending.set(reqId, resolve);
      const done = (r) => { if (_stampPending.has(reqId)) { _stampPending.delete(reqId); resolve(r); } };
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'stamp-version', reqId }); }
      catch (e) { done({ ok: false, error: 'host unreachable: ' + ((e && e.message) || e) }); return; }
      setTimeout(() => done({ ok: false, error: 'version stamp timed out' }), 15000);
    });
  }

  function onHostMsg(m) {
    if (!m || m.v !== PROTOCOL_V) return;
    switch (m.type) {
      case 'git-result': { const resolve = _gitPending.get(m.reqId); if (resolve) { _gitPending.delete(m.reqId); resolve(m); } break; }   // v2.74.1034 (DBR-2)
      case 'test-result': { const resolve = _testPending.get(m.reqId); if (resolve) { _testPending.delete(m.reqId); resolve(m); } break; }   // DBR-P2-3
      case 'git-confirm-result': { const resolve = _confirmPending.get(m.reqId); if (resolve) { _confirmPending.delete(m.reqId); resolve(m); } break; }   // DBR-P2-4
      case 'stamp-result': { const resolve = _stampPending.get(m.reqId); if (resolve) { _stampPending.delete(m.reqId); resolve(m); } break; }   // version-at-land (docs/DESIGN_surfaces.md §4.2)
      case 'preflight': {
        const r = _pendingPreflight.shift() || run;   // DBR-P4-4 — this preflight-ok answers the earliest-dispatched run (FIFO)
        if (!m.ok) { endRun(`✗ preflight failed: ${m.error}`, r); break; }
        if (r && r.pendingPayload) { const p = r.pendingPayload; r.pendingPayload = null; port.postMessage(p); _emit({ kind: 'meta', text: `claude ${m.claudeVersion} · ${m.repoRoot}` }, r); _pendingStarted.push(r); }
        break;
      }
      case 'pool': {
        // DBR-P4-3b (§10) — the run-pool snapshot the host emits on run start/finish + on the connect probe. At cap=1
        // it's the one run; the running-bar (below, P4-4) renders it. Stored now, consumed there.
        _lastPool = { running: Array.isArray(m.running) ? m.running : [], cap: Number(m.cap) || 1 };
        // DBR-P4-8 / v2.74.1104 — POOL REATTACH (ALL caps — the host always sends `pool`, and it carries the runId the
        // `status` frame lacks): a run still live in the pool that this panel has NO handle for (lost to a close/reload)
        // gets a bubble so the host's re-tailed events land somewhere. _rekeyRunMsg gives it the stable `devrun-<runId>`
        // id → reopening N times collapses to ONE bubble (+ removes the rehydrated stale copy), instead of piling up a
        // new "↻ reattaching…" per reconnect. The FIRST reattach claims the foreground `run`; the rest are background.
        for (const r of _lastPool.running) {
          if (!r || !r.runId || runs.has(r.runId) || (run && run.runId === r.runId)) continue;
          // v2.74.1106 — the host now reports each surviving run's home conversation (`r.conv`). Bind it so the run
          // shows running in ITS conversation's drawer, the dispatch guard counts it, and a conversation switch
          // re-attaches it correctly. Render the bubble HERE only if that conversation is the one on screen; else
          // create it DETACHED (it accumulates blocks + persists pinned, invisibly) so it doesn't land in the wrong
          // conversation — reattachConversation() renders it when the user opens its conversation.
          const convId = r.conv || null;
          const openConv = (typeof currentConversationId === 'function') ? currentConversationId() : null;
          const isOpen = !!(convId && openConv && convId === openConv);
          const h = _beginRunBubble(`↻ reattaching to a run still in progress (pid ${r.pid != null ? r.pid : '?'})…`, { reattach: true, background: !isOpen || !!run });
          h.conversationId = convId;
          h.runId = r.runId; runs.set(r.runId, h); _rekeyRunMsg(h, r.runId);
          if (!isOpen) { try { h.msg.remove(); } catch { /* */ } }   // not this conversation → detach; surfaced on switch
        }
        _renderRunningBar();   // DBR-P4-4 — refresh the multi-run indicator
        break;
      }
      case 'started': {
        const r = _pendingStarted.shift() || run;   // DBR-P4-4 — this `started` belongs to the earliest run awaiting it (FIFO)
        if (r) { r.runId = m.runId || r.runId; if (r.runId) { runs.set(r.runId, r); _rekeyRunMsg(r, r.runId); } }   // DBR-P4-3b step 5 — runId → run map (demux key); .1104 — + stable `devrun-<runId>` message id (collapses reattach copies)
        _emit({ kind: 'meta', text: `▶ run started (pid ${m.pid}${m.resumed ? `, ↻ resumed ${String(m.resumed).slice(0, 8)}` : ''}${m.model && m.model !== 'default' ? `, model ${m.model}` : ''}${m.maxTurns ? `, ≤${m.maxTurns} turns` : ''}, journal logs/bridge/${m.journal})` }, r);
        break;
      }
      case 'event': {
        const ev = m.ev || {};
        const rh = runs.get(m.runId) || run;   // DBR-P4-3b step 5b — demux: route this frame to ITS run's bubble (the foreground at cap=1)
        if (ev.type === 'system' && ev.subtype === 'init') {
          if (rh) rh.sessionId = ev.session_id ?? null;
          _emit({ kind: 'meta', text: `session ${String(ev.session_id ?? '').slice(0, 8)} · ${ev.model ?? ''}` }, rh);
        } else if (ev.type === 'assistant') {
          for (const block of (ev.message?.content ?? [])) {
            if (block.type === 'text' && block.text?.trim()) _emit({ kind: 'text', text: block.text.trim() }, rh);
            else if (block.type === 'thinking' && block.thinking?.trim()) _emit({ kind: 'thinking', text: block.thinking.trim() }, rh);
            else if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
              // v2.74.1024 — SURFACE Claude's questions. Pre-.1024 this rendered as a bare "AskUserQuestion"
              // chip (the arg pick below has none of its fields) so the question + options VANISHED — the
              // "chat doesn't surface claude code questions" bug. Headless `claude -p` can't take an
              // interactive answer mid-run, so render the question as plain text and tell the user to reply
              // with `dev: <choice>` (which resumes the session so Claude sees the answer).
              // v2.74.1025 (DB-4) — when the relay is ON, the PreToolUse hook ALSO sends an interactive
              // `approval` (question) frame → _emitQuestion renders option buttons that PAUSE the run. Skip
              // this static text then (avoid a double); only render it as the relay-OFF fallback.
              const qs = Array.isArray(block.input?.questions) ? block.input.questions : [];
              const lines = ['❓ Claude is asking:'];
              for (const q of qs) {
                lines.push(`• ${String(q.question ?? q.header ?? '').trim()}`);
                for (const o of (Array.isArray(q.options) ? q.options : [])) lines.push(`    – ${String(o.label ?? '').trim()}${o.description ? ` — ${String(o.description).trim()}` : ''}`);
              }
              lines.push('↳ answer with `dev: <your choice>`.');
              getRelay().then((on) => { if (!on) _emit({ kind: 'text', text: lines.join('\n') }, rh); }).catch(() => _emit({ kind: 'text', text: lines.join('\n') }, rh));
            }
            else if (block.type === 'tool_use' && block.name === 'ExitPlanMode') {
              // v2.74.1024 — surface the proposed plan (was a content-less chip too).
              _emit({ kind: 'text', text: `📋 Claude proposed a plan:\n${String(block.input?.plan ?? '').trim()}\n↳ approve with \`dev: yes\`, or redirect with \`dev: <changes>\`.` }, rh);
            }
            else if (block.type === 'tool_use' && /(?:^|__)propose_split$/.test(String(block.name || ''))) {
              // DBR-P3-3 (v2.74.1056, DESIGN §8.1/U5) — Claude proposed a split via the proposal-only `propose_split`
              // tool. Surface the approve/decline card; the panel alone seeds the branch on a human tap (the tool
              // never mutates git/fs). MCP exposes it as `mcp__<server>__propose_split` (P3-3b) — match the suffix.
              _proposeSplitCard(block.input, rh?.conversationId || null);
            }
            else if (block.type === 'tool_use') {
              const arg = block.input?.file_path ?? block.input?.pattern ?? block.input?.command ?? '';
              _emit({ kind: 'tool', name: block.name, arg: arg ? _short(arg, 80) : '' }, rh);
            }
          }
        }
        break;
      }
      case 'diffstat': {
        const files = Array.isArray(m.files) ? m.files : [];
        const sig = typeof m.sig === 'string' ? m.sig : '';
        // v2.74.980 — PENDING = dirty AND the signature differs from the last-reloaded baseline. On first
        // use (no baseline persisted) appliedSig is '' so a dirty tree still arms the dot — honest: there
        // are uncommitted changes a reload would apply. After a reload the signatures match → dot clears.
        getAppliedSig().then((applied) => emitReload({ available: files.length > 0 && sig !== applied, files, sig }));
        break;
      }
      case 'done': {
        // A run may have edited the repo — re-check the working tree so the reload icon arms (spec §5).
        refreshReloadState();
        const rh = runs.get(m.runId) || run;   // DBR-P4-3b step 5b — resolve which run finished (the foreground at cap=1)
        const r = m.result || {};
        // v2.74.985 — remember this run's session so the NEXT `dev:` continues it by default (the
        // bridge is a conversation; `dev: new` starts a fresh thread). Capture from the result, else the
        // init event the run streamed. This is also what makes resume-after-pause work.
        const sid = r.sessionId || rh?.sessionId || null;
        // v2.74.1034 (DBR-2) — record the session on the OWNING dev conversation (per-conversation resume),
        // falling back to the legacy global key only when the run isn't bound to a conversation.
        if (sid && !rh?.replay) {
          if (rh?.conversationId) ConversationStore.patchMeta(rh.conversationId, { sessionId: sid }).catch(() => { /* */ });
          else setLastSession(sid);
        }
        // DB-3 (v2.74.992, spec §7.1) — a user-initiated PAUSE arrives here as the host-lost `done` that
        // follows the kill. Frame it as paused (the Esc-analog: resume with a redirect), NOT an error.
        if (rh?.pausing) {
          endRun({ kind: 'result', ok: true, text: sid
            ? '⏸ paused — session kept. `dev: <your redirect>` to resume with a correction, or `dev:` to continue as-is.'
            : '⏸ paused before a session id arrived — nothing to resume; start a fresh run.' }, rh);
          break;
        }
        const ok = r.subtype === 'success';
        const bits = [
          ok ? '✓ done' : `✗ ${r.subtype ?? 'ended'}`,
          r.numTurns != null ? `${r.numTurns} turns` : null,
          r.durationMs != null ? `${Math.round(r.durationMs / 1000)}s` : null,
          r.costUsd != null ? `$${Number(r.costUsd).toFixed(2)}` : null,
        ].filter(Boolean).join(' · ');
        const resume = sid ? `\ncontinue in terminal: claude --resume ${sid}` : '';
        endRun({ kind: 'result', ok, text: `${bits}${resume}` }, rh);
        // surfaces-§4.3 — a successful dev-conversation run may be a task to land → offer Review. _offerReview queries
        // the branch's OWN worktree for changes (cap-correct: a cap>1 run edits `.wt/<branch>`, which the repo-root
        // diffstat misses) and no-ops if nothing changed / the gate is off. Best-effort: never blocks the done flow.
        if (ok && rh?.conversationId && !rh.replay && !rh.pausing) _offerReview(rh.conversationId).catch(() => { /* */ });
        break;
      }
      case 'status': {
        // DB-3 (v2.74.999) — the reattach probe reply. v2.74.1104 — reattach is now driven solely by the `pool` frame
        // the host sends right after this: the pool carries the runId (this `status` frame doesn't), which is needed
        // for the stable per-run bubble id that collapses open/close reattach copies. So this is informational only.
        break;
      }
      case 'history':   // DB-3 (v2.74.1000) — list of recent runs → clickable, replay-on-tap
        renderHistory(Array.isArray(m.runs) ? m.runs : []);
        break;
      case 'approval': {  // DB-3 (v2.74.1002) — the run wants a non-safe tool → inline Allow/Deny
        // v2.74.1025 (DB-4) — an AskUserQuestion relay → interactive question card (pause-for-reply), not Allow/Deny.
        const rh = runs.get(m.runId) || run;   // DBR-P4-4 step 3 — route the card to the requesting run's bubble (foreground at cap=1)
        _emitPrompt(m, rh);
        break;
      }
      case 'error':
        endRun(`✗ bridge error: ${m.code}${m.message ? ` — ${m.message}` : ''}${m.code === 'busy' ? ' (one run at a time; "dev: pause" to stop it)' : ''}`, runs.get(m.runId) || run);
        break;
      default: break;
    }
  }

  // Build the live run bubble + footer (spinner · ticking elapsed · Pause). Shared by a normal run and a
  // reattach (v2.74.999). The caller posts preflight/run (normal) or nothing (reattach — the host is
  // already re-tailing the journal and will stream events straight into this bubble).
  function _beginRunBubble(headline, { reattach = false, background = false } = {}) {
    _follow = true;       // v2.74.995 — a fresh run follows from the top; the user can scroll up to stop it
    _wireFollow();        // attach the one scroll listener (idempotent) now that the panel is up
    const { msg, bodyEl, blocks } = devBubble(headline, { persist: false });   // v2.74.1104 — run content persists via _emit under the STABLE `devrun-<runId>` id (_rekeyRunMsg); the initial UUID-keyed persist is what piled up duplicate reattach bubbles across open/close
    const rh = { msgEl: msg, msg, bodyEl, blocks, bar: null, sessionId: null, pendingPayload: null, tick: null, reattach };
    // DBR-P4-4 step 2 — a FOREGROUND run owns the global `run` pointer (cap=1: always; the reattach/replay/gl paths
    // read it); a cap>1 BACKGROUND run lives ONLY in `runs` (registered on `started`) + streams to its own bubble via
    // the runId demux, leaving the foreground pointer alone. Step 1 already threaded the footer/Pause through `rh`.
    if (!background) run = rh;
    rh.startedAt = Date.now();   // v2.74.1093 — kept on the handle so a conversation-switch re-attach preserves elapsed
    _attachRunFooter(rh);        // v2.74.989/.992 — amber spinner · ticking "working… Ns" · Pause; factored out (.1093) so re-attach can rebuild it
    return rh;
  }

  // v2.74.1104 — give a run's bubble a STABLE message id derived from its runId (`devrun-<runId>`), so EVERY bubble
  // for that run — the original + each open/close reattach — shares ONE stored message instead of piling up a new
  // "↻ reattaching…" copy per reconnect. Also removes any other DOM node already carrying that id (a rehydrated stale
  // copy), so the run renders exactly once. Called on `started` (fresh run) and on a pool reattach (surviving run).
  function _rekeyRunMsg(rh, runId) {
    if (!rh || !rh.msg || runId == null) return;
    const id = 'devrun-' + String(runId).replace(/[^\w-]/g, '');
    try { document.querySelectorAll(`[data-message-id="${id}"]`).forEach((el) => { if (el !== rh.msg) el.remove(); }); } catch { /* */ }
    try { rh.msg.dataset.messageId = id; } catch { /* */ }
  }

  // Build (or REBUILD) the run footer onto rh's CURRENT bubble: spinner · ticking elapsed · Pause. Factored out of
  // _beginRunBubble at v2.74.1093 so _reattachRunBubble can re-create it on a freshly-rendered bubble after a
  // conversation switch. Clears any prior tick first (the old bubble's interval) so only one ever ticks.
  function _attachRunFooter(rh) {
    if (rh.tick) { try { clearInterval(rh.tick); } catch { /* */ } rh.tick = null; }
    const bar = document.createElement('div');
    bar.className = 'dev-run-bar';
    const spinner = document.createElement('span');
    spinner.className = 'dev-run-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'dev-run-status';
    bar.appendChild(spinner);
    bar.appendChild(status);
    bar.appendChild(mkBtn('Pause', () => { rh.pausing = true; try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'pause', runId: rh.runId }); } catch { /* */ } }));   // pause THIS run by its OWN id (host: no runId → all)
    const _content = (rh.msg && rh.msg.querySelector('.message-content')) || rh.msg;   // v2.74.991 — the vertical text column, not the row
    if (_content) _content.appendChild(bar);
    rh.bar = bar;
    try { _anchor(); } catch { /* */ }
    const tickFn = () => { status.textContent = `${rh.reattach ? 'reattached · ' : ''}working… ${Math.round((Date.now() - (rh.startedAt || Date.now())) / 1000)}s`; };
    tickFn();
    rh.tick = setInterval(tickFn, 1000);
  }

  // v2.74.1093 — RE-ATTACH a still-live run to a FRESH bubble after a conversation switch wiped #messages. The run
  // kept executing (the host doesn't know about UI switches) and kept accumulating rh.blocks + persisting; only its
  // bubble DOM was destroyed. Rebuild: new bubble, re-render rh.blocks, KEEP the stored message id (so persistence
  // stays ONE row), re-point the handle, restore the live footer. Streaming (demuxed by runId) lands here from now on.
  function _reattachRunBubble(rh) {
    if (!rh) return;
    const prevMsgId = (rh.msg && rh.msg.dataset) ? rh.msg.dataset.messageId : null;
    if (rh.tick) { try { clearInterval(rh.tick); } catch { /* */ } rh.tick = null; }
    const { msg, bodyEl } = devBubble('', { persist: false });   // already persisting under prevMsgId — don't double-write
    if (prevMsgId && msg && msg.dataset) { try { msg.dataset.messageId = prevMsgId; } catch { /* */ } }
    for (const b of (rh.blocks || [])) { try { bodyEl.appendChild(_blockNode(b)); } catch { /* */ } }
    rh.msgEl = msg; rh.msg = msg; rh.bodyEl = bodyEl;
    _attachRunFooter(rh);
    // v2.74.1094 — if the run is paused waiting on you, re-render its approval/question card into the new bubble so
    // it's answerable HERE (it was stranded in the bubble that got wiped on the switch).
    if (rh.awaitingAction && rh.pendingPrompt) { try { _emitPrompt(rh.pendingPrompt, rh); } catch { /* */ } }
  }
  // The live run handles bound to a conversation (started, mid-handshake, or the foreground). At most one per
  // conversation (the dispatch guard refuses a 2nd), but kept general. Replay/history bubbles are excluded.
  function _liveRunsForConv(cid) {
    if (cid == null) return [];
    const set = new Set([...runs.values(), ..._pendingPreflight, ..._pendingStarted]);
    if (run) set.add(run);
    return [...set].filter((rh) => rh && rh.conversationId === cid && !rh.replay);
  }
  // v2.74.1093 — chat.js calls this on a conversation switch (after rendering persisted messages): re-attach any run
  // still live for the now-open conversation so it shows LIVE, not a frozen snapshot. Returns how many re-attached.
  function reattachConversation(cid) {
    const live = _liveRunsForConv(cid);
    for (const rh of live) _reattachRunBubble(rh);
    try { _renderRunningBar(); } catch { /* */ }
    return live.length;
  }
  // The persisted message ids of live runs for a conversation — chat.js SKIPS these on rehydrate so the live
  // re-attach (above) is the single rendering, not a frozen duplicate beside it.
  function liveRunMessageIds(cid) {
    return new Set(_liveRunsForConv(cid).map((rh) => rh && rh.msg && rh.msg.dataset && rh.msg.dataset.messageId).filter(Boolean));
  }
  // v2.74.1094 — the run status for a conversation, for the drawer's live indicator. 'awaiting' = a run is paused
  // for YOUR input (approval / question); 'running' = executing; 'idle' = no live run. `startedAt` (running) drives
  // the ticking elapsed. chat.js renders it under the session id, replacing the static timestamp while active.
  function runStatusForConv(cid) {
    const live = _liveRunsForConv(cid);
    if (live.some((rh) => rh.awaitingAction)) return { state: 'awaiting' };
    if (live.length) return { state: 'running', startedAt: Math.min(...live.map((rh) => Number(rh.startedAt) || Date.now())) };
    const o = _lastRunOutcome.get(cid);   // v2.74.1096/.1098 — no live run, but the last one ended → done / failed / paused
    if (o) return { state: o.kind, at: o.at };
    return { state: 'idle' };
  }
  // v2.74.1096 — clear a conversation's "done" marker (called when the conversation is opened — you've seen it).
  function clearRunOutcome(cid) { if (cid != null) _lastRunOutcome.delete(cid); }
  // v2.74.1094 — ANY run (any conversation) paused for your input? Drives the drawer-toggle "needs you" dot, which
  // must show even when the drawer is closed — so chat.js reads this on every run-state change, not just on render.
  function anyAwaiting() {
    if (run && run.awaitingAction) return true;
    for (const rh of [...runs.values(), ..._pendingPreflight, ..._pendingStarted]) if (rh && rh.awaitingAction) return true;
    return false;
  }
  // v2.74.1095 — STOP every live run for a conversation, called when the conversation is DELETED so it doesn't ORPHAN
  // (a run that keeps executing with no UI home, holding a host slot). Pause each STARTED run by its runId — the host
  // kills the child + frees the slot, and the host-lost `done` runs endRun BY RUNID (the handle is still in `runs`,
  // so it can't clobber another run — the same proven path as the Pause button; an immediate endRun here would let
  // that late `done` fall back to the foreground `run`). A still-PENDING run (no runId — a sub-second window) is left
  // to the order-based preflight/started FIFO so removing it can't desync a later run's correlation. Returns the count.
  function cancelConversationRuns(cid) {
    let n = 0;
    for (const rh of _liveRunsForConv(cid)) {
      if (!rh.runId) continue;
      rh.pausing = true;
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'pause', runId: rh.runId }); n++; } catch { /* */ }
    }
    try { refreshHistory && refreshHistory(); } catch { /* */ }
    return n;
  }
  // v2.74.1095 — stop ALL live runs (for "delete all conversations"). One pause with NO runId → the host kills every
  // child; each host-lost `done` then frees its slot via endRun.
  function cancelAllRuns() {
    for (const rh of [...runs.values(), ..._pendingPreflight, ..._pendingStarted, ...(run ? [run] : [])]) { if (rh) rh.pausing = true; }
    try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'pause' }); } catch { /* */ }
    try { refreshHistory && refreshHistory(); } catch { /* */ }
  }

  function startRun(payload, headline, opts = {}) {
    if (opts.conversationId) _lastRunOutcome.delete(opts.conversationId);   // v2.74.1096 — a new run supersedes the prior "done" status
    if (opts.conversationId && payload && typeof payload === 'object') payload.conv = opts.conversationId;   // v2.74.1106 — the host stores this in the lock so a reattach re-binds the surviving run to its home conversation
    const r = _beginRunBubble(headline, { background: opts.background || false });   // DBR-P4-4 — a cap>1 2nd+ run is background
    r.pendingPayload = payload;
    r.conversationId = opts.conversationId || null;   // v2.74.1034 (DBR-2) — bind the run to its dev conversation
    try {
      ensurePort().postMessage({ v: PROTOCOL_V, type: 'preflight' });   // run is posted on preflight-ok
      _pendingPreflight.push(r);   // DBR-P4-4 — queue ONLY once the preflight actually went out, so the FIFO and the host's ok stay in lockstep
      _renderRunningBar();   // DBR-P4-4 step 5 — a new run is in flight; refresh the multi-run indicator
      try { refreshHistory && refreshHistory(); } catch { /* */ }   // v2.74.1094 — a run started → drawer shows it running
    } catch (e) {
      endRun(`✗ could not reach the bridge host: ${e.message}. Run bridge/install.ps1, then reload.`, r);
    }
  }

  // ── Run history (v2.74.1000, DB-3) ───────────────────────────────────────────────────────────────
  const _clock = (ts) => { try { return new Date(Number(ts)).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } };

  // Replay a past run read-only: a minimal bubble the host's `history-open` events render into. No footer/
  // spinner/Pause (the run is finished) and NOT persisted (a transient view; re-open via `dev: history`).
  function startReplay(headline) {
    _beginReplayBubble(headline);
  }
  function _beginReplayBubble(headline) {
    _follow = true; _wireFollow();
    const { msg, bodyEl, blocks } = devBubble(headline, { persist: false });
    run = { msgEl: msg, msg, bodyEl, blocks, bar: null, sessionId: null, pendingPayload: null, tick: null, replay: true };
  }

  // ── Permission relay (v2.74.1002, DB-3) ──────────────────────────────────────────────────────────
  // The host forwards a non-safe tool request as an `approval` frame; render an inline Allow/Deny card in
  // the active run bubble. The host writes the decision back to the hook, which is blocked polling for it.
  function _approvalSummary(tool, input) {
    input = input || {};
    if (tool === 'Bash') return input.command || '(no command)';
    const v = input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.command ?? '';
    return v ? String(v) : JSON.stringify(input).slice(0, 200);
  }
  // v2.74.1094 — dispatch a relayed prompt to the right card renderer. Also called by _reattachRunBubble to
  // RE-RENDER a pending prompt when its (backgrounded) conversation is reopened — so a run waiting on you is
  // answerable there, not stranded in the bubble that got wiped on the switch.
  function _emitPrompt(m, rh = run) {
    if (m && m.tool === 'AskUserQuestion') _emitQuestion(m, rh); else _emitApproval(m, rh);
  }
  function _emitApproval(m, rh = run) {   // DBR-P4-4 step 3 — render into the REQUESTING run's bubble (rh), not always the foreground
    const hostEl = (rh && rh.bodyEl) || devBubble('', { persist: false }).bodyEl;
    if (!hostEl) return;
    if (rh) { rh.awaitingAction = true; rh.pendingPrompt = m; try { refreshHistory && refreshHistory(); } catch { /* */ } }   // v2.74.1094 — flag "needs you" in the drawer + stash for re-attach
    const card = document.createElement('div');
    card.className = 'dev-approval';
    const q = document.createElement('div'); q.className = 'dev-approval-q';
    q.textContent = `Approve  ${m.tool || 'tool'} ?`;
    const detail = document.createElement('div'); detail.className = 'dev-approval-detail';
    detail.textContent = _approvalSummary(m.tool, m.input);
    const actions = document.createElement('div'); actions.className = 'dev-approval-actions';
    let decided = false;
    const decide = (decision) => {
      if (decided) return; decided = true;
      if (rh) { rh.awaitingAction = false; rh.pendingPrompt = null; try { refreshHistory && refreshHistory(); } catch { /* */ } }   // v2.74.1094 — answered → clear "needs you"
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'approval-decision', id: m.id, decision }); } catch { /* */ }
      actions.remove();
      const verdict = document.createElement('span');
      verdict.className = `dev-approval-verdict ${decision}`;
      verdict.textContent = decision === 'allow' ? '✓ allowed' : '✗ denied';
      card.appendChild(verdict);
    };
    actions.appendChild(mkBtn('Allow', () => decide('allow')));
    actions.appendChild(mkBtn('Deny', () => decide('deny')));
    card.appendChild(q); card.appendChild(detail); card.appendChild(actions);
    hostEl.appendChild(card);
    try { _anchor(); } catch { /* */ }
  }

  // v2.74.1025 (DB-4) — interactive QUESTION card. The PreToolUse hook relayed an AskUserQuestion and is
  // BLOCKING; render each question with option buttons, collect the user's pick(s), then send the answer
  // back as an `approval-decision` whose `reason` carries the answer — the hook returns it to Claude (as a
  // deny reason) and the PAUSED run continues. All text via textContent (trust rule §5 — never HTML).
  function _emitQuestion(m, rh = run) {   // DBR-P4-4 step 3 — render into the REQUESTING run's bubble (rh)
    const hostEl = (rh && rh.bodyEl) || devBubble('', { persist: false }).bodyEl;
    if (!hostEl) return;
    if (rh) { rh.awaitingAction = true; rh.pendingPrompt = m; try { refreshHistory && refreshHistory(); } catch { /* */ } }   // v2.74.1094 — flag "needs you" + stash for re-attach
    const questions = Array.isArray(m.input?.questions) ? m.input.questions : [];
    const card = document.createElement('div');
    card.className = 'dev-approval dev-question';
    const head = document.createElement('div'); head.className = 'dev-approval-q'; head.textContent = '❓ Claude is asking:';
    card.appendChild(head);
    // selections[i] = Set of chosen labels for question i
    const selections = questions.map(() => new Set());
    let sent = false;
    const submit = () => {
      if (sent) return;
      if (selections.some((s) => s.size === 0)) return;   // every question needs an answer
      sent = true;
      if (rh) { rh.awaitingAction = false; rh.pendingPrompt = null; try { refreshHistory && refreshHistory(); } catch { /* */ } }   // v2.74.1094 — answered → clear "needs you"
      const summary = questions.map((q, i) => `${String(q.header || q.question || `Q${i + 1}`).trim()}: ${[...selections[i]].join(', ')}`).join(' · ');
      const reason = `[dev-bridge] The user answered in the panel — ${summary}. Use these answers and continue; do NOT call AskUserQuestion again for them.`;
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'approval-decision', id: m.id, decision: 'deny', reason }); } catch { /* */ }
      card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const verdict = document.createElement('div'); verdict.className = 'dev-approval-verdict allow';
      verdict.textContent = `✓ answered — ${summary}`;
      card.appendChild(verdict);
      try { _anchor(); } catch { /* */ }
    };
    questions.forEach((q, i) => {
      const block = document.createElement('div'); block.className = 'dev-question-block';
      const qt = document.createElement('div'); qt.className = 'dev-approval-detail';
      qt.textContent = String(q.question || q.header || '').trim();
      block.appendChild(qt);
      const opts = document.createElement('div'); opts.className = 'dev-approval-actions';
      const btns = [];
      (Array.isArray(q.options) ? q.options : []).forEach((o) => {
        const label = String(o.label ?? '').trim();
        if (!label) return;
        const b = mkBtn(o.description ? `${label} — ${_short(String(o.description), 60)}` : label, () => {
          if (sent) return;
          if (q.multiSelect) {
            if (selections[i].has(label)) { selections[i].delete(label); b.classList.remove('sel'); }
            else { selections[i].add(label); b.classList.add('sel'); }
          } else {
            selections[i].clear(); selections[i].add(label);
            btns.forEach((x) => x.classList.remove('sel')); b.classList.add('sel');
            // single question + single-select → one click answers (Claude-chat feel)
            if (questions.length === 1) { submit(); return; }
          }
        });
        b.dataset.label = label; btns.push(b); opts.appendChild(b);
      });
      block.appendChild(opts); card.appendChild(block);
    });
    // Submit button for multi-select / multi-question cases (single-select single-question auto-submits above).
    if (!(questions.length === 1 && !questions[0]?.multiSelect)) {
      const actions = document.createElement('div'); actions.className = 'dev-approval-actions';
      actions.appendChild(mkBtn('Send answer ▸', submit));
      card.appendChild(actions);
    }
    hostEl.appendChild(card);
    try { _anchor(); } catch { /* */ }
  }

  // Render the `history` reply: a clickable list of recent runs; a row replays that journal read-only.
  function renderHistory(runs) {
    const msg = appendMessage({ role: 'assistant', body: '' });
    const bodyEl = msg.querySelector('.message-body');
    if (bodyEl) bodyEl.textContent = '';
    if (decorateBubble) decorateBubble(msg, { collapsed: false });
    else { try { msg.style.borderLeft = '3px solid #c9a227'; msg.dataset.devBridge = '1'; } catch { /* */ } }
    const wrap = document.createElement('div');
    wrap.className = 'dev-history';
    const head = document.createElement('div');
    head.className = 'dev-history-head';
    head.textContent = runs.length ? `Recent runs (${runs.length}) — tap to replay` : 'No runs recorded yet.';
    wrap.appendChild(head);
    for (const r of runs) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'dev-history-row';
      const stateCls = r.subtype === 'success' ? 'ok' : (r.subtype === 'incomplete' ? 'warn' : 'err');
      const v = document.createElement('span'); v.className = 'dev-history-verb'; v.textContent = r.verb || '?';
      const p = document.createElement('span'); p.className = 'dev-history-prev'; p.textContent = r.promptPreview || '(no preview)';
      const meta = document.createElement('span'); meta.className = `dev-history-meta ${stateCls}`;
      meta.textContent = [_clock(r.startedAt), r.numTurns != null ? `${r.numTurns}t` : '', r.costUsd != null ? `$${Number(r.costUsd).toFixed(2)}` : '', r.subtype].filter(Boolean).join(' · ');
      row.appendChild(v); row.appendChild(p); row.appendChild(meta);
      row.addEventListener('click', () => {
        if (run) { devBubble('a run is live — `dev: pause` it first.'); return; }
        startReplay(`↩ replaying ${r.verb || 'run'} · ${_short(r.promptPreview || r.journal, 60)}`);
        try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'history-open', journal: r.journal }); }
        catch { endRun('✗ could not reach the host to replay this run.'); }
      });
      wrap.appendChild(row);
    }
    bodyEl?.appendChild(wrap);
    try { _anchor(); } catch { /* */ }
  }

  // v2.74.1022 — the session's log entries (since logger:sessionStart), shared by the full + decisions builders.
  async function _sessionEntries() {
    let entries = [];
    try {
      const res = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_LOGS' }, (r) => { void chrome.runtime.lastError; resolve(r); }));
      entries = Array.isArray(res?.entries) ? res.entries : [];
    } catch { /* */ }
    try {
      const sess = await chrome.storage.local.get('logger:sessionStart');
      const start = sess?.['logger:sessionStart'];
      if (start) entries = entries.filter((e) => (e.timestamp ?? '') >= start);
    } catch { /* */ }
    return entries;
  }

  // v2.74.1022 — `gl` ships the FULL trace (was decisions-only pre-.1022, mismatching the terminal `gl`).
  async function buildFullTraceAttachment() {
    const entries = await _sessionEntries();
    if (!entries.length) return null;
    return { kind: 'full-trace', filename: `orchard-logs-${_stamp()}.txt`, content: entries.map(_fmtEntry).join('\n') };
  }

  async function buildDecisionsAttachment() {
    const entries = await _sessionEntries();
    const decisions = entries.filter((e) => DECISION_RE.test(String(e.message ?? '')));
    if (!decisions.length) return null;
    return { kind: 'decisions-trace', filename: `orchard-logs-decisions-${_stamp()}.txt`, content: decisions.map(_fmtEntry).join('\n') };
  }

  // v2.74.1022 — `gch` ships the chat transcript: non-dev conversations since the SHARED boundary
  // (settings:lastChatExport — same key the Studio grab uses), oldest→newest, advancing the boundary so
  // the next grab (bridge OR manual) doesn't re-ship them. Dev-bridge chats excluded whole.
  async function buildChatsAttachment() {
    const KEY = 'settings:lastChatExport';
    let summaries = [];
    try { summaries = await ConversationStore.list(); } catch { return null; }
    if (!summaries.length) return null;
    const now = Date.now();
    let since = 0;
    try { const s = await chrome.storage.local.get(KEY); since = s?.[KEY] ?? 0; } catch { /* */ }
    // v2.74.1029 — a `kind:'dev'` conversation is excluded WHOLE (its messages are Claude Code, not user
    // chat) — same intent as the per-message devBridge filter below, but catches an empty/user-only dev thread.
    const candidates = summaries.filter((s) => (s.updatedAt ?? 0) > since && s.kind !== 'dev').sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0));
    if (!candidates.length) return null;
    const convs = [];
    for (const s of candidates) {
      let conv = null;
      try { conv = await ConversationStore.load(s.id); } catch { /* */ }
      if (!conv) continue;
      if ((conv.messages ?? []).some((m) => m.devBridge)) continue;   // dev chats excluded whole
      convs.push(conv);
    }
    try { await chrome.storage.local.set({ [KEY]: now }); } catch { /* */ }   // advance boundary regardless of dev-filtering
    if (!convs.length) return null;
    return { kind: 'chats', filename: `orchard-chats-${_stamp()}.txt`, content: convs.map(_fmtConv).join(`\n${'─'.repeat(60)}\n\n`) };
  }

  /**
   * The chat send-path hook. Returns true when the text was a bridge verb (handled here, never routed).
   * MUST be called synchronously from the send gesture for `dev: on` (the permission request needs it).
   */
  async function maybeHandle(text, opts = {}) {
    // v2.74.1029 — `devConversation`: the caller is a DEV conversation (the conversations-menu surface that
    // replaces the `dev:` prefix). `skipEcho`: the panel already rendered the user's bubble with the original
    // text, so don't echo it again here. Both default off → every existing call site behaves exactly as before.
    const devConv = opts.devConversation === true;
    const skipEcho = opts.skipEcho === true;
    const convId = opts.conversationId || null;   // v2.74.1034 (DBR-2) — the dev conversation this run belongs to
    let t = String(text ?? '').trim();
    // DBR-4 (v2.74.1036, DESIGN §4) — `lt` live-test. Dev-conversation only, WHOLE-message match, intercepted
    // HERE — before the bare-text→`dev:` normalization below — so it never gets rewritten to `dev: lt` and
    // forwarded to Claude. Switches the loaded tree to this conversation's branch and reloads the extension.
    if (devConv && (isLiveTest(t) || isLiveTestForce(t))) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _liveTest(convId, { force: isLiveTestForce(t) });   // v2.74.1043 — `lt!`/`lt force` skips the behind-main warning
      return true;
    }
    // DBR-P2-2 (v2.74.1045, DESIGN §5/§6.2) — `sync`: pull main into this conversation's branch. Whole-message,
    // dev-conversation only, intercepted HERE (before the bare-text→`dev:` normalization) so it never forwards to Claude.
    if (devConv && isSync(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _sync(convId);
      return true;
    }
    // DBR-P2-3 (v2.74.1046, DESIGN §6) — `merge` PREPARE: WIP → sync → test gate → diff preview, then halt for the
    // P2-4 land confirm. Whole-message, dev-conversation only, intercepted before the bare-text normalization.
    if (devConv && isMerge(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _mergePrepare(convId);
      return true;
    }
    // DBR-P2-6 (v2.74.1051, DESIGN §5/U13) — `abandon` (soft archive, keep branch) / `delete branch` (hard,
    // confirm-gated). Whole-message, dev-conversation only, intercepted before the bare-text normalization.
    if (devConv && isAbandon(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _abandon(convId);
      return true;
    }
    if (devConv && isDeleteBranch(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _deleteBranch(convId);
      return true;
    }
    // DBR-P2-7 (v2.74.1052, DESIGN §5/§7) — `drift`: read-only check of this branch vs main's recent changes.
    if (devConv && isDrift(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _driftCheck(convId);
      return true;
    }
    // DBR-P3-2 (v2.74.1055, DESIGN §8/§8.1) — `scope`: deterministic split backstop (cluster + foundational nudge).
    if (devConv && isScope(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _scopeCheck(convId);
      return true;
    }
    // DBR-P3-7 (v2.74.1060, DESIGN §8.1 layer 3) — `scope?`: the optional semantic check (one metered model call).
    if (devConv && isScopeSemantic(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _scopeSemantic(convId);
      return true;
    }
    // DBR-P3-1 (v2.74.1053, DESIGN §8.1) — `split: <concern>`: extract out-of-scope work into its own seeded branch.
    if (devConv && isSplit(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _split(convId, t);
      return true;
    }
    // DBR-P3-5 (v2.74.1059, DESIGN §6.1) — `fork`: continue this (usually merged/abandoned) conversation on a fresh branch.
    if (devConv && isFork(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _fork(convId);
      return true;
    }
    // DBR (regress, v2.74.1133) — `regress`: abandon this change and snap the live build back to `main` (preview → main + reload + archive).
    if (devConv && isRegress(t)) {
      if (!skipEcho) appendMessage({ role: 'user', body: t });
      await _regress(convId);
      return true;
    }
    // keystone K3 (DESIGN_surfaces §2.2) — `surface` / `surface high|low|design` sets THIS conversation's altitude; the
    // next `dev:` run carries it so the host injects the surface preamble (K2/K4). Whole-message, dev-conversation only.
    {
      const sv = devConv ? parseSurfaceVerb(t) : null;
      if (sv) { if (!skipEcho) appendMessage({ role: 'user', body: t }); await _handleSurface(convId, sv); return true; }
    }
    // Inside a dev conversation, bare input IS a dev command: a standalone log verb (gl/gc/gch) or a
    // `bug:`/`dev:` prefix is taken verbatim; anything else (a sub-verb like `pause`/`history`/`model …`, or
    // a plain task) is normalized to the `dev: …` form so the existing branch table handles it unchanged —
    // the user never types `dev:`.
    if (devConv && t) {
      const head = t.toLowerCase();
      const standalone = head === 'gl' || head === 'gc' || head === 'gch' || /^bug:/i.test(t) || /^dev:/i.test(t);
      if (!standalone) t = `dev: ${t}`;
    }
    const echoUser = () => { if (!skipEcho) appendMessage({ role: 'user', body: t }); };
    const isDevVerb = /^dev:/i.test(t);
    const lower = t.toLowerCase().replace(/\s+/g, ' ');

    if (lower === 'dev: on' || lower === 'dev:on') {
      // Permission request FIRST — before any await — while the user-gesture token is live (§11).
      let granted = false;
      try { granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }); } catch { granted = false; }
      echoUser();
      if (!granted) { devBubble('✗ nativeMessaging permission declined — the bridge stays off.'); return true; }
      await setEnabled(true);
      emitReload({ enabled: true });   // reveal the header reload icon
      refreshReloadState();            // and arm it if the tree is already dirty
      devBubble('✓ dev bridge ON — `gl` (full trace), `gc` (decisions), `gch` (chats), `bug: <what broke>` and `dev: <ask>` now route to Claude Code on this repo.\nIf the host isn’t installed yet: run bridge/install.ps1 once, then reload the extension.');
      return true;
    }
    if (lower === 'dev: off' || lower === 'dev:off') {
      echoUser();
      await setEnabled(false);
      disconnect();
      emitReload({ enabled: false, available: false, files: [] });   // hide the header reload icon
      devBubble('dev bridge OFF.');
      return true;
    }

    const enabled = await getEnabled();
    if (!enabled) {
      // v2.74.1029 — a dev conversation whose bridge got turned off (e.g. via `dev: off`) re-enables by
      // starting a fresh dev conversation (the permission request needs that click gesture).
      if (isDevVerb || devConv) { echoUser(); devBubble('dev bridge is off — open the conversations menu and start a new dev conversation to re-enable it.'); return true; }
      return false;   // 'gl' (or anything else) falls through to the normal pipeline when the bridge is off
    }

    // DB-3 (v2.74.992, spec §7.1) — `dev: pause` (and the kept `dev: cancel` alias): the Esc-analog.
    // Kills the process but keeps the session; the done handler then frames it as paused and the next
    // `dev: <redirect>` resumes it with a correction (resume-with-redirect — already the default for any
    // `dev:` since .985). Marking run.pausing distinguishes this from an unexpected host-lost.
    if (lower === 'dev: pause' || lower === 'dev: cancel') {
      echoUser();
      if (run) run.pausing = true;
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'pause' }); } catch { /* */ }
      if (!run) devBubble('nothing is running to pause.');
      return true;
    }

    // DB-3 (v2.74.1000) — `dev: history` (alias `dev: runs`): list recent runs; tap one to replay it
    // read-only. The host reads the journals in logs/bridge/; the reply renders via the `history` case.
    if (lower === 'dev: history' || lower === 'dev: runs') {
      echoUser();
      try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'history' }); } catch { devBubble('✗ could not reach the bridge host.'); }
      return true;
    }

    // DB-3 (v2.74.1002) — `dev: relay` shows the state; `dev: relay on|off` toggles the permission relay.
    // ON → each run gates non-safe tools through an inline Allow/Deny in the panel (a PreToolUse hook);
    // OFF → the static DB-2 allowlist (safe tools only; anything else auto-denied). Safe tier auto-allows
    // either way. Takes effect on the next run.
    if (lower === 'dev: relay' || /^dev: relay /.test(lower)) {
      echoUser();
      const arg = lower === 'dev: relay' ? '' : lower.slice('dev: relay '.length).trim();
      if (!arg) { devBubble(`permission relay: ${(await getRelay()) ? 'ON — non-safe tools prompt for Allow/Deny' : 'OFF — non-safe tools auto-denied (DB-2 allowlist)'}.\ntoggle with \`dev: relay on|off\`.`); return true; }
      if (arg !== 'on' && arg !== 'off') { devBubble('usage: `dev: relay on` or `dev: relay off`.'); return true; }
      await setRelay(arg === 'on');
      devBubble(`permission relay → ${arg.toUpperCase()}. Takes effect on the next run.${arg === 'on' ? ' Non-safe tools (git, network, plain shell…) will ask you inline.' : ''}`);
      return true;
    }

    // v2.74.976 — `dev: model` shows the current pick; `dev: model <alias>` sets it (next run uses it).
    if (lower === 'dev: model' || /^dev: model /.test(lower)) {
      echoUser();
      const arg = lower === 'dev: model' ? '' : lower.slice('dev: model '.length).trim();
      const cur = await getModel();
      if (!arg) { devBubble(`bridge model: ${cur}\nchange with \`dev: model <${MODEL_ALIASES.join('|')}>\` (default = your Claude Code setting).`); return true; }
      if (!MODEL_ALIASES.includes(arg)) { devBubble(`unknown model "${arg}" — choose one of: ${MODEL_ALIASES.join(', ')}.`); return true; }
      await setModel(arg);
      devBubble(`bridge model → ${arg}${arg === 'default' ? ' (your Claude Code default)' : ''}. Takes effect on the next \`gl\` / \`dev:\` run.`);
      return true;
    }

    // v2.74.978 — `dev: turns` shows the budget; `dev: turns <n>` sets it (any positive integer, no cap).
    if (lower === 'dev: turns' || /^dev: turns /.test(lower)) {
      echoUser();
      const arg = lower === 'dev: turns' ? '' : lower.slice('dev: turns '.length).trim();
      const cur = await getTurns();
      if (!arg) { devBubble(`bridge turn budget: ${cur} (the runaway cap). Set with \`dev: turns <n>\` — ~25 for a fix, ~50 for a feature, higher for a big task.`); return true; }
      const n = Math.floor(Number(arg));
      if (!Number.isFinite(n) || n < 1) { devBubble('turns must be a positive whole number.'); return true; }
      await setTurns(n);
      devBubble(`bridge turn budget → ${n}. Takes effect on the next run.`);
      return true;
    }

    // DBR-5 (v2.74.1037, DESIGN §8.2) — `dev: concern` shows this conversation's scope; `dev: concern <text>`
    // edits it. The concern defaults to the first ask (captured on dispatch); editing it changes the scope
    // contract the host re-injects on the NEXT spawn. (DBR-6 surfaces the same edit in the header.)
    if (lower === 'dev: concern' || /^dev: concern /.test(lower)) {
      echoUser();
      const arg = t.replace(/^dev:\s*concern\b/i, '').trim();   // from the ORIGINAL-case text — concerns are prose
      if (!convId) { devBubble('the concern is per dev conversation — open a dev conversation to set one.'); return true; }
      if (!arg) {
        const cur = await _ensureConcern(convId, null);
        devBubble(cur ? `scope (concern): ${cur}\nedit with \`dev: concern <new scope>\` — applies to the next run.` : 'no concern set yet — it defaults to your first task here. Set one now with `dev: concern <scope>`.');
        return true;
      }
      const concern = _conciseConcern(arg);
      await ConversationStore.patchMeta(convId, { concern, titledByLlm: false }).catch(() => { /* */ });   // .1102 — re-scope → let Claude re-pick the label
      try { _applyScopeTitle(await ConversationStore.load(convId), concern); } catch { /* */ }   // v2.74.1099 — instant keyword label
      _llmCategorize(convId, concern);   // v2.74.1102 — Claude re-categorizes for the new scope
      devBubble(`scope (concern) → ${concern}. Applies to the next run.`);
      return true;
    }

    // v2.74.1022 — gl (FULL trace), gc (decisions), gch (chats) — each ships the matching attachment to
    // Claude Code over native messaging (no manual Download). The host writes it into logs/run/ and the
    // run's prompt is the bare shorthand; the repo's standing convention does the analysis.
    if (lower === 'gl' || lower === 'gc' || lower === 'gch') {
      echoUser();
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const att = lower === 'gl' ? await buildFullTraceAttachment()
                : lower === 'gc' ? await buildDecisionsAttachment()
                : await buildChatsAttachment();
      const model = await getModel();
      const maxTurns = await getTurns();
      const nothing = lower === 'gch' ? 'no new chat activity this session' : lower === 'gc' ? 'no decision lines this session' : 'no log lines this session';
      startRun(
        { v: PROTOCOL_V, type: 'run', verb: lower, attachments: att ? [att] : [], model, maxTurns, relay: await getRelay() },
        att ? `${lower} · shipping ${att.filename} + analyzing…` : `${lower} · ${nothing} — analyzing the newest already in logs/run/…`,
        { conversationId: convId },
      );
      return true;
    }

    // DB-2 (v2.74.988) — `bug: <what broke>`: the fix path. Ships the newest decisions trace (same
    // attachment `gl` builds) plus the user's report; the host composes report + trace pointer + version
    // line, and the DB-2 allowlist lets the run verify itself with `npm test`. Never commits (no git).
    // A fresh report each time → no resume; the run's session is still recorded (done handler) so a
    // follow-up `dev: <reply>` continues the same fix thread.
    if (/^bug:/i.test(t)) {
      echoUser();
      const report = t.slice(t.indexOf(':') + 1).trim();
      if (!report) { devBubble('usage: `bug: <what broke / what you saw>` — ships the newest trace + your report to a verified fix run.'); return true; }
      if (run) { devBubble('a bridge run is already live — `dev: pause` to stop it.'); return true; }
      const att = await buildDecisionsAttachment();
      const model = await getModel();
      const maxTurns = await getTurns();
      const bugPayload = { v: PROTOCOL_V, type: 'run', verb: 'bug', text: report, attachments: att ? [att] : [], model, maxTurns, relay: await getRelay() };
      // DBR-5 (DESIGN §8.2) — a bug run codes against the branch too, so it carries the same scope contract;
      // if this is the conversation's first task, the report seeds the concern.
      const bugConcern = await _ensureConcern(convId, report);
      if (bugConcern) bugPayload.concern = bugConcern;
      startRun(
        bugPayload,
        att ? `bug · ${_short(report, 56)} (+ ${att.filename})` : `bug · ${_short(report, 70)}`,
        { conversationId: convId },
      );
      return true;
    }

    // v2.74.985 — `dev: reset` drops the conversation thread (next `dev:` starts fresh), no run.
    if (lower === 'dev: reset') {
      echoUser();
      await clearLastSession();
      devBubble('thread cleared — the next `dev:` starts a fresh conversation.');
      return true;
    }

    if (isDevVerb) {
      // v2.74.985 — `dev: new <task>` forces a FRESH session (a new, unrelated direction); plain
      // `dev: <reply>` CONTINUES the prior session by default — the bridge is a conversation. (Other
      // `dev: <sub>` verbs were matched above, so only a real ask reaches here.)
      const rest = t.slice(t.indexOf(':') + 1).trim();
      const isNew = /^new\b/i.test(rest);
      const ask = isNew ? rest.replace(/^new\b[:\s]*/i, '').trim() : rest;
      echoUser();
      if (!ask) { devBubble('usage: `dev: <reply>` (continues / resumes the thread) · `dev: new <task>` (fresh) · `gl` (full trace) · `gc` (decisions) · `gch` (chats) · `bug: <what broke>` · `dev: pause` (stop, keep session) · `dev: history` (recent runs) · `dev: relay on|off` (inline approvals) · `dev: concern [<scope>]` (show/edit scope) · `dev: model|turns <…>` · `dev: reset` · `dev: off`'); return true; }
      // DBR-P4-4 — at cap>1, a 2nd dev task in ANOTHER conversation spawns a BACKGROUND run; but NEVER two at once on
      // the SAME conversation (same branch/worktree → they'd clobber), and never past the host's slot cap. At cap=1
      // both checks collapse to the old "one run at a time" (any 2nd task is refused — `_canDispatch` is false once
      // a single run is in flight).
      if (_liveForConv(convId)) { devBubble('this conversation already has a live run — `dev: pause` to stop it.'); return true; }
      if (!_canDispatch()) { devBubble(`all ${_capNow()} run slot${_capNow() === 1 ? '' : 's'} busy — \`dev: pause\` one, or wait.`); return true; }
      // DBR-P4 — a dev run edits whatever tree is LOADED (single-tree, cap=1). If the loaded checkout isn't this
      // conversation's branch, the work lands on the wrong tree — and the host's commit-guard refuses to commit on
      // `main`, so the run does NOTHING for the branch. That mismatch used to surface only later, at `merge` time;
      // guard the run itself the way `merge`/`sync` already do — refuse with a clear `lt` next-step. Fails OPEN (a
      // host that can't answer `currentBranch` never blocks), and is SKIPPED under worktree mode (cap>1, from the
      // last `pool` snapshot): there the host spawns in `.wt/<branch>` regardless of what's loaded.
      const _devConv = convId ? await ConversationStore.load(convId).catch(() => null) : null;
      const convBranch = (_devConv && _devConv.branch) || null;
      const convSurface = (_devConv && _devConv.surface) || null;   // keystone K3 — the conversation's altitude ('high'/'low'); absent → low (host default)
      const worktreeMode = !!(_lastPool && _lastPool.cap > 1);
      if (convBranch && !worktreeMode) {
        const cur = await gitOp('currentBranch');
        if (cur && cur.ok && cur.stdout !== convBranch) {
          devBubble(`✗ \`dev\` — the loaded tree is on \`${cur.stdout || '?'}\`, not this conversation's branch \`${convBranch}\`. \`lt\` to load the branch first so your work lands on it, then send the task. (\`merge\` needs the tree there too.)`);
          return true;
        }
      }
      const model = await getModel();
      const maxTurns = await getTurns();
      // v2.74.1034 (DBR-2) — resume THIS dev conversation's session (per-conversation), not the global key.
      let resumeSessionId = null;
      if (!isNew) resumeSessionId = convId ? await _convResume(convId) : await getLastSession();
      if (isNew) { if (convId) await ConversationStore.patchMeta(convId, { sessionId: null }).catch(() => { /* */ }); else await clearLastSession(); }
      const payload = { v: PROTOCOL_V, type: 'run', verb: 'dev', text: ask, model, maxTurns, relay: await getRelay() };
      if (resumeSessionId) payload.resumeSessionId = resumeSessionId;
      // DBR-5 (DESIGN §8.2) — capture the concern from the first ask, then carry it so the host re-injects the
      // scope contract on this spawn (fresh AND resume). The concern is per-conversation/branch, so `dev: new`
      // (a fresh SESSION on the same branch) keeps it; it's only seeded if none exists yet.
      const concern = await _ensureConcern(convId, ask);
      if (concern) payload.concern = concern;
      // DBR-P4-3b step 4 — send the branch so a CONCURRENT host run spawns in that branch's worktree. Harmless at
      // cap=1 (the host ignores it: repo-root spawn unless ORCHARD_MAX_CONCURRENT>1). Reuses convBranch from the
      // loaded-tree guard above.
      if (convBranch) payload.branch = convBranch;
      if (convSurface) payload.surface = convSurface;   // keystone K3 — carry the conversation's altitude so the host injects the surface preamble (K2/K4)
      startRun(payload, `dev${resumeSessionId ? ' (continuing)' : isNew ? ' (new thread)' : ''} · ${_short(ask, 80)}`, { conversationId: convId, background: _activeRuns() > 0 });   // DBR-P4-4 — first run = foreground; a concurrent one (cap>1) = background
      return true;
    }

    return false;
  }

  // DB-2 — ask the host for the working-tree diffstat; the `diffstat` reply (onHostMsg) updates the icon.
  // No-op when the bridge is off, or when the host is unreachable (not installed) — the icon just stays
  // un-armed; a started run is unaffected since diffstat is a standalone host verb.
  async function refreshReloadState() {
    if (!(await getEnabled())) return;
    try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'diffstat' }); } catch { /* host not reachable */ }
  }

  // DB-3 (v2.74.999) — on startup, ask the host whether a run is still alive so the panel can reattach. The
  // host answers with `status` (probe ack) THEN a `pool` frame listing live runs; v2.74.1104 the `pool` handler
  // rebuilds a stable `devrun-<runId>` bubble per surviving run (the runId it needs isn't on the `status` frame).
  // No-op when off / host unreachable. The detached native `claude.exe` now survives panel close (v2.74.1103).
  async function _probeActiveRun() {
    if (!(await getEnabled())) return;
    try { ensurePort().postMessage({ v: PROTOCOL_V, type: 'status' }); } catch { /* host not reachable */ }
  }

  // chat.js calls this once at startup: register the icon's state listener, then push current state
  // (visibility from the persisted setting) and arm the dot if the tree is already dirty.
  async function onReloadState(fn) {
    reloadListener = typeof fn === 'function' ? fn : null;
    const enabled = await getEnabled();
    emitReload({ enabled });
    if (enabled) { refreshReloadState(); _probeActiveRun(); _runWorktreeGc().catch(() => { /* */ }); _categorizeExistingDevConvs(); }   // DBR-P4-7 — reconcile leftover `.wt/` worktrees on startup; .1099 — backfill scope-category labels
  }
  // v2.74.1099 — one-time backfill: retitle EXISTING dev conversations from the session shortid to their SCOPE
  // CATEGORY (from the stored concern). Idempotent (no-op once a title already matches its category) and host-free
  // (pure storage + scopeCategory), so it runs regardless of run-pool ownership. Loads only the dev rows.
  async function _categorizeExistingDevConvs() {
    try {
      const list = await ConversationStore.list();
      for (const c of (Array.isArray(list) ? list : [])) {
        if (!c || c.kind !== 'dev') continue;
        try { const full = await ConversationStore.load(c.id); if (full && full.concern) _applyScopeTitle(full, full.concern); } catch { /* */ }
      }
    } catch { /* */ }
  }

  // The reload action itself — restarts the WHOLE extension (the spec's "Apply & Reload"), which closes
  // the panel; the user reopens via the toolbar icon. Committing stays human (terminal `cp`/`bcp`).
  // v2.74.980 — stamp the current tree signature as the applied baseline BEFORE reloading (await, so it's
  // durably persisted before the process restarts). After the reload, the post-reload diffstat matches
  // this baseline and the dot clears; the next edit changes the signature and re-arms it.
  async function reloadExtension() {
    try { await setAppliedSig(reloadState.sig || ''); } catch { /* */ }
    try { chrome.runtime.reload(); } catch { /* */ }
  }

  // DBR-4 (v2.74.1036, DESIGN §4) — replace a devBubble's body with a single text block (the lt status line is
  // optimistic; on failure we rewrite it in place). Mirrors devBubble's render + persist so the message reads
  // the same after the swap.
  function _setBubble(b, text) {
    try {
      if (!b || !b.bodyEl) return;
      b.bodyEl.textContent = '';
      const block = { kind: 'text', text };
      b.blocks.length = 0; b.blocks.push(block);
      b.bodyEl.appendChild(_blockNode(block));
      _persistBlocks(b.msg, b.blocks);
    } catch { /* a render throw must not break the flow */ }
  }

  // DBR-4 (v2.74.1036, DESIGN §4) — the `lt` flow: WIP-commit the CURRENT branch (so the tree is clean for the
  // switch) → host `git switch` the loaded folder to THIS dev conversation's branch → reload the extension,
  // which re-reads the now-swapped files. All git is host-side, parameter-validated (§3); the panel only relays
  // via gitOp. Phase 1 is single-tree + serial — no worktree/preview yet (those are Phase 4). The reload CLOSES
  // the panel (reopen via the toolbar icon to see the branch live), so this is the last thing the flow does.
  async function _liveTest(convId, opts = {}) {
    const force = opts.force === true;
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `lt` — no branch is recorded for this dev conversation, so there’s nothing to live-test.'); return; }
    // v2.74.1043 (DESIGN §4 guardrail) — single-tree `lt` does a full reload onto the branch, so a branch BEHIND
    // main reverts the WHOLE panel to that older code: you silently lose newer panel features (e.g. the DBR-5/DBR-6
    // concern + dev header). Warn + refuse by default; `lt!`/`lt force` overrides. Uses the same read-only
    // `aheadBehind` op the DBR-6 header uses (`git rev-list --left-right --count main...<branch>` → "<behind>\t<ahead>",
    // so parts[0] is how far the branch is BEHIND main). Fails OPEN: a host that's unreachable or an unparseable
    // answer must NOT block `lt` — only a confidently-positive behind count refuses.
    if (!force) {
      const steer = archivedSteer(conv, 'lt');   // DBR-P4 — a merged/abandoned branch is done; steer to `fork` (lt! still overrides)
      if (steer) { devBubble(steer); return; }
      let behind = 0;
      try {
        const ab = await gitOp('aheadBehind', { a: 'main', b: branch });
        if (ab && ab.ok && typeof ab.stdout === 'string') behind = Number(ab.stdout.trim().split(/\s+/)[0]) || 0;
      } catch { behind = 0; }
      if (behind > 0) {
        devBubble(`⚠ \`lt\` — \`${branch}\` is ${behind} commit${behind === 1 ? '' : 's'} behind \`main\`. Switching reloads the **whole** extension onto that older code, so newer panel features (e.g. the dev header / concern) will disappear until you switch back. Type \`lt!\` to switch anyway, or bring the branch up to date with \`main\` first (Phase 2 \`sync\`).`);
        return;
      }
    }
    const bubble = devBubble(`↻ switching to \`${branch}\` and reloading…`);
    // DBR-P4-5 (§10) — worktree mode (cap>1): `lt` points the PREVIEW worktree (`.wt/preview`, the folder Chrome
    // loads) at the branch's tip via a DETACHED checkout, leaving the repo-root `main` + the branch's own worktree
    // untouched (so a branch can be live-tested WHILE its agent still runs in its worktree). The repo-root single-tree
    // path below (commitWip + switch) is the cap=1 legacy, unchanged. This needs the one-time Chrome re-point
    // (Load-unpacked `.wt/preview`) to take VISIBLE effect; until then the branch is inert (cap=1 never enters it).
    if (ltUsesPreview(_capNow())) {
      const plan = previewRepointPlan(branch);
      if (!plan) { _setBubble(bubble, `✗ \`lt\` — \`${branch}\` isn't a dev branch; the preview only shows a dev branch's tip.`); return; }
      // DBR (eyeball fix, v2.74.1133) — CHECKPOINT the branch's worktree FIRST. The preview reads the branch's
      // COMMITTED tip, so without this the dev session's uncommitted edits are invisible ("no changes reflected").
      // Mirrors sync/merge's `commitWip {worktree}`. Best-effort: nothing-to-commit / a clean tree is fine → repoint
      // the last committed state (no worse than before); a real failure still falls through (the preview shows HEAD).
      _setBubble(bubble, `↻ checkpointing \`${branch}\` then pointing the preview at it…`);
      await gitOp('commitWip', { message: `lt → ${branch}` }, { worktree: branch });
      _setBubble(bubble, `↻ pointing the preview at \`${branch}\` and reloading…`);
      for (const step of plan) {
        const r = await gitOp(step.op, step.params);
        if ((!r || !r.ok) && !step.optional) { _setBubble(bubble, `✗ \`lt\` — couldn’t point the preview at \`${branch}\`: ${(r && r.error) || 'host unreachable'}.`); return; }
      }
      await reloadExtension();
      return;
    }
    // 1) checkpoint the CURRENT branch so `git switch` has a clean tree — but only when we're ON a dev branch.
    // The host commit-guard refuses to commit on main (correct — never commit to main), so on a non-dev branch
    // commitWip returns "not on a dev branch". That is NOT fatal (v2.74.1040 fix — the old code aborted on it, so
    // `lt` could never bootstrap from main): we never checkpoint main; instead switch directly when the tree is
    // clean, and refuse with a clear next step when it's dirty (don't carry uncommitted work across the switch).
    const wip = await gitOp('commitWip', { message: `lt → ${branch}` });
    const guardBlocked = wip && !wip.ok && /not on a dev branch/i.test(String(wip.error || ''));
    if ((!wip || !wip.ok) && !guardBlocked) { _setBubble(bubble, `✗ \`lt\` — couldn’t checkpoint the current branch: ${(wip && wip.error) || 'host unreachable'}. Not switching.`); return; }
    if (guardBlocked) {
      let dirty = false;
      try { const st = await gitOp('status'); dirty = !!(st && st.ok && (st.dirty === true || (typeof st.porcelain === 'string' && st.porcelain.trim()) || (Array.isArray(st.changed) && st.changed.length) || (typeof st.changed === 'number' && st.changed > 0))); } catch { dirty = false; }
      if (dirty) { _setBubble(bubble, `✗ \`lt\` — the loaded tree is on a non-dev branch (e.g. main) with uncommitted changes, so it can’t live-test \`${branch}\` cleanly. Commit or stash your changes first (the bridge never commits to main), then \`lt\`.`); return; }
      // clean non-dev branch → no checkpoint needed; fall through to the switch.
    }
    // 2) switch the loaded folder to this conversation's branch (lt:true → the host logs the LT ▸ decision marker).
    const sw = await gitOp('switch', { branch, lt: true });
    if (!sw || !sw.ok) { _setBubble(bubble, `✗ \`lt\` — couldn’t switch to \`${branch}\`: ${(sw && sw.error) || 'host unreachable'}.`); return; }
    // 3) reload so Chrome re-reads the swapped files (stamps the applied baseline first, then restarts).
    await reloadExtension();
  }

  // DBR-P2-2 (DESIGN §5/§6.2) — `sync`: pull current `main` into THIS conversation's branch (catch up). Single-tree
  // Phase 2: the loaded tree must already be ON the conversation's branch (`lt` there first) — we never merge main
  // into the wrong branch, so a mismatch refuses with a clear next step. commitWip checkpoints the branch, then
  // `syncMain` merges main in; `planSync` classifies. Clean → record the synced-onto main commit (feeds the P2-5
  // freshness check) + report. Conflict → leave the branch's work checkpointed + the merge paused, hand to the human
  // (the §6.2 auto-resolution run is P2-2b). Error → report. The host logs the `SYNC ▸` decision marker on syncMain.
  async function _sync(convId) {
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `sync` — no branch is recorded for this dev conversation, so there’s nothing to sync.'); return; }
    { const steer = archivedSteer(conv, 'sync'); if (steer) { devBubble(steer); return; } }   // DBR-P4 — merged/abandoned → steer to fork
    const wt = _capNow() > 1 ? branch : undefined;   // DBR-#1 — at cap>1 sync runs in the branch's `.wt/` worktree, not the repo root
    const cur = await gitOp('currentBranch', {}, { worktree: wt });
    if (!cur || !cur.ok || cur.stdout !== branch) {
      devBubble(`✗ \`sync\` — the loaded tree is on \`${(cur && cur.stdout) || '?'}\`, not this conversation's branch \`${branch}\`. \`lt\` to switch there first, then \`sync\`.`);
      return;
    }
    const bubble = devBubble(`↻ syncing \`${branch}\` with \`main\`…`);
    const wip = await gitOp('commitWip', { message: `sync ${branch}` }, { worktree: wt });
    if (!wip || !wip.ok) { _setBubble(bubble, `✗ \`sync\` — couldn’t checkpoint \`${branch}\` before merging: ${(wip && wip.error) || 'host unreachable'}.`); return; }
    const plan = planSync(await gitOp('syncMain', {}, { worktree: wt }));
    if (plan.status === 'clean') {
      const mainRef = await gitOp('revParse', { ref: 'main' });
      const mainSha = String((mainRef && mainRef.ok && mainRef.stdout) || '').trim();
      try { await ConversationStore.patchMeta(convId, { syncedMain: mainSha }); } catch { /* record is best-effort */ }
      _setBubble(bubble, `✓ synced \`${branch}\` onto \`main@${mainSha.slice(0, 7) || '?'}\`.`);
    } else if (plan.status === 'conflict') {
      const where = plan.files.length ? plan.files.map((f) => '`' + f + '`').join(', ') : 'one or more files';
      _setBubble(bubble, `⚠ \`sync\` hit merge conflicts in ${where}. Your branch work is checkpointed and the merge is paused — resolve the conflicts in the worktree/terminal and commit, then re-run \`sync\` (auto-resolution lands in P2-2b).`);
    } else {
      _setBubble(bubble, `✗ \`sync\` — merge failed: ${plan.detail}.`);
    }
  }

  // DBR-P2-3 (DESIGN §6 steps 1–4) — the `merge` PREPARE half (lock-free; the squash-LAND + confirm is P2-4).
  // Single-tree: requires the loaded tree is ON the conversation's branch. WIP-commit → sync (P2-2a; conflict/error
  // STOPS, no merge) → test gate (`npm test` via the host, ONE retry on red — U14; still red STOPS) → diff preview
  // (`git diff --stat main...<branch>`). Then HALTS awaiting the human's land confirm (P2-4). `MERGE ▸` markers
  // are host-side (the syncMain + test ops log them). NB: the test-gate EXECUTION (host npm spawn) is live-only.
  async function _mergePrepare(convId, opts = {}) {
    const autoDeploy = opts.autoDeploy === true;   // surfaces-§4.4 — set by the review gate's Approve (not the typed `merge`) → land also redeploys live
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `merge` — no branch is recorded for this dev conversation.'); return; }
    { const steer = archivedSteer(conv, 'merge'); if (steer) { devBubble(steer); return; } }   // DBR-P4 — merged/abandoned → steer to fork
    // DBR-#1 (§7.2) — at cap>1 the branch lives in its OWN `.wt/` worktree, so the prepare ops (checkpoint · sync · test)
    // run THERE (on the branch's real changes) while the land still lands on repo-root `main`. At cap=1 `wt` is
    // undefined → every op runs in the repo root, exactly as before (and the guard below still needs an `lt` there).
    const wt = _capNow() > 1 ? branch : undefined;
    const cur = await gitOp('currentBranch', {}, { worktree: wt });   // at cap>1 reads the worktree (= the branch) → guard passes
    if (!cur || !cur.ok || cur.stdout !== branch) {
      devBubble(`✗ \`merge\` — the loaded tree is on \`${(cur && cur.stdout) || '?'}\`, not \`${branch}\`. \`lt\` to switch there first, then \`merge\`.`);
      return;
    }
    const bubble = devBubble(`↻ preparing to merge \`${branch}\` → \`main\`…`);
    // 1) checkpoint
    const wip = await gitOp('commitWip', { message: `merge-prep ${branch}` }, { worktree: wt });
    if (!wip || !wip.ok) { _setBubble(bubble, `✗ \`merge\` — couldn’t checkpoint \`${branch}\`: ${(wip && wip.error) || 'host unreachable'}.`); return; }
    // 2) sync main into the branch (reuse P2-2a's classifier)
    _setBubble(bubble, `↻ merge: syncing \`${branch}\` with \`main\`…`);
    const sync = planSync(await gitOp('syncMain', {}, { worktree: wt }));
    if (sync.status === 'conflict') {
      const where = sync.files.length ? sync.files.map((f) => '`' + f + '`').join(', ') : 'one or more files';
      _setBubble(bubble, `⚠ \`merge\` stopped — sync hit conflicts in ${where}. Resolve + commit, then re-run \`merge\` (no merge happened; \`main\` is untouched).`); return;
    }
    if (sync.status === 'error') { _setBubble(bubble, `✗ \`merge\` stopped — sync failed: ${sync.detail}.`); return; }
    // DBR-P2-5 — record the `main` commit we synced onto, so the land can detect an out-of-band `main` move (§7.2).
    const sm0 = await gitOp('revParse', { ref: 'main' });
    const syncedMain = String((sm0 && sm0.ok && sm0.stdout) || '').trim();
    // 3) test gate — one automatic retry (real suites flake; U14)
    _setBubble(bubble, `↻ merge: running the test gate (\`npm test\`)…`);
    let t = await hostTest({ worktree: wt });
    if (!t.ok) { _setBubble(bubble, `↻ merge: tests red — one automatic retry…`); t = await hostTest({ worktree: wt }); }
    if (!t.ok) {
      _setBubble(bubble, `✗ \`merge\` stopped — tests still red after a retry${t.code != null ? ` (exit ${t.code})` : ''}. No merge; \`main\` is untouched.${t.tail ? '\n```\n' + t.tail + '\n```' : ''}`); return;
    }
    // 4) diff preview — but only OFFER to land if there's actually something to merge. A no-change branch makes
    //    `git merge --squash` stage NOTHING, so the land's commit fails "nothing to commit" (DBR-P2-4 live-test, .1048).
    const diff = await gitOp('diffStat', { a: 'main', b: branch });
    const stat = String((diff && diff.ok && diff.stdout) || '').trim();
    if (!mergeHasChanges(stat)) {
      _setBubble(bubble, `✓ \`${branch}\` is synced with \`main\` + green — but it has **no changes vs \`main\`** (already up to date). Nothing to land.`);
      return;
    }
    const summary = buildMergeSummary({ concern: conv.concern, title: conv.title, diffStat: stat });
    _setBubble(bubble, `✓ \`${branch}\` is synced with \`main\` + green. This will squash-merge it onto \`main\` as ONE commit:\n\n**${summary.subject}**\n\`\`\`\n${stat}\n\`\`\`\n\`main\` is mutated **locally only** — push stays manual (\`cp\`). Confirm to land:`);
    // append confirm / cancel buttons — the closure captures the prepared {branch, summary, syncedMain} (no stale state).
    try {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      const go = mkBtn('Confirm land ▸', () => { try { actions.remove(); } catch { /* */ } _mergeLand(convId, { branch, summary, syncedMain, autoDeploy }); });
      const no = mkBtn('Cancel', () => { try { actions.remove(); } catch { /* */ } devBubble(`✗ merge cancelled — \`${branch}\` is synced + green but NOT landed. \`main\` is untouched.`); });
      actions.appendChild(go); actions.appendChild(no);
      bubble.bodyEl.appendChild(actions);
    } catch { /* no buttons (older host wiring) → re-run `merge` */ }
  }

  // DBR-P2-4 (DESIGN §6/§6.1/§6.3) — the merge LAND, fired by the human's confirm tap. Squash-merges the branch
  // onto `main` and commits with the merge-summary + a `Dev-conversation:<id>` trailer (the host's gated ops, each
  // carrying a freshly-minted confirm token — P2-1). LOCAL-ONLY: push stays manual (§6 step 7), so a bad land is a
  // local `main` commit the user can inspect + `git reset`/`merge --abort` before pushing. Marks the conversation
  // merged (archived). DBR-P2-5 adds the freshness re-check below — nothing lands on a `main` it wasn't synced+green against.
  async function _mergeLand(convId, { branch, summary, syncedMain, autoDeploy = false }) {
    const bubble = devBubble(`↻ landing \`${branch}\` → \`main\`…`);
    let landed = null, preMain = null;   // DBR-P4-7 — the merge commit + the pre-land `main` HEAD, captured on success → drive the post-release drift broadcast (below)
    const wt = _capNow() > 1 ? branch : undefined;   // DBR-#1 — at cap>1 the freshness re-sync/re-test run in the branch's worktree; the land still lands on repo-root main
    // DBR-P4-6 (DESIGN §7.2) — acquire the single LAND lock. Prepare ran lock-free; here concurrent lands queue FIFO
    // (the bubble shows "waiting to merge — Nth in line") and each re-runs its freshness re-check below against the
    // `main` the one ahead just produced. ALWAYS release in the finally — a held lock would wedge every queued merge.
    const release = await _mergeLock.acquire(convId || branch || 'land', (pos) => {
      try { console.info(`MERGE_LOCK ▸ ${branch} queued — ${_ordinal(pos)} in line`); } catch { /* */ }
      _setBubble(bubble, `⏳ waiting to merge — ${_ordinal(pos)} in line (another land is landing on \`main\`)…`);
    });
    try { console.info(`MERGE_LOCK ▸ ${branch} acquired the land lock`); } catch { /* */ }
    _setBubble(bubble, `↻ landing \`${branch}\` → \`main\`…`);   // clears any "waiting…" text once we hold the lock
    try {
    // DBR-P2-5 (DESIGN §7.2) — FRESHNESS: re-read `main`'s HEAD; if it moved since prepare (another merge or an
    // out-of-band commit landed meanwhile), re-sync the branch onto the new `main` + re-run the test gate BEFORE
    // landing, so nothing ever lands on a `main` it wasn't synced+green against. (The lock/FIFO queue is Phase 4.)
    const headNow = await gitOp('revParse', { ref: 'main' });
    const currentMain = String((headNow && headNow.ok && headNow.stdout) || '').trim();
    if (isMainStale(syncedMain, currentMain)) {
      _setBubble(bubble, `↻ land: \`main\` moved since prepare (${(syncedMain || '?').slice(0, 7)} → ${currentMain.slice(0, 7) || '?'}) — re-syncing + re-testing before landing…`);
      if (!wt) {   // cap=1: ensure the repo root is back ON the branch before re-syncing (at cap>1 the worktree already is)
        const cur = await gitOp('currentBranch');
        if (!cur || !cur.ok || cur.stdout !== branch) {
          const back = await gitOp('switch', { branch });
          if (!back || !back.ok) { _setBubble(bubble, `✗ land aborted — couldn’t switch back to \`${branch}\` to re-sync: ${(back && back.error) || '?'}. \`main\` is untouched.`); return; }
        }
      }
      const resync = planSync(await gitOp('syncMain', {}, { worktree: wt }));
      if (resync.status === 'conflict') { _setBubble(bubble, `✗ land aborted — re-sync onto the new \`main\` hit conflicts in ${resync.files.length ? resync.files.map((f) => '`' + f + '`').join(', ') : 'files'}. Resolve + commit, then re-run \`merge\`. \`main\` is untouched.`); return; }
      if (resync.status === 'error') { _setBubble(bubble, `✗ land aborted — re-sync failed: ${resync.detail}. \`main\` is untouched.`); return; }
      let rt = await hostTest({ worktree: wt }); if (!rt.ok) rt = await hostTest({ worktree: wt });
      if (!rt.ok) { _setBubble(bubble, `✗ land aborted — after re-syncing onto the new \`main\`, tests are red${rt.code != null ? ` (exit ${rt.code})` : ''}. No merge; \`main\` is untouched.`); return; }
    }
    // 1) switch the loaded tree to main (the host's mergeSquash/commitMerge require current === main)
    const sw = await gitOp('switch', { branch: 'main' });
    if (!sw || !sw.ok) { _setBubble(bubble, `✗ land — couldn’t switch to \`main\`: ${(sw && sw.error) || 'host unreachable'}. \`main\` is unchanged.`); return; }
    // 2) squash-merge the branch onto main (gated — fresh token)
    const tok1 = await hostConfirmToken();
    if (!tok1 || !tok1.token) { _setBubble(bubble, `✗ land — couldn’t mint a confirm token: ${(tok1 && tok1.error) || '?'}. \`main\` is unchanged.`); return; }
    const sq = await gitOp('mergeSquash', { branch, confirmToken: tok1.token });
    if (!sq || !sq.ok) { _setBubble(bubble, `✗ land — squash-merge failed: ${(sq && sq.error) || '?'}. Check \`git status\` on \`main\` (you may need \`git merge --abort\`).`); return; }
    // 2b) version-at-land (docs/DESIGN_surfaces.md §4.2) — stamp `main`'s manifest version to current+1 on the STAGED
    //     squash, so the landed version is monotonic + unique regardless of what the branch bumped to. commitMerge's
    //     `-am` then carries this one tracked modification into the single squash commit (below).
    const vs = await hostStampVersion();
    if (!vs || !vs.ok) { _setBubble(bubble, `✗ land — version stamp failed: ${(vs && vs.error) || '?'}. The squash is STAGED on \`main\` but not committed — \`git commit\` or \`git reset --hard\` to back out.`); return; }
    try { console.info(`VERSION ▸ stamp ${branch} → main ${vs.version}${vs.from ? ` (was ${vs.from})` : ''}`); } catch { /* */ }
    // 3) commit the staged squash on main (gated — fresh token) with the summary + Dev-conversation trailer
    const tok2 = await hostConfirmToken();
    if (!tok2 || !tok2.token) { _setBubble(bubble, `✗ land — couldn’t mint the commit token. The squash is STAGED on \`main\` but not committed — \`git commit\` or \`git reset --hard\` to back out.`); return; }
    const cm = await gitOp('commitMerge', { message: buildMergeCommitMessage(summary, convId), confirmToken: tok2.token });
    if (!cm || !cm.ok) { _setBubble(bubble, `✗ land — commit failed: ${(cm && cm.error) || '?'}. The squash is staged on \`main\` — \`git commit\` or \`git reset --hard\` to back out.`); return; }
    // 4) record the merge + archive the conversation (DESIGN §6.1)
    const head = await gitOp('revParse', { ref: 'HEAD' });
    const mergeCommit = String((head && head.ok && head.stdout) || '').trim();
    try { await ConversationStore.patchMeta(convId, { status: 'merged', mergedAt: Date.now(), mergeCommit }); } catch { /* archive is best-effort */ }
    _setBubble(bubble, `✓ merged \`${branch}\` → \`main\` as \`${mergeCommit.slice(0, 7) || '?'}\` (one squash commit). This conversation is archived (merged); the loaded tree is on \`main\`. **Push stays manual** — run \`cp\` when ready to publish.`);
    landed = mergeCommit; preMain = currentMain;   // DBR-P4-7 — mark success + the squash's parent; the drift broadcast runs AFTER the lock releases (below)
    } finally {
      try { console.info(`MERGE_LOCK ▸ ${branch} released the land lock`); } catch { /* */ }
      release();   // free the land lock → auto-promotes the next queued land (which then re-checks freshness)
    }
    // DBR-P4-7 (DESIGN §7) — post-land, lock RELEASED: nudge the OTHER live dev branches that now drift from `main`.
    // Best-effort + non-blocking — a broadcast failure never touches the just-completed land.
    if (landed) { try { await _broadcastDrift(convId, branch, landed, preMain); } catch { /* */ } _runWorktreeGc().catch(() => { /* */ }); }   // DBR-P4-7 — the merged branch's worktree can be reclaimed
    // surfaces-§4.4 (Approve-scoped auto-deploy) — "approved → live": when the land came from the review gate's Approve
    // (NOT the typed `merge` verb), redeploy the landed `main` to the live build. LAST thing — reloadExtension restarts
    // the extension, so the drift broadcast + GC above run first. Host-code (`bridge/`) lands still need a manual host
    // respawn to take effect (deferred — slice 2b).
    if (landed && autoDeploy) {
      // Detect whether the land touched HOST code (`bridge/`) from the clean diff path-set (not the stat lines), so the
      // host-refresh is legible: panel code is live on the reload below, but the host only refreshes on the panel reopen
      // (a fresh native-messaging host loads the landed repo-root `bridge/host.js`). See landTouchedHost.
      let hostTouched = false;
      try { const dn = await gitOp('diffNames', { a: preMain, b: landed }); hostTouched = landTouchedHost(String((dn && dn.ok && dn.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)); } catch { /* best-effort — a diff failure just omits the note */ }
      try { console.info(`DEPLOY ▸ approve → main live (${String(landed).slice(0, 7)})${hostTouched ? ' [host code — refreshes on reopen]' : ''}`); } catch { /* */ }
      if (hostTouched) devBubble('⚙ This land changed `bridge/` (host) code. The panel reloads now; the **host** refreshes automatically when you **reopen the panel** — a fresh native-messaging host loads the landed `bridge/host.js`.');
      await _redeployToMain();
    }
  }

  // surfaces-§4.4 — push the landed `main` to the live build: at cap>1 repoint the preview worktree at `main` (the
  // un-gated previewToMainPlan), then reload; at cap=1 the loaded tree (repo root) is already on `main` after a land, so
  // a reload alone applies it. Mirrors _regress's deploy half (minus the archive). reloadExtension CLOSES the panel.
  async function _redeployToMain() {
    if (ltUsesPreview(_capNow())) {
      for (const step of previewToMainPlan()) {
        const r = await gitOp(step.op, step.params);
        if ((!r || !r.ok) && !step.optional) return false;   // a preview-repoint failure → skip the reload (don't strand on a half-pointed preview)
      }
    } else {
      // cap=1: the loaded tree IS the repo root — point it at `main` before reloading. A no-op after an Approve land
      // (already switched there), but the necessary correction when called from "Preview main" with the tree on a dev
      // branch (else the reload would re-load that branch, not the trunk). Mirrors _regress's cap=1 branch; a dirty-tree
      // switch failure → skip the reload (don't strand). (v2.74.1146 — bcp catch.)
      const sw = await gitOp('switch', { branch: 'main' });
      if (!sw || !sw.ok) return false;
    }
    await reloadExtension();
    return true;
  }

  // DBR-P2-6 (DESIGN §5/U13) — `abandon` (SOFT): archive the conversation (status → 'abandoned', read-only) but
  // KEEP the branch — fully recoverable, no git mutation. (The drawer's Merged/Abandoned grouping is a separate
  // chat.js render concern; this flips the data.)
  async function _abandon(convId) {
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `abandon` — no branch is recorded for this dev conversation.'); return; }
    try { await ConversationStore.patchMeta(convId, { status: 'abandoned' }); } catch { /* best-effort */ }
    devBubble(`✗ abandoned — this conversation is archived (read-only). The branch \`${branch}\` is KEPT (recoverable). Type \`delete branch\` to remove it permanently.`);
  }

  // DBR (regress, v2.74.1133) — abandon this conversation's change AND snap the LIVE build back to `main`: point the
  // preview at `main` (the un-gated previewToMainPlan) + reload + archive (status 'abandoned'). The branch is KEPT
  // (recoverable via `fork`), exactly like `abandon`; regress just ALSO reverts the preview so the panel returns to
  // the last `main` build. NO `main` mutation, no force-reset — the dev branch's commits stay on the branch.
  async function _regress(convId) {
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = (conv && conv.branch) || null;
    const bubble = devBubble('↻ regress — reverting the live build to `main`…');
    if (ltUsesPreview(_capNow())) {
      for (const step of previewToMainPlan()) {
        const r = await gitOp(step.op, step.params);
        if ((!r || !r.ok) && !step.optional) { _setBubble(bubble, `✗ \`regress\` — couldn’t point the preview at \`main\`: ${(r && r.error) || 'host unreachable'}.`); return; }
      }
    } else {
      const sw = await gitOp('switch', { branch: 'main' });
      if (!sw || !sw.ok) { _setBubble(bubble, `✗ \`regress\` — couldn’t switch the loaded tree to \`main\` (commit/stash branch work first?): ${(sw && sw.error) || 'host unreachable'}.`); return; }
    }
    await reloadExtension();
    try { await ConversationStore.patchMeta(convId, { status: 'abandoned' }); } catch { /* best-effort */ }
    _setBubble(bubble, `✓ regressed — the live build is back on \`main\` and this conversation is archived. The branch${branch ? ` \`${branch}\`` : ''} is KEPT (type \`fork\` to revive it).`);
  }

  // surfaces-§4.3 (the review gate) — the contextual Review card. After a successful dev run that CHANGED files, the
  // land verbs become buttons at the right moment: Approve → the existing `merge` prepare (WIP→sync→test→diff→Confirm-
  // land, version-at-land stamps the version); Preview → `lt` (load this branch to eyeball); Discard → `regress` (snap
  // the live build back to `main` + archive); Keep working → dismiss. NON-modal — ignore it and type the verbs as
  // before. Gated by getReviewGate() + the pure shouldOfferReview() (dev conversation, not archived, has changes).
  async function _offerReview(convId) {
    if (!(await getReviewGate())) return;
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) return;
    // Read the changes the run made in the tree it RAN in: at cap>1 the branch's own `.wt/` worktree; at cap=1 the
    // repo root (mirrors _mergePrepare/_sync's `wt`). The global diffstat reads the repo root only, so it'd miss a
    // cap>1 run's edits — query the worktree directly so the gate is cap-correct.
    const wt = _capNow() > 1 ? branch : undefined;
    const st = await gitOp('status', {}, { worktree: wt });
    const changed = parsePorcelainFiles(st && st.ok ? st.stdout : '');
    if (!shouldOfferReview({ ok: true, replay: false, pausing: false, conversationId: convId, status: conv && conv.status, fileCount: changed.length })) return;
    const n = changed.length;
    const shown = changed.slice(0, 6).map((f) => `\`${f}\``).join(', ');
    const more = n > 6 ? `, +${n - 6} more` : '';
    const bubble = devBubble(`✦ Review \`${branch}\` — ${n} file${n === 1 ? '' : 's'} changed: ${shown}${more}\n\n_Approve to sync + test + land on \`main\` (then go live), Preview to load this branch, or Discard to drop it._`);
    try {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap';
      // Approve → the merge prepare with autoDeploy:true so a successful land also redeploys `main` to the live build (§4.4).
      const approve = mkBtn('Approve ▸', () => { try { actions.remove(); } catch { /* */ } _mergePrepare(convId, { autoDeploy: true }); });
      const preview = mkBtn('Preview', () => { try { actions.remove(); } catch { /* */ } _liveTest(convId); });
      const discard = mkBtn('Discard', () => { try { actions.remove(); } catch { /* */ } _regress(convId); });
      const keep = mkBtn('Keep working', () => { try { actions.remove(); } catch { /* */ } _setBubble(bubble, `✦ Review dismissed — \`${branch}\`'s changes are kept; type \`merge\` when you're ready to land.`); });
      [approve, preview, discard, keep].forEach((b) => actions.appendChild(b));
      bubble.bodyEl.appendChild(actions);
    } catch { /* no buttons → the offer stays as text; the verbs still work */ }
    try { console.info(`REVIEW ▸ offer ${branch} — ${n} file(s) changed`); } catch { /* */ }
  }

  // keystone K3 — show or SET this dev conversation's surface (altitude). Stored on the conversation record; ABSENT =
  // 'low' (Dev), so existing conversations need no migration. The next `dev:` run reads it + carries it to the host,
  // which injects the surface preamble (K2/K4). SURFACE ▸ marker (panel-side; the host logs its own at spawn).
  async function _handleSurface(convId, parsed) {
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const label = (s) => (s === 'high' ? 'Design (high-level / conceptual)' : 'Dev (low-level / implementation)');
    if (parsed.show) {
      const cur = (conv && conv.surface) || 'low';
      devBubble(`surface — this conversation is **${label(cur)}**. \`surface high\` (Design) / \`surface low\` (Dev) to change — applies to the next \`dev:\` run.`);
      return;
    }
    const next = parsed.set === 'high' ? 'high' : 'low';
    try { await ConversationStore.patchMeta(convId, { surface: next }); } catch { /* best-effort */ }
    try { console.info(`SURFACE ▸ set ${next}`); } catch { /* */ }
    devBubble(`✓ surface → **${label(next)}**. The next \`dev:\` run spawns at this altitude.`);
  }

  // DBR-P2-6 (DESIGN §5/U13) — `delete branch` (HARD): irreversible. A confirm button → gated host `branchDelete`
  // (P2-1; needs a fresh token). Can't delete the checked-out branch, so we switch off it first. Then archive.
  async function _deleteBranch(convId) {
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `delete branch` — no branch is recorded for this dev conversation.'); return; }
    const bubble = devBubble(`⚠ \`delete branch\` — permanently delete \`${branch}\`? This is **irreversible**: any commits on it not merged to \`main\` are lost.`);
    try {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      const go = mkBtn('Delete branch ⌫', async () => {
        try { actions.remove(); } catch { /* */ }
        const cur = await gitOp('currentBranch');                          // can't delete the checked-out branch
        if (cur && cur.ok && cur.stdout === branch) {
          const sw = await gitOp('switch', { branch: 'main' });
          if (!sw || !sw.ok) { _setBubble(bubble, `✗ delete — couldn’t switch off \`${branch}\` first: ${(sw && sw.error) || '?'}.`); return; }
        }
        const tok = await hostConfirmToken();
        if (!tok || !tok.token) { _setBubble(bubble, `✗ delete — couldn’t mint a confirm token: ${(tok && tok.error) || '?'}.`); return; }
        const del = await gitOp('branchDelete', { branch, confirmToken: tok.token });
        if (!del || !del.ok) { _setBubble(bubble, `✗ delete — failed: ${(del && del.error) || '?'}.`); return; }
        try { await ConversationStore.patchMeta(convId, { status: 'abandoned' }); } catch { /* */ }
        _setBubble(bubble, `✓ deleted branch \`${branch}\` permanently. This conversation is archived (abandoned).`);
      });
      const no = mkBtn('Cancel', () => { try { actions.remove(); } catch { /* */ } _setBubble(bubble, `✗ delete cancelled — \`${branch}\` is kept.`); });
      actions.appendChild(go); actions.appendChild(no);
      bubble.bodyEl.appendChild(actions);
    } catch { /* no buttons → re-run `delete branch` */ }
  }

  // DBR-P2-7 (DESIGN §5/§7) — `drift`: does THIS branch overlap with main's recent changes? Read-only, no LLM,
  // never blocks (§7). Computes the fork point (merge-base), the files main changed since then, the files the
  // branch changed, and their intersection (`computeDrift`); flags foundational/shared files. The AUTOMATIC
  // cross-branch broadcast (nudge OTHER live branches after a merge) is a follow-up — this is the on-demand check.
  async function _driftCheck(convId) {
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `drift` — no branch is recorded for this dev conversation.'); return; }
    const bubble = devBubble(`↻ checking drift of \`${branch}\` vs \`main\`…`);
    const base = await gitOp('mergeBase', { a: 'main', b: branch });
    const baseSha = String((base && base.ok && base.stdout) || '').trim();
    if (!baseSha) { _setBubble(bubble, `✗ \`drift\` — couldn’t find the fork point with \`main\`: ${(base && base.error) || 'host unreachable'}.`); return; }
    const [mainD, branchD] = await Promise.all([
      gitOp('diffNames', { a: baseSha, b: 'main' }),     // files main changed since the fork
      gitOp('diffNames', { a: baseSha, b: branch }),     // files this branch changed since the fork
    ]);
    const split = (r) => String((r && r.ok && r.stdout) || '').split(/\r?\n/);
    const drift = computeDrift(split(mainD), split(branchD));
    if (!drift.length) {
      _setBubble(bubble, `✓ no drift — \`${branch}\` and \`main\` haven’t changed the same files since the fork. Safe to \`merge\` (it'll still sync + test first).`);
      return;
    }
    const flagged = drift.map((f) => isFoundationalFile(f) ? '`' + f + '` ⚠' : '`' + f + '`').join(', ');
    _setBubble(bubble, `⚠ drift — \`main\` and this branch both changed ${flagged} since the fork. \`sync\` to fold main's changes in before you \`merge\` (⚠ = foundational/shared file). Warning only — nothing is blocked.`);
  }

  // DBR-P4-7 (DESIGN §7) — the AUTOMATIC counterpart to `_driftCheck`: after a successful land, NUDGE the OTHER live
  // dev branches that overlap what just landed. Best-effort + non-blocking (the caller wraps it): a broadcast failure
  // NEVER affects the completed land. Reuses the pure `driftBroadcastSet` over each other live branch's changed-file
  // set; posts a one-line `sync` nudge INTO each drifting conversation's transcript (updateMessage upsert — surfaced
  // when they next open it). Skips a branch it can't fork-point (host hiccup) rather than false-nudging. Runs with the
  // loaded tree on `main` (the land left it there) — every op is ref-based, so it's tree-agnostic.
  async function _broadcastDrift(mergedConvId, mergedBranch, mergeCommit, preMain) {
    if (!mergeCommit || !preMain) return;
    const split = (r) => String((r && r.ok && r.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // what the squash landed: `preMain...mergeCommit`. Both are PLAIN shas — preMain is mergeCommit's parent, so the
    // host's three-dot diffNames (`a...b`) collapses to the squash's own diff; using mergeCommit (a fixed sha) not the
    // `main` ref makes it immune to another queued land moving `main` between our lock-release and this read (cap>1).
    const mergedFiles = split(await gitOp('diffNames', { a: preMain, b: mergeCommit }));
    if (!mergedFiles.length) return;
    let summaries = [];
    try { summaries = await ConversationStore.list(); } catch { summaries = []; }
    const others = (Array.isArray(summaries) ? summaries : []).filter((s) => s && s.kind === 'dev' && (s.status == null || s.status === 'active') && s.id !== mergedConvId);
    const branches = [];
    for (const s of others) {
      let conv = null;
      try { conv = await ConversationStore.load(s.id); } catch { conv = null; }
      const br = conv && conv.branch;
      if (!br || br === mergedBranch) continue;
      const base = await gitOp('mergeBase', { a: 'main', b: br });
      const baseSha = String((base && base.ok && base.stdout) || '').trim();
      if (!baseSha) continue;   // can't fork-point this branch → skip rather than false-nudge
      const files = split(await gitOp('diffNames', { a: baseSha, b: br }));
      branches.push({ convId: s.id, branch: br, files });
    }
    const drifted = driftBroadcastSet(mergedFiles, branches);
    for (const d of drifted) {
      try { console.info(`DRIFT ▸ broadcast — ${d.branch} drifts on ${d.drift.length} file(s) after ${mergeCommit.slice(0, 7)}`); } catch { /* */ }
      const top = d.drift.slice(0, 5).map((f) => '`' + f + '`').join(', ') + (d.drift.length > 5 ? ', …' : '');
      const body = `⚠ \`main\` moved — the merge \`${mergeCommit.slice(0, 7)}\` changed ${d.foundational ? 'a **foundational** file + ' : ''}${d.drift.length} file${d.drift.length === 1 ? '' : 's'} this branch also touched (${top}). Run \`sync\` to catch up before more work.`;
      const msgId = `drift-${mergeCommit.slice(0, 7)}-${String(d.branch).replace(/[^\w.-]/g, '_')}`;
      try { await ConversationStore.updateMessage(d.convId, msgId, { role: 'assistant', body }, { upsert: true }); } catch { /* best-effort */ }
    }
  }

  // DBR-P4-7 (§9/U10) — actuate the worktree GC: list the `.wt/` worktrees, reconcile against the dev conversations
  // via the pure `gcPlan`, then REMOVE the ones owned by a merged/abandoned conversation (the branch is done) + `prune`
  // stale registrations. KEEP live-conversation + the preview worktree; an orphan (no conversation) is always SURFACED
  // not deleted (`unmerged: true` → the safe default — never auto-delete work we can't attribute). Best-effort +
  // non-blocking. Runs after a merge (the just-merged branch's worktree can go) and on panel startup (reconcile).
  async function _runWorktreeGc() {
    try {
      const lst = await gitOp('worktreeList');
      if (!lst || !lst.ok) return;
      const items = [];
      for (const w of parseWorktreeList(lst.stdout)) {
        const m = String(w.path || '').match(/[/\\]\.wt[/\\](.+)$/);
        if (!m) continue;   // the repo root (or anything outside `.wt/`) — never GC
        const rel = '.wt/' + m[1].replace(/\\/g, '/');
        items.push({ path: rel, branch: w.detached ? null : w.branch, stale: w.prunable, preview: rel === PREVIEW_WT, unmerged: true });
      }
      if (!items.length) return;
      const convs = [];
      try {
        const sums = (await ConversationStore.list()).filter((s) => s && s.kind === 'dev');
        for (const s of sums) { const c = await ConversationStore.load(s.id); if (c && c.branch) convs.push({ branch: c.branch, status: c.status }); }
      } catch { /* no conversations readable → every worktree is an orphan → surfaced, never deleted */ }
      const plan = gcPlan(items, convs);
      for (const r of plan.remove) { try { console.info(`GC ▸ remove ${r.path} — ${r.reason}`); await gitOp('worktreeRemove', { path: r.path, force: true }); } catch { /* */ } }
      if (plan.prune.length) { try { console.info(`GC ▸ prune ${plan.prune.length} stale`); await gitOp('worktreePrune'); } catch { /* */ } }
      for (const s of plan.surface) { try { console.info(`GC ▸ kept (surfaced — ${s.reason}): ${s.path} (${s.branch || 'detached'})`); } catch { /* */ } }
    } catch { /* GC is best-effort, never blocks a flow */ }
  }

  // DBR-P3-2 (DESIGN §8/§8.1 layer 2) — `scope`: the deterministic split backstop. Read-only, no LLM, never blocks.
  // Diffs THIS branch vs its fork point (`mergeBase` → `diffNames`), scans the changed CODE files' imports
  // (panel-side `fetch` of the LOADED tree — read-only, no host capability; run `lt` first if the loaded tree
  // isn't this branch), and runs the pure detectors (`assessSplit`). On a flag, posts the §8.1 nudge offering a
  // `split:`. The auto-fire-on-run-complete hook is a follow-up (eyeball the nudge's signal/noise first).
  async function _scopeCheck(convId) {
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `scope` — no branch is recorded for this dev conversation.'); return; }
    const bubble = devBubble(`↻ scope-checking \`${branch}\` vs \`main\`…`);
    const base = await gitOp('mergeBase', { a: 'main', b: branch });
    const baseSha = String((base && base.ok && base.stdout) || '').trim();
    if (!baseSha) { _setBubble(bubble, `✗ \`scope\` — couldn’t find the fork point with \`main\`: ${(base && base.error) || 'host unreachable'}.`); return; }
    const namesR = await gitOp('diffNames', { a: baseSha, b: branch });
    const changed = String((namesR && namesR.ok && namesR.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!changed.length) { _setBubble(bubble, `✓ scope — \`${branch}\` has no changes vs \`main\` yet. Nothing to check.`); return; }
    // import scan over the changed CODE files (panel reads its OWN packaged source — same-origin, read-only).
    const texts = {};
    await Promise.all(changed.filter((f) => /\.(?:js|cjs|mjs)$/.test(f)).map(async (f) => {
      try { const res = await fetch(chrome.runtime.getURL(f)); if (res && res.ok) texts[f] = await res.text(); } catch { /* deleted/unfetchable → skip */ }
    }));
    const assessment = assessSplit({ changedFiles: changed, fileImports: buildImportGraph(texts), isFoundational: (p) => isFoundationalFile(p) });
    const nudge = buildSplitNudge({ concern: conv.concern, ...assessment });
    if (!nudge) { _setBubble(bubble, `✓ scope — \`${branch}\` looks focused (${changed.length} file${changed.length === 1 ? '' : 's'}${conv.concern ? `, concern: \`${String(conv.concern).slice(0, 48)}\`` : ''}). No split suggested.`); return; }
    _setBubble(bubble, nudge);
  }

  // DBR-P3-7 (DESIGN §8.1 layer 3) — `scope?`: the OPTIONAL semantic scope check. ONE metered model call (the panel
  // LLM path, injected) for a second opinion on scope creep, beyond P3-2's deterministic `scope`. Read-only, never
  // blocks. Gathers the branch's diff (mergeBase → diffNames + diffStat), asks the model, posts split suggestions.
  async function _scopeSemantic(convId) {
    if (typeof scopeCheckLLM !== 'function') { devBubble('✗ `scope?` — the semantic check needs the panel LLM (set your API key in settings). `scope` is the deterministic, no-model check.'); return; }
    let conv = null;
    try { conv = convId ? await ConversationStore.load(convId) : null; } catch { conv = null; }
    const branch = conv && conv.branch;
    if (!branch) { devBubble('✗ `scope?` — no branch is recorded for this dev conversation.'); return; }
    const bubble = devBubble(`↻ scope? — asking the model about \`${branch}\` vs \`main\`… (one metered call)`);
    const base = await gitOp('mergeBase', { a: 'main', b: branch });
    const baseSha = String((base && base.ok && base.stdout) || '').trim();
    if (!baseSha) { _setBubble(bubble, `✗ \`scope?\` — couldn’t find the fork point with \`main\`: ${(base && base.error) || 'host unreachable'}.`); return; }
    const [namesR, statR] = await Promise.all([
      gitOp('diffNames', { a: baseSha, b: branch }),
      gitOp('diffStat', { a: baseSha, b: branch }),
    ]);
    const changedFiles = String((namesR && namesR.ok && namesR.stdout) || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!changedFiles.length) { _setBubble(bubble, `✓ scope? — \`${branch}\` has no changes vs \`main\` yet. Nothing to check.`); return; }
    const { system, user } = buildScopeCheckPrompt({ concern: conv.concern, diffStat: String((statR && statR.ok && statR.stdout) || ''), changedFiles });
    let res = null;
    try { res = await scopeCheckLLM({ system, user }); } catch (e) { res = { success: false, error: e && e.message }; }
    if (!res || !res.success) { _setBubble(bubble, `✗ \`scope?\` — model call failed${res && res.error ? `: ${res.error}` : ''}. (\`scope\` still works — deterministic, no model.)`); return; }
    const v = normalizeScopeVerdict(res.text);
    if (!v.creep || !v.suggestions.length) { _setBubble(bubble, `✓ scope? — the model reads \`${branch}\` as focused${v.summary ? `: ${v.summary}` : ''}. No split suggested.`); return; }
    const list = v.suggestions.map((s) => `• **${s.concern}** — ${s.reason}  ↳ \`split: ${s.concern}\``).join('\n');
    _setBubble(bubble, `⚠ scope? — ${v.summary || 'possible scope creep.'}\n\n${list}\n\n_A second opinion (one model call) — a nudge, not a block._`);
  }

  // DBR-P3-3 — the shared split SEEDER. Both the manual `split:` verb (P3-1) and the `propose_split` tool (P3-3)
  // funnel through here: mint `dev/<slug>` off `branchBase` (default `main`; a `dev/…` base ONLY if the split
  // depends on the parent — DBR-1 branchCreate) + a SEED-AND-HOLD kind:'dev' conversation (the seed rides the
  // record; chat.js pre-fills the composer on first open, NOT sent). `seedPrompt` (Claude's, from the tool)
  // overrides the deterministic default. The PANEL is the sole actor (§2.1) — actuation is panel-side + human-
  // initiated. Returns the new conversation, or null on failure.
  async function _seedSplitBranch({ concern, seedPrompt = '', branchBase = 'main', suggestedName = '', parentConvId = null, bubble = null, verb = 'split' } = {}) {
    const c = String(concern || '').replace(/\s+/g, ' ').trim();
    if (!c) { devBubble(`✗ \`${verb}\` — give a concern.`); return null; }
    const b = bubble || devBubble(`↻ splitting out \`${c}\`…`);
    let parent = null;
    try { parent = parentConvId ? await ConversationStore.load(parentConvId) : null; } catch { parent = null; }
    const base = (branchBase && branchBase !== 'main') ? branchBase : 'main';
    const shortid = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const branch = splitSlug(suggestedName || c, shortid);
    const br = await gitOp('branchCreate', { branch, base });
    if (!br || !br.ok) { _setBubble(b, `✗ \`${verb}\` — couldn’t create \`${branch}\`: ${(br && br.error) || 'host unreachable'}.`); return null; }
    const seed = String(seedPrompt || '').trim() || buildSeedPrompt({ concern: c, parentConcern: parent && parent.concern });
    let conv = null;
    try { conv = await ConversationStore.create({ kind: 'dev', title: c.slice(0, 60), branch, concern: c, seed }); } catch { conv = null; }
    if (!conv) { _setBubble(b, `✗ \`${verb}\` — created \`${branch}\` but couldn’t create the conversation. Make a dev conversation on that branch manually.`); return null; }
    try { await refreshHistory?.(); } catch { /* */ }   // v2.74.1054 — show the new conversation in an already-open drawer
    const tail = (verb === 'split' && base === 'main') ? ' Merge that branch first, then `sync` this one onto it.' : '';
    _setBubble(b, `✓ ${verb} — created \`${branch}\` (off \`${base}\`) + a new dev conversation **${c.slice(0, 60)}**. Open the conversations drawer (☰) and select it: its seed is **pre-filled** (review + send).${tail}`);
    return conv;
  }

  // DBR-P3-1 (DESIGN §8.1) — `split: <concern>`: the manual corrective split (the human-typed verb form; seeds off `main`).
  async function _split(convId, rawText) {
    const concern = String(rawText || '').replace(/^split:\s*/i, '').replace(/\s+/g, ' ').trim();
    if (!concern) { devBubble('✗ `split:` — give a concern, e.g. `split: extract the date util`.'); return; }
    await _seedSplitBranch({ concern, branchBase: 'main', parentConvId: convId });
  }

  // DBR-P3-3 (DESIGN §8.1/U5) — render the approve/decline card for a `propose_split` tool_use (surfaced from the
  // assistant-block stream loop). Validate the typed payload; on `Yes, split` seed the branch (panel-side, human-
  // gated — the tool itself never mutates); on `No` keep the work here. `parentConvId` = the run's dev conversation.
  function _proposeSplitCard(input, parentConvId) {
    const v = validateProposeSplit(input);
    if (!v.ok) { devBubble(`⚠ propose_split — ignored a malformed proposal (${v.error}).`); return; }
    const { concern, reason, branchBase, seedPrompt, suggestedName } = v.value;
    const baseNote = branchBase && branchBase !== 'main' ? ` (off \`${branchBase}\`)` : '';
    const bubble = devBubble(`🔀 Claude proposes splitting out **${concern.slice(0, 72)}** into its own branch${baseNote}.${reason ? `\n_${reason.slice(0, 200)}_` : ''}`);
    try {
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;gap:8px;margin-top:8px';
      const yes = mkBtn('Yes, split', async () => {
        try { actions.remove(); } catch { /* */ }
        await _seedSplitBranch({ concern, seedPrompt, branchBase, suggestedName, parentConvId, bubble });
      });
      const no = mkBtn('No, keep here', () => { try { actions.remove(); } catch { /* */ } _setBubble(bubble, `✗ split declined — keeping **${concern.slice(0, 60)}** in this branch.`); });
      actions.appendChild(yes); actions.appendChild(no);
      bubble.bodyEl.appendChild(actions);
    } catch { /* no buttons → the proposal stays surfaced as text */ }
  }

  // DBR-P3-5 (DESIGN §6.1/U12) — `fork`: continue THIS dev conversation (usually a merged/abandoned proposal) on a
  // FRESH branch off `main` + a new seeded conversation. Reuses the P3-3 seeder (verb:'fork'). The new conversation
  // inherits the parent's concern; its seed carries the continue cue (Claude Code sessions are linear — a summary,
  // not a session fork). Works from any dev conversation; the archived-proposal case is the primary use.
  async function _fork(convId) {
    let parent = null;
    try { parent = convId ? await ConversationStore.load(convId) : null; } catch { parent = null; }
    if (!parent) { devBubble('✗ `fork` — open the dev conversation you want to fork from.'); return; }
    const concern = String(parent.concern || parent.title || '').replace(/\s+/g, ' ').trim() || 'continue the previous work';
    const seedPrompt = buildForkSeedPrompt({ parentConcern: parent.concern, parentTitle: parent.title });
    const bubble = devBubble(`↻ forking from **${concern.slice(0, 60)}**…`);
    await _seedSplitBranch({ concern, seedPrompt, branchBase: 'main', parentConvId: convId, bubble, verb: 'fork' });
  }

  // v2.74.1029 — enable the bridge for a NEW dev conversation. The conversations-menu "New dev conversation"
  // button calls this FIRST in its click handler (before any other await) so the nativeMessaging permission
  // request stays gesture-bound — exactly as `dev: on` did (§11/§12). Returns whether the permission was
  // granted; on grant it flips the setting and reveals/arms the reload icon. This is the ONLY enable path now
  // (the `dev: on` verb is unreachable from a normal conversation — the bridge is dev-conversation-only).
  async function enable() {
    // v2.74.1136 — `permissions.request` REQUIRES a live user gesture and THROWS otherwise, even when the
    // permission is ALREADY granted. So check `contains()` FIRST (gesture-free): an already-granted enable then
    // succeeds from a non-gesture caller — the `il: open new dev conversation` panel leg, dispatched after the
    // async ORCH_MATCH/JUDGE calls have spent the user gesture. Only the FIRST-EVER grant needs `request` (a real
    // New-dev BUTTON click); `il:` can't grant it cold, by Chrome's design — and that's the only case left gated.
    let granted = false;
    try { granted = await chrome.permissions.contains({ permissions: ['nativeMessaging'] }); } catch { granted = false; }
    if (!granted) {
      try { granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] }); } catch { granted = false; }
    }
    if (!granted) return false;
    await setEnabled(true);
    emitReload({ enabled: true });   // reveal the header reload icon
    refreshReloadState();            // and arm it if the tree is already dirty
    return true;
  }

  return { maybeHandle, enable, gitOp, onReloadState, refreshReloadState, reloadExtension, reattachConversation, liveRunMessageIds, runStatusForConv, clearRunOutcome, anyAwaiting, cancelConversationRuns, cancelAllRuns,
    // surfaces-§4.5 (preview-as-selection) — the drawer drives the live build instead of typed `lt` / back-to-main:
    // previewConversation loads a dev conversation's branch (the SAME _liveTest the `lt` verb uses — behind-main guard
    // + reload); previewMain points the live build back at `main` (previewToMainPlan + reload, no archive).
    previewConversation: (convId) => _liveTest(convId), previewMain: () => _redeployToMain() };
}
