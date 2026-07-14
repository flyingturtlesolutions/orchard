// background/handlers/fleet.js — FL-6 (v2.74.1355, DESIGN_app_fleet.md §6). The fleet app's CLOCK TRIGGER: a
// per-instance chrome.alarm fires the SAME propose-only sweep the `sweep` verb runs — HEADLESS (the panel is
// usually closed when it fires). The loop didn't change; only what pokes it did.
//
// Headless orchestration mirrors chat.js `_runFleetSweep` (the panel twin keeps its live status weaving; this
// one is bare — candidate for a shared Core sweep-driver with injected IO once both are proven). Everything
// rides existing machinery via `invokeSgHandler` (the in-SW handler bridge): SWEEP_PROPOSE for the two think
// seams, the planExec channel (INVOKE_SESSION — incl. its §16 cold-start ephemeral-tab path) for reads. A
// signed-out session fails the reads → the run ledgers as skipped, never throws. Results park in the SAME
// instance-keyed queue; the app conversation gets ONE persisted note when proposals mint (no 0-proposal spam).
// The pending signal is the APP'S OWN Rail card (FL-6c — the chip derives from the queue; the panel's
// storage.onChanged watch lights it live) — NEVER the extension-icon badge, which belongs to other features
// and can't say WHICH app wants attention.

import { planExec } from '../../Core/execPlan.js';
import { coerceParams } from '../../Core/connectorRecipes.js';
import { minimizeReadValue } from '../../Core/sweepPrompt.js';
import { targetUrls, getPath, autonomyFor, executedTodayByRecipe, filterRejectedRepeats, rejectionContext, supersedePlan } from '../../Core/proposals.js';
import { ledgerEntry } from '../../Core/actionLedger.js';
import { sweepAlarmName, instanceFromAlarmName, describeEvery, rollDailyCounts, spikeVerdict, localDay, queueStateLines, priorRunVerdict, routineAlarmName, instanceFromRoutineAlarm } from '../../Core/fleetSchedule.js';   // DK-8 (v1491) — + the routine alarm identity
import { listRows, pickDrillCandidates, extractTicketEvidence, solveVerdict, stubCloseVerdict, clusterTickets, mergeAdvice, renderTicketEvidence, deriveMe, updateSeen, toBankEntry, bankEvidence } from '../../Core/ticketEvidence.js';
import { builtinApp } from '../../Core/appCatalog.js';
import { loadProposals, addProposals, decideProposal } from '../../Services/Storage/ProposalStore.js';
import { appendLedger } from '../../Services/Storage/ActionLedgerStore.js';
import { ConversationStore } from '../../Services/ConversationStore.js';
import { Logger } from '../../Core/Logger.js';

const _SCHED_KEY = (instanceId) => `fleetSchedule:${instanceId}`;   // instance-keyed (the identity invariant)
const _ROUT_KEY = (instanceId) => `fleetRoutine:${instanceId}`;     // DK-8 (v1491) — the desk's declared routine record (one per desk, v1)

async function _readSchedule(instanceId) {
  try { const got = await chrome.storage.local.get(_SCHED_KEY(instanceId)); return got[_SCHED_KEY(instanceId)] || null; } catch { return null; }
}

/** Execute one read leg through the in-SW channel (the same dispatch the panel's _runConnectorLeg plans).
 * H-1a (v1376) — `headless: true` rides every payload: INVOKE_SESSION must fail fast on signed-out instead of
 * focusing a login tab and waiting for a human who isn't there. */
async function _runReadLeg(invokeSgHandler, leg, params) {
  const plan = planExec(leg, coerceParams(params || {}, leg.paramSchema), {});
  if (!plan || !plan.ok || !plan.channel) return { ok: false, error: (plan && plan.reason) || 'no executor' };
  const res = await invokeSgHandler(plan.channel, { ...plan.payload, headless: true });
  if (!res || res.success === false) return { ok: false, error: (res && res.error) || 'failed' };
  return { ok: true, value: res.value };
}

const _SEEN_KEY = (instanceId) => `fleetSeen:${instanceId}`;   // FL-10b — the drill's pass-state (per-ticket updated_at + held/done)

/**
 * FL-10b (v2.74.1383, from logs/run/zendesk-queue-workflow-spec.md) — the EVIDENCE DRILL: triage the list rows
 * (code, the spec §2 signals), fetch the candidates' FULL threads through the recipe the list read declares
 * (`tool.drill.via`), extract deterministic facts + rubric verdicts (Core/ticketEvidence), and hand the propose
 * model a fenced per-item evidence block. This closes the gap the Claude Code MVP exposed: "solve what looks
 * resolved" was unjudgeable from subject+status rows — the model was evidence-STARVED, not under-reasoned.
 * Held stubs (call intelligence not posted yet) re-drill every fire until populated. Never throws.
 */
