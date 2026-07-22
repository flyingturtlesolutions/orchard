// background/handlers/cadence.js — CD-1 (DESIGN_cadence.md §2 / §5): the ONE CLOCK OWNER for time-triggered
// workflows. The I/O shell around the pure cores (Core/trigger.js, Core/workflowTier.js, Core/runDriver.js,
// Core/runHistory.js). Copies background/handlers/vitals.js verbatim in structure — that is the model this whole
// design adopts by absorbing the mistake fleet made (an alarm per desk that nothing collects).
//
// THE RULE (§2): exactly ONE repeating alarm. It wakes, SCANS workflow records, and fires the ones that are due.
// Never an alarm per workflow. Deleting a workflow or a desk cannot orphan anything — the scanner simply stops
// finding the record. Everything is fail-safe: cadence must never break the boot it rides or the call it observes.
//
// TIER (§11.3): only a tier-'sw' workflow (all steps are pinned rides / navs — Core/workflowTier) fires HEADLESS
// here. A tier-'panel' workflow is logged as due and its clock advanced (coalescing), then left for the panel to
// run on next desk-open — the honest label §7.3 already tells the user which it is. Phase 1 executes only READ
// rides; a write reached unattended PARKS (§8), because writePolicy has no 'auto' and nobody is watching.

import { Logger } from '../../Core/Logger.js';
import { listAllWorkflows, updateWorkflow } from '../../Services/Storage/WorkflowStore.js';
import { appendRunEntry } from '../../Services/Storage/WorkflowRunStore.js';
import { normalizeWorkflow } from '../../Core/workflowMemory.js';
import { isDue, coalescedCount, advanceTrigger, recordFailure, disarm, normalizeTrigger, armTrigger } from '../../Core/trigger.js';
import { runsHeadless } from '../../Core/workflowTier.js';
import { replayPlan } from '../../Core/workflowWizard.js';
import { runWorkflow, makeAccumulatorReporter, makeResumeReporter } from '../../Core/runDriver.js';
import { mintRunId } from '../../Core/pipelineRun.js';
import { priorRunVerdict } from '../../Core/fleetSchedule.js';
import { recipeToLeg } from '../../Core/connectorLeg.js';
import { planExec } from '../../Core/execPlan.js';
import { armable } from '../../Core/rideRecipe.js';

const TICK_ALARM = 'cadence:tick';
const TICK_MINUTES = 5;                    // honor the 5-min cadence floor (Core/trigger clamps below this)
const RUN_PREFIX = 'cadence:run:';         // per-workflow in-flight marker { runId, startedAt } — survives SW death
const PARK_PREFIX = 'cadence:parked:';     // a parked run's minimal resume marker (CD-7 promotes this to a wfp_ case)

let _ctx = null;

// ── registration — copy vitals.js: alarms are durable across SW restarts, only the LISTENER re-registers ──────────
export function initCadence(ctx) {
  _ctx = (ctx && typeof ctx === 'object') ? ctx : null;
  try { chrome.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES }); } catch { /* */ }
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
  let scanned = 0, fired = 0, deferred = 0, parked = 0, disarmed = 0, inflight = 0, failedFire = 0;

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
      if (raw && raw.orphanedFrom) {
        await _autoDisarm(appId, wf, 'the owning desk was deleted', now);
        disarmed++;
        continue;
      }

      // check 5 — no run already in flight (§7.2 overlap: two concurrent runs corrupt each other's DOM waits).
      const marker = await _readRunMarker(wf.id);
      const verdict = priorRunVerdict(marker, now);
      if (verdict.inFlight) { inflight++; continue; }
      if (verdict.died && marker) {
        // a mid-flight SW/browser death ran no catch — report it, then proceed.
        Logger.info('cadence', `CADENCE ▸ prior run of "${wf.name || wf.id}" died mid-flight (run ${marker.runId}) — proceeding`);
        await _clearRunMarker(wf.id);
      }

      const coalesced = coalescedCount(trig, now);          // §7.2 — several due-times passed → run ONCE, record it

      // ── tier gate (§11.3): tier-'panel' defers to the PANEL; only tier-'sw' fires headless here ───────────────
      if (!runsHeadless(wf)) {
        // The SW can't run these (a branch/map/case/write step needs the panel). LEAVE the trigger's nextDue as
        // the due signal — the panel surfaces "due now" and runs it, then advances via WORKFLOW_MARK_RAN.
        // Advancing HERE (the pre-1696 bug) pushed nextDue into the future, so the panel never saw it as due and
        // the workflow advanced its clock every tick but NEVER ran. Don't touch it; just count it for the summary.
        deferred++;
        continue;
      }

      const res = await _fire(appId, wf, trig, { now, coalesced, trigger: 'auto' });
      if (res.verdict === 'parked') parked++;
      else if (res.verdict === 'failed') failedFire++;
      else fired++;
    }
  }

  if (scanned) {
    Logger.info('cadence', `CADENCE ▸ scan: ${scanned} triggered — ${fired} fired, ${parked} parked, ${deferred} deferred(panel), ${disarmed} disarmed, ${inflight} in-flight, ${failedFire} failed`);
  }
}

