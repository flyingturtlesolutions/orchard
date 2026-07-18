// Core/vitalsDashboard.js — VT-2d/2e (v2.74.1583-1585, DESIGN_vitals.md §8): the CONTEXT-DETERMINED dashboard, as
// a pure CanvasSpec builder. "show dashboard" resolves against the desk you're standing in (user directive): the
// Admin desk gets the full VITALS view, a work desk gets ITS OWN slice (its origins' presence + grounds +
// incidents + asks), the Front desk gets the cross-desk OVERVIEW. One phrase, three shapes — all real data.
//
// v2.74.1585 — the builders emit the MOCK's visual grammar (live report: "built dashboard is nothing like the
// mockup"): tile sub-lines, presence DOTS, success BARS, failure-MIX bars, drift CHIPS, severity-striped incident
// CARDS, and a hover ⓘ per block — all via the closed cell/cards vocabulary (canvasSpec.js), never markup.
//
// PURE: no chrome / DOM / LLM / clock — the model (assembled by background/handlers/vitals.js VITALS_DASHBOARD)
// carries `now`. Body-blind discipline holds: everything rendered is a count, a status word, a host, a recipe
// NAME, or a verbatim taught ask — never response bodies or params.

/** Parse a dashboard ask. PURE. null = not a dashboard ask; {explicitAdmin} = "admin"/"vitals" forces the
 * vitals dashboard from ANY desk; bare "show dashboard" resolves by context (the caller owns that ladder). */
export function parseDashboardAsk(text) {
  const m = String(text || '').trim().match(/^(?:show\s+|open\s+|display\s+)?(?:the\s+|my\s+)?(admin\s+|vitals\s+)?dashboard\s*$/i);
  return m ? { explicitAdmin: !!m[1] } : null;
}

const _s = (v) => String(v == null ? '' : v);
const _pct = (r) => (r == null ? '—' : `${Math.round(r * 100)}%`);

/** A friendly clock stamp: "7:02 PM" (today) · "yesterday 7:02 PM" · "Jul 15, 7:02 PM". PURE (now injected;
 * hand-formatted so tests aren't locale-hostage). */
