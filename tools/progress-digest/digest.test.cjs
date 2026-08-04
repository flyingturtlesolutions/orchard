#!/usr/bin/env node
'use strict';
/*
 * tools/progress-digest/digest.test.cjs — standalone self-test (run: `node tools/progress-digest/digest.test.cjs`).
 * Not part of the ESM `npm test` gate; verifies the META-ONLY guarantee + derivation math.
 * The fixture below is intentionally dense with the SAME shapes the real findings.md carries
 * (file:line refs, UPPER_SNAKE + camelCase identifiers, version tokens, paren refs, backtick spans)
 * so a regression that lets any of it leak fails loudly.
 */
const D = require('./digest.cjs');

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error('  ✗ ' + msg); } };

// ---- fixture: two entries, dense markers + the explicit human conventions ----------------
const FIXTURE = `# Orchard — debug findings

## 2026-06-13 09:10 · orchard-logs-20260613-091000.txt · v2.74.1015
**Issue:** something broke in \`chat.js\` near \`_tryGroundedTurn\` (line 2334).
**Change:** v2.74.1015 — **MILESTONE BANKED:** cross-site ground-aware routing now fires from a no-Ground source tab (\`ROUTE ▸\` marker at sg.js:1544), the tab-dependent gap is CLOSED. **Still-open:** the \`ORCH_MATCH_GLOBAL\` demote-compound-collapse guard.
DIRECTION: lean into connector-based data access (read an MFA code via a Gmail connector) alongside the deterministic DOM path.
LESSON[technical]: a single bare token can false-match a search capability — require intent signal, not just bindability.

## 2026-06-14 18:53 · orchard-logs-decisions-20260614-185448.txt · v2.74.1018
**Issue:** ❌ the ephemeral cross-Ground RUN runner (\`▶ RUN r_1\`) fails step 1.
**Change:** none (analyze-only). **BANKED:** the Indeed search FRAGMENT is healthy on .1018 when driven by the WALK runner (\`REPLAY_SG_CAPABILITY\`, 28), NOT the fragment itself. **BLOCKER (now step 1, regardless of source tab):** the Indeed search fragment fails — cold-open pre-gate from a no-Ground tab (15:45) AND a 13.5s in-fragment failure (\`EDIT_LOCATION\`="remote") from a warm Indeed tab, a regression vs .1008. **NEXT ACTIONS:** (1) Backfill what .1011/.1012 changed in \`sg.js\` (\`rankAndDecide\`) before re-running. (2) verify from a full trace.
LESSON[process]: verify cross-tab runs from a full trace, not the decisions view.
`;

