/**
 * background/handlers/pipeline.js — persistence for per-item CASES (v2.74.1665).
 *
 * Spec: docs/DESIGN_peritem_pipeline.md §5.7 (case + re-run) · §9.3 (the sidecar precedent).
 *
 * §9.3 established that a case cannot live on the `Conversation` record: it has no status field, `patchMeta`'s
 * allow-list is closed (and silently drops writes that miss it — the `resolvedAt` bug), and ledger/proposals key
 * by `instanceId`, which every case under one desk SHARES. The pattern that works is the vitals sidecar: real
 * state in an owned store, the conversation as a render shell.
 *
 * So this mirrors `background/handlers/vitals.js` deliberately — same serialized read-modify-write chain, same
 * fail-quiet posture. The decision logic is all pure in `Core/pipelineCase.js`; this file only persists.
 */

import { Logger } from '../../Core/Logger.js';
import {
  upsertCase, setBranch, addStage, addAction, closeCase, openItemIds, caseTally,
} from '../../Core/pipelineCase.js';

const CASE_KEY = 'pipeline:cases';

// Serialized RMW, exactly as the incident store does it: concurrent per-item writes would otherwise
// read-modify-write over each other and silently drop cases.
let _chain = Promise.resolve();
function _mutate(fn) {
  const step = _chain.then(async () => {
    let list = [];
    try { list = (await chrome.storage.local.get(CASE_KEY))?.[CASE_KEY] || []; } catch { /* */ }
    const out = fn(Array.isArray(list) ? list : []);
    const next = Array.isArray(out) ? out : (out && out.list) || [];
    try { await chrome.storage.local.set({ [CASE_KEY]: next }); } catch { /* */ }
    return out;
  }).catch(() => ({ list: [], opened: false }));
  _chain = step.then(() => {}, () => {});
  return step;
}

async function _read() {
  try { return (await chrome.storage.local.get(CASE_KEY))?.[CASE_KEY] || []; } catch { return []; }
}

export function createPipelineHandlers() {
  return {
    /**
     * The re-run gate (§5.7). Returns the item ids that ALREADY have an open case for this pipeline, so the
     * panel can mark them `already-open` instead of minting a second case for the same record.
     */
    PIPELINE_OPEN_ITEMS: async (payload, _sender, sendResponse) => {
      try {
        const pipeline = String(payload?.pipeline ?? '').trim();
        sendResponse({ success: true, itemIds: openItemIds(await _read(), pipeline) });
      } catch (e) { sendResponse({ success: false, error: String((e && e.message) || e) }); }
    },

    /**
     * Open-or-append one item's case and record its branch outcome + stages + actions in ONE hop.
     *
     * Batched on purpose: a per-item pipeline over 22 rows would otherwise make 22×4 round trips to the service
     * worker, and each hop is a place the chain can interleave. The pure core is append-shaped, so replaying the
     * whole item's record on each call stays correct.
     */
    PIPELINE_RECORD_ITEM: async (payload, _sender, sendResponse) => {
      try {
        const p = payload || {};
        const pipeline = String(p.pipeline ?? '').trim();
        const itemId = String(p.itemId ?? '').trim();
        if (!pipeline || !itemId) { sendResponse({ success: false, error: 'pipeline and itemId required' }); return; }

        const r = await _mutate((list) => {
          const up = upsertCase(list, {
            pipeline, itemId,
            label: String(p.label ?? ''),
            runId: String(p.runId ?? ''),
            record: p.record || null,
            line: String(p.line ?? ''),
            now: Date.now(),
          });
          let l = up.list;
          if (p.branch && typeof p.branch === 'object') l = setBranch(l, up.id, p.branch);
          for (const s of (Array.isArray(p.stages) ? p.stages : [])) l = addStage(l, up.id, s);
          for (const a of (Array.isArray(p.actions) ? p.actions : [])) l = addAction(l, up.id, a);
          if (p.close && typeof p.close === 'object') l = closeCase(l, up.id, { ...p.close, now: Date.now() });
          return { list: l, opened: up.opened, id: up.id };
        });

        sendResponse({ success: true, id: r.id, opened: r.opened });
      } catch (e) { sendResponse({ success: false, error: String((e && e.message) || e) }); }
    },

    /** Read back a pipeline's cases (the Rail / dashboard surface). */
    PIPELINE_CASES: async (payload, _sender, sendResponse) => {
      try {
        const pipeline = String(payload?.pipeline ?? '').trim();
        const all = await _read();
        const cases = pipeline ? all.filter((c) => c && c.pipeline === pipeline) : all;
        sendResponse({ success: true, cases, tally: caseTally(all, pipeline) });
      } catch (e) { sendResponse({ success: false, error: String((e && e.message) || e) }); }
    },

    /** Close one case explicitly (a human resolving it from the surface). */
    PIPELINE_CLOSE_CASE: async (payload, _sender, sendResponse) => {
      try {
        const id = String(payload?.id ?? '').trim();
        if (!id) { sendResponse({ success: false, error: 'id required' }); return; }
        await _mutate((list) => closeCase(list, id, {
          state: String(payload?.state ?? 'done'),
          verdict: String(payload?.verdict ?? ''),
          now: Date.now(),
        }));
        try { Logger.info('background', `PIPELINE ▸ case closed ${id} → ${payload?.state || 'done'}`); } catch { /* */ }
        sendResponse({ success: true });
      } catch (e) { sendResponse({ success: false, error: String((e && e.message) || e) }); }
    },
  };
}
