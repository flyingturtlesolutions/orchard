#!/usr/bin/env node
// tools/glf/dashboard.cjs — the glf dashboard, two surfaces from one gather (v2.74.2046, glf F6).
//
// 1. LOCAL HTML — logs/run/glf-dashboard.html: the rich view (status strip, waiting-human census, duty sparkline,
//    verdict-chip scoreboard, results feed). Self-contained: inline CSS/SVG, zero external requests (the
//    extension's own CSP discipline applied to a dev page), auto-refreshes via <meta>. Git-ignored, this machine.
// 2. BUS MARKDOWN — ../orchard-logs/state/dashboard.md: the ANYWHERE view. GitHub renders it natively, so the
//    private bus repo becomes the phone/away view with repo auth as the whole access model. Machine-local metrics
//    (duty, lease, gap) are EMBEDDED at generation with an `as of` stamp — which makes the file's own age a
//    remote LIVENESS signal: a dashboard that stops regenerating IS the "machine asleep / loop down" indicator.
//    Scrubbed before write (residual REFUSES — same contract as every bus write). Never GitHub Pages: the repo
//    being private is the access model; a published page would perforate it.
//
// Renderers are pure (data in, string out) and exported for the standalone test; only the CLI gathers and writes.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { parseDoc, leaseState } = require('./testbus.cjs');
const { parseTicks, dutyCycle, scoreboard, waitingHuman, admissibility, TICKS_FILE } = require('./report.cjs');
const { GAP_MIN } = require('./tick.cjs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HTML_OUT = path.join(REPO_ROOT, 'logs', 'run', 'glf-dashboard.html');
const LEASE_FILE = path.join(REPO_ROOT, 'logs', 'run', 'grader.lease');
const MD_REL = path.join('state', 'dashboard.md');

// ── pure ────────────────────────────────────────────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** ms → "2m" / "3h" / "1d4h" — ages read at a glance. PURE. */
function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? `${m % 60}m` : ''}`;
  return `${Math.floor(h / 24)}d${h % 24 ? `${h % 24}h` : ''}`;
}

/** Verdict → a stable css class (chips color by class; unknown verdicts get 'other'). PURE. */
function chipClass(verdict) {
  const v = String(verdict || '').toUpperCase();
  return ['PASS', 'FAIL', 'INCONCLUSIVE', 'UNMAPPED', 'ORPHANED'].includes(v) ? v.toLowerCase() : 'other';
}

/** F6b — the starvation ramp: an age's urgency class. fresh <6h · ok <24h · warn <72h · late beyond.
 *  The census is a queue whose whole point is WHICH item is rotting; identical-looking ages hid that. PURE. */
function ageClass(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'age-ok';
  const h = ms / 3600000;
  return h < 6 ? 'age-fresh' : h < 24 ? 'age-ok' : h < 72 ? 'age-warn' : 'age-late';
}

/** F6b — run-length compress a verdict chain: the PATTERN is the signal, not the repetition.
 *  ['INC','INC','INC','PASS'] → [{v:'INC',n:3},{v:'PASS',n:1}]. PURE. */
function compressChain(chain) {
  const out = [];
  for (const v of chain || []) {
    if (out.length && out[out.length - 1].v === v) out[out.length - 1].n++;
    else out.push({ v, n: 1 });
  }
  return out;
}

/** F6b — chip label abbreviations (full verdict survives in the title attr — honesty by hover). PURE. */
const VERDICT_ABBREV = { INCONCLUSIVE: 'INC', UNMAPPED: 'UNM', ORPHANED: 'ORPH' };
const chipLabel = (v) => VERDICT_ABBREV[String(v || '').toUpperCase()] || String(v || '').toUpperCase();

/** Tick intervals → an SVG polyline path over a fixed viewbox; values capped so one monster gap doesn't flatten
 *  the rest. PURE. */
function sparklinePath(values, w = 220, h = 36, cap = 60) {
  const vs = (values || []).map((v) => Math.min(Math.max(Number(v) || 0, 0), cap));
  if (!vs.length) return '';
  const step = vs.length > 1 ? w / (vs.length - 1) : 0;
  return vs.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(h - (v / cap) * h).toFixed(1)}`).join(' ');
}

