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
import { armable, partitionRecipesByOrigin, recipeFromCatalogEntry } from '../../Core/rideRecipe.js';   // v2.74.2052 — the OWN-ORIGIN read door (the vs_state-as-shopify-canary incident); v2229 — the write-back projects its leg from the catalog
import { primaryHost } from '../../Core/groundDedup.js';   // v2.74.2052 — the ground's OWN identity anchors the filter (never the modal-of-records host)
import { invokeRideRecipe, projectRideLeg } from '../../Core/rideStep.js';   // DESIGN_cadence.md §12 (v1715) — share the RUNNER: one resolve→plan→invoke for the canary AND the workflow step; v2229 — projectRideLeg for the write-back's gate verdict
import { gateActionForLeg } from '../../Core/pipelineGate.js';   // v2229 — the write-back runs ONLY on a gate-auto verdict (gateCleared authority)
import { composeNoteLine, appendNote, dueWriteBacks, markWriteBack, composeCustomerEmail, dueNotify, stagePendingNotify } from '../../Core/consequenceNote.js';   // v2229 — §14 write-back, pure half; v2230 — the customer-notify STAGE (send stays human)
import { contactMethodClass } from '../../Core/contactChannel.js';   // v2230 — the automated-email ALLOW-LIST (CONCERN 1: never machine-email someone who asked to be phoned)
import { planSessionGovernorTick } from '../../Core/sessionGovernor.js';   // SGV-0 — the governor's PURE planner (inert soak; BUILD_ARC rung 4)
import { listAllWorkflows } from '../../Services/Storage/WorkflowStore.js';   // SGV-0 — due-soon demand source for the snapshot
// AU-6 (v2.74.2207, §12.4) — the COLLECTION poll rides this tick: the catalog it reads, the ledger it reconciles,
// the pure planner/reconciler, and the state-machine functions it applies. No new alarm, no second clock owner.
import { CONNECTOR_RECIPES } from '../../Core/connectorRecipes.js';
import { loadCreates, updateCreate } from '../../Services/Storage/AuditCreateStore.js';
import { pollPlan, reconcileCollection, rowsAt, probePlan, probeParams, readTransition, observeFields, hasNews, newsToFields, destinationWarmMs } from '../../Core/recordObserve.js';   // v2217 — the hand-off grants the DESTINATION kind's warm window
import { applyGone, applyUpdate, applyTransition, applyLabel, warmWindowMs, nextWatch } from '../../Core/recordLife.js';

const TICK_ALARM = 'vitals:tick';
const CONFIRM_PREFIX = 'vitals:confirm:';
const LAST_DAILY_KEY = 'vitals:lastDaily';
const SETTINGS_KEY = 'settings:vitals';
const INC_KEY = 'vitals:incidents';
const TALLY_KEY = 'vitals:tally';
const WATCH_KEY = 'audit:watch';      // AU-6 §12.4 — { lastPollAt: {recipeId: ms}, seenBy: {rowKey: observe-seen-state} }
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
  const s = await _settings();
  // verify-fix MED (O1) — the heartbeat NEVER dies quietly: vitals-disabled still says so (dead ≠ quiet ≠ off).
  if (!s.enabled) { try { Logger.info('vitals', 'SGV ▸ tick demands=0 planned=0 deferred=0 (vitals disabled)'); } catch { /* */ } return; }
  await _presenceSweep(s);
  // v2.74.1760 — after presence: pre-warm sniffed CSRF on open Shopify-class tabs so the first ask isn't cold-403.
  try { await _ctx.invokeSgHandler('CSRF_PREWARM', {}); } catch { /* best-effort — never block the tick */ }
  await _keepAliveSweep(s);   // KA-1 — after presence: an opted-in FRESH origin past its cadence gets its ping
  let last = 0;
  try { last = Number((await chrome.storage.local.get(LAST_DAILY_KEY))?.[LAST_DAILY_KEY] || 0); } catch { /* */ }
  if (Date.now() - last >= s.dailyWindowH * 3600e3) {
    try { await chrome.storage.local.set({ [LAST_DAILY_KEY]: Date.now() }); } catch { /* */ }   // stamp at START (double-run guard across SW restarts)
    await _dailySweep(s);
  }
  await _recordWatchSweep();   // AU-6 §12.4 — the COLLECTION poll: one read per collection, reconciled against every row
  await _sgvInertTick();   // SGV-0 — the governor's INERT soak: plan + log, never execute (BUILD_ARC rung 4)
}

/**
 * AU-6 (v2.74.2207, DESIGN_audit.md §12.3/§12.4) — THE COLLECTION POLL. The trigger that catches a change made
 * somewhere other than this browser, and therefore the one that makes the watch mean anything at all.
 *
 * NO NEW ALARM, per §12.4: "`vitals:tick` is explicitly one alarm — the window is the cadence, the tick is just
 * the scanner", and it already absorbed `conn:heartbeat`. A second alarm would regress that consolidation, and
 * under MV3 alarms are the only durable timer.
 *
 * THE UNIT IS THE COLLECTION, never the record — `shopify_draft_orders` answers for N drafts in ONE request, and
 * per-record polling is O(N) requests on a live user session, untenable near the 500-row cap. Which is also why
 * COLD rows are reconciled here: the read costs the same either way, so excluding them would save nothing and
 * blind us precisely where it hurts (a draft that sat long enough to go cold, then completed on someone else's
 * machine — §12.3's corrected rule).
 *
 * EVERYTHING FAIL-SAFE. This runs after presence and keep-alive; a throw anywhere must not cost the tick.
 */
