'use strict';
// bridge/setVersion.cjs — the version-at-land STAMP for manifest.json (docs/DESIGN_surfaces.md §4.2, Phase 1).
// At a dev-branch LAND the host calls this to set `main`'s manifest version to (main's current patch + 1),
// AUTHORITATIVELY — overwriting whatever the branch bumped to. That makes the landed version monotonic + unique per
// land, killing the "two branches both bumped to 1138 → both ship as 1138" join-key collapse that the merge driver
// (bridge/mergeVersion.cjs) can't fix on its own: the driver dedups a CONFLICT, it can't ASSIGN a fresh number. With
// this, dev-branch work need not hand-bump manifest.json at all — the land owns the number.
//
// PURE core (parseVersion / bumpPatch / stampVersionLine) is unit-tested (bridge/setVersion.test.js). The host REQUIRES
// this module and does the read-`main`-via-git + write-manifest itself (its existing runGit + fs.writeFileSync); the ONE
// new thing vs. the git-only host surface is WHICH file it writes — a tracked source file's version line, on `main`,
// behind the on-main land guard. The CLI at the bottom mirrors that for manual/diagnostic use; it is NOT a git driver
// (unlike mergeVersion.cjs) and nothing invokes it automatically.

// The `"version": "x.y.z"` line — same shape as mergeVersion's VER_LINE (indent + value + optional trailing comma).
// Three capture groups (prefix / number / suffix) so a stamp swaps ONLY the number and preserves the formatting.
const VER_LINE_RE = /^(\s*"version":\s*")(\d+(?:\.\d+){1,3})("\s*,?\s*)$/m;

// The first `"version"` line's value from a manifest blob, or null. PURE.
function parseVersion(text) {
  const m = String(text == null ? '' : text).match(VER_LINE_RE);
  return m ? m[2] : null;
}

// Bump the LAST (patch) component of a dotted version: '2.74.1137' → '2.74.1138'. Returns null if the patch isn't a
// clean integer (so a malformed version FAILS the land rather than writing garbage). PURE.
function bumpPatch(version) {
  const parts = String(version == null ? '' : version).split('.');
  if (parts.length < 2) return null;
  const i = parts.length - 1;
  if (!/^\d+$/.test(parts[i])) return null;
  const n = parseInt(parts[i], 10);
  if (!Number.isFinite(n)) return null;
  parts[i] = String(n + 1);
  return parts.join('.');
}

// Replace the manifest's version line with `version`, preserving indentation + trailing comma. Returns { text, from }
// or null (no version line, or a malformed target). PURE — the caller writes the file.
function stampVersionLine(manifestText, version) {
  const v = String(version == null ? '' : version);
  if (!/^\d+(?:\.\d+){1,3}$/.test(v)) return null;
  const s = String(manifestText == null ? '' : manifestText);
  const from = parseVersion(s);
  if (from == null) return null;
  return { text: s.replace(VER_LINE_RE, `$1${v}$3`), from };
}

module.exports = { VER_LINE_RE, parseVersion, bumpPatch, stampVersionLine };

// ── CLI (manual/diagnostic; NOT git-invoked) ── run at the repo root, `node bridge/setVersion.cjs` bumps manifest.json's
// version to (HEAD:manifest.json's patch + 1) — the same effect the host produces at land. Prints the new version; exits
// non-zero (writing nothing) on any failure, so a caller can treat a bad exit as "abort the land".
if (require.main === module) {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const repo = process.cwd();
  const mfPath = path.join(repo, 'manifest.json');
  let headText;
  try { headText = execFileSync('git', ['show', 'HEAD:manifest.json'], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { process.stderr.write('setVersion: cannot read HEAD:manifest.json: ' + ((e && e.message) || e) + '\n'); process.exit(1); }
  const to = bumpPatch(parseVersion(headText));
  if (!to) { process.stderr.write('setVersion: unparseable version in HEAD:manifest.json\n'); process.exit(1); }
  let cur;
  try { cur = fs.readFileSync(mfPath, 'utf8'); }
  catch (e) { process.stderr.write('setVersion: cannot read manifest.json: ' + ((e && e.message) || e) + '\n'); process.exit(1); }
  const stamped = stampVersionLine(cur, to);
  if (!stamped) { process.stderr.write('setVersion: no version line in manifest.json\n'); process.exit(1); }
  try { fs.writeFileSync(mfPath, stamped.text); }
  catch (e) { process.stderr.write('setVersion: write failed: ' + ((e && e.message) || e) + '\n'); process.exit(1); }
  process.stdout.write(to + '\n');
  process.exit(0);
}
