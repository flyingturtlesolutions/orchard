// background/handlers/vitals.js — Ground Vitals (DESIGN_vitals.md, VT-0..VT-4): the I/O half of the subsystem.
// Owns: the transport-general LEG-OUTCOME FUNNEL (`reportLegOutcome` — the ONE call every executor makes; it
// classifies presence → drift in order and applies the ticks), the SCHEDULER (one `vitals:tick` alarm — the
// window is the cadence, the tick is just the scanner; absorbs the old `conn:heartbeat`), the DAILY VISIT
// (per ride-armed ground: canary read through the NORMAL executor — its §16 ephemeral-tab machinery + belts do
// the rest; result discarded), the one-shot CONFIRM re-probe, the signed-out→fresh CATCH-UP (VT-4), and the
// INCIDENT store the Admin desk renders (VT-2). Heal machinery stays owned by its substrates — this module
// schedules detection and records incidents; it never re-implements a heal (spec §1 boundary).
//
// Wiring: `initVitals(ctx)` from background.js with { invokeSgHandler, readRideRecipes, writeRideRecipes,
// readConnRegistry, reportAuthSignal }; `onConnTransition` registered with connections.js' transition listeners.
// Everything is fail-safe: vitals must never break the call (or the boot) it observes.

import { Logger } from '../../Core/Logger.js';
import { StorageManager } from '../../Services/StorageManager.js';
import { classifyLegOutcome, pickCanary, dueForDaily, upsertIncident, resolveIncident, openIncidents,
  tallyClassOf, tallyTick, tallySummary, tallyByDay,
  kaSetOptIn, kaCadenceMs, kaNotePing, kaRecordDeath, kaPlan } from '../../Core/vitals.js';   // KA-0/1 (v2.74.1599) — keep-alive: learned windows + the idle-gated opt-in probe plan
import { buildAdminDashboardSpec, buildDeskDashboardSpec, buildFrontDashboardSpec, ageWord } from '../../Core/vitalsDashboard.js';
import { tickOk, tickRouteMiss } from '../../Core/routeHeal.js';
import { heartbeatTargets } from '../../Core/connectionPresence.js';
import { armable } from '../../Core/rideRecipe.js';
import { invokeRideRecipe } from '../../Core/rideStep.js';   // DESIGN_cadence.md §12 (v1715) — share the RUNNER: one resolve→plan→invoke for the canary AND the workflow step

const TICK_ALARM = 'vitals:tick';
const CONFIRM_PREFIX = 'vitals:confirm:';
const LAST_DAILY_KEY = 'vitals:lastDaily';
const SETTINGS_KEY = 'settings:vitals';
const INC_KEY = 'vitals:incidents';
const TALLY_KEY = 'vitals:tally';
const KA_KEY = 'vitals:ka';           // KA-0/1 — { [origin]: { on, samples[], est, lastPingAt, lastPingOkAt, strikes, futile } }

let _ctx = null;

async function _settings() {
  let s = {};
  try { s = (await chrome.storage.local.get(SETTINGS_KEY))?.[SETTINGS_KEY] || {}; } catch { /* */ }
  return {
    enabled: s.enabled !== false,                                   // the subsystem master switch
    presenceWindowMin: Number(s.presenceWindowMin) > 0 ? Number(s.presenceWindowMin) : 30,   // spec §5: 30–60min open-tab
    dailyWindowH: Number(s.dailyWindowH) > 0 ? Number(s.dailyWindowH) : 24,
    ephemeral: s.ephemeral !== false,                               // the closed-tab tier (spec §11: on-with-notice; the visit logs itself)
  };
}

