// Core/goalRetrieval.js — AL-4 (DESIGN_apps_learning.md §6, "the load-bearing new work"): the ASSEMBLE step — given
// an app's goal memory + the current ask, select what enters the finite context. PURE: no chrome / DOM / LLM / clock.
//
// The §6 budget: always-load the distilled SUMMARY + STANDING RULES, conditionally load BELIEFS by task, lazy-load
// the rest. Two outputs feed the reasoner:
//   • RULES (deltas) — how to BEHAVE: always-on rules (no trigger) ALWAYS apply; triggered rules apply when their
//     trigger overlaps the ask. (Authored via `remember:`, AL-3c.)
//   • RECALL (beliefs) — what's KNOWN/proven here: summary-tier facts ALWAYS (the distilled summary, AL-6); plus
//     ask-relevant beliefs by token overlap (the capability-association recall — body = a prior phrasing, ref = the
//     capability that handled it, AL-3b).
// Relevance is deterministic token overlap (cheap, no embedding). The live wiring (feed renderGoalContext into the
// interpret + answer prompts) is AL-4's later slices; this is the policy, headless-testable.

import { tierRank, retireStaleShapeDeltas } from './goalMemory.js';   // v2.74.1870 — drop verdicts about routing that has since changed
import { classifyAskToGrid } from './appDef.js';   // OM #3a — classify the ask + each belief into their operation×object cell

// Tiny stoplist — drop function words + the highest-frequency app verbs so overlap reflects DOMAIN words ("open
// emails", "refund ticket"), not "get"/"show"/"my". Conservative on purpose.
const _STOP = new Set([
  'the', 'a', 'an', 'my', 'me', 'i', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'is', 'it', 'do', 'does',
  'you', 'your', 'this', 'that', 'with', 'at', 'be', 'are', 'as', 'by', 'how', 'many', 'much', 'have', 'has',
  'get', 'show', 'find', 'list', 'all', 'any', 'some', 'from', 'into', 'out', 'up', 'about',
]);

/** Meaningful token SET from text (lowercased alphanum, >2 chars, non-stop). PURE. */
function _tokens(s) {
  const out = new Set();
  for (const t of String(s || '').toLowerCase().match(/[a-z0-9]+/g) || []) {
    if (t.length > 2 && !_STOP.has(t)) out.add(t);
  }
  return out;
}

/** Count of the text's meaningful tokens present in the ask-token set. PURE. */
function _overlap(askTokens, text) {
  let n = 0;
  for (const t of _tokens(text)) if (askTokens.has(t)) n++;
  return n;
}

/**
 * Select the goal-memory items relevant to an ask. PURE.
 * @param {Array} items   the app's stored beliefs/deltas (AL-2 list)
 * @param {{ ask?: string, maxRules?: number, maxRecall?: number, minOverlap?: number }} [opts]
 * @returns {{ rules: Array, recalled: Array }}
 */
