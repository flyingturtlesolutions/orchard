// Core/observedSegment.js — OBS-2: segment a demonstration trace into Tier-1 primitives (Fragments).
//
// Path 3, stage O-3. Input: a coalesced RawAction[] (from Core/observedTrace.js). Output: an
// `{ tier:'observed', nodes:[fragment…] }` — the SAME node shape the T2 lowering emits, so OBS-3 feeds it
// straight into buildTier2CapabilityRecords. PURE: no DOM / chrome / LLM (testable in node).
//
// Rules, validated against a live Indeed demonstration (search "support" in Minneapolis, filter by date):
//  1. PRE-CLEAN — drop focus-noise: redundant consecutive clicks on the same element, and a click that is
//     immediately superseded by a type/select on that SAME element (you click a field, then type in it).
//  2. BOUNDARY — `navigate`, `submit`, and `state_change` are TRANSITION markers, not steps. A Fragment = the
//     steps that accumulated before a boundary (the actions that CAUSED the transition — the T2 "fragment is a
//     transition" rule). The boundary is LOGICAL, not physical: a `state_change` marker (the recorder fires it
//     when the intent's content landmark changes + settles after a commit) splits an SPA's search↔filter into
//     two Fragments with NO navigation, exactly as a reload splits an MPA. Consecutive boundaries coalesce.
//  3. LABEL — a heuristic name (disclosure-open name → commit name → first step). OBS-4's describeTrace
//     gives nicer labels later; this keeps it runnable without an LLM.
//
// @module Core/observedSegment

import { featureToProtoLandmark } from './landmark.js';   // OBS (v2.74.764) — reconcile demonstrated elements to grounded Locale features
import { slugUpper } from './slug.js';   // v2.74.940 (CR-D2)
import { isFillableInputSelector } from './postcondition.js';   // v2.74.783 — never synthesize a presence postcondition on a fillable input (precondition-shaped, always-true)

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
        if (b.kind === 'navigate' || b.kind === 'submit' || b.kind === 'state_change') break;   // boundary — keep this click (it's the commit)
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
 * @returns {{tier:'observed', nodes:Array<{type:'fragment', label:string, steps:object[], from:string, to:string, settle?:{selector:string}}>}}
 */
export function segmentTrace(trace) {
  const acts = _preclean(Array.isArray(trace) ? trace.filter(Boolean) : []);
  const nodes = [];
  let cur = [];
  let fromUrl = acts.length ? (acts[0].url || '') : '';
  const flush = (toUrl, settle) => {
    if (!cur.length) return;
    nodes.push({
      type: 'fragment', label: _label(cur), steps: cur, from: fromUrl,
      to: toUrl || (cur[cur.length - 1] && cur[cur.length - 1].url) || '',
      // OBS — an IN-PLACE (SPA) boundary carries the swapped-in container's IDENTITY (the recorder's `state_change`
      // marker target: selector + optional role/accessibleName/text — b5b). It's the in-place success signal: with
      // no URL change there is no `url_matches`, so the settle selector becomes a `selector_present` postcondition
      // (derivePhasePostcondition), and the identity lets accept mint a recoverable outcome landmark (b5).
      ...(settle && settle.selector ? { settle } : {}),
    });
    cur = [];
  };
  for (let i = 0; i < acts.length; i++) {
    const a = acts[i];
    if (a.kind === 'navigate') { flush(a.to || a.url || ''); fromUrl = a.to || a.url || fromUrl; continue; }
    // LOGICAL boundary (SPA): the intent's content landmark changed + settled after a commit, with NO navigation.
    // The steps accumulated since the last boundary CAUSED this change → flush them as a Fragment. An empty buffer
    // (a marker right after an Enter/nav boundary) is a no-op, so redundant markers never mint empty fragments.
    if (a.kind === 'state_change') {
      const u = a.url || (cur.length ? cur[cur.length - 1].url : '') || fromUrl;
      const t = a.target;
      const settle = (t && t.selector)
        ? { selector: String(t.selector), role: t.role || null, accessibleName: t.accessibleName || null, text: t.text || null }
        : null;
      flush(u, settle); fromUrl = u; continue;
    }
    if (a.kind === 'submit') {
      // A submit fires BEFORE the navigation it causes, so its URL is stale. When a navigate follows
      // immediately, let THAT be the boundary (it carries the real target URL); otherwise this is an
      // in-place submit (no navigation) and we flush here.
      if (acts[i + 1] && acts[i + 1].kind === 'navigate') continue;
      flush(a.url || ''); fromUrl = a.url || fromUrl; continue;
    }
    if (a.kind === 'key') {
      // Enter is a step AND a boundary: it submits/navigates, so anything captured AFTER it belongs to the
      // NEXT page (a re-type the user did on the results page would otherwise sit in this fragment and fail
      // when Enter has already torn the page down). Include the Enter, then flush. A navigate that follows
      // (its real target URL) just flushes an already-empty buffer.
      cur.push(a); flush(a.url || ''); fromUrl = a.url || fromUrl; continue;
    }
    cur.push(a);   // includes 'scroll' — kept so a PURE-scroll demo has a step; opToPhases drops INCIDENTAL scrolls
  }
  flush('');   // trailing fragment (a final action with no navigation — e.g. a filter that applied in place)
  return { tier: 'observed', nodes: _dropRedundantRetype(nodes) };
}