async function _registry() { try { return (await _ctx.readConnRegistry()) || {}; } catch { return {}; } }
async function _presenceStatus(origin) {
  const o = String(origin || '').toLowerCase();
  if (!o) return null;
  const e = (await _registry())[o];
  return (e && e.status) || null;
}
async function _openOrigins() {
  try {
    const tabs = await chrome.tabs.query({});
    return [...new Set(tabs.filter((t) => t && !t.discarded && /^https?:\/\//i.test(t.url || ''))
      .map((t) => { try { return new URL(t.url).host.toLowerCase(); } catch { return null; } })
      .filter(Boolean))];
  } catch { return []; }
}

// ── the incident store (VT-2) — chained RMW over the pure transforms; broadcast so an open panel refreshes ─────────
let _incChain = Promise.resolve();
function _mutateIncidents(fn) {
  const step = _incChain.then(async () => {
    let list = [];
    try { list = (await chrome.storage.local.get(INC_KEY))?.[INC_KEY] || []; } catch { /* */ }
    const r = fn(Array.isArray(list) ? list : []);
    try { await chrome.storage.local.set({ [INC_KEY]: r.list }); } catch { /* */ }
    return r;
  }).catch(() => ({ list: [], opened: false, closed: false }));
  _incChain = step.then(() => {}, () => {});
  return step;
}
async function readIncidents() {
  try { const l = (await chrome.storage.local.get(INC_KEY))?.[INC_KEY]; return Array.isArray(l) ? l : []; } catch { return []; }
}
function _broadcastVitals() {
  try { chrome.runtime.sendMessage({ type: 'VITALS_CHANGED' }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
}
// ── VT-2c (v2.74.1583) — the rolling outcome tally: one serialized RMW per funnel event (the funnel is often
// fire-and-forget from the executor, so unserialized writes would race and drop counts). Body-blind counts only.
let _tallyChain = Promise.resolve();
function _tallyWrite(groundId, cls) {
  const step = _tallyChain.then(async () => {
    let book = {};
    try { book = (await chrome.storage.local.get(TALLY_KEY))?.[TALLY_KEY] || {}; } catch { /* */ }
    const next = tallyTick(book, { groundId, cls, now: Date.now() });
    try { await chrome.storage.local.set({ [TALLY_KEY]: next }); } catch { /* */ }
  }).catch(() => { /* the tally must never break the funnel */ });
  _tallyChain = step;
  return step;
}
async function _readTally() {
  try { return (await chrome.storage.local.get(TALLY_KEY))?.[TALLY_KEY] || {}; } catch { return {}; }
}

// ── KA-0/1 (v2.74.1599) — the keep-alive book: serialized RMW (deaths + pings + toggles share one chain) ──────────
let _kaChain = Promise.resolve();
function _kaMutate(fn) {
  const step = _kaChain.then(async () => {
    let book = {};
    try { book = (await chrome.storage.local.get(KA_KEY))?.[KA_KEY] || {}; } catch { /* */ }
    const next = fn((book && typeof book === 'object') ? book : {});
    try { await chrome.storage.local.set({ [KA_KEY]: next }); } catch { /* */ }
    return next;
  }).catch(() => ({}));
  _kaChain = step.then(() => {}, () => {});
  return step;
}
async function _kaBook() {
  try { const b = (await chrome.storage.local.get(KA_KEY))?.[KA_KEY]; return (b && typeof b === 'object') ? b : {}; } catch { return {}; }
}
// The consent gate: keep-alive fires ONLY while the user is actively using the browser (chrome.idle 'active',
// 5-min detection window). Fail-CLOSED — no idle verdict (missing permission, API error) means no pings: the
// walk-away property is the design ("don't let my session rot while I'm working", never "defeat the timeout").
function _userActive() {
  return new Promise((resolve) => {
    try { chrome.idle.queryState(300, (st) => { void chrome.runtime.lastError; resolve(st === 'active'); }); }
    catch { resolve(false); }
  });
}

async function _openIncident(fields) {
  const r = await _mutateIncidents((l) => upsertIncident(l, { ...fields, now: Date.now() }));
  if (r.opened) { try { Logger.info('conn', `VITALS ▸ incident open [${fields.cls}] ${fields.subject}`); } catch { /* */ } }
  _broadcastVitals();
}
async function _closeIncident(fields) {
  const r = await _mutateIncidents((l) => resolveIncident(l, { ...fields, now: Date.now() }));
  if (r.closed) { try { Logger.info('conn', `VITALS ▸ incident closed [${fields.cls}] ${fields.subject}`); } catch { /* */ } }
  if (r.closed) _broadcastVitals();
}

// ── VT-0 — the outcome funnel: presence → drift, in order; the ONE call per executor ───────────────────────────────
/**
 * @param {object} evt { transport, ok, status, error, jsonBody, csrfInvolved, origin, groundId, recipeId,
 *                       probePath, probeHeaders, probeAccept }  (probe fields: the registry's spec self-heal rides along)
 * @returns {Promise<null | { auth: string|null, suspect: boolean, becameSuspect: boolean }>}
 */
export async function reportLegOutcome(evt) {
  try {
    if (!_ctx) return null;
    const { transport = 'ride', ok = false, status = null, error = '', jsonBody = false, csrfInvolved = false,
      origin = '', groundId = null, recipeId = null, probePath = null, probeHeaders = null, probeAccept = null,
      urlArgs = null } = evt || {};   // LEG-1 (v2.74.1593) — tab-derived urlParam values ride the outcome so the record banks them
    const cls = classifyLegOutcome({ transport, ok, status, error, jsonBody, csrfInvolved });
    if (cls.auth && origin && typeof _ctx.reportAuthSignal === 'function') {
      void _ctx.reportAuthSignal({
        origin, status: cls.auth, source: 'ride',
        cause: cls.auth === 'signed-out' ? (String(error || '') || (status ? `http-${status}` : null)) : null,
        probePath, probeHeaders, probeAccept,
      });
    }
    // spec §3.1 — the reactive half of presence-gates-drift: refuse route-miss evidence while the REGISTRY
    // says the session is out (the 404-on-anonymous class — a logged-out app must never read as drift).
    // Hoisted (v2.74.1583) so the recipe tick AND the tally share ONE gate verdict.
    let gatedMiss = false;
    if (cls.drift === 'miss') {
      const ps = await _presenceStatus(origin);
      gatedMiss = ps === 'signed-out' || ps === 'wrong-account';
    }
    let suspect = false, becameSuspect = false;
    if (groundId && recipeId && cls.drift !== null) {
      if (!gatedMiss) {
        const list = await _ctx.readRideRecipes(groundId);
        const i = Array.isArray(list) ? list.findIndex((r) => r && r.id === recipeId) : -1;
        if (i >= 0) {
          const t = cls.drift === 'ok' ? tickOk(list[i], Date.now()) : tickRouteMiss(list[i], Date.now());
          // LEG-1 (v2.74.1593) — bank the tab-derived urlArgs (e.g. Shopify's {handle}) on SUCCESSFUL runs: the
          // ephemeral daily canary has no /store/ tab, so the executor's urlParam fill falls back to this banked
          // value (trusted tab provenance — the executor never lets the model supply it). Written only when it
          // actually changed, riding the same list-write as the tick when both fire.
          const wantArgs = (ok && urlArgs && typeof urlArgs === 'object' && Object.keys(urlArgs).length) ? urlArgs : null;
          let rec = t ? t.record : list[i];
          let dirty = !!t;
          if (wantArgs && JSON.stringify(rec.lastUrlArgs || null) !== JSON.stringify(wantArgs)) { rec = { ...rec, lastUrlArgs: wantArgs }; dirty = true; }
          if (dirty) {
            const next = list.slice(); next[i] = rec;
            await _ctx.writeRideRecipes(groundId, next);
          }
          if (t) {
            suspect = rec.driftSuspect === true;
            becameSuspect = !!t.becameSuspect;
            if (t.becameSuspect) {
              Logger.info('ride', `HEAL ▸ suspect ${recipeId} (${origin} ${status || error || '?'} ×${t.streak}) — the request shape may have changed`);
              void _openIncident({ cls: 'drift', subject: recipeId, origin, groundId, recipeId, name: rec.name || recipeId,
                title: `“${rec.name || recipeId}” on ${origin} may have changed its request shape`, line: `${status || error || '?'} ×${t.streak}` });
            } else if (t.cleared) {
              Logger.info('ride', `HEAL ▸ cleared ${recipeId} (${origin} verified ok)`);
              void _closeIncident({ cls: 'drift', subject: recipeId, line: 'verified ok' });
            }
          } else if (cls.drift === 'ok') {
            suspect = rec.driftSuspect === true;   // throttled stamp — drift state unchanged
          }
        }
      }
    }
    // VT-2c — the tally tick: per-ground per-day counts (the rates the binary drift flag can't carry). The gated
    // miss counts as AUTH (the cause) — the same honesty the recipe tick applies. Fire-and-forget, serialized.
    if (groundId) void _tallyWrite(groundId, tallyClassOf({ ok, auth: cls.auth, drift: cls.drift, gatedMiss }));
    return { auth: cls.auth, suspect, becameSuspect };
  } catch { /* the funnel must never break the call it observes */ }
  return null;
}

// ── VT-4 — presence transitions: incidents + the signed-out→fresh catch-up ─────────────────────────────────────────
export function onConnTransition(tr) {
  try {
    if (!tr || !tr.origin) return;
    if (tr.to === 'signed-out' || tr.to === 'wrong-account') {
      void _openIncident({ cls: 'presence', subject: tr.origin, origin: tr.origin,
        title: `${tr.origin} ${tr.to === 'wrong-account' ? 'is signed in as the wrong account' : 'looks signed out'}`,
        line: `${tr.from} → ${tr.to}${tr.cause ? ` (${tr.cause})` : ''}` });
      // KA-0 (v2.74.1599) — every observed death teaches the origin's idle window (gap = last fresh evidence →
      // this observation), opted in or not; a death that beat a recent successful ping is the futility strike.
      if (tr.to === 'signed-out' && tr.prevVerifiedAt > 0) {
        void _kaMutate((b) => kaRecordDeath(b, tr.origin, { gapMs: Date.now() - tr.prevVerifiedAt, now: Date.now() }));
      }
    } else if (tr.to === 'fresh') {
      void _closeIncident({ cls: 'presence', subject: tr.origin, line: 'signed in again' });
      void _recoveryCatchUp(tr.origin);   // spec §3.2 — the deferred checks fire on the RECOVERY transition, not the next alarm
    }
  } catch { /* */ }
}

async function _recoveryCatchUp(origin) {
  try {
    if (!_ctx) return;
    const s = await _settings(); if (!s.enabled) return;
    const o = String(origin || '').toLowerCase();
    for (const g of await _vitalsGrounds()) {
      if (g.host !== o) continue;
      if (!dueForDaily(g.armed, Date.now(), s.dailyWindowH * 3600e3)) continue;
      const canary = pickCanary(g.armed); if (!canary) continue;
      const r = await _runCanary(g.groundId, canary);
      Logger.info('conn', `VITALS ▸ catch-up ${g.host} after sign-in → canary [${canary.id}] ${r && r.success ? 'ok' : `FAIL ${(r && r.error) || '?'}`}`);
    }
  } catch { /* */ }
}

// ── VT-1/VT-3 — the scheduler + the sweeps ─────────────────────────────────────────────────────────────────────────
export function initVitals(ctx) {
  _ctx = (ctx && typeof ctx === 'object') ? ctx : null;
  try { chrome.alarms.clear('conn:heartbeat'); } catch { /* absorbed (VT-1) — one clock owner */ }
  try { chrome.alarms.create(TICK_ALARM, { periodInMinutes: 20 }); } catch { /* */ }
  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (!alarm || !alarm.name) return;
      if (alarm.name === TICK_ALARM) { _tick().catch(() => { /* */ }); }
      else if (alarm.name.startsWith(CONFIRM_PREFIX)) { _confirmFire(alarm.name.slice(CONFIRM_PREFIX.length)).catch(() => { /* */ }); }
    });
  } catch { /* */ }
  // launch = an immediate tick-if-due (spec §4): the SW boots dozens of times a day, so the tick itself is
  // window-gated — a boot inside every window is a no-op. Small delay lets the boot finish wiring.
  try { setTimeout(() => { _tick().catch(() => { /* */ }); }, 5000); } catch { /* */ }
}

