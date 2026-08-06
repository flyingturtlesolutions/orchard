#!/usr/bin/env node
// tools/glf/report.cjs — the auto-glf aggregator (v2.74.2044, glf F4).
//
// Three facts the loop produced but nothing computed:
//
// 1. DUTY CYCLE. tick.cjs has appended every firing to logs/run/loop-ticks.jsonl since v1981, and the headline
//    metric of the whole arc (35.4% over 2026-08-02→03) was hand-derived once and then lived only in a code
//    comment. `report` computes it from the ledger, so "is the loop actually running" is a command, not an audit.
//
// 2. THE SCOREBOARD. results/ is append-only by design, which means the state of the queue (verdict chains,
//    time-to-first-grade, INCONCLUSIVE churn) existed only as the latest grade's prose footnote. `report` derives
//    it from the files.
//
// 3. THE WAITING-HUMAN CENSUS. 8 of the first 18 INCONCLUSIVE grades were "waiting-human" — evidence that cannot
//    exist until a person performs the [human] ACTION steps — and nothing ever surfaced that list to the person.
//    `report census` prints exactly the open tests blocked on a human, with their unmet steps; the cron prompt
//    quotes it on QUIET ticks, which turns dead air into the human's to-do list.
//
// Pure functions take their inputs as arguments; only the CLI reads the ledgers and the bus.

const fs = require('fs');
const path = require('path');
const { parseDoc } = require('./testbus.cjs');
const { GAP_MIN } = require('./tick.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TICKS_FILE = path.join(REPO_ROOT, 'logs', 'run', 'loop-ticks.jsonl');
const TICK_MIN = 5;

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Parse the tick ledger; torn lines are skipped, not fatal (same discipline as lastRow). PURE. */
function parseTicks(text) {
  const rows = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r && r.ts) rows.push(r); } catch { /* skip a torn line */ }
  }
  return rows;
}

/** Duty cycle over [windowStart(first row or sinceIso), nowIso]: fired vs expected at one tick per TICK_MIN,
 *  plus the gap census (rows whose recorded gapMin exceeds gapMin threshold). PURE. */
function dutyCycle(rows, nowIso, { sinceIso = null, tickMin = TICK_MIN, gapMin = GAP_MIN } = {}) {
  const inWindow = sinceIso ? rows.filter((r) => String(r.ts) >= String(sinceIso)) : rows;
  if (!inWindow.length) return { fired: 0, expected: 0, dutyPct: null, gaps: [], lostMin: 0, maxGapMin: 0, windowMin: 0 };
  const start = Date.parse(sinceIso || inWindow[0].ts);
  const end = Date.parse(nowIso);
  const windowMin = Math.max(0, Math.round((end - start) / 60000));
  const expected = Math.floor(windowMin / tickMin) + 1;         // one at each boundary incl. the first
  const gaps = inWindow.filter((r) => Number(r.gapMin) > gapMin).map((r) => ({ ts: r.ts, gapMin: Number(r.gapMin) }));
  const lostMin = gaps.reduce((a, g) => a + g.gapMin, 0);
  return {
    fired: inWindow.length, expected,
    dutyPct: expected ? Math.round((inWindow.length / expected) * 1000) / 10 : null,
    gaps, lostMin, maxGapMin: gaps.reduce((a, g) => Math.max(a, g.gapMin), 0), windowMin,
  };
}

/** Per-test verdict chains + totals. tests/results carry {meta} shaped like the bus files. PURE. */
function scoreboard(tests, results) {
  const byTest = new Map();
  for (const r of results || []) {
    const id = r.meta && r.meta.test; if (!id) continue;
    if (!byTest.has(id)) byTest.set(id, []);
    byTest.get(id).push({ verdict: r.meta.verdict || '?', graded: r.meta.graded || '' });
  }
  for (const chain of byTest.values()) chain.sort((a, b) => String(a.graded).localeCompare(String(b.graded)));
  const totals = {};
  for (const r of results || []) { const v = (r.meta && r.meta.verdict) || '?'; totals[v] = (totals[v] || 0) + 1; }
  const rowsOut = (tests || []).map((t) => {
    const m = t.meta || {};
    const chain = byTest.get(m.id) || [];
    const first = (chain.length && m.created) ? Date.parse(chain[0].graded) - Date.parse(m.created) : null;   // no created: → null, never a fake "0h"
    return {
      id: m.id, status: m.status || 'open', owner: m.owner || '?',
      chain: chain.map((c) => c.verdict),
      firstGradeH: (first != null && Number.isFinite(first)) ? Math.round(first / 3600000 * 10) / 10 : null,
      lastVerdict: chain.length ? chain[chain.length - 1].verdict : null,
      lastGraded: chain.length ? chain[chain.length - 1].graded : null,
    };
  });
  return { rows: rowsOut, totals, ungraded: rowsOut.filter((r) => r.status === 'open' && !r.chain.length).map((r) => r.id) };
}

/** The `[human]` ACTION lines of a test body — the steps a person still owes. PURE. */
function humanActions(body) {
  const out = [];
  for (const m of String(body || '').matchAll(/^\s*[-*]\s*\[human\]\s*(.+)$/gim)) out.push(m[1].trim());
  return out;
}

/** Open tests whose LATEST grade is INCONCLUSIVE and marked waiting-human (note or evidence body). PURE.
 *  results here carry {meta, body}. */
