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
// @version 2.74.667

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
    if (a.kind === 'scroll') continue;   // OBS-4 — recorded for trace fidelity, not a step (replay scrolls via SCROLL_TO)
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
  const lm = (t.role && t.accessibleName)
    ? { role: t.role, accessibleName: t.accessibleName, hierarchicalContext: t.hierarchicalContext || null, selector: sel, rect: t.rect || null, text: t.text || null, attrs: t.attrs || null }
    : null;
  if (a.kind === 'type') return { action: 'TYPE', selector: sel, value: a.value != null ? a.value : '', ...(lm ? { landmark: lm } : {}) };
  if (a.kind === 'select') {
    if (String(t.tagName || '').toUpperCase() === 'SELECT') return { action: 'SELECT', selector: sel, value: a.value != null ? a.value : '' };
    return { action: 'CLICK', selector: sel, ...(lm ? { landmark: lm } : {}) };   // a clicked custom option
  }
  if (a.kind === 'click') return { action: 'CLICK', selector: sel, ...(lm ? { landmark: lm } : {}) };
  if (a.kind === 'key') return { action: 'KEY', selector: sel, value: a.value || 'Enter', ...(lm ? { landmark: lm } : {}) };   // Enter-to-submit replays via handleKey→handleEnter
  return null;   // navigate / submit are boundaries, not steps
}

const _slug = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

/**
 * OBS-4 — derive a reusable PARAM SCHEMA from a segmented demonstration. PURE. Every captured VALUE is a
 * candidate param: a typed field (text) and a chosen option (option). An option's key/label come from its
 * dropdown's DISCLOSURE name (the click that opened it), not the option text — so "Date posted filter →
 * Last 3 days" yields param `date-posted-filter = Last 3 days`, not `last-3-days`. The demonstrated value is
 * the param's default. Keys are deduped. (The LLM describeTrace may rename these; this is the deterministic
 * floor.) Works on the op BEFORE opToPhases (option clicks keep their value here; the executable CLICK drops it).
 * @returns {Array<{key:string,label:string,kind:'text'|'option',value:string,selector:(string|null)}>}
 */
export function deriveObservedParams(op) {
  const nodes = (op && Array.isArray(op.nodes)) ? op.nodes : [];
  const out = []; const seen = new Set();
  const add = (base, label, kind, value, selector, vocabulary) => {
    let key = _slug(base) || 'param';
    let k = key; let n = 2; while (seen.has(k)) k = `${key}-${n++}`;
    seen.add(k);
    const vocab = (Array.isArray(vocabulary) ? vocabulary.map(String).filter(Boolean) : []);
    out.push({ key: k, label: label || base || k, kind, value: value != null ? String(value) : '', selector: selector || null, ...(vocab.length > 1 ? { vocabulary: Array.from(new Set(vocab)) } : {}) });
  };
  for (const node of nodes) {
    if (!node || node.type !== 'fragment') continue;
    let disclosure = null;
    for (const s of (Array.isArray(node.steps) ? node.steps : [])) {
      const name = s.target && s.target.accessibleName;
      const sel = s.target && s.target.selector;
      // ORCH-V — an option choice carries its dropdown's full vocabulary (the closed set the binder classifies
      // against + the datalist the re-run form offers); a typed field has no vocabulary.
      const vocab = s.target && s.target.options;
      if (s.kind === 'type' && s.value != null && s.value !== '') add(name || 'field', name || 'Field', 'text', s.value, sel);
      else if (s.kind === 'select' && s.value != null && s.value !== '') add(disclosure || name || 'choice', disclosure || name || 'Choice', 'option', s.value, sel, vocab);
      else if (s.kind === 'click' && _DISCLOSURE_HINT.test(name || '')) disclosure = name;
    }
  }
  return out;
}

/** OBS-4b — placeholder NAME for a param key: UPPER_SNAKE, [A-Z0-9_], bounded — matches the `{{NAME}}` regex
 *  TemplateWalker/InjectionService use (`/\{\{([A-Z0-9_]+)\}\}/`). 'date-posted-filter' → 'DATE_POSTED_FILTER'. */
