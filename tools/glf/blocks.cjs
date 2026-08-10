#!/usr/bin/env node
// tools/glf/blocks.cjs — the open-assertion ledger (v2.74.1989).
//
// STEP 2 of the auto-glf loop grepped for the LAST `VALIDATE[` block and graded only that. So a block became
// unreachable the moment a newer one was written, whether or not it had ever been answered. The loop diagnosed
// this itself 42 versions ago — `INCIDENT[class=validate-block-is-a-stack-not-a-set-orphans-in-flight-fixes
// sev=silent status=open vfirst=1947]` — and then orphaned that incident too.
//
// It is not hypothetical. At v2.74.1988 three fixes (FR-1, SH-1, SH-2) landed on main with their blocks sitting
// BEHIND the newest one in the file. Nothing in the loop would ever look at them again: shipped, unverified,
// and structurally unobservable.
//
// A block is OPEN until something says otherwise. Retirement is an explicit, greppable line — never inferred
// from position, recency, or an incident tag that may belong to a different question:
//
//     RETIRED[v2.74.1988 — PASS @ 48bfc2f+179b0d3d — contact-shaped(13) settled it]
//
// Inference was considered and rejected. Tying a block to an INCIDENT by version proximity is exactly the
// "close enough" reasoning that produced 84 closures at passes=0; a retirement has to be an act, not a guess.

const fs = require('fs');

