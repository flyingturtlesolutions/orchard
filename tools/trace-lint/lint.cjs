#!/usr/bin/env node
// tools/trace-lint/lint.cjs — v2.74.1856 — Experiment B's detector (law-ledger README): SILENT EXITS become a
// machine-checkable property of any exported trace. A span-OPENER without a later terminal RECEIPT is exactly
// the class that cost multi-pass diagnoses (the 22s silent walk · the receipt-less 121-division fan · the
// outcome-less SESSION_REPLAY channel). Run it on every gl pass:
//   node tools/trace-lint/lint.cjs logs/run/orchard-logs-<stamp>.txt [more files…]
// Exit code 1 when violations exist. Local TOOLCHAIN — never the shipped bundle; counts + line numbers only.
//
// Semantics per rule: sequential scan; an opener line pushes its line-number; a terminal line pops the oldest
// pending opener (FIFO — interleaved spans of the same rule resolve in order); pending openers at EOF are the
// violations. Deliberately coarse (whole-file scope, no timing) — v1 flags structure, humans judge severity.

'use strict';
const fs = require('fs');

// Openers must not match their own terminals (the RIDE_EACH receipt lines share the marker — the negative
// lookahead splits them). Terminals are ANY line proving the span concluded — success, failure, or honest skip.
const RULES = [
  {
    id: 'ride-each-receipt',
    // Calibrated twice on live traces: the fan's own drill exits narrate as `each-filter … hit(s)` /
    // `refused placeholder` (logged on the same turn); `→ on-site open` belongs to the SEPARATE drill-open
    // flow and — under whole-file FIFO — absorbed the 14:38 founding incident's missing receipt (a later
    // unrelated turn paid the earlier turn's debt). Terminals must be lines only THIS span can emit.
    why: 'a fan-out tally must be followed by a delivery receipt (rendered / exit / its own drill filter)',
    // gl 202123 (toolchain-only, no version — manifest stays 1871) — the negative lookahead must list EVERY receipt form, or a receipt counts as an opener too.
    // Live 202123: `RIDE_EACH ▸ cross-division new → 0 row(s), no match` retired the pending span (correct) and
    // was then pushed as a NEW pending span (wrong), so the last sweep line always flagged. Both `cross-division`
    // and `returned` were added to `terminals` when they were introduced and neither was added here — the two
    // lists are one contract stated twice, and only one of them was updated.
    opener: /RIDE_EACH ▸ (?!rendered |exit |cross-division |returned )/,
    terminals: [/RIDE_EACH ▸ (rendered |exit |cross-division |returned )/, /RIDE_DRILL ▸ .*each-filter .*hit\(s\)/, /RIDE_DRILL ▸ refused placeholder/],
  },
  {
    id: 'workflow-run-receipt',
    // Calibrated on first live run: RUN ▸ is deliberately the NO-EFFECT backstop (renderNoEffect fires only
    // when the ledger saw zero effects, chat.js _orchRunChain) — an effectful run's receipt is its STEP ▸
    // line(s). The rule's first draft demanded RUN ▸ always and flagged two perfectly-narrated replays.
    why: 'a workflow replay must end in a receipt — STEP ▸ (effectful) or RUN ▸ (the no-effect backstop)',
    opener: /WORKFLOW ▸ replay — /,
    terminals: [/RUN ▸ /, /STEP ▸ /],
  },
  {
    id: 'interpret-concludes',
    why: 'an interpret dispatch must produce a routing verdict line',
    opener: /Message: INTERPRET_ASK/,
    terminals: [/INTERPRET_ASK "/, /INTERPRET_ASK ▸/],
  },
  {
    id: 'drive-invoke-receipt',
    why: 'a drive invoke must conclude (DRIVE_INVOKE verdict or a section-wait line) — the 22s-silence class',
    opener: /Message: INVOKE_DRIVE_ARTIFACT/,
    terminals: [/DRIVE_INVOKE ▸ .* → /, /DRIVE ▸ section-wait/],
  },
  {
    id: 'invoke-session-concludes',
    // v2.74.1857 — `INVOKE ▸ blocked …` joins the terminals: the rule's first ritual catch (gl 103120) was a
    // dispatch dying in a bare early exit; every INVOKE_SESSION exit now names itself in the blocked family.
    why: 'a session invoke must log an outcome (INVOKE/SESSION_REPLAY verdict, blocked exit, ride-tab refusal, or a csrf line)',
    opener: /Message: INVOKE_SESSION/,
    terminals: [/INVOKE ▸ .* → /, /INVOKE ▸ blocked /, /SESSION_REPLAY ▸ .* → /, /SESSION_REPLAY ▸ blocked /, /RIDE_TAB ▸ .*UNRESOLVED/, /INVOKE ▸ csrf/],
  },
];

function lintText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const pending = new Map(RULES.map((r) => [r.id, []]));
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    for (const r of RULES) {
      if (r.terminals.some((t) => t.test(line))) { pending.get(r.id).shift(); }
      if (r.opener.test(line)) pending.get(r.id).push(n + 1);
    }
  }
  const violations = [];
  for (const r of RULES) {
    for (const lineNo of pending.get(r.id)) violations.push({ rule: r.id, line: lineNo, why: r.why });
  }
  return violations;
}

function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (!files.length) { console.error('usage: node tools/trace-lint/lint.cjs <trace.txt> [more…]'); process.exit(2); }
  let total = 0;
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch (e) { console.error(`${f}: unreadable — ${e.message}`); process.exit(2); }
    const v = lintText(text);
    total += v.length;
    if (!v.length) { console.log(`${f}: clean (${RULES.length} rules)`); continue; }
    console.log(`${f}: ${v.length} silent exit(s)`);
    for (const x of v) console.log(`  line ${x.line} [${x.rule}] ${x.why}`);
    // v2.74.1861 — ATTRIBUTION HONESTY. Matching is FIFO, so each terminal retires the OLDEST pending opener:
    // with a deficit, the lines printed above are the most RECENT openers, which are usually innocent — the
    // debt was incurred earlier (gl 162926 cost a diagnosis step exactly here: 18 flagged lines all had
    // terminals directly beneath them, while the real orphans were 20 quieted fan-out dispatches at the head).
    // The COUNT is exact; the line numbers are where the deficit surfaced, not where it started.
    if (v.length > 2) console.log('  note: FIFO matching — the count is exact, but with a deficit these line numbers mark where it SURFACED; look earlier for openers whose terminal was suppressed or evicted.');
  }
  process.exit(total ? 1 : 0);
}

if (require.main === module) main();
module.exports = { lintText, RULES };