async function _recordWatchSweep({ force = false, onlyKey = '' } = {}) {
  try {
    const { items } = await loadCreates();
    // v2.74.2222 — SCOPE. verify-at-view passes the ONE row being looked at (`onlyKey` = its at|id identity), so
    // a card open costs that row's reads — §12.3 prices the trigger at "1 read, on demand", and the unscoped
    // force (every collection due + every row probe-due) was O(book) network calls per drill open: invisible at
    // 3 rows, a per-open storm at the 500 cap. An empty key keeps the whole-book sweep (the background tick).
    const _key = (r) => `${Number(r && r.at) || 0}|${String((r && r.id) || '')}`;
    let rows = Array.isArray(items) ? items : [];
    if (onlyKey) rows = rows.filter((r) => _key(r) === onlyKey);
    if (!rows.length) return;
    // v2.74.2213 — `chrome.storage.local` DIRECTLY, like every other book in this file (INC_KEY, TALLY_KEY,
    // KA_KEY). v2207 used `StorageManager.get(WATCH_KEY)`, and `#get` is a PRIVATE static — there is no public
    // one — so this line threw a TypeError on every sweep, the fail-safe catch swallowed it, and NEITHER the
    // collection poll NOR the per-record tier has executed since. I reached for a helper instead of copying the
    // neighbour three functions up.
    let book = {};
    try { book = (await chrome.storage.local.get(WATCH_KEY))?.[WATCH_KEY] || {}; } catch { book = {}; }
    const lastPollAt = _isPlain(book.lastPollAt) ? book.lastPollAt : {};
    const seenBy = _isPlain(book.seenBy) ? book.seenBy : {};
    // `force` = a human is looking (verify-at-view). Passing an empty lastPollAt makes every collection due;
    // the window exists to bound BACKGROUND cost, and a person asking is not background cost.
    const plan = pollPlan(rows, { catalog: CONNECTOR_RECIPES, now: Date.now(), lastPollAt: force ? {} : lastPollAt });
    // v2.74.2213 — NO EARLY RETURN ON AN EMPTY COLLECTION PLAN. It skipped the PER-RECORD tier below, so a record
    // that had HANDED OFF was never watched again: nothing collection-shaped covers `order` (the unfulfilled
    // queue cannot host that watch — v2209), so its plan is empty by design and the shipping watch died there.
    // Caught by the sweep's own execution test, which is the first thing to ever run this path.
    let polled = 0; let updated = 0; let gone = 0; let handed = 0; let probed = 0; let failed = 0;
    for (const step of plan) {
      const leg = (CONNECTOR_RECIPES || []).find((r) => r && r.id === step.recipeId);
      if (!leg) continue;
      // The ground that owns this host — the same resolution the canary makes, and the same shared runner.
      let groundId = '';
      try { groundId = (await _ctx.invokeSgHandler('ENSURE_GROUND_FOR_URL', { url: `https://${step.host}/` }))?.groundId || ''; } catch { groundId = ''; }
      if (!groundId) continue;
      let reply = null;
      try {
        reply = await invokeRideRecipe({ id: leg.id, ...leg }, groundId, { params: step.params || {}, invoke: (payload) => _ctx.invokeSgHandler('INVOKE_SESSION', { ...payload, headless: true }) });
      } catch { reply = null; }
      polled++;
      if (!reply || !reply.ok) { failed++; continue; }   // a signed-out or 404 collection says nothing about its members
      const observedRows = rowsAt(reply.value, leg.rows);   // v2208 — ONE walker, shared with the pure half: the local copy took edges[0] and reconciled a single row
      const _st = {};
      const acts = reconcileCollection(rows, observedRows, { leg, now: Date.now(), seenBy, stats: _st });
      // v2.74.2214 — NAME WHICH KIND OF NOTHING HAPPENED. Two polls read this collection green while #D29741 sat
      // COMPLETED in Shopify, and `0 handed off · 0 unreadable` could not say whether the banked row was ABSENT
      // from the vendor's reply (our poll's query:''/no-saved-view differs from the HAR-proven page request) or
      // PRESENT with a status the probe declaration did not expect. Counts only, body-blind.
      try { Logger.info('audit', `AUDIT ▸ watch reconcile [${leg.id}] vendor=${observedRows.length} banked=${rows.length} matched=${_st.matched} when-met=${_st.whenMet} → ${acts.length} act(s)`); } catch { /* */ }
      for (const a of acts) {
        const [atStr, ...idParts] = String(a.key).split('|');
        const ref = { at: Number(atStr) || 0, id: idParts.join('|') };
        try {
          if (a.kind === 'gone') { const r = await updateCreate(ref, (row) => applyGone(row, { why: a.why || '404', at: a.at })); if (r.changed) gone++; }
          // §12.5/§12.0 — the HAND-OFF: the same row changes kind, the timeline records both ends, and the warm
          // window RESTARTS because the thing worth seeing (a tracking number) usually arrives AFTER it.
          // v2.74.2217 — restarts with the DESTINATION kind's window (the order leg's declared 60d), not the
          // observing collection's: the thing worth seeing arrives on the NEW kind's timescale.
          else if (a.kind === 'transition') {
            const r = await updateCreate(ref, (row) => applyTransition(row, { toKind: a.toKind, toId: a.toId, at: a.at, windowMs: destinationWarmMs(CONNECTOR_RECIPES, { toKind: a.toKind, host: leg.appHost }) }));
            if (r.changed) handed++;
          }
          // §12.5, second branch — the collection can see THAT something happened and not WHAT. It asks; one
          // targeted read answers. (Shopify's DraftOrderList carries `status` and no `order` — HAR 2026-08-11.)
          else if (a.kind === 'probe') {
            const got = await _probeOne(a.via, { id: a.id, label: '' }, Date.now());
            if (got && got.name) { try { await updateCreate(ref, (row) => applyLabel(row, { label: got.name })); } catch { /* */ } }   // v2226 — label backfill rides this tier too
            if (got && got.handOff) {
              const r = await updateCreate(ref, (row) => applyTransition(row, { ...got.handOff, at: a.at, windowMs: got.windowMs }));
              if (r.changed) handed++;
            }
            probed++;
          }
          else {
            const r = await updateCreate(ref, (row) => applyUpdate(row, { fields: a.fields, at: a.at, windowMs: warmWindowMs(leg) }));
            if (r.changed) updated++;
            // v2.74.2222 — the seen-state advances whenever the act was PROCESSED, not only when the row changed.
            // Two memories diff here (reconcile against seenBy; applyUpdate against row.observed), and gating the
            // seenBy write on `changed` let them wedge: if they ever disagreed (WATCH_KEY cleared, a crash between
            // the two commits), reconcile re-emitted the same set/member "news" every poll and applyUpdate
            // rejected it every time — seenBy never learned the ids, forever.
            seenBy[a.key] = a.seenNext;
          }
        } catch { /* one row's failure must not stop the rest */ }
      }
      lastPollAt[leg.id] = Date.now();
    }

    // ── §12.3's PER-RECORD tier. Priced at "1 read per record", so it is warm-gated — unlike a collection read,
    // this one's cost scales with the book. It exists because a collection cannot always host the watch: an
    // order's tracking lives on the order, and the only orders collection that returns tracking is the
    // UNFULFILLED queue, which an order LEAVES at the moment it ships (v2209, from the same capture).
    const _freshAll = (await loadCreates()).items || rows;
    const fresh = onlyKey ? _freshAll.filter((r) => _key(r) === onlyKey) : _freshAll;
    const lastProbeAt = _isPlain(book.lastProbeAt) ? book.lastProbeAt : {};
    // v2.74.2217 — UNDER FORCE, COLD ROWS ARE RE-READ. `force` means a human is looking (verify-at-view), and
    // reversalOffer promised at v2206 that "when verify-at-view lands, `stale` becomes a re-read instead of a
    // caveat" — verify-at-view landed at v2212 and the promise didn't: the warm gate still suppressed cold rows
    // even on a card open, so a draft past its window that THEN completed could never hand off (the collection
    // cannot see COMPLETED drafts — v2215). Cold-suppression exists to bound BACKGROUND cost, and a person
    // asking is not background cost — the same reasoning `force` already applies to the poll windows above.
    // Banked-`gone` rows stay excluded either way (probePlan's own first check).
    const perRecord = probePlan(fresh, {
      catalog: CONNECTOR_RECIPES, now: Date.now(), lastProbeAt: force ? {} : lastProbeAt,
      watchOf: force ? () => 'warm' : (row) => nextWatch(row, Date.now()),
    });
    for (const step of perRecord) {
      const [atStr, ...idParts] = String(step.key).split('|');
      const ref = { at: Number(atStr) || 0, id: idParts.join('|') };
      try {
        const got = await _probeOne(step.recipeId, { id: step.id, label: step.label }, Date.now(), seenBy[step.key] || null);
        if (!got) { failed++; continue; }
        probed++;
        lastProbeAt[step.key] = Date.now();
        // v2.74.2226 — LABEL BACKFILL: an id-titled row takes the vendor's own name (applyLabel — once, never
        // over a human label, no event). This is how every pre-v2225 customer card stops reading as 13 digits.
        if (got.name) { try { await updateCreate(ref, (row) => applyLabel(row, { label: got.name })); } catch { /* */ } }
        // v2.74.2222 (§12.2) — an EXACT probe that resolved to nothing IS the "object returned 404" observation:
        // the read addressed the record by its own id (`probe.exact`, a leg declaration) and the vendor answered
        // "no such record". Search-shaped probes (a `name:` query) never take this branch — an empty search is
        // the v2214 query-mismatch class, and concluding gone from it would be a confidently wrong terminal
        // state. Before this, NO live path could ever observe a vendor-side deletion (the per-record tier
        // counted it `failed`; only a partition collection could say gone, and none is declared).
        if (got.gone) {
          const r = await updateCreate(ref, (row) => applyGone(row, { why: '404', at: Date.now() }));
          if (r.changed) gone++;
        } else if (got.handOff) {
          const r = await updateCreate(ref, (row) => applyTransition(row, { ...got.handOff, at: Date.now(), windowMs: got.windowMs }));
          if (r.changed) handed++;
        } else if (got.fields) {
          const r = await updateCreate(ref, (row) => applyUpdate(row, { fields: got.fields, at: Date.now(), windowMs: got.windowMs }));
          if (r.changed) updated++;
          seenBy[step.key] = got.seenNext;   // v2222 — advance when processed, not only when changed (see the collection tier)
        }
      } catch { /* one row's failure must not stop the rest */ }
    }

    // ── v2.74.2229 — §14 CONSEQUENCE WRITE-BACK (the CW-VS slice; USER RULING 2026-08-14). When a watched
    // record's lifecycle moves — hand-off confirmed / tracking observed / delivered — write one dated line onto
    // the VendorSuite task that INCITED it (§12.8.1's provenance is the address). STATE-DERIVED off each row
    // (dueWriteBacks), so a write lost to a blip retries next sweep; markWriteBack is what makes it stop.
    // The append contract is what makes the unattended write honest: the leg's transport REPLACES
    // VendorExplanation wholesale (v2227 capture), so the sweep reads the task first and appendNote preserves
    // the prior text. Authority: gateActionForLeg must say 'auto' (the v2229 reversible ruling) and the leg is
    // CURATED by construction (read straight from CONNECTOR_RECIPES — headlessWrite's curated-only rule holds);
    // invokeRideRecipe stamps gateCleared, so the trace and the ledger say who: 'gate', never 'human'.
    // v1 scope: the one declared consequence pair (Shopify order → VendorSuite task). A second pair becomes a
    // catalog declaration, not a second loop.
    {
      const _reload = onlyKey ? fresh : _freshAll;
      for (const row of _reload) {
        try {
          // v2.74.2229b — NAME THE NOTHINGS (the v2214 lesson): on a SCOPED sweep (a human is looking) say WHY
          // no write-back fired, or the drill-open proof is indistinguishable from a silent throw.
          const due = dueWriteBacks(row);
          if (!due.length) {
            if (onlyKey) { try { Logger.info('audit', `AUDIT ▸ write-back none due — ${row.incitedBy && row.incitedBy.id ? 'provenance ok, no unsent lifecycle events' : 'row has NO incitedBy (provenance was never banked for it)'}`); } catch { /* */ } }
            continue;
          }
          const inc = row.incitedBy || {};
          if (!/(^|\.)vendorsuite\.drhorton\.com$/i.test(String(inc.system || ''))) { try { Logger.info('audit', `AUDIT ▸ write-back skipped — inciting system has no declared consequence pair`); } catch { /* */ } continue; }   // CW-VS v1
          const wentry = (CONNECTOR_RECIPES || []).find((r) => r && r.id === 'vs_update_task_note');
          const rentry = (CONNECTOR_RECIPES || []).find((r) => r && r.id === 'vs_warranty_task');
          if (!wentry || !rentry) continue;
          let vsGround = '';
          try { vsGround = (await _ctx.invokeSgHandler('ENSURE_GROUND_FOR_URL', { url: `https://${wentry.appHost}/` }))?.groundId || ''; } catch { vsGround = ''; }
          if (!vsGround) continue;
          // READ the task first — the append contract's load-bearing half (and proof the task is reachable).
          let taskReply = null;
          try {
            taskReply = await invokeRideRecipe({ id: rentry.id, ...rentry }, vsGround, {
              params: { taskId: String(inc.id) },
              invoke: (p) => _ctx.invokeSgHandler('INVOKE_SESSION', { ...p, headless: true }),
            });
          } catch { taskReply = null; }
          if (!taskReply || !taskReply.ok) { try { Logger.info('audit', `AUDIT ▸ write-back skipped — task unreadable (${(taskReply && taskReply.error) || 'no-reply'})`); } catch { /* */ } continue; }
          const taskRow = rowsAt(taskReply.value, rentry.rows || '')[0] || taskReply.value;
          const prior = String((taskRow && taskRow.VendorExplanation) || '');
          const wleg = projectRideLeg(recipeFromCatalogEntry(wentry, { groundId: vsGround, origin: wentry.appHost }), vsGround);
          const gate = wleg ? gateActionForLeg(wleg) : { decision: 'refused', why: 'no leg' };
          if (gate.decision !== 'auto') { try { Logger.info('audit', `AUDIT ▸ write-back parked — gate ${gate.decision} (${gate.why || ''})`); } catch { /* */ } continue; }
          const _date = new Date().toLocaleDateString();
          let noteText = prior;
          for (const d of due) noteText = appendNote(noteText, composeNoteLine(d.key, { date: _date, ref: d.ref, tracking: d.tracking, carrier: d.carrier }));
          if (noteText === prior) {   // every line already present (a prior run wrote, the marker was lost) — mark and move on
            const _ref = { at: Number(row.at) || 0, id: String(row.id || '') };
            for (const d of due) await updateCreate(_ref, (r) => markWriteBack(r, d.key, Date.now()));
            continue;
          }
          const wr = await invokeRideRecipe({ id: wentry.id, ...wentry }, vsGround, {
            params: { task_id: String(inc.id), note: noteText },
            gate,
            invoke: (p) => _ctx.invokeSgHandler('INVOKE_SESSION', { ...p, headless: true }),
          });
          if (wr && wr.ok && wr.value === true) {   // the bare-boolean contract: only a literal true is a save
            const _ref = { at: Number(row.at) || 0, id: String(row.id || '') };
            for (const d of due) await updateCreate(_ref, (r) => markWriteBack(r, d.key, Date.now()));
            try { Logger.info('audit', `AUDIT ▸ write-back ${due.map((d) => d.key).join('+')} → task on ${inc.system} (ok)`); } catch { /* */ }
          } else {
            try { Logger.info('audit', `AUDIT ▸ write-back ${due.map((d) => d.key).join('+')} → task on ${inc.system} FAILED (${(wr && (wr.error || (wr.ok ? 'reply-not-true' : 'no-reply'))) || 'no-reply'}) — retries next sweep`); } catch { /* */ }
          }
        } catch (e) {
          // v2.74.2229b — fail-safe means "do not break the sweep", NOT "say nothing" (the sweep's own v2213
          // lesson, re-learned by this block's first draft): a throw here was invisible for exactly one tick.
          try { Logger.info('audit', `AUDIT ▸ write-back ERROR — ${(e && e.message) || e}`); } catch { /* */ }
        }
      }

      // v2.74.2230 — the CUSTOMER NOTIFY, STAGE ONLY (USER: "the customer is also notified by email"). The
      // email is an OUTWARD act — pipelineGate queues outward, so the sweep composes and PARKS the draft on the
      // row (pendingNotify) and the Records drill's Send click is the one road to the wire (PP-3). The homeowner
      // comes from the inciting task's contacts read; the automated-email ALLOW-LIST holds (contactMethodClass —
      // only an affirmative Any/Email ever stages a sendable draft; anything else stages a VISIBLE withheld
      // verdict, never a silent skip).
      for (const row of _reload) {
        try {
          const need = dueNotify(row);
          if (!need) continue;
          const inc = row.incitedBy || {};
          if (!/(^|\.)vendorsuite\.drhorton\.com$/i.test(String(inc.system || ''))) continue;   // CW-VS v1 pair
          const centry = (CONNECTOR_RECIPES || []).find((r) => r && r.id === 'vs_task_contacts');
          if (!centry) continue;
          let vsg = '';
          try { vsg = (await _ctx.invokeSgHandler('ENSURE_GROUND_FOR_URL', { url: `https://${centry.appHost}/` }))?.groundId || ''; } catch { vsg = ''; }
          if (!vsg) continue;
          let cReply = null;
          try {
            cReply = await invokeRideRecipe({ id: centry.id, ...centry }, vsg, {
              params: { taskId: String(inc.id) },
              invoke: (p) => _ctx.invokeSgHandler('INVOKE_SESSION', { ...p, headless: true }),
            });
          } catch { cReply = null; }
          if (!cReply || !cReply.ok) { try { Logger.info('audit', `AUDIT ▸ notify skipped — contacts unreadable (${(cReply && cReply.error) || 'no-reply'})`); } catch { /* */ } continue; }
          const contacts = Array.isArray(cReply.value) ? cReply.value : [];
          const person = contacts.find((c) => c && !c.IsDrHorton && c.IsPrimary) || contacts.find((c) => c && !c.IsDrHorton) || null;
          const email = String((person && person.Email) || '').trim();
          const nm = String((person && (person.FullName || [person.FirstName, person.LastName].filter(Boolean).join(' '))) || '').trim();
          const klass = contactMethodClass(person && person.ContactMethod);
          const _ref = { at: Number(row.at) || 0, id: String(row.id || '') };
          if (!person || !email || !(klass === 'any' || klass === 'email')) {
            const why = !person ? 'no homeowner contact on the task' : (!email ? 'no email on file' : `their contact preference reads "${String(person.ContactMethod || 'unset')}" — call, don't email`);
            await updateCreate(_ref, (r) => stagePendingNotify(r, { withheld: why, at: Date.now() }));
            try { Logger.info('audit', `AUDIT ▸ notify withheld — ${why}`); } catch { /* */ }
            continue;
          }
          const draft = composeCustomerEmail({ name: nm, ref: need.ref, date: new Date().toLocaleDateString() });
          await updateCreate(_ref, (r) => stagePendingNotify(r, { to: email, name: nm, subject: draft.subject, body: draft.body, at: Date.now() }));
          try { Logger.info('audit', `AUDIT ▸ notify staged — a draft awaits the human Send on the record card`); } catch { /* */ }
        } catch (e) {
          try { Logger.info('audit', `AUDIT ▸ notify ERROR — ${(e && e.message) || e}`); } catch { /* */ }
        }
      }
    }

    // v2.74.2222 — PRUNE the row-keyed watch state for rows no longer in the book (evicted past the cap, or
    // removed). Without this, seenBy/lastProbeAt grew one orphan per departed row forever. Only on a WHOLE-book
    // sweep — a scoped verify sees one row and must not read every other row's state as departed.
    if (!onlyKey) {
      const _live = new Set(_freshAll.map(_key));
      for (const k of Object.keys(seenBy)) if (!_live.has(k)) delete seenBy[k];
      for (const k of Object.keys(lastProbeAt)) if (!_live.has(k)) delete lastProbeAt[k];
    }
    try { await chrome.storage.local.set({ [WATCH_KEY]: { lastPollAt, lastProbeAt, seenBy } }); } catch { /* */ }
    // BODY-BLIND like every other audit line: counts and leg ids, never a value that was observed.
    try { Logger.info('audit', `AUDIT ▸ watch poll ${polled} collection(s) + ${probed} record read(s) over ${rows.length} row(s) → ${updated} updated · ${handed} handed off · ${gone} gone · ${failed} unreadable`); } catch { /* */ }
    // v2.74.2212 — THE CALLER GETS THE TALLY, because a surface that says 're-checked' on a sweep where every read
    // was refused is the dishonest-indicator class this ledger keeps correcting (`→ driven`, `arrived`, '5 of 6').
    return { polled, probed, updated, handed, gone, failed };
  } catch (e) {
    // FAIL-SAFE MEANS 'DO NOT BREAK THE TICK', NOT 'SAY NOTHING'. A bare catch here hid a TypeError for six
    // versions — the sweep threw on its third line and every surface reported a healthy no-op. The tick still
    // survives; it just no longer does so in silence.
    try { Logger.info('audit', `AUDIT ▸ watch sweep FAILED — ${(e && e.message) || e}`); } catch { /* */ }
  }
  return null;
}