/** The one data shape both renderers consume. PURE assembly from parts the CLI gathers. */
function model({ nowIso, host, build, lease, leaseSt, duty, board, census, busDirtyN, recent, tickIntervals, busRootPath }) {
  return { nowIso, host, build, lease, leaseSt, duty, board, census, busDirtyN, recent, tickIntervals, busRootPath: busRootPath || null };
}

/** Age of `ts` as seen from the RENDER moment (m.nowIso, never Date.now() — renders stay deterministic). PURE. */
const ageOf = (nowIso, ts) => fmtAge(Date.parse(nowIso) - Date.parse(ts));

/** file:// URL into the bus repo for local drill-down links; null when no bus root is known. PURE. */
function fileUrl(busRootPath, rel) {
  if (!busRootPath) return null;
  return 'file:///' + encodeURI(String(busRootPath).replace(/\\/g, '/').replace(/^\/+/, '') + '/' + String(rel).replace(/\\/g, '/'));
}

function renderMd(m) {
  const L = [];
  L.push(`# glf dashboard`);
  L.push('');
  L.push(`**as of ${m.nowIso}** · host \`${m.host}\` · build \`${m.build}\` — *this file's age is the liveness signal: if it stops regenerating, the machine or the loop is down.*`);
  L.push('');
  const leaseLine = m.leaseSt === 'free' ? 'free' : `${m.leaseSt} — ${m.lease.lane} since ${m.lease.ts}`;
  L.push(`**lease:** ${leaseLine} · **bus:** ${m.busDirtyN ? `⚠ ${m.busDirtyN} UNDELIVERED` : 'delivered'} · **duty 24h:** ${m.duty.fired}/${m.duty.expected}${m.duty.dutyPct != null ? ` = ${m.duty.dutyPct}%` : ''} · ${m.duty.gaps.length} gap(s) >${GAP_MIN}min, max ${m.duty.maxGapMin}min`);
  L.push('');
  L.push(`## 🧍 Waiting on a human (${m.census.length})`);
  if (!m.census.length) L.push('nothing — the loop owes you no steps.');
  for (const r of m.census) {
    if (r.onYou === false) {
      L.push(`- ⏸ **[${r.id}](../tests/${r.id}.md)** — **blocked: ${r.state}** (owner ${r.owner} must rearm; your actions are invisible until then) — waiting ${ageOf(m.nowIso, r.since)}`);
      if (r.note) L.push(`  - last grade: ${r.note}`);
      continue;
    }
    L.push(`- **[${r.id}](../tests/${r.id}.md)** — **on you** — waiting **${ageOf(m.nowIso, r.since)}** (since ${r.since})`);
    if (r.note) L.push(`  - last grade: ${r.note}`);
    if (!r.actions.length) L.push(`  - [ ] (no [human] lines parsed — see the test file)`);
    for (const a of r.actions) L.push(`  - [ ] ${a}`);
  }
  L.push('');
  L.push(`## Scoreboard (${m.board.rows.filter((r) => r.status === 'open').length} open / ${m.board.rows.length})`);
  L.push('| test | owner | verdict chain | last |');
  L.push('|---|---|---|---|');
  for (const r of [...m.board.rows].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1))) {
    L.push(`| ${r.status === 'open' ? `**[${r.id}](../tests/${r.id}.md)**` : `[${r.id}](../tests/${r.id}.md)`} | ${r.owner} | ${r.chain.length ? r.chain.join(' → ') : '_ungraded_'} | ${r.lastGraded ? ageOf(m.nowIso, r.lastGraded) + ' ago' : '—'} |`);
  }
  if (m.board.ungraded.length) { L.push(''); L.push(`_${m.board.ungraded.length} open test(s) never graded: ${m.board.ungraded.join(', ')}_`); }
  L.push('');
  L.push(`## Recent results`);
  for (const r of m.recent) L.push(`- \`${r.verdict}\` ${r.test} — ${r.graded} by ${r.grader}${r.selfGraded ? ' (self)' : ''}${r.note ? ` — ${r.note}` : ''}`);
  if (!m.recent.length) L.push('none yet.');
  L.push('');
  return L.join('\n') + '\n';
}

