// Core/readLeg.js — the read-leg abstraction for an Observation step (DESIGN_connectors.md §15). CX-9 slice 1.
// v2.74.1158.
//
// PURE: no chrome / DOM / LLM / storage. One LOGICAL read (an Observation extract) can be served by more than
// one MECHANISM — a "leg" — and the router picks the best FEASIBLE leg per step (§8/§15):
//   • dom-scrape      — read the rendered DOM region (today's path; always feasible — we're on the page)
//   • session-fetch   — call the app's own endpoint directly (A1; rides the session → INVOKE_SESSION)
//   • network-harvest — tee the in-flight JSON the page already fetched (A2; needs interception + a driven step)
// Preference: session-fetch > network-harvest > dom-scrape. This module is the schema + constructors + the PURE
// per-step selector; the runtime wiring (ObservationExecutor calling selectReadLeg, the network-harvest channel)
// is the next slice. Backward-compatible: a legacy { selector, output, shape } extract normalizes to one
// dom-scrape leg, so nothing that emits the old shape breaks. A session-fetch leg carries the SAME `tool`
// descriptor as a session-ride connector leg (connectorLeg.js) so dispatch is identical.
//
// `shape` (list|record|text) is a property of the EXTRACT (the logical read's output structure), NOT the leg —
// every leg serving the same extract yields the same shape. Legs are pure mechanism (selector / tool / match).

const _str = (x) => (typeof x === 'string' ? x.trim() : '');
const _shape = (s) => (s === 'list' || s === 'record' ? s : 'text');   // the Observation extract shapes

// Preference order — lower rank = preferred (§15). Unknown kinds sort last.
const _RANK = { 'session-fetch': 0, 'network-harvest': 1, 'dom-scrape': 2 };
export const READ_LEG_KINDS = ['session-fetch', 'network-harvest', 'dom-scrape'];
export function legRank(kind) { return Number.isFinite(_RANK[kind]) ? _RANK[kind] : 99; }

// Stable per-leg identity (kind + its addressing) for dedupe.
const _legId = (l) => {
  if (!l) return '';
  if (l.kind === 'dom-scrape') return `scrape:${l.selector}`;
  if (l.kind === 'session-fetch') return `session:${(l.tool && l.tool.endpoint) || ''}`;
  if (l.kind === 'network-harvest') return `harvest:${l.match}`;
  return `?:${JSON.stringify(l)}`;
};

/** dom-scrape leg — read a rendered DOM region. PURE. Null without a selector. */
export function domScrapeLeg(selector) {
  const sel = _str(selector);
  if (!sel) return null;
  return { kind: 'dom-scrape', selector: sel };
}

/**
 * session-fetch leg (A1) — call the app's own endpoint directly, riding the session (INVOKE_SESSION). PURE.
 * Carries the SAME `tool` descriptor as a session-ride connector leg so dispatch is identical. `result` is the
 * JSON path to the rows/record (e.g. 'results' / 'tickets'); `args` template the endpoint. Null without an
 * endpoint + (origin | appHost).
 */
export function sessionFetchLeg({ origin, appHost, endpoint, method = 'GET', app, verifyIdentity = false, identityProbe, args, result } = {}) {
  const ep = _str(endpoint);
  if (!ep || !(_str(origin) || _str(appHost))) return null;
  return {
    kind: 'session-fetch',
    tool: {
      impl: 'session', app: _str(app) || null,
      origin: _str(origin) || null, appHost: _str(appHost) || null,
      endpoint: ep, method: _str(method).toUpperCase() || 'GET',
      verifyIdentity: verifyIdentity === true, identityProbe: _str(identityProbe) || null,
    },
    args: (args && typeof args === 'object') ? args : {},
    result: _str(result) || null,
  };
}

/**
 * network-harvest leg (A2) — tee the in-flight response the page itself fetches, instead of scraping the render.
 * PURE. `match` is the endpoint URL pattern that identifies THE result-bearing call (correlation, §15); `result`
 * is the JSON path to the rows. Only feasible alongside a driven step with interception available. Null without
 * a `match`.
 */
export function networkHarvestLeg({ match, method, result } = {}) {
  const m = _str(match);
  if (!m) return null;
  return { kind: 'network-harvest', match: m, method: _str(method).toUpperCase() || null, result: _str(result) || null };
}