async function _tick() {
  if (!_ctx) return;
  const s = await _settings(); if (!s.enabled) return;
  await _presenceSweep(s);
  await _keepAliveSweep(s);   // KA-1 — after presence: an opted-in FRESH origin past its cadence gets its ping
  let last = 0;
  try { last = Number((await chrome.storage.local.get(LAST_DAILY_KEY))?.[LAST_DAILY_KEY] || 0); } catch { /* */ }
  if (Date.now() - last >= s.dailyWindowH * 3600e3) {
    try { await chrome.storage.local.set({ [LAST_DAILY_KEY]: Date.now() }); } catch { /* */ }   // stamp at START (double-run guard across SW restarts)
    await _dailySweep(s);
  }
}

// The absorbed open-tab heartbeat: probe only probe-bearing, stale-enough, OPEN-tab origins (organic evidence
// suppresses — an actively-used app is never probed). Probing stays in the connector domain (CONN_PROBE_ORIGIN).
async function _presenceSweep(s) {
  try {
    const [registry, open] = await Promise.all([_registry(), _openOrigins()]);
    const targets = heartbeatTargets(registry, open, { now: Date.now(), minAgeMs: s.presenceWindowMin * 60e3, cap: 4 });
    if (!targets.length) return;
    let probed = 0;
    for (const t of targets) {
      try {
        const r = await _ctx.invokeSgHandler('CONN_PROBE_ORIGIN', { origin: t.origin, probePath: t.probePath, probeHeaders: t.probeHeaders, probeAccept: t.probeAccept, source: 'heartbeat' });
        if (r && r.success !== false) probed++;
      } catch { /* per-origin best-effort */ }
    }
    Logger.info('conn', `VITALS ▸ presence probed ${probed}/${targets.length} open-tab origin(s)`);
  } catch { /* */ }
}

