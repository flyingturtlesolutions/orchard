// Core/proposals.js — FL-2 (v2.74.1346, DESIGN_app_fleet.md). The PROPOSAL: the unit a propose-only sweep emits
// instead of acting. PURE — schema/normalize/decide helpers only; storage lives in Services/Storage/ProposalStore.js.
//
// A proposal is a NOT-YET-ACTION: {leg, params, targets, why, evidence, basedOn} — everything needed to (a) show the
// user an approvable card, (b) execute later via the EXISTING gated write path, (c) refuse execution if the world
// moved (the basedOn freshness anchor → the staleness CAS, same pattern as the canvas rev gate). The intelligence
// that MINTS proposals is the LLM + the app's memory (Core/sweepPrompt.js) — nothing domain-specific lives here.

import { legRef } from './legRef.js';

const _str = (x) => (typeof x === 'string' ? x.trim() : '');

export const PROPOSAL_STATUS = ['pending', 'approved', 'executed', 'rejected', 'stale', 'failed'];

/**
 * Normalize one raw LLM proposal against the OFFERED act legs (anti-hallucination: the key MUST be one we offered —
 * route.js's rule). Returns null for anything unofferable. PURE.
 * @param {object} raw               the LLM's proposal object
 * @param {{ legs?: Array<object> }} opts   the act-mode legs that were offered
 */
export function normalizeProposal(raw, { legs = [] } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const key = _str(raw.key) || _str(raw.tool) || _str(raw.capabilityId);
  const leg = (Array.isArray(legs) ? legs : []).find((l) => legRef(l) === key) || null;
  if (!leg) return null;
  const params = (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) ? raw.params : {};
  const targets = (Array.isArray(raw.targets) ? raw.targets : []).map((t) => _str(String(t))).filter(Boolean).slice(0, 12);
  const evidence = (Array.isArray(raw.evidence) ? raw.evidence : []).map((e) => _str(String(e))).filter(Boolean).slice(0, 4);
  let basedOn = null;
  if (raw.basedOn && typeof raw.basedOn === 'object' && _str(raw.basedOn.readKey) && _str(raw.basedOn.path)) {
    basedOn = { readKey: _str(raw.basedOn.readKey), path: _str(raw.basedOn.path), value: raw.basedOn.value == null ? '' : String(raw.basedOn.value) };
  }
  return {
    key,
    name: _str(leg.name) || key,
    params,
    targets,
    why: _str(raw.why).slice(0, 300),
    evidence,
    basedOn,
    safety: _str(leg.safety) || 'gated',   // the RECIPE's class rides the leg — never the LLM's opinion
    leg,                                    // full leg snapshot: execution later must not depend on re-assembly
  };
}

/** Bulk approval covers only the reversible classes; destructive/gated stays per-item. PURE. */
export function canBulkApprove(p) {
  return !!p && (p.safety === 'auto' || p.safety === 'confirm');
}

