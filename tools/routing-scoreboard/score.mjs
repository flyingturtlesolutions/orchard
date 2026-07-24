/**
 * tools/routing-scoreboard/score.mjs — C.1/C.2 pure scoring (Stage 4, v2.74.1729). NO I/O, NO model — the
 * runner (scoreboard.mjs) feeds decisions in; this classifies and tallies. Self-test: score.test.mjs.
 *
 * Spec: docs/HANDOFF_hardening_arc.md §6 · DESIGN_hardening_ladder.md §4.1/§4.2.
 *
 * Outcome classes per corpus entry (docs order = precedence):
 *   violation — a NEGATIVE was breached (mustNotResolve hit, or mustNotWrite hit a write leg). Worst class.
 *   hit       — the expectation held (leg matched / intent matched / pure negative satisfied).
 *   redirect  — a guard rail absorbed it (clarify / teach / lowConfidence flag) instead of a clean resolve.
 *               C.2's leading indicator: counted separately from miss because the SYSTEM behaved safely even
 *               though the model didn't aim true.
 *   miss      — resolved cleanly to the WRONG thing. The dangerous class C.1 exists to surface.
 *   error     — the call itself failed (runner-stamped; excluded from rate denominators, reported).
 */

const _str = (v) => (typeof v === 'string' ? v.trim() : '');

/** 'me.<app>.<id>@<host>' → '<id>'; a builtin key passes through unchanged. PURE. */
export function legIdFromKey(key) {
  const k = _str(key);
  if (!k) return null;
  const m = /^[^.]+\.[^.]+\.(.+?)(?:@|$)/.exec(k);
  return m ? m[1] : k;
}

/** What did the decision RESOLVE to, if anything? act → its leg id; clause intents carry no leg. PURE. */
export function resolvedLegId(decision) {
  const d = decision || {};
  if (d.intent !== 'act') return null;
  return legIdFromKey(d.capabilityId || d.op || null);
}

/** Did a guard rail absorb this decision? PURE. */
export function isRedirect(decision) {
  const d = decision || {};
  return d.intent === 'clarify' || d.intent === 'teach' || d.lowConfidence === true;
}

/**
 * Score ONE corpus entry against ONE live decision. PURE.
 * @param {object} entry     a Core/goldenAsks.js entry
 * @param {object} decision  the gated decision (interpret() output)
 * @param {{writeIds?: Set<string>}} opts  ids of write-class legs (for mustNotWrite)
 * @returns {{status: 'hit'|'miss'|'redirect'|'violation', got: string, why: string}}
 */
export function scoreEntry(entry, decision, { writeIds = new Set() } = {}) {
  const e = entry || {};
  const d = decision || {};
  const got = resolvedLegId(d);
  const gotLabel = got || `intent:${d.intent || '?'}${d.lowConfidence ? '(low)' : ''}`;

  // negatives outrank everything — a breached fence is a violation no matter what else matched
  if (Array.isArray(e.mustNotResolve) && got && e.mustNotResolve.includes(got)) {
    return { status: 'violation', got: gotLabel, why: `resolved to forbidden leg ${got}` };
  }
  if (e.mustNotWrite && got && writeIds.has(got)) {
    return { status: 'violation', got: gotLabel, why: `a count/read ask resolved to the WRITE leg ${got}` };
  }

  if (e.expect && e.expect.intent) {
    if (d.intent === e.expect.intent) return { status: 'hit', got: gotLabel, why: 'intent matched' };
    if (isRedirect(d)) return { status: 'redirect', got: gotLabel, why: 'guard rail absorbed it' };
    return { status: 'miss', got: gotLabel, why: `wanted intent ${e.expect.intent}` };
  }
  if (e.expect && e.expect.legId) {
    if (got === e.expect.legId) return { status: 'hit', got: gotLabel, why: 'leg matched' };
    if (isRedirect(d)) return { status: 'redirect', got: gotLabel, why: 'guard rail absorbed it' };
    return { status: 'miss', got: gotLabel, why: `wanted ${e.expect.legId}` };
  }
  // a pure negative with no breach above = the fence held
  return { status: 'hit', got: gotLabel, why: 'negative satisfied' };
}