// ── the fire: resolve → drive → write history → advance/record (§5.5 "go through the normal executor") ────────────
// `reporter`/`startIndex` are the CD-7 resume seam: a resume passes a makeResumeReporter() + the parked stepIndex.
async function _fire(appId, wf, trig, { now, coalesced = 1, trigger = 'auto', reporter = null, startIndex = 0 } = {}) {
  const runId = mintRunId({ now, rand: (now % 997) / 997 });   // deterministic-ish entropy (Math.random is banned in Core; fine here)
  await _stampRunMarker(wf.id, runId, now);
  const rep = reporter || makeAccumulatorReporter();
  let out = { verdict: 'failed' };
  try {
    const plan = replayPlan(wf, (clause) => _canResolve(clause));
    if (!plan.runnable) {
      // a banked step no longer resolves (drift) — never silently re-interpret (§2.1). Count as a failure.
      Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" STOPPED — ${plan.stale.length} banked step(s) no longer resolve`);
      out = { verdict: 'failed' };
    } else {
      out = await runWorkflow({
        clauses: plan.clauses,
        reporter: rep,
        startIndex: Math.max(0, Number(startIndex) || 0),
        runStep: (clause, cctx) => _runStep(clause, { ...cctx, runId, wf }),
      });
    }
  } catch (e) {
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" fire threw: ${(e && e.message) || e}`);
    out = { verdict: 'failed' };
  }
  await _clearRunMarker(wf.id);

  const snap = rep.snapshot();
  const counts = { steps: snap.steps, done: snap.results.length, parked: snap.parked ? 1 : 0 };
  const verdict = out.verdict === 'parked' || snap.parked ? 'parked' : out.verdict;
  const parkedRunId = out.parkedRunId || runId;

  // history entry (§6.3) — auto vs manual, verdict, the coalesced-backlog note, and due!=ran (§7.3)
  try {
    await appendRunEntry(wf.id, {
      at: trig.nextDue || now, ranAt: now, trigger, verdict, counts,
      ...(verdict === 'parked' ? { parkedRunId, why: 'a write step needs approval' } : {}),
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
        stepIndex: out.parkedAt, at: now, preview: (snap.preview && typeof snap.preview === 'object') ? snap.preview : null,
      } });
    } catch { /* */ }
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" PARKED at step ${out.parkedAt + 1} — a write needs a human (run ${parkedRunId})`);
    if (auto) await _advance(appId, wf, now);
  } else if (verdict === 'failed') {
    if (auto) await _recordFailure(appId, wf, now);
  } else {
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" ran → ${verdict} (${counts.done}/${snap.total} step(s))${coalesced > 1 ? ` · ${coalesced} collapsed` : ''}`);
    if (auto) await _advance(appId, wf, now);
  }
  return { verdict, parkedRunId: verdict === 'parked' ? parkedRunId : '' };
}

// One step. Phase 1: a pinned READ ride runs through the normal executor; a write PARKS (§8); a nav is a no-op
// success (the ride's ephemeral tab carries its own URL). Everything else can't reach here — the tier gate ensures
// every step is sw-eligible before we fire.
async function _runStep(clause, ctx) {
  const via = clause && clause.pinned ? clause.pinned : null;
  const kind = String((via && via.kind) || '').trim();
  if (kind === 'navigate' || (!via && /navigate/i.test(clause && clause.text || ''))) return { ok: true, value: null };

  const groundId = via && via.groundId;
  const capId = via && via.capabilityId;
  if (!groundId || !capId) return { ok: false, error: 'unpinned-step' };

  let recs = [];
  try { recs = (await _ctx.readRideRecipes(groundId)) || []; } catch { recs = []; }
  const rec = recs.find((r) => r && r.id === capId);
  if (!rec) return { ok: false, error: 'recipe-gone' };
  if (!armable(rec)) return { ok: false, error: 'not-armed' };

  // §8 — a write reached unattended parks. writePolicy has no 'auto': a GET is safetyClass 'auto', anything else
  // is a write/act. The reporter's gate decides (SW ⇒ 'park'; a panel reporter could approve live).
  const isWrite = rec.write === true || (rec.safetyClass && rec.safetyClass !== 'auto');
  if (isWrite) {
    const decision = await ctx.reporter.gate({ workflowId: ctx.wf && ctx.wf.id, step: clause.text, recipe: rec.name || capId, groundId });
    if (decision !== true) return { park: true, parkedRunId: ctx.runId };
  }

  const leg = recipeToLeg({ ...rec, groundId }, { account: 'me', trusted: true });
  if (!leg || !leg.tool) return { ok: false, error: 'no-leg' };
  const plan = planExec(leg, {}, {});
  if (!plan || plan.ok === false || plan.channel !== 'INVOKE_SESSION') return { ok: false, error: 'no-plan' };
  let r = null;
  try { r = await _ctx.invokeSgHandler('INVOKE_SESSION', plan.payload); } catch (e) { return { ok: false, error: (e && e.message) || 'invoke-threw' }; }
  const ok = !!(r && r.success !== false);
  return ok ? { ok: true, value: (r && r.value) } : { ok: false, error: (r && r.error) || 'invoke-failed' };
}

