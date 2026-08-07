// background/handlers/cadence.js — CD-1 (DESIGN_cadence.md §2 / §5): the ONE CLOCK OWNER for time-triggered
// workflows. The I/O shell around the pure cores (Core/trigger.js, Core/workflowTier.js, Core/runDriver.js,
// Core/runHistory.js). Copies background/handlers/vitals.js verbatim in structure — that is the model this whole
// design adopts by absorbing the mistake fleet made (an alarm per desk that nothing collects).
//
// THE RULE (§2): exactly ONE repeating alarm. It wakes, SCANS workflow records, and fires the ones that are due.
// Never an alarm per workflow. Deleting a workflow or a desk cannot orphan anything — the scanner simply stops
// finding the record. Everything is fail-safe: cadence must never break the boot it rides or the call it observes.
//
// TIER (§11.3): only a tier-'sw' workflow fires HEADLESS here (pinned ride/nav/fieldRead/map/write — Core/workflowTier).
// A tier-'panel' workflow is deferred (WORKFLOW_DUE_CHANGED) for panel due-on-open. Writes use pipelineGate (§8
// amended v2036): internal+reversible → auto; outward/undeclared → park; destructive → refuse.

import { Logger } from '../../Core/Logger.js';
import { ConversationStore } from '../../Services/ConversationStore.js';   // §2.1 check 4 (v1715) — desk LIVENESS, not just the orphan stamp
import { listAllWorkflows, updateWorkflow } from '../../Services/Storage/WorkflowStore.js';
import { appendRunEntry, loadRuns } from '../../Services/Storage/WorkflowRunStore.js';   // v1739 — loadRuns STATIC: MV3 SWs disallow dynamic import() at runtime (the WORKFLOW_RUNS lazy-load threw on every call — background.js:77 records the same purge once before)
import { normalizeWorkflow } from '../../Core/workflowMemory.js';
import { isDue, coalescedCount, advanceTrigger, recordFailure, disarm, normalizeTrigger, armTrigger, isTransientFailure } from '../../Core/trigger.js';   // v2.74.2043 — isTransientFailure keeps auth blips out of the disarm count
import { runsHeadless, explainTier } from '../../Core/workflowTier.js';   // v2.74.2043 — explainTier names the demoting step (`TIER ▸`)
import { replayPlan } from '../../Core/workflowWizard.js';
import { runWorkflow, makeAccumulatorReporter, makeResumeReporter } from '../../Core/runDriver.js';
import { mintRunId } from '../../Core/pipelineRun.js';
import { priorRunVerdict } from '../../Core/fleetSchedule.js';
import { runRideStep, rideStepResolvable, projectRideLeg } from '../../Core/rideStep.js';   // CD-1a (§9.4) — the SHARED pinned-ride/nav step primitive (one impl for SW + panel); projectRideLeg = the one SW projection (v2047)
import { runFieldReadStep } from '../../Core/headlessClause.js';   // CD-1a phase 2, extraction 1 (v1717) — the headless banked field read
import { runMapStep } from '../../Core/headlessMap.js';           // v2.74.2036 — pinned map (no INTERPRET)
import { runWriteStep } from '../../Core/headlessWrite.js';       // v2.74.2036 — write + pipelineGate (auto for internal)

const TICK_ALARM = 'cadence:tick';
const TICK_MINUTES = 5;                    // honor the 5-min cadence floor (Core/trigger clamps below this)
const RUN_PREFIX = 'cadence:run:';         // per-workflow in-flight marker { runId, startedAt } — survives SW death
const PARK_PREFIX = 'cadence:parked:';     // a parked run's minimal resume marker (CD-7 promotes this to a wfp_ case)
const PAUSE_PREFIX = 'cadence:pause:';     // WFP-6 — the headless ⏸ latch {at}, runId-scoped OWN key (the heartbeat re-stamp would erase a marker field); cleared with the run
// v2.74.2047 — how often an EACH sweep re-stamps its own run marker (see _runStepInner's onEach): the 5-min
// in-flight window (Core/fleetSchedule.priorRunVerdict) is a hard ceiling on run DURATION, and a 121-invoke sweep
// can cross it cold (measured 6.8–11.9s per cold ride) — after which the next 5-min tick judges the marker DIED
// and fires a CONCURRENT duplicate over the still-running sweep, re-executing the whole prefix. Refreshing the
// marker on sweep progress makes the window measure from the last life-sign instead of fire-start; a mid-sweep SW
// death stops the refreshes, so the died-verdict recovery still runs — at most one refresh interval later.
const RUN_MARKER_REFRESH_MS = 60_000;

let _ctx = null;

// v2.74.2052 — the SW reads MERGED records, never the raw store. The raw store freezes mechanical fields at
// seed-time shape until a PANEL read happens to trigger the v1435 catalog merge (GET_RIDE_RECIPES) — so a
// catalog upgrade (live: the v2051 joinKey ladder dropping its name rungs) reached the panel immediately but the
// scheduled path only after someone opened a desk — the user as state manager, the exact iron-principle failure.
// ONE merge implementation (the handler), never a second copy here; the raw store is the offline fallback
// (stale beats none — the run must not die because a merge read failed).
async function _mergedReadRecipes(groundId) {
  try {
    const r = await _ctx.invokeSgHandler('GET_RIDE_RECIPES', { groundId });
    if (r && r.success !== false && Array.isArray(r.recipes)) return r.recipes;
  } catch { /* fall through */ }
  try { return (await _ctx.readRideRecipes(groundId)) || []; } catch { return []; }
}

// ── registration — copy vitals.js: alarms are durable across SW restarts, only the LISTENER re-registers ──────────
export function initCadence(ctx) {
  _ctx = (ctx && typeof ctx === 'object') ? ctx : null;
  // v2.74.2043 — EXISTENCE GUARD, copied from vitals.js:384 (which has always had it; this file said "copy vitals"
  // and then didn't). `chrome.alarms.create` with an existing NAME replaces the alarm and RESTARTS its period from
  // zero. initCadence runs on every service-worker boot, and the SW boots dozens of times a day, so an unguarded
  // create meant the 5-minute periodic alarm was continually pushed back: during active browsing it could go long
  // stretches without ever firing, and the effective clock was the 6-second boot kick below rather than the cadence
  // this file claims to own. Recreate ONLY when the period itself changed (so editing TICK_MINUTES still takes).
  (async () => {
    try {
      const existing = await chrome.alarms.get(TICK_ALARM);
      if (!existing) { chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES }); return; }
      if (existing.periodInMinutes !== TICK_MINUTES) chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES });
    } catch {
      try { chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES }); } catch { /* */ }
    }
  })();
  try {
    chrome.alarms.onAlarm.addListener((alarm) => {
      if (alarm && alarm.name === TICK_ALARM) { _tick().catch(() => { /* */ }); }
    });
  } catch { /* */ }
  // the boot kick (vitals.js:255): the SW boots dozens of times a day, so the tick is itself due-gated — a boot
  // inside a window is a no-op. A small delay lets the boot finish wiring _invokeSgHandler + the recipe readers.
  try { setTimeout(() => { _tick().catch(() => { /* */ }); }, 6000); } catch { /* */ }
}

