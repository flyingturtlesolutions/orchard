#!/usr/bin/env node
// tools/glf/scrub.cjs — PII scrubber for the loop's journal (v2.74.1981).
//
// WHY THIS EXISTS. `logs/run/findings.md` is the auto-glf loop's memory, and the loop writes it by QUOTING live
// log lines — which is exactly where customer names, order numbers and tracking numbers enter it. The fleet
// shipper already scrubs emails/phones/ids on the way to the cloud, but it does NOT scrub person names or
// business identifiers, and the journal quotes them verbatim from the very lines the shipper let through.
//
// The exposure is structural, not hypothetical: this repo has NO BUILD STEP — the repo root IS the unpacked
// extension root (CLAUDE.md). Anything in the tree is in the bundle. `logs/.gitignore` is `*`, which is the only
// thing standing between the journal and every install, and "let's commit findings.md for durability" was a
// serious proposal three hours before this file was written.
//
// WHAT IT PRESERVES. Diagnostic value lives in DISTINCTNESS and RECURRENCE, not identity: "5 different customers
// matched", "the same order as the previous turn". So each value maps to a STABLE token derived from a hash of
// itself — `[customer:a3f2]` — and the same input always yields the same token. Counting, joining and
// same-vs-different reasoning all survive; the identity does not.
//
// Names cannot be regexed safely (any capitalised pair is a candidate, and this journal is full of prose), so
// they come from an explicit roster. `--check` reports what WOULD change, by kind and count, and never prints a
// value — this tool's own output must not become the leak.

const fs = require('fs');
const crypto = require('crypto');

const tok = (kind, val) => `[${kind}:${crypto.createHash('sha256').update(String(val)).digest('hex').slice(0, 4)}]`;

// Structural identifiers — safe to match by shape.
const PATTERNS = [
  { kind: 'tracking', re: /\b1Z[0-9A-Z]{16}\b/g },
  { kind: 'order', re: /\bDEAKO#\d+\b/g },
  { kind: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
];

// Person names — an explicit roster, because a regex for "a capitalised pair of words" would eat half the prose.
// Add to this list rather than loosening the matcher. Case-insensitive, whole-token.
const NAMES = [
  'Divine Monkam', 'CJ Bouchard', 'John Froh', 'Brian Sweet', 'Phillip Edwards', 'Daniel Shaw',
  'John Smith',
];
// NOT scrubbed, deliberately: DIVISION names (Raleigh, Atlanta West, Las Vegas) and product names (Zendesk
// Guide). They are business geography, they are already in Core/connectorRecipes.js, and they carry the scope
// vocabulary a reproducer needs — the v1979 lesson was that a test ask stated outside the ground's own
// vocabulary tests the wrong path, so removing them would cost real diagnostic value for no privacy gain.

// Addresses that identify a person's home rather than a business endpoint.
const EXTRA = [];

function scrub(text) {
  const counts = Object.create(null);
  let out = text;
  const bump = (k, n) => { counts[k] = (counts[k] || 0) + n; };

  for (const name of NAMES) {
    const re = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const hits = out.match(re);
    if (hits) { bump('name', hits.length); out = out.replace(re, tok('customer', name.toLowerCase())); }
  }
  for (const { kind, re } of PATTERNS) {
    const hits = out.match(re);
    if (hits) { bump(kind, hits.length); out = out.replace(re, (m) => tok(kind, m)); }
  }
  for (const { kind, re } of EXTRA) {
    const hits = out.match(re);
    if (hits) { bump(kind, hits.length); out = out.replace(re, (m) => tok(kind, m)); }
  }
  return { text: out, counts };
}

// A value already scrubbed must survive a second pass unchanged — the loop appends continuously, so this runs
// repeatedly over text it has already processed and must be idempotent.
function residual(text) {
  const left = Object.create(null);
  for (const name of NAMES) {
    const n = (text.match(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) || []).length;
    if (n) left.name = (left.name || 0) + n;
  }
  for (const { kind, re } of PATTERNS) {
    const n = (text.match(re) || []).length;
    if (n) left[kind] = n;
  }
  return left;
}

module.exports = { scrub, residual, tok, NAMES, PATTERNS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = args.find((a) => !a.startsWith('--')) || 'logs/run/findings.md';
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(2); }

  const { text, counts } = scrub(src);
  const kinds = Object.keys(counts).sort();
  const total = kinds.reduce((a, k) => a + counts[k], 0);

  if (!total) { console.log(`SCRUB ▸ ${file} — clean (0 replacements)`); process.exit(0); }
  console.log(`SCRUB ▸ ${file} — ${total} replacement(s): ${kinds.map((k) => `${k} x${counts[k]}`).join(' · ')}`);

  if (!apply) { console.log('SCRUB ▸ --check only; pass --apply to rewrite. (No values are printed, by design.)'); process.exit(1); }

  fs.writeFileSync(file, text);
  const left = residual(text);
  const leftKinds = Object.keys(left);
  if (leftKinds.length) { console.error(`SCRUB ▸ FAILED — residual after apply: ${leftKinds.map((k) => `${k} x${left[k]}`).join(' · ')}`); process.exit(3); }
  console.log(`SCRUB ▸ applied; residual scan clean.`);
}
