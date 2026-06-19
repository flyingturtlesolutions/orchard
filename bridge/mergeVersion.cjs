'use strict';
// bridge/mergeVersion.cjs — a git MERGE DRIVER for manifest.json that auto-resolves the `version` line to the higher
// semver and leaves any OTHER conflict for the human. The manifest version is bumped on EVERY change, so any two
// branches both touch it → it's the one line that ALWAYS conflicts when `main` moved under an open branch (the
// recurring `sync`/`merge` pain). PURE core (cmpSemver / resolveVersionConflicts) is unit-tested; the CLI shells
// `git merge-file` for the real 3-way merge, then post-processes only the version-conflict blocks.
//
// Registered PER-CLONE (drivers can't be fully committed — git requires local opt-in): `.gitattributes` maps
// `manifest.json merge=orchard-version`, and `git config merge.orchard-version.driver "node bridge/mergeVersion.cjs
// %O %A %B"` defines it (bridge/install.ps1 for new clones). Git invokes it as `node mergeVersion.cjs <base> <ours>
// <theirs>`; the merged result must land in <ours>. NOT in gitOps' panel allowlist — it's git-invoked tooling, not a
// panel-driven op, so the trust surface (parameter-validated host git) is unchanged.

// Compare two dotted versions "x.y.z…" → -1 / 0 / 1. Missing components count as 0; non-numeric → 0. PURE.
function cmpSemver(a, b) {
  const pa = String(a == null ? '' : a).split('.'), pb = String(b == null ? '' : b).split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (parseInt(pa[i], 10) || 0) - (parseInt(pb[i], 10) || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

const VER_LINE = /^(\s*"version":\s*")(\d+(?:\.\d+){1,3})("\s*,?\s*)$/;

// A conflict block whose BOTH sides are a single `"version": "x.y.z"` line → the higher one's line, verbatim. Returns
// null for anything else (a version line tangled with other changes, or a non-version block) so it's left untouched. PURE.
function resolveVersionBlock(oursBlock, theirsBlock) {
  const o = String(oursBlock).split('\n'), t = String(theirsBlock).split('\n');
  if (o.length !== 1 || t.length !== 1) return null;
  const mo = o[0].match(VER_LINE), mt = t[0].match(VER_LINE);
  if (!mo || !mt) return null;
  const hi = cmpSemver(mo[2], mt[2]) >= 0 ? mo : mt;
  return `${hi[1]}${hi[2]}${hi[3]}`;
}

// Post-process a merged file (default 2-way conflict markers in place): resolve version-only conflict blocks to the
// higher version, leave every OTHER block untouched. Returns { text, conflict }, conflict=true iff a non-version
// conflict remains (→ the human still resolves the real conflict; the version is already done). PURE.
const CONFLICT_RE = /^<<<<<<<[^\n]*\n([\s\S]*?)\n=======\n([\s\S]*?)\n>>>>>>>[^\n]*$/gm;
function resolveVersionConflicts(merged) {
  let conflict = false;
  const text = String(merged).replace(CONFLICT_RE, (whole, ours, theirs) => {
    const r = resolveVersionBlock(ours, theirs);
    if (r == null) { conflict = true; return whole; }
    return r;
  });
  return { text, conflict };
}

module.exports = { cmpSemver, resolveVersionBlock, resolveVersionConflicts };

// ── CLI (git invokes this; not run under `npm test`) ──
if (require.main === module) {
  const fs = require('fs');
  const { execFileSync } = require('child_process');
  const base = process.argv[2], ours = process.argv[3], theirs = process.argv[4];
  if (!base || !ours || !theirs) process.exit(2);   // bad invocation → let git fall back to its default
  let merged = null;
  try {
    merged = execFileSync('git', ['merge-file', '-p', ours, base, theirs], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    // git merge-file exits non-zero ON CONFLICT but still emits the merged text (markers) to stdout — use it.
    if (e && e.stdout != null) merged = String(e.stdout);
    else process.exit(1);   // a real failure (not a conflict) → mark conflict, hand to the human
  }
  const { text, conflict } = resolveVersionConflicts(merged);
  try { fs.writeFileSync(ours, text); } catch { process.exit(1); }
  process.exit(conflict ? 1 : 0);
}