// A search demo typically ends by submitting (Enter) and landing on a results page that RE-SHOWS the query in
// its own search box — which the recorder captures as a SECOND TYPE of the SAME value. The Enter-boundary split
// puts that re-type in its own fragment; replaying it just re-types the query into the results-page box (the
// "type runs twice" the user saw). Drop a fragment that is ONLY type step(s) re-typing a value an EARLIER
// fragment already typed — it reproduces nothing. A type with a NEW value (a genuine next-page field) is kept.
function _dropRedundantRetype(nodes) {
  const out = []; const typed = new Set();
  for (const node of (Array.isArray(nodes) ? nodes : [])) {
    const steps = (node && Array.isArray(node.steps)) ? node.steps : [];
    const meaningful = steps.filter((s) => s && s.kind !== 'scroll');
    const types = meaningful.filter((s) => s.kind === 'type' && s.value != null && s.value !== '');
    const onlyTypes = meaningful.length > 0 && meaningful.every((s) => s.kind === 'type');
    if (onlyTypes && types.length > 0 && types.every((s) => typed.has(String(s.value)))) continue;   // redundant re-type
    for (const s of types) typed.add(String(s.value));
    out.push(node);
  }
  return out;
}

// OBS-3 — map a recorded RawAction to the EXECUTABLE action shape (what TemplateWalker runs + what
// buildTier2CapabilityRecords persists). Each step keeps its inline `landmark` (role + accessibleName +
// hierarchicalContext + selector) so replay self-heals via probe-or-recover (SG-LM-3), no registry round
// trip. A `select` that was a click on a custom option (role=option, not a <select>) replays as a CLICK on
// that option; a native <select> change replays as SELECT. PURE.
export function stepToAction(a) {
  if (!a) return null;
  const t = a.target || {};
  // A page SCROLL replays as a window SCROLL_TO to where the viewport settled (no selector → window scroll).
  if (a.kind === 'scroll') {
    const y = t.scrollY;
    return { action: 'SCROLL_TO', value: Number.isFinite(y) ? `${Math.round(y)}px` : 'bottom' };
  }
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
  const add = (base, label, kind, value, selector, vocabulary, containerHint) => {
    let key = _slug(base) || 'param';
    let k = key; let n = 2; while (seen.has(k)) k = `${key}-${n++}`;
    seen.add(k);
    const vocab = (Array.isArray(vocabulary) ? vocabulary.map(String).filter(Boolean) : []);
    const p = { key: k, label: label || base || k, kind, value: value != null ? String(value) : '', selector: selector || null, ...(vocab.length > 1 ? { vocabulary: Array.from(new Set(vocab)) } : {}), ...(containerHint ? { containerHint: String(containerHint) } : {}) };
    out.push(p);
    return p;
  };
  // v2.74.1528 — the RESULT-ROW REUSE: a demonstrated CLICK that SELECTS a search result (its captured row text
  // CONTAINS the value just typed into a search field) is otherwise captured POSITIONALLY (li:nth-of-type(72)) —
  // meaningless on any other search (the live "Navigate to specific list item" failure). Instead of a fixed click
  // (or a new param), the click REUSES the search text-param as a CLICK_BY_LABEL {value} scoped to the results
  // list — so replay re-finds the row by CONTENT. `lastText` carries the pending search param across the
  // search↔results fragment boundary; the first matching click CONSUMES it (one reuse per search).
  let lastText = null;
  for (const node of nodes) {
    if (!node || node.type !== 'fragment') continue;
    let disclosure = null;
    for (const s of (Array.isArray(node.steps) ? node.steps : [])) {
      const name = s.target && s.target.accessibleName;
      const sel = s.target && s.target.selector;
      // ORCH-V — an option choice carries its dropdown's full vocabulary (the closed set the binder classifies
      // against + the datalist the re-run form offers); a typed field has no vocabulary.
      const vocab = s.target && s.target.options;
      if (s.kind === 'type' && s.value != null && s.value !== '') lastText = add(name || 'field', name || 'Field', 'text', s.value, sel);
      else if (s.kind === 'select' && s.value != null && s.value !== '') add(disclosure || name || 'choice', disclosure || name || 'Choice', 'option', s.value, sel, vocab, s.target && s.target.optionContainer);
      // B — a CLICK that carries a captured peer GROUP (a category nav / tablist: ≥3 sibling links/tabs) is a
      // re-bindable OPTION, not a fixed click. The demonstrated label ("Music") is the default; the group is the
      // vocabulary. This collapses N per-category capabilities ("Search for music/vectors/gifs") into ONE with a
      // CATEGORY param. The clicked item is included in `vocab` so the default replay validates.
      else if (s.kind === 'click' && Array.isArray(vocab) && vocab.length >= 3 && s.value != null && s.value !== '')
        add('category', 'Category', 'option', s.value, sel, vocab.includes(s.value) ? vocab : [s.value, ...vocab], s.target && s.target.optionContainer);
      // v2.74.1528 — a result-row click after a search → reuse the search param as a by-label click in the list
      else if (s.kind === 'click' && sel && lastText && lastText.value && _rowContainsValue(s, lastText.value)) {
        lastText.clickReuse = { selector: sel, container: (s.target && s.target.resultContainer) || (s.target && s.target.optionContainer) || optionContainerSelector(sel) || sel };
        lastText = null;
      }
      else if (s.kind === 'click' && _DISCLOSURE_HINT.test(name || '')) disclosure = name;
    }
  }
  return out;
}

