// tools/journalPath.cjs — ONE resolver for the build/run journal (audit item 3′, v2.74.2104).
//
// The journal moved OUT of the extension root to a sibling repo (`apps/orchard-journal`): this repo has no build
// step, so its root is the unpacked-extension root and `logs/run/findings.md` shipped in the bundle — and it had
// exactly one copy with no history, so a bad edit or a scrub regression was unrecoverable.
//
// Three consumers hardcoded the old path (`tools/glf/blocks.cjs`, `tools/law-ledger/ledger.cjs`,
// `tools/progress-digest/digest.cjs`). They call this instead, so the location is one edit, not three.
//
// RESOLUTION ORDER — first hit wins:
//   1. $ORCHARD_JOURNAL          explicit override (absolute or relative to the extension repo root)
//   2. ../orchard-journal/findings.md   the sibling repo — the default since v2.74.2104
//   3. logs/run/findings.md      the LEGACY in-repo path, still honoured
//
// Why 3 survives: a fresh clone has no sibling repo, and the migration cannot be atomic across a live 5-minute
// loop plus a racing lane. Falling back keeps every un-migrated script and every clean checkout working; the
// alternative (hard-fail on a missing sibling) would have broken the loop mid-pass. `resolveJournal()` reports
// WHICH rule fired so a caller can say so instead of guessing.

'use strict';
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SIBLING = path.resolve(REPO_ROOT, '..', 'orchard-journal', 'findings.md');
const LEGACY = path.resolve(REPO_ROOT, 'logs', 'run', 'findings.md');

/**
 * Resolve the journal path.
 * @returns {{path: string, via: 'env'|'sibling'|'legacy'|'none', exists: boolean}}
 */
function resolveJournal() {
  const env = process.env.ORCHARD_JOURNAL;
  if (env && String(env).trim()) {
    const p = path.isAbsolute(env) ? env : path.resolve(REPO_ROOT, env);
    return { path: p, via: 'env', exists: fs.existsSync(p) };
  }
  if (fs.existsSync(SIBLING)) return { path: SIBLING, via: 'sibling', exists: true };
  if (fs.existsSync(LEGACY)) return { path: LEGACY, via: 'legacy', exists: true };
  // Nothing on disk yet (fresh clone, journal never written). Name the DEFAULT so a writer creates it in the
  // right place rather than re-seeding the legacy path we just migrated away from.
  return { path: SIBLING, via: 'none', exists: false };
}

/** Just the path — for call sites that only need a string. */
function journalPath() { return resolveJournal().path; }

/** Read the journal, or '' when absent (absence is legal — a fresh clone has no journal). */
function readJournal() {
  const { path: p } = resolveJournal();
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

module.exports = { resolveJournal, journalPath, readJournal, REPO_ROOT, SIBLING, LEGACY };