/**
 * AU-6 (v2.74.2209) — READ ONE RECORD through a declared leg, and return what its declarations found. The single
 * executor behind BOTH per-record paths: the hand-off probe a collection asks for, and the per-record observe
 * tier. One function, because they are the same act with different triggers — and two copies would drift.
 *
 * Everything it does is declared BY THE LEG: `probe` says how to address the record (a gid to rebuild, or a name
 * to strip to digits), `rows` says where the record is in the reply, `handOff` says where the new address lives,
 * `observe` says what counts as news. This function contributes no knowledge of any platform.
 */
async function _probeOne(recipeId, { id = '', label = '' } = {}, now = 0, seen = null) {
  const leg = (CONNECTOR_RECIPES || []).find((r) => r && r.id === String(recipeId || ''));
  if (!leg) return null;
  const params = probeParams(leg, { id, label });
  if (!params) return null;                                   // no way to address it → no read, rather than a wrong one
  let groundId = '';
  try { groundId = (await _ctx.invokeSgHandler('ENSURE_GROUND_FOR_URL', { url: `https://${leg.appHost}/` }))?.groundId || ''; } catch { groundId = ''; }
  if (!groundId) return null;
  let reply = null;
  try {
    // The SHARED runner, with the record's key as its params — the same call the canary makes, one argument
    // richer. NOT `literalSafeParams`: that strip exists to drop model-minted `resolve`/`lookup` phrases the SW
    // cannot resolve, and this value is neither — it is an id we banked from a vendor reply.
    reply = await invokeRideRecipe({ id: leg.id, ...leg }, groundId, {
      params,
      invoke: (payload) => _ctx.invokeSgHandler('INVOKE_SESSION', { ...payload, headless: true }),
    });
  } catch { reply = null; }
  if (!reply || !reply.ok) return null;
  const one = rowsAt(reply.value, leg.rows)[0];
  // v2.74.2222 (§12.2) — an OK reply whose rows resolved to nothing, on a leg whose probe addresses the record
  // by EXACT id (`probe.exact` — the gid-addressed draft detail, where a deleted draft answers
  // `data.draftOrder: null` with a 200): that is the vendor stating non-existence, the one shape §12.2 accepts
  // as a gone observation. Anything else (a search probe, a non-exact read) keeps failing toward silence.
  if (!one) return (leg.probe && leg.probe.exact === true) ? { gone: true } : null;
  const windowMs = warmWindowMs(leg);
  // v2.74.2226 — the vendor's own HUMAN name for this record, riding every probe so the sweep can BACKFILL a
  // display label onto id-titled rows (recordLife.applyLabel — once, never over a human label). Name-shaped
  // fields only; an id is not a name.
  const _nm = (() => {
    try {
      const fn = [one.firstName, one.lastName].filter((x) => typeof x === 'string' && x.trim()).join(' ').trim();
      if (fn) return fn;
      for (const f of ['name', 'title', 'displayName', 'email', 'subject']) {
        const v = one[f];
        if (typeof v === 'string' && v.trim() && v.trim().length <= 60) return v.trim();
      }
    } catch { /* */ }
    return '';
  })();
  const ho = readTransition(one, leg.handOff);
  // v2.74.2217 — a hand-off re-warms on the DESTINATION kind's timescale. This leg's own window (the draft
  // detail declares none → 14d default) was granted to the ORDER the record became, so a shipment slower than
  // 14 quiet days went cold before its tracking number existed — and cold suppresses the very read that would
  // have seen it. The order leg's `warm: '60d'` now applies from the moment of the hand-off, not from its first
  // lucky observation.
  if (ho) return { handOff: ho, name: _nm, windowMs: destinationWarmMs(CONNECTOR_RECIPES, { toKind: ho.toKind, host: leg.appHost }) };
  if (!leg.observe) return { name: _nm, windowMs };
  const obs = observeFields(one, leg.observe, seen);
  if (!hasNews(obs)) return { name: _nm, windowMs };
  return { fields: newsToFields(obs), seenNext: obs.seenNext, name: _nm, windowMs };
}

