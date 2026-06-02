// Sidepanel/modes/perspective-capture/sg-trial.js
//
// SG-LM (code_review_2.74.605 R5 seed, companion to sg-library.js) — the in-session substrate-grounded
// TRIAL flow, extracted from the perspective-capture monolith: the synthesized plan summary, the live
// "▶ Run on page" outcome (RUN_SG_TRIAL), Accept (→ durable capability) / Reject, and the no-LLM
// ▶ Re-run of the just-saved capability.
//
// Self-contained: owns its state, talks to the background by message, asks the host to re-render via the
// injected `rerender`, and tells the host to refresh the library after an accept via `afterAccept`.

import { escHtml } from '../../../shared.js';
import { toast } from '../../shell-api.js';

/**
 * @param {object} ctx
 * @param {() => (string|null)} ctx.getGroundId
 * @param {() => (number|null)} ctx.getTabId
 * @param {() => string}        ctx.getIntent     the raw intent text (verbatim)
 * @param {() => void}          ctx.rerender      re-render the host panel
 * @param {() => void}          [ctx.afterAccept] called after a successful accept (e.g. refresh the library)
 */
export function createSgTrial({ getGroundId, getTabId, getIntent, rerender, afterAccept } = {}) {
  let plan = null;             // synthesized fill plan from GROUND_INTENT (cover + steps + deferred/skipped)
  let tier2Inspect = false;    // SG-T2-6 — when on, ▶ Run lowers the intent and returns the Tier-2 plan (no execution)
  let trialInFlight = false;
  let trialResult = null;      // RUN_SG_TRIAL outcome
  let acceptInFlight = false;
  let capabilityResult = null; // saved capability after Accept
  let rejected = false;
  let replayInFlight = false;
  let replayResult = null;

  // OBS-1 — demonstration recorder (Path 3): independent of the intent plan. Record a session, stop, see the
  // raw action trace (the basis for deriving a capability in OBS-3). Polls a live count while recording.
  let recording = false;
  let recordTrace = null;
  let recordCount = 0;
  let _recPoll = null;
  const _recStopPoll = () => { if (_recPoll) { clearInterval(_recPoll); _recPoll = null; } };
  const onRecordToggle = async () => {
    if (!recording) {
      try { await new Promise((r) => chrome.runtime.sendMessage({ type: 'RECORD_START_SESSION', payload: { tabId: getTabId?.() } }, r)); } catch { /* */ }
      recording = true; recordCount = 0; recordTrace = null;
      _recStopPoll();
      _recPoll = setInterval(() => {
        chrome.runtime.sendMessage({ type: 'GET_RECORDING' }, (res) => { if (res && typeof res.count === 'number' && res.count !== recordCount) { recordCount = res.count; rerender?.(); } });
      }, 1500);
      rerender?.();
    } else {
      _recStopPoll();
      let res = null;
      try { res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RECORD_STOP_SESSION' }, r)); } catch { /* */ }
      recording = false; recordTrace = (res && Array.isArray(res.trace)) ? res.trace : []; recordCount = recordTrace.length;
      rerender?.();
    }
  };
  const _recordHtml = () => {
    if (recording) return `<div class="dbg-perspective-ground-note">● recording demonstration — ${recordCount} action(s) captured…</div>`;
    if (recordTrace && recordTrace.length) {
      const kinds = recordTrace.reduce((m, a) => { m[a.kind] = (m[a.kind] || 0) + 1; return m; }, {});
      const sum = Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ');
      const lines = recordTrace.slice(0, 12).map((a, i) => `${i + 1}. <b>${escHtml(a.kind)}</b> ${escHtml(a.target?.accessibleName || a.target?.selector || a.to || '')}${a.value != null ? ` = ${escHtml(String(a.value).slice(0, 40))}` : ''}`);
      const more = recordTrace.length > 12 ? `<br>… +${recordTrace.length - 12} more` : '';
      return `<div class="dbg-perspective-ground-note">▣ demonstration captured — ${recordTrace.length} action(s) (${escHtml(sum)}):<br>${lines.join('<br>')}${more}</div>`;
    }
    return '';
  };

  const _resetTrial = () => { trialInFlight = false; trialResult = null; acceptInFlight = false; capabilityResult = null; rejected = false; replayInFlight = false; replayResult = null; };

  const _planSummary = () => {
    if (!plan || !plan.cover) return '';
    const c = plan.cover;
    const bits = [c.complete ? '✓ complete' : '◐ partial', `${c.completionCount ?? (plan.steps || []).length} field(s)`];
    if (Array.isArray(plan.skipped) && plan.skipped.length) bits.push(`${plan.skipped.length} deferred (file)`);
    if (Array.isArray(plan.deferred) && plan.deferred.length) bits.push('submit deferred');
    return `<div class="dbg-perspective-ground-note">plan: ${escHtml(bits.join(' · '))}</div>`;
  };

  const _replayNote = (r) => {
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

  // The live trial outcome + (once it PASSES) Accept/Reject, or (once accepted) the saved-capability note
  // + ▶ Re-run. Mirrors the former _renderSGTrialResult, reading module state.
  // SG-T2-6/7 — render the lowered Tier-2 plan + (when executed) each phase's verdict.
  const _tier2Html = (t) => {
    const op = t.tier2;
    if (!op || !Array.isArray(op.nodes)) return '';
    const byLabel = {};
    for (const o of (Array.isArray(t.outcomes) ? t.outcomes : [])) byLabel[o.label] = o;
    const detail = (n) => {
      if (n.type === 'fragment') return `${(n.roles || []).length} role(s)${n.postcondition ? ` · postcond(${escHtml(n.postcondition.source || '')})` : ''}`;
      if (n.type === 'observation') return `${(n.extracts || []).length} extract(s)`;
      if (n.type === 'navigate') return n.mode === 'url' ? `→ ${escHtml(String(n.url || ''))}` : 'click';
      if (n.type === 'analysis') return `${escHtml(n.op || '')} over ${escHtml(n.over || '')}`;
      if (n.type === 'wait') return 'settle';
      return '';
    };
    const mark = (n) => { const o = byLabel[n.label]; if (!o) return ''; return o.passed ? '✓ ' : (o.ran ? '✗ ' : '∅ '); };
    const lines = op.nodes.map((n, i) => `${i + 1}. ${mark(n)}<b>${escHtml(n.type)}</b> ${escHtml(n.label || '')} — ${detail(n)}`);
    const sc = t.tier2Score;
    const head = sc
      ? `⚙ Tier-2 run — verdict <b>${escHtml(String(sc.verdict || '?'))}</b> (${sc.requiredPassed}/${sc.requiredTotal} phases)`
      : `⚙ Tier-2 plan (${op.nodes.length} node(s))`;
    return `<div class="dbg-perspective-ground-note">${head}:<br>${lines.join('<br>')}</div>`;
  };

  const _trialResultHtml = () => {
    const t = trialResult;
    if (!t) return '';
    if (t.success === false) return `<div class="dbg-perspective-ground-note">⚠ Run failed: ${escHtml(t.error || 'unknown')}</div>`;
    if (t.tier2) return _tier2Html(t);   // SG-T2-6/7 — the lowered plan + per-phase run verdicts
    if (t.ran === false) return `<div class="dbg-perspective-ground-note">∅ Nothing ran: ${escHtml(t.reason || 'no actionable steps')}</div>`;
    const v = t.trial || {};
    const pct = (typeof v.score === 'number') ? ` (${Math.round(v.score * 100)}%)` : '';
    const def = (Array.isArray(t.deferred) && t.deferred.length) ? ` · ${t.deferred.length} deferred` : '';
    let html = `<div class="dbg-perspective-ground-note">▶ ran — verdict <b>${escHtml(String(v.verdict || '?'))}</b>${pct} · safety ${escHtml(String(t.safetyClass || '?'))}${def}</div>`;
    if (capabilityResult) {
      const cap = capabilityResult;
      const n = Array.isArray(cap.landmarkUids) ? cap.landmarkUids.length : 0;
      html += `<div class="dbg-perspective-ground-note">✓ saved as a perspective — <b>${n}</b> landmark(s) promoted${cap.cover?.complete ? ' · complete' : ''}</div>`;
      html += replayInFlight
        ? `<div class="dbg-perspective-ground-actions"><button class="btn-secondary tiny" type="button" disabled>⏳ Re-running…</button></div>`
        : `<div class="dbg-perspective-ground-actions"><button class="btn-secondary tiny" data-perspective-action="replay-sg-capability" type="button" title="Re-run this saved capability on the page — uses the cached binding, so NO LLM (no Comprehend/Select). The irreversible submit stays deferred.">▶ Re-run (no LLM)</button></div>`;
      if (replayResult) html += _replayNote(replayResult);
    } else if (rejected) {
      html += `<div class="dbg-perspective-ground-note">✗ trial rejected — not saved</div>`;
    } else if (t.acceptError) {
      html += `<div class="dbg-perspective-ground-note">⚠ Not saved: ${escHtml(t.acceptError)}</div>`;
    } else if (t.acceptEligible) {
      html += acceptInFlight
        ? `<div class="dbg-perspective-ground-actions"><button class="btn-secondary tiny" type="button" disabled>⏳ Saving…</button></div>`
        : `<div class="dbg-perspective-ground-actions">
            <button class="btn-secondary tiny" data-perspective-action="accept-sg-trial" type="button" title="Save this as a verified, re-runnable capability. The binding (role → selector) is cached, so re-runs need no LLM.">✓ Accept as capability</button>
            <button class="btn-secondary tiny" data-perspective-action="reject-sg-trial" type="button" title="Discard this trial — nothing is saved.">✗ Reject</button>
          </div>`;
    }
    return html;
  };

  async function onRun() {
    const intent = (getIntent?.() || '').trim();
    if (trialInFlight || !intent) return;
    trialInFlight = true; trialResult = null; capabilityResult = null; rejected = false; acceptInFlight = false; replayResult = null; replayInFlight = false;
    rerender?.();
    let res;
    try { res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'RUN_SG_TRIAL', payload: { tabId: getTabId?.(), groundId: getGroundId?.(), intent, tier2: tier2Inspect } }, r)); }
    catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
    trialInFlight = false;
    trialResult = res || { success: false, error: 'no result' };
    rerender?.();
  }

  async function onAccept() {
    const groundId = getGroundId?.();
    if (acceptInFlight || !groundId) return;
    acceptInFlight = true; rerender?.();
    let res;
    try { res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'ACCEPT_SG_TRIAL', payload: { groundId, tabId: getTabId?.() } }, r)); }
    catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
    acceptInFlight = false;
    if (res?.success && res.accepted) {
      capabilityResult = res.capability || null;
      afterAccept?.();              // the new capability should appear in the library on next render
      toast?.('Saved as a verified capability');
    } else if (trialResult) {
      trialResult = { ...trialResult, acceptError: res?.reason || res?.error || 'accept failed' };
    }
    rerender?.();
  }

  async function onReject() {
    const groundId = getGroundId?.();
    if (acceptInFlight || !groundId) return;
    try { await new Promise((r) => chrome.runtime.sendMessage({ type: 'REJECT_SG_TRIAL', payload: { groundId } }, r)); } catch { /* best-effort */ }
    rejected = true; capabilityResult = null;
    rerender?.();
  }

  async function onReplay() {
    const groundId = getGroundId?.();
    if (replayInFlight || !groundId || !capabilityResult?.id) return;
    replayInFlight = true; replayResult = null; rerender?.();
    let res;
    try { res = await new Promise((r) => chrome.runtime.sendMessage({ type: 'REPLAY_SG_CAPABILITY', payload: { tabId: getTabId?.(), groundId, capabilityId: capabilityResult.id } }, r)); }
    catch (e) { res = { success: false, error: e?.message ?? 'unknown' }; }
    replayInFlight = false;
    replayResult = res || { success: false, error: 'no result' };
    rerender?.();
  }

  return {
    /** Fresh ground check → adopt its plan + clear any prior trial state. */
    setPlan(p) { plan = p || null; _resetTrial(); },
    /** Full clear (session reset / dismiss). */
    reset() { plan = null; _resetTrial(); },
    /** The plan summary + live trial result (+ accept/reject/re-run) for the intent-check row. */
    renderResult() { return `${_planSummary()}\n        ${_trialResultHtml()}\n        ${_recordHtml()}`; },
    /** The ▶ Run on page button (or running state) for the row's action area; '' when no runnable plan. */
    renderRunButton() {
      // SG-T2-6 — Tier-2 inspect toggle: when on, ▶ Run returns the lowered multi-phase plan (no execution).
      const toggle = `<button class="btn-secondary tiny" data-perspective-action="toggle-tier2" type="button" title="Tier-2 plan inspect: ▶ Run lowers the intent into its multi-phase plan (fragment/observation/navigate/wait nodes) and shows it, instead of running the flat trial. No execution.">${tier2Inspect ? '◉' : '○'} T2 plan</button>`;
      // OBS-1 — Record demo (always available; the observed path doesn't need an intent first).
      const rec = `<button class="btn-secondary tiny" data-perspective-action="toggle-record" type="button" title="OBS-1 — record a demonstration: do the task on the page yourself, then Stop to capture the raw action trace (the basis for deriving a capability, no Comprehend/Select).">${recording ? '■ Stop recording' : '● Record demo'}</button>`;
      if (plan && plan.runnable && !trialInFlight) return `<button class="btn-secondary tiny" data-perspective-action="run-sg-trial" type="button" title="Run the substrate-grounded plan on this page — fills the fields; the irreversible submit is deferred.">▶ Run on page</button> ${toggle} ${rec}`;
      if (trialInFlight) return `<button class="btn-secondary tiny" type="button" disabled>⏳ Running…</button> ${rec}`;
      return `${toggle} ${rec}`;
    },
    wire(container) {
      if (!container) return;
      container.querySelector('[data-perspective-action="run-sg-trial"]')?.addEventListener('click', () => onRun());
      container.querySelector('[data-perspective-action="toggle-tier2"]')?.addEventListener('click', () => { tier2Inspect = !tier2Inspect; rerender?.(); });
      container.querySelector('[data-perspective-action="toggle-record"]')?.addEventListener('click', () => onRecordToggle());
      container.querySelector('[data-perspective-action="accept-sg-trial"]')?.addEventListener('click', () => onAccept());
      container.querySelector('[data-perspective-action="reject-sg-trial"]')?.addEventListener('click', () => onReject());
      container.querySelector('[data-perspective-action="replay-sg-capability"]')?.addEventListener('click', () => onReplay());
    },
  };
}
