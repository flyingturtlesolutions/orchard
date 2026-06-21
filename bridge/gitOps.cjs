'use strict';
// bridge/gitOps.cjs — DBR-1 (docs/DESIGN_dev_branches.md §3): the dev-branch git allowlist as a PURE module.
//
// Discrete, parameter-validated operations → an **argv array** (never a shell string). No spawning / no I/O
// here; the host (bridge/host.js) execs `spawn('git', argv, { shell:false })`. Pure + dependency-free so it is
// unit-tested under `npm test` (imported by bridge/gitOps.test.js) AND `require()`d by the CommonJS host at
// native-host runtime.  ← .cjs, not .js: the test-harness loader force-loads every local `.js` as ESM, which
// would break `module.exports`; `.cjs` stays CommonJS in both worlds.
//
// TRUST (DESIGN §3, signed off 2026-06-17): Claude Code never runs git — this is host-side. The host refuses
// any WRITE whose target isn't a `dev/…` branch (commit's current-branch guard is enforced host-side, since
// `commit` carries no branch arg). Phase-1 ops + the Phase-2 W-GATED converge ops (`syncMain`/`mergeSquash`/
// `commitMerge`/`branchDelete` — DESIGN §6/§7). The converge ops that mutate `main` or destroy a branch carry a
// one-time CONFIRM TOKEN the panel supplies only after the human taps confirm (presence checked here, value
// checked host-side). Still FORBIDDEN by construction: rebase / push / reset / worktree / config (no `case`).
// buildGitArgs returns argv for the allowed ops and rejects everything else.

