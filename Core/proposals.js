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
/**
 * FL-10f (v2.74.1385) — evidence HYGIENE: the model quotes raw minimized-JSON shards (`"id":65798,"subject":"…`)
 * as "evidence" — noise on an approval card a human must read in one glance. A JSON-ish shard is rewritten to the
 * human facts it carries (subject · status/priority · when); a shard carrying nothing extractable is DROPPED (the
 * `why` states the claim — a raw fragment adds no proof). Human quotes (transcript lines, thread sentences) pass
 * through untouched. PURE.
 */
export function cleanEvidence(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : [])) {
    const e = String(raw ?? '').trim();
    if (!e) continue;
    const jsonish = (e.match(/"?\w+"\s*:\s*/g) || []).length >= 2;
    if (!jsonish) { if (!out.includes(e)) out.push(e); }
    else {
      const g = (re) => { const m = e.match(re); return m ? m[1].trim() : null; };
      const subject = g(/"subject"\s*:\s*"([^"]{1,120})"/i);
      const status = g(/"status"\s*:\s*"([A-Za-z]+)"/i);
      const prio = g(/"priority"\s*:\s*"([A-Za-z]+)"/i);
      const created = g(/"created_at"\s*:\s*"([^"]{4,40})"/i);
      const when = created ? created.replace('T', ' ').replace(/:\d\d(?:\.\d+)?Z?$/, '') : null;
      const bits = [subject, [status, prio].filter(Boolean).join('/'), when].filter(Boolean);
      if (bits.length) { const line = bits.join(' · '); if (!out.includes(line)) out.push(line); }
    }
    if (out.length >= 3) break;
  }
  return out;
}

export function normalizeProposal(raw, { legs = [] } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const key = _str(raw.key) || _str(raw.tool) || _str(raw.capabilityId);
  const leg = (Array.isArray(legs) ? legs : []).find((l) => legRef(l) === key) || null;
  if (!leg) return null;
  const params = (raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)) ? raw.params : {};
  const targets = (Array.isArray(raw.targets) ? raw.targets : []).map((t) => _str(String(t))).filter(Boolean).slice(0, 12);
  const evidence = cleanEvidence((Array.isArray(raw.evidence) ? raw.evidence : []).map((e) => _str(String(e))).filter(Boolean).slice(0, 4));
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

/** FL-10f — a proposal that needs HUMAN JUDGMENT (vs routine policy work): gated/destructive classes + anything
 * whose recipe demands evidence for unattended execution. Data-driven — never a recipe-id check. PURE. */
export function isJudgment(p) {
  return !!p && (p.safety === 'gated' || p.safety === 'destructive' || !!(p.leg && p.leg.tool && p.leg.tool.autoRequires));
}

/**
 * FL-10f (v2.74.1385) — the pending batch as a READABLE review, not a wall: judgment items first as full cards
 * (direction line for consolidations, drill facts, cleaned quotes), routine items grouped per action as
 * one-liners (12 same-shaped assigns don't deserve 12 cards). Returns the DISPLAY order (numbering follows what
 * the user sees — `approve 2` means visible #2) + how many lead items get their own ✓/✗ buttons. PURE.
 */