// ── the in-flight marker (§5.2) — mirror fleet.js: stamp BEFORE work, judge on the NEXT fire ──────────────────────
async function _readRunMarker(workflowId) {
  try { const k = RUN_PREFIX + workflowId; return (await chrome.storage.local.get(k))?.[k] || null; } catch { return null; }
}
async function _stampRunMarker(workflowId, runId, now) {
  try { await chrome.storage.local.set({ [RUN_PREFIX + workflowId]: { runId, startedAt: now } }); } catch { /* */ }
}
async function _clearRunMarker(workflowId) {
  try { await chrome.storage.local.remove(RUN_PREFIX + workflowId); } catch { /* */ }
}

// ── CD-7 (§8) — parked-run markers (the resumable record a write-bearing scheduled run leaves) ────────────────────
async function _listParked() {
  let all = null;
  try { all = await chrome.storage.local.get(null); } catch { return []; }
  const out = [];
  for (const [k, v] of Object.entries(all || {})) {
    if (k.startsWith(PARK_PREFIX) && v && typeof v === 'object') out.push({ ...v, runId: v.runId || k.slice(PARK_PREFIX.length) });
  }
  return out.sort((a, b) => (b.at || 0) - (a.at || 0));
}
async function _readParked(runId) {
  try { const k = PARK_PREFIX + runId; return (await chrome.storage.local.get(k))?.[k] || null; } catch { return null; }
}
async function _clearParked(runId) {
  try { await chrome.storage.local.remove(PARK_PREFIX + runId); } catch { /* */ }
}
/**
 * v2.74.2043 — does this workflow already have a park waiting on a human? The §7.2 overlap check reads only
 * `cadence:run:` (an IN-FLIGHT run), and a park is not in flight — so a parked workflow was re-fired on its very
 * next due-time, forever, until someone approved it. Each re-fire re-ran the whole prefix and minted ANOTHER park
 * record and another history row: N parks for one decision, and the panel's parked list grew a duplicate per
 * interval.
 *
 * This turns load-bearing with v2.74.2043's auto-write authority: in a chain where an early write is gate-`auto`
 * and a LATER step parks, every re-fire re-executes that write. The per-item shape does defend itself here — the
 * map ahead of the write no longer counts the created rows as misses, so the re-run writes nothing — but that
 * defence is a property of one workflow shape, not of the scheduler, and it evaporates the moment a lookup is
 * eventually-consistent or keyed differently from the create. Don't rely on it; don't re-fire a parked workflow.
 */
async function _hasOpenPark(workflowId) {
  try {
    const all = await chrome.storage.local.get(null);
    for (const [k, v] of Object.entries(all || {})) {
      if (k.startsWith(PARK_PREFIX) && v && typeof v === 'object' && v.workflowId === workflowId) return v;
    }
  } catch { /* fail OPEN: a storage read failure must not wedge the clock permanently */ }
  return null;
}
async function _resolveWorkflow(workflowId) {
  try {
    for (const g of await listAllWorkflows()) {
      const hit = (g.items || []).find((x) => x && x.id === workflowId);
      if (hit) return { wf: normalizeWorkflow(hit), appId: g.appId };
    }
  } catch { /* */ }
  return { wf: null, appId: null };
}

// ── the scan (§2.1): checks in order, cheapest first — every one a reason NOT to fire ─────────────────────────────
async function _tick() {
  if (!_ctx) return;
  let groups = [];
  try { groups = await listAllWorkflows(); } catch { groups = []; }
  const now = Date.now();
  // §2.1 check 4 (v1715) — "the owning desk still EXISTS", not just "was stamped orphaned": a desk deleted by any
  // path that never stamped (pre-1640 legacy) was invisible to the stamp-only check. Build the live-key set once
  // per tick — a workflow bank key that matches NO conversation's id/instanceId/appId has no desk. FAIL-SAFE: if
  // the list read fails or comes back empty, skip the liveness check entirely (never disarm on missing evidence).
  let liveKeys = null;
  try {
    const convs = await ConversationStore.list();
    if (Array.isArray(convs) && convs.length) {
      liveKeys = new Set();
      for (const c of convs) for (const k of [c && c.id, c && c.instanceId, c && c.appId]) if (k) liveKeys.add(k);
    }
  } catch { liveKeys = null; }
  let scanned = 0, fired = 0, deferred = 0, parked = 0, disarmed = 0, inflight = 0, failedFire = 0;
  let parkHold = 0;   // v2.74.2043 — held because ALREADY parked (a standing state; deliberately not in the summary gate)

  for (const g of (Array.isArray(groups) ? groups : [])) {
    const appId = g && g.appId;
    for (const raw of (g && Array.isArray(g.items) ? g.items : [])) {
      const wf = normalizeWorkflow(raw);
      if (!wf || !wf.trigger) continue;                     // check 1+2 in one: a real record with a trigger
      scanned++;
      const trig = wf.trigger;
      if (!trig.enabled) continue;                          // check 2 — disabled records never fire (silent)
      if (!isDue(trig, now)) continue;                      // check 3 — not due yet (silent)

      // check 4 — the owning desk still exists. A workflow survives desk deletion stamped `orphanedFrom` (§9);
      // an orphaned trigger auto-disarms and writes history, because a person will later ask why it stopped.
      // v1715 — the stamp OR live-key liveness (§2.1's actual wording): either signal disarms.
      if ((raw && raw.orphanedFrom) || (liveKeys && !liveKeys.has(appId))) {
        await _autoDisarm(appId, wf, (raw && raw.orphanedFrom) ? 'the owning view was deleted' : 'the owning view no longer exists', now);
        disarmed++;
        continue;
      }

      // check 5 — no run already in flight (§7.2 overlap: two concurrent runs corrupt each other's DOM waits).
      // v1715 — a skip WRITES HISTORY (§2.1: "a row that fails 4 or 5 writes history, because a person will later
      // ask why it stopped"). Verdict 'running' is the honest one — a run IS in flight; at most ~1 entry per
      // overlap window (the in-flight marker is judged dead after 5 min, so this can't spam).
      const marker = await _readRunMarker(wf.id);
      const verdict = priorRunVerdict(marker, now);
      if (verdict.inFlight) {
        try { await appendRunEntry(wf.id, { at: trig.nextDue || now, ranAt: now, trigger: 'auto', verdict: 'running', why: 'skipped — a run was already in flight (overlap)' }); } catch { /* */ }
        inflight++;
        continue;
      }
      if (verdict.died && marker) {
        // a mid-flight SW/browser death ran no catch — report it, then proceed.
        Logger.info('cadence', `CADENCE ▸ prior run of "${wf.name || wf.id}" died mid-flight (run ${marker.runId}) — proceeding`);
        await _clearRunMarker(wf.id);
      }

      // check 5b (v2.74.2043) — no PARK already waiting on a human for this workflow. See _hasOpenPark. Throttled
      // to the same once-an-hour report as a deferral: this is a standing state, and the panel's parked banner is
      // where a person is meant to see it.
      const openPark = await _hasOpenPark(wf.id);
      if (openPark) {
        // NOT `parked++`. `parked` counts runs that parked THIS tick — an EVENT. A workflow held because it is
        // already parked is a STANDING STATE, and feeding it into `parked` would put a nonzero value in the
        // summary's fire condition below on every single tick, re-creating the exact `gc` spam that condition
        // exists to prevent (and doing it for as long as the park went unapproved).
        parkHold++;
        try {
          const last = _deferLoggedAt.get('park:' + wf.id) || 0;
          if (now - last >= DEFER_LOG_MS) {
            _deferLoggedAt.set('park:' + wf.id, now);
            Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" not re-fired — a parked run (${openPark.runId}) is waiting for approval`);
          }
        } catch { /* */ }
        continue;
      }

      const coalesced = coalescedCount(trig, now);          // §7.2 — several due-times passed → run ONCE, record it

      // ── tier gate (§11.3): tier-'panel' defers to the PANEL; only tier-'sw' fires headless here ───────────────
      if (!runsHeadless(wf)) {
        // The SW can't run these (a branch/map/case/write step needs the panel). LEAVE the trigger's nextDue as
        // the due signal — the panel surfaces "due now" and runs it, then advances via WORKFLOW_MARK_RAN.
        // Advancing HERE (the pre-1696 bug) pushed nextDue into the future, so the panel never saw it as due and
        // the workflow advanced its clock every tick but NEVER ran. Don't touch it; just count it for the summary.
        // v2.74.2035 — wake an OPEN panel (due-on-open was documented but unwired; panel-tier sat "due now" forever).
        deferred++;
        try {
          chrome.runtime.sendMessage(
            { type: 'WORKFLOW_DUE_CHANGED', workflowId: wf.id, appId, name: wf.name || wf.ask || wf.id },
            () => { void chrome.runtime.lastError; },
          );
        } catch { /* panel closed — next Automate render / desk-open still picks it up */ }
        // v2.74.2043 — the DEFERRED BACKLOG WAS STRUCTURALLY INVISIBLE. The broadcast above is fire-and-forget: with
        // the panel closed nothing receives it, and the scan summary below is suppressed unless something HAPPENED.
        // So "my workflow never ran" and "the SW never even considered it" produced byte-identical traces (empty).
        // Say it — but THROTTLED (the suppression rationale below is real: a standing due must not emit every 5 min).
        await _reportDeferred(wf, appId, trig, now);
        continue;
      }

      const res = await _fire(appId, wf, trig, { now, coalesced, trigger: 'auto' });
      if (res.verdict === 'parked') parked++;
      else if (res.verdict === 'failed') failedFire++;
      else fired++;
    }
  }

  // Log the summary ONLY on a real EVENT (a fire / park / disarm / overlap-skip). A standing state — a workflow
  // that merely HAS a schedule, or a tier-'panel' one that stays due until the panel runs it — must not emit a
  // line every 5-min tick, or it spams the decisions log (`CADENCE ▸` is in _DECISION_RE, so gc would fill with
  // "0 fired, 0 parked …" forever). The panel surfaces standing-due; the scan need only speak when it acts.
  if (fired || parked || disarmed || failedFire || inflight) {
    Logger.info('cadence', `CADENCE ▸ scan: ${scanned} triggered — ${fired} fired, ${parked} parked, ${deferred} deferred(panel), ${disarmed} disarmed, ${inflight} in-flight, ${failedFire} failed${parkHold ? `, ${parkHold} awaiting approval` : ''}`);
  }
}