// A dev branch: `dev/` + a segment starting alphanumeric, then [A-Za-z0-9._-]. No `..`, no metacharacters.
const DEV_RE = /^dev\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
// A general ref token we'll pass to read ops (a branch, `HEAD`, or a sha). Ranges (`a...b`) are assembled by
// US from two validated refs, so an individual ref never needs `.` runs or range syntax.
const REF_RE = /^(?:HEAD|[A-Za-z0-9][A-Za-z0-9._/-]*)$/;
// git refname-invalid chars + shell metacharacters (belt-and-braces — spawn is shell-free anyway).
const BAD = /[\s~^:?*[\\@{}()$`'"!;&|<>]/;

function noTraversal(s) { return !String(s).includes('..'); }

function validateBranchName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 200
    && DEV_RE.test(name) && noTraversal(name) && !BAD.test(name);
}
function validRef(ref) {
  return typeof ref === 'string' && ref.length > 0 && ref.length <= 200
    && REF_RE.test(ref) && noTraversal(ref) && !BAD.test(ref);
}
// Switching the loaded tree may target a `dev/…` branch OR `main` (e.g. "show me main") — never anything else.
function validSwitchTarget(t) { return t === 'main' || validateBranchName(t); }
// DBR-P4-1 (§10/U6, sign-off 2026-06-18) — a HOST-MANAGED worktree path: the fixed `.wt/` root + ONE safe segment
// (`.wt/preview`, `.wt/r1`, …). No `..`, no absolute, no nesting — a `worktree add` can't escape the managed root.
const WT_RE = /^\.wt\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
function validWorktreePath(p) {
  return typeof p === 'string' && p.length > 0 && p.length <= 200 && WT_RE.test(p) && noTraversal(p) && !BAD.test(p);
}

function clampInt(v, lo, hi, def) {
  const x = Math.floor(Number(v));
  if (!Number.isFinite(x)) return def;          // non-number → the default
  return Math.min(hi, Math.max(lo, x));         // in-range → clamp to [lo,hi] (don't silently drop to default)
}
function wipMsg(m) {
  const base = 'WIP (dev-bridge checkpoint)';
  if (typeof m !== 'string' || !m.trim()) return base;
  return (base + ': ' + m.replace(/[\r\n]+/g, ' ').trim()).slice(0, 120);
}
// DBR-P2-1 (DESIGN §6.3) — the merge-squash commit message: the multi-line merge-summary becomes the commit
// body, so (UNLIKE wipMsg) KEEP newlines (subject / body / `Dev-conversation:` trailer); strip only NULs; cap
// length so a runaway summary can't bloat the commit.
function commitMsg(m) {
  const s = (typeof m === 'string' && m.replace(/\0/g, '').trim()) || 'Merge dev branch';
  return s.slice(0, 4000);
}
// DBR-P2-1 (DESIGN §3) — the W-gated converge ops carry a one-time confirm token the PANEL supplies ONLY after
// the human taps confirm (Claude's allowlist is git-free → it cannot reach these). The pure layer enforces token
// PRESENCE; the host validates its VALUE against an issued single-use nonce.
function hasConfirm(p) { return typeof p.confirmToken === 'string' && p.confirmToken.length > 0; }

const ok = (argv, write = false) => ({ ok: true, argv, write });
const err = (error) => ({ ok: false, error });

// Read ops never mutate; write ops (`write:true`) the host additionally guards (commit ⇒ current branch must
// be `dev/…`; switch/branchCreate already validate their target). `unknown-op` for anything off the allowlist.
function buildGitArgs(op, params = {}) {
  switch (op) {
    // ── read (unrestricted) ──
    case 'status':        return ok(['status', '--porcelain=v1', '--branch']);
    case 'currentBranch': return ok(['rev-parse', '--abbrev-ref', 'HEAD']);
    case 'log':           return ok(['log', '--oneline', '-n', String(clampInt(params.n, 1, 200, 20))]);
    case 'branchList':    return ok(['branch', '--list', '--format=%(refname:short)']);
    case 'revParse':      return validRef(params.ref) ? ok(['rev-parse', params.ref]) : err('bad-ref');
    case 'mergeBase':     return (validRef(params.a) && validRef(params.b)) ? ok(['merge-base', params.a, params.b]) : err('bad-ref');
    case 'aheadBehind':   return (validRef(params.a) && validRef(params.b)) ? ok(['rev-list', '--left-right', '--count', params.a + '...' + params.b]) : err('bad-ref');
    case 'diffStat':      return (validRef(params.a) && validRef(params.b)) ? ok(['diff', '--stat', params.a + '...' + params.b]) : err('bad-ref');
    case 'diffNames':     return (validRef(params.a) && validRef(params.b)) ? ok(['diff', '--name-only', params.a + '...' + params.b]) : err('bad-ref');   // DBR-P2-7 — drift file-set intersection (§7.1)
    // ── write (W-auto, dev-branch-scoped) ──
    case 'branchCreate': {
      if (!validateBranchName(params.branch)) return err('bad-branch');
      if (params.base != null && !validRef(params.base)) return err('bad-base');
      return ok(['branch', params.branch, ...(params.base != null ? [params.base] : [])], true);
    }
    case 'switch':        return validSwitchTarget(params.branch) ? ok(['switch', params.branch], true) : err('bad-target');
    case 'switchDetach':  return validRef(params.ref) ? ok(['switch', '--detach', params.ref], true) : err('bad-ref');
    case 'commitWip':     return ok(['commit', '--allow-empty', '-am', wipMsg(params.message)], true);
    // ── Phase-2 W-gated converge ops (DESIGN §6/§7) ──
    // `sync`: merge `main` INTO the current branch (catch up). The host guards that current is a `dev/…` branch
    // — never merge into `main`. NO confirm token: the `sync` verb is itself the human gesture and it touches
    // only the branch (not `main`). `--no-edit` so a non-ff merge never blocks on the editor in the shell-free spawn.
    case 'syncMain':      return ok(['merge', '--no-edit', 'main'], true);
    // `merge` land (two staged ops the host runs on `main`, after switching there): squash the dev branch, then
    // commit. BOTH are CONFIRM-GATED (they mutate `main` — the single allowed mutation, §3) and take a `dev/…` SOURCE.
    case 'mergeSquash': {
      if (!validateBranchName(params.branch)) return err('bad-branch');   // (c) source must be dev/…
      if (!hasConfirm(params)) return err('needs-confirm');               // (b) gated
      return ok(['merge', '--squash', params.branch], true);
    }
    case 'commitMerge': {
      if (!hasConfirm(params)) return err('needs-confirm');               // (b) gated — the ONE commit allowed on main
      // `-am` (not `-m`): the squash already staged the branch; the version-at-land stamp (§4.2, bridge/setVersion.cjs)
      // then rewrites manifest.json's version line in the working tree AFTER the squash, so `-a` stages that one tracked
      // modification too → the bump rides the single squash commit. Mirrors commitWip's `-am`. (docs/DESIGN_surfaces.md)
      return ok(['commit', '-am', commitMsg(params.message)], true);
    }
    // abandon (hard): delete a dev branch — gated (irreversible) + `dev/…` only.
    case 'branchDelete': {
      if (!validateBranchName(params.branch)) return err('bad-branch');
      if (!hasConfirm(params)) return err('needs-confirm');
      return ok(['branch', '-D', params.branch], true);
    }
    // ── DBR-P4-1 worktree lifecycle (§10/U6 — host-managed `.wt/` trees) ──
    // `add`: a per-branch tree for a `dev/…` branch, OR `--detach <ref>` for the read-only PREVIEW tree (§10).
    // Path always `.wt/`-scoped (the host re-checks the resolved path too). These author in a worktree, never on `main`.
    case 'worktreeAdd': {
      if (!validWorktreePath(params.path)) return err('bad-wt-path');
      if (params.detach != null) return validRef(params.detach) ? ok(['worktree', 'add', '--detach', params.path, params.detach], true) : err('bad-ref');
      if (!validateBranchName(params.branch)) return err('bad-branch');
      return ok(['worktree', 'add', params.path, params.branch], true);
    }
    case 'worktreeRemove': return validWorktreePath(params.path) ? ok(['worktree', 'remove', ...(params.force === true ? ['--force'] : []), params.path], true) : err('bad-wt-path');
    case 'worktreeList':   return ok(['worktree', 'list', '--porcelain']);
    case 'worktreePrune':  return ok(['worktree', 'prune'], true);
    default:              return err('unknown-op');
  }
}

// The allowlist (read + W-auto + the Phase-2 W-gated converge ops + the Phase-4 worktree lifecycle). FORBIDDEN here
// by construction: rebase, push, reset, config — they have no `case`, so buildGitArgs returns `unknown-op`. (Plain
// `merge` is likewise absent — only the scoped `syncMain`/`mergeSquash` forms exist.) DBR-P4-1: `worktree` is now
// ALLOWED but tightly scoped — `.wt/`-rooted paths + a `dev/…` branch (or a detached preview tip), never an
// arbitrary path; the host re-checks the resolved path (signed off 2026-06-18, §10/U6).
const ALLOWED_OPS = ['status', 'currentBranch', 'log', 'branchList', 'revParse', 'mergeBase', 'aheadBehind',
  'diffStat', 'diffNames', 'branchCreate', 'switch', 'switchDetach', 'commitWip',
  'syncMain', 'mergeSquash', 'commitMerge', 'branchDelete',
  'worktreeAdd', 'worktreeRemove', 'worktreeList', 'worktreePrune'];

module.exports = { validateBranchName, validRef, validSwitchTarget, validWorktreePath, clampInt, wipMsg, commitMsg, hasConfirm, buildGitArgs, ALLOWED_OPS };
