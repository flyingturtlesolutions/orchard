#!/usr/bin/env node
'use strict';
/*
 * tools/progress-digest/digest.cjs — Orchard → Forge progress digest publisher.
 *
 * Publishes a SMALL, META-ONLY summary of build progress as a single file committed to a
 * SEPARATE private Git repo (the "Forge" portfolio catalog), so an external tracker can
 * follow progress WITHOUT ever seeing source code.
 *
 * HARD CONSTRAINTS (enforced here):
 *  1. META ONLY — whitelist, not blacklist. The payload object literal carries ONLY the
 *     schema fields (renderDigestMarkdown iterates known keys). Marker text is never dumped:
 *     it is extracted from specific labels, then HARD-SCRUBBED (scrubHeavy) of anything code-
 *     like (paths, file:line, identifiers, version tokens, refs). Human-authored convention
 *     lines (DIRECTION:/LESSON[]:/DIGEST_*) get a lighter scrub (scrubLight).
 *  2. NO SECRETS — publishing rides the machine's existing git auth (credential manager / SSH).
 *     No token is read, stored, requested, or logged. We never handle credentials.
 *  3. FAIL-SAFE — any failure (offline, push rejected, destination missing) is caught, logged
 *     as a ONE-LINE non-sensitive warning, and we exit 0. A pass is never broken by publishing.
 *     The digest is written + committed locally regardless; an offline push defers to next pass.
 *  4. IDEMPOTENT — the digest file is overwritten in place. The Forge repo's git history is the
 *     timeline. Never append duplicates; skip entirely when nothing advanced.
 *  5. NO NEW DEPS — built-in fs + child_process only (mirrors bridge/host.js's spawnSync git).
 *  6. PLACEMENT — this lives in the LOCAL trace-review toolchain (tools/, like tools/test-harness/),
 *     referenced by NOTHING in manifest.json. It is never part of the shipped extension bundle and
 *     must be excluded from any future web-store pack. The shipped extension holds no git access.
 *
 * Usage:
 *   node tools/progress-digest/digest.cjs            # safe: prints the digest (dry-run), no I/O
 *   node tools/progress-digest/digest.cjs --dry-run  # explicit dry-run (same)
 *   node tools/progress-digest/digest.cjs --post     # write → commit → push to Forge (fail-safe)
 *
 * Config (env or a git-ignored repo-root .env; env wins):
 *   FORGE_REPO_PATH       local path to the Forge catalog repo (required for --post)
 *   WEBPILOT_DIGEST_PATH  optional override of the in-repo digest path
 *                         (default: project-catalog/digests/webpilot.md)
 */

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------
const REPO = path.resolve(__dirname, '..', '..');          // tools/progress-digest → repo root
const FINDINGS_PATH = path.join(REPO, 'logs', 'run', 'findings.md');
const MANIFEST_PATH = path.join(REPO, 'manifest.json');
const STATE_PATH = path.join(REPO, 'logs', 'run', '.progress-digest.state.json'); // git-ignored under logs/
const DEFAULT_DIGEST_REL = 'project-catalog/digests/webpilot.md';
const STAGE = '7 (Building)';
const TAG = '[progress-digest]';

const warn = (m) => { try { process.stderr.write(`${TAG} ${m}\n`); } catch { /* */ } };
const log = (m) => { try { process.stderr.write(`${TAG} ${m}\n`); } catch { /* */ } };

// ---------------------------------------------------------------------------
// Tiny .env loader (no dependency). process.env always wins; .env fills gaps only.
// ---------------------------------------------------------------------------
function loadEnv() {
  const out = Object.assign({}, process.env);
  try {
    const raw = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const key = m[1];
      if (out[key] != null && out[key] !== '') continue;     // env wins
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[key] = v;
    }
  } catch { /* no .env — fine */ }
  return out;
}