// ── v2.74.2043 — the deferral report (§11.3's missing half) ───────────────────────────────────────────────────────
// THROTTLED to once an hour per workflow: the standing-due suppression above is correct (a tier-'panel' workflow
// stays due until a panel runs it, so an un-throttled line would fill `gc` forever), but SILENCE was worse — it is
// why four passes re-diagnosed the same demotion. Once an hour is loud enough to see in any real window and quiet
// enough that a week of deferrals is ~168 lines, not ~2000.
const DEFER_LOG_MS = 60 * 60 * 1000;
const _deferLoggedAt = new Map();   // workflowId → last report (module scope; a SW death just re-reports once)

/** Is a side panel actually listening? `getContexts` is Chrome 116+; unknown ≠ closed (fail-safe). */
async function _panelOpen() {
  try {
    if (!chrome.runtime || typeof chrome.runtime.getContexts !== 'function') return null;
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] });
    return Array.isArray(ctxs) ? ctxs.length > 0 : null;
  } catch { return null; }
}

async function _reportDeferred(wf, appId, trig, now) {
  try {
    const last = _deferLoggedAt.get(wf.id) || 0;
    if (now - last < DEFER_LOG_MS) return;
    _deferLoggedAt.set(wf.id, now);
    const t = explainTier(wf);
    const open = await _panelOpen();
    const dueMin = Math.max(0, Math.round((now - (trig.nextDue || now)) / 60000));
    const where = open === true ? 'panel open — due-on-open should run it'
      : (open === false ? 'PANEL CLOSED — nothing will run it' : 'panel presence unknown');
    Logger.info('cadence', `CADENCE ▸ deferred "${wf.name || wf.id}" — tier-panel, due ${dueMin}m, ${where}`);
    Logger.info('cadence', `TIER ▸ "${wf.name || wf.id}" panel — step ${t.stepIndex + 1} kind=${t.kind}: ${t.why}`);
  } catch { /* a report must never break the scan */ }
}