async function _runDrill({ instanceId, legs, allReads, rawByKey, cfg, invokeSgHandler, step }) {
  const out = { evidence: '', verdicts: new Map(), attach: new Map(), drilled: 0, held: 0 };
  let via = null;
  const rows = []; const seenRowIds = new Set();
  for (const r of allReads) {
    const spec = r.leg && r.leg.tool && r.leg.tool.drill;
    if (!spec || !spec.via || !rawByKey.has(r.key)) continue;
    via = via || spec.via;
    for (const row of listRows(rawByKey.get(r.key))) {
      const id = row && row.id != null ? String(row.id) : '';
      if (!id || seenRowIds.has(id)) continue;
      seenRowIds.add(id); rows.push(row);
    }
  }
  if (!rows.length || !via) return out;
  const drillLeg = legs.find((l) => l && l.mode === 'ask' && l.tool && l.tool.recipeId === via);
  if (!drillLeg) { await step('drill', 'evidence', false, `drill read "${via}" not offered`); return out; }
  // MY agent id + MY ticket ids — derived from the mine-scoped reads' own rows, never config. Unknown me → the
  // "assigned to me" checks fail CLOSED (nothing auto-executes on evidence this run). mineIds feeds the solve
  // lane: only my tickets can ever be solve-eligible, so they get the protected budget share (FL-10e).
  let mineRows = [];
  for (const r of allReads) {
    if (r.leg && r.leg.tool && r.leg.tool.pulse && r.leg.tool.pulse.scope === 'mine' && rawByKey.has(r.key)) mineRows = mineRows.concat(listRows(rawByKey.get(r.key)));
  }
  const me = deriveMe(mineRows);
  const mineIds = new Set(mineRows.filter((r) => r && r.id != null).map((r) => String(r.id)));
  let seen = {};
  try { const got = await chrome.storage.local.get(_SEEN_KEY(instanceId)); seen = got[_SEEN_KEY(instanceId)] || {}; } catch { /* */ }
  const cap = Math.max(1, Math.min(12, Number(cfg && cfg.drill && cfg.drill.cap) || 8));
  const cands = pickDrillCandidates(rows, { cap, seen, mineIds });
  if (!cands.length) return out;
  const now = Date.now();
  const evidences = []; const seenUpdates = [];
  for (const c of cands) {
    const run = await _runReadLeg(invokeSgHandler, drillLeg, { id: c.id });
    if (!run.ok) { await step('drill', `#${c.id}`, false, run.error || 'read failed'); continue; }
    const ev = extractTicketEvidence(c.row, listRows(run.value), { now });
    const sv = solveVerdict(ev, { me });
    const cv = stubCloseVerdict(ev, { afterMs: Math.max(1, Number(cfg && cfg.drill && cfg.drill.stubCloseAfterHours) || 4) * 3600e3 });
    const held = (ev.stub && !ev.populated && cv.tooNew);
    out.verdicts.set(ev.id, { autoSolve: sv.autoEligible, autoClose: cv.autoEligible, solveEligible: sv.eligible, closeEligible: cv.eligible, holds: held ? sv.holds : sv.holds.filter((h) => !h.startsWith('call intelligence')), missing: sv.missing });
    out.attach.set(ev.id, { klass: ev.klass, sentiment: ev.sentiment, commitment: !!ev.actionItem, matched: null, crossAgent: false });
    evidences.push(ev);
    seenUpdates.push({ id: ev.id, updatedAt: ev.updatedAt, held, bank: toBankEntry(ev, { now }) });
    if (held) out.held++;
    await step('drill', `#${ev.id}`, true, `[${c.lane}] ${held ? 'held — call intelligence not posted yet' : [ev.klass, ev.sentiment ? `sentiment ${ev.sentiment}` : null, ev.actionItem ? 'open commitment' : null].filter(Boolean).join(' · ')}`);
  }
  out.drilled = evidences.length;
  // FL-10e — same-customer clustering across THIS RUN ∪ the EVIDENCE BANK (prior fires' compact facts): pairs no
  // longer need to be drilled in the same fire to meet, and an already-solved twin (drilled while open, since
  // resolved) surfaces as "already handled". Advice only for clusters touching a FRESH member — bank-only
  // clusters were advised when their members were fresh.
  const freshIds = new Set(evidences.map((e) => e.id));
  const bankEvs = Object.entries(seen)
    .filter(([id, sn]) => sn && sn.b && !freshIds.has(String(id)))
    .map(([id, sn]) => bankEvidence(id, sn.b, { now }));
  const pool = [...evidences, ...bankEvs];
  const byId = new Map(pool.map((e) => [e.id, e]));
  const clusters = clusterTickets(pool).filter((cl) => cl.ids.some((id) => freshIds.has(id)));
  const advices = clusters.map((cl) => mergeAdvice(cl, byId, { me })).filter(Boolean).map((a, i) => ({ ...a, ids: clusters[i].ids }));
  const bankLines = [];
  for (const a of advices) for (const id of a.ids) {
    const at = out.attach.get(id);
    if (at) { at.matched = a.matchedBy.join('+'); at.crossAgent = a.crossAgent; }
    const b = !freshIds.has(id) && byId.get(id);
    if (b) bankLines.push(`#${id} (from a prior sweep) "${b.subject}" — ${b.klass} · status-at-last-read ${b.status || 'n/a'} · ${b.assigneeId == null ? 'unassigned' : (me != null && String(b.assigneeId) === String(me) ? 'assigned to me' : 'ANOTHER AGENT’S')}`);
  }
  // FL-10e — REQUESTER-HISTORY reads (the MVP checklist's get_user_tickets): for ≤2 fresh identity-bearing
  // tickets with no cluster hit, search the extracted email — surfaces prior/related tickets the list reads
  // can't see (incl. solved twins). ids+status only ride the evidence; never bodies.
  const histLines = [];
  const searchLeg = legs.find((l) => l && l.mode === 'ask' && l.tool && l.tool.recipeId === 'search_tickets');
  if (searchLeg) {
    const clustered = new Set(advices.flatMap((a) => a.ids));
    const wantHist = evidences.filter((e) => !clustered.has(e.id) && e.identity.emails.length && (e.klass !== 'other' || e.identity.refs.length)).slice(0, 2);
    for (const e of wantHist) {
      const run = await _runReadLeg(invokeSgHandler, searchLeg, { query: e.identity.emails[0] });
      if (!run.ok) { await step('drill', `history #${e.id}`, false, run.error || 'search failed'); continue; }
      const hits = listRows(run.value).filter((r) => r && r.id != null && String(r.id) !== e.id).slice(0, 5);
      if (hits.length) histLines.push(`HISTORY for #${e.id}'s customer (email search): ${hits.map((r) => `#${r.id} (${String(r.status || '?')}${r.assignee_id != null ? ', assigned' : ''})`).join(', ')} — check for an already-handled or mergeable thread`);
      await step('drill', `history #${e.id}`, true, `${hits.length} prior ticket(s)`);
    }
  }
  out.evidence = [...renderTicketEvidence(evidences, advices, { verdicts: out.verdicts, me }), ...bankLines, ...histLines].join('\n');
  try { await chrome.storage.local.set({ [_SEEN_KEY(instanceId)]: updateSeen(seen, seenUpdates, { now }) }); } catch { /* */ }
  if (evidences.length || out.held) await step('drill', 'evidence', true, `${evidences.length} drilled — ${cands.filter((c) => c.lane === 'mine').length} mine / ${cands.filter((c) => c.lane === 'merge').length} merge / ${cands.filter((c) => c.lane === 'stub').length} stub / ${cands.filter((c) => c.lane === 'held').length} held-recheck · ${clusters.length} same-customer cluster(s) (bank ${bankEvs.length})${me == null ? ' — my agent id underivable: nothing auto-executes on evidence' : ''}`);
  return out;
}

// FL-8b (v2.74.1358) — execute ONE minted proposal UNATTENDED (the autonomy policy said 'auto'). The panel's
// _approveProposal ported headless, step for step: same staleness CAS (re-read the grounding anchor, refuse a
// moved item), same fail-closed dispatch — `confirmed:true` here is the POLICY's standing approval (the user's
// standing directive in config), not a skipped gate — and the same decision/execution ledger trail, under the run.
async function _executeHeadless(instanceId, p, { invokeSgHandler, runId }) {
  if (p.basedOn && p.readLeg) {
    const chk = await _runReadLeg(invokeSgHandler, p.readLeg, p.readParams || {});
    if (chk.ok) {
      const cur = getPath(chk.value, p.basedOn.path);
      if (cur !== undefined && String(cur) !== String(p.basedOn.value)) {
        await decideProposal(instanceId, p.id, { status: 'stale' });
        await appendLedger(instanceId, ledgerEntry('decision', { status: 'stale', action: p.name, targets: p.targets, proposalId: p.id, runId, reason: 'item moved since the sweep read it' }));
        return { status: 'stale' };
      }
    }
  }
  await decideProposal(instanceId, p.id, { status: 'approved' });
  await appendLedger(instanceId, ledgerEntry('decision', { status: 'approved', action: p.name, targets: p.targets, proposalId: p.id, urls: p.urls, runId, reason: 'auto (autonomy policy)' }));
  const plan = planExec(p.leg, p.params, {});
  let res = null;
  if (!plan || !plan.ok || !plan.channel) res = { success: false, error: (plan && plan.reason) || 'no executor' };
  else { try { res = await invokeSgHandler(plan.channel, { ...plan.payload, confirmed: true, headless: true }); } catch (e) { res = { success: false, error: (e && e.message) || 'failed' }; } }   // H-1a — no reauth-focus from the clock
  const ok = !!(res && res.success !== false);
  await decideProposal(instanceId, p.id, { status: ok ? 'executed' : 'failed', reason: ok ? '' : ((res && res.error) || 'failed') });
  await appendLedger(instanceId, ledgerEntry('execution', { action: p.name, targets: p.targets, proposalId: p.id, ok, error: ok ? '' : ((res && res.error) || 'failed'), urls: p.urls, runId }));
  return { status: ok ? 'executed' : 'failed' };
}

// FL-6e (v2.74.1367; ROLLING since v1382) — one persisted note per kind, never throws. Eventful runs keep
// per-run ids (append, permanent). RECURRING kinds ('sweep_status' / 'sweep_idle') ROLL: the prior bubble is
// removed and a fresh one appends at the TAIL — the upsert pattern pinned them at their first-created position,
// so the freshest report sat buried mid-thread while the user watched the bottom ("sweep runs, nothing happens").
async function _note(convId, id, body) {
  try {
    if (id === 'sweep_status' || id === 'sweep_idle') await ConversationStore.rollMessage(convId, id, { role: 'assistant', body });
    else await ConversationStore.updateMessage(convId, id, { role: 'assistant', body }, { upsert: true });
  } catch { /* */ }
}
const _hhmm = () => { try { return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

const _RUN_KEY = (instanceId) => `fleetRun:${instanceId}`;   // H-1b — the in-flight run marker (instance-keyed)

/** The headless sweep — the clock-fired twin of chat.js `_runFleetSweep`. Never throws. */
export async function runHeadlessSweep(instanceId, { invokeSgHandler } = {}) {
  const sched = await _readSchedule(instanceId);
  if (!sched || !sched.convId) return;
  // H-1b (v1376) — the DEAD-RUN marker: a mid-flight SW/browser death runs no catch, so the run vanishes without
  // a trace. Every run stamps a marker and clears it on exit; the NEXT fire judges any leftover — fresh means a
  // run is still in flight (skip: no concurrent double-runs), stale means the previous run died (say so, proceed).
  let prior = null;
  try { const got = await chrome.storage.local.get(_RUN_KEY(instanceId)); prior = got[_RUN_KEY(instanceId)] || null; } catch { /* */ }
  const verdict = priorRunVerdict(prior);
  if (verdict.inFlight) { try { Logger.info('route', `SWEEP ▸ clock ${instanceId.slice(0, 12)} → skipped (a run is already in flight)`); } catch { /* */ } return; }
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  try { await chrome.storage.local.set({ [_RUN_KEY(instanceId)]: { runId, startedAt: Date.now() } }); } catch { /* */ }
  const _step = (phase, action, ok, note) => appendLedger(instanceId, ledgerEntry('step', { runId, phase, action, ok, note }));
  // FL-6e — a scheduled run must NEVER be chat-invisible (the first live clock test: "timer resets but nothing
  // prints" — a failed run and a quiet run both looked like a run that never happened). Every early exit says why.
  const _fail = (why) => _note(sched.convId, 'sweep_status', `Scheduled sweep at ${_hhmm()} couldn't complete — ${why}. Details: \`show work\`.`);
  try {
    if (verdict.died) {
      const when = (() => { try { return new Date(prior.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return 'earlier'; } })();
      await _step('plan', 'clock', false, `previous run (${when}) died mid-flight — browser or extension shutdown`);
      await _note(sched.convId, 'sweep_status', `The scheduled run at ${when} didn't finish (browser or extension shut down mid-run). This run continues normally.`);
    }
    const conv = await ConversationStore.load(sched.convId);
    if (!conv) {
      // The app conversation is gone — the schedule is orphaned; self-clear instead of firing forever.
      await _step('plan', 'clock', false, 'conversation gone — schedule cleared');
      try { await chrome.alarms.clear(sweepAlarmName(instanceId)); } catch { /* */ }
      try { await chrome.storage.local.remove(_SCHED_KEY(instanceId)); } catch { /* */ }
      return;
    }
    const connections = (conv.config && Array.isArray(conv.config.connections)) ? conv.config.connections : [];
    if (!connections.length) { await _step('plan', 'clock', false, 'no connections'); await _fail('this app has no connections (run setup)'); return; }
    await _step('plan', 'clock', true, `scheduled sweep (every ${describeEvery(sched.minutes)})`);
    const base = { connections, appId: conv.appId || null, memoryId: instanceId, seed: conv.seed || '' };
    // FL-8b/8c — the app's autonomy policy + daily caps: instance config first, else its preset's defaults
    // (read-through, so instances created before v1358 inherit the type's policy without migration).
    const cfg = (conv.config && typeof conv.config === 'object') ? conv.config : {};
    const preset = conv.appId ? builtinApp(conv.appId) : null;
    // FL-10e — an EMPTY instance map must not shadow the preset (an `autonomy: {}` written by any older setup
    // path silently gated EVERYTHING — the recurring "auto-class proposals parked" anomaly). Non-empty instance
    // config wins; empty/absent falls through to the preset's defaults.
    const _keys = (o) => (o && typeof o === 'object' && !Array.isArray(o)) ? Object.keys(o).length : 0;
    const autonomy = (_keys(cfg.autonomy) ? cfg.autonomy : (preset && preset.defaultConfig && preset.defaultConfig.autonomy)) || {};
    const dailyCaps = (_keys(cfg.dailyCaps) ? cfg.dailyCaps : (preset && preset.defaultConfig && preset.defaultConfig.dailyCaps)) || {};
    // …and SAY which policy is in force — the parked-instead-of-executed anomaly was undiagnosable because the
    // resolved policy was invisible. One ledger step makes the next occurrence readable from `show work`.
    const _autoClasses = Object.entries(autonomy).filter(([, v]) => v === 'auto').map(([k]) => k);
    await _step('plan', 'autonomy', true, `${_keys(cfg.autonomy) ? 'instance' : (preset ? 'preset' : 'NONE (no appId — preset defaults unreachable)')} policy — auto: ${_autoClasses.join(', ') || 'none'}`);

    const r1 = await invokeSgHandler('SWEEP_PROPOSE', { ...base, phase: 'reads' });
    if (!r1 || r1.success === false) { const e = (r1 && r1.error) || 'no reply'; await _step('plan', 'reads', false, e); await _fail(`planning the reads failed (${e})`); return; }
    const reads = Array.isArray(r1.reads) ? r1.reads : [];
    const legs = Array.isArray(r1.legs) ? r1.legs : [];
    await _step('plan', 'reads', true, reads.length ? reads.map((rd) => (legs.find((l) => l && l.key === rd.key)?.name) || rd.key).join(' · ') : 'none picked');

    const results = [];
    const rawByKey = new Map();   // FL-10b — pre-minimization values for the drill's triage (transient, this run only)
    for (const rd of reads) {
      const leg = legs.find((l) => l && l.key === rd.key);
      if (!leg) continue;
      const run = await _runReadLeg(invokeSgHandler, leg, rd.params);
      if (run.ok) rawByKey.set(rd.key, run.value);
      const mv = run.ok ? minimizeReadValue(run.value) : { error: run.error || 'read failed' };
      results.push({ key: rd.key, params: rd.params || {}, value: mv, leg });
      let _size = ''; try { _size = run.ok ? `${mv && mv.count != null ? `${mv.shown}/${mv.count} items, ` : ''}~${JSON.stringify(mv).length} chars` : ''; } catch { /* */ }
      await _step('read', leg.name || rd.key, run.ok !== false, run.ok ? _size : (run.error || 'read failed'));
    }
    // v1375 — deterministic DIGEST coverage: run every param-free PULSE read the model didn't pick (plain API
    // GETs, no LLM cost) so the queue-state breakdown is complete on every fire, not only when phase-A happened
    // to choose those reads. Kept OUT of the propose results (they'd crowd the handler's results belt + the
    // evidence-needs headroom) — digest-only.
    const pulseResults = [];
    const _readKeys = new Set(results.map((x) => x.key));
    for (const leg of legs) {
      const pl = leg && leg.tool && leg.tool.pulse;
      if (!pl || _readKeys.has(leg.key)) continue;
      if (Array.isArray(leg.params) && leg.params.length) continue;   // param-free only — nothing to bind headless
      const run = await _runReadLeg(invokeSgHandler, leg, {});
      if (run.ok) { rawByKey.set(leg.key, run.value); pulseResults.push({ key: leg.key, params: {}, value: minimizeReadValue(run.value), leg }); await _step('read', leg.name || leg.key, true, 'digest pulse'); }
      else await _step('read', leg.name || leg.key, false, run.error || 'read failed');
    }

    if ((!results.length || results.every((x) => x.value && x.value.error)) && !pulseResults.length) {
      await _step('propose', 'round 1', false, 'no readable queue (signed out / site unreachable?) — skipped');
      await _fail('the queue wasn’t readable (signed out or the site is unreachable?)');
      return;
    }

    // FL-10b — the evidence drill: triage → per-ticket thread reads → deterministic facts/verdicts/clusters.
    // Best-effort: a drill failure degrades to the pre-FL-10 list-level sweep, never kills the run.
    let drill = { evidence: '', verdicts: new Map(), attach: new Map(), drilled: 0, held: 0 };
    try { drill = await _runDrill({ instanceId, legs, allReads: [...results, ...pulseResults], rawByKey, cfg, invokeSgHandler, step: _step }); }
    catch (e) { await _step('drill', 'evidence', false, (e && e.message) || 'drill failed'); }

    // FL-8c — operational counters into the propose prompt (fenced data): quota state + the volume baseline.
    // Derived from the queue + the schedule record — the model proposes within the remainder; the executor
    // enforces the cap again regardless (defense in depth).
    const allPrior = await loadProposals(instanceId);
    const executedToday = executedTodayByRecipe(allPrior);
    const ctxLines = [];
    for (const [rid, cap] of Object.entries(dailyCaps)) {
      const used = executedToday[rid] || 0;
      ctxLines.push(`quota ${rid}: ${used}/${cap} executed today — ${Math.max(0, Number(cap) - used)} remaining (propose at most the remainder)`);
    }
    const _extraToday = Object.entries(executedToday).filter(([rid]) => dailyCaps[rid] == null).map(([r, n]) => `${r}×${n}`);
    if (_extraToday.length) ctxLines.push(`also executed today: ${_extraToday.join(', ')}`);
    if (Array.isArray(sched.dailyCounts) && sched.dailyCounts.length) ctxLines.push(`new tickets per day (history): ${sched.dailyCounts.map((e) => `${e.day}: ${e.count}`).join(' · ')}`);
    const _rejCtx = rejectionContext(allPrior);   // FL-9 — the model SEES what the user recently declined, and why
    if (_rejCtx) ctxLines.push(_rejCtx);
    const context = ctxLines.join('\n');

    let proposals = []; let summary = '';
    for (let round = 1; round <= 2; round++) {
      const r = await invokeSgHandler('SWEEP_PROPOSE', { ...base, phase: 'propose', round, context, evidence: drill.evidence, results: results.map((x) => ({ key: x.key, params: x.params, value: x.value })) });
      if (!r || r.success === false) { const e = (r && r.error) || 'no reply'; await _step('propose', `round ${round}`, false, e); await _fail(`the propose step failed (${e})`); return; }
      proposals = Array.isArray(r.proposals) ? r.proposals : [];
      summary = r.summary || '';
      const needs = (round === 1 && Array.isArray(r.needs)) ? r.needs : [];
      await _step('propose', `round ${round}`, true, `${proposals.length} proposal(s)${needs.length ? `, ${needs.length} evidence need(s)` : ''}${summary ? ` — ${summary}` : ''}`);
      if (!needs.length) break;
      for (const nd of needs) {
        const leg = legs.find((l) => l && l.key === nd.key);
        if (!leg) { await _step('need', nd.key, false, 'not among the offered reads'); continue; }
        const run = await _runReadLeg(invokeSgHandler, leg, nd.params);
        results.push({ key: nd.key, params: nd.params || {}, value: run.ok ? minimizeReadValue(run.value) : { error: run.error || 'read failed' }, leg });
        await _step('need', leg.name || nd.key, run.ok !== false, run.ok ? (nd.params && Object.keys(nd.params).length ? JSON.stringify(nd.params) : '') : (run.error || 'read failed'));
      }
    }

    for (const p of proposals) {
      if (p.basedOn && p.basedOn.readKey) {
        const src = results.find((x) => x.key === p.basedOn.readKey);
        if (src) { p.readLeg = src.leg; p.readParams = src.params; }
      }
      p.urls = targetUrls(p);
      // FL-10c — ride the drill's code-derived facts on the proposal (approval cards render them: sentiment,
      // commitment, same-customer match keys, cross-agent). Enums/key-names only — never thread content.
      const _tid = String((Array.isArray(p.targets) && p.targets[0]) || '').replace(/\D/g, '');
      if (_tid && drill.attach.has(_tid)) p.drill = drill.attach.get(_tid);
    }
    // FL-9 — rejections STICK: never re-mint an (action, targets) pair the user rejected in the last 24h,
    // unless the grounding anchor moved (the item changed). Belt to the prompt context's suspenders.
    const rr = filterRejectedRepeats(proposals, allPrior);
    if (rr.suppressed.length) await _step('propose', 'rejected-repeat', true, `suppressed ${rr.suppressed.length} re-proposal(s) of user-rejected action(s)`);
    proposals = rr.kept;
    // v1381 — pendings SURVIVE sweeps: stale only same-pair replacements + 24h-unreviewed expiries (the 5-minute
    // clock was expiring proposals faster than the human could review them — "1 pending" → "Nothing pending").
    const plan = supersedePlan(allPrior, proposals);
    for (const s of plan.stale) await decideProposal(instanceId, s.id, { status: 'stale', reason: s.reason });
    if (plan.stale.length) await appendLedger(instanceId, ledgerEntry('decision', { status: 'stale', reason: `superseded ${plan.stale.length} pending proposal${plan.stale.length === 1 ? '' : 's'} (replaced / expired)`, runId }));
    const surviving = plan.kept.length;
    const minted = await addProposals(instanceId, proposals);
    await appendLedger(instanceId, ledgerEntry('sweep', { counts: { reads: results.length, proposals: minted.length }, runId }));
    for (const p of minted) await appendLedger(instanceId, ledgerEntry('proposal', { action: p.name, targets: p.targets, why: p.why, proposalId: p.id, urls: p.urls, runId }));

    // FL-8b — the UNATTENDED half: execute the policy-auto'd classes now; gated/capped classes park for the human.
    // Order: as minted (the model's own priority). The cap re-checks per execution — defense in depth vs the prompt.
    const ranByRecipe = {};
    let executed = 0, failed = 0, staleN = 0, capped = 0, egated = 0;
    for (const p of minted) {
      if (autonomyFor({ autonomy }, p) !== 'auto') continue;
      const rid = (p.leg && p.leg.tool && p.leg.tool.recipeId) || '';
      // FL-10c — the EVIDENCE GATE: a recipe marked `autoRequires:'evidence'` executes unattended only with a
      // same-run CODE-verified verdict for its target (solved needs autoSolve/autoClose — POSITIVE + no
      // commitment + mine, or an aged empty stub). The model's say-so is never enough; undrilled targets park.
      // A human approving from the card is untouched by this.
      if (p.leg && p.leg.tool && p.leg.tool.autoRequires === 'evidence') {
        const tid = String((Array.isArray(p.targets) && p.targets[0]) || '').replace(/\D/g, '');
        const v = tid ? drill.verdicts.get(tid) : null;
        const want = String((p.params && p.params.status) || '').toLowerCase();
        const proven = !!v && (want === 'solved' ? (v.autoSolve || v.autoClose) : false);
        if (!proven) {
          egated++;
          await _step('execute', p.name, true, `parked for review (evidence gate — ${v ? (v.missing && v.missing.length ? v.missing.join('; ') : 'not auto-grade') : 'target not drilled this run'})`);
          continue;
        }
      }
      const cap = rid && dailyCaps[rid] != null ? Number(dailyCaps[rid]) : null;
      if (cap != null && ((executedToday[rid] || 0) + (ranByRecipe[rid] || 0)) >= cap) {
        capped++;
        await _step('execute', p.name, true, `daily cap ${cap} reached — parked for review`);
        continue;
      }
      const r = await _executeHeadless(instanceId, p, { invokeSgHandler, runId });
      if (r.status === 'executed') { executed++; if (rid) ranByRecipe[rid] = (ranByRecipe[rid] || 0) + 1; }
      else if (r.status === 'failed') failed++;
      else staleN++;
      await _step('execute', p.name, r.status === 'executed', r.status === 'executed' ? '' : r.status);
    }
    // v1381 — visibility for "why didn't it run on its own?": when everything minted parked, say so in the trail.
    if (minted.length && !executed && !failed && !staleN && !capped && !egated) {
      await _step('execute', 'policy', true, `all ${minted.length} parked for review (no auto-class match — see config.autonomy)`);
    }
    try { Logger.info('route', `SWEEP ▸ clock ${instanceId.slice(0, 12)} → ${minted.length} proposal(s) from ${results.length} read(s); auto-executed ${executed}${failed ? `, ${failed} failed` : ''}${capped ? `, ${capped} capped` : ''}`); } catch { /* */ }

    // FL-8d — digest + spike, keyed by the reads' PULSE semantics (recipe data, v1359; object form v1375) —
    // never a recipe id: this harness must stay app-blind (the portability test; the v1358 first cut named three
    // Zendesk ids here — that was the bug). Digest counts come from BOTH the model-picked reads and the
    // deterministic pulse reads.
    const allReads = [...results, ...pulseResults];
    const _countFor = (cls) => { const e = allReads.find((x) => x.leg && x.leg.tool && x.leg.tool.pulse && x.leg.tool.pulse.kind === cls); const v = e && e.value; return (v && typeof v.count === 'number') ? v.count : null; };
    const day = localDay();
    const newN = _countFor('inflow');
    let spike = { spike: false, baseline: null, ratio: null };
    const schedNow = await _readSchedule(instanceId);   // re-read — never resurrect a schedule turned off mid-run
    const firstOfDay = !!schedNow && schedNow.lastDigestDay !== day;
    if (schedNow) {
      if (newN != null) { spike = spikeVerdict(schedNow.dailyCounts, day, newN); schedNow.dailyCounts = rollDailyCounts(schedNow.dailyCounts, day, newN); }
      if (firstOfDay) schedNow.lastDigestDay = day;
      if (newN != null || firstOfDay) { try { await chrome.storage.local.set({ [_SCHED_KEY(instanceId)]: schedNow }); } catch { /* */ } }
    }

    // FL-6e (v1367) — EVERY scheduled run reports to chat. Eventful runs (minted / executed / first-of-day
    // digest) get their own per-run note; a QUIET run upserts ONE 'sweep_idle' bubble in place (stamped with the
    // time), so results are always visible without hourly spam.
    const pendingLeft = surviving + minted.length - executed - failed - staleN;   // v1381 — survivors count too
    const lines = [];
    // v1375 — the queue-state breakdown ("You: 4 open · 3 pending / Team: 32 open · 3 unassigned"), assembled by
    // CODE from the reads' own API counts + their pulse {scope, status} data. Inflow keeps its baseline tail.
    const qLines = queueStateLines(allReads);
    if (newN != null) qLines.push(`${newN} new in 24h${spike.baseline != null ? ` (~${spike.baseline}/day baseline)` : ''}`);
    if (qLines.length) lines.push(qLines.join('\n'));
    if (spike.spike) lines.push(`New-ticket volume spike — ${newN} in 24h vs ~${spike.baseline}/day${spike.ratio ? ` (${spike.ratio}×)` : ''}. See the sweep summary / \`show work\` for the cluster.`);
    if (executed || failed || staleN) lines.push(`Ran ${executed} action${executed === 1 ? '' : 's'} unattended (policy)${failed ? `, ${failed} failed` : ''}${staleN ? `, ${staleN} skipped as stale` : ''} — \`ledger\` has the trail.`);
    if (capped) lines.push(`${capped} held at the daily cap.`);
    if (egated) lines.push(`${egated} parked for your review (no code-verified evidence this run).`);
    if (drill.held) lines.push(`${drill.held} fresh call record${drill.held === 1 ? '' : 's'} held — call intelligence not posted yet (re-checked next sweep).`);
    // FL-10e — the parked-anomaly, IN THE NOTE: when the policy auto-matched nothing at all, say so where the
    // user reads (the ledger step alone left them staring at parked auto-class proposals with no explanation).
    if (minted.length && !executed && !failed && !staleN && !capped && !egated) lines.push(`All ${minted.length} parked — the autonomy policy matched none of them (\`show work\` has the resolved policy).`);
    if (pendingLeft > 0) lines.push(`**${pendingLeft} proposal${pendingLeft === 1 ? '' : 's'} pending** — say \`pending\` to review.`);
    if (summary) lines.push(summary.replace(/\.+$/, '') + '.');
    if (minted.length || executed || firstOfDay) {
      await _note(sched.convId, `sweep_${runId}`, `Scheduled sweep at ${_hhmm()}:\n\n${lines.join('\n\n')}`);
    } else {
      await _note(sched.convId, 'sweep_idle', `Scheduled sweep at ${_hhmm()} — nothing to act on.${lines.length ? `\n\n${lines.join('\n\n')}` : ''}`);
    }
  } catch (e) {
    // v1379 — the LAST chat-silent branch (FL-6e covered every early exit but not an unexpected throw): an
    // exception mid-run now reports to the thread like every other failure, not just the ledger.
    try { await _step('propose', 'run', false, (e && e.message) || 'headless sweep failed'); } catch { /* */ }
    try { await _fail(`it hit an unexpected error (${(e && e.message) || 'unknown'})`); } catch { /* */ }
  } finally {
    // H-1b — clear OUR marker only (an overlapping newer run owns its own); a crash before this line is exactly
    // what the next fire's dead-run verdict reports.
    try { const got = await chrome.storage.local.get(_RUN_KEY(instanceId)); if (got[_RUN_KEY(instanceId)] && got[_RUN_KEY(instanceId)].runId === runId) await chrome.storage.local.remove(_RUN_KEY(instanceId)); } catch { /* */ }
  }
}

/**
 * The FLEET_SCHEDULE handler (set / off / status) + the alarm listener registration.
 * @param {{ invokeSgHandler: (type:string, payload:object)=>Promise<object> }} deps
 */
export function createFleetHandlers({ invokeSgHandler } = {}) {
  return {
    'FLEET_SCHEDULE': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const instanceId = String((payload && payload.instanceId) || '');
          if (!instanceId) { sendResponse({ success: false, error: 'no-instance' }); return; }
          if (payload.off === true) {
            // FL-6b — `ifSource: 'seed'` clears only a schedule that source armed (a seed losing its cadence must
            // never cancel a hand-set `sweep every`); a bare off (the command/leg) clears unconditionally.
            const ifSource = payload.ifSource ? String(payload.ifSource) : null;
            if (ifSource) {
              const sched = await _readSchedule(instanceId);
              if (!sched || (sched.source || 'command') !== ifSource) { sendResponse({ success: true, off: false, kept: true }); return; }
            }
            try { await chrome.alarms.clear(sweepAlarmName(instanceId)); } catch { /* */ }
            try { await chrome.storage.local.remove(_SCHED_KEY(instanceId)); } catch { /* */ }
            try { Logger.info('route', `SWEEP ▸ schedule ${instanceId.slice(0, 12)} → OFF${ifSource ? ` (${ifSource}-owned)` : ''}`); } catch { /* */ }
            sendResponse({ success: true, off: true });
            return;
          }
          const minutes = Number(payload.minutes);
          if (!Number.isFinite(minutes) || minutes < 1) {
            const sched = await _readSchedule(instanceId);   // status read
            let nextAt = null;   // FL-6d (v1361) — the alarm's own scheduledTime is the countdown's ground truth
            if (sched) { try { const a = await chrome.alarms.get(sweepAlarmName(instanceId)); nextAt = (a && a.scheduledTime) || null; } catch { /* */ } }
            sendResponse({ success: true, schedule: sched ? { minutes: sched.minutes, every: describeEvery(sched.minutes), source: sched.source || 'command', nextAt } : null });
            return;
          }
          const convId = String((payload && payload.convId) || '');
          if (!convId) { sendResponse({ success: false, error: 'no-conversation' }); return; }
          const source = payload.source === 'seed' ? 'seed' : 'command';   // FL-6b — provenance; never model-supplied
          const prior = await _readSchedule(instanceId);
          const changed = !(prior && prior.minutes === minutes && (prior.source || 'command') === source && prior.convId === convId);
          // bcp v1370 review — a re-schedule must PRESERVE the accrued digest state (dailyCounts baseline +
          // lastDigestDay): every seed re-save re-applies the cadence, and wiping here meant the spike baseline
          // could never reach its 2-day minimum.
          await chrome.storage.local.set({ [_SCHED_KEY(instanceId)]: {
            minutes, convId, createdAt: Date.now(), source,
            ...(prior && Array.isArray(prior.dailyCounts) ? { dailyCounts: prior.dailyCounts } : {}),
            ...(prior && prior.lastDigestDay ? { lastDigestDay: prior.lastDigestDay } : {}),
          } });
          await chrome.alarms.create(sweepAlarmName(instanceId), { periodInMinutes: minutes, delayInMinutes: minutes });
          try { Logger.info('route', `SWEEP ▸ schedule ${instanceId.slice(0, 12)} → every ${describeEvery(minutes)} (${source})`); } catch { /* */ }
          sendResponse({ success: true, minutes, every: describeEvery(minutes), source, changed });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'schedule-failed' }); }
      })();
      return true;
    },

    // DK-8 (v2.74.1491) — the desk ROUTINE: a DECLARED recurring ask, stored as a first-class record (the seed
    // declares it, only the USER arms it — HITL at declaration; enabling creates the alarm). v1 fire model: the
    // alarm marks the record DUE; the panel runs the ask when the desk next opens (the ask needs the panel
    // pipeline — each fan-out, sub-task creation). One routine per desk (v1 — deliberate).
    'FLEET_ROUTINE': (payload, _sender, sendResponse) => {
      (async () => {
        try {
          const instanceId = String((payload && payload.instanceId) || '');
          if (!instanceId) { sendResponse({ success: false, error: 'no-instance' }); return; }
          const key = _ROUT_KEY(instanceId);
          const read = async () => (await chrome.storage.local.get(key))[key] || null;
          if (payload.off === true) {
            const ifSource = payload.ifSource ? String(payload.ifSource) : null;   // seed-owned clear mirrors FLEET_SCHEDULE
            if (ifSource) { const cur = await read(); if (!cur || (cur.source || 'command') !== ifSource) { sendResponse({ success: true, off: false, kept: true }); return; } }
            try { await chrome.alarms.clear(routineAlarmName(instanceId)); } catch { /* */ }
            try { await chrome.storage.local.remove(key); } catch { /* */ }
            try { Logger.info('route', `ROUTINE ▸ ${instanceId.slice(0, 12)} → OFF${ifSource ? ` (${ifSource}-owned)` : ''}`); } catch { /* */ }
            sendResponse({ success: true, off: true }); return;
          }
          if (payload.set && typeof payload.set === 'object') {
            const minutes = Number(payload.set.minutes);
            const ask = String(payload.set.ask || '').trim().slice(0, 200);
            if (!Number.isFinite(minutes) || minutes < 1 || !ask) { sendResponse({ success: false, error: 'bad-routine' }); return; }
            const source = payload.set.source === 'seed' ? 'seed' : 'command';
            const prior = await read();
            const changed = !(prior && prior.minutes === minutes && prior.ask === ask);
            // enabled NEVER auto-flips on a re-declare — the user's arm/disarm survives seed edits.
            const rec = { minutes, ask, source, enabled: !!(prior && prior.enabled), declaredAt: (prior && prior.declaredAt) || Date.now(), due: !!(prior && prior.due), lastFiredAt: (prior && prior.lastFiredAt) || null, convId: String((payload && payload.convId) || (prior && prior.convId) || '') };
            await chrome.storage.local.set({ [key]: rec });
            if (rec.enabled) { try { await chrome.alarms.create(routineAlarmName(instanceId), { periodInMinutes: minutes, delayInMinutes: minutes }); } catch { /* */ } }
            try { Logger.info('route', `ROUTINE ▸ ${instanceId.slice(0, 12)} declared every ${describeEvery(minutes)} (${source}${rec.enabled ? ', armed' : ', OFF until enabled'}) — "${ask.slice(0, 50)}"`); } catch { /* */ }
            sendResponse({ success: true, changed, enabled: rec.enabled }); return;
          }
          if (payload.enable === true || payload.enable === false) {
            const cur = await read();
            if (!cur) { sendResponse({ success: false, error: 'no-routine' }); return; }
            cur.enabled = payload.enable === true;
            if (payload.convId) cur.convId = String(payload.convId);
            await chrome.storage.local.set({ [key]: cur });
            if (cur.enabled) { try { await chrome.alarms.create(routineAlarmName(instanceId), { periodInMinutes: cur.minutes, delayInMinutes: cur.minutes }); } catch { /* */ } }
            else { try { await chrome.alarms.clear(routineAlarmName(instanceId)); } catch { /* */ } }
            try { Logger.info('route', `ROUTINE ▸ ${instanceId.slice(0, 12)} → ${cur.enabled ? `ARMED every ${describeEvery(cur.minutes)}` : 'disabled'}`); } catch { /* */ }
            sendResponse({ success: true, enabled: cur.enabled }); return;
          }
          if (payload.fired === true) {   // the panel ran the ask — clear due + stamp
            const cur = await read();
            if (cur) { cur.due = false; cur.lastFiredAt = Date.now(); await chrome.storage.local.set({ [key]: cur }); }
            sendResponse({ success: true }); return;
          }
          const cur = await read();   // status
          let nextAt = null;
          if (cur && cur.enabled) { try { const a = await chrome.alarms.get(routineAlarmName(instanceId)); nextAt = (a && a.scheduledTime) || null; } catch { /* */ } }
          sendResponse({ success: true, routine: cur ? { ...cur, nextAt } : null });
        } catch (e) { sendResponse({ success: false, error: (e && e.message) || 'routine-failed' }); }
      })();
      return true;
    },
  };
}