/** Normalize one leg-ish object (by `kind`) into a validated leg. PURE. Null on junk / incomplete. */
export function normalizeLeg(leg) {
  const o = (leg && typeof leg === 'object') ? leg : null;
  if (!o) return null;
  if (o.kind === 'session-fetch') {
    const t = (o.tool && typeof o.tool === 'object') ? o.tool : o;
    return sessionFetchLeg({ origin: t.origin, appHost: t.appHost, endpoint: t.endpoint, method: t.method,
      app: t.app, verifyIdentity: t.verifyIdentity, identityProbe: t.identityProbe, args: o.args, result: o.result });
  }
  if (o.kind === 'network-harvest') return networkHarvestLeg({ match: o.match, method: o.method, result: o.result });
  return domScrapeLeg(o.selector);   // 'dom-scrape' / unknown → the DOM region read
}

/**
 * Normalize an Observation extract into { output, shape, legs[] } with legs preference-ordered. PURE.
 * Backward-compatible: a legacy { selector, output, shape } yields one dom-scrape leg. An extract with `legs`
 * is normalized; a bare `selector` always contributes a dom-scrape fallback when not already present. Returns
 * null when nothing is readable.
 */
export function normalizeExtract(extract) {
  const x = (extract && typeof extract === 'object') ? extract : null;
  if (!x) return null;
  const legs = [];
  const seen = new Set();
  const push = (l) => { if (l) { const k = _legId(l); if (!seen.has(k)) { seen.add(k); legs.push(l); } } };
  for (const l of (Array.isArray(x.legs) ? x.legs : [])) push(normalizeLeg(l));
  const sel = _str(x.selector);
  if (sel && !legs.some((l) => l.kind === 'dom-scrape')) push(domScrapeLeg(sel));
  if (!legs.length) return null;
  legs.sort((a, b) => legRank(a.kind) - legRank(b.kind));
  return { output: _str(x.output) || null, shape: _shape(x.shape), legs };
}

// Is the app/host behind a session-fetch leg currently rideable? `env.sessionRideable` is a Set<app|host|origin>
// or a predicate (§6 availability). PURE.
function _rideable(tool, env) {
  const r = env && env.sessionRideable;
  if (!r || !tool) return false;
  const keys = [tool.app, tool.appHost, tool.origin].filter(Boolean);
  if (r instanceof Set) return keys.some((k) => r.has(k));
  if (typeof r === 'function') { for (const k of keys) { try { if (r(k)) return true; } catch { /* */ } } return false; }
  return false;
}

/**
 * Is a leg feasible in this env? PURE. dom-scrape always (we're on the page); network-harvest needs interception
 * available (env.canHarvest) — it only makes sense alongside a driven step; session-fetch needs the app rideable.
 * An injected env.healthy(leg)=>bool (GA-3 trust) can veto any leg — "two-leg health, not blind preference" (§15).
 */
export function legFeasible(leg, env = {}) {
  if (!leg) return false;
  const healthy = (env && typeof env.healthy === 'function') ? env.healthy : () => true;
  if (!healthy(leg)) return false;
  switch (leg.kind) {
    case 'dom-scrape': return true;
    case 'network-harvest': return !!(env && env.canHarvest === true);
    case 'session-fetch': return _rideable(leg.tool, env);
    default: return false;
  }
}

/**
 * The per-STEP arbitration (§8/§15): pick the most-preferred FEASIBLE read leg for an Observation extract.
 * PURE. Accepts an extract ({ legs | selector, … }) or a bare legs[]. Returns { leg, reason, considered }; `leg`
 * is null when nothing is feasible (the caller surfaces the gap). Health/availability ride in `env`.
 */
export function selectReadLeg(extractOrLegs, env = {}) {
  const norm = Array.isArray(extractOrLegs)
    ? { legs: extractOrLegs.map((l) => normalizeLeg(l)).filter(Boolean) }
    : normalizeExtract(extractOrLegs);
  const legs = (norm && Array.isArray(norm.legs) ? norm.legs.slice() : []).sort((a, b) => legRank(a.kind) - legRank(b.kind));
  const considered = legs.map((l) => l.kind);
  for (const leg of legs) {
    if (legFeasible(leg, env)) return { leg, reason: `chose ${leg.kind}`, considered };
  }
  return { leg: null, reason: legs.length ? 'none-feasible' : 'no-legs', considered };
}
