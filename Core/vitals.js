// Core/vitals.js — VT-0 (DESIGN_vitals.md §2-4): the PURE half of Ground Vitals — the transport-general leg-outcome
// classifier (the one partition contract presence/drift share), canary selection, staleness windows, and the
// incident-list transforms. PURE: no chrome / DOM / LLM / clock (`now` is injected).
//
// The belief kinds are fixed (can-act · shape-current · artifact-freshness); transports supply bindings. v1 binds
// the RIDE classifiers; `transport:'drive'|'broker'` events pass through classified as no-evidence until VT-6/7
// add their bindings — the funnel's signature is transport-general from day one so a new transport never touches
// the spine.

import { rideOutcomeSignal } from './connectionPresence.js';
import { isRouteMiss } from './routeHeal.js';
import { armable } from './rideRecipe.js';

/**
 * Classify ONE leg outcome into per-belief evidence. PURE. The partition contract (spec §3.3): auth and drift
 * verdicts are mutually exclusive readings of the same failure — a signed-out outcome is auth evidence and
 * explicitly NOT drift evidence (spec §3.1 ordering: presence gates shape; the 404-on-anonymous class).
 * @returns {{ auth: 'fresh'|'signed-out'|null, drift: 'ok'|'miss'|null }}
 */
export function classifyLegOutcome({ transport = 'ride', ok = false, status = null, error = '', jsonBody = false, csrfInvolved = false } = {}) {
  if (transport !== 'ride') return { auth: null, drift: null };   // VT-6/7 add the drive/broker bindings
  const auth = rideOutcomeSignal({ ok, httpStatus: status, errorCode: error, csrfInvolved });
  if (ok) return { auth: 'fresh', drift: 'ok' };
  if (auth === 'signed-out' || auth === 'wrong-account') return { auth, drift: null };   // auth evidence, never route evidence
  return { auth, drift: isRouteMiss({ status, error, jsonBody }) ? 'miss' : null };
}

// LEG-1 (v2.74.1593) — endpoint placeholders are canary-fatal UNLESS every one is the recipe's own tab-derived
// urlParam with a funnel-BANKED fill (`lastUrlArgs` — trusted tab provenance; the executor's fallback supplies it
// when the ephemeral visit has no ride tab). User-param placeholders still disqualify — never improvised. PURE.
export function canaryPlaceholdersFillable(r) {
  const eps = String((r && r.endpoint) || '').match(/\{[^}]+\}/g) || [];
  if (!eps.length) return true;
  const uname = r && r.urlParam && r.urlParam.name;
  return eps.every((p) => {
    const n = p.slice(1, -1);
    return n === uname && r.lastUrlArgs && r.lastUrlArgs[n] != null && r.lastUrlArgs[n] !== '';
  });
}

/**
 * Pick a ground's CANARY read (spec §6 discipline, hard-line order): armable, non-write, transport-READ
 * (GET/HEAD, or a curated GraphQL QUERY — a gql POST is a read by DOCUMENT; the read-only belts re-validate the
 * document at both dispatch boundaries, so selection here never widens what can execute), placeholders fillable
 * (none, or the banked urlParam — LEG-1), no required params, PROVEN (curated or ever-succeeded). Preference:
 * `pulse`-marked (the digest legs are exactly canary-shaped) > curated > freshest lastOkAt. Null when the ground
 * has no safe canary — the sweep says so honestly rather than improvising params.
 *
 * v2.74.2052 — the DECLARED-READ class joins candidacy: a CURATED record with an explicit `write: false` (the
 * v1936 plain-JSON-POST-read shape — UPS's `ups_recent`, `pulse:{kind:'liveness'}`, params:[], the catalog's own
 * comment calls it "the ground's CANARY") was structurally excluded by the GET/HEAD-or-gql line, so its declared
 * canary duty was unservable and the ground sat 'no-canary' forever. The §9 story is unchanged: recipeToLeg
 * projects `write:false` as mode 'ask' → planExec stamps `readOnly:true` → BOTH executor belts ride the v1941
 * readOnly carve-out (belt #2's re-validation is declarative for this class, which is why candidacy here demands
 * the CURATED provenance — a harvested/demonstrated record cannot self-declare its way into unattended runs;
 * an ABSENT `write` on a non-GET still fails the line exactly as before (the fail-safe governs the undeclared).
 */