// ---- 1. unit: scrubbers neutralise code, keep prose ----------------------------------------
const codey = 'the `rankAndDecide` gate in sg.js:1544 set ORCH_MATCH_GLOBAL and EDIT_LOCATION via wireCrossGroundData (line 143) on v2.74.1018';
const h = D.scrubHeavy(codey);
ok(!/`/.test(h), 'scrubHeavy drops backticks');
ok(!/\bsg\.js\b|:1544|:143/.test(h), 'scrubHeavy drops file paths + file:line');
ok(!/ORCH_MATCH_GLOBAL|EDIT_LOCATION/.test(h), 'scrubHeavy drops UPPER_SNAKE identifiers');
ok(!/rankAndDecide|wireCrossGroundData/.test(h), 'scrubHeavy drops camelCase identifiers');
ok(!/2\.74\.1018/.test(h), 'scrubHeavy drops version tokens');
ok(D.scrubLight('connector-based MFA fetch is the UX win').includes('MFA'), 'scrubLight keeps acronyms (MFA) in human lines');
ok(D.scrubLight('route to YouTube then read the title').includes('YouTube'), 'scrubLight keeps brand names (YouTube)');

// ---- 2. parse ------------------------------------------------------------------------------
const entries = D.parseFindings(FIXTURE);
ok(entries.length === 2, `parseFindings finds 2 entries (got ${entries.length})`);
ok(entries[0].stamp === '2026-06-13 09:10#001', 'first entry stamp parsed (with the ordinal tie-break)');

// The journal's KIND-first header shapes (the 2026-07-24 convention change). The date+time-only pattern these
// replaced matched 138 of 1012 real headers — all older than 2026-07-24 — so the digest silently summarized an
// eleven-day-stale world while reporting `passes_since_last: 0`.
const SHAPES = D.parseFindings([
  '## build 2026-08-04 (v2.74.1996) — a kind-first entry with no time',
  '## The wrapped title line of that same entry — no date, so it is BODY',
  'body text',
  '## glf 2026-08-03 18:15Z (v2.74.1986 live) — kind + a Z-suffixed time',
  '## review 2026-08-03 — kind, no time',
  '## 2026-08-02 — bare date, no kind, no time',
  '## 2026-07-24 13:35 · the OLD date+time shape still parses',
].join('\n'));
ok(SHAPES.length === 5, `all five header shapes parse, wrapped title stays body (got ${SHAPES.length} entries)`);
ok(SHAPES[0].kind === 'build' && SHAPES[0].time === '00:00', 'kind-first, timeless → kind captured, time defaults');
ok(/no date, so it is BODY/.test(SHAPES[0].body), 'a wrapped `## ` title line without a date stays BODY');
ok(SHAPES[1].time === '18:15', '`18:15Z` parses (no trailing \\b — there is no boundary between 5 and Z)');
ok(SHAPES[2].kind === 'review' && SHAPES[2].time === '00:00', 'kind, no time');
ok(SHAPES[3].kind === '' && SHAPES[3].date === '2026-08-02', 'a bare date with no kind still parses');
ok(SHAPES[4].time === '13:35', 'the pre-2026-07-24 date+time shape is unbroken');
// Two timeless entries on the SAME day must not collide, or the second is never > lastEntryStamp.
const TIE = D.parseFindings('## build 2026-08-04 — first\n## bcp 2026-08-04 — second');
ok(TIE[0].stamp < TIE[1].stamp, 'same-day timeless entries get a deterministic order (the tie-break)');
// State written before the tie-break existed must not re-count the entry it was written from.
const LEGACY = D.buildDigest({ findingsText: FIXTURE, manifestVersion: '2.74.1018',
  state: { lastEntryStamp: '2026-06-14 18:53', lastManifestVersion: '2.74.1018' }, now: 'x' });   // the stamp of the LAST fixture entry, as an older build would have persisted it
ok(LEGACY.activity.passes_since_last === 0, `legacy suffix-less state does not re-count (got ${LEGACY.activity.passes_since_last})`);

// ---- 3. build + render, first-run (no state) ----------------------------------------------
const dg = D.buildDigest({ findingsText: FIXTURE, manifestVersion: '2.74.1018', state: {}, now: '2026-06-14T19:00:00.000Z' });
const md = D.renderDigestMarkdown(dg);

ok(dg.activity.passes_since_last === 2, `activity.passes_since_last = 2 (got ${dg.activity.passes_since_last})`);
ok(dg.activity.span === '2026-06-13→2026-06-14', `activity.span window (got ${dg.activity.span})`);
ok(dg.version === 'v2.74.1018', 'version carries v-prefix from manifest');
ok(dg.direction.includes('connector') && dg.direction.includes('MFA'), 'direction = explicit DIRECTION line (kept)');
ok(dg.lessons.length === 2 && dg.lessons.every((l) => /^\[(technical|process)\]/.test(l)), 'lessons = explicit LESSON[tag] lines');
ok(dg.milestones.length >= 1, 'milestones derived from MILESTONE BANKED / BANKED');
ok(dg.open_blocker !== 'none' && D.hasSignal(dg.open_blocker), 'open_blocker derived from latest BLOCKER');
ok(dg.next_focus !== 'unchanged' && D.hasSignal(dg.next_focus), 'next_focus derived from latest NEXT ACTIONS item 1');

// ---- 4. META-ONLY: no code/paths/identifiers/version tokens survive into ANY derived value --
const dynamicValues = [].concat(dg.milestones, [dg.open_blocker, dg.direction, dg.next_focus], dg.lessons);
const BANNED = [
  [/`/, 'backtick'],
  [/\b[\w./\\-]+\.(?:js|cjs|mjs|ts|json|md|html|css)\b/i, 'file path/extension'],
  [/\b[A-Za-z_]\w*:\d+\b/, 'name:line ref'],
  [/(^|\s)_[A-Za-z]\w*/, '_prefixed identifier'],
  [/\b[a-z]+[A-Z]\w*/, 'camelCase identifier'],
  [/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/, 'UPPER_SNAKE identifier'],
  [/\bv?2\.74\.\d+\b/, 'version token'],
  [/\.\d{3,}\b/, 'bare .NNNN ref'],
];
for (const v of dynamicValues) {
  for (const [re, name] of BANNED) ok(!re.test(v), `leak (${name}) in derived value: "${v}"`);
}
// explicit code tokens from the fixture must be gone (NB: ".1018" is excluded — it is the
// legit manifest version rendered in the `version:` field, not a leaked internal ref).
for (const tok of ['REPLAY_SG_CAPABILITY', 'rankAndDecide', 'ORCH_MATCH_GLOBAL', 'EDIT_LOCATION', 'sg.js', '.1011', '.1008']) {
  ok(md.indexOf(tok) === -1, `rendered digest must not contain "${tok}"`);
}

// ---- 5. idempotent render + incremental state ---------------------------------------------
const md2 = D.renderDigestMarkdown(D.buildDigest({ findingsText: FIXTURE, manifestVersion: '2.74.1018', state: {}, now: '2026-06-14T19:00:00.000Z' }));
ok(md === md2, 'render is deterministic (same input → same output)');
const inc = D.buildDigest({ findingsText: FIXTURE, manifestVersion: '2.74.1018', state: { lastEntryStamp: '2026-06-13 09:10', lastManifestVersion: '2.74.1015' }, now: 'x' });
ok(inc.activity.passes_since_last === 1, `incremental: 1 new pass since 06-13 (got ${inc.activity.passes_since_last})`);
ok(inc.activity.version_delta === 3, `incremental: version_delta 1018-1015 = 3 (got ${inc.activity.version_delta})`);

console.log(`\n${fail === 0 ? '✅' : '❌'} progress-digest self-test: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