// The death-signal script (review fix #1): the page must be able to say "my generator stopped". STATIC text — no
// interpolation — so its sha256 is stable and the CSP can pin exactly this script and nothing else (an injected
// <script> from bus text would need to match the hash; with esc() + this CSP the XSS class is dead twice over).
const AGE_SCRIPT = "(function(){var b=document.body;var t=Date.parse(b.getAttribute('data-asof')||'');var el=document.getElementById('age');function r(){if(!el||!isFinite(t))return;var m=Math.floor((Date.now()-t)/60000);el.textContent='regenerated '+(m<1?'just now':m+'m ago');var s=document.getElementById('strip');if(s)s.classList.toggle('stale',m>12);}r();setInterval(r,30000);})();";

function renderHtml(m) {
  const scriptHash = crypto.createHash('sha256').update(AGE_SCRIPT).digest('base64');
  const chips = (chain) => compressChain(chain).map(({ v, n }) => `<span class="chip ${chipClass(v)}" title="${esc(v)}${n > 1 ? ` ×${n}` : ''}">${esc(chipLabel(v))}${n > 1 ? ` ×${n}` : ''}</span>`).join('');
  const testLink = (id) => { const u = fileUrl(m.busRootPath, `tests/${id}.md`); return u ? `<a href="${esc(u)}">${esc(id)}</a>` : esc(id); };
  const censusRows = m.census.map((r) => {
    const head = `<b>${testLink(r.id)}</b> <span class="dim">— waiting <b class="${ageClass(Date.parse(m.nowIso) - Date.parse(r.since))}" title="${esc(r.since)} · owner ${esc(r.owner)}">${esc(ageOf(m.nowIso, r.since))}</b></span>`;
    const note = r.note ? `<div class="dim" style="font-size:12px;margin-left:2px">last grade: ${esc(r.note)}</div>` : '';
    // Census honesty — a STALE test's checklist is unactionable: the loop cannot see anything the human does
    // until its OWNER rearms. Label the real blocker instead of re-nagging done steps.
    if (r.onYou === false) return `
    <div class="test">${head} <span class="pill warn">⏸ blocked: ${esc(r.state || '?')} — owner ${esc(r.owner)} must rearm; not on you</span>${note}</div>`;
    return `
    <div class="test">${head} <span class="pill ok">on you</span>${note}
      <ul class="todo">${r.actions.length ? r.actions.map((a) => `<li>${esc(a)}</li>`).join('') : '<li class="dim">(no [human] lines parsed — see the test file)</li>'}</ul></div>`;
  }).join('') || '<p class="ok">nothing — the loop owes you no steps.</p>';
  const openFirst = [...m.board.rows].sort((a, b) => (a.status === b.status ? 0 : a.status === 'open' ? -1 : 1));
  const rowHtml = (r) => `
    <tr class="${esc(r.status)}"><td>${testLink(r.id)}</td><td>${esc(r.owner)}</td>
      <td>${r.chain.length ? chips(r.chain) : '<span class="dim">ungraded</span>'}</td>
      <td>${r.firstGradeH != null ? esc(r.firstGradeH) + 'h' : '—'}</td><td class="dim ${r.lastGraded ? ageClass(Date.parse(m.nowIso) - Date.parse(r.lastGraded)) : ''}" title="${esc(r.lastGraded || '')}">${r.lastGraded ? esc(ageOf(m.nowIso, r.lastGraded)) + ' ago' : '—'}</td></tr>`;
  const openRows = openFirst.filter((r) => r.status === 'open').map(rowHtml).join('');
  const retired = openFirst.filter((r) => r.status !== 'open');
  const retiredRows = retired.map(rowHtml).join('');
  const thead = '<tr><th>test</th><th>owner</th><th>verdicts</th><th>1st grade</th><th>last graded</th></tr>';
  const recent = m.recent.map((r) => {
    const u = r.file ? fileUrl(m.busRootPath, `results/${r.file}`) : null;
    return `
    <li><span class="chip ${chipClass(r.verdict)}">${esc(r.verdict)}</span> ${u ? `<a href="${esc(u)}">${esc(r.test)}</a>` : esc(r.test)} <span class="dim" title="${esc(r.graded)}">${esc(ageOf(m.nowIso, r.graded))} ago by ${esc(r.grader)}${r.selfGraded ? ' (self)' : ''}</span>${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</li>`;
  }).join('');
  const leasePill = m.leaseSt === 'free' ? 'LEASE free' : `LEASE ${m.leaseSt} · ${m.lease.lane} · ${ageOf(m.nowIso, m.lease.ts)}`;
  const leaseBad = m.leaseSt !== 'live';
  // Review fix #4 — with N sessions ticking one shared ledger, the interval series shows CONTENTION, not cadence;
  // rendering it under a >100% duty would be a healthy-looking lie. Suppress and say why.
  const spark = (m.duty.dutyPct != null && m.duty.dutyPct > 100)
    ? '<p class="dim" style="font-size:11px">sparkline suppressed — multi-session ledger, intervals not meaningful</p>'
    : `<svg width="220" height="36" viewBox="0 0 220 36"><path d="${sparklinePath(m.tickIntervals)}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>
  <p class="dim" style="font-size:11px">tick intervals, capped at 60min</p>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="60">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'">
<title>glf dashboard</title><style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--dim:#6b6b6b;--card:#f5f5f7;--line:#e2e2e6}
@media(prefers-color-scheme:dark){:root{--bg:#131417;--fg:#e8e8ea;--dim:#9a9aa2;--card:#1d1f24;--line:#2a2d33}}
body{background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif;margin:0;padding:18px;max-width:980px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:12px 0}
.dim{color:var(--dim)}.ok{color:#2e9e44}.bad{color:#d64545;font-weight:600}
.chip{display:inline-block;padding:0 7px;border-radius:999px;font-size:11px;font-weight:600;color:#fff;margin-right:3px}
.chip.pass{background:#2e9e44}.chip.fail{background:#d64545}.chip.inconclusive{background:#c9922a}
.chip.unmapped{background:#8a5fc9}.chip.orphaned{background:#666}.chip.other{background:#888}
table{border-collapse:collapse;width:100%}td,th{padding:4px 8px;text-align:left;border-top:1px solid var(--line);vertical-align:top}
tr.retired td{opacity:.55}.test{margin:8px 0}
.note{color:var(--dim);font-size:12px;margin-left:26px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:2px 0 8px}
ul{margin:4px 0 4px 20px}svg{display:block}
a{color:inherit;text-decoration:underline dotted;text-underline-offset:2px}a:hover{text-decoration:underline solid}
.pill{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:1px 10px;font-size:12px}
.pill.ok{color:#2e9e44;border-color:#2e9e4455}.pill.bad{color:#d64545;border-color:#d64545;font-weight:600}
.pill.warn{color:#c9922a;border-color:#c9922a88}
.age-fresh{color:var(--dim)}.age-ok{}.age-warn{color:#c9922a}.age-late{color:#d64545}
ul.todo{list-style:none;margin-left:4px;padding-left:0}ul.todo li::before{content:"☐ ";opacity:.6}
details{margin-top:8px}summary{cursor:pointer}
.strip{display:flex;gap:14px;flex-wrap:wrap;align-items:baseline}
.strip.stale{border-color:#d64545;background:rgba(214,69,69,.08)}
.strip.stale::after{content:"⚠ STALE — the generator has stopped; this page is a snapshot";color:#d64545;font-weight:600;width:100%}</style></head><body data-asof="${esc(m.nowIso)}">
<div class="card strip" id="strip">
  <b>glf dashboard</b><span class="dim" title="${esc(m.host)}">as of ${esc(m.nowIso)}</span><span id="age" class="dim"></span>
  <span class="pill" title="${esc(m.host)}">BUILD <code>${esc(m.build)}</code></span>
  <span class="pill ${leaseBad ? 'bad' : 'ok'}">${esc(leasePill)}</span>
  <span class="pill ${m.busDirtyN ? 'bad' : 'ok'}">BUS ${m.busDirtyN ? `${m.busDirtyN} UNDELIVERED` : '✓ delivered'}</span>
</div>
<div class="card"><h2>🧍 Waiting on a human (${m.census.length})</h2>${censusRows}</div>
<div class="card"><h2>Duty — last 24h</h2>
  <p title="${m.duty.fired}/${m.duty.expected} tick(s) in the window · gaps are >${GAP_MIN}min">duty <b>${m.duty.dutyPct != null ? `${m.duty.dutyPct}%` : '—'}</b>${m.duty.dutyPct > 100 ? ' <span class="dim">(>100% = multiple ticking sessions)</span>' : ''} · gaps ${m.duty.gaps.length} · lost ${m.duty.lostMin}m · worst ${m.duty.maxGapMin}m</p>
  ${spark}</div>
<div class="card"><h2>Scoreboard (${openFirst.filter((r) => r.status === 'open').length} open / ${m.board.rows.length})</h2>
  <div style="overflow-x:auto"><table>${thead}${openRows}</table></div>
  ${retired.length ? `<details><summary class="dim">${retired.length} retired</summary><div style="overflow-x:auto"><table>${thead}${retiredRows}</table></div></details>` : ''}</div>
<div class="card"><h2>Recent results</h2><ul style="list-style:none;margin:0;padding:0">${recent || '<li class="dim">none yet</li>'}</ul></div>
<script>${AGE_SCRIPT}</script>
</body></html>`;
}