export function pickCanary(recipes) {
  const cands = (Array.isArray(recipes) ? recipes : []).filter((r) => r
    && armable(r)
    && r.write !== true
    && (['GET', 'HEAD'].includes(String(r.method || 'GET').toUpperCase()) || r.gql === true
      || (r.write === false && r.provenance === 'curated'))
    && canaryPlaceholdersFillable(r)
    && !(Array.isArray(r.params) && r.params.some((p) => p && p.required))
    && (r.provenance === 'curated' || r.lastOkAt));
  if (!cands.length) return null;
  const score = (r) => (r.pulse != null ? 4 : 0) + (r.provenance === 'curated' ? 2 : 0) + (r.lastOkAt ? 1 : 0);
  return cands.sort((a, b) => (score(b) - score(a)) || ((b.lastOkAt || 0) - (a.lastOkAt || 0)))[0];
}

/** Is this ground DUE a daily visit — no organic (or probed) success within the window? PURE. */
export function dueForDaily(recipes, now, windowMs) {
  const last = Math.max(0, ...(Array.isArray(recipes) ? recipes : []).map((r) => Number((r && r.lastOkAt) || 0)));
  return (Number(now) - last) >= Number(windowMs);
}

// ── Incidents (spec §8) — one OPEN incident per (class, subject); evidence appends; verify closes. ──────────────────
export const INCIDENT_CAP = 100;      // total incidents kept (closed ones age out first)
export const EVIDENCE_CAP = 12;       // per-incident timeline entries (newest kept)

const _key = (i) => `${i.cls}|${i.subject}`;

/**
 * Open-or-append: if an OPEN incident exists for (cls, subject), append the evidence line (a flapping belief is
 * ONE case with a growing timeline, never case-spam); else create. PURE.
 * @returns {{ list: Array, opened: boolean }} opened = a NEW incident was created (the surface may announce it)
 */
export function upsertIncident(list, { cls, subject, origin = null, groundId = null, recipeId = null, name = null, title = '', line = '', now = 0 } = {}) {
  const l = Array.isArray(list) ? list.slice() : [];
  if (!cls || !subject) return { list: l, opened: false };
  const i = l.findIndex((x) => x && x.status === 'open' && _key(x) === `${cls}|${subject}`);
  if (i >= 0) {
    const inc = { ...l[i] };
    if (line) inc.evidence = [...(inc.evidence || []), { at: Number(now), line: String(line).slice(0, 160) }].slice(-EVIDENCE_CAP);
    l[i] = inc;
    return { list: l, opened: false };
  }
  const inc = {
    id: `vt_${cls}_${String(subject).replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 48)}_${Number(now)}`,
    cls, subject, origin, groundId, recipeId, name,
    title: String(title || subject).slice(0, 120),
    status: 'open', openedAt: Number(now), closedAt: null,
    evidence: line ? [{ at: Number(now), line: String(line).slice(0, 160) }] : [],
  };
  l.push(inc);
  // cap: age out CLOSED first (they are history; the Rail/store keeps only the newest CAP), never an open one.
  while (l.length > INCIDENT_CAP) {
    const j = l.findIndex((x) => x && x.status === 'closed');
    if (j < 0) break;
    l.splice(j, 1);
  }
  return { list: l, opened: true };
}

/**
 * Close the OPEN incident for (cls, subject) — the verify (spec: auto-close, one quiet closing line). PURE.
 * @returns {{ list: Array, closed: boolean }}
 */
export function resolveIncident(list, { cls, subject, line = '', now = 0 } = {}) {
  const l = Array.isArray(list) ? list.slice() : [];
  const i = l.findIndex((x) => x && x.status === 'open' && _key(x) === `${cls}|${subject}`);
  if (i < 0) return { list: l, closed: false };
  const inc = { ...l[i], status: 'closed', closedAt: Number(now) };
  if (line) inc.evidence = [...(inc.evidence || []), { at: Number(now), line: String(line).slice(0, 160) }].slice(-EVIDENCE_CAP);
  l[i] = inc;
  return { list: l, closed: true };
}