/** Every ground holding ≥1 armable ride recipe, with its (modal) host + the armable set. */
async function _vitalsGrounds() {
  const out = [];
  try {
    const grounds = await StorageManager.getAllGrounds();
    for (const g of (Array.isArray(grounds) ? grounds : [])) {
      const gid = g && (g.id || g.groundId); if (!gid) continue;
      let recs = []; try { recs = (await _ctx.readRideRecipes(gid)) || []; } catch { recs = []; }
      const armed = recs.filter((r) => r && armable(r) && r.origin);
      if (!armed.length) continue;
      const counts = {};
      for (const r of armed) { const o = String(r.origin).toLowerCase(); counts[o] = (counts[o] || 0) + 1; }
      const host = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
      out.push({ groundId: gid, host, armed });
    }
  } catch { /* */ }
  return out;
}

async function _hostHasTab(host) {
  try { const tabs = await chrome.tabs.query({ url: [`*://${host}/*`] }); return (tabs || []).length > 0; } catch { return false; }
}

// The canary runs through the NORMAL executor (recipeToLeg → planExec → INVOKE_SESSION): the §16 ephemeral-tab
// cold start, the arm guard, the belts, and the VT-0 funnel all apply unchanged — the sweep is JUST a caller.
// The result VALUE is discarded here (spec §6: the sweep wants the verdict, never the data).
async function _runCanary(groundId, rec) {
  try {
    // §12 (v1715) — the canary rides the SHARED runner (Core/rideStep.invokeRideRecipe), not its own copy of
    // recipeToLeg→planExec→INVOKE_SESSION. Contract preserved: unresolvable (no leg / no plan) → null, exactly
    // as before; an invoke reply maps to the {success, error, status} shape the sweep callers read.
    const r = await invokeRideRecipe(rec, groundId, { invoke: (payload) => _ctx.invokeSgHandler('INVOKE_SESSION', payload) });
    if (r.error === 'no-leg' || r.error === 'no-plan') return null;
    return { success: r.ok, error: r.ok ? null : (r.error || null), status: r.status || null };
  } catch { return null; }
}