/** A tiny JSON-path getter for the staleness check: 'a.b[0].c' over a read result. PURE, never throws. */
export function getPath(obj, path) {
  if (obj == null || !path) return undefined;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * FL-1c (v2.74.1347) — GROUND TRUTH: the human-viewable page per target, assembled from TRUSTED data ONLY —
 * the leg's connection origin + its curated `itemUrl` template + the target id, which must be a plain token
 * ([A-Za-z0-9_-]+, then URI-encoded) so a minted target like `../../evil` can never escape the path. The model
 * contributes nothing but the id. Returns [] when the leg carries no template (graceful). PURE.
 * @returns {Array<{ id:string, url:string }>}
 */
export function targetUrls(p) {
  const tool = p && p.leg && p.leg.tool;
  const origin = tool && _str(tool.origin).toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const tpl = tool && _str(tool.itemUrl);
  if (!origin || !tpl || !tpl.includes('{id}')) return [];
  const out = [];
  for (const t of (Array.isArray(p.targets) ? p.targets : [])) {
    const id = String(t).trim().replace(/^#/, '');
    if (!/^[A-Za-z0-9_-]+$/.test(id)) continue;
    out.push({ id, url: `https://${origin}${tpl.replace('{id}', encodeURIComponent(id))}` });
  }
  return out;
}

// ── FL-8b (v2.74.1358) — per-action-class AUTONOMY: the config policy that lets the CLOCK execute ──────────────
// The user's standing directive ("run the admin task without me") lives as DATA in the app's config:
// `config.autonomy = { <recipeId>: 'auto' | 'gated' }`. Fail-closed three ways: an action absent from the map is
// gated; a leg whose SAFETY class is 'gated' (destructive:true — merge) can never be auto'd by config; and only
// the headless executor consults this at all — a panel `sweep` always parks for the human who is right there.

/** Resolve one proposal's unattended-execution verdict against the app's autonomy config. PURE. */
export function autonomyFor(config, p) {
  if (!p || !p.leg) return 'gated';
  if (p.safety === 'gated') return 'gated';               // destructive class — config cannot override the floor
  const map = (config && config.autonomy && typeof config.autonomy === 'object') ? config.autonomy : {};
  const rid = _str(p.leg.tool && p.leg.tool.recipeId);
  return rid && map[rid] === 'auto' ? 'auto' : 'gated';   // absent → gated (fail-closed)
}

/**
 * FL-8c — today's EXECUTED count per recipeId (the daily-quota counter, derived from the queue — no separate
 * bookkeeping). "Today" = same local calendar day as `now`. PURE.
 * @returns {Record<string, number>}
 */
export function executedTodayByRecipe(proposals, now = Date.now()) {
  const day = new Date(now); day.setHours(0, 0, 0, 0);
  const start = day.getTime();
  const out = {};
  for (const p of (Array.isArray(proposals) ? proposals : [])) {
    if (!p || p.status !== 'executed' || !(p.decidedAt >= start && p.decidedAt <= now + 86400000)) continue;
    const rid = _str(p.leg && p.leg.tool && p.leg.tool.recipeId);
    if (rid) out[rid] = (out[rid] || 0) + 1;
  }
  return out;
}

// ── FL-9 (v2.74.1370) — rejections must STICK (live miss: the 09:08 sweep re-proposed the exact action the
// user rejected at 09:02). Two layers: a STRUCTURAL filter (the harness never re-asks what a human just
// declined — contract, not domain judgment) + rejection lines in the propose prompt's operational context
// (so the model learns the pattern too). The escape hatch is mechanical: if the proposal's grounding anchor
// (basedOn.value) MOVED since the rejection, the world changed and re-proposing is legitimate.

const REJECT_COOLDOWN_MS = 24 * 3600_000;

const _pairKey = (p) => `${_str(p && p.leg && p.leg.tool && p.leg.tool.recipeId) || _str(p && p.key)}|${(Array.isArray(p && p.targets) ? p.targets : []).map((t) => String(t).trim().replace(/^#/, '')).sort().join(',')}`;

/**
 * Drop fresh proposals that repeat a HUMAN-REJECTED (action, targets) pair from the cooldown window — unless
 * the grounding anchor moved. PURE.
 * @returns {{ kept: Array<object>, suppressed: Array<{proposal: object, reason: string}> }}
 */
export function filterRejectedRepeats(proposals, prior, { windowMs = REJECT_COOLDOWN_MS, now = Date.now() } = {}) {
  const rejected = (Array.isArray(prior) ? prior : []).filter((p) => p && p.status === 'rejected' && (now - (p.decidedAt || 0)) <= windowMs);
  const list = Array.isArray(proposals) ? proposals : [];
  if (!rejected.length) return { kept: list, suppressed: [] };
  const kept = []; const suppressed = [];
  for (const p of list) {
    const twin = rejected.find((r) => _pairKey(r) === _pairKey(p));
    const moved = !!(twin && twin.basedOn && p && p.basedOn && String(twin.basedOn.value) !== String(p.basedOn.value));
    if (twin && !moved) suppressed.push({ proposal: p, reason: twin.reason || '' });
    else kept.push(p);
  }
  return { kept, suppressed };
}

/** The recent-rejection lines for the propose prompt's operational context (fenced data, last 8). PURE. */
export function rejectionContext(prior, { windowMs = REJECT_COOLDOWN_MS, now = Date.now() } = {}) {
  const lines = [];
  for (const p of (Array.isArray(prior) ? prior : [])) {
    if (!p || p.status !== 'rejected' || (now - (p.decidedAt || 0)) > windowMs) continue;
    lines.push(`recently REJECTED by the user (do not re-propose unless the item has changed): ${p.name}${p.targets && p.targets.length ? ` @ ${p.targets.join(', ')}` : ''}${p.reason ? ` — "${p.reason}"` : ''}`);
  }
  return lines.slice(-8).join('\n');
}

/** One-line batch summary: "6 pending: 3× Merge tickets · 2× Solve ticket · 1× Assign ticket". PURE. */
export function pendingSummary(list) {
  const pend = (Array.isArray(list) ? list : []).filter((p) => p && p.status === 'pending');
  if (!pend.length) return 'Nothing pending.';
  const byName = new Map();
  for (const p of pend) byName.set(p.name, (byName.get(p.name) || 0) + 1);
  const parts = [...byName.entries()].map(([n, c]) => `${c}× ${n}`);
  return `${pend.length} pending: ${parts.join(' · ')}`;
}