// ---------------------------------------------------------------------------
// Meta scrubbers — the backstop that keeps code out of the digest.
// _stripCommon removes UNAMBIGUOUS code leaks (applied to every field).
// scrubLight  = _stripCommon only            → for human-authored lines (keeps acronyms/brands).
// scrubHeavy  = _stripCommon + parens + SCREAMING → for auto-extracted dense bug markers.
// ---------------------------------------------------------------------------
function _stripCommon(t) {
  return String(t)
    .replace(/`[^`]*`/g, ' ')                                                            // inline code spans
    .replace(/\*\*/g, '')                                                                // bold markers
    .replace(/\b[\w./\\-]+\.(?:js|cjs|mjs|ts|jsx|tsx|json|md|html|css|txt|py)\b(?::\d+(?:[-/]\d+)*)?/gi, ' ') // paths + file:line
    .replace(/\b[A-Za-z_]\w*:\d+(?:[-/]\d+)*\b/g, ' ')                                    // name:line (also strips 15:49 time refs)
    .replace(/\b_[A-Za-z]\w*/g, ' ')                                                      // _prefixed identifiers
    .replace(/\b[a-z]+[A-Z]\w*/g, ' ')                                                    // lowerCamelCase identifiers
    .replace(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g, ' ')                                       // UPPER_SNAKE_CASE
    .replace(/\b[A-Za-z]{2,}\.[A-Za-z]{2,}\b/g, ' ')                                      // dotted.member (spares e.g./i.e.)
    .replace(/\bv?\d+\.\d+(?:\.\d+)+\b/g, ' ')                                            // version tokens v2.74.1018
    .replace(/\.?\d{3,}(?:\s*\/\s*\.?\d{3,})+/g, ' ')                                     // slash-joined build refs .1011/.1012
    .replace(/\.\d{3,}\b/g, ' ')                                                          // bare .1011 / .1018 refs (any preceding char)
    .replace(/[`*_~|<>[\]{}]/g, ' ');                                                     // leftover md / brackets
}
function _finish(t, maxLen) {
  t = String(t)
    .replace(/\s+[/\\](?=\s|$)/g, ' ')                                                    // orphan standalone/trailing slash
    .replace(/(^|\s)[/\\]\s/g, '$1')                                                      // orphan leading slash
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:])/g, '$1')                                                        // space before punct
    .replace(/([,;:])(?:\s*\1)+/g, '$1')                                                  // doubled separators ", ,"
    .replace(/,\s*\./g, '.')                                                              // ", ." → "."
    .trim();
  t = t.replace(/^[\s\-–—•·:>*"']+/, '').trim();                                          // leading list/quote punct
  t = t.replace(/[\s\-–—•·,;:/\\]+$/, '').trim();                                         // trailing dangling punct
  t = t.replace(/[\s,;:]+(?:is|are|was|were|in|on|of|to|the|an?|from|and|or|vs|by|with|that|this|it|its)\.?$/i, '').trim(); // dangling stopword
  t = t.replace(/\s*\.\s*$/, '').trim();                                                  // normalise: no terminal period
  if (t.length > maxLen) {
    const cut = t.slice(0, maxLen);
    const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '), cut.lastIndexOf(' — '));
    t = (stop > 40 ? cut.slice(0, stop) : cut).replace(/[\s,;:—-]+$/, '') + '…';
  }
  return t;
}
function scrubLight(s, maxLen = 160) { return _finish(_stripCommon(s), maxLen); }
function scrubHeavy(s, maxLen = 140) {
  let t = _stripCommon(s)
    .replace(/\([^)]*\)/g, ' ')               // drop all parentheticals (refs/asides)
    .replace(/\b[A-Z][A-Z0-9]{2,}\b/g, ' ');  // drop SCREAMING tokens ≥3 (RUN/ROUTE/SEARCH markers + acronyms)
  return _finish(t, maxLen);
}
function hasSignal(s) {
  return typeof s === 'string' && s.trim().length >= 8 && (s.replace(/[^A-Za-z]/g, '').length >= 5);
}
function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = x.toLowerCase().replace(/\s+/g, ' ').trim(); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