// ── KA-1 (v2.74.1599) — the keep-alive sweep: opt-in per origin, USER-ACTIVE-gated, learned cadence. An open tab
// gets the light identity probe (the registry's learned spec, real tab context); a closed tab rides the §16
// ephemeral canary (value discarded; the funnel's ok stamps fresh) when that tier is on. Futile origins are
// skipped by the plan itself — the honest end state for absolute-expiry / bearer-class sites.
async function _keepAliveSweep(s) {
  try {
    const book = await _kaBook();
    if (!Object.values(book).some((r) => r && r.on)) return;        // nobody opted in — zero cost
    if (!(await _userActive())) return;                             // the consent gate: walk away → pings stop → the site times out naturally
    const [registry, open] = await Promise.all([_registry(), _openOrigins()]);
    const plan = kaPlan(book, registry, { now: Date.now(), openOrigins: open, ephemeralOk: s.ephemeral });
    for (const p of plan) {
      let ok = false;
      try {
        if (p.mode === 'probe') {
          const r = await _ctx.invokeSgHandler('CONN_PROBE_ORIGIN', { origin: p.origin, probePath: p.probePath, probeHeaders: p.probeHeaders, probeAccept: p.probeAccept, source: 'heartbeat' });
          ok = !!(r && r.success !== false);
        } else {
          const g = (await _vitalsGrounds()).find((x) => x.host === p.origin);
          const canary = g && pickCanary(g.armed);
          if (!canary) {
            Logger.info('conn', `VITALS ▸ keepalive ${p.origin} skip — no safe canary (open its tab once, or run any read)`);
            await _kaMutate((b) => kaNotePing(b, p.origin, { ok: false, now: Date.now() }));   // stamp the ATTEMPT so the skip throttles to cadence
            continue;
          }
          const r = await _runCanary(g.groundId, canary);
          ok = !!(r && r.success);
        }
      } catch { ok = false; }
      await _kaMutate((b) => kaNotePing(b, p.origin, { ok, now: Date.now() }));
      Logger.info('conn', `VITALS ▸ keepalive ${p.origin} ${p.mode} → ${ok ? 'ok' : 'FAIL'}`);
      await new Promise((res) => setTimeout(res, 800));             // politeness spacing
    }
  } catch { /* */ }
}