// ── the fire: resolve → drive → write history → advance/record (§5.5 "go through the normal executor") ────────────
// `reporter`/`startIndex`/`state` are the CD-7 resume seam: a resume passes a makeResumeReporter() + the parked
// stepIndex + the parked chainState (§8's record — prior steps' values must survive the park for a later write).
async function _fire(appId, wf, trig, { now, coalesced = 1, trigger = 'auto', reporter = null, startIndex = 0, state = null, resumedFrom = '' } = {}) {
  const runId = mintRunId({ now, rand: (now % 997) / 997 });   // deterministic-ish entropy (Math.random is banned in Core; fine here)
  await _stampRunMarker(wf.id, runId, now);
  // WFP-6 (§12.9) — the RUN-STATE broadcast: the panel card renders a running state for cadence fires (the ⏸'s
  // surface) from this. Payload contract (written here, the arc's rung 1): {workflowId, runId, state, name}.
  const _runState = (stateWord) => { try { chrome.runtime.sendMessage({ type: 'WORKFLOW_RUN_STATE', workflowId: wf.id, runId, state: stateWord, name: String(wf.name || wf.ask || wf.id).slice(0, 120) }, () => { void chrome.runtime.lastError; }); } catch { /* closed panel */ } };
  _runState('running');
  const rep = reporter || makeAccumulatorReporter();
  let out = { verdict: 'failed' };
  // v2.74.2048 — bank the run's OWN lines as the durable Trace. v2030 gave PANEL runs this ({t,m} on the
  // history entry, preferred by the drill); an AUTO run's row apologized "No workflow lines left in the session
  // log" the moment the INFO ring rotated — live report, minutes after the first real headless fire. The SW
  // banks the same lines it logs (RIDE_EACH/STEP/GATE/STOPPED); normalizeHistoryTrace caps + scrubs at append.
  const traceBank = [];
  const bankLine = (m) => { if (traceBank.length < 40) traceBank.push({ t: new Date().toISOString().slice(11, 23), m: String(m) }); };
  // v2.74.2036 — closed-panel presence: pulse toolbar while a scheduled fire runs.
  try { _cadencePresence('running', { name: wf.name || wf.ask || wf.id }); } catch { /* */ }
  try {
    // v2.74.2044 — drift is resolved BEFORE the plan (see _resolveDrift); replayPlan's predicate must stay sync.
    const resolvable = await _resolveDrift(wf);
    const plan = replayPlan(wf, (pin) => resolvable.get(pin) !== false);   // absent pin (can't happen) → no manufactured drift
    if (!plan.runnable) {
      // a banked step no longer resolves (drift) — never silently re-interpret (§2.1). Count as a failure.
      const _stopLine = `CADENCE ▸ "${wf.name || wf.id}" STOPPED — ${plan.stale.length} banked step(s) no longer resolve`;
      Logger.info('cadence', _stopLine);
      bankLine(_stopLine);
      out = { verdict: 'failed' };
    } else {
      out = await runWorkflow({
        clauses: plan.clauses,
        reporter: rep,
        startIndex: Math.max(0, Number(startIndex) || 0),
        state,
        runStep: (clause, cctx) => _runStep(clause, { ...cctx, runId, wf, bank: bankLine }),
        // WFP-6 — the SW pause binding: an own-key latch (never a marker field — the heartbeat re-stamp
        // overwrites the marker wholesale), runId-scoped so a stale ⏸ can never latch a newer run.
        shouldPause: async () => { try { const o = await chrome.storage.local.get(PAUSE_PREFIX + runId); return !!o[PAUSE_PREFIX + runId]; } catch { return false; } },
      });
    }
  } catch (e) {
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" fire threw: ${(e && e.message) || e}`);
    out = { verdict: 'failed' };
  }
  await _clearRunMarker(wf.id);
  try { await chrome.storage.local.remove(PAUSE_PREFIX + runId); } catch { /* */ }   // WFP-6 — the latch dies with the run (honored or outran)
  _runState('ended');
  const _pausedRun = out.pauseCause === 'paused';   // WFP-6 — the user's ⏸, never a write-gate park
  try {
    const v = out.verdict === 'parked' ? 'parked' : out.verdict;
    // §12.5 — a pause is the user's own act: NO presence pulse, no OS notification, no "needs approval" badge.
    if (!_pausedRun) _cadencePresence(v === 'parked' || v === 'failed' ? v : 'done', { name: wf.name || wf.ask || wf.id, verdict: v });
  } catch { /* */ }

  const snap = rep.snapshot();
  const _rows = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' && Array.isArray(v.rows) ? v.rows.length : 0));
  const counts = { steps: snap.steps, total: snap.total, done: snap.results.length, parked: snap.parked ? 1 : 0, ...(_rows(out.state && out.state.lastValue) ? { rows: _rows(out.state.lastValue) } : {}) };
  const verdict = out.verdict === 'parked' || snap.parked ? 'parked' : out.verdict;
  const parkedRunId = out.parkedRunId || runId;

  // history entry (§6.3/§6.5) — initiation · verdict · duration · scale · the failing step · the join keys
  try {
    await appendRunEntry(wf.id, {
      at: trig.nextDue || now, ranAt: now, trigger, verdict, counts,
      ms: Date.now() - now, runId, contentId: wf.contentId || '',
      ...(traceBank.length ? { trace: traceBank } : {}),   // v2.74.2048 — the durable Trace (parity with panel ▶)
      ...(out.failedStep ? { failedStep: out.failedStep } : {}),
      ...(resumedFrom ? { resumedFrom } : {}),
      ...(verdict === 'parked' ? { parkedRunId, kind: _pausedRun ? 'paused' : 'gate', why: _pausedRun ? `paused by you at step ${(Number(out.parkedAt) || 0) + 1}` : 'a write step needs approval' } : {}),   // WFP-4/WFP-6 — the park's CAUSE picks the story
      ...(coalesced > 1 ? { coalesced } : {}),
    });
  } catch { /* history must never block the clock */ }

  // Only an AUTO fire touches the schedule — a manual "run now" must not push the next due-time or disarm on a
  // one-off failure (that would let a hand-run silently reschedule the automation).
  const auto = trigger === 'auto';
  if (verdict === 'parked') {
    // CD-7 (§8) — persist the parked run as a resumable record: { workflowId, appId, stepIndex, at, preview }.
    // The panel surfaces it as a wfp_ case (Approve & continue / Cancel run); resume re-fires from stepIndex.
    try {
      await chrome.storage.local.set({ [PARK_PREFIX + parkedRunId]: {
        runId: parkedRunId, workflowId: wf.id, appId, name: wf.name || wf.ask || wf.id,
        kind: _pausedRun ? 'paused' : 'gate', tier: 'sw',   // WFP-4/6 (§12.2) — cause + executor; readers default an absent kind to 'gate'
        stepIndex: out.parkedAt, at: now, preview: _pausedRun ? null : ((snap.preview && typeof snap.preview === 'object') ? snap.preview : null),
        // §8 (v1715) — the chainState rides the park record: phase-1 ride steps thread no state yet, but the
        // moment a write's params come from a prior step's read, losing this would resume the write blind.
        chainState: (out.state && typeof out.state === 'object' && Object.keys(out.state).length) ? out.state : null,
      } });
    } catch { /* */ }
    // Tell an OPEN panel a run is waiting on a human — a scheduled run that stopped silently is worse than useless
    // (§8: "ran and is waiting on you" is the most important thing to say). Fire-and-forget; a closed panel misses
    // it and finds the run in the manage-view parked banner instead. Only an AUTO fire nudges (a manual/⚡ run is
    // already on-screen for the user who started it).
    if (auto || _pausedRun) { try { chrome.runtime.sendMessage({ type: 'WORKFLOW_PARKED_CHANGED', name: wf.name || wf.ask || wf.id }, () => { void chrome.runtime.lastError; }); } catch { /* */ } }   // WFP-6 — a pause refreshes the open panel too (rows/dots), it just never NOTIFIES
    Logger.info('cadence', _pausedRun
      ? `STOP ▸ workflow "${String(wf.name || wf.id).slice(0, 40)}" paused at step ${out.parkedAt + 1} (run ${parkedRunId})`
      : `CADENCE ▸ "${wf.name || wf.id}" PARKED at step ${out.parkedAt + 1} — a write needs a human (run ${parkedRunId})`);
    if (auto) await _advance(appId, wf, now);
  } else if (verdict === 'failed') {
    // v2.74.2043 — pass the FIRST failing step's error so an auth/offline failure doesn't burn a disarm strike.
    if (auto) await _recordFailure(appId, wf, now, (out.failedStep && out.failedStep.error) || '');
  } else {
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" ran → ${verdict} (${counts.done}/${snap.total} step(s))${coalesced > 1 ? ` · ${coalesced} collapsed` : ''}`);
    if (auto) await _advance(appId, wf, now);
  }
  return { verdict, parkedRunId: verdict === 'parked' ? parkedRunId : '' };
}