export function renderProposalCards(pend) {
  const list = (Array.isArray(pend) ? pend : []).filter(Boolean);
  const judgment = list.filter(isJudgment);
  const routine = list.filter((p) => !isJudgment(p));
  const order = [];
  const lines = [];
  const tsetOf = (p) => new Set((Array.isArray(p.targets) ? p.targets : []).map((t) => String(t).replace(/^#/, '')));
  const paramBits = (p) => Object.entries((p.params && typeof p.params === 'object') ? p.params : {})
    .filter(([, v]) => v != null && (typeof v !== 'object' || Array.isArray(v)))
    .filter(([k]) => !/comment|note|body|message/i.test(k))   // boilerplate prose params — the direction/why carry the meaning
    .map(([k, v]) => [k, (Array.isArray(v) ? v.map(String).join(', ') : String(v)).replace(/`/g, '′').slice(0, 80)])
    .filter(([, v]) => v.trim() && !tsetOf(p).has(v.replace(/^#/, '')));
  // consolidation direction: an all-numeric array param + a scalar id param = sources → target ("which one survives?"
  // must never take a second read)
  const direction = (p) => {
    const prm = (p.params && typeof p.params === 'object') ? p.params : {};
    const arr = Object.entries(prm).find(([, v]) => Array.isArray(v) && v.length && v.every((x) => /^\d{2,}$/.test(String(x))));
    const tgt = prm.id != null && /^\d{2,}$/.test(String(prm.id)) ? String(prm.id) : null;
    return (arr && tgt) ? `#${arr[1].map(String).join(', #')} → #${tgt} _(target keeps the thread)_` : null;
  };
  if (judgment.length) {
    lines.push(`**Needs your judgment (${judgment.length})**`);
    for (const p of judgment) {
      order.push(p);
      const n = order.length;
      const tgt = direction(p) || (p.targets && p.targets.length ? p.targets.join(', ') : '');
      const bits = paramBits(p);
      const prm = bits.length ? `\n   → ${bits.map(([k, v]) => `\`${k}: ${v}\``).join(' · ')}` : '';
      const d = p.drill;
      const dr = d ? `\n   _${[
        d.klass || '', d.sentiment ? `sentiment ${d.sentiment}` : '', d.commitment ? 'OPEN COMMITMENT' : '',
        d.matched ? `same customer via ${d.matched}` : '', d.crossAgent ? 'CROSS-AGENT — solve own record, don’t merge' : '',
        p.safety === 'destructive' ? 'hard to reverse (source closes)' : 'reversible',
      ].filter(Boolean).join(' · ')}_` : '';
      // drop quotes that only restate the drill line (SAME CUSTOMER …) — say each fact once
      const evs = cleanEvidence(p.evidence).filter((e) => !(d && d.matched && /^['"]?(SAME CUSTOMER|TICKET_EVIDENCE)/i.test(e)));
      const ev = evs.length ? `\n   > ${evs.join('\n   > ')}` : '';
      lines.push(`${n}. **${p.name}** — ${tgt}${prm}${dr}\n   ${p.why || ''}${ev}`);
    }
  }
  if (routine.length) {
    const byName = new Map();
    for (const p of routine) { if (!byName.has(p.name)) byName.set(p.name, []); byName.get(p.name).push(p); }
    for (const [name, grp] of byName) {
      lines.push(`**Routine — ${name} (${grp.length})** _reversible, within policy_`);
      for (const p of grp) {
        order.push(p);
        const gist = (cleanEvidence(p.evidence)[0] || p.why || '').replace(/\s+/g, ' ').slice(0, 90);
        lines.push(`${order.length}. ${p.targets && p.targets.length ? p.targets.join(', ') : '—'}${gist ? ` — ${gist}` : ''}`);
      }
    }
  }
  return { lines, order, judgmentCount: judgment.length };
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
    // v1374 (live: the 65679 re-proposal slipped through) — "moved" ONLY when the SAME anchor (readKey + path)
    // changed value. Each sweep may ground on a different field, and cross-field comparison made every
    // re-grounding look like change. Index-shifted paths land on the conservative side (suppressed) — the
    // human can always act manually inside the 24h window.
    const moved = !!(twin && twin.basedOn && p && p.basedOn
      && twin.basedOn.readKey === p.basedOn.readKey && twin.basedOn.path === p.basedOn.path
      && String(twin.basedOn.value) !== String(p.basedOn.value));
    if (twin && !moved) suppressed.push({ proposal: p, reason: twin.reason || '' });
    else kept.push(p);
  }
  return { kept, suppressed };
}

/**
 * v1381 (live: "1 proposal pending — say pending" → "Nothing pending") — pendings SURVIVE sweeps. The v1349
 * wholesale-supersede was built for manual sweeps; on a 5-minute clock it expired proposals faster than a human
 * could review them. New rule: a prior pending goes stale ONLY when (a) the fresh mint contains the same
 * (action, targets) pair — replaced with fresh grounding — or (b) it sat unreviewed past maxAge. Everything else
 * survives; the approve-time staleness CAS still refuses items whose anchor moved, so survivors stay safe. PURE.
 * @returns {{ stale: Array<{id:string, reason:string}>, kept: Array<object> }}
 */
export function supersedePlan(prior, fresh, { now = Date.now(), maxAgeMs = 24 * 3600_000 } = {}) {
  const freshKeys = new Set((Array.isArray(fresh) ? fresh : []).map(_pairKey));
  const stale = []; const kept = [];
  for (const p of (Array.isArray(prior) ? prior : [])) {
    if (!p || p.status !== 'pending') continue;
    if (freshKeys.has(_pairKey(p))) stale.push({ id: p.id, reason: 'replaced by a fresh proposal (new sweep)' });
    else if ((now - (p.ts || 0)) > maxAgeMs) stale.push({ id: p.id, reason: 'expired unreviewed (24h)' });
    else kept.push(p);
  }
  return { stale, kept };
}

/** The recent-rejection lines for the propose prompt's operational context (fenced data, last 8). PURE.
 * v1374 — scoped explicitly as PER-ITEM decisions: the live sweep read two same-reason rejections as a policy
 * pivot and invented a bulk status-to-pending task the goal never asked for. */
export function rejectionContext(prior, { windowMs = REJECT_COOLDOWN_MS, now = Date.now() } = {}) {
  const lines = [];
  for (const p of (Array.isArray(prior) ? prior : [])) {
    if (!p || p.status !== 'rejected' || (now - (p.decidedAt || 0)) > windowMs) continue;
    lines.push(`- ${p.name}${p.targets && p.targets.length ? ` @ ${p.targets.join(', ')}` : ''}${p.reason ? ` — "${p.reason}"` : ''}`);
  }
  return lines.length
    ? `USER DECISIONS on specific items (do not re-propose these unless the item has changed; learn the judgment behind each reason, but do NOT invent new task types or shift your overall behavior — each decision scopes to its item only):\n${lines.slice(-8).join('\n')}`
    : '';
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