async function _dailySweep(s) {
  const gs = await _vitalsGrounds();
  let visited = 0, deferred = 0, fresh = 0, noCanary = 0;
  for (const g of gs) {
    try {
      if (!dueForDaily(g.armed, Date.now(), s.dailyWindowH * 3600e3)) { fresh++; continue; }   // organic evidence within the window
      const ps = await _presenceStatus(g.host);
      if (ps === 'signed-out' || ps === 'wrong-account') { deferred++; continue; }   // spec §3.2 — deferred(signed-out); the presence incident already stands; the catch-up fires on recovery
      const canary = pickCanary(g.armed);
      if (!canary) { noCanary++; Logger.info('conn', `VITALS ▸ visit ${g.host} skip — no canary (no params-free proven read)`); continue; }
      if (!s.ephemeral && !(await _hostHasTab(g.host))) { deferred++; continue; }    // closed-tab tier off → open-tab grounds only
      const r = await _runCanary(g.groundId, canary);
      visited++;
      Logger.info('conn', `VITALS ▸ visit ${g.host} canary [${canary.id}] → ${r && r.success ? 'ok' : `FAIL ${(r && r.error) || 'no-reply'}`} (ground ${g.groundId})`);
      // A route-miss-shaped failure gets ONE same-day confirm (spec §4): ×2 crosses the suspect threshold in
      // ~45min instead of two daily ticks. One-shot; never re-armed by the confirm itself.
      if (r && r.success === false && /^http-(404|405|410)$/.test(String(r.error || ''))) {
        try {
          const name = CONFIRM_PREFIX + g.groundId;
          const existing = await chrome.alarms.get(name);
          if (!existing) chrome.alarms.create(name, { delayInMinutes: 45 });
        } catch { /* */ }
      }
      await new Promise((res) => setTimeout(res, 1500));   // politeness spacing between visits
    } catch { /* per-ground best-effort */ }
  }
  Logger.info('conn', `VITALS ▸ daily sweep: ${gs.length} ground(s) — ${visited} visited, ${fresh} fresh, ${deferred} deferred, ${noCanary} no-canary`);
}

async function _confirmFire(groundId) {
  try {
    if (!_ctx) return;
    const s = await _settings(); if (!s.enabled) return;
    let recs = []; try { recs = (await _ctx.readRideRecipes(groundId)) || []; } catch { return; }
    const armed = recs.filter((r) => r && armable(r) && r.origin);
    const canary = pickCanary(armed); if (!canary) return;
    const host = String(canary.origin || '').toLowerCase();
    const ps = await _presenceStatus(host);
    if (ps === 'signed-out' || ps === 'wrong-account') return;
    const r = await _runCanary(groundId, canary);
    Logger.info('conn', `VITALS ▸ confirm ${host} canary [${canary.id}] → ${r && r.success ? 'ok' : `FAIL ${(r && r.error) || 'no-reply'}`} (ground ${groundId})`);
  } catch { /* */ }
}

