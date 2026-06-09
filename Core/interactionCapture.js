// Core/interactionCapture.js — C2a: the PURE shaping + privacy core of L0 interaction capture
// (monitoring / Track phase, DESIGN_interaction_monitoring.md §4). No chrome / DOM — the live
// content-script listeners (C2b) extract DOM bits and post them; THIS module shapes/validates the
// RawInteraction in the background, where the privacy invariants are enforced in ONE tested place.
//
// PRIVACY INVARIANT (load-bearing): a RawInteraction NEVER carries a typed VALUE — only inputType +
// lengthDelta. makeRawInteraction structurally cannot emit a value, so a content-script bug can't leak one.

import { mintEventId } from './outcomes.js';
import { INTERACTION_KINDS } from './interactionClassification.js';   // share ONE interaction vocabulary

export const CAPTURE_SCHEMA = 1;

const MAX_CLASSLIST = 8;
const MAX_NAME = 120;

/** DOM event type → the bounded `interactionKind` vocabulary. Unknown → null (drop). */
const DOM_EVENT_KIND = Object.freeze({
  click: 'click', auxclick: 'click', dblclick: 'dblclick',
  input: 'type', submit: 'submit', focusin: 'focus', focusout: 'blur',
});
export function domEventToKind(domType) {
  return DOM_EVENT_KIND[String(domType || '').toLowerCase()] ?? null;
}

/** A field whose VALUE (and even length) must never be captured. */
export function isSensitiveTarget(target) {
  const t = target || {};
  const type = String(t.type || t.inputType || '').toLowerCase();
  if (type === 'password') return true;
  const ac = String(t.autocomplete || '').toLowerCase();
  if (/\b(one-time-code|current-password|new-password|cc-number|cc-csc|cc-exp)\b/.test(ac)) return true;
  if (String(t.role || '').toLowerCase() === 'password-input') return true;
  return false;
}

/**
 * Shape + validate a RawInteraction (DESIGN_interaction_monitoring §4.2). PURE shaping (DOM/chrome-free,
 * node-testable); the auto-minted `id` (mintEventId) is the only non-deterministic bit — an event id is
 * meant to be unique, not reproducible; pass `id` for a fully deterministic result. The background calls
 * this on every `INTERACTION_RAW` from a content-script listener.
 * Returns null for an unknown `interactionKind` (caller drops). NEVER emits a typed value.
 * @param {object} parts { interactionKind, ts, tabId, frameId, url, target:{tagName,id?,classList?,role?,accessibleName?,type?},
 *                         click?:{button,clientX,clientY,modifiers}, type?:{inputType,lengthDelta}, navigate?:{fromUrl,toUrl,transitionType}, id? }
 * @returns {object|null} RawInteraction
 */
export function makeRawInteraction(parts = {}) {
  const interactionKind = String((parts && parts.interactionKind) || '');
  if (!INTERACTION_KINDS.includes(interactionKind)) return null;
  const ts = Number.isFinite(parts.ts) ? parts.ts : 0;
  const tabId = Number.isFinite(parts.tabId) ? parts.tabId : -1;
  const frameId = Number.isFinite(parts.frameId) ? parts.frameId : 0;
  const t = parts.target || {};
  const target = { tagName: String(t.tagName || '').toLowerCase() };
  if (t.id) target.id = String(t.id).slice(0, 64);
  if (Array.isArray(t.classList) && t.classList.length) target.classList = t.classList.slice(0, MAX_CLASSLIST).map(String);
  if (t.role) target.role = String(t.role).slice(0, 40);
  if (t.accessibleName) target.accessibleName = String(t.accessibleName).slice(0, MAX_NAME);

  const out = {
    id: (parts.id && String(parts.id)) || mintEventId(`${ts}|${tabId}|${frameId}|${interactionKind}`),
    ts, tabId, frameId,
    url: String(parts.url || ''),
    interactionKind,
    target,
    schema: CAPTURE_SCHEMA,
  };

  if ((interactionKind === 'click' || interactionKind === 'dblclick') && parts.click) {
    const c = parts.click;
    out.click = {
      button: Number(c.button) || 0,
      clientX: Number(c.clientX) || 0,
      clientY: Number(c.clientY) || 0,
      modifiers: Array.isArray(c.modifiers) ? c.modifiers.map(String) : [],
    };
  }
  if (interactionKind === 'type' && parts.type) {
    const ty = parts.type;
    const typeOut = {};   // PRIVACY: inputType + lengthDelta ONLY — a `value` is structurally impossible here.
    if (ty.inputType) typeOut.inputType = String(ty.inputType).slice(0, 40);
    if (Number.isFinite(ty.lengthDelta) && !isSensitiveTarget({ ...t, inputType: t.type })) typeOut.lengthDelta = ty.lengthDelta;
    out.type = typeOut;
  }
  if (interactionKind === 'navigate' && parts.navigate) {
    const n = parts.navigate;
    out.navigate = { toUrl: String(n.toUrl || '') };
    if (n.fromUrl) out.navigate.fromUrl = String(n.fromUrl);
    if (n.transitionType) out.navigate.transitionType = String(n.transitionType);
  }
  return out;
}

/**
 * Enrich the C1 demand set with selectors so the content-script listener (C2b) can hit-test live
 * targets (`event.target.closest(selector)`). Drops demand rows whose landmark has no selector. PURE.
 * @param {Array<{landmarkUid:string, interactionKinds:string[]}>} demand
 * @param {Map<string,string>|Object<string,string>} selectorByUid
 * @returns {Array<{landmarkUid:string, selector:string, interactionKinds:string[]}>}
 */
export function toCaptureTargets(demand, selectorByUid) {
  const sel = selectorByUid instanceof Map ? selectorByUid : new Map(Object.entries(selectorByUid || {}));
  const out = [];
  for (const d of Array.isArray(demand) ? demand : []) {
    const uid = d && typeof d.landmarkUid === 'string' ? d.landmarkUid : '';
    const selector = uid ? sel.get(uid) : null;
    if (!selector) continue;
    out.push({ landmarkUid: uid, selector: String(selector), interactionKinds: Array.isArray(d.interactionKinds) ? d.interactionKinds.slice() : [] });
  }
  return out;
}
