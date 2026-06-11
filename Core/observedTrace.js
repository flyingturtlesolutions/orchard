// Core/observedTrace.js — OBS-1: the observed-demonstration trace (pure schema + transforms).
//
// Path 3 (observed perspectives): the user DEMONSTRATES a task; we record each action as a RawAction
// carrying the acted element's identity (the proto-landmark inputs). This module is the PURE half — the
// schema, value scrubbing, action-kind classification, and consecutive-typing coalescing. The content
// script extracts the DOM identity + raw value and posts the parts; the background calls buildRawAction
// (scrub + classify) and buffers the trace. No DOM / chrome / LLM here (testable in node).
//
// Downstream (OBS-2/3): coalesce(trace) → segment into Fragments → buildTier2CapabilityRecords (SG-T2-ACC).
//
// @module Core/observedTrace

// `state_change` is a LOGICAL boundary marker (not a user action): the recorder emits it when the intent's
// content landmark changes + settles after a commit with NO navigation (an SPA XHR swap). The segmenter treats
// it like a navigation — so search↔filter splits into two Fragments on an SPA exactly as a reload does on an MPA.
export const OBSERVED_KINDS = Object.freeze(['click', 'type', 'select', 'submit', 'navigate', 'scroll', 'key', 'state_change']);

// Field name/type/autocomplete patterns that mark a value SENSITIVE — never store the raw value. The
// content script ALSO checks this (mirrored) so a sensitive value never leaves the page; this is the
// defensive second gate at the buffering layer.
const _SENSITIVE = /pass(word|code)|(^|[^a-z])pin([^a-z]|$)|\bssn\b|social.?security|credit.?card|card.?number|(^|[^a-z])cc-?(num|number|csc|cvv|cvc)|security.?code|\bcvv\b|\bcvc\b|account.?number|routing.?number/i;
export const REDACTED = '«redacted»';

/** Is this captured target a sensitive field (by type / name / id / autocomplete / class)? PURE. */
export function isSensitiveField(target) {
  if (!target || typeof target !== 'object') return false;
  const t = String(target.inputType || target.type || '').toLowerCase();
  if (t === 'password') return true;
  const hay = [target.name, target.id, target.accessibleName, target.autocomplete]
    .concat(Array.isArray(target.classList) ? target.classList : [])
    .filter(Boolean).join(' ');
  return _SENSITIVE.test(hay);
}

/** Scrub a captured value: sensitive → REDACTED; otherwise stringify + length-cap. PURE. */
export function scrubValue(value, target) {
  if (isSensitiveField(target)) return REDACTED;
  if (value == null) return null;
  return String(value).slice(0, 300);
}

/** Map a DOM event kind + target to the observed action vocabulary. PURE. */
export function classifyKind(domKind, target) {
  switch (domKind) {
    case 'submit': return 'submit';
    case 'navigate': return 'navigate';
    case 'state_change': return 'state_change';   // logical (SPA) boundary marker
    case 'scroll': return 'scroll';
    case 'keypress': return 'key';
    case 'change':
    case 'input': {
      const tag = String((target && target.tagName) || '').toLowerCase();
      return tag === 'select' ? 'select' : 'type';
    }
    case 'click':
    default: {
      // a click on an option / radio / checkbox is a value SELECT, not a plain click
      const role = String((target && target.role) || '').toLowerCase();
      if (/^(option|menuitemradio|menuitemcheckbox|radio|checkbox|tab|treeitem|switch)$/.test(role)) return 'select';
      const tag = String((target && target.tagName) || '').toLowerCase();
      const type = String((target && (target.inputType || target.type)) || '').toLowerCase();
      if (tag === 'input' && (type === 'radio' || type === 'checkbox')) return 'select';
      return 'click';
    }
  }
}

/**
 * Assemble a clean RawAction from already-extracted parts (the content script does the DOM extraction). PURE.
 * @param {{seq?:number, ts?:number, url?:string, frameId?:number, domKind:string, target?:object, value?:any, from?:string}} parts
 * @returns {object} RawAction
 */
