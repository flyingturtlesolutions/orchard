// Core/execPlan.js — the runTool dispatch table (DESIGN_inference_layer.md §4.2). IL-2 (v2.74.1109).
//
// PURE: maps a chosen OfferedLeg → a DISPATCH PLAN (which executor channel · the payload · whether to
// busy-mark the tab · the mode) WITHOUT performing any I/O. The impure runTool = planExec + the actual
// channel send + Observation normalization (the AGENT_LOOP handler). Keeping the routing PURE makes the
// dispatch policy — especially the busy-mark rule (Invariant #2) and the Page-needs-ground/tab gate —
// unit-testable; the handler just executes the plan.
//
// Busy-mark policy (Invariant #2): a PAGE leg drives the tab with synthetic events → busy-mark so the
// interaction monitor drops them as `engine-run`. BROWSER legs are `chrome.tabs` calls (no synthetic DOM
// input) and SELF legs are introspection → never busy-mark. (A user-demonstration leg is never busy-marked
// either, but that path doesn't go through the inference-layer loop.)

// The verified executor channels per leg (the names the SW message handlers already answer). A learned PAGE
// capability replays through REPLAY_SG_CAPABILITY (the trial/verify-gated runner); browser primitives map to
// their existing ops. Self/connector are partial/greenfield — planned but may dispatch to a not-yet-built
// handler (the plan says ok:true so the loop attempts it; a missing handler returns ok:false at runtime).
const BROWSER_CHANNEL = { OPEN_URL: 'OPEN_URL_NEW_TAB', FOCUS_TAB: 'FOCUS_TAB', CLOSE_TABS: 'CLOSE_TABS', LIST_TABS: 'LIST_TABS' };
const SELF_CHANNEL    = { LIST_CAPABILITIES: 'GET_INTENT_MENU', RUN_STATUS: 'RUN_STATUS' };   // IL-3b — the real handler is GET_INTENT_MENU

const keyOf = (leg) => (leg && (leg.key ?? leg.capabilityId ?? leg.op ?? leg.name)) || null;

/**
 * Plan the dispatch of one leg. PURE.
 * @param {object} leg     an OfferedLeg ({key, domain, mode, source, tool, …})
 * @param {object} params  the bound params from the Decision
 * @param {{tabId?:number, groundId?:string}} [ctx]
 * @returns {{ ok:boolean, channel:(string|null), payload:object, busyMark:boolean, mode:string, domain:string, reason:string }}
 */
export function planExec(leg, params = {}, ctx = {}) {
  const plan = _planExec(leg, params, ctx);
  // v2.74.1115 — stamp the human NAME so the panel's HITL confirm names WHICH capability ("run 'Search for
  // media content'…?") instead of a uuid; harmless on the dispatch path.
  const name = (leg && (leg.name || leg.key || leg.capabilityId || leg.op)) || null;
  return name ? { ...plan, name } : plan;
}