// One step, through the SHARED primitives (§9.4 — the SAME modules the panel reads, so the two never diverge).
// Dispatch by pin kind: a banked fieldRead runs pure over the chain state (Core/headlessClause); everything else
// is the pinned-ride/nav path (Core/rideStep) with the SW's IO injected. A ride READ threads its value into the
// chain state (state.lastValue) so a following fieldRead has rows to read — phase 2's composition seam.
async function _runStep(clause, ctx) {
  // A THROWN step must still report. runDriver catches throws and converts them to {ok:false}, so without this
  // catch the one case most likely to need a trace line — an unexpected exception — was the one case that emitted
  // none. Converting here is behaviour-identical to what runDriver would have done with the throw.
  let r;
  try { r = await _runStepInner(clause, ctx); }
  catch (e) { r = { ok: false, error: `threw: ${(e && e.message) || e}` }; }
  // v2.74.2043 — the SW ran every headless step SILENTLY. A whole scheduled run produced at most one summary line,
  // so "which step died, and how" was unanswerable from a trace — the exact question every v2038–2042 pass asked.
  try {
    const pin = (clause && clause.pinned && typeof clause.pinned === 'object') ? clause.pinned : null;
    const kind = (pin && pin.kind) || 'ride';
    const at = `${(ctx.index || 0) + 1}/${ctx.total || '?'}`;
    const outcome = r && r.park ? 'parked' : (r && r.ok ? 'ok' : `fail(${(r && r.error) || '?'})`);
    const ids = pin ? [pin.capabilityId && `cap=${pin.capabilityId}`, pin.groundId && `g=${pin.groundId}`].filter(Boolean).join(' ') : 'unpinned';
    // v2.74.2047 — the HOST speaks the each-sweep's lines (Core/rideEach stays Logger-free), in the panel fan's
    // exact vocabulary so gc/gl read ONE language — `(sw…)`/`[sw]` marks this driver the way `(chain…)`/`[chain]`
    // marks the panel chain. trace-lint's ride-each-receipt pairing holds by construction: the tally OPENS the
    // span and the `returned`/`exit` terminal is emitted adjacent, in the same guarded block. RIDE_EACH ▸ is an
    // already-registered marker family (Core/decisionMarkers.js) — invariant #1 satisfied by reuse.
    // v2.74.2048 — every run line ALSO banks onto the history entry's durable Trace (ctx.bank, seeded by _fire).
    const _say = (m) => { Logger.info('cadence', m); if (typeof ctx.bank === 'function') { try { ctx.bank(m); } catch { /* */ } } };
    if (r && r.each && typeof r.each === 'object') {
      const e = r.each;
      _say(`RIDE_EACH ▸ ${e.recipeId || (pin && pin.capabilityId) || '?'} × ${e.total} ${e.noun}(s) (sw${e.fixed ? `, ${e.fixed}` : ''}) → ${e.ok} ok, ${e.failed} failed, ${e.seen} row(s)`);
      if (e.ok > 0) _say(`RIDE_EACH ▸ returned ${e.returned} row(s)${e.truncated ? ` of ${e.seen} — CAPPED at ${e.rowCap}` : ''} from ${e.ok}/${e.total} ${e.noun}(s) [sw]`);
      else _say(`RIDE_EACH ▸ exit — total failure (0 ok, ${e.failed} tried) [sw]`);
    }
    _say(`STEP ▸ ${at} ${kind} ${ids} → ${outcome}`);
    // The gate verdict headlessWrite now returns (Core stays Logger-free — the host speaks).
    if (r && r.gate) _say(`GATE   ▸ item=${r.gate.targetId || '?'} headless write → ${r.gate.decision}${r.gate.decision === 'auto' ? '' : `(${r.gate.why})`}`);
  } catch { /* a trace line must never change a run */ }
  return r;
}

async function _runStepInner(clause, ctx) {
  const pin = (clause && clause.pinned && typeof clause.pinned === 'object') ? clause.pinned : null;
  // v2.74.2043 — `headless: true`, matching background/handlers/fleet.js:42 (which has stamped it on every
  // scheduled read since H-1a). Without it, connector.js's identity gate takes the INTERACTIVE branch on a
  // signed-out ground: `_focusTab` + `_waitForReauth`. That means a 3 AM scheduled run STEALS THE SCREEN — it
  // raises a login tab in front of whatever the person is doing, or in front of nobody, and then blocks the
  // worker waiting for a human who isn't there. With the flag the same verdict fails fast as `not-logged-in`,
  // which Core/trigger.isTransientFailure then keeps out of the auto-disarm count.
  const invoke = (payload) => _ctx.invokeSgHandler('INVOKE_SESSION', { ...payload, headless: true });
  const readRecipes = _mergedReadRecipes;   // v2.74.2052 — merged, never raw (see the helper)
  // v2.74.2047 — keep the in-flight marker ALIVE across every long step (see RUN_MARKER_REFRESH_MS): each
  // completion beat re-stamps `cadence:run:<wfId>` at most once a minute, so priorRunVerdict's 5-min window
  // measures from the last life-sign and a slow run — a 121-invoke EACH sweep, a 121-row map lookup chain, a
  // 25-row write — is never declared dead (and duplicated) mid-run. Same runId: a heartbeat, not a new run.
  // Fire-and-forget (_stampRunMarker never throws). Seeded to NOW — _fire stamped the marker moments ago, so
  // the first re-stamp is owed a full interval out, not at once.
  let lastBeat = Date.now();
  const onEach = () => {
    const t = Date.now();
    if (t - lastBeat < RUN_MARKER_REFRESH_MS) return;
    lastBeat = t;
    if (ctx.wf && ctx.wf.id && ctx.runId) void _stampRunMarker(ctx.wf.id, ctx.runId, t);
  };
  if (pin && pin.kind === 'fieldRead') return runFieldReadStep(clause, { state: ctx.state });
  if (pin && pin.kind === 'map') {
    return runMapStep(clause, { state: ctx.state, invoke, readRecipes, onRow: onEach });
  }
  if (pin && pin.kind === 'write') {
    return runWriteStep(clause, {
      state: ctx.state, invoke, readRecipes, reporter: ctx.reporter, runId: ctx.runId, onRow: onEach,
    });
  }
  const r = await runRideStep(clause, {
    readRecipes,
    invoke,
    reporter: ctx.reporter,
    runId: ctx.runId,
    workflowId: ctx.wf && ctx.wf.id,
    onEach,
  });
  if (r && r.ok && r.value !== undefined && r.value !== null) {
    // Thread lastLeg for a following map's joinKey ladder (panel does this on connector success).
    let lastLeg = (ctx.state && ctx.state.lastLeg) || null;
    try {
      const p = pin;
      if (p && p.groundId && p.capabilityId) {
        const recs = (await readRecipes(p.groundId)) || [];
        const rec = recs.find((x) => x && x.id === p.capabilityId);
        if (rec) {
          lastLeg = projectRideLeg(rec, p.groundId) || lastLeg;   // v2.74.2047 — the one SW projection (raw recipeToLeg lost seeded records)
        }
      }
    } catch { /* */ }
    return { ...r, state: { ...(ctx.state || {}), lastValue: r.value, lastLeg } };
  }
  return r;
}