// ---------------------------------------------------------------------------
// findings.md parsing
// ---------------------------------------------------------------------------
function parseFindings(text) {
  const entries = [];
  let cur = null;
  for (const line of String(text).split(/\r?\n/)) {
    const h = /^##\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})\b(.*)$/.exec(line);
    if (h) {
      if (cur) entries.push(cur);
      cur = { date: h[1], time: h[2], stamp: `${h[1]} ${h[2]}`, header: (h[3] || '').trim(), body: '' };
    } else if (cur) {
      cur.body += line + '\n';
    }
  }
  if (cur) entries.push(cur);
  return entries;
}

// Text after a bold inline label `**…LABEL…:**` up to the next bold label or blank line.
function extractAfterBoldLabel(body, labelRe) {
  const re = new RegExp('\\*\\*([^*]*?(?:' + labelRe.source + ')[^*]*?):\\*\\*\\s*', 'i');
  const m = re.exec(body);
  if (!m) return null;
  let rest = body.slice(m.index + m[0].length);
  const next = /\*\*[^*]+:\*\*/.exec(rest);
  if (next) rest = rest.slice(0, next.index);
  const para = rest.indexOf('\n\n');
  if (para >= 0) rest = rest.slice(0, para);
  return rest.trim();
}

// Plain convention lines: `DIRECTION: x`, `LESSON[tag]: x`, `DIGEST_*: x` (tolerant of leading -/* and bold).
function collectConvention(body, re) {
  const out = [];
  let m;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(body))) out.push(m[1] != null ? m[1] : m[0]);
  return out;
}
const RE_DIRECTION = /^[\s\-*]*DIRECTION:\s*\**\s*(.+?)\**\s*$/gim;
const RE_LESSON = /^[\s\-*]*LESSON\[(process|scope|estimate|technical|market)\]:\s*\**\s*(.+?)\**\s*$/gim;
const RE_D_MILESTONE = /^[\s\-*]*DIGEST_MILESTONE:\s*\**\s*(.+?)\**\s*$/gim;
const RE_D_BLOCKER = /^[\s\-*]*DIGEST_BLOCKER:\s*\**\s*(.+?)\**\s*$/im;
const RE_D_NEXT = /^[\s\-*]*DIGEST_NEXT:\s*\**\s*(.+?)\**\s*$/im;

function patchOf(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3] } : null;
}

