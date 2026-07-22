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
import { AnthropicService } from '../../Services/AnthropicService.js';
import { CONNECTOR_RECIPES } from '../../Core/connectorRecipes.js';
import { curatedRidesForConnections } from '../../Core/rideRecipe.js';
import { deriveGroundFacts, renderGroundFacts } from '../../Core/groundFacts.js';   // v2.74.1672 — the substrate facts the decomposer cannot infer (the form-oracle move)   // v2.74.1669 — the intent → steps decomposition (a dedicated prompt; interpret is a router)
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
     * v2.74.1669 — INTENT → WORKFLOW STEPS. One step = one action = one result a person can approve.
     *
     * Dedicated rather than reusing `interpret` (a ROUTER — returned `branch`/`clarify` with no subAsks live)
     * or `decomposeAsk` (a CONNECTIVE splitter — no period, no `if`, so a find-or-create stays one clause).
     * Returns the coverage report alongside the steps so the panel can show which step is still doing two
     * things rather than silently accepting an under-split.
     */
    DECOMPOSE_STEPS: async (payload, _sender, sendResponse) => {
      try {
        const intent = String(payload?.intent ?? '').trim();
        if (!intent) { sendResponse({ success: false, error: 'intent required' }); return; }
        // v2.74.1672 — hand the model the site's OWN capability declarations. A 4-step plan shipped live that
        // needed 5, and the missing step ("read the instructions on each one") was missing because nothing told
        // the decomposer that the warranty list carries a per-item DRILL. That is catalog knowledge, and no
        // prompt wording substitutes for it — the same reason `proposePerspectives` is handed the form oracle
        // rather than asked to guess which fields a form requires.
        let groundFacts = '';
        try {
          const conns = Array.isArray(payload?.connections) ? payload.connections : [];
          // v2.74.1689 — render UNCONDITIONALLY. The old `if (conns.length)` gated the whole block on a connected
          // site, which was right while every fact described one. It is wrong now that the block also states what
          // ORCHARD ITSELF can do: "open a case" is valid with no connections at all, and gating it meant the one
          // user who most needs to hear "you can open a case here" — the one with nothing connected — heard nothing.
          groundFacts = renderGroundFacts(deriveGroundFacts(conns.length ? curatedRidesForConnections(conns, CONNECTOR_RECIPES) : []));
        } catch { groundFacts = ''; }   // facts are an ENRICHMENT: without them the decomposer still runs, just blinder

        const out = await AnthropicService.decomposeIntoSteps(intent, {
          host: String(payload?.host ?? ''),
          rejected: Array.isArray(payload?.rejected) ? payload.rejected : [],
          edited: Array.isArray(payload?.edited) ? payload.edited : [],
          groundFacts,
        });
        const steps = (out && Array.isArray(out.steps)) ? out.steps : [];
        try {
          const c = out && out.coverage;
          Logger.info('background', `STEPS ▸ "${intent.slice(0, 40)}" → ${steps.length} step(s)${groundFacts ? ' +facts' : ' NO-FACTS'}${c ? ` (floor ${c.expectedMin}${c.underSplit ? ' — UNDER-SPLIT' : ''}${c.compound.length ? `, ${c.compound.length} still compound` : ''})` : ''}${out && out.dropped && out.dropped.length ? ` — ${out.dropped.length} dropped` : ''}`);
          // v2.74.1673 — LOG THE STEPS THEMSELVES, not just the count.
          //
          // v1671 moved the step list off the chat bubble and onto the plan page, on the reasoning that the page
          // is the review surface. True for reviewing — and it made the plan unobservable in EVERY export: the
          // page is not exported, the bubble no longer lists them, and this line carried only a number. A live
          // 5-step plan came back and the trace could not say what the five were.
          //
          // The count is the DECISION; the steps are the DISPOSITION (the v1660 rule). One line, so a fan-out
          // cannot bury it the way 121 INVOKE lines bury everything else.
          if (steps.length) Logger.info('background', `STEPS ▸ plan: ${steps.map((s, i) => `${i + 1}) ${String(s).slice(0, 60)}`).join(' | ')}`);
        } catch { /* */ }
        sendResponse({ success: true, steps, coverage: (out && out.coverage) || null, dropped: (out && out.dropped) || [] });
      } catch (e) { sendResponse({ success: false, error: String((e && e.message) || e) }); }
    },

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
