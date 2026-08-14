'use strict';
/*
 * tools/updater/promoteChecks.cjs — PURE checks for the fleet-update promotion gate (SU / BUILD_ARC_self_update
 * rung 2; DESIGN_self_update.md §3.1, §3.1a). No git, no fs, no network — every function is data-in / verdict-out
 * so promote.test.cjs can exercise the whole decision surface without a repo. The git orchestration (fetch,
 * worktree, push) lives in promote.cjs and calls these. Same "pure core + thin glue" split the extension uses.
 *
 * Runs under plain node (CommonJS) on the dev machine only — never shipped in the extension bundle.
 */

/** Compare two dotted numeric versions ("2.74.2224"). → -1 | 0 | 1. Non-numeric / ragged parts compare as 0. */
function cmpSemver(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10));
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/** Parse a manifest.json string. → { ok, manifest?, error? }. Requires a string `version` (the join key). */
function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `manifest.json does not parse: ${(e && e.message) || 'invalid JSON'}` };
  }
  if (!manifest || typeof manifest !== 'object') return { ok: false, error: 'manifest.json is not an object' };
  if (typeof manifest.version !== 'string' || !manifest.version) return { ok: false, error: 'manifest.json lacks a string "version"' };
  return { ok: true, manifest };
}

/**
 * Collect the files a manifest REFERENCES, split into the two tiers of DESIGN_self_update.md §3.1a:
 *   brick  — Chromium refuses to load the whole extension if any is missing (service worker, content
 *            scripts js/css, icons, action.default_icon).
 *   broken — loads, but the referenced surface fails at use (side_panel.default_path; literal, non-glob
 *            web_accessible_resources). Glob WAR entries (containing '*') can't be existence-checked as a
 *            literal path, so they are intentionally skipped — the `globsSkipped` count records that we did.
 * All paths are manifest-relative with forward slashes, matching `git ls-tree -r --name-only` output.
 */
function collectRefs(manifest) {
  const brick = [];
  const broken = [];
  let globsSkipped = 0;
  const push = (arr, v) => { if (typeof v === 'string' && v) arr.push(v); };

  if (manifest.background) push(brick, manifest.background.service_worker);

  for (const cs of manifest.content_scripts || []) {
    for (const j of cs.js || []) push(brick, j);
    for (const c of cs.css || []) push(brick, c);
  }

  for (const v of Object.values(manifest.icons || {})) push(brick, v);

  const di = manifest.action && manifest.action.default_icon;
  if (typeof di === 'string') push(brick, di);
  else if (di && typeof di === 'object') for (const v of Object.values(di)) push(brick, v);

  if (manifest.side_panel) push(broken, manifest.side_panel.default_path);

  for (const war of manifest.web_accessible_resources || []) {
    for (const r of war.resources || []) {
      if (typeof r !== 'string' || !r) continue;
      if (r.includes('*')) { globsSkipped++; continue; }
      broken.push(r);
    }
  }

  const dedupe = (a) => Array.from(new Set(a));
  return { brick: dedupe(brick), broken: dedupe(broken), globsSkipped };
}

/**
 * Walk collected refs against the set of files present in the candidate tree.
 * → { ok, missing: { brick:[], broken:[] } }. `ok` is false if ANYTHING is missing (spec §3.1a refuses on any
 * absent reference); the tier split is for the operator's message, not for whether to refuse.
 */
function walkRefs(refs, treeFileSet) {
  const missing = {
    brick: refs.brick.filter((p) => !treeFileSet.has(p)),
    broken: refs.broken.filter((p) => !treeFileSet.has(p)),
  };
  return { ok: missing.brick.length === 0 && missing.broken.length === 0, missing };
}

/**
 * The version-movement gate (DESIGN_self_update.md §3.1 step 4). An unbumped behavior change would land
 * fleet-wide with ZERO signal (the extension's §3.3.2 poll is a version gate) — so a bump is required to ship.
 * → { ok, reason, code }. Distinguishes a clean no-op ('nothing-to-promote') from a real refusal.
 *   fleetVersion === null → no fleet yet (first promotion) → ok.
 *   candidate > fleet                         → ok ('bumped').
 *   candidate === fleet && filesDiffer        → REFUSE ('version-not-bumped').
 *   candidate === fleet && !filesDiffer       → no-op   ('nothing-to-promote').
 *   candidate < fleet                         → REFUSE ('downgrade-forbidden' — fix-forward only, ruling 3).
 */
function versionMoved({ candidateVersion, fleetVersion, filesDiffer }) {
  if (fleetVersion == null) return { ok: true, code: 'first', reason: 'no fleet yet — first promotion' };
  const cmp = cmpSemver(candidateVersion, fleetVersion);
  if (cmp > 0) return { ok: true, code: 'bumped', reason: `v${fleetVersion} → v${candidateVersion}` };
  if (cmp === 0 && filesDiffer) return { ok: false, code: 'version-not-bumped', reason: `files changed but version stayed v${candidateVersion} — bump manifest.json` };
  if (cmp === 0) return { ok: false, code: 'nothing-to-promote', reason: `fleet already at v${candidateVersion}` };
  return { ok: false, code: 'downgrade-forbidden', reason: `candidate v${candidateVersion} is older than fleet v${fleetVersion} — fix forward, never downgrade` };
}

/** Does a tree path look like JS the syntax pass should check? (skips node_modules and the ignored update/ dir) */
function isCheckableJs(relPath) {
  if (/(^|\/)node_modules\//.test(relPath)) return false;
  if (/^update\//.test(relPath)) return false;
  return /\.(js|cjs|mjs)$/.test(relPath);
}

/** Heuristic: does this source use ESM top-level import/export? (→ node --check needs --input-type=module). */
function looksLikeEsm(source) {
  return /^\s*import\s.+from\s|^\s*import\s*['"]|^\s*export\s/m.test(String(source || ''));
}

module.exports = { cmpSemver, parseManifest, collectRefs, walkRefs, versionMoved, isCheckableJs, looksLikeEsm };