export function clockWord(ts, now) {
  const d = new Date(Number(ts) || 0);
  const n = new Date(Number(now) || 0);
  const hh = d.getHours(); const mm = String(d.getMinutes()).padStart(2, '0');
  const t = `${((hh + 11) % 12) + 1}:${mm} ${hh < 12 ? 'AM' : 'PM'}`;
  if (d.toDateString() === n.toDateString()) return t;
  if (d.toDateString() === new Date((Number(now) || 0) - 86400e3).toDateString()) return `yesterday ${t}`;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MON[d.getMonth()]} ${d.getDate()}, ${t}`;
}

// v2.74.1590 — evidence lines speak HUMAN (live report: "fresh → signed-out (no-json-liveness)" is the
// state-machine's grammar, not the user's). Transition arrows → plain verbs; detector codes → plain causes;
// unknown text passes through untouched (never lossy). PURE.
const _CAUSE_WORDS = {
  'no-json-liveness': 'the session check failed',
  'session-expired': 'the session expired',
  'anon-sentinel': 'the site answered as anonymous',
  'http-401': 'the site returned 401',
  'http-403': 'the site returned 403',
};
export function friendlyVitalsLine(line) {
  let s = String(line || '').trim();
  s = s.replace(/^[\w-]+\s*→\s*signed-out\b/, 'signed out');
  s = s.replace(/^[\w-]+\s*→\s*wrong-account\b/, 'signed in as the wrong account');
  s = s.replace(/^[\w-]+\s*→\s*fresh\b/, 'signed in');
  s = s.replace(/^verified ok$/i, 'verified working again');
  s = s.replace(/^(?:http-)?(\d{3})\s*×\s*(\d+)$/, (m, code, n) => `the read came back ${code} (${n}×)`);
  s = s.replace(/\(([^)]+)\)$/, (m, c) => `(${_CAUSE_WORDS[c.trim()] || c.trim()})`);
  return s;
}

/** Compact age ("just now" / "5m" / "3h" / "2d" / "never"). PURE (now injected). */
export function ageWord(at, now) {
  const t = Number(at) || 0;
  if (!t) return 'never';
  const ms = Math.max(0, Number(now) - t);
  if (ms < 90e3) return 'just now';
  if (ms < 3600e3) return `${Math.round(ms / 60e3)}m`;
  if (ms < 86400e3) return `${Math.round(ms / 3600e3)}h`;
  return `${Math.round(ms / 86400e3)}d`;
}

// The ⓘ texts — the artifact mock's tooltips, verbatim class (each explains meaning + source, hover-revealed).
const HELP = {
  succ: 'Share of ride runs that succeeded across these grounds, last 7 days — counted once per leg at the outcome funnel. A dip here is the earliest warning, before any incident opens.',
  runs: 'Total leg runs in the 7-day window — organic use plus daily canaries.',
  inc: 'Unresolved problems the desk is tracking — one per kind and subject. Opened by the vitals funnel (sign-outs, drift suspects); closed automatically when a verify passes or presence returns.',
  heal: 'Median time from an incident opening to its close, last 30 days — how fast detect → relearn → apply → verify (plus you, for sign-ins) restores service.',
  canary: 'Grounds with a safe daily probe: a proven, parameter-free read the sweep can run without touching your data. A ground without one is drift-blind between real uses.',
  trend: 'Daily success rate across these grounds, from the same outcome tally — days with runs only.',
  grounds: 'One row per learned ground. Success and failure mix come from the outcome funnel — auth vs route is its own classification. Drift chips come from route-heal, proven/armed from recipe records.',
  incidents: 'The incident store, newest first. Open items need a human — usually a sign-in; Orchard never enters credentials. Healed items show the relearn loop’s work.',
  asks: 'Taught phrases that have RUN successfully before, verbatim — the only example asks the desk will ever suggest.',
  presence: 'Sign-in status per origin, from real evidence (rides, probes, setup checks) — never assumed.',
  desks: 'Your desks, newest activity first — cases are their sub-task conversations.',
  proven: 'Reads that have succeeded at least once (or shipped curated) vs everything armed. An unproven read carries no evidence — prove it with one run, or prune.',
  cases: 'This desk’s sub-task conversations.',
  conn: 'Origins with live sign-in evidence vs all known origins.',
};

// ── shared section builders (each returns a block or null — null sections are simply omitted) ──────────────────────

function _presenceMd(registry, { origins = null, now } = {}) {
  const rows = Object.entries(registry || {})
    .filter(([o]) => !origins || origins.includes(o))
    .sort((a, b) => _s(a[0]).localeCompare(_s(b[0])))
    .map(([o, e]) => {
      const st = _s(e && e.status) || 'unknown';
      const mark = st === 'fresh' ? '●' : (st === 'signed-out' || st === 'wrong-account') ? '○' : '·';
      const who = e && e.identityName ? ` — ${_s(e.identityName)}` : '';
      const age = ageWord(e && (e.lastVerifiedAt || e.verifiedAt || e.at), now);
      return `- ${mark} **${o}**${who} · ${st === 'fresh' ? 'signed in' : st} · ${age}`;
    });
  if (!rows.length) return null;
  return { id: 'md-presence', kind: 'markdown', help: HELP.presence, text: `## Connections\n\n${rows.join('\n')}` };
}