function _planExec(leg, params = {}, ctx = {}) {
  const p = (params && typeof params === 'object') ? params : {};
  const tabId = (ctx && Number.isInteger(ctx.tabId)) ? ctx.tabId : null;
  const groundId = (ctx && ctx.groundId) ? ctx.groundId : null;
  const mode = (leg && leg.mode === 'ask') ? 'ask' : 'act';
  const fail = (domain, reason) => ({ ok: false, channel: null, payload: {}, busyMark: false, mode, domain, reason });

  if (!leg || typeof leg !== 'object') return fail('?', 'no-leg');
  const key = keyOf(leg);
  if (!key) return fail(leg.domain || '?', 'no-key');
  const domain = leg.domain || (leg.source === 'learned' ? 'page' : 'browser');

  if (domain === 'page') {
    // A learned capability replays through the verified runner. It needs its Ground + a tab to act on.
    if (tabId == null || !groundId) return fail('page', 'needs-ground-tab');
    return { ok: true, channel: 'REPLAY_SG_CAPABILITY', busyMark: true, mode, domain: 'page',
             payload: { capabilityId: key, groundId, tabId, paramValues: p }, reason: 'page-replay' };
  }
  if (domain === 'browser') {
    const channel = BROWSER_CHANNEL[key];
    if (!channel) return fail('browser', 'unknown-browser-op');
    if (key === 'OPEN_URL') {
      const url = typeof p.url === 'string' ? p.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) return fail('browser', 'open-url-needs-url');
      return { ok: true, channel, busyMark: false, mode: 'act', domain: 'browser', payload: { url, active: true }, reason: 'browser-open' };
    }
    if (key === 'FOCUS_TAB') {
      const t = Number.isInteger(p.tabId) ? p.tabId : tabId;
      if (t == null) return fail('browser', 'focus-needs-tab');
      return { ok: true, channel, busyMark: false, mode: 'act', domain: 'browser', payload: { tabId: t }, reason: 'browser-focus' };
    }
    if (key === 'CLOSE_TABS') {
      return { ok: true, channel, busyMark: false, mode: 'act', domain: 'browser', payload: { match: p.match ?? p.query ?? null }, reason: 'browser-close' };
    }
    // LIST_TABS (read)
    return { ok: true, channel, busyMark: false, mode: 'ask', domain: 'browser', payload: {}, reason: 'browser-list' };
  }
  if (domain === 'self') {
    // CA-2 — canvas render legs (DESIGN_canvas.md §3): write a model-authored spec to the app's presentation tab.
    // Self-domain but SW-channel-dispatched (it crosses to the canvas tab + persists, and the cadence path fires it
    // with no panel open) → never busy-marked (Invariant #2 N/A, like connector). The handler is CA-4.
    if (key === 'DISPLAY' || key === 'COMPOSE') {
      const spec = (p && p.spec && typeof p.spec === 'object') ? p.spec : null;
      if (!spec) return fail('self', 'render-needs-spec');
      const anchor = { appId: (ctx && ctx.appId) || null, conversationId: (ctx && ctx.conversationId) || null };
      return { ok: true, channel: 'RENDER_CANVAS', busyMark: false, mode: 'act', domain: 'self',
               payload: { op: key.toLowerCase(), spec, anchor }, reason: 'canvas-render' };
    }
    const channel = SELF_CHANNEL[key];
    if (!channel) return fail('self', 'unknown-self-op');
    return { ok: true, channel, busyMark: false, mode: 'ask', domain: 'self', payload: { tabId, groundId }, reason: 'self-introspect' };
  }
  if (domain === 'connector') {
    // Two implementations (DESIGN_connectors.md §7): session-ride (client, rides the browser login) and
    // oauth/MCP-broker (cloud proxy). Neither drives a tab → never busy-mark (Invariant #2 N/A).
    const t = (leg && leg.tool) || {};
    if (t.impl === 'session') {
      if (!(t.origin || t.appHost) || !t.endpoint) return fail('connector', 'session-no-recipe');
      return { ok: true, channel: 'INVOKE_SESSION', busyMark: false, mode, domain: 'connector',
               payload: { origin: t.origin || null, appHost: t.appHost || null, endpoint: t.endpoint,
                          method: t.method || 'GET', body: t.body || null, account: t.account || null, args: p,
                          groundId: groundId || null, recipeId: (leg && leg.key) || null,   // §18 — the arm guard checks the per-Ground recipe at INVOKE_SESSION
                          verifyIdentity: t.verifyIdentity === true, identityProbe: t.identityProbe || null },
               reason: 'session-ride' };
    }
    if (!t.server || !t.name) return fail('connector', 'connector-no-binding');
    return { ok: true, channel: 'INVOKE_CONNECTOR', busyMark: false, mode, domain: 'connector',
             payload: { server: t.server, tool: t.name, args: p }, reason: 'connector-invoke' };
  }
  return fail(domain, 'no-dispatch');
}

/**
 * Normalize a raw executor reply ({success, …}) into a uniform Observation the loop re-thinks over. PURE.
 * `value`/`scope` carry forward; a failure rides back as `structuredFailure` (the #1 envelope) so Orchard
 * can re-engage, not just give up.
 * @param {object|null} reply   the executor's response message
 * @param {object} [plan]       the planExec output (for context on a miss)
 * @returns {{ok:boolean, value?:*, scope?:object, structuredFailure?:object, reason:string}}
 */
export function toObservation(reply, plan = {}) {
  if (!reply || typeof reply !== 'object') {
    return { ok: false, structuredFailure: { where: plan.channel || '?', reason: 'no-reply' }, reason: 'no-reply' };
  }
  const ok = reply.success !== false && !reply.error;
  if (!ok) {
    return { ok: false, structuredFailure: { where: plan.channel || '?', reason: reply.error || reply.reason || 'failed', verdict: reply.verdict ?? null }, reason: reply.error || 'failed' };
  }
  const value = (reply.value !== undefined) ? reply.value
    : (reply.result !== undefined) ? reply.result
    : (reply.extracted !== undefined) ? reply.extracted : null;
  const obs = { ok: true, value, reason: 'ok' };
  if (reply.scope && typeof reply.scope === 'object') obs.scope = reply.scope;
  if (reply.verdict !== undefined) obs.verdict = reply.verdict;
  return obs;
}