export function assembleGoalContext(items, { ask = '', maxRules = 8, maxRecall = 5, minOverlap = 1, om = null, shapes = null } = {}) {
  // v2.74.1870 — a verdict about code that no longer exists is dropped at RECALL, before it can steer anything.
  // `shapes` maps ref → the leg's CURRENT shape key (Core/goalMemory.capabilityShapeKey); an act-fail whose
  // banked shape has moved retires here. Read-time, so no migration and no writer coordination: the store keeps
  // the row, the reasoner never sees it. Absent map / absent ref / pre-v1870 lesson without a shape → unchanged.
  const _pre = (Array.isArray(items) ? items : []).filter((x) => x && x.id);
  const list = shapes ? retireStaleShapeDeltas(_pre, shapes).items : _pre;
  const askTokens = _tokens(ask);
  const deltas = list.filter((x) => x.kind === 'delta');
  const beliefs = list.filter((x) => x.kind === 'belief');
  // OM #3a — recall-by-GRID: when the app has an object model, classify the ask into its operation×object cell and
  // BOOST beliefs whose body lands in the same cell (op match +2, object match +1). So a "close" ask recalls the
  // close-capability over a view one even when the wording overlaps little — and a grid match can clear the floor.
  const askGrid = (om && ask) ? classifyAskToGrid(ask, om) : null;
  const gridBoost = (b) => {
    if (!askGrid) return 0;
    const bg = classifyAskToGrid(b.body, om);
    if (!bg) return 0;
    return (askGrid.op && bg.op === askGrid.op ? 2 : 0) + (askGrid.object && bg.object === askGrid.object ? 1 : 0);
  };

  // AL-3e conflict resolution (v2.74.1328) — an act-fail LESSON delta must not override STRONGER positive evidence
  // for the SAME capability on this ask. Live .1327: one infra-era failure delta rendered as a STANDING RULE
  // ("didn't work — re-teach") and beat the confirmed "previously handled with COMPOSE" recall below it, wedging
  // every re-ask to teach. Read-time retire: an ask-relevant positive belief for the delta's ref with confidence
  // ≥ the delta's suppresses it (repeated REAL failures out-accrue the belief and surface again; user-authored
  // `remember:` rules carry no act-fail provenance and are never touched).
  const posConf = new Map();   // ref → best ask-relevant positive confidence
  for (const b of beliefs) {
    if (!b.ref) continue;
    if (b.tier !== 'summary' && (_overlap(askTokens, `${b.body} ${b.ref}`) + gridBoost(b)) < minOverlap) continue;
    const c = b.confidence ?? 0;
    if (c > (posConf.get(b.ref) ?? -1)) posConf.set(b.ref, c);
  }
  // RULES — always-on (no trigger) ALWAYS; triggered rules whose trigger overlaps the ask. Rank tier then confidence.
  const rules = deltas
    .filter((d) => !(d.provenance === 'act-fail' && d.ref && (posConf.get(d.ref) ?? -1) >= (d.confidence ?? 0)))
    .filter((d) => !d.trigger || _overlap(askTokens, d.trigger) >= minOverlap)
    .sort((a, b) => (tierRank(b.tier) - tierRank(a.tier)) || ((b.confidence ?? 0) - (a.confidence ?? 0)))
    .slice(0, maxRules);

  // RECALL — summary-tier beliefs ALWAYS (the distilled summary, §6); plus ask-relevant beliefs ranked by overlap.
  const always = beliefs.filter((b) => b.tier === 'summary');
  const scored = beliefs
    .filter((b) => b.tier !== 'summary')
    .map((b) => ({ b, score: _overlap(askTokens, `${b.body} ${b.ref || ''}`) + gridBoost(b) }))
    .filter((x) => x.score >= minOverlap)
    .sort((x, y) => (y.score - x.score) || (tierRank(y.b.tier) - tierRank(x.b.tier)) || ((y.b.confidence ?? 0) - (x.b.confidence ?? 0)));
  const recalled = [...always, ...scored.map((x) => x.b)].slice(0, maxRecall);

  return { rules, recalled };
}

/** Render the assembled context as a fenced-ready text block (trusted — the app's OWN memory). PURE. '' when empty. */
export function renderGoalContext(ctx) {
  const { rules = [], recalled = [] } = (ctx && typeof ctx === 'object') ? ctx : {};
  const lines = [];
  if (rules.length) {
    lines.push('STANDING RULES — follow these:');
    for (const r of rules) lines.push(`- ${r.trigger ? `when ${r.trigger}, ` : ''}${r.body}`);
  }
  if (recalled.length) {
    if (lines.length) lines.push('');
    lines.push('LEARNED here (relevant from past work):');
    for (const b of recalled) lines.push(`- ${b.body}${b.ref ? `  → previously handled with capability "${b.ref}"` : ''}`);
  }
  return lines.join('\n');
}

/** Convenience: assemble + render in one call. PURE. '' when nothing is relevant (caller fences only if non-empty). */
export function goalContextFor(items, ask, opts) {
  return renderGoalContext(assembleGoalContext(items, { ask, ...(opts || {}) }));
}