function _groundsTable(grounds) {
  const gs = (Array.isArray(grounds) ? grounds : []);
  if (!gs.length) return null;
  const rows = gs.map((g) => {
    const t = g.tally || { total: 0, rate: null, auth: 0, miss: 0 };
    const drift = g.suspects > 0
      ? { chip: g.proposals > 0 ? 'drift? fix ready' : 'drift?', tone: 'danger' }
      : g.healedRecently ? { chip: 'heal ✓', tone: 'violet' }
      : g.canary ? { chip: 'ok', tone: 'ok' }
      : { chip: 'blind', tone: 'warn' };
    return [
      { text: _s(g.host), sub: `${g.armed} armed`, mono: true },
      { dot: g.presence === 'in' ? 'in' : g.presence === 'out' ? 'out' : 'unknown', label: _s(g.presence || 'unknown') },
      t.rate != null ? { bar: t.rate, label: _pct(t.rate) } : { text: '—' },
      String(t.total || 0), String(t.auth || 0), String(t.miss || 0),
      { mix: { ok: t.ok || 0, auth: t.auth || 0, miss: t.miss || 0, other: t.other || 0 } },
      `${g.proven}/${g.armed}`,
      drift,
      _s(g.lastOkAge || 'never'),
    ];
  });
  return { id: 't-grounds', kind: 'table', help: HELP.grounds,
    headers: ['Ground', 'Presence', 'Success · 7d', 'Runs', 'Auth', 'Route', 'Mix', 'Proven', 'Drift', 'Last ok'], rows };
}

function _trendChart(byDay) {
  const days = (Array.isArray(byDay) ? byDay : []).filter((d) => d && d.total > 0);
  if (days.length < 2) return null;   // a one-point trend is noise, not signal
  return { id: 'ch-trend', kind: 'chart', chartType: 'area', help: HELP.trend,
    data: { labels: days.map((d) => _s(d.day).slice(5)), values: days.map((d) => Math.round((d.ok / d.total) * 100)) } };
}

function _incidentsBlock(incidents, { now, cap = 6 } = {}) {
  const list = Array.isArray(incidents) ? incidents : [];
  const open = list.filter((i) => i && i.status === 'open').sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)).slice(0, cap);
  const closed = list.filter((i) => i && i.status === 'closed').sort((a, b) => (b.closedAt || 0) - (a.closedAt || 0)).slice(0, 3);
  const lastLine = (i) => {
    const ev = Array.isArray(i.evidence) ? i.evidence : [];
    return ev.length ? friendlyVitalsLine(ev[ev.length - 1].line) : '';   // v1590 — human words on the dashboard too
  };
  const items = [
    ...open.map((i) => ({ tone: 'open', title: _s(i.title), when: `open ${ageWord(i.openedAt, now)}`,
      body: lastLine(i), marker: `[${_s(i.cls)}] ${_s(i.subject)}` })),
    ...closed.map((i) => {
      const mins = (i.closedAt && i.openedAt) ? Math.max(1, Math.round((i.closedAt - i.openedAt) / 60e3)) : null;
      return { tone: i.cls === 'drift' ? 'heal' : 'closed', title: _s(i.title),
        when: `closed ${ageWord(i.closedAt, now)}${mins != null ? ` · ${mins < 90 ? `${mins}m` : `${Math.round(mins / 60)}h`} open` : ''}`,
        body: lastLine(i), marker: `[${_s(i.cls)}] ${_s(i.subject)}` };
    }),
  ].filter((it) => it.title);
  if (!items.length) return { id: 'md-incidents', kind: 'markdown', help: HELP.incidents, text: '## Incidents\n\n_Silence when green — nothing open, nothing recent._' };
  return { id: 'cd-incidents', kind: 'cards', help: HELP.incidents, items };
}

function _asksMd(asks, { cap = 6 } = {}) {
  const list = (Array.isArray(asks) ? asks : []).slice(0, cap);
  if (!list.length) return null;
  const lines = list.map((a) => `- “${_s(a.ask)}”${a.host ? ` · ${_s(a.host)}` : ''}`);
  return { id: 'md-asks', kind: 'markdown', help: HELP.asks, text: `## Asks that work\n\n${lines.join('\n')}` };
}