export function obsParamName(key) {
  const n = String(key || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return n || 'PARAM';
}

/** OBS-4c — the CONTAINER selector for an option click: the option's parent (strip the last TOP-LEVEL CSS
 *  combinator — `>` `+` `~` or a descendant space, ignoring combinators inside `[…]` / `(…)`). CLICK_BY_LABEL
 *  searches this container for a role=option/menuitem/interactive descendant whose label matches, so
 *  re-choosing works by LABEL, not by the demonstrated element's fragile position. Returns null for a single
 *  simple selector (no derivable container → the option stays literal, no regression). PURE.
 *  e.g. '#date>li:nth-of-type(3)' → '#date'; '.menu .item' → '.menu'; '#solo' → null. */
export function optionContainerSelector(selector) {
  const s = String(selector || '').trim();
  if (!s) return null;
  let depth = 0, cut = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === '>' || c === '+' || c === '~' || c === ' ')) cut = i;
  }
  if (cut <= 0) return null;
  const head = s.slice(0, cut).replace(/[>+~\s]+$/, '').trim();
  return head || null;
}

/**
 * OBS-4b/4c — parameterize a demonstration's INPUTS so it RE-RUNS with NEW values (a demo becomes a reusable
 * template, not a one-shot). PURE. Two kinds of input are templated, each gaining a `{{NAME}}` the strategy
 * param fills at replay (via InjectionService.injectParams):
 *   • TEXT (OBS-4b) — the TYPE action that typed the value (matched by selector) gets `value` → `{{NAME}}`.
 *   • OPTION (OBS-4c) — two dropdown styles. A custom <li role=option> CLICK becomes a CLICK_BY_LABEL scoped
 *     to the dropdown CONTAINER (the option selector's parent) with `value` → `{{NAME}}`: re-choosing finds the
 *     option by LABEL in the open container (the landmarkRef is dropped — the target is the label). A native
 *     <select> SELECT just gets `value` → `{{NAME}}`, like a text input. An option whose CLICK has no derivable
 *     container stays literal (param `used:false`, surfaced fixed).
 * The demonstrated value stays on each param as its DEFAULT, so a no-override replay reproduces the demo.
 * Returns NEW phases (originals untouched) and the params enriched with a unique `name`, a `used` flag, and
 * (for templated options) the `container` selector.
 * @param {Array<{label:string, actions:object[]}>} phases
 * @param {Array<{key:string,label:string,kind:string,value:string,selector:(string|null)}>} params
 * @returns {{phases:Array, params:Array<{key,label,kind,value,selector,name,used,container?}>}}
 */
export function parameterizeObserved(phases, params) {
  const ps = (Array.isArray(params) ? params : []).map((p) => ({ ...p, name: obsParamName(p.key), used: false }));
  // Dedupe placeholder names (two fields could slug to the same NAME) — append _2, _3…
  const seenName = new Set();
  for (const p of ps) { let nm = p.name, n = 2; while (seenName.has(nm)) nm = `${p.name}_${n++}`; seenName.add(nm); p.name = nm; }
  // Index params by selector: TEXT → TYPE substitution; OPTION → CLICK_BY_LABEL (custom) or SELECT-value
  // (native). The container is derived per-action, only for the CLICK (custom dropdown) case.
  const textBySel = new Map();
  const optBySel = new Map();
  for (const p of ps) {
    if (!p.selector) continue;
    if (p.kind === 'text') textBySel.set(p.selector, p);
    else if (p.kind === 'option') optBySel.set(p.selector, p);
  }
  const outPhases = (Array.isArray(phases) ? phases : []).map((ph) => ({
    ...ph,
    actions: (Array.isArray(ph.actions) ? ph.actions : []).map((a) => {
      if (!a || !a.selector) return a;
      if (a.action === 'TYPE' && textBySel.has(a.selector)) {
        const p = textBySel.get(a.selector); p.used = true;
        return { ...a, value: `{{${p.name}}}` };
      }
      if (optBySel.has(a.selector)) {
        const p = optBySel.get(a.selector);
        if (a.action === 'SELECT') {                  // native <select> — substitute the value
          p.used = true;
          return { ...a, value: `{{${p.name}}}` };
        }
        if (a.action === 'CLICK') {                   // custom dropdown — find-by-label in the open container
          const container = optionContainerSelector(p.selector);
          if (container) { p.container = container; p.used = true; return { action: 'CLICK_BY_LABEL', selector: container, value: `{{${p.name}}}` }; }
        }
      }
      return a;
    }),
  }));
  return { phases: outPhases, params: ps };
}