module.exports = { esc, fmtAge, ageOf, fileUrl, chipClass, ageClass, compressChain, chipLabel, sparklinePath, renderMd, renderHtml, model, AGE_SCRIPT, HTML_OUT, MD_REL };

// ── impure ──────────────────────────────────────────────────────────────────────────────────────────────────
function busRoot() { return process.env.ORCHARD_LOGS || path.resolve(REPO_ROOT, '..', 'orchard-logs'); }
function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md').map((f) => {
    const { meta, body } = parseDoc(fs.readFileSync(path.join(dir, f), 'utf8'));
    return { file: f, meta, body };
  });
}
function git(args, cwd) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).replace(/\n+$/, ''); }
  catch { return ''; }
}

function gather() {
  const nowIso = new Date().toISOString();
  const rows = parseTicks(fs.existsSync(TICKS_FILE) ? fs.readFileSync(TICKS_FILE, 'utf8') : '');
  const last = rows.length ? rows[rows.length - 1] : null;
  const duty = dutyCycle(rows, nowIso, { sinceIso: new Date(Date.now() - 24 * 3600000).toISOString() });
  const tickIntervals = rows.slice(-72).map((r) => Number(r.gapMin) || 0);
  let lease = null; try { lease = JSON.parse(fs.readFileSync(LEASE_FILE, 'utf8')); } catch { /* free */ }
  const tests = readDir(path.join(busRoot(), 'tests'));
  const results = readDir(path.join(busRoot(), 'results'));
  const recent = results
    .map((r) => ({ test: r.meta.test || '?', file: r.file, verdict: r.meta.verdict || '?', graded: r.meta.graded || '', grader: r.meta.grader || '?', selfGraded: r.meta['self-graded'] === 'true', note: r.meta.note || '' }))
    .sort((a, b) => String(b.graded).localeCompare(String(a.graded))).slice(0, 15);
  const busDirty = git(['status', '--porcelain', '--', 'tests', 'results'], busRoot());
  return model({
    nowIso,
    host: (process.env.COMPUTERNAME || process.env.HOSTNAME || 'local'),
    build: last ? last.build : '?',
    lease, leaseSt: leaseState(nowIso, lease),
    duty, board: scoreboard(tests, results), census: waitingHuman(tests, results, admissibility(tests)),
    busDirtyN: busDirty ? busDirty.split('\n').filter(Boolean).length : 0,
    recent, tickIntervals, busRootPath: busRoot(),
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const m = gather();
  // HTML — local, git-ignored, no scrub needed (never leaves the machine); everything escaped regardless.
  fs.mkdirSync(path.dirname(HTML_OUT), { recursive: true });
  fs.writeFileSync(HTML_OUT, renderHtml(m));
  console.log(`DASHBOARD ▸ html → ${HTML_OUT}`);
  // MD — a BUS write: scrub + residual-refuse, same contract as every byte that leaves this machine.
  const mdFile = path.join(busRoot(), MD_REL);
  const { scrub, residual } = require('./scrub.cjs');
  const { text: clean, counts } = scrub(renderMd(m));
  if (Object.keys(counts).length) console.log(`DASHBOARD ▸ scrubbed: ${Object.entries(counts).map(([k, n]) => `${k} x${n}`).join(' · ')}`);
  const left = residual(clean);
  if (Object.keys(left).length) { console.error(`DASHBOARD ▸ REFUSING md write — residual PII: ${Object.keys(left).join(' ')}`); process.exit(3); }
  fs.mkdirSync(path.dirname(mdFile), { recursive: true });
  fs.writeFileSync(mdFile, clean);
  console.log(`DASHBOARD ▸ md → ${mdFile}`);
  if (args.includes('--push')) {
    // bus discipline: commit FIRST, then pull --rebase, then push (the exporter commits underneath constantly).
    const bus = busRoot();
    // Wedge guard (glf F6a) — a transiently failed rebase (e.g. index.lock contention with the per-minute
    // exporter or the grader's own push) leaves rebase-in-progress; git() swallows failures, so every later run
    // would fail silently FOREVER — a fails-silent state, the loop's cardinal sin. Abort any stale rebase first.
    // (verify fix) `--git-path` ALWAYS prints a path — the signal is whether that path EXISTS, resolved against
    // the bus root so worktree/gitdir-pointer layouts are honored (a hardcoded .git/ would never match there and
    // the wedge would silently persist — the exact state this guard exists to clear).
    const rebasing = git(['rev-parse', '--git-path', 'rebase-merge'], bus);
    if (rebasing && fs.existsSync(path.resolve(bus, rebasing))) { git(['rebase', '--abort'], bus); console.log('DASHBOARD ▸ aborted a stale rebase (wedge guard)'); }
    // commit ONLY this file (explicit pathspec — `commit -m` without one would sweep whatever another concurrent
    // bus writer has staged, e.g. the grader's results, under a "dashboard:" message).
    git(['add', MD_REL], bus);
    git(['commit', '-m', `dashboard: ${m.nowIso}`, '--', MD_REL], bus);
    git(['pull', '--rebase'], bus);
    git(['push'], bus);
    // Verify delivery instead of trusting silence: ahead>0 after push = NOT delivered — say so visibly.
    // (verify fix) '' means the CHECK ITSELF failed (no upstream / detached HEAD) — that is UNVERIFIED, never
    // "delivered": a verifier that fails open is worse than no verifier.
    const ahead = git(['rev-list', '--count', '@{u}..HEAD'], bus);
    if (ahead === '') console.error('DASHBOARD ▸ push UNVERIFIED — no upstream/detached HEAD; cannot confirm delivery');
    else if (Number(ahead) > 0) console.error(`DASHBOARD ▸ push FAILED — ${ahead} commit(s) undelivered (will retry next firing)`);
    else console.log('DASHBOARD ▸ delivered');
  }
}