/** Tally results overall + per site. PURE. `results` rows: {site, status, ...}. */
export function tally(results) {
  const mk = () => ({ n: 0, hits: 0, misses: 0, redirects: 0, violations: 0, errors: 0 });
  const overall = mk();
  const perSite = {};
  for (const r of (Array.isArray(results) ? results : [])) {
    const site = r.site || '(unknown)';
    perSite[site] = perSite[site] || mk();
    for (const t of [overall, perSite[site]]) {
      t.n++;
      if (r.status === 'hit') t.hits++;
      else if (r.status === 'miss') t.misses++;
      else if (r.status === 'redirect') t.redirects++;
      else if (r.status === 'violation') t.violations++;
      else t.errors++;
    }
  }
  const rate = (t) => { const scored = t.n - t.errors; return scored ? +(t.hits / scored).toFixed(3) : 0; };
  const redirectRate = (t) => { const scored = t.n - t.errors; return scored ? +(t.redirects / scored).toFixed(3) : 0; };
  overall.rate = rate(overall); overall.redirectRate = redirectRate(overall);
  for (const s of Object.keys(perSite)) { perSite[s].rate = rate(perSite[s]); perSite[s].redirectRate = redirectRate(perSite[s]); }
  return { overall, perSite };
}

/** The C.2 calibration curve: confidence bins × actual correctness. PURE. Bins [0,0.1) … [0.9,1]. */
export function calibrationBins(results, bins = 10) {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: +(i / bins).toFixed(2), hi: +((i + 1) / bins).toFixed(2), n: 0, hits: 0 }));
  for (const r of (Array.isArray(results) ? results : [])) {
    if (r.status === 'error' || typeof r.confidence !== 'number') continue;
    const i = Math.min(bins - 1, Math.max(0, Math.floor(r.confidence * bins)));
    out[i].n++;
    if (r.status === 'hit') out[i].hits++;
  }
  for (const b of out) b.accuracy = b.n ? +(b.hits / b.n).toFixed(3) : null;
  return out;
}

/** One-screen console summary. PURE (returns lines). */
export function summaryLines({ tallies, calibration, results, attribution }) {
  const L = [];
  const o = tallies.overall;
  L.push(`SCOREBOARD ▸ ${attribution.manifestVersion} · model ${attribution.model} · promptSha ${attribution.promptSha.slice(0, 12)}`);
  L.push(`overall ▸ ${o.hits}/${o.n - o.errors} hit (${Math.round(o.rate * 100)}%) · ${o.redirects} redirect (${Math.round(o.redirectRate * 100)}%) · ${o.misses} miss · ${o.violations} VIOLATION${o.errors ? ` · ${o.errors} error` : ''}`);
  for (const [site, t] of Object.entries(tallies.perSite).sort()) {
    L.push(`  ${site.padEnd(28)} ${String(t.hits).padStart(3)}/${String(t.n - t.errors).padEnd(3)} hit · ${t.redirects} redirect · ${t.misses} miss${t.violations ? ` · ${t.violations} VIOLATION` : ''}`);
  }
  const bad = results.filter((r) => r.status === 'miss' || r.status === 'violation');
  if (bad.length) {
    L.push('— misses & violations —');
    for (const r of bad) L.push(`  [${r.status}] "${r.ask.slice(0, 56)}" wanted ${r.expected} got ${r.got} — ${r.why}`);
  }
  const cal = calibration.filter((b) => b.n);
  if (cal.length) L.push(`calibration ▸ ${cal.map((b) => `${b.lo}-${b.hi}:${b.accuracy === null ? '—' : Math.round(b.accuracy * 100) + '%'}(n${b.n})`).join(' · ')}`);
  return L;
}
