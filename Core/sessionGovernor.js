// Core/sessionGovernor.js — SGV-0: the Session Governor's PURE planner (DESIGN_session_governor.md v1.14 §1-§4).
// PURE: no chrome / DOM / LLM / storage / clock — the snapshot carries `now`; the SW assembles it and (at SGV-0)
// only LOGS the plan (`SGV ▸` lines, the inert soak). The plan gains hands at SGV-1, gated on the soak's grade.
//
// Deliberately conservative at SGV-0: the mechanical ladder (§3) plans the CHEAP verbs (probe/warm/keepalive)
// and `focus` only when the focus gate is determinately open — `drive_assist`/`relink`/`escalate_secret` need
// machinery (drive table, broker signals, staging) that does not exist yet, so the planner never proposes them
// (a plan naming an unbuildable act would soak-grade the wrong thing).

const _str = (v) => (typeof v === 'string' ? v.trim() : (v == null ? '' : String(v).trim()));

export const SGV_LIMITS = Object.freeze({
  HEALS: 3, NUDGES: 1, CHAIN_RESUMES: 1, LLM_CALLS: 1, INTERRUPTS: 1,
  PREWARM_HORIZON_MS: 25 * 60000,   // §2 — due-within window that creates work demand
  ACTIVE_ASKS_CAP: 4,
});

const STATUSES = new Set(['fresh', 'stale', 'signed-out', 'wrong-account', 'unknown']);   // §2 — closed enum

/** §2 — the incident identity grammar (one problem = one id across heals/nudges/blocks/metrics). PURE. */
export function incidentIdFor(kind, { runId = '', askId = '', workflowId = '', origin = '', utcDay = '' } = {}) {
  if (kind === 'block') return `block:${_str(runId)}`;
  if (kind === 'ask') return `ask:${_str(askId)}`;
  if (kind === 'due') return `due:${_str(workflowId)}:${_str(origin)}`;
  return `scope:${_str(origin)}:${_str(utcDay)}`;
}

/**
 * The tick planner. PURE.
 * @param {{
 *   now:number,
 *   origins?: Object<string,{status?:string, csrfCold?:boolean, contested?:number, cooldownUntil?:number, kaOn?:boolean, kaDue?:boolean}>,
 *   blocked?: Array<{runId:string, workflowId?:string, origins?:string[], parkedAt?:number}>,
 *   activeAsks?: Array<{id:string, origins?:string[], at?:number}>,
 *   due?: Array<{workflowId:string, origins?:string[], nextDue?:number}>,
 *   userActiveOn?: boolean,
 *   budgets?: { probes?:number, keepalives?:number },
 * }} snapshot
 * @returns {{ heals:Array<{verb:string,origin:string,incidentId:string}>, dueNudges:Array, chainResumes:Array,
 *            llmCalls:Array, interrupts:Array, demands:number, planned:number, deferred:number,
 *            budgetExhausted:string[] }}
 */
export function planSessionGovernorTick(snapshot = {}) {
  const now = Number(snapshot.now) || 0;
  const origins = (snapshot.origins && typeof snapshot.origins === 'object') ? snapshot.origins : {};
  const blocked = Array.isArray(snapshot.blocked) ? snapshot.blocked.filter(Boolean) : [];
  const activeAsks = (Array.isArray(snapshot.activeAsks) ? snapshot.activeAsks.filter(Boolean) : []).slice(0, SGV_LIMITS.ACTIVE_ASKS_CAP);
  const due = Array.isArray(snapshot.due) ? snapshot.due.filter(Boolean) : [];
  const userActive = !!snapshot.userActiveOn;
  const budgets = (snapshot.budgets && typeof snapshot.budgets === 'object') ? snapshot.budgets : {};
  const utcDay = new Date(now).toISOString().slice(0, 10);

  // §2 — workDemands: blocked ∪ activeAsks ∪ due within the horizon. Each demand names its origins + incident.
  const demandByOrigin = new Map();   // origin → incidentId (FIRST demand wins — oldest-first ordering below)
  const noteDemand = (origin, incidentId) => {
    const o = _str(origin);
    if (o && !demandByOrigin.has(o)) demandByOrigin.set(o, incidentId);
  };
  for (const b of blocked.slice().sort((a, x) => (a.parkedAt || 0) - (x.parkedAt || 0))) {
    for (const o of (b.origins || [])) noteDemand(o, incidentIdFor('block', { runId: b.runId }));
  }
  for (const a of activeAsks) for (const o of (a.origins || [])) noteDemand(o, incidentIdFor('ask', { askId: a.id }));
  for (const d of due) {
    if (Number(d.nextDue) > 0 && Number(d.nextDue) - now <= SGV_LIMITS.PREWARM_HORIZON_MS) {
      for (const o of (d.origins || [])) noteDemand(o, incidentIdFor('due', { workflowId: d.workflowId, origin: o }));
    }
  }

  const heals = [];
  const budgetExhausted = [];
  let deferred = 0;

  // §3 mechanical ladder + §4 preconditions — one verb per origin, cheapest-first.
  for (const [origin, incidentId] of demandByOrigin) {
    if (heals.length >= SGV_LIMITS.HEALS) { deferred++; continue; }
    const st = origins[origin] || {};
    const status = STATUSES.has(_str(st.status)) ? _str(st.status) : 'unknown';
    if (Number(st.cooldownUntil) > now) { deferred++; continue; }                    // give_up cooldown holds
    if (Number(st.contested) >= 2 && status !== 'signed-out' && status !== 'wrong-account') { deferred++; continue; }   // §3 — flapping never heals past probe; indeterminate waits
    let verb = null;
    if (st.csrfCold) verb = 'warm';
    else if (status === 'signed-out' || status === 'wrong-account' || status === 'unknown') verb = 'probe';   // cheapest determinate signal first
    else if (status === 'stale' && (st.kaOn || st.kaDue)) verb = 'keepalive';
    // focus — ONLY through the R1 gate: determinate bad status AND the user idle everywhere AND probe already
    // tried (the ladder never skips a rung without a determinate signal). `watching` can never override this.
    // verify-fix MED (§3, latent) — a CONTESTED origin may never climb past probe/warm, determinate or not.
    if (verb === 'probe' && (status === 'signed-out' || status === 'wrong-account') && st.probedThisIncident && !userActive && !(Number(st.contested) >= 2)) verb = 'focus';
    if (verb === 'focus' && userActive) verb = 'probe';   // structural belt: focus while active is a spec violation, not a choice
    if (!verb) continue;                                   // fresh + no csrf/ka need → no heal (not deferred; nothing owed)
    if (verb === 'probe' && Number.isFinite(budgets.probes) && budgets.probes <= 0) { budgetExhausted.push(origin); continue; }
    if (verb === 'keepalive' && Number.isFinite(budgets.keepalives) && budgets.keepalives <= 0) { budgetExhausted.push(origin); continue; }
    heals.push({ verb, origin, incidentId });
  }

  // §5h — nudges/resumes (SGV-0: blocked is empty until Door A/B exist, but the ordering contract is testable).
  const dueNudges = blocked
    .filter((b) => b.runId && b.workflowId)
    .sort((a, x) => (a.parkedAt || 0) - (x.parkedAt || 0))
    .slice(0, SGV_LIMITS.NUDGES)
    .map((b) => ({ blockedRunId: b.runId, workflowId: b.workflowId }));

  return {
    heals, dueNudges, chainResumes: [], llmCalls: [], interrupts: [],
    demands: demandByOrigin.size,
    planned: heals.length + dueNudges.length,
    deferred,
    budgetExhausted,
    utcDay,
  };
}
