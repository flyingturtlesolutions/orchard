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
// `commit` carries no branch arg). Phase-1 ops ONLY — no merge / rebase / push / worktree (those are Phases
// 2–4). buildGitArgs returns argv for the allowed ops and rejects everything else.

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
    // ── write (W-auto, dev-branch-scoped) ──
    case 'branchCreate': {
      if (!validateBranchName(params.branch)) return err('bad-branch');
      if (params.base != null && !validRef(params.base)) return err('bad-base');
      return ok(['branch', params.branch, ...(params.base != null ? [params.base] : [])], true);
    }
    case 'switch':        return validSwitchTarget(params.branch) ? ok(['switch', params.branch], true) : err('bad-target');
    case 'switchDetach':  return validRef(params.ref) ? ok(['switch', '--detach', params.ref], true) : err('bad-ref');
    case 'commitWip':     return ok(['commit', '--allow-empty', '-am', wipMsg(params.message)], true);
    default:              return err('unknown-op');
  }
}

// The Phase-1 allowlist (read + W-auto). FORBIDDEN here by construction: merge, rebase, push, reset, worktree,
// config — they have no `case`, so buildGitArgs returns `unknown-op`.
const ALLOWED_OPS = ['status', 'currentBranch', 'log', 'branchList', 'revParse', 'mergeBase', 'aheadBehind',
  'diffStat', 'branchCreate', 'switch', 'switchDetach', 'commitWip'];

module.exports = { validateBranchName, validRef, validSwitchTarget, clampInt, wipMsg, buildGitArgs, ALLOWED_OPS };