const _isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);


// ── SGV-0 (DESIGN_session_governor.md v1.14 §11.1) — the planner runs INERT: every tick snapshots, plans, and
// LOGS (`SGV ▸` heartbeat + plan lines) — nothing executes. The soak's plans are graded against real traffic
// BEFORE the governor gains hands (SGV-1 is gated on that grade). Plus the O2 baseline capture: the §10 pass
// bar's "presence fails ≤50% of baseline" is ungradeable without a stored pre-SGV-1 baseline — the vitals
// tally's rolling {ok,auth,miss,other} book is today's presence-failure proxy, snapshotted per UTC day.
const SGV_BASELINE_KEY = 'sgv:baseline';
async function _sgvInertTick() {
  try {
    const now = Date.now();
    const registry = await _registry();
    const origins = {};
    for (const [o, e] of Object.entries(registry || {})) {
      if (!e || typeof e !== 'object') continue;
      origins[o] = { status: (typeof e.status === 'string') ? e.status : 'unknown' };
    }
    // demand sources at SGV-0: due-soon workflows only (blocked/activeAsks arrive with SGV-1's doors and the
    // panel PING — absent here, honestly zero, and the heartbeat says so every tick).
    const due = [];
    try {
      const banks = await listAllWorkflows();
      for (const g of (banks || [])) {
        for (const w of (g && g.items) || []) {
          const t = w && w.trigger;
          if (!(t && t.enabled && Number(t.nextDue) > 0)) continue;
          // verify-fix MED — a demand NAMES ITS ORIGINS (§2's derivation, via.host): with origins:[] the
          // planner could never demand anything and the soak graded liveness only.
          const _os = new Set();
          for (const st of (Array.isArray(w.steps) ? w.steps : [])) { const h = st && st.via && st.via.host; if (h) _os.add(String(h)); }
          due.push({ workflowId: w.id, nextDue: Number(t.nextDue), origins: [..._os] });
        }
      }
    } catch { /* due demand degrades to none */ }
    const plan = planSessionGovernorTick({ now, origins, due, userActiveOn: false, blocked: [], activeAsks: [] });
    // O1 — the heartbeat, EMPTY PLANS INCLUDED: a dead governor and a quiet one must never look identical.
    Logger.info('vitals', `SGV ▸ tick demands=${plan.demands} planned=${plan.planned} deferred=${plan.deferred}`);
    for (const h of plan.heals) Logger.info('vitals', `SGV ▸ heal plan verb=${h.verb} origin=${h.origin} incident=${h.incidentId} (inert — SGV-0 soak)`);
    for (const o of plan.budgetExhausted) Logger.info('vitals', `SGV ▸ budget-exhausted origin=${o} (inert)`);
    // O2 — the baseline book: one row per UTC day from the tally's auth/total counts, capped at 14 days.
    try {
      // verify-fix HIGH (O2) — the tally book is NESTED {groundId: {dayKey: {ok,auth,miss,other}}}; the flat
      // read summed undefineds and the baseline filled with structural zeros — a false passing-zero, the exact
      // failure O2 exists to prevent. Walk both levels, keyed by the tally's OWN (local) day keys.
      const tallyRaw = (await chrome.storage.local.get(TALLY_KEY))?.[TALLY_KEY] || {};
      const byDay = {};
      for (const ground of Object.values(tallyRaw)) {
        if (!ground || typeof ground !== 'object') continue;
        for (const [dk, v] of Object.entries(ground)) {
          if (!v || typeof v !== 'object') continue;
          const d = byDay[dk] = byDay[dk] || { auth: 0, total: 0 };
          d.auth += Number(v.auth) || 0;
          d.total += (Number(v.ok) || 0) + (Number(v.auth) || 0) + (Number(v.miss) || 0) + (Number(v.other) || 0);
        }
      }
      const book = (await chrome.storage.local.get(SGV_BASELINE_KEY))?.[SGV_BASELINE_KEY] || { startedAt: now, days: [] };
      let days = Array.isArray(book.days) ? book.days : [];
      for (const [dk, agg] of Object.entries(byDay)) {
        const idx = days.findIndex((d) => d && d.day === dk);
        if (idx >= 0) days[idx] = { day: dk, ...agg };
        else days.push({ day: dk, ...agg });
      }
      days = days.sort((a, b) => String(a.day).localeCompare(String(b.day))).slice(-14);
      await chrome.storage.local.set({ [SGV_BASELINE_KEY]: { startedAt: book.startedAt || now, days } });
    } catch { /* the baseline book is best-effort; the heartbeat still proves liveness */ }
  } catch (e) {
    try { Logger.info('vitals', `SGV ▸ tick failed: ${(e && e.message) || e}`); } catch { /* */ }
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

// v2.74.2052 — one throttled diagnosability line per polluted ground (the panel's shape, chat.js v1937/v2049):
// the filter hides foreign rows from every reader, so the LOG is what keeps the pollution visible. 60s per
// ground matches the panel's cache-fill cadence; _vitalsGrounds runs inside per-entry sweep loops, so unthrottled
// it would flood a single keepalive pass.
const _foreignLogAt = new Map();
function _logForeignRows(gid, host, part) {
  try {
    const last = _foreignLogAt.get(gid) || 0;
    if (Date.now() - last < 60_000) return;
    _foreignLogAt.set(gid, Date.now());
    Logger.info('conn', `RIDE_RESOLVE ▸ ${part.foreign.length} foreign recipe(s) stored under ${host} (${part.foreignOrigins.slice(0, 3).join(', ')}) — filtered from every reader`);
  } catch { /* the line must never break the read */ }
}

/** Every ground holding ≥1 armable OWN-ORIGIN ride recipe, with its host + the armable set.
 * v2.74.2052 — the armed set is filtered to the ground's OWN origin before anything reads it: this ONE build
 * site feeds pickCanary (the vs_state-as-shopify-canary incident), dueForDaily (foreign lastOkAt marked a
 * ground 'fresh'), the presence gate, catch-up matching, keepalive, VITALS_STATUS and VITALS_DASHBOARD.
 * The anchor is the ground's OWN identity (primaryHost — the TARGET_RESOLVE/discovery derivation), NEVER the
 * modal-of-records host: on a majority-foreign store (UPS: 33 foreign vs 2 own) the modal anchor keeps the
 * pollution and drops the real legs, and also mis-names the sweep's log/presence/freshness host. A ground whose
 * shape yields no primaryHost falls back to the pre-2052 modal election, unfiltered (no anchor, no verdict).
 * The exposed `host` keeps the OWN rows' stored form (what the registry/tab layer keys on) — byte-identical to
 * the modal host on every clean ground. */
async function _vitalsGrounds() {
  const out = [];
  try {
    const grounds = await StorageManager.getAllGrounds();
    for (const g of (Array.isArray(grounds) ? grounds : [])) {
      const gid = g && (g.id || g.groundId); if (!gid) continue;
      let recs = []; try { recs = (await _ctx.readRideRecipes(gid)) || []; } catch { recs = []; }
      let armed = recs.filter((r) => r && armable(r) && r.origin);
      if (!armed.length) continue;
      let anchor = ''; try { anchor = String(primaryHost(g) || '').toLowerCase(); } catch { anchor = ''; }
      if (anchor) {
        const part = partitionRecipesByOrigin(armed, anchor);
        if (part.foreign.length) _logForeignRows(gid, anchor, part);
        armed = part.own;
        if (!armed.length) continue;   // pure pollution — nothing of the ground's own to visit (the log line says why)
      }
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
    // v2.74.2052 — `headless: true`, matching cadence.js:437 / fleet.js:42 (the H-1a/v2043 precedent): every
    // canary here is CLOCK-driven (daily sweep, keepalive, confirm, catch-up), so the executor must take its
    // headless branches — the identity gate fails fast `not-logged-in` instead of _focusTab+_waitForReauth
    // (a sweep must never steal the screen), and the new cookie-class gate can answer an honest signed-out
    // BEFORE any tab is touched (the `no-csrf`-instead-of-`not-logged-in` incident).
    const r = await invokeRideRecipe(rec, groundId, { invoke: (payload) => _ctx.invokeSgHandler('INVOKE_SESSION', { ...payload, headless: true }) });
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
    let armed = recs.filter((r) => r && armable(r) && r.origin);
    // v2.74.2052 — this reader bypasses _vitalsGrounds (raw read by groundId), so it needs its own own-origin
    // door: same anchor rule (the ground's identity; no anchor → unfiltered, the pre-2052 shape).
    try {
      const g = ((await StorageManager.getAllGrounds()) || []).find((x) => x && (x.id === groundId || x.groundId === groundId));
      const anchor = String(primaryHost(g) || '').toLowerCase();
      if (anchor) {
        const part = partitionRecipesByOrigin(armed, anchor);
        if (part.foreign.length) _logForeignRows(groundId, anchor, part);
        armed = part.own;
      }
    } catch { /* best-effort — the confirm still runs on the unfiltered set rather than dying */ }
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
    /**
     * AU-6 (v2.74.2207, §12.3) — VERIFY-AT-VIEW: "whatever is true right now", 1 read, ON DEMAND. The tier that
     * fires when a HUMAN is looking, which is why it ignores the poll window — a person opening a record has
     * asked a question the cadence cannot answer, and §12.3 marks this trigger "fires when cold: yes".
     *
     * It runs the SAME sweep as the tick rather than a private read path: one reconciliation, one set of rules
     * about what absence means. `force` only bypasses the window.
     */
    // v2.74.2222 — `key` (the row's at|id identity) scopes the forced sweep to the record being LOOKED at, which
    // is the §12.3 price ("1 read, on demand"); no key = the whole-book force (a deliberate full re-check).
    RECORD_VERIFY_NOW: (payload, _sender, sendResponse) => {
      (async () => {
        try { const t = await _recordWatchSweep({ force: true, onlyKey: String((payload && payload.key) || '') }); sendResponse({ success: true, tally: t }); }
        catch (e) { sendResponse({ success: false, error: (e && e.message) || 'verify failed' }); }
      })();
      return true;
    },
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