// v2.74.2036 — toolbar presence when the panel is closed (DESIGN_panel_surfaces §7 standing channel).
let _cadenceDoneSinceOpen = 0;
function _cadencePresence(phase, { name = '', verdict = '' } = {}) {
  try {
    if (phase === 'running') {
      chrome.action.setTitle({ title: `Running: ${String(name).slice(0, 80)}` });
      chrome.action.setBadgeText({ text: '…' });
      chrome.action.setBadgeBackgroundColor({ color: '#d97757' });
      try { if (_ctx && typeof _ctx.startPulse === 'function') _ctx.startPulse(); } catch { /* */ }
      return;
    }
    try { if (_ctx && typeof _ctx.stopPulse === 'function') _ctx.stopPulse(); } catch { /* */ }
    if (phase === 'parked' || phase === 'failed') {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: phase === 'failed' ? '#c25a5a' : '#c8954a' });
      chrome.action.setTitle({ title: phase === 'failed'
        ? `Failed: ${String(name).slice(0, 60)}`
        : `Needs you: ${String(name).slice(0, 60)}` });
      try {
        chrome.notifications.create(`cadence-${phase}-${Date.now()}`, {
          type: 'basic',
          iconUrl: 'assets/icon128.png',
          title: phase === 'failed' ? 'Scheduled run failed' : 'Scheduled run needs approval',
          message: String(name).slice(0, 120),
        });
      } catch { /* notifications permission optional */ }
      return;
    }
    // done
    _cadenceDoneSinceOpen = Math.min(99, _cadenceDoneSinceOpen + 1);
    chrome.action.setBadgeText({ text: _cadenceDoneSinceOpen > 1 ? String(_cadenceDoneSinceOpen) : '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#6b9e5c' });
    chrome.action.setTitle({ title: `Done: ${String(name).slice(0, 60)}${verdict ? ` (${verdict})` : ''}` });
  } catch { /* badge best-effort */ }
}

/** Panel open clears the "done while closed" standing badge. */
export function clearCadenceDoneBadge() {
  _cadenceDoneSinceOpen = 0;
  try {
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Orchard' });
  } catch { /* */ }
}

// The drift check (§2.1), via the same shared primitive — PRE-resolved (v2.74.2044). rideStepResolvable is
// async, but replayPlan's canResolve contract is SYNCHRONOUS (the panel path relies on that — keep it): handing
// it the async function returned a Promise per call, which `!!` coerced truthy — plan.stale stayed empty,
// plan.runnable stayed true, and the STOPPED branch in _fire was unreachable dead code. A drifted workflow
// therefore ran its live prefix (including gate-auto writes — the re-execution hazard _hasOpenPark documents)
// every due-tick before dying mid-run as generic 'recipe-gone'/'not-armed'. So: await every pin's verdict FIRST
// (Promise.all), then hand replayPlan a sync lookup keyed by pin IDENTITY (replayPlan passes steps[i].clause
// through unchanged). NOTE the {pinned:pin} wrapper — replayPlan hands canResolve the BARE pin, while
// rideStepResolvable unwraps `.pinned`/`.clause`; a naked pin finds no pin inside and answers true for
// everything, which was the same vacuity by a second route.
async function _resolveDrift(wf) {
  const out = new Map();
  const pins = [];
  for (const s of (Array.isArray(wf && wf.steps) ? wf.steps : [])) {
    if (s && s.clause && typeof s.clause === 'object') pins.push(s.clause);
  }
  await Promise.all(pins.map(async (pin) => {
    let ok = false;
    try { ok = (await rideStepResolvable({ pinned: pin }, { readRecipes: _mergedReadRecipes })) === true; } catch { ok = false; }
    out.set(pin, ok);
  }));
  return out;
}

// ── trigger write-backs (through the sanctioned store path; updateWorkflow re-normalizes + whitelists trigger) ─────
async function _advance(appId, wf, now) {
  const next = advanceTrigger(wf.trigger, now);
  try { await updateWorkflow(appId, wf.id, { trigger: next }); } catch { /* */ }
}
async function _recordFailure(appId, wf, now, error = '') {
  const transient = isTransientFailure(error);
  const next = recordFailure(wf.trigger, { now, transient });
  try { await updateWorkflow(appId, wf.id, { trigger: next }); } catch { /* */ }
  if (transient) {
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" failed transiently (${error}) — clock advanced, no disarm strike`);
  }
  if (next && next.enabled === false) {
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" AUTO-DISARMED after ${next.failures} consecutive failures — its route may have drifted`);
    try { await appendRunEntry(wf.id, { at: now, ranAt: now, trigger: 'auto', verdict: 'disarmed', why: `${next.failures} consecutive failures` }); } catch { /* */ }
  }
}
async function _autoDisarm(appId, wf, why, now) {
  const next = disarm(wf.trigger, why, now);   // RB-2 — stamp the reason on the trigger so the Automate tab can say it
  try { await updateWorkflow(appId, wf.id, { trigger: next }); } catch { /* */ }
  Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" auto-disarmed — ${why}`);
  try { await appendRunEntry(wf.id, { at: now, ranAt: now, trigger: 'auto', verdict: 'disarmed', why }); } catch { /* */ }
}