// v2.74.1528 — does a demonstrated result-row click's captured text CONTAIN the search value? Matches the ROW's
// text (captured on a repeating-list click, `target.rowText`), else the clicked element's own text / a11y name.
// Case-insensitive; the value must be ≥3 chars so a short value can't match spuriously. PURE.
function _rowContainsValue(step, value) {
  const v = String(value || '').trim().toLowerCase();
  if (v.length < 3) return false;
  const t = (step && step.target) || {};
  const hay = [t.rowText, t.text, t.accessibleName].filter(Boolean).join(' ').toLowerCase();
  return hay.includes(v);
}

/** OBS-4b — placeholder NAME for a param key: UPPER_SNAKE, [A-Z0-9_], bounded — matches the `{{NAME}}` regex
 *  TemplateWalker/InjectionService use (`/\{\{([A-Z0-9_]+)\}\}/`). 'date-posted-filter' → 'DATE_POSTED_FILTER'. */
export function obsParamName(key) {
  return slugUpper(key, { maxLen: 40, fallback: 'PARAM' });   // v2.74.940 (CR-D2) — shared builder
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
  const reuseBySel = new Map();   // v2.74.1528 — a result-row click REUSES a text param as CLICK_BY_LABEL {value}
  for (const p of ps) {
    if (p.clickReuse && p.clickReuse.selector) reuseBySel.set(p.clickReuse.selector, p);
    if (!p.selector) continue;
    if (p.kind === 'text') textBySel.set(p.selector, p);
    else if (p.kind === 'option') optBySel.set(p.selector, p);
  }
  const outPhases = (Array.isArray(phases) ? phases : []).map((ph) => ({
    ...ph,
    actions: (Array.isArray(ph.actions) ? ph.actions : []).map((a) => {
      if (!a || !a.selector) return a;
      // v2.74.1528 — the result-row CLICK → CLICK_BY_LABEL the search value in the results container (the row is
      // re-found by CONTENT, never by the demonstrated position). Checked FIRST so it wins over a stray option map.
      if (a.action === 'CLICK' && reuseBySel.has(a.selector)) {
        const p = reuseBySel.get(a.selector); p.used = true;
        return { action: 'CLICK_BY_LABEL', selector: p.clickReuse.container || a.selector, value: `{{${p.name}}}` };
      }
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
        if (a.action === 'CLICK') {                   // custom dropdown / category nav — find-by-label in the container
          // Prefer the record-time container (the nav/listbox the peer group was found in); fall back to deriving
          // it from the option selector (works when options are direct children, e.g. an Indeed filter list).
          const container = p.containerHint || optionContainerSelector(p.selector);
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
  return nodes.filter((n) => n && n.type === 'fragment').map((n) => {
    const all = Array.isArray(n.steps) ? n.steps : [];
    // A scroll is INCIDENTAL when the phase also has real actions (you scrolled to reach a control — replay
    // reaches it via the per-action SCROLL_TO). But a PURE-scroll phase ("scroll down the page") IS the scroll,
    // so keep it. (deriveObservedParams + landmark build ignore scroll steps.)
    const nonScroll = all.filter((s) => s && s.kind !== 'scroll');
    const steps = nonScroll.length ? nonScroll : all;
    return {
      label: n.label,
      url: n.from || (all[0] && all[0].url) || '',
      to: n.to || '',   // the post-phase URL — a NAVIGATING phase's success signal (→ a url_matches postcondition)
      settleSelector: (n.settle && n.settle.selector) || '',   // an IN-PLACE phase's signal (→ a selector_present postcondition)
      settleLandmark: n.settle || null,                        // b5b — the swap region's identity (selector + role/name/text) for a recoverable outcome landmark
      // OBS-4 — prepend an optional SCROLL_TO before each ELEMENT action so replay reaches a control the user
      // had to scroll to (viewport-safe; an optional miss is harmless). A window SCROLL_TO (no selector) emits
      // as-is.
      actions: steps.map(stepToAction).filter(Boolean)
        .flatMap((a) => (a.selector ? [{ action: 'SCROLL_TO', selector: a.selector, optional: true }, a] : [a])),
    };
  });
}

const _RX_META = /[.*+?^${}()|[\]\\]/g;   // escape a literal path so it's a safe url_matches regex

/**
 * OBS (v2.74.763) — derive a Fragment's success POSTCONDITION from its page-state boundary. PURE. A Fragment is
 * gated by a page-state change, and that change IS the observable success signal the structural floor often can't
 * see (the result region lives past the boundary):
 *   • NAVIGATION (to ≠ url) → the destination PATH is reliable → a `url_matches` postcondition (source 'url-nav').
 *   • IN-PLACE SPA swap (no URL change, but the recorder captured the swapped-in container) → assert that
 *     container is present → a `selector_present` postcondition (source 'spa-settle') — the in-place analog.
 *   • Otherwise → null (the demo's structural floor / any LLM-refined postcondition still applies).
 * Returns the envelope { match:'all', conditions:[…], source } (the array shape ExecutionEngine reads) or null.
 * Shared by the demonstration accept (DERIVE_OBSERVED) so the nav and in-place rules can't drift.
 * @param {{url?:string, to?:string, settleSelector?:string}} phase
 * @returns {({match:'all', conditions:object[], source:string})|null}
 */
export function derivePhasePostcondition(phase) {
  const url = (phase && phase.url) || '';
  const to = (phase && phase.to) || '';
  const settleSelector = (phase && phase.settleSelector) || '';
  // A real navigation: the destination path is the signal. A '/' (or unparseable) destination tells us nothing.
  if (to && url && to !== url) {
    try {
      const navPath = new URL(to).pathname;
      if (navPath && navPath !== '/') {
        return { match: 'all', conditions: [{ type: 'url_matches', pattern: navPath.replace(_RX_META, '\\$&') }], source: 'url-nav' };
      }
    } catch { /* unparseable destination → no url signal */ }
    return null;   // navigated, but no usable path → don't fall through to a settle selector (there is none post-nav)
  }
  // In-place (SPA) commit: no URL change, but the swapped-in results container settled → assert its presence.
  // v2.74.783 — UNLESS the recorder's "settle" container resolved to a FILLABLE INPUT (e.g. on Indeed the most-
  // changed subtree was the search box itself). A presence check on an input is precondition-shaped — true before
  // AND after the search — so it would make the Fragment un-repeatable (the runtime skips when it "already holds").
  // In that case emit NO postcondition (null): the structural floor / any LLM-refined success signal applies, and
  // the runtime never wrongly short-circuits a re-search.
  if (settleSelector && typeof settleSelector === 'string' && !isFillableInputSelector(settleSelector)) {
    return { match: 'all', conditions: [{ type: 'selector_present', selector: settleSelector }], source: 'spa-settle' };
  }
  return null;
}

// Same page (origin + pathname), ignoring query/hash — the demo's phase url may carry session/query noise the
// grounded Locale url doesn't. A bad parse fails closed (no reconciliation rather than a wrong match).
function _sameLocalePath(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  try { const ua = new URL(a), ub = new URL(b); return ua.origin === ub.origin && ua.pathname === ub.pathname; }
  catch { return false; }
}
function _localeFeatureList(loc) {
  const f = loc && loc.features;
  return Array.isArray(f) ? f.filter(Boolean) : (f && typeof f === 'object' ? Object.values(f).filter(Boolean) : []);
}
// Match a demonstrated landmark to a grounded feature: exact selector first (page-specific, strongest), then
// role + accessibleName (identity-robust — survives selector drift between the recorder and Explore captures).
function _matchLocaleFeature(lm, feats) {
  const sel = lm && lm.selector;
  if (sel) { const bySel = feats.find((f) => f.selector && f.selector === sel); if (bySel) return bySel; }
  const role = String((lm && lm.role) || '').toLowerCase();
  const name = String((lm && lm.accessibleName) || '').trim().toLowerCase();
  if (role && name) return feats.find((f) => String(f.a11yRole || '').toLowerCase() === role && String(f.label || '').trim().toLowerCase() === name) || null;
  return null;
}

/**
 * OBS (v2.74.764) — RECONCILE demonstrated landmarks to the grounded Locale catalog. PURE.
 *
 * The observed/chat path derives each landmark's identity from the RAW demonstration (the recorder's
 * runtime selector + captured role/name). That identity is content-addressed into the landmark uid
 * (mintLandmarkUid hashes ground|locale|role|name|selector), so a run-to-run selector difference, OR a
 * difference from the selector Explore already grounded for the SAME element, mints a DIFFERENT uid → a
 * DUPLICATE landmark for one logical element (silent registry fragmentation). The SG-trial/NL path avoids
 * this because it sources identity from the Locale feature (bind.js → featureToProtoLandmark); the observed
 * path is the only one that bypasses the Locale. This pass closes that gap: for each demonstrated landmark
 * that matches a grounded feature on the SAME page, adopt the feature's canonical identity (the vetted
 * Explore selector + role + name, via featureToProtoLandmark) and stamp its `featureId`. Downstream uid
 * minting (buildLandmarkRecords + landmarkRefActions) then collides on the catalog identity → reuse, not a
 * duplicate. Elements the Locale doesn't know (e.g. a results region never enumerated) keep the demo identity.
 *
 * Conservative: only reconciles within a Locale whose url is the SAME page (origin+pathname) as the phase, so
 * a "Search" button on page A can't be mis-bound to one on page B. No locale for the page → that phase is left
 * untouched (no regression — just no dedup).
 *
 * @param {Array<{url?:string, actions?:object[]}>} phases  opToPhases output (actions carry inline `landmark`)
 * @param {Array<{url?:string, features?:(object|object[])}>} locales  grounded Locales: { url, features }
 * @returns {{ phases:object[], reconciled:number, total:number }}
 */
export function reconcileObservedLandmarks(phases, locales) {
  const phaseList = Array.isArray(phases) ? phases : [];
  const locList = Array.isArray(locales) ? locales.filter(Boolean) : [];
  if (!locList.length) return { phases: phaseList, reconciled: 0, total: 0 };
  let reconciled = 0, total = 0;
  const out = phaseList.map((ph) => {
    const loc = locList.find((l) => _sameLocalePath(l.url, ph && ph.url));
    if (!loc) return ph;
    const feats = _localeFeatureList(loc);
    if (!feats.length) return ph;
    const actions = (Array.isArray(ph.actions) ? ph.actions : []).map((a) => {
      if (!a || !a.landmark) return a;
      total++;
      const feat = _matchLocaleFeature(a.landmark, feats);
      if (!feat) return a;
      const canon = featureToProtoLandmark(feat);
      if (!canon || !canon.selector || !canon.role) return a;   // not recoverable → leave the demo identity
      reconciled++;
      return {
        ...a,
        landmark: {
          ...a.landmark,
          role: canon.role,
          accessibleName: canon.accessibleName,
          selector: canon.selector,
          hierarchicalContext: canon.hierarchicalContext || a.landmark.hierarchicalContext || null,
          featureId: feat.id || null,   // explicit catalog link (future exact-dedup + traceability)
        },
      };
    });
    // Canonicalize the MINT url to the grounded Locale url (no query/hash noise): mintLandmarkUid also hashes the
    // localeUrl, so two demos of the same element on /jobs?q=a vs /jobs?q=b would otherwise fork the uid. `localeUrl`
    // is consumed only by uid minting (buildLandmarkRecords / landmarkRefActions); the phase's `url`/`to` stay raw
    // for postcondition derivation.
    return { ...ph, localeUrl: loc.url || ph.url, actions };
  });
  return { phases: out, reconciled, total };
}