/** The open subset, newest first (the Admin desk renders these; closed = history). PURE. */
export function openIncidents(list) {
  return (Array.isArray(list) ? list : []).filter((x) => x && x.status === 'open').sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

/**
 * How long a RESOLVED presence case lingers in the Rail (showing its "✓ all clear") before it auto-dismisses.
 * v2.74.1703 — long enough to register that it cleared, short enough not to accumulate.
 */
export const PRESENCE_DISMISS_GRACE_MS = 30_000;

/**
 * The recently-RESOLVED incidents, newest-closed first — the AUDIT record behind an auto-dismiss. PURE. v2.74.1705.
 *
 * The case (attention surface) is deleted when it self-heals, but the closed incident is still in the store
 * (INCIDENT_CAP keeps the newest, closed ageing out first). So the record the Admin desk shows for "what was
 * auto-dismissed and why" is just these — no new store, the history already exists. Each carries its evidence
 * timeline, so the panel can render subject + how it resolved + when.
 *
 * @param {Array} incidents         the full incident list (open + closed) from VITALS_STATUS
 * @param {{now?:number, max?:number, cls?:string|null}} opts   cls filters (e.g. 'presence' = the auto-dismissed)
 */
export function recentlyResolved(incidents, { now = 0, max = 5, cls = null } = {}) {
  return (Array.isArray(incidents) ? incidents : [])
    .filter((x) => x && x.status === 'closed' && Number(x.closedAt) > 0 && (!cls || x.cls === cls))
    .sort((a, b) => (Number(b.closedAt) || 0) - (Number(a.closedAt) || 0))
    .slice(0, Math.max(0, Number(max) || 0));
}

/**
 * Should this incident's Rail CASE be auto-dismissed (deleted)? PURE. v2.74.1703.
 *
 * "Silence when green" vs "history, not attention" collided: a resolved presence case was kept forever, and once
 * its incident aged out of the store (INCIDENT_CAP) the case ORPHANED. The reconciliation splits by class:
 *
 *   · PRESENCE self-heals — a sign-out that fixed itself needs no permanent record; the Connections card already
 *     shows the origin fresh. So a resolved presence case dismisses after a short grace (the ✓ shows first).
 *   · DRIFT (and anything else) is a SUBSTANTIVE problem worth keeping as history — never auto-dismissed here.
 *
 * The store still holds the closed incident as history (until it ages out); this only removes the RAIL surface.
 */
export function shouldDismissIncidentCase(inc, { now = 0, graceMs = PRESENCE_DISMISS_GRACE_MS } = {}) {
  if (!inc || typeof inc !== 'object') return false;
  if (inc.status !== 'closed') return false;   // only a RESOLVED case
  if (inc.cls !== 'presence') return false;     // presence only — drift is kept as history
  const closedAt = Number(inc.closedAt) || 0;
  if (!closedAt) return false;                  // no resolution stamp → keep (defensive)
  return (Number(now) - closedAt) >= Math.max(0, Number(graceMs) || 0);
}

// ── VT-2c (v2.74.1583) — the rolling outcome TALLY: per-ground per-day {ok,auth,miss,other} counts, the funnel's ──
// one new write path. This is the metric class the binary drift flag can't carry (a ground at 82% is telling you
// something "shape ok" can't) — success RATES + failure MIX for the dashboard, body-blind by construction (counts
// only; no params, no bodies, no asks). Book shape: { [groundId]: { 'YYYY-MM-DD': {ok,auth,miss,other} } }.

export const TALLY_CLASSES = ['ok', 'auth', 'miss', 'other'];
export const TALLY_KEEP_DAYS = 14;    // two windows of the 7d rate — enough for a delta, small enough to never matter

/** The tally class of one funnel outcome — the classifier's partition mapped to the four counted buckets. PURE.
 * `gatedMiss` = a route-miss shape seen while the REGISTRY says signed-out (the 404-on-anonymous class): counted
 * as AUTH (the cause), never as route evidence — the same honesty rule the recipe tick applies. */
export function tallyClassOf({ ok = false, auth = null, drift = null, gatedMiss = false } = {}) {
  if (ok) return 'ok';
  if (auth === 'signed-out' || auth === 'wrong-account') return 'auth';
  if (drift === 'miss') return gatedMiss ? 'auth' : 'miss';
  return 'other';
}

/** Local-date day key for a timestamp. PURE (now injected). */
export function tallyDayKey(now) {
  const d = new Date(Number(now) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Tick one outcome into the book — copy-on-write; prunes entries older than keepDays as it goes. PURE. */
export function tallyTick(book, { groundId, cls, now = 0, keepDays = TALLY_KEEP_DAYS } = {}) {
  const b = (book && typeof book === 'object') ? book : {};
  const gid = String(groundId || '');
  if (!gid || !TALLY_CLASSES.includes(cls)) return b;
  const day = tallyDayKey(now);
  const floor = tallyDayKey(Number(now) - keepDays * 86400e3);
  const next = {};
  for (const [g, days] of Object.entries(b)) {
    if (!days || typeof days !== 'object') continue;
    const kept = {};
    for (const [k, v] of Object.entries(days)) if (k >= floor && v && typeof v === 'object') kept[k] = v;
    if (Object.keys(kept).length) next[g] = kept;
  }
  const gDays = { ...(next[gid] || {}) };
  const cell = { ok: 0, auth: 0, miss: 0, other: 0, ...(gDays[day] || {}) };
  cell[cls] = (Number(cell[cls]) || 0) + 1;
  gDays[day] = cell;
  next[gid] = gDays;
  return next;
}

/** Sum a window: groundIds = one id, an array, or null for ALL grounds. PURE.
 * @returns {{ total:number, ok:number, auth:number, miss:number, other:number, rate:number|null }} */
export function tallySummary(book, groundIds, { now = 0, days = 7 } = {}) {
  const b = (book && typeof book === 'object') ? book : {};
  const ids = groundIds == null ? Object.keys(b) : (Array.isArray(groundIds) ? groundIds : [groundIds]).map(String);
  const floor = tallyDayKey(Number(now) - days * 86400e3);
  const sum = { total: 0, ok: 0, auth: 0, miss: 0, other: 0, rate: null };
  for (const gid of ids) {
    const gDays = b[gid];
    if (!gDays || typeof gDays !== 'object') continue;
    for (const [k, v] of Object.entries(gDays)) {
      if (k < floor || !v || typeof v !== 'object') continue;
      for (const c of TALLY_CLASSES) sum[c] += Number(v[c]) || 0;
    }
  }
  sum.total = sum.ok + sum.auth + sum.miss + sum.other;
  sum.rate = sum.total ? sum.ok / sum.total : null;
  return sum;
}

/** Per-day rollup across grounds for the trend chart, oldest→newest, days with runs only. PURE.
 * @returns {Array<{day:string, total:number, ok:number}>} */
export function tallyByDay(book, groundIds, { now = 0, days = 14 } = {}) {
  const b = (book && typeof book === 'object') ? book : {};
  const ids = groundIds == null ? Object.keys(b) : (Array.isArray(groundIds) ? groundIds : [groundIds]).map(String);
  const floor = tallyDayKey(Number(now) - days * 86400e3);
  const byDay = new Map();
  for (const gid of ids) {
    const gDays = b[gid];
    if (!gDays || typeof gDays !== 'object') continue;
    for (const [k, v] of Object.entries(gDays)) {
      if (k < floor || !v || typeof v !== 'object') continue;
      const cell = byDay.get(k) || { day: k, total: 0, ok: 0 };
      for (const c of TALLY_CLASSES) cell.total += Number(v[c]) || 0;
      cell.ok += Number(v.ok) || 0;
      byDay.set(k, cell);
    }
  }
  return [...byDay.values()].filter((d) => d.total > 0).sort((a, b2) => (a.day < b2.day ? -1 : 1));
}

// ── KA-0/KA-1 (v2.74.1599) — keep-alive: LEARNED idle windows + the user-active-gated opt-in probe plan ─────────────
// Session expiry is org-configured and unknowable a priori (sliding idle / absolute cap / bearer refresh / SSO —
// usually layered), so keep-alive is EMPIRICAL: each observed death teaches the origin's window (a sample = the gap
// between the last fresh evidence and the observed signed-out; the MIN of recent samples is the tightest window a
// session has been SEEN to die inside), the probe cadence is a third of the learned window, and a death that lands
// DESPITE a recent successful ping is a FUTILITY strike (absolute-expiry / bearer class — pinging doesn't slide it;
// two strikes stop the probes honestly instead of burning requests forever). Deaths are learned for EVERY origin
// (KA-0), so the picker can show the observed window before anyone opts in; probing (KA-1) is per-origin OPT-IN and
// the handler additionally gates every sweep on chrome.idle === 'active' — keep-alive means "don't let my session
// rot while I'm actively working in other tabs", never "defeat the site's walk-away timeout". All pure; the handler
// owns storage, clocks, and the idle gate.
export const KA_FLOOR_MS = 20 * 60e3;          // never probe faster than the tick cadence
export const KA_DEFAULT_MS = 30 * 60e3;        // no learned window yet → the presence-window default
export const KA_EST_MAX_MS = 24 * 3600e3;
export const KA_SAMPLE_CAP = 8;
export const KA_STRIKES_FUTILE = 2;
export const KA_PLAN_CAP = 6;

const _kaKey = (origin) => String(origin || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
const _kaRec = (book, k) => {
  const r = (book && typeof book === 'object' && book[k]) || {};
  return { on: false, samples: [], est: null, lastPingAt: 0, lastPingOkAt: 0, strikes: 0, futile: false, ...r };
};

/** Toggle keep-alive for an origin. Re-enabling clears futility (the site's policy may have changed). PURE. */
export function kaSetOptIn(book, origin, on) {
  const k = _kaKey(origin);
  if (!k) return book || {};
  const rec = _kaRec(book, k);
  const next = { ...rec, on: on === true };
  if (on === true) { next.futile = false; next.strikes = 0; }
  return { ...(book || {}), [k]: next };
}

/** The probe cadence for a record: futile → null (stop); learned window/3, floored; else the default. PURE. */
export function kaCadenceMs(rec) {
  if (!rec || rec.futile === true) return null;
  const est = Number(rec.est) || 0;
  return est > 0 ? Math.max(KA_FLOOR_MS, Math.round(est / 3)) : KA_DEFAULT_MS;
}

/** Stamp a ping attempt (ok also refreshes lastPingOkAt). PURE. */
export function kaNotePing(book, origin, { ok = false, now = 0 } = {}) {
  const k = _kaKey(origin);
  if (!k) return book || {};
  const rec = _kaRec(book, k);
  return { ...(book || {}), [k]: { ...rec, lastPingAt: Number(now) || 0, ...(ok ? { lastPingOkAt: Number(now) || 0 } : {}) } };
}

/**
 * Learn from an observed death (fresh → signed-out). The gap sample teaches the window; a death within 1.5×cadence
 * of the last SUCCESSFUL ping is a futility strike — the ping provably didn't slide the session. PURE.
 */
export function kaRecordDeath(book, origin, { gapMs = 0, now = 0 } = {}) {
  const k = _kaKey(origin);
  if (!k) return book || {};
  const rec = _kaRec(book, k);
  const g = Number(gapMs);
  const samples = (Number.isFinite(g) && g > 0 && g < KA_EST_MAX_MS * 2)
    ? [...rec.samples, Math.round(g)].slice(-KA_SAMPLE_CAP) : rec.samples;
  const est = samples.length ? Math.min(KA_EST_MAX_MS, Math.max(KA_FLOOR_MS, Math.min(...samples))) : rec.est;
  const cad = kaCadenceMs(rec);
  const struck = rec.on && cad != null && rec.lastPingOkAt > 0 && (Number(now) - rec.lastPingOkAt) <= cad * 1.5;
  const strikes = struck ? rec.strikes + 1 : rec.strikes;
  return { ...(book || {}), [k]: { ...rec, samples, est, strikes, futile: rec.futile || strikes >= KA_STRIKES_FUTILE } };
}

/**
 * The sweep plan: which opted-in origins to touch NOW, and how. Only FRESH entries qualify — keep-alive keeps a
 * live session alive; recovery from signed-out belongs to the human (and wrong-account is never probed). An open
 * tab → 'probe' (the registry's learned spec rides along); no tab → 'canary' when the ephemeral tier is on (the
 * §16 vehicle — the handler resolves the ground; a ground with no safe canary skips honestly). Stalest first. PURE.
 */
export function kaPlan(book, registry, { now = 0, openOrigins = [], ephemeralOk = false } = {}) {
  const open = new Set((Array.isArray(openOrigins) ? openOrigins : []).map(_kaKey).filter(Boolean));
  const out = [];
  for (const [k, rec0] of Object.entries(book || {})) {
    const rec = _kaRec(book, k);
    if (!rec.on || rec0 == null) continue;
    const cad = kaCadenceMs(rec);
    if (cad == null) continue;                                     // futile — stopped honestly
    const e = (registry || {})[k];
    if (!e || e.status !== 'fresh') continue;                      // only a LIVE session is kept alive
    const age = Number(now) - (Number(e.lastVerifiedAt) || 0);
    if (age < cad) continue;
    if (rec.lastPingAt > 0 && (Number(now) - rec.lastPingAt) < cad) continue;   // ATTEMPT-throttle: a failing/skipping origin retries at cadence, never every tick
    if (open.has(k)) {
      if (!e.probePath) continue;                                  // no learned probe spec yet — the first ride teaches it
      out.push({ origin: k, mode: 'probe', age, probePath: e.probePath, probeHeaders: e.probeHeaders || null, probeAccept: e.probeAccept || 'identity' });
    } else if (ephemeralOk) {
      out.push({ origin: k, mode: 'canary', age });
    }
  }
  return out.sort((a, b) => b.age - a.age).slice(0, KA_PLAN_CAP);
}