/** Wire the alarm → headless sweep. chrome.alarms persist across SW restarts natively — no re-registration. */
export function registerFleetAlarmListener({ invokeSgHandler } = {}) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    const instanceId = instanceFromAlarmName(alarm && alarm.name);
    if (instanceId) {
      runHeadlessSweep(instanceId, { invokeSgHandler }).catch((e) => { try { Logger.warn('background', `fleet alarm: ${e?.message || e}`); } catch { /* */ } });
      return;
    }
    // DK-8 (v2.74.1491) — a ROUTINE alarm marks the record DUE; the panel fires the ask when the desk next opens
    // (v1 — the routine's ask needs the panel pipeline: each fan-out, sub-task creation. Headless execution owed).
    const routInst = instanceFromRoutineAlarm(alarm && alarm.name);
    if (!routInst) return;   // foreign alarm (orchard-sync etc.)
    (async () => {
      const key = _ROUT_KEY(routInst);
      const cur = (await chrome.storage.local.get(key))[key];
      if (!cur || !cur.enabled) return;   // disabled records never fire (a stale alarm self-noops)
      cur.due = true;
      await chrome.storage.local.set({ [key]: cur });
      try { Logger.info('route', `ROUTINE ▸ due ${routInst.slice(0, 12)} — "${String(cur.ask).slice(0, 50)}" (runs when the desk opens)`); } catch { /* */ }
    })().catch((e) => { try { Logger.warn('background', `routine alarm: ${e?.message || e}`); } catch { /* */ } });
  });
}