// Does a pinned clause still resolve? (replayPlan's drift check, §2.1). A ground + capability that reads back an
// armable recipe resolves; anything else is drift → STOP the run, never re-interpret.
async function _canResolve(clause) {
  const pin = clause && (clause.pinned || clause.clause);
  if (!pin) return true;                                  // a loose (text) step is legitimately unpinned
  const kind = String(pin.kind || '').trim();
  if (kind === 'navigate') return true;
  const groundId = pin.groundId, capId = pin.capabilityId;
  if (!groundId || !capId) return false;
  try {
    const recs = (await _ctx.readRideRecipes(groundId)) || [];
    const rec = recs.find((r) => r && r.id === capId);
    return !!(rec && armable(rec));
  } catch { return false; }
}

// ── trigger write-backs (through the sanctioned store path; updateWorkflow re-normalizes + whitelists trigger) ─────
async function _advance(appId, wf, now) {
  const next = advanceTrigger(wf.trigger, now);
  try { await updateWorkflow(appId, wf.id, { trigger: next }); } catch { /* */ }
}
async function _recordFailure(appId, wf, now) {
  const next = recordFailure(wf.trigger, { now });
  try { await updateWorkflow(appId, wf.id, { trigger: next }); } catch { /* */ }
  if (next && next.enabled === false) {
    Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" AUTO-DISARMED after ${next.failures} consecutive failures — its route may have drifted`);
    try { await appendRunEntry(wf.id, { at: now, ranAt: now, trigger: 'auto', verdict: 'disarmed', why: `${next.failures} consecutive failures` }); } catch { /* */ }
  }
}
async function _autoDisarm(appId, wf, why, now) {
  const next = disarm(wf.trigger);
  try { await updateWorkflow(appId, wf.id, { trigger: next }); } catch { /* */ }
  Logger.info('cadence', `CADENCE ▸ "${wf.name || wf.id}" auto-disarmed — ${why}`);
  try { await appendRunEntry(wf.id, { at: now, ranAt: now, trigger: 'auto', verdict: 'disarmed', why }); } catch { /* */ }
}

// ── the handlers the panel arms / reads history from ─────────────────────────────────────────────────────────────
export function createCadenceHandlers() {
  return {
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
          const { loadRuns } = await import('../../Services/Storage/WorkflowRunStore.js');
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
          const now = Date.now();
          const res = await _fire(owner, wf, wf.trigger || normalizeTrigger({ minutes: 60 }), { now, coalesced: 1, trigger: 'manual' });
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
          sendResponse({ success: true, parked });
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
          const { wf, appId } = await _resolveWorkflow(marker.workflowId);
          if (!wf) { sendResponse({ success: false, error: 'workflow-not-found' }); await _clearParked(runId); return; }
          await _clearParked(runId);   // this park is consumed; a re-park mints a fresh marker
          Logger.info('cadence', `TRIGGER ▸ resume "${wf.name || wf.id}" from step ${(marker.stepIndex || 0) + 1} (approved write, run ${runId})`);
          const res = await _fire(appId || marker.appId, wf, wf.trigger || normalizeTrigger({ minutes: 60 }),
            { now: Date.now(), coalesced: 1, trigger: 'manual', reporter: makeResumeReporter(), startIndex: Number(marker.stepIndex) || 0 });
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
            try { await appendRunEntry(marker.workflowId, { at: marker.at || Date.now(), ranAt: Date.now(), trigger: 'manual', verdict: 'partial', why: 'parked write cancelled by the user' }); } catch { /* */ }
            Logger.info('cadence', `TRIGGER ▸ cancel parked run ${runId} ("${marker.name || marker.workflowId}") — the write was not sent`);
          }
          sendResponse({ success: true });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'cancel-failed' }); }
      })();
      return true;
    },
  };
}
