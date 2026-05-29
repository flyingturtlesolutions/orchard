// Sidepanel/modes/perspective-capture/sg-library.js
//
// SG-LM-6 — the cross-session capability library, extracted from the perspective-capture monolith
// (code_review_2.74.605 §5 R5 seed). Lists a Ground's accepted substrate-grounded capabilities and
// re-runs them via REPLAY_SG_CAPABILITY (no LLM; the saved Strategy self-heals selectors through
// landmark recovery).
//
// Self-contained: owns its state, talks to the background by message, and asks the host UI to re-render
// through the injected `rerender`. The host wires it into the perspective panel via render()/wire().
// escHtml/escAttr come from the CANONICAL shared.js (review D1), not a local copy.

import { escHtml, escAttr } from '../../../shared.js';

/**
 * @param {object} ctx
 * @param {() => (string|null)} ctx.getGroundId  current Ground id (null when none)
 * @param {() => (number|null)} ctx.getTabId     capture tab id
 * @param {() => void}          ctx.rerender      re-render the host panel
 */
export function createSgLibrary({ getGroundId, getTabId, rerender } = {}) {
  let capabilities = [];
  let loadedFor = null;    // groundId the list was loaded for (lazy, once per ground)
  let loading = false;
  let replay = {};         // capId → { inFlight:boolean, result:object|null }

  // The no-LLM re-run outcome line. Strategy replay returns { ok }; the binding fallback returns a trial.
  const renderReplayNote = (r) => {
    if (!r) return '';
    if (r.success === false) return `<div class="dbg-perspective-ground-note">⚠ Re-run failed: ${escHtml(r.error || 'unknown')}</div>`;
    if (r.ran === false) return `<div class="dbg-perspective-ground-note">∅ Re-run: ${escHtml(r.reason || 'nothing ran')}</div>`;
    if (r.via === 'strategy') return r.ok
      ? `<div class="dbg-perspective-ground-note">↻ re-ran the saved capability — ok (no LLM, landmark recovery)</div>`
      : `<div class="dbg-perspective-ground-note">⚠ Re-run failed: ${escHtml(r.reason || 'a step failed')}</div>`;
    const v = r.trial || {};
    const pct = (typeof v.score === 'number') ? ` (${Math.round(v.score * 100)}%)` : '';
    return `<div class="dbg-perspective-ground-note">↻ re-ran with no LLM — verdict <b>${escHtml(String(v.verdict || '?'))}</b>${pct}</div>`;
  };

  async function load() {
    const groundId = getGroundId?.();
    if (!groundId || loading) return;
    loading = true;
    let res;
    try { res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'GET_SG_CAPABILITIES', payload: { groundId } }, r)); }
    catch { res = null; }
    loading = false;
    loadedFor = groundId;
    capabilities = (res && res.success && Array.isArray(res.capabilities)) ? res.capabilities : [];
    rerender?.();
  }

  async function onReplay(capId) {
    const groundId = getGroundId?.();
    if (!capId || !groundId || replay[capId]?.inFlight) return;
    replay[capId] = { inFlight: true, result: null }; rerender?.();
    let res;
    try {
      res = await new Promise((r) => chrome.runtime.sendMessage({
        type: 'REPLAY_SG_CAPABILITY', payload: { tabId: getTabId?.(), groundId, capabilityId: capId },
      }, r));
    } catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
    replay[capId] = { inFlight: false, result: res || { success: false, error: 'no result' } };
    rerender?.();
  }

  return {
    /** Clear all state (host session reset / unmount). */
    reset() { capabilities = []; loadedFor = null; loading = false; replay = {}; },
    /** Force a reload on next render (e.g. after a fresh accept adds a capability). */
    invalidate() { loadedFor = null; },
    /** The "Saved capabilities" section HTML — empty until loaded / when there are none. */
    render() {
      const groundId = getGroundId?.();
      if (!groundId || loadedFor !== groundId || !capabilities.length) return '';
      let html = `<div class="dbg-perspective-caplib"><div class="dbg-perspective-caplib-title">Saved capabilities (${capabilities.length})</div>`;
      for (const cap of capabilities) {
        const n = Array.isArray(cap.landmarkUids) ? cap.landmarkUids.length : 0;
        const verdict = cap.trial?.verdict || '?';
        const rep = replay[cap.id] || {};
        const btn = rep.inFlight
          ? `<button class="btn-secondary tiny" type="button" disabled>⏳ Running…</button>`
          : `<button class="btn-secondary tiny" data-perspective-action="replay-saved-cap" data-cap="${escAttr(cap.id)}" type="button" title="Re-run this saved capability on the current page — no LLM; landmarks self-heal a stale selector.">▶ Re-run</button>`;
        html += `<div class="dbg-perspective-caplib-item">
            <div class="dbg-perspective-caplib-head"><span class="dbg-perspective-caplib-intent">${escHtml(cap.intent || cap.id)}</span>${btn}</div>
            <div class="dbg-perspective-caplib-meta">${escHtml(cap.shape || 'act')} · ${n} landmark(s) · ${escHtml(String(verdict))}${cap.strategyId ? ' · strategy' : ''}</div>
            ${renderReplayNote(rep.result)}
          </div>`;
      }
      html += `</div>`;
      return html;
    },
    /** Lazily load the list (once per ground) + attach the per-capability re-run handlers. */
    wire(container) {
      if (!container) return;
      const groundId = getGroundId?.();
      if (groundId && loadedFor !== groundId && !loading) load();
      container.querySelectorAll('[data-perspective-action="replay-saved-cap"]').forEach((b) =>
        b.addEventListener('click', () => onReplay(b.getAttribute('data-cap'))));
    },
  };
}
