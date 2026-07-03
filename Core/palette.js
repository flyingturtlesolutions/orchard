// Core/palette.js — the inference-layer leg palette (DESIGN_inference_layer.md §4.3). IL-2 (v2.74.1108).
//
// PURE: no chrome / DOM / LLM / storage. `assemblePalette` unifies the two leg sources Orchard selects over —
// LEARNED capabilities (tool-RAG, R-2, injected `retrieve`) and the small fixed BUILTIN registry — into one
// uniform, availability-gated, policy-filtered, OUTCOMES-biased OfferedLeg[] (the §4.3 pipeline). The handlers
// that DISPATCH a chosen leg live with runTool (the IL-2 wire-in, impure); THIS module is descriptors + the
// pure assembly. The alias warm-path (route.js Tier-0) runs BEFORE this — the palette is the cold path only.
//
// An OfferedLeg (the uniform leg spec, §2.2):
//   { key, name, does, mode('act'|'ask'), domain('page'|'browser'|'connector'|'self'),
//     params, source('learned'|'builtin'), safety('auto'|'confirm'|'gated'|'forbidden'),
//     verified_by?, tool?(underlying descriptor for dispatch), prior?(attached bias) }

import { legRef } from './legRef.js';

// The stable selection key — see Core/legRef.js (single precedence order).
const keyOf = legRef;

/**
 * The BUILTIN leg registry — the small fixed set Orchard always has beyond the learned library. Descriptors
 * only (handlers are wired at runTool, IL-2b). `requires` is the availability gate (§4.3): a leg is offered
 * only when the env provides every flag (e.g. FOCUS_TAB needs an existing tab). Browser is partial today,
 * Self is partial, Connector is greenfield (§4.2) — so this set is intentionally small and grows with handlers.
 */
export const BUILTIN_LEGS = [
  // Browser — tabs / windows / navigation
  { key: 'OPEN_URL',   name: 'Open a URL',     does: 'navigate to a URL (active or new tab)', mode: 'act', domain: 'browser', safety: 'auto',    params: ['url'],   requires: [] },
  { key: 'FOCUS_TAB',  name: 'Focus a tab',    does: 'bring an existing tab to the front',    mode: 'act', domain: 'browser', safety: 'auto',    params: ['tabId'], requires: ['tab'] },
  { key: 'CLOSE_TABS', name: 'Close tabs',     does: 'close tabs matching a description',     mode: 'act', domain: 'browser', safety: 'confirm', params: ['match'], requires: ['tab'] },
  { key: 'LIST_TABS',  name: 'List open tabs', does: 'report the open tabs',                  mode: 'ask', domain: 'browser', safety: 'auto',    params: [],        requires: [] },
  // Self — the agent reasons over its own tool/state (READ)
  { key: 'LIST_CAPABILITIES', name: 'What can I do here', does: 'list capabilities available on this page/site', mode: 'ask', domain: 'self', safety: 'auto', params: [], requires: [] },
  { key: 'RUN_STATUS',        name: "What's running",      does: 'report in-flight runs',                        mode: 'ask', domain: 'self', safety: 'auto', params: [], requires: [] },
  // Self — PANEL actions (ACT×Self; dispatched panel-local in chat.js — a function/button click, not a SW channel). IL-3c.
  { key: 'NEW_DEV_CONVERSATION',     name: 'New dev conversation', does: 'open a new dev (Claude Code) conversation on this repo', mode: 'act', domain: 'self', safety: 'confirm', params: [], requires: [] },
  { key: 'NEW_CONVERSATION',         name: 'New conversation',     does: 'start a fresh chat conversation',                       mode: 'act', domain: 'self', safety: 'auto',    params: [], requires: [] },
  { key: 'OPEN_HISTORY',             name: 'Conversation history', does: 'show the list of past conversations',                   mode: 'act', domain: 'self', safety: 'auto',    params: [], requires: [] },
  { key: 'DELETE_ALL_CONVERSATIONS', name: 'Delete all conversations', does: 'delete every saved conversation (irreversible)',    mode: 'act', domain: 'self', safety: 'gated',   params: [], requires: [] },
  { key: 'OPEN_STUDIO',              name: 'Open Studio',          does: 'open the Studio authoring tab',                        mode: 'act', domain: 'self', safety: 'auto',    params: [], requires: [] },
  { key: 'OPEN_GROUND',              name: 'Open Ground panel',    does: 'open the Ground monitoring side panel',                mode: 'act', domain: 'self', safety: 'auto',    params: [], requires: [] },
  { key: 'HIDE_PANEL',               name: 'Hide panel',           does: 'hide the side panel (running tasks continue)',         mode: 'act', domain: 'self', safety: 'auto',    params: [], requires: [] },
  { key: 'RELOAD_EXTENSION',         name: 'Reload extension',     does: 'reload the extension (dev)',                           mode: 'act', domain: 'self', safety: 'auto',    params: [], requires: [] },
  { key: 'EXPLORE_PAGE',             name: 'Explore this page',    does: 'map/ground the current page so I learn what it offers', mode: 'act', domain: 'self', safety: 'auto',    params: [], requires: [] },
  { key: 'TOGGLE_TRACKING',          name: 'Toggle interaction tracking', does: 'turn the interaction monitor (learns capabilities from your clicks) on or off', mode: 'act', domain: 'self', safety: 'confirm', params: [], requires: [] },
  // Self — CANVAS render (ACT×Self → the SW channel RENDER_CANVAS, not panel-local). CA-2 (DESIGN_canvas.md §3).
  // Offered ONLY when the bound app DEFINES a presentation layer (`requires:['canvas']` → env.canvas, set in CA-6);
  // until then never offered. `spec` is the model-authored CanvasSpec (validated by canvasSpec.normalizeCanvasSpec).
  { key: 'DISPLAY', name: 'Show in the canvas',    does: "render a read-only view (a HUD, digest, or summary) in the app's canvas tab",                 mode: 'act', domain: 'self', safety: 'auto', params: ['spec'], requires: ['canvas'] },
  { key: 'COMPOSE', name: 'Compose in the canvas', does: "open editable content (a reply, a guide) in the app's canvas tab for the user to review/edit", mode: 'act', domain: 'self', safety: 'auto', params: ['spec'], requires: ['canvas'] },
];

