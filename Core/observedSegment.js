// Core/observedSegment.js — OBS-2: segment a demonstration trace into Tier-1 primitives (Fragments).
//
// Path 3, stage O-3. Input: a coalesced RawAction[] (from Core/observedTrace.js). Output: an
// `{ tier:'observed', nodes:[fragment…] }` — the SAME node shape the T2 lowering emits, so OBS-3 feeds it
// straight into buildTier2CapabilityRecords. PURE: no DOM / chrome / LLM (testable in node).
//
// Rules, validated against a live Indeed demonstration (search "support" in Minneapolis, filter by date):
//  1. PRE-CLEAN — drop focus-noise: redundant consecutive clicks on the same element, and a click that is
//     immediately superseded by a type/select on that SAME element (you click a field, then type in it).
//  2. BOUNDARY — `navigate` and `submit` are TRANSITION markers, not steps. A Fragment = the steps that
//     accumulated before a boundary (the actions that CAUSED the transition — the T2 "fragment is a
//     transition" rule). Consecutive boundaries (click-Search → submit → navigate) coalesce into one.
//  3. LABEL — a heuristic name (disclosure-open name → commit name → first step). OBS-4's describeTrace
//     gives nicer labels later; this keeps it runnable without an LLM.
//
// @module Core/observedSegment
// @version 2.74.654

const _DISCLOSURE_HINT = /filter|menu|sort|posted|date|pay|salary|wage|type|level|experience|distance|remote|radius|category|options?|dropdown|expand|more/i;

function _named(a) {
  if (!a) return '';
  return (a.target && a.target.accessibleName) || a.value || (a.target && a.target.selector) || a.kind || '';
}

/** Heuristic Fragment label: a disclosure-open name, else the last click (the commit), else the first step. */
function _label(steps) {
  const disc = steps.find((a) => a.kind === 'click' && _DISCLOSURE_HINT.test(_named(a)));
  if (disc) return String(_named(disc)).slice(0, 60);
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].kind === 'click') return String(_named(steps[i])).slice(0, 60);
  return String(_named(steps[0])).slice(0, 60);
}

/** Drop focus-noise clicks: a click is removed if a later same-element click (dup) or a later same-element
 *  type/select (focus-before-typing) follows it before any boundary or different-element action. PURE. */
function _preclean(acts) {
  const out = [];
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (a.kind === 'click') {
      const sel = a.target && a.target.selector;
      let drop = false;
      for (let j = i + 1; j < acts.length; j++) {
        const b = acts[j];
        const bsel = b.target && b.target.selector;
        if (b.kind === 'navigate' || b.kind === 'submit') break;           // boundary — keep this click (it's the commit)
        if (bsel === sel && (b.kind === 'click' || b.kind === 'type' || b.kind === 'select')) { drop = true; break; }
        if (bsel !== sel) break;                                            // a different element intervened — keep
      }
      if (drop) continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Segment a coalesced demonstration trace into Fragments. PURE.
 * @param {object[]} trace  RawAction[] (already coalesced by Core/observedTrace.coalesce)
 * @returns {{tier:'observed', nodes:Array<{type:'fragment', label:string, steps:object[], from:string, to:string}>}}
 */
export function segmentTrace(trace) {
  const acts = _preclean(Array.isArray(trace) ? trace.filter(Boolean) : []);
  const nodes = [];
  let cur = [];
  let fromUrl = acts.length ? (acts[0].url || '') : '';
  const flush = (toUrl) => {
    if (!cur.length) return;
    nodes.push({ type: 'fragment', label: _label(cur), steps: cur, from: fromUrl, to: toUrl || (cur[cur.length - 1] && cur[cur.length - 1].url) || '' });
    cur = [];
  };
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (a.kind === 'navigate') { flush(a.to || a.url || ''); fromUrl = a.to || a.url || fromUrl; continue; }
    if (a.kind === 'submit') {
      // A submit fires BEFORE the navigation it causes, so its URL is stale. When a navigate follows
      // immediately, let THAT be the boundary (it carries the real target URL); otherwise this is an
      // in-place submit (no navigation) and we flush here.
      if (acts[i + 1] && acts[i + 1].kind === 'navigate') continue;
      flush(a.url || ''); fromUrl = a.url || fromUrl; continue;
    }
    cur.push(a);
  }
  flush('');   // trailing fragment (a final action with no navigation — e.g. a filter that applied in place)
  return { tier: 'observed', nodes };
}

// OBS-3 — map a recorded RawAction to the EXECUTABLE action shape (what TemplateWalker runs + what
// buildTier2CapabilityRecords persists). Each step keeps its inline `landmark` (role + accessibleName +
// hierarchicalContext + selector) so replay self-heals via probe-or-recover (SG-LM-3), no registry round
// trip. A `select` that was a click on a custom option (role=option, not a <select>) replays as a CLICK on
// that option; a native <select> change replays as SELECT. PURE.
export function stepToAction(a) {
  if (!a) return null;
  const t = a.target || {};
  const sel = t.selector;
  if (!sel) return null;
  const lm = (t.role && t.accessibleName) ? { role: t.role, accessibleName: t.accessibleName, hierarchicalContext: t.hierarchicalContext || null, selector: sel } : null;
  if (a.kind === 'type') return { action: 'TYPE', selector: sel, value: a.value != null ? a.value : '', ...(lm ? { landmark: lm } : {}) };
  if (a.kind === 'select') {
    if (String(t.tagName || '').toUpperCase() === 'SELECT') return { action: 'SELECT', selector: sel, value: a.value != null ? a.value : '' };
    return { action: 'CLICK', selector: sel, ...(lm ? { landmark: lm } : {}) };   // a clicked custom option
  }
  if (a.kind === 'click') return { action: 'CLICK', selector: sel, ...(lm ? { landmark: lm } : {}) };
  return null;   // navigate / submit are boundaries, not steps
}

/** OBS-3 — turn a segmented op into the per-phase {label, url, actions} the capability builder consumes.
 *  `url` is the page the phase's steps happened on (its `from`) — needed to mint per-page landmark UIDs,
 *  since a demonstration spans pages (search on the homepage, filter on the results). PURE. */
export function opToPhases(op) {
  const nodes = (op && Array.isArray(op.nodes)) ? op.nodes : [];
  return nodes.filter((n) => n && n.type === 'fragment').map((n) => ({
    label: n.label,
    url: n.from || (Array.isArray(n.steps) && n.steps[0] && n.steps[0].url) || '',
    actions: (Array.isArray(n.steps) ? n.steps : []).map(stepToAction).filter(Boolean),
  }));
}
