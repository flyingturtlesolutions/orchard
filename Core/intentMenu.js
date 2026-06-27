// Core/intentMenu.js — IM-1 (v2.74.895): the INTENT MENU — "what can I do here?" answered from the
// substrate, not the user's prior knowledge. PURE. Composes the three readiness tiers into one ranked,
// badged list:
//   run-now   — a taught capability (active, non-orphan; the handler pre-filters) → clicking replays it
//   teachable — a Locale/site-catalog GOAL no capability covers yet (GA-7 authoringCoverage) → clicking
//               sends the goal label as an ask, which lands in the EXISTING teach/trial path
//   explore-first — nothing known (cold ground) → the page must be Explored before intents exist
// ZERO LLM: goals come from Explore (the exploration planner + deriveDisclosureGoals), prevalence from
// the siteMap capability catalog, the taught/teachable split from authoringCoverage. The menu is the PULL
// twin of the Act tier's sanctioned `suggest` class (DESIGN_substrate_constrains_agent_hardened §suggest).

import { authoringCoverage } from './select.js';
import { normalizeGoalLabel } from './siteMap.js';

/**
 * Ride-recipe entries for the menu — the §18 RIDE class (the app's own API, harvested/curated). PURE. ARMABLE recipes
 * (accepted ∧ enabled) become `run-now` (clicking invokes them); merely PENDING ones become one `needs-accept` summary
 * (clicking opens the Ride section to accept). Class-tagged `ride` so the surface can group Drive · Ride · Broker.
 */
function _rideEntries(ride, max) {
  const list = (Array.isArray(ride) ? ride : []).filter((r) => r && (r.name || r.id));
  const armable = list.filter((r) => r.enabled !== false && r.reviewState === 'accepted');
  const pending = list.filter((r) => r.reviewState === 'pending');
  const out = armable
    .map((r) => ({ kind: 'run-now', class: 'ride', label: String(r.name || r.id).trim(), ask: String(r.name || r.id).trim(), capabilityId: r.id || null, prevalence: 0, source: 'ride' }))
    .slice(0, Math.max(1, max));
  if (pending.length) {   // never enumerate dozens of pending recipes as chips — one summary that routes to review
    out.push({ kind: 'needs-accept', class: 'ride', label: `${pending.length} data action${pending.length === 1 ? '' : 's'} available — accept to enable`, ask: null, capabilityId: null, prevalence: 0, source: 'ride' });
  }
  return out;
}

/**
 * @param {object} [input]
 * @param {Array}  [input.caps]        the Ground's ACTIVE, non-orphan sgCapabilities (the DRIVE class)
 * @param {Array<{id?:string,label:string}>} [input.goals]  Locale goals (union across the Ground's pages)
 * @param {{capabilities?:Array<{goal:string,count:number}>}|null} [input.siteCatalog]  siteMapCapabilities(map)
 * @param {Array} [input.ride]   the Ground's ride-recipes (§18 RIDE class) — armable shown run-now, pending summarized
 * @param {Array} [input.broker] OAuth/MCP broker tools (§18 BROKER class) — empty until brokers exist; the agnostic seam
 * @param {string|null} [input.readiness]  G1-3 state (empty|preparing|capable|rich)
 * @param {number} [input.limit]
 * @returns {{entries:Array<{kind:string,class:string,label:string,ask:(string|null),capabilityId:(string|null),prevalence:number,source:string}>,
 *            readiness:(string|null), counts:{taught:number,teachable:number,goals:number,ride:number,broker:number}}}
 */
