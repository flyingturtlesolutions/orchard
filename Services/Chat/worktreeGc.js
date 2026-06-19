// Services/Chat/worktreeGc.js — DBR-P4-7 (DESIGN §9/U10): the worktree GC plan.
//
// Concurrency means N branch worktrees accrete under `.wt/`. This is the PURE reconciliation that decides, per
// worktree, whether to KEEP / REMOVE / SURFACE / PRUNE it — given the worktree list (parsed from `git worktree
// list`) and the dev conversations (from ConversationStore). The caller actuates: `git worktree remove` the REMOVE
// set, `git worktree prune` once if anything is PRUNE, surface the SURFACE set for an explicit `delete branch`, and
// leave KEEP alone. PURE so the one safety-critical rule — NEVER auto-delete unmerged work that has no conversation
// — is unit-tested and can't regress.
//
// The rules (§9), in priority order:
//   • the Chrome-loaded PREVIEW worktree            → KEEP    (never GC, even with no conversation)
//   • stale registration (working dir gone)         → PRUNE   (git prunes it; nothing to lose)
//   • detached / no-branch (and not the preview)    → SURFACE (can't classify → never auto-delete)
//   • owned by a LIVE conversation                  → KEEP
//   • owned by a MERGED / ABANDONED conversation    → REMOVE  (the branch is done)
//   • orphan (no conversation) with unmerged work   → SURFACE (human decides via `delete branch`)
//   • orphan with no unmerged work                  → REMOVE  (nothing to lose)
//
// NB the squash-merge asymmetry (a squash-landed branch always reads "ahead" of main) only matters for ORPHANS,
// where SURFACE is the safe call anyway; a worktree whose conversation is recorded merged hits the REMOVE rule
// regardless of its ahead-count.

const _DONE = new Set(['merged', 'abandoned']);

/** A conversation is LIVE unless it has been merged or abandoned. */
export function isLiveStatus(status) {
  return !_DONE.has(String(status || '').toLowerCase());
}

/**
 * Decide the GC action for each worktree. PURE — returns grouped sets, mutates nothing.
 * @param {Array<{path:string, branch?:string|null, stale?:boolean, unmerged?:boolean, preview?:boolean}>} worktrees
 * @param {Array<{branch:string, status?:string}>} conversations
 * @returns {{keep:Array, remove:Array, surface:Array, prune:Array}} each item `{ path, branch, reason }`
 */
export function gcPlan(worktrees, conversations) {
  const out = { keep: [], remove: [], surface: [], prune: [] };
  const byBranch = new Map();
  for (const c of (Array.isArray(conversations) ? conversations : [])) {
    if (c && c.branch) byBranch.set(c.branch, c);
  }
  for (const wt of (Array.isArray(worktrees) ? worktrees : [])) {
    if (!wt || !wt.path) continue;
    const put = (action, reason) => out[action].push({ path: wt.path, branch: wt.branch || null, reason });
    if (wt.preview) { put('keep', 'preview worktree (Chrome-loaded) — never GC'); continue; }
    if (wt.stale)   { put('prune', 'stale registration (working dir gone)'); continue; }
    if (!wt.branch) { put('surface', 'detached/unknown worktree — not auto-removed'); continue; }
    const conv = byBranch.get(wt.branch);
    if (conv && isLiveStatus(conv.status)) { put('keep', 'owned by a live conversation'); continue; }
    if (conv) { put('remove', `conversation ${String(conv.status).toLowerCase()} — branch done`); continue; }
    // orphan: no conversation owns this branch
    if (wt.unmerged) put('surface', 'orphan with unmerged work — needs an explicit `delete branch`');
    else put('remove', 'orphan, no unmerged work — safe to remove');
  }
  return out;
}