function _footMd({ lastDaily, now } = {}) {
  const sweep = lastDaily ? `Last daily sweep ${ageWord(lastDaily, now)} ago.` : 'No daily sweep has run yet.';
  return { id: 'md-foot', kind: 'markdown', text: `_${sweep} Counts only — the dashboard is body-blind (statuses, hosts, names; never content)._` };
}

// Median minutes-to-heal over recently CLOSED incidents. PURE. null when none closed in the window.
export function medianHealMinutes(incidents, { now, days = 30 } = {}) {
  const floor = Number(now) - days * 86400e3;
  const spans = (Array.isArray(incidents) ? incidents : [])
    .filter((i) => i && i.status === 'closed' && i.closedAt >= floor && i.openedAt)
    .map((i) => Math.max(1, Math.round((i.closedAt - i.openedAt) / 60e3)))
    .sort((a, b) => a - b);
  if (!spans.length) return null;
  return spans[Math.floor((spans.length - 1) / 2)];
}

const _healWord = (mins) => (mins == null ? '—' : (mins < 90 ? `${mins}m` : `${Math.round(mins / 60)}h`));

// ── the three scope builders ───────────────────────────────────────────────────────────────────────────────────────

/** The ADMIN (vitals) dashboard — the full operator view. model: { now, registry, grounds, incidents, asks,
 * tallyAll:{total,rate}, byDay, canaryHave, canaryOf, lastDaily }. PURE. @returns {{title, blocks}} */
export function buildAdminDashboardSpec(model) {
  const m = model || {};
  const incidents = Array.isArray(m.incidents) ? m.incidents : [];
  const open = incidents.filter((i) => i && i.status === 'open');
  const closed30 = incidents.filter((i) => i && i.status === 'closed' && i.closedAt >= (m.now - 30 * 86400e3)).length;
  const heal = medianHealMinutes(incidents, { now: m.now });
  const t = m.tallyAll || { total: 0, rate: null };
  const blocks = [
    { id: 'm-succ', kind: 'metric', label: 'Ride success · 7d', value: _pct(t.rate),
      sub: t.total ? `${t.total} runs` : 'no runs yet', help: HELP.succ },
    { id: 'm-runs', kind: 'metric', label: 'Runs · 7d', value: t.total || 0, sub: 'organic + canary', help: HELP.runs },
    { id: 'm-inc', kind: 'metric', label: 'Open incidents', value: open.length,
      sub: open.length ? _s(open[0].subject).slice(0, 40) : 'silence when green', help: HELP.inc },
    { id: 'm-heal', kind: 'metric', label: 'Median time-to-heal', value: _healWord(heal),
      sub: closed30 ? `${closed30} closed · 30d` : 'no heals yet', help: HELP.heal },
    { id: 'm-canary', kind: 'metric', label: 'Canary coverage', value: `${m.canaryHave || 0}/${m.canaryOf || 0}`,
      sub: 'grounds with a safe probe', help: HELP.canary },
    _trendChart(m.byDay),
    _groundsTable(m.grounds),
    _presenceMd(m.registry, { now: m.now }),
    _incidentsBlock(incidents, { now: m.now }),
    _asksMd(m.asks),
    _footMd(m),
  ].filter(Boolean);
  return { title: 'Ground vitals — Admin desk', blocks };
}

/** A WORK DESK's dashboard — the same vitals, scoped to ITS origins, plus its cases. model adds: { deskName,
 * origins, cases:{count} }. PURE. */
