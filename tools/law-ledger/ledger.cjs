#!/usr/bin/env node
// tools/law-ledger/ledger.cjs — v2.74.1855 — the quantified instrument for the falsification protocol (README.md).
// Local TOOLCHAIN (progress-digest precedent): never the shipped bundle. Reads ONLY structured data — the
// INCIDENT[...] tags in logs/run/findings.md plus the frozen tools/law-ledger/baseline.csv — and prints per-stage
// failure rates, lifetimes, and the pre-registered Poisson verdicts. Prose never enters a computation.
//
// Tag grammar (one line inside a findings entry, same family as LESSON[...]):
//   INCIDENT[stage=receipts class=silent-exit sev=live status=open vfirst=1853]
//   INCIDENT[class=silent-exit status=closed vclosed=1855 passes=3]
// An EPISODE = all tag lines sharing `class` up to (and including) a status=closed line. Lifetime = explicit
// `passes` on the closing line, else the count of tag lines in the episode.
//
// Usage:
//   node tools/law-ledger/ledger.cjs [--findings logs/run/findings.md] [--baseline tools/law-ledger/baseline.csv]
//                                    [--from-v N] [--to-v N] [--json]

'use strict';
const fs = require('fs');
const path = require('path');

// ── parsing ──────────────────────────────────────────────────────────────────────────────────────────────────────
function parseIncidentTags(text) {
  const out = [];
  const re = /INCIDENT\[([^\]]+)\]/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const rec = {};
    for (const kv of m[1].trim().split(/\s+/)) {
      const i = kv.indexOf('=');
      if (i > 0) rec[kv.slice(0, i)] = kv.slice(i + 1);
    }
    for (const k of ['vfirst', 'vclosed', 'passes']) if (rec[k] != null) rec[k] = parseInt(String(rec[k]).replace(/^\+/, ''), 10);
    out.push(rec);
  }
  return out;
}

function parseBaselineCsv(text) {
  const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
  if (!lines.length) return [];
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((line) => {
    // anchors may contain commas only if quoted — baseline rows keep anchors comma-free by convention
    const cells = line.split(',').map((s) => s.trim());
    const rec = {};
    head.forEach((h, i) => { rec[h] = cells[i] != null ? cells[i] : ''; });
    for (const k of ['vfirst', 'vclosed', 'passes']) if (rec[k]) rec[k] = parseInt(rec[k], 10);
    return rec;
  });
}

// ── episodes + rates ─────────────────────────────────────────────────────────────────────────────────────────────
function episodesFrom(rows) {
  const byClass = new Map();
  for (const r of rows) {
    if (!r || !r.class) continue;
    if (!byClass.has(r.class)) byClass.set(r.class, []);
    byClass.get(r.class).push(r);
  }
  const episodes = [];
  for (const [cls, list] of byClass) {
    let cur = null;
    for (const r of list) {
      if (!cur) cur = { class: cls, stage: r.stage || '', sev: r.sev || '', vfirst: r.vfirst || r.vclosed || null, rows: 0, passes: 0, status: 'open' };
      cur.rows += 1;
      if (r.passes) cur.passes += r.passes;
      if (r.stage) cur.stage = cur.stage || r.stage;
      if (r.sev === 'live') cur.sev = 'live';
      if (r.status === 'closed') {
        cur.status = 'closed';
        cur.vclosed = r.vclosed || r.vfirst || null;
        cur.lifetime = cur.passes || cur.rows;
        episodes.push(cur); cur = null;
      }
    }
    if (cur) { cur.lifetime = cur.passes || cur.rows; episodes.push(cur); }
  }
  return episodes;
}

function stageSummary(episodes, { fromV, toV }) {
  const span = Math.max(1, (toV || 0) - (fromV || 0));
  const stages = new Map();
  for (const e of episodes) {
    const s = e.stage || 'unknown';
    if (!stages.has(s)) stages.set(s, { stage: s, incidents: 0, live: 0, lifetimes: [], open: 0 });
    const t = stages.get(s);
    t.incidents += 1;
    if (e.sev === 'live') t.live += 1;
    if (e.status !== 'closed') t.open += 1;
    if (e.lifetime) t.lifetimes.push(e.lifetime);
  }
  const out = [];
  for (const t of stages.values()) {
    const ls = t.lifetimes.slice().sort((a, b) => a - b);
    out.push({
      ...t,
      per100v: +(t.incidents * 100 / span).toFixed(2),
      livePer100v: +(t.live * 100 / span).toFixed(2),
      medianPasses: ls.length ? ls[Math.floor((ls.length - 1) / 2)] : null,
    });
  }
  return out.sort((a, b) => b.incidents - a.incidents);
}

// ── Poisson (event-count statistics — n is small, so counts, never percentages) ──────────────────────────────────
function poissonPmf(k, lambda) { let p = Math.exp(-lambda); for (let i = 1; i <= k; i++) p *= lambda / i; return p; }
function poissonCdf(k, lambda) { let s = 0; for (let i = 0; i <= k; i++) s += poissonPmf(i, lambda); return Math.min(1, s); }