/**
 * ORCH-D — assemble the STRUCTURED input describeTrace consumes, so the description is a faithful projection of
 * the capability's STRUCTURE (its phases, the kind of each step, and its params with example values + option
 * vocabularies) rather than a loose text guess. PURE. Feeding structure (not a transcript) minimizes drift and
 * lets the model treat the demonstrated values as EXAMPLE inputs, not fixed text. Runs on the parameterized
 * phases (so a templated step reads as "choose an option" / "type a value", not the literal demo value).
 * @param {Array<{label:string, actions:object[]}>} phases  parameterized phases (post-parameterizeObserved)
 * @param {Array<{label,name,kind,value,vocabulary?,used}>} params
 * @returns {{phases:Array<{phase:number,label:string,steps:string[]}>, params:Array}}
 */
export function describeTraceInput(phases, params) {
  const ph = (Array.isArray(phases) ? phases : []).map((p, i) => ({
    phase: i + 1,
    label: (p && p.label) || '',
    steps: (Array.isArray(p && p.actions) ? p.actions : []).filter((a) => a && a.action !== 'SCROLL_TO').map((a) => {
      const at = (a.landmark && a.landmark.accessibleName) || a.selector || '';
      switch (a.action) {
        case 'TYPE': return `type into “${at}”`;
        case 'CLICK_BY_LABEL': return `choose an option in “${a.selector}”`;
        case 'SELECT': return `select a value in “${at}”`;
        case 'CLICK': return `click “${at}”`;
        case 'KEY': return `press ${a.value || 'Enter'}`;
        default: return String(a.action || '');
      }
    }),
  }));
  const ps = (Array.isArray(params) ? params : []).filter((p) => p && p.used).map((p) => ({
    label: p.label || p.name, kind: p.kind, example: p.value,
    ...(Array.isArray(p.vocabulary) && p.vocabulary.length ? { options: p.vocabulary } : {}),
  }));
  return { phases: ph, params: ps };
}

/** OBS-3 — turn a segmented op into the per-phase {label, url, actions} the capability builder consumes.
 *  `url` is the page the phase's steps happened on (its `from`) — needed to mint per-page landmark UIDs,
 *  since a demonstration spans pages (search on the homepage, filter on the results). PURE. */
export function opToPhases(op) {
  const nodes = (op && Array.isArray(op.nodes)) ? op.nodes : [];
  return nodes.filter((n) => n && n.type === 'fragment').map((n) => ({
    label: n.label,
    url: n.from || (Array.isArray(n.steps) && n.steps[0] && n.steps[0].url) || '',
    // OBS-4 — prepend an optional SCROLL_TO before each action so replay reaches an element the user had to
    // scroll to (the demonstration's scrolls don't transfer across viewports; SCROLL_TO is viewport-safe).
    // A SCROLL_TO on a revealed option runs AFTER its disclosure-open action, so order stays correct; an
    // optional miss is harmless (a not-yet-present element is skipped).
    actions: (Array.isArray(n.steps) ? n.steps : []).map(stepToAction).filter(Boolean)
      .flatMap((a) => (a.selector ? [{ action: 'SCROLL_TO', selector: a.selector, optional: true }, a] : [a])),
  }));
}