export function buildDeskDashboardSpec(model) {
  const m = model || {};
  const incidents = Array.isArray(m.incidents) ? m.incidents : [];
  const open = incidents.filter((i) => i && i.status === 'open');
  const t = m.tallyAll || { total: 0, rate: null };
  const proven = (Array.isArray(m.grounds) ? m.grounds : []).reduce((n, g) => n + (g.proven || 0), 0);
  const armed = (Array.isArray(m.grounds) ? m.grounds : []).reduce((n, g) => n + (g.armed || 0), 0);
  const blocks = [
    { id: 'm-succ', kind: 'metric', label: 'Success · 7d', value: _pct(t.rate),
      sub: t.total ? `${t.total} runs` : 'no runs yet', help: HELP.succ },
    { id: 'm-runs', kind: 'metric', label: 'Runs · 7d', value: t.total || 0, sub: 'organic + canary', help: HELP.runs },
    { id: 'm-inc', kind: 'metric', label: 'Open incidents', value: open.length,
      sub: open.length ? _s(open[0].subject).slice(0, 40) : 'silence when green', help: HELP.inc },
    { id: 'm-proven', kind: 'metric', label: 'Proven reads', value: `${proven}/${armed}`,
      sub: armed ? (proven < armed ? `${armed - proven} unproven` : 'all proven') : 'none armed', help: HELP.proven },
    ...(m.cases && m.cases.count ? [{ id: 'm-cases', kind: 'metric', label: 'Cases', value: m.cases.count, help: HELP.cases }] : []),
    _trendChart(m.byDay),
    _groundsTable(m.grounds),
    _presenceMd(m.registry, { origins: m.origins, now: m.now }),
    _incidentsBlock(incidents, { now: m.now }),
    _asksMd(m.asks),
    ...(!(Array.isArray(m.grounds) && m.grounds.length)
      ? [{ id: 'md-empty', kind: 'markdown', text: '_No learned reads are bound to this desk yet — run one from chat (or bank a capture) and this dashboard fills in._' }] : []),
    _footMd(m),
  ].filter(Boolean);
  return { title: `${_s(m.deskName) || 'Desk'} — dashboard`, blocks };
}

/** The FRONT DESK overview — the cross-desk roster, not the vitals detail (that lives on the Admin desk). model
 * adds: { desks:[{name, cases, updatedAt, pinned}], signedIn, originCount }. PURE. */
export function buildFrontDashboardSpec(model) {
  const m = model || {};
  const incidents = Array.isArray(m.incidents) ? m.incidents : [];
  const open = incidents.filter((i) => i && i.status === 'open');
  const t = m.tallyAll || { total: 0, rate: null };
  const desks = Array.isArray(m.desks) ? m.desks : [];
  const blocks = [
    { id: 'm-desks', kind: 'metric', label: 'Desks', value: desks.length, help: HELP.desks },
    { id: 'm-conn', kind: 'metric', label: 'Signed in', value: `${m.signedIn || 0}/${m.originCount || 0}`,
      sub: 'origins with evidence', help: HELP.conn },
    { id: 'm-inc', kind: 'metric', label: 'Open incidents', value: open.length,
      sub: open.length ? _s(open[0].subject).slice(0, 40) : 'silence when green', help: HELP.inc },
    { id: 'm-succ', kind: 'metric', label: 'Ride success · 7d', value: _pct(t.rate),
      sub: t.total ? `${t.total} runs` : 'no runs yet', help: HELP.succ },
    desks.length ? { id: 't-desks', kind: 'table', help: HELP.desks, headers: ['Desk', 'Cases', 'Updated', ''],
      rows: desks.map((d) => [{ text: _s(d.name) }, String(d.cases || 0), ageWord(d.updatedAt, m.now),
        d.pinned ? { chip: 'pinned', tone: 'mute' } : '']) } : null,
    _presenceMd(m.registry, { now: m.now }),
    _incidentsBlock(incidents, { now: m.now }),
    { id: 'md-hint', kind: 'markdown', text: '_The full vitals view lives on the **Admin desk** — say “show dashboard” there (or “show admin dashboard” from anywhere)._' },
  ].filter(Boolean);
  return { title: 'Orchard — desks overview', blocks };
}