export function buildRawAction(parts) {
  const p = parts || {};
  const target = p.target || {};
  const kind = classifyKind(p.domKind, target);
  const action = {
    seq: p.seq | 0,
    ts: p.ts || 0,
    url: String(p.url || ''),
    frameId: p.frameId | 0,
    kind,
    target: {
      tagName: target.tagName || null,
      role: target.role || null,
      accessibleName: target.accessibleName ? String(target.accessibleName).slice(0, 120) : null,
      selector: target.selector || null,
      hierarchicalContext: target.hierarchicalContext || null,
      // OBS-3b — record-time identity (the NL path profiles live post-accept; a demo can't be re-profiled)
      rect: target.rect || null,
      text: target.text ? String(target.text).slice(0, 140) : null,
      attrs: (target.attrs && typeof target.attrs === 'object') ? target.attrs : null,
      scrollY: Number.isFinite(target.scrollY) ? target.scrollY : undefined,
      // ORCH-V — the dropdown's full option vocabulary (only set on an option click / native <select> change).
      options: Array.isArray(target.options) ? target.options.slice(0, 60).map((s) => String(s).slice(0, 80)) : undefined,
      // B — the SELECTOR of the container the peer group was found in (the nav/listbox), so CLICK_BY_LABEL
      // re-binds by searching the whole set, not the single demonstrated item's li (which holds only one label).
      optionContainer: target.optionContainer ? String(target.optionContainer).slice(0, 400) : undefined,
    },
  };
  if (kind === 'type' || kind === 'select') action.value = scrubValue(p.value, target);
  // A click that carries a captured peer GROUP (category nav / tablist) keeps its label as the value, so
  // deriveObservedParams can lift it into a re-bindable option (B: parameterize the category from the group).
  if (kind === 'click' && Array.isArray(target.options) && target.options.length >= 3) action.value = scrubValue(p.value != null ? p.value : target.accessibleName, target);
  if (kind === 'key') action.value = p.value ? String(p.value).slice(0, 20) : 'Enter';   // the key name (never sensitive)
  if (p.domKind === 'navigate') { action.from = p.from ? String(p.from) : null; action.to = String(p.url || ''); }
  return action;
}

/**
 * Coalesce CONSECUTIVE `type` actions on the SAME element into one (keeping the final value) — debounce a
 * burst of keystrokes into a single TYPE — and drop a navigate that merely repeats the prior URL. PURE;
 * returns a NEW array, re-sequenced.
 *
 * ORDER FIX: actions are first STABLE-SORTED by `ts` (the event timestamp the content script stamps when the
 * event fires) — NOT by the background's arrival order. `chrome.runtime.sendMessage` doesn't guarantee delivery
 * order, so a keydown(Enter) fired right after the final input keystroke can RACE ahead of the input message
 * and be sequenced first → "Enter before type" → the capability submits before it fills the field. Sorting by
 * event time restores the true order; ties keep arrival order (stable).
 */
export function coalesce(actions) {
  const arr = (Array.isArray(actions) ? actions.filter(Boolean) : [])
    .map((a, i) => ({ a, i }))
    .sort((x, y) => ((x.a.ts || 0) - (y.a.ts || 0)) || (x.i - y.i))
    .map((x) => x.a);
  const out = [];
  for (const a of arr) {
    const prev = out[out.length - 1];
    if (prev && a.kind === 'type' && prev.kind === 'type'
        && a.target && prev.target && a.target.selector && a.target.selector === prev.target.selector) {
      out[out.length - 1] = { ...prev, value: a.value, ts: a.ts };       // keep the latest typed value
      continue;
    }
    if (prev && a.kind === 'navigate' && prev.kind === 'navigate' && a.to === prev.to) continue;   // duplicate nav
    if (prev && a.kind === 'state_change' && prev.kind === 'state_change') continue;   // one boundary per settle, not per mutation
    if (prev && a.kind === 'state_change' && (prev.kind === 'navigate' || prev.kind === 'submit')) continue;   // a nav already split here — the swap marker is redundant
    if (prev && a.kind === 'scroll' && prev.kind === 'scroll') { out[out.length - 1] = { ...a }; continue; }   // collapse a scroll run to the latest
    out.push(a);
  }
  return out.map((a, i) => ({ ...a, seq: i }));
}