// ── the handlers the panel arms / reads history from ─────────────────────────────────────────────────────────────
export function createCadenceHandlers() {
  return {
    // v2.74.2036 — panel open clears the closed-panel "done" toolbar badge.
    CADENCE_PRESENCE_CLEAR: (_payload, _sender, sendResponse) => {
      clearCadenceDoneBadge();
      sendResponse({ success: true });
      return false;
    },
    // TRIGGER ▸ arm/edit/disarm a workflow's cadence. payload: { appId, workflowId, trigger|null }. The trigger is
    // normalized here; a null/invalid trigger clears the cadence.
    WORKFLOW_TRIGGER_SET: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const { appId, workflowId, trigger } = (payload && typeof payload === 'object') ? payload : {};
          if (!appId || !workflowId) { sendResponse({ success: false, error: 'appId + workflowId required' }); return; }
          let norm = normalizeTrigger(trigger) || null;   // null ⇒ clear the cadence
          // ARM properly: an enabled trigger with no nextDue anchor (the panel schedule bar sends
          // {minutes, enabled} only) would be enabled yet NEVER due (isDue requires nextDue > 0) — the scanner
          // would silently skip it forever. Anchor a fresh nextDue one interval out.
          if (norm && norm.enabled && !(norm.nextDue > 0)) norm = armTrigger(norm.minutes, Date.now()) || norm;
          const items = await updateWorkflow(appId, workflowId, { trigger: norm });
          const wf = (items || []).find((x) => x && x.id === workflowId) || null;
          Logger.info('cadence', `TRIGGER ▸ ${norm ? (norm.enabled ? 'armed' : 'set(paused)') : 'cleared'} "${(wf && (wf.name || wf.id)) || workflowId}"${norm ? ` every ${norm.minutes}m` : ''}`);
          sendResponse({ success: true, trigger: wf ? wf.trigger : null });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'trigger-set-failed' }); }
      })();
      return true;
    },
    // The run history for the overlay (§6.2). payload: { workflowId }.
    WORKFLOW_RUNS: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const workflowId = payload && payload.workflowId;
          if (!workflowId) { sendResponse({ success: false, error: 'workflowId required' }); return; }
          const runs = await loadRuns(workflowId);
          sendResponse({ success: true, ...runs });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'runs-failed' }); }
      })();
      return true;
    },
    // A MANUAL headless fire (the run icon on a tier-'sw' workflow, or "run now" from the overlay). payload:
    // { appId, workflowId }. Writes a `trigger:'manual'` history entry. Panel-tier workflows still run in the panel.
    WORKFLOW_RUN_FIRE: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const { appId, workflowId } = (payload && typeof payload === 'object') ? payload : {};
          if (!appId || !workflowId) { sendResponse({ success: false, error: 'appId + workflowId required' }); return; }
          const items = await listAllWorkflows();
          let wf = null, owner = appId;
          for (const g of items) { const hit = (g.items || []).find((x) => x && x.id === workflowId); if (hit) { wf = normalizeWorkflow(hit); owner = g.appId; break; } }
          if (!wf) { sendResponse({ success: false, error: 'workflow-not-found' }); return; }
          if (!runsHeadless(wf)) { sendResponse({ success: false, error: 'panel-tier', tier: 'panel' }); return; }
          // v2.74.2047 — a manual fire must not overlap an in-flight run: an each sweep widened this window from
          // seconds to minutes, and two concurrent runs share one ground (duplicate reads, racing markers, the
          // heartbeat alternating runIds). The scan's own overlap rule, applied to the manual door.
          const _mk = await _readRunMarker(wf.id);
          if (priorRunVerdict(_mk, Date.now()).inFlight) {
            Logger.info('cadence', `CADENCE ▸ manual fire of "${wf.name || wf.id}" refused — a run is already in flight (${_mk.runId})`);
            sendResponse({ success: false, error: 'in-flight', runId: _mk.runId || '' });
            return;
          }
          // WFP-5 (§12.4) — the manual door checks open parks too: a paused/parked workflow re-fired from step 0
          // runs beside its own suspended state (the scan's check 5b, applied here — parks were SW-only before
          // the pause arc, so only the scan needed it).
          const _openPark = await _hasOpenPark(wf.id);
          if (_openPark) {
            Logger.info('cadence', `CADENCE ▸ manual fire of "${wf.name || wf.id}" refused — a ${_openPark.kind === 'paused' ? 'paused' : 'parked'} run is waiting (${_openPark.runId})`);
            sendResponse({ success: false, error: 'parked-open', runId: _openPark.runId || '', kind: _openPark.kind === 'paused' ? 'paused' : 'gate' });
            return;
          }
          const now = Date.now();
          const res = await _fire(owner, wf, wf.trigger || normalizeTrigger({ minutes: 60 }), { now, coalesced: 1, trigger: 'headless' });   // §6.5 — the 4-way initiation stamp
          sendResponse({ success: true, verdict: res.verdict, parkedRunId: res.parkedRunId || '' });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'fire-failed' }); }
      })();
      return true;
    },
    // CD-1a (§11.3) — a tier-'panel' scheduled workflow RAN in the panel (the SW can't run it headless); advance
    // its clock so it isn't perpetually "due". Only the panel calls this, and only for a due panel-tier run — a
    // manual extra run of a tier-'sw' workflow must NOT reschedule its headless fire. payload: { appId, workflowId }.
    WORKFLOW_MARK_RAN: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const { appId, workflowId } = (payload && typeof payload === 'object') ? payload : {};
          if (!appId || !workflowId) { sendResponse({ success: false, error: 'appId + workflowId required' }); return; }
          const { wf, appId: owner } = await _resolveWorkflow(workflowId);
          if (!wf || !wf.trigger) { sendResponse({ success: true, advanced: false }); return; }
          await _advance(owner || appId, wf, Date.now());
          Logger.info('cadence', `TRIGGER ▸ "${wf.name || wf.id}" ran in panel — clock advanced`);
          sendResponse({ success: true, advanced: true });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'mark-ran-failed' }); }
      })();
      return true;
    },
    // CD-7 (§8) — the PARKED runs waiting on a human. payload: { appId? } (optional filter). Each is a run that
    // reached a write on a schedule and stopped; the panel surfaces them as wfp_ cases with Approve & continue.
    WORKFLOW_PARKED: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const appId = payload && payload.appId;
          let parked = await _listParked();
          if (appId) parked = parked.filter((p) => p && p.appId === appId);
          // RB-2 (rail review) — count auto-disarmed triggers in the same response so the Automate attention dot
          // covers "the system switched your automation off" without the panel paying a second bank sweep.
          let disarmedN = 0;
          try {
            for (const g of await listAllWorkflows()) {
              for (const w of (g.items || [])) {
                // Loop2 (independent review) — ONE dot formula: the Automate render counts OWNED banks only (an
                // orphaned bank draws no "Stopped" row), so an orphan-stamped disarm here made the dot show a
                // count the tab could never explain — N closed, drop on render, bounce back on the next funnel.
                if (w && w.orphanedFrom) continue;
                const t = w && w.trigger;
                if (t && t.enabled === false && t.disarmedWhy) disarmedN++;
              }
            }
          } catch { /* the dot degrades to parked-only */ }
          sendResponse({ success: true, parked, disarmedN });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'parked-failed' }); }
      })();
      return true;
    },
    // CD-7 (§8) — APPROVE & CONTINUE: re-fire the parked run from its stepIndex, approving the write the person saw.
    // A later write re-parks (one approval per write). payload: { runId }.
    WORKFLOW_RESUME_PARKED: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const runId = payload && payload.runId;
          if (!runId) { sendResponse({ success: false, error: 'runId required' }); return; }
          const marker = await _readParked(runId);
          if (!marker) { sendResponse({ success: false, error: 'parked-run-not-found' }); return; }
          // WFP-2 (§12.2) — TIER-ROUTED resume: a panel-tier park (a paused card run) must never resume through
          // _fire's headless executor, which runs only pinned fieldRead/map/write/ride steps — branch/case/walk
          // steps would fail one by one. The panel drives its own resume: consume the marker and hand it back.
          if (marker.tier === 'panel') {
            await _clearParked(runId);
            Logger.info('cadence', `TRIGGER ▸ panel-tier park ${runId} handed back for a panel resume ("${marker.name || marker.workflowId}")`);
            sendResponse({ success: true, panel: true, marker });
            return;
          }
          const { wf, appId } = await _resolveWorkflow(marker.workflowId);
          if (!wf) {
            // verify-fix LOW — a resume whose workflow vanished must not evaporate: one history row says so.
            try { await appendRunEntry(marker.workflowId, { at: Date.now(), ranAt: Date.now(), trigger: 'manual', verdict: 'failed', why: 'resume failed — the workflow no longer exists' }); } catch { /* */ }
            sendResponse({ success: false, error: 'workflow-not-found' }); await _clearParked(runId); return;
          }
          await _clearParked(runId);   // this park is consumed; a re-park mints a fresh marker
          // WFP-4 (§12.5) — the resume REPORTER is picked by the park's CAUSE, and a kind-less legacy record is
          // 'gate': makeResumeReporter's first-gate-true IS the human's approval of the write they were shown; a
          // PAUSED park has no shown write, so it resumes with the accumulator (gate → park) — resuming a pause
          // must never silently approve an unseen write. (Wrong default the other way = the v2043 approve-forever
          // loop: a gate park resumed with the accumulator re-parks the same write with no way through.)
          const _paused = marker.kind === 'paused';
          Logger.info('cadence', `TRIGGER ▸ resume "${wf.name || wf.id}" from step ${(marker.stepIndex || 0) + 1} (${_paused ? 'paused by user' : 'approved write'}, run ${runId})`);
          const res = await _fire(appId || marker.appId, wf, wf.trigger || normalizeTrigger({ minutes: 60 }),
            { now: Date.now(), coalesced: 1, trigger: 'resume', resumedFrom: runId, reporter: _paused ? makeAccumulatorReporter() : makeResumeReporter(), startIndex: Number(marker.stepIndex) || 0,
              state: (marker.chainState && typeof marker.chainState === 'object') ? marker.chainState : null });   // §8 (v1715) — resume with the parked chainState
          sendResponse({ success: true, verdict: res.verdict, parkedRunId: res.parkedRunId || '' });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'resume-failed' }); }
      })();
      return true;
    },
    // CD-7 (§8) — CANCEL RUN: drop the parked run without approving the write. payload: { runId }. Records history.
    WORKFLOW_CANCEL_PARKED: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const runId = payload && payload.runId;
          if (!runId) { sendResponse({ success: false, error: 'runId required' }); return; }
          const marker = await _readParked(runId);
          await _clearParked(runId);
          if (marker && marker.workflowId) {
            // WFP-4 (§12.5) — the ✕ story is KIND-aware: discarding a PAUSE is "stopped by you" (verdict 'empty'
            // when the pause landed before step 1 — no work ran), never the gate's write-cancellation story.
            const _paused = marker.kind === 'paused';
            const _k = (Number(marker.stepIndex) || 0);
            const _entry = _paused
              ? { verdict: _k > 0 ? 'partial' : 'empty', kind: 'paused', why: `stopped by you (was paused at step ${_k + 1})` }
              : { verdict: 'partial', kind: 'gate', why: 'parked write cancelled by the user' };
            try { await appendRunEntry(marker.workflowId, { at: marker.at || Date.now(), ranAt: Date.now(), trigger: 'manual', ..._entry }); } catch { /* */ }
            Logger.info('cadence', `TRIGGER ▸ ${_paused ? 'discard paused' : 'cancel parked'} run ${runId} ("${marker.name || marker.workflowId}")${_paused ? '' : ' — the write was not sent'}`);
          }
          // RB-1 (rail review) — found:false = the marker was already consumed (approved/finished); the panel
          // must not tell the user a stop happened when there was nothing left to stop.
          sendResponse({ success: true, found: !!marker });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'cancel-failed' }); }
      })();
      return true;
    },
    // WFP-2 (§12.2) — the PANEL's park-mint: a card run the user paused banks its bookmark here (the parked
    // store is SW-owned). kind:'paused' + tier:'panel' by construction — resume is tier-routed back to the
    // panel (RESUME_PARKED above), NEVER through _fire. Deliberately NO _cadencePresence and no OS notification
    // (§12.5): the user just clicked ⏸; notifying them of their own act is noise. The PARKED_CHANGED broadcast
    // still fires so dots/rows refresh. payload: { appId, workflowId, name, stepIndex, total, chainState }.
    WORKFLOW_PARK_PANEL: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const { appId, workflowId, name, stepIndex, total, chainState } = (payload && typeof payload === 'object') ? payload : {};
          if (!appId || !workflowId) { sendResponse({ success: false, error: 'appId + workflowId required' }); return; }
          const now = Date.now();
          const runId = mintRunId({ now, rand: (now % 997) / 997 });
          const _k = Math.max(0, Number(stepIndex) || 0);
          await chrome.storage.local.set({ [PARK_PREFIX + runId]: {
            runId, workflowId, appId, name: String(name || workflowId).slice(0, 120),
            kind: 'paused', tier: 'panel',
            stepIndex: _k, at: now, preview: null,
            chainState: (chainState && typeof chainState === 'object' && Object.keys(chainState).length) ? chainState : null,
          } });
          try {
            await appendRunEntry(workflowId, {
              at: now, ranAt: now, trigger: 'manual', verdict: 'parked', kind: 'paused', parkedRunId: runId,
              why: `paused by you at step ${_k + 1}${Number(total) > 0 ? ` of ${Number(total)}` : ''}`,
            });
          } catch { /* history must never block the park */ }
          try { chrome.runtime.sendMessage({ type: 'WORKFLOW_PARKED_CHANGED', name: String(name || workflowId).slice(0, 120) }, () => { void chrome.runtime.lastError; }); } catch { /* */ }
          Logger.info('cadence', `STOP ▸ workflow "${String(name || workflowId).slice(0, 40)}" paused at step ${_k + 1}${Number(total) > 0 ? `/${Number(total)}` : ''} (run ${runId})`);
          sendResponse({ success: true, runId });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'park-failed' }); }
      })();
      return true;
    },
    // WFG-1e — is a HEADLESS run live for this workflow? The panel's edit guard asks (its broadcast-fed map
    // misses fires that started before the panel opened). payload: { workflowId }.
    WORKFLOW_RUN_LIVE: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const workflowId = payload && payload.workflowId;
          if (!workflowId) { sendResponse({ success: false, error: 'workflowId required' }); return; }
          const mk = await _readRunMarker(workflowId);
          sendResponse({ success: true, live: !!(mk && mk.runId && priorRunVerdict(mk, Date.now()).inFlight), runId: (mk && mk.runId) || '' });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'live-check-failed' }); }
      })();
      return true;
    },
    // WFP-6 (§12.9) — PAUSE a HEADLESS run: latch cadence:pause:<runId> against the LIVE run marker only
    // (runId-scoped — a stale ⏸ can never latch a newer run; no live run → found:false, "already finished").
    // The driver's shouldPause poll honors it at the next clause boundary; the park exit stamps kind:'paused'.
    WORKFLOW_PAUSE_RUN: (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const { workflowId, runId } = (payload && typeof payload === 'object') ? payload : {};
          if (!workflowId) { sendResponse({ success: false, error: 'workflowId required' }); return; }
          const mk = await _readRunMarker(workflowId);
          const live = mk && mk.runId && priorRunVerdict(mk, Date.now()).inFlight;
          if (!live || (runId && mk.runId !== runId)) { sendResponse({ success: true, found: false }); return; }
          await chrome.storage.local.set({ [PAUSE_PREFIX + mk.runId]: { at: Date.now() } });
          Logger.info('cadence', `STOP ▸ pause requested for workflow ${String(workflowId).slice(0, 40)} (run ${mk.runId})`);
          sendResponse({ success: true, found: true, runId: mk.runId });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'pause-failed' }); }
      })();
      return true;
    },
  };
}