// ---------------------------------------------------------------------------
// Build the digest object — ONLY whitelisted fields, each derived explicitly.
// ---------------------------------------------------------------------------
function buildDigest({ findingsText, manifestVersion, state, now }) {
  const entries = parseFindings(findingsText);
  const st = state || {};
  const lastStamp = st.lastEntryStamp || '';
  const windowEntries = entries.filter((e) => e.stamp > lastStamp);
  const latest = entries.length ? entries[entries.length - 1] : null;

  // activity
  const passes_since_last = windowEntries.length;
  const cur = patchOf(manifestVersion);
  const last = patchOf(st.lastManifestVersion);
  const version_delta = (cur && last && cur.major === last.major && cur.minor === last.minor)
    ? Math.max(0, cur.patch - last.patch) : 0;
  const dates = windowEntries.map((e) => e.date).sort();
  const span = dates.length
    ? (dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]}→${dates[dates.length - 1]}`)
    : '—';

  // milestones — explicit DIGEST_MILESTONE (light) across window; else auto BANKED claims (heavy)
  let milestones = [];
  for (const e of windowEntries) for (const x of collectConvention(e.body, RE_D_MILESTONE)) {
    const s = scrubLight(x); if (hasSignal(s)) milestones.push(s);
  }
  if (!milestones.length) {
    for (const e of windowEntries) {
      const span2 = extractAfterBoldLabel(e.body, /BANKED/);
      if (span2) { const s = scrubHeavy(span2); if (hasSignal(s)) milestones.push(s); }
    }
  }
  milestones = dedupe(milestones).slice(0, 6);

  // open_blocker — latest entry only; explicit (light) else auto BLOCKER/NEW OPEN/STILL OPEN (heavy) else "none"
  let open_blocker = 'none';
  if (latest) {
    const exp = (collectConvention(latest.body, RE_D_BLOCKER)[0]) || null;
    if (exp) { open_blocker = scrubLight(exp) || 'active (withheld from meta digest)'; }
    else {
      const auto = extractAfterBoldLabel(latest.body, /BLOCKER|NEW\s+OPEN|STILL[-\s]?OPEN/);
      if (auto) { const s = scrubHeavy(auto); open_blocker = hasSignal(s) ? s : 'active (withheld from meta digest)'; }
    }
  }

  // next_focus — latest entry; explicit (light) else first NEXT ACTIONS item (heavy) else "unchanged"
  let next_focus = 'unchanged';
  if (latest) {
    const exp = (collectConvention(latest.body, RE_D_NEXT)[0]) || null;
    if (exp) { const s = scrubLight(exp); if (hasSignal(s)) next_focus = s; }
    else {
      const na = extractAfterBoldLabel(latest.body, /NEXT\s+ACTIONS/);
      if (na) {
        const first = na.split(/\(\d+\)/).map((x) => x.trim()).filter(Boolean)[0] || na;
        const s = scrubHeavy(first); if (hasSignal(s)) next_focus = s;
      }
    }
  }

  // direction — explicit DIRECTION across window, latest wins (light); else "unchanged"
  let direction = 'unchanged';
  const dirs = [];
  for (const e of windowEntries) for (const x of collectConvention(e.body, RE_DIRECTION)) dirs.push(x);
  if (dirs.length) { const s = scrubLight(dirs[dirs.length - 1]); if (hasSignal(s)) direction = s; }

  // lessons — explicit LESSON[tag] across window (light)
  const lessons = [];
  for (const e of windowEntries) {
    const re = new RegExp(RE_LESSON.source, 'gim');
    let m; while ((m = re.exec(e.body))) { const s = scrubLight(m[2]); if (hasSignal(s)) lessons.push(`[${m[1].toLowerCase()}] ${s}`); }
  }

  return {
    as_of: now,
    version: `v${manifestVersion}`,
    stage: STAGE,
    activity: { passes_since_last, version_delta, span },
    milestones,
    open_blocker,
    direction,
    lessons: dedupe(lessons).slice(0, 8),
    next_focus,
    _latestStamp: latest ? latest.stamp : null,
  };
}

// ---------------------------------------------------------------------------
// Render — iterate KNOWN schema keys only (never dump source state).
// ---------------------------------------------------------------------------
function renderDigestMarkdown(d) {
  const out = [];
  out.push('# WebPilot (Orchard) — Progress Digest');
  out.push('');
  out.push(`as_of:        ${d.as_of}`);
  out.push(`version:      ${d.version}`);
  out.push(`stage:        ${d.stage}`);
  out.push(`activity:     { passes_since_last: ${d.activity.passes_since_last}, version_delta: ${d.activity.version_delta}, span: "${d.activity.span}" }`);
  if (d.milestones && d.milestones.length) {
    out.push('milestones:');
    for (const m of d.milestones) out.push(`  - ${m}`);
  }
  out.push(`open_blocker: ${d.open_blocker}`);
  out.push(`direction:    ${d.direction}`);
  if (d.lessons && d.lessons.length) {
    out.push('lessons:');
    for (const l of d.lessons) out.push(`  - ${l}`);
  }
  out.push(`next_focus:   ${d.next_focus}`);
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Git publish (fail-safe). Reuses bridge/host.js's spawnSync pattern, array form (no shell).
// ---------------------------------------------------------------------------
function git(forge, args, timeout = 20000) {
  const r = cp.spawnSync('git', ['-C', forge, ...args], { encoding: 'utf8', timeout, windowsHide: true });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  return { ok: !r.error && r.status === 0, status: r.status, stdout, stderr, spawnError: r.error || null };
}

function publish(forge, digestRel, content, commitMsg) {
  // 1. verify destination is a git repo (fail-safe skip otherwise)
  const probe = git(forge, ['rev-parse', '--is-inside-work-tree'], 8000);
  if (!probe.ok || probe.stdout !== 'true') return { wrote: false, committed: false, pushed: false, reason: 'not-a-git-repo' };

  // 2. write the digest file in place (overwrite)
  const abs = path.join(forge, digestRel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);

  // 3. stage
  const add = git(forge, ['add', '--', digestRel]);
  if (!add.ok) return { wrote: true, committed: false, pushed: false, reason: 'git-add-failed' };

  // 4. commit (nothing-to-commit is benign — content identical to last pass)
  const commit = git(forge, ['commit', '-m', commitMsg]);
  const nothing = /nothing to commit|no changes added/i.test(commit.stdout + ' ' + commit.stderr);
  if (!commit.ok && !nothing) return { wrote: true, committed: false, pushed: false, reason: 'git-commit-failed' };
  const committed = commit.ok;

  // 5. push (offline / rejected → defer to next pass; do NOT echo git stderr — may include remote URL)
  const push = git(forge, ['push']);
  if (!push.ok) return { wrote: true, committed, pushed: false, reason: 'push-deferred' };
  return { wrote: true, committed, pushed: true, reason: committed ? 'published' : 'up-to-date' };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function readState() { try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n'); } catch (e) { warn(`could not persist state: ${e.code || 'error'}`); } }

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function readVersion() {
  try { return String(JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')).version || ''); } catch { return ''; }
}

function run(argv) {
  const env = loadEnv();
  const dryRun = argv.includes('--dry-run');
  const post = argv.includes('--post');

  const findingsText = (() => { try { return fs.readFileSync(FINDINGS_PATH, 'utf8'); } catch { return ''; } })();
  const manifestVersion = readVersion();
  const state = readState();
  const now = new Date().toISOString();

  const digest = buildDigest({ findingsText, manifestVersion, state, now });
  const md = renderDigestMarkdown(digest);

  // Default (no --post) = safe dry-run: print only, no write/commit/push.
  if (!post || dryRun) {
    process.stdout.write(md + '\n');
    if (!post && !dryRun) warn('printed dry-run only (no --post → no write/commit/push).');
    return 0;
  }

  // --post: skip if nothing advanced (idempotent; avoids empty/noise commits)
  if (state.lastPublishedAt && digest.activity.passes_since_last === 0 && digest.activity.version_delta === 0) {
    log('no new pass since last digest — nothing to publish.');
    return 0;
  }

  const forge = env.FORGE_REPO_PATH;
  if (!forge) { warn('FORGE_REPO_PATH unset — skipped publish (run with --dry-run to preview).'); return 0; }
  const digestRel = (env.WEBPILOT_DIGEST_PATH || DEFAULT_DIGEST_REL).replace(/\\/g, '/');
  const commitMsg = `digest: webpilot ${digest.version} @ ${digest.as_of}`;

  let res;
  try {
    res = publish(forge, digestRel, md, commitMsg);
  } catch (e) {
    warn(`publish skipped (${e.code || 'error'}) — pass continues.`);
    return 0;
  }

  if (!res.wrote) { warn(`publish skipped: ${res.reason}.`); return 0; }
  if (res.pushed) log(`published ${digestRel} → Forge (${digest.version}).`);
  else warn(`wrote + ${res.committed ? 'committed' : 'staged'} locally; push deferred (${res.reason}) — retries next pass.`);

  // Advance state only when the digest content is durably recorded (committed, or already up-to-date).
  if (res.committed || res.reason === 'up-to-date' || res.reason === 'push-deferred') {
    writeState({
      lastManifestVersion: manifestVersion,
      lastEntryStamp: digest._latestStamp || state.lastEntryStamp || '',
      lastPublishedAt: now,
    });
  }
  return 0;
}

// Exported for the self-test (no side effects on require).
module.exports = {
  loadEnv, _stripCommon, scrubLight, scrubHeavy, hasSignal, dedupe,
  parseFindings, extractAfterBoldLabel, collectConvention, patchOf,
  buildDigest, renderDigestMarkdown, git, publish, readState, writeState,
};

if (require.main === module) {
  // FAIL-SAFE: a publish problem must never break a pass.
  try { process.exitCode = run(process.argv.slice(2)); }
  catch (e) { warn(`unexpected error (${(e && e.code) || 'error'}) — pass continues.`); process.exitCode = 0; }
}