// The pre-registered experiments (README.md §Thresholds — formulas over the baseline, never hand-entered rates).
function experimentVerdicts(baselineEpisodes, liveEpisodes, { toV }) {
  const rate = (cls, eps, span) => eps.filter((e) => e.class.startsWith(cls) && e.sev === 'live').length * 100 / Math.max(1, span);
  const spanOf = (eps, cls, fallback) => {
    const vs = eps.filter((e) => e.class.startsWith(cls)).map((e) => e.vfirst).filter(Boolean);
    return vs.length ? Math.max(...vs) - Math.min(...vs) || fallback : fallback;
  };
  const exps = [
    { id: 'A', cls: 'claiming', landedV: null, note: 'door registry (not yet landed)' },
    { id: 'B', cls: 'silent-', landedV: 1856, note: 'logbook glass (LEARNED banked lines · trace-lint · fan-out receipts)' },
    { id: 'C', cls: 'hop-drop', landedV: 1855, note: 'hop seal (Core/hopSeal.test.js)' },
  ];
  return exps.map((x) => {
    const span0 = spanOf(baselineEpisodes, x.cls, 400);
    const lambda0 = +rate(x.cls, baselineEpisodes, span0).toFixed(2);
    const post = x.landedV ? liveEpisodes.filter((e) => e.class.startsWith(x.cls) && (e.vfirst || 0) > x.landedV) : [];
    const windowV = x.landedV && toV ? Math.max(0, toV - x.landedV) : 0;
    const expected = +(lambda0 * windowV / 100).toFixed(2);
    const observed = post.length;
    const pNoChange = windowV ? +poissonCdf(observed, expected).toFixed(4) : null;   // P(X ≤ observed | no-change)
    let verdict = 'pending';
    if (x.id === 'C' && observed > 0) verdict = 'FALSIFIED (structural zero-prediction broken)';
    else if (windowV > 0 && expected >= 4.7 && observed === 0) verdict = `law holds (p=${pNoChange} under no-change)`;
    else if (windowV > 0) verdict = `accruing (window ${windowV}v, expected-under-no-change ${expected})`;
    return { experiment: x.id, class: x.cls, note: x.note, lambda0PerV100: lambda0, landedV: x.landedV, windowV, observed, expectedUnderNoChange: expected, pNoChange, verdict };
  });
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const root = path.resolve(__dirname, '..', '..');
  const findingsPath = path.resolve(root, opt('--findings', 'logs/run/findings.md'));
  const baselinePath = path.resolve(root, opt('--baseline', 'tools/law-ledger/baseline.csv'));

  let findingsText = ''; try { findingsText = fs.readFileSync(findingsPath, 'utf8'); } catch { /* absent is legal (fresh clone) */ }
  let baselineText = ''; try { baselineText = fs.readFileSync(baselinePath, 'utf8'); } catch { /* */ }

  const liveTags = parseIncidentTags(findingsText);
  const baseRows = parseBaselineCsv(baselineText);
  const liveEpisodes = episodesFrom(liveTags);
  const baseEpisodes = episodesFrom(baseRows);

  const allV = [...baseRows, ...liveTags].flatMap((r) => [r.vfirst, r.vclosed]).filter((v) => Number.isFinite(v));
  const fromV = parseInt(opt('--from-v', String(allV.length ? Math.min(...allV) : 0)), 10);
  const toV = parseInt(opt('--to-v', String(allV.length ? Math.max(...allV) : 0)), 10);

  const report = {
    window: { fromV, toV, versions: Math.max(0, toV - fromV) },
    baseline: { rows: baseRows.length, episodes: baseEpisodes.length, byStage: stageSummary(baseEpisodes, { fromV, toV }) },
    live: { tags: liveTags.length, episodes: liveEpisodes.length, byStage: stageSummary(liveEpisodes, { fromV, toV }) },
    experiments: experimentVerdicts(baseEpisodes, liveEpisodes, { toV }),
  };

  if (args.includes('--json')) { console.log(JSON.stringify(report, null, 2)); return report; }
  console.log(`law-ledger — window v${fromV}→v${toV} (${report.window.versions} versions)`);
  console.log(`baseline: ${baseRows.length} rows → ${baseEpisodes.length} episodes · live tags: ${liveTags.length} → ${liveEpisodes.length} episodes`);
  for (const s of report.baseline.byStage) {
    console.log(`  [baseline] ${s.stage}: ${s.incidents} incidents (${s.live} live) · ${s.per100v}/100v · median lifetime ${s.medianPasses ?? '—'} pass(es)`);
  }
  for (const s of report.live.byStage) {
    console.log(`  [live]     ${s.stage}: ${s.incidents} incidents (${s.open} open) · median lifetime ${s.medianPasses ?? '—'} pass(es)`);
  }
  for (const x of report.experiments) {
    console.log(`  [exp ${x.experiment}] ${x.class} λ0=${x.lambda0PerV100}/100v — ${x.verdict} (${x.note})`);
  }
  return report;
}

if (require.main === module) main();
module.exports = { parseIncidentTags, parseBaselineCsv, episodesFrom, stageSummary, poissonPmf, poissonCdf, experimentVerdicts };