/**
 * Normalize a learned saved capability, a primitive/builtin descriptor, or an already-normalized leg into a
 * uniform OfferedLeg. PURE. Read-only buys autonomy (§2.4): an ASK leg defaults to `auto`, an ACT leg to
 * `confirm` (a write wants a gate) — unless the source carries an explicit safety class (PB-4).
 */
export function toOfferedLeg(x) {
  if (!x || typeof x !== 'object') return null;
  if (x.key && x.domain && x.source) return x;            // already a normalized leg
  const key = keyOf(x);
  if (!key) return null;
  // a builtin / primitive descriptor (carries an op or a non-page domain)
  if (x.op || x.domain === 'browser' || x.domain === 'self' || x.domain === 'connector') {
    const mode = x.mode === 'ask' ? 'ask' : 'act';
    return { key, name: x.name ?? null, does: x.does ?? null, mode, domain: x.domain ?? 'browser',
             params: Array.isArray(x.params) ? x.params : [], source: 'builtin', safety: x.safety ?? 'auto', tool: x };
  }
  // a learned saved capability → a Page leg
  const mode = (x.mode === 'ask' || x.read === true) ? 'ask' : 'act';
  const safety = x.safety ?? (mode === 'ask' ? 'auto' : 'confirm');
  return { key, name: x.name ?? null, does: x.intent ?? x.does ?? null, mode, domain: 'page',
           params: Array.isArray(x.params) ? x.params : [], source: 'learned', safety, verified_by: x.verifiedBy ?? 'trial', tool: x };
}

/** Filter the builtin registry to those AVAILABLE in this env (every `requires` flag truthy). PURE. */
export function availableBuiltins(catalog = BUILTIN_LEGS, env = {}) {
  const list = Array.isArray(catalog) ? catalog : BUILTIN_LEGS;
  const e = env || {};
  return list
    .filter((l) => l && (Array.isArray(l.requires) ? l.requires : []).every((r) => !!e[r]))
    .map((l) => ({ ...l, source: 'builtin' }));
}

/**
 * GD-4b (v2.74.1324, DESIGN_canvas.md §8.2) — project the COMPOSE leg for INTERPRET's palette when the bound app
 * DEFINES a presentation layer. Drafting is a STANDALONE act (not ticket/connector-gated — the ask itself is the
 * brief), so the projection is PARAM-FREE: the dispatch hands the WHOLE ask to COMPOSE_CANVAS and the compose LLM
 * authors the spec — interpret never fills a `spec` param (the BUILTIN_LEGS descriptor's `spec` is the CA-2
 * channel shape, wrong for selection). The draft-forward `does` is what breaks the clarify-loop: an
 * underspecified "draft a reply to James" is ENOUGH detail to select compose. PURE; null off-app / no presentation.
 */
export function composeOfferedLeg(app) {
  if (!app || !app.presentation || typeof app.presentation !== 'object') return null;
  const base = BUILTIN_LEGS.find((l) => l && l.key === 'COMPOSE') || {};
  return { ...base, key: 'COMPOSE', params: [], source: 'builtin', name: 'Draft on the canvas',
           does: 'draft or revise content (a reply, a message, a document) on the app’s canvas — works from ANY page (the canvas is its own surface; the current tab is irrelevant) and from whatever detail the ask gives (no ticket or context required); a follow-up ask ("change the first line") revises the same draft; nothing is sent anywhere' };
}