export function buildIntentMenu({ caps = [], goals = [], siteCatalog = null, ride = [], broker = [], readiness = null, limit = 5 } = {}) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 5;

  // ── run-now: taught capabilities, ranked by alias count (a usage proxy — confirmations accrete aliases)
  const seenLabels = new Set();
  const runNow = [];
  for (const c of (Array.isArray(caps) ? caps : [])) {
    if (!c) continue;
    const label = String(c.intent || c.name || '').replace(/\s+/g, ' ').trim();
    if (!label) continue;
    const k = label.toLowerCase();
    if (seenLabels.has(k)) continue;
    seenLabels.add(k);
    const aliases = Array.isArray(c.aliases) ? c.aliases.filter((a) => typeof a === 'string' && a.trim()) : [];
    runNow.push({
      kind: 'run-now', class: 'drive', label,
      ask: aliases[0] || label,                      // an accreted alias hits the deterministic warm path
      capabilityId: c.id || null,
      prevalence: aliases.length,
      source: 'capability',
    });
  }
  runNow.sort((a, b) => (b.prevalence - a.prevalence) || a.label.localeCompare(b.label));

  // ── goal pool: Locale goals ∪ site-catalog goals, deduped by normalized label; catalog carries prevalence
  const catalogByLabel = new Map();
  for (const sc of (siteCatalog && Array.isArray(siteCatalog.capabilities) ? siteCatalog.capabilities : [])) {
    if (!sc || !sc.goal) continue;
    const norm = normalizeGoalLabel(sc.goal);
    if (norm && !catalogByLabel.has(norm)) catalogByLabel.set(norm, { label: String(sc.goal).trim(), count: Number(sc.count) || 1 });
  }
  const pool = new Map();   // norm → {id,label}
  for (const g of (Array.isArray(goals) ? goals : [])) {
    if (!g || !g.label) continue;
    const label = String(g.label).replace(/\s+/g, ' ').trim();
    const norm = normalizeGoalLabel(label);
    if (!norm || pool.has(norm)) continue;
    pool.set(norm, { id: g.id != null ? String(g.id) : `goal:${norm}`, label });
  }
  for (const [norm, sc] of catalogByLabel) if (!pool.has(norm)) pool.set(norm, { id: `site:${norm}`, label: sc.label });

  // ── teachable: pool goals NO capability covers (GA-7), ranked by site prevalence then label
  const { unauthored } = authoringCoverage([...pool.values()], Array.isArray(caps) ? caps : []);
  const teachable = unauthored
    .filter((u) => u.label && !seenLabels.has(u.label.toLowerCase()))   // a goal lexically identical to a taught cap is already surfaced
    .map((u) => ({
      kind: 'teachable', class: 'drive', label: u.label, ask: u.label, capabilityId: null,
      prevalence: catalogByLabel.get(normalizeGoalLabel(u.label))?.count || 1,
      source: catalogByLabel.has(normalizeGoalLabel(u.label)) ? 'site-catalog' : 'locale-goal',
    }))
    .sort((a, b) => (b.prevalence - a.prevalence) || a.label.localeCompare(b.label));

  // ── compose DRIVE: taught first (immediately useful) but never crowd out discovery — when both tiers exist,
  // run-now takes at most ceil(max/2); teachable fills the rest; leftovers top up from whichever remains.
  let driveEntries;
  if (runNow.length && teachable.length) {
    const runTake = Math.min(runNow.length, Math.ceil(max / 2));
    driveEntries = [...runNow.slice(0, runTake), ...teachable.slice(0, max - runTake)];
    if (driveEntries.length < max) driveEntries = [...driveEntries, ...runNow.slice(runTake, runTake + (max - driveEntries.length))];
  } else {
    driveEntries = [...runNow, ...teachable].slice(0, max);
  }

  // ── AGNOSTIC class mix: the menu represents EVERY available class (Drive · Ride · Broker), not just the page-action
  // lane. Ride = the §18 ride-recipes; Broker = OAuth/MCP tools (seam — empty until brokers exist). When everything fits
  // in `max` we show it all; over budget, the non-drive classes are RESERVED up to half the slots so they never vanish.
  const rideEntries = _rideEntries(ride, max);
  const brokerEntries = (Array.isArray(broker) ? broker : [])
    .filter((b) => b && (b.label || b.name))
    .map((b) => ({ kind: 'run-now', class: 'broker', label: String(b.label || b.name).trim(), ask: String(b.ask || b.label || b.name).trim(), capabilityId: b.id || null, prevalence: 0, source: 'broker' }));
  const classExtra = [...rideEntries, ...brokerEntries];
  let entries = [...driveEntries, ...classExtra];
  if (entries.length > max) {
    const keepExtra = Math.min(classExtra.length, Math.max(1, Math.floor(max / 2)));
    entries = [...driveEntries.slice(0, max - keepExtra), ...classExtra.slice(0, keepExtra)];
  }

  // ── cold ground: nothing known in ANY class → a single explore-first signpost (ask=null; the UI explains/triggers Explore)
  if (!entries.length) {
    entries = [{ kind: 'explore-first', class: 'drive', label: 'Explore this page to discover what it can do', ask: null, capabilityId: null, prevalence: 0, source: 'readiness' }];
  }

  return {
    entries,
    readiness: readiness || null,
    counts: { taught: runNow.length, teachable: teachable.length, goals: pool.size, ride: rideEntries.length, broker: brokerEntries.length },
  };
}