function waitingHuman(tests, results) {
  const latest = new Map();
  for (const r of results || []) {
    const id = r.meta && r.meta.test; if (!id) continue;
    const prev = latest.get(id);
    if (!prev || String(r.meta.graded || '') > String(prev.meta.graded || '')) latest.set(id, r);
  }
  const rows = [];
  for (const t of tests || []) {
    const m = t.meta || {};
    if ((m.status || 'open') !== 'open') continue;
    const last = latest.get(m.id);
    if (!last || (last.meta.verdict || '') !== 'INCONCLUSIVE') continue;
    const marked = /waiting-human/i.test(`${last.meta.note || ''}\n${last.body || ''}`);
    if (!marked) continue;
    rows.push({ id: m.id, owner: m.owner || '?', since: last.meta.graded || '', actions: humanActions(t.body) });
  }
  rows.sort((a, b) => String(a.since).localeCompare(String(b.since)));
  return rows;
}

module.exports = { parseTicks, dutyCycle, scoreboard, humanActions, waitingHuman, TICK_MIN, TICKS_FILE };

// ── impure ──────────────────────────────────────────────────────────────────────────────────────────────────
function busRoot() {
  return process.env.ORCHARD_LOGS || path.resolve(REPO_ROOT, '..', 'orchard-logs');
}
function readDir(dir, withBody) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').map((f) => {
    const { meta, body } = parseDoc(fs.readFileSync(path.join(dir, f), 'utf8'));
    return withBody ? { file: f, meta, body } : { file: f, meta };
  });
}

function printDuty(hours) {
  const rows = parseTicks(fs.existsSync(TICKS_FILE) ? fs.readFileSync(TICKS_FILE, 'utf8') : '');
  const nowIso = new Date().toISOString();
  const sinceIso = hours ? new Date(Date.now() - hours * 3600000).toISOString() : null;
  const d = dutyCycle(rows, nowIso, { sinceIso });
  if (!d.fired) { console.log(`DUTY ▸ no tick rows${hours ? ` in the last ${hours}h` : ''} — the loop has not fired`); return; }
  // >100% is not health — the ledger is SHARED, so N concurrent ticking sessions fire N rows per slot. Say so.
  const multi = d.dutyPct != null && d.dutyPct > 100 ? ' · >100% = multiple ticking sessions share this ledger' : '';
  console.log(`DUTY ▸ ${d.fired}/${d.expected} tick(s) over ${Math.round(d.windowMin / 6) / 10}h = ${d.dutyPct}% · ${d.gaps.length} gap(s) >${GAP_MIN}min · ${d.lostMin}min lost · max ${d.maxGapMin}min${multi}`);
}

function printScoreboard(tests, results) {
  const s = scoreboard(tests, results);
  const open = s.rows.filter((r) => r.status === 'open');
  const tot = Object.entries(s.totals).map(([v, n]) => `${v} ${n}`).join(' · ') || 'none';
  console.log(`SCOREBOARD ▸ ${s.rows.length} test(s) · ${open.length} open · verdicts: ${tot}`);
  for (const r of s.rows) {
    const chain = r.chain.length ? r.chain.join(',') : 'ungraded';
    const first = r.firstGradeH != null ? ` · first grade ${r.firstGradeH}h after write` : '';
    console.log(`  ${r.status.toUpperCase().padEnd(7)} ${r.id} (${r.owner}) — ${chain}${first}`);
  }
  if (s.ungraded.length) console.log(`SCOREBOARD ▸ ${s.ungraded.length} open test(s) never graded: ${s.ungraded.join(' ')}`);
}

function printCensus(tests, results) {
  const rows = waitingHuman(tests, results);
  if (!rows.length) { console.log('CENSUS ▸ nothing waiting on a human'); return; }
  console.log(`CENSUS ▸ ${rows.length} test(s) waiting on a [human] step — this is the to-do list:`);
  for (const r of rows) {
    console.log(`  ${r.id} (${r.owner}) — waiting since ${r.since}`);
    for (const a of r.actions) console.log(`    [human] ${a}`);
  }
}

function printBus() {
  const { execFileSync } = require('child_process');
  let out = '';
  try { out = execFileSync('git', ['status', '--porcelain', '--', 'tests', 'results'], { cwd: busRoot(), encoding: 'utf8' }).replace(/\n+$/, ''); } catch { /* bus absent → silent */ }
  const n = out ? out.split('\n').filter(Boolean).length : 0;
  console.log(n ? `BUS UNDELIVERED ▸ ${n} file(s) uncommitted in orchard-logs — the push IS the delivery` : 'BUS ▸ delivered (tests/ and results/ clean)');
}

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  const hoursFlag = rest.indexOf('--hours');
  const hours = hoursFlag >= 0 ? Number(rest[hoursFlag + 1]) || null : (cmd === 'duty' ? null : 24);
  if (cmd === 'census') {   // the QUIET-tick read: cheap, bus-only
    printCensus(readDir(path.join(busRoot(), 'tests'), true), readDir(path.join(busRoot(), 'results'), true));
    process.exit(0);
  }
  if (cmd === 'duty') { printDuty(hours); process.exit(0); }
  if (cmd && cmd !== 'all') { console.error('usage: report.cjs [all|duty|census] [--hours N]'); process.exit(2); }
  const tests = readDir(path.join(busRoot(), 'tests'), true);
  const results = readDir(path.join(busRoot(), 'results'), true);
  printDuty(hours);
  printScoreboard(tests, results);
  printCensus(tests, results);
  printBus();
}