// ── VT-2 — the handlers the Admin desk renders from ────────────────────────────────────────────────────────────────
export function createVitalsHandlers() {
  return {
    // The full vitals picture: the presence registry + incidents + a per-ground shape rollup (counts + names only).
    VITALS_STATUS: (_payload, _sender, sendResponse) => {
      (async () => {
        try {
          const registry = await _registry();
          const incidents = await readIncidents();
          const grounds = (await _vitalsGrounds()).map((g) => ({
            groundId: g.groundId, host: g.host, armed: g.armed.length,
            driftSuspects: g.armed.filter((r) => r.driftSuspect === true).length,
            proposals: g.armed.filter((r) => r.healProposal).length,
            lastOkAt: Math.max(0, ...g.armed.map((r) => Number(r.lastOkAt) || 0)) || null,
            suspects: g.armed.filter((r) => r.driftSuspect === true).slice(0, 6).map((r) => ({ id: r.id, name: r.name || r.id, hasProposal: !!r.healProposal })),
          }));
          sendResponse({ success: true, registry, incidents, grounds, now: Date.now() });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'vitals-status-failed' }); }
      })();
      return true;
    },
    // The cheap attention count (the Front-desk chip + per-desk pointers): open incidents only, one storage read.
    VITALS_BADGE: (_payload, _sender, sendResponse) => {
      (async () => {
        try { const open = openIncidents(await readIncidents()); sendResponse({ success: true, open: open.length }); }
        catch { sendResponse({ success: true, open: 0 }); }
      })();
      return true;
    },
    // VT-2d (v2.74.1583) — the CONTEXT dashboard: assemble the scope's model from the real stores (registry ·
    // incidents · recipes · the VT-2c tally · aliases) and shape it through the pure builders into a CanvasSpec.
    // scope: 'admin' (full vitals) | 'desk' (payload.origins slice + payload.cases) | 'front' (payload.desks
    // roster). The panel renders the returned spec via RENDER_CANVAS — this handler never opens a tab itself.
    VITALS_DASHBOARD: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const p = (payload && typeof payload === 'object') ? payload : {};
          const scope = ['admin', 'desk', 'front'].includes(p.scope) ? p.scope : 'admin';
          const now = Date.now();
          const norm = (o) => String(o || '').toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
          const origins = Array.isArray(p.origins) ? p.origins.map(norm).filter(Boolean) : null;
          const inScope = (host) => !origins || origins.includes(String(host || '').toLowerCase());
          const [registryAll, incidentsAll, book, gsRaw] = await Promise.all([_registry(), readIncidents(), _readTally(), _vitalsGrounds()]);
          const gs = gsRaw.filter((g) => scope !== 'desk' || inScope(g.host));
          const grounds = gs.map((g) => {
            const st = (registryAll[g.host] && registryAll[g.host].status) || null;
            return {
              host: g.host, groundId: g.groundId, armed: g.armed.length,
              proven: g.armed.filter((r) => Number(r.lastOkAt) > 0 || r.provenance === 'curated').length,
              suspects: g.armed.filter((r) => r.driftSuspect === true).length,
              proposals: g.armed.filter((r) => r.healProposal).length,
              healedRecently: g.armed.some((r) => Number(r.healedAt) > now - 7 * 86400e3),
              canary: !!pickCanary(g.armed),
              presence: st === 'fresh' ? 'in' : (st === 'signed-out' || st === 'wrong-account') ? 'out' : 'unknown',
              lastOkAge: ageWord(Math.max(0, ...g.armed.map((r) => Number(r.lastOkAt) || 0)) || 0, now),
              tally: tallySummary(book, g.groundId, { now, days: 7 }),
            };
          });
          const gids = gs.map((g) => g.groundId);
          const registry = scope === 'desk' ? Object.fromEntries(Object.entries(registryAll).filter(([o]) => inScope(o))) : registryAll;
          const incidents = scope === 'desk' ? incidentsAll.filter((i) => i && (inScope(i.origin) || gids.includes(i.groundId))) : incidentsAll;
          let asks = [];
          try {
            const al = (await chrome.storage.local.get('connector:aliases'))?.['connector:aliases'];
            const seen = new Set();
            asks = (Array.isArray(al) ? al : []).slice()
              .sort((a, b) => ((b && b.at) || 0) - ((a && a.at) || 0))
              .map((a) => (a && a.ask) ? { ask: String(a.ask), host: String(a.host || '').toLowerCase() } : null)
              .filter(Boolean)
              .filter((a) => scope !== 'desk' || !a.host || inScope(a.host))
              .filter((v) => { const k = v.ask.trim().toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
              .slice(0, 8);
          } catch { /* */ }
          let lastDaily = 0; try { lastDaily = Number((await chrome.storage.local.get(LAST_DAILY_KEY))?.[LAST_DAILY_KEY] || 0); } catch { /* */ }
          const model = {
            now, registry, incidents, grounds, asks, lastDaily, origins,
            deskName: String(p.deskName || ''),
            cases: (p.cases && typeof p.cases === 'object') ? p.cases : null,
            desks: Array.isArray(p.desks) ? p.desks : [],
            tallyAll: tallySummary(book, scope === 'desk' ? gids : null, { now, days: 7 }),
            byDay: tallyByDay(book, scope === 'desk' ? gids : null, { now, days: 14 }),
            canaryHave: grounds.filter((g) => g.canary).length,
            canaryOf: grounds.length,
            signedIn: Object.values(registryAll).filter((e) => e && e.status === 'fresh').length,
            originCount: Object.keys(registryAll).length,
          };
          const spec = scope === 'admin' ? buildAdminDashboardSpec(model)
            : scope === 'desk' ? buildDeskDashboardSpec(model)
            : buildFrontDashboardSpec(model);
          const anchor = { appId: scope === 'desk' ? String(p.appId || 'desk') : (scope === 'admin' ? 'admin_desk' : 'front_desk'), conversationId: null };
          Logger.info('conn', `DASH ▸ ${scope}${scope === 'desk' ? ` [${(origins || []).join(',') || 'no-origins'}]` : ''} → ${spec.blocks.length} blocks (${grounds.length} ground(s), ${model.tallyAll.total} run(s) 7d)`);
          sendResponse({ success: true, spec, anchor, scope });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'vitals-dashboard-failed' }); }
      })();
      return true;
    },
    // "Check now" from the Admin desk: presence with no age gate + the daily sweep regardless of the last stamp
    // (per-ground organic-evidence gating still applies — fresh is fresh).
    VITALS_CHECK_NOW: (_payload, _sender, sendResponse) => {
      (async () => {
        try {
          const s = await _settings();
          await _presenceSweep({ ...s, presenceWindowMin: 0 });
          try { await chrome.storage.local.set({ [LAST_DAILY_KEY]: Date.now() }); } catch { /* */ }
          await _dailySweep(s);
          sendResponse({ success: true });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'vitals-check-failed' }); }
      })();
      return true;
    },
    // KA-1 (v2.74.1599) — the keep-alive door: list (every registry origin joined with its learned window +
    // opt-in state) and set (toggle one origin). The panel's `keepalive` picker is the only writer.
    VITALS_KEEPALIVE: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const op = payload && payload.op;
          let book = await _kaBook();
          if (op === 'set' && payload.origin) {
            book = await _kaMutate((b) => kaSetOptIn(b, payload.origin, payload.on === true));
            Logger.info('conn', `VITALS ▸ keepalive ${String(payload.origin).toLowerCase()} ${payload.on === true ? 'ON' : 'off'} (user)`);
          }
          const registry = await _registry();
          const origins = [...new Set([...Object.keys(registry), ...Object.keys(book)])].sort();
          const rows = origins.map((o) => {
            const rec = book[o] || {};
            const e = registry[o] || {};
            const cadence = kaCadenceMs({ on: false, samples: [], est: rec.est ?? null, futile: rec.futile === true, strikes: rec.strikes || 0, lastPingAt: 0, lastPingOkAt: 0, ...rec });
            return { origin: o, on: rec.on === true, est: rec.est || null, samples: (rec.samples || []).length,
              cadence, futile: rec.futile === true, lastPingAt: rec.lastPingAt || 0, lastPingOkAt: rec.lastPingOkAt || 0,
              status: e.status || null, lastVerifiedAt: e.lastVerifiedAt || 0 };
          });
          sendResponse({ success: true, rows, ephemeral: (await _settings()).ephemeral });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'keepalive-failed' }); }
      })();
      return true;
    },
  };
}