// v2.74.2104 (audit item 3′) — the journal moved to the sibling repo; resolve it instead of hardcoding.
const { journalPath } = require('../journalPath.cjs');
const FINDINGS = journalPath();
const RE_BLOCK = /^VALIDATE\[v(\d+\.\d+\.\d+)\s*[—-]\s*([^\]]*)\]:/;
const RE_RETIRED = /^RETIRED\[v(\d+\.\d+\.\d+)\s*[—-]\s*(PASS|FAIL|SUPERSEDED|WONTFIX)\b([^\]]*)\]/;
// A block's BUILD is captured when the block is WRITTEN — while the fix is still uncommitted. The moment that
// fix LANDS, HEAD and the working diff both change, so the recorded fingerprint can never match again and the
// block reads INCONCLUSIVE forever. Retiring was an explicit act and re-arming was not, which froze two
// landed-but-unverified blocks (FR-1, SH-2) exactly the way stack-not-a-set froze three. Append-only, like
// RETIRED — the journal is never rewritten, only added to:
//     REARM[v2.74.1980 — c44df5a+7903a812@2.74.1988 — landed in e228dc9; fingerprint moved with the commit]
const RE_REARM = /^REARM\[v(\d+\.\d+\.\d+)\s*[—-]\s*(\S+)([^\]]*)\]/;

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Parse a findings document into { blocks, retired }. PURE — takes text, touches nothing. */
function parse(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  const retired = new Map();   // version → {verdict, note}
  const rearmed = new Map();   // version → {build, note} — a later REARM supersedes an earlier one
  for (let i = 0; i < lines.length; i++) {
    const b = RE_BLOCK.exec(lines[i]);
    if (b) {
      // The arms follow until a blank line that is not part of a continuation, or the next heading.
      const arms = [];
      for (let j = i + 1; j < lines.length && j < i + 40; j++) {
        if (/^(##|---|VALIDATE\[|RETIRED\[)/.test(lines[j])) break;
        if (/^\s*$/.test(lines[j]) && arms.length) break;
        arms.push(lines[j]);
      }
      const body = arms.join('\n');
      const build = (/^\s*BUILD\s*=\s*(\S+)/m.exec(body) || [])[1] || null;
      blocks.push({ version: b[1], claim: b[2].trim(), line: i + 1, build });
      continue;
    }
    const m = RE_REARM.exec(lines[i]);
    if (m) { rearmed.set(m[1], { build: m[2], note: (m[3] || '').trim().replace(/^[—-]\s*/, '') }); continue; }
    const r = RE_RETIRED.exec(lines[i]);
    if (r) retired.set(r[1], { verdict: r[2], note: (r[3] || '').trim().replace(/^[—-]\s*/, '') });
  }
  // A version may carry more than one block over time (a re-arm). The LAST one wins — it is the current wording.
  const byVersion = new Map();
  for (const b of blocks) byVersion.set(b.version, b);
  for (const b of byVersion.values()) {
    const r = rearmed.get(b.version);
    if (r) { b.buildOriginal = b.build; b.build = r.build; b.rearmed = true; }
  }
  const all = [...byVersion.values()].sort((a, b) => cmpVer(a.version, b.version));
  return {
    blocks: all,
    retired,
    rearmed,
    open: all.filter((b) => !retired.has(b.version)),
  };
}

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

module.exports = { parse, cmpVer, RE_BLOCK, RE_RETIRED, RE_REARM };

// ── cli ─────────────────────────────────────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const read = () => { try { return fs.readFileSync(FINDINGS, 'utf8'); } catch (e) { console.error(`cannot read ${FINDINGS}: ${e.message}`); process.exit(2); } };

  if (!cmd || cmd === 'list') {
    const { open, blocks, retired } = parse(read());
    console.log(`BLOCKS ▸ ${blocks.length} total · ${retired.size} retired · ${open.length} OPEN`);
    if (!open.length) { console.log('BLOCKS ▸ none open — the loop has no live question'); process.exit(0); }
    for (const b of open) console.log(`  OPEN v${b.version}${b.build ? ` [${b.build}${b.rearmed ? ' re-armed' : ''}]` : ''} — ${b.claim.slice(0, 96)}  (findings.md:${b.line})`);
    console.log('BLOCKS ▸ grade the OLDEST open block whose BUILD is live; say in one line why any other is not gradeable.');
    process.exit(0);
  }

  // Re-arm a block whose fix has LANDED: the code is the same, the fingerprint is not. Reuses tick.cjs's
  // fingerprint so there is exactly one definition of a build identity in the toolchain.
  if (cmd === 'rearm') {
    const [version, ...note] = rest;
    const { blocks } = parse(read());
    if (!version || !blocks.some((b) => b.version === version)) {
      console.error(`usage: blocks.cjs rearm <version> [note…]  (no VALIDATE block at v${version || "?"})`); process.exit(2);
    }
    const { fingerprint } = require('./tick.cjs');
    const { execFileSync } = require('child_process');
    const git = (a) => { try { return execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).replace(/\n+$/, ''); } catch { return ''; } };
    let mv = '?'; try { mv = JSON.parse(fs.readFileSync('manifest.json', 'utf8')).version; } catch { /* */ }
    const fp = fingerprint(git(['rev-parse', 'HEAD']), git(['diff']), mv);
    fs.appendFileSync(FINDINGS, `\nREARM[v${version} — ${fp}${note.length ? ` — ${note.join(' ')}` : ''}]\n`);
    console.log(`BLOCKS ▸ re-armed v${version} on ${fp}`);
    process.exit(0);
  }

  if (cmd === 'retire') {
    const [version, verdict, ...note] = rest;
    if (!version || !/^(PASS|FAIL|SUPERSEDED|WONTFIX)$/.test(verdict || '')) {
      console.error('usage: blocks.cjs retire <version> <PASS|FAIL|SUPERSEDED|WONTFIX> [note…]'); process.exit(2);
    }
    const { blocks } = parse(read());
    if (!blocks.some((b) => b.version === version)) { console.error(`no VALIDATE block at v${version}`); process.exit(3); }
    fs.appendFileSync(FINDINGS, `\nRETIRED[v${version} — ${verdict}${note.length ? ` — ${note.join(' ')}` : ''}]\n`);
    console.log(`BLOCKS ▸ retired v${version} as ${verdict}`);
    process.exit(0);
  }

  // One-off: everything strictly below <version> predates the ledger and was graded in prose. Marking them
  // SUPERSEDED is bookkeeping, not a claim that each passed — the note says so, so nobody reads it as a green.
  if (cmd === 'bootstrap') {
    const floor = rest[0];
    if (!floor) { console.error('usage: blocks.cjs bootstrap <version>'); process.exit(2); }
    const { blocks, retired } = parse(read());
    const todo = blocks.filter((b) => cmpVer(b.version, floor) < 0 && !retired.has(b.version));
    if (!todo.length) { console.log('BLOCKS ▸ nothing to bootstrap'); process.exit(0); }
    fs.appendFileSync(FINDINGS, `\n${todo.map((b) => `RETIRED[v${b.version} — SUPERSEDED — pre-ledger; graded in prose, not re-verified]`).join('\n')}\n`);
    console.log(`BLOCKS ▸ bootstrapped ${todo.length} block(s) below v${floor} as SUPERSEDED`);
    process.exit(0);
  }

  console.error('usage: blocks.cjs [list] | retire <ver> <verdict> [note…] | rearm <ver> [note…] | bootstrap <ver>');
  process.exit(2);
}