const _ruleApplies = (r, scope) => !r || !r.when || (r.when.ground == null) || (r.when.ground === (scope && scope.ground));
const _ruleForbids = (r, leg) => !!((Array.isArray(r.forbidKeys) && r.forbidKeys.includes(keyOf(leg))) ||
                                    (Array.isArray(r.forbidDomains) && r.forbidDomains.includes(leg.domain)));

/**
 * Enforce the selection policy (§2.3 "LLM proposes, policy disposes") as a FILTER — it only ever DROPS legs:
 *   • the FLOOR (unrelaxable): a `forbidden`-safety leg is never offerable (credentials / money-move / the
 *     "never" boundary §2.4) — no rule can re-admit it (floor always wins).
 *   • the user RULE TABLE: tighten-only. A rule may forbid keys/domains within a scope; it can never ADD a leg
 *     (loosening the floor needs elevated consent, not a table entry — §2.3). Most-specific scope wins; here a
 *     single forbidding match drops the leg.
 * Filter-before-offer is WHY a corrupted think can't fire a forbidden leg — it was never in the palette (§9).
 */
export function policyFilter(legs, { rules = [], scope = {} } = {}) {
  const list = Array.isArray(legs) ? legs : [];
  const rs = Array.isArray(rules) ? rules : [];
  return list.filter((leg) => {
    if (!leg || !keyOf(leg)) return false;   // v1340 — keyOf-tolerant: a RAG candidate carries capabilityId, not key (the live interpret palette runs through here now)
    if (leg.safety === 'forbidden') return false;                       // floor — unrelaxable
    for (const r of rs) { if (_ruleApplies(r, scope) && _ruleForbids(r, leg)) return false; }
    return true;
  });
}

/**
 * Bias a leg with its OUTCOMES prior (GA-5) + the read/write hint (§2.3: read→speed, write→observability).
 * PURE — `outcomes(key) → {success:0..1, n}` is injected. The selection reads `prior`; assembly only attaches.
 */
export function attachPrior(leg, outcomes) {
  if (!leg) return leg;
  let o = null;
  if (typeof outcomes === 'function') { try { o = outcomes(leg.key); } catch { o = null; } }
  return { ...leg, prior: {
    success: (o && Number.isFinite(o.success)) ? o.success : null,
    n: (o && Number.isFinite(o.n)) ? o.n : 0,
    readWrite: leg.mode === 'ask' ? 'read' : 'write',
  } };
}

/**
 * Assemble the palette for one step (§4.3). PURE — all I/O via injected deps (any may be absent).
 * @param {string} goal
 * @param {Object} scope                       live HS-2 values (used by policy scoping)
 * @param {{
 *   retrieve?: (goal:string, k:number)=>Promise<Array<object>>,   // learned: tool-RAG (R-2)
 *   builtins?: Array<object>,                                     // the builtin registry (default BUILTIN_LEGS)
 *   env?: Object,                                                 // availability flags {tab,connector,dev,…}
 *   rules?: Array<object>,                                        // the user routing-rule table
 *   outcomes?: (key:string)=>({success:number,n:number}|null),   // OUTCOMES prior (GA-5)
 * }} [deps]
 * @param {{ k?:number }} [opts]
 * @returns {Promise<Array<object>>}            OfferedLeg[] — unified, gated, policy-filtered, prior-biased
 */
export async function assemblePalette(goal, scope = {}, deps = {}, opts = {}) {
  const { retrieve, builtins = BUILTIN_LEGS, env = {}, rules = [], outcomes } = deps || {};
  const k = Number.isFinite(opts.k) ? opts.k : 8;
  const g = String(goal ?? '').trim();

  // LEARNED — bounded retrieval keeps the palette small at any library size (k≈8); never dump-all.
  let learned = [];
  if (g && typeof retrieve === 'function') {
    try { const r = await retrieve(g, k); if (Array.isArray(r)) learned = r; } catch { learned = []; }
  }
  const learnedLegs = learned.map(toOfferedLeg).filter(Boolean);
  const builtinLegs = availableBuiltins(builtins, env).map(toOfferedLeg).filter(Boolean);

  // Union + dedupe by key; a LEARNED capability wins a tie over a generic builtin (the taught path is preferred).
  const seen = new Set();
  const merged = [];
  for (const leg of [...learnedLegs, ...builtinLegs]) {
    if (!leg || !leg.key || seen.has(leg.key)) continue;
    seen.add(leg.key); merged.push(leg);
  }

  const allowed = policyFilter(merged, { rules, scope });
  return allowed.map((l) => attachPrior(l, outcomes));
}
