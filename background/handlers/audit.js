// background/handlers/audit.js — AU-1 (DESIGN_audit.md §11): the creates-audit HOOK. `recordCreate(evt)` is a
// SIBLING to reportLegOutcome (vitals.js), called at the two WRITE-capable ride-executor success branches
// (connector.js:1393 INVOKE_SESSION, :1844 SESSION_REPLAY-ok — NOT :1819, reads-only). It is body-blind's
// opposite by design: it deliberately banks the created id + a human label so the ledger can answer "what have I
// created?". Everything is FAIL-SAFE — audit must never break the write it observes (mirrors vitals' contract).
//
// The load-bearing guard is `auditSucceeded` (Core/audit.js §10.1): SESSION_REPLAY-ok reaches :1844 with ok:true
// even for a 200-with-nested-userErrors (that branch screens only top-level body.errors), so a naive hook there
// would bank a phantom "created" row for a vendor-REFUSED create. recordCreate refuses to bank one.

import { Logger } from '../../Core/Logger.js';
import { auditSucceeded, classifyCreate, createRecordFrom, customerLabelFrom } from '../../Core/audit.js';
import { appendCreateEntry } from '../../Services/Storage/AuditCreateStore.js';
import { CONNECTOR_RECIPES } from '../../Core/connectorRecipes.js';   // AU-6 (v2204) — the leg's declared `warm` window
import { warmWindowMs } from '../../Core/recordLife.js';                 // AU-6 — parse it; the decision stays pure

/**
 * Bank one create event to the audit ledger — IF it was a real, vendor-accepted create.
 * @param {{value:object, origin?:string, recipeId?:string, groundId?:string, method?:string,
 *          who?:string, inputParams?:object, urlArgs?:object, incitedBy?:object}} evt
 *   value       the mutation reply value (GraphQL `{data:…}` or a REST `{ticket:{…}}`)
 *   who         'human' (a person clicked) | 'gate' (pipelineGate auto) — the seam's clearedBy
 *   inputParams the create INPUT (payload.params) — the customer label source (§10.5)
 *   urlArgs     endpoint args ({handle}…) so the surface can resolve the durable itemUrl (AU-2)
 *   incitedBy   {system, kind, id, label, args} — the record that CAUSED this create (§12.8.1). Shaped like a
 *               RECORD, not like any one source: a Zendesk-incited draft carries no division, so anything
 *               source-specific rides in `args`. The opener is chosen from `system`, never from a name test.
 */
export async function recordCreate(evt) {
  try {
    const e = (evt && typeof evt === 'object') ? evt : null;
    if (!e) return;
    if (!auditSucceeded(e.value)) return;                       // the phantom-row guard (§10.1) — banks nothing for a refused write
    const rec = createRecordFrom(e.value);
    if (!rec || !rec.id) return;                                // no extractable id → nothing to record
    const { verb, kind } = classifyCreate(e.value, e.recipeId, e.method);
    let label = rec.label;
    if (kind === 'customer') { const cl = customerLabelFrom(e.inputParams); if (cl) label = cl; }   // §10.5 minimal human label
    const who = (e.who === 'human') ? 'human' : 'gate';
    const fields = {
      at: Date.now(),                                           // the seam owns the clock (Core/audit stays clock-free)
      system: e.origin || '',
      verb, kind, id: rec.id, label, who,
      ...(e.recipeId ? { recipeId: e.recipeId } : {}),
      ...(e.groundId ? { groundId: e.groundId } : {}),
      ...(e.urlArgs && typeof e.urlArgs === 'object' ? { urlArgs: e.urlArgs } : {}),
      // v2.74.2195 (§12.8.1) — the record that CAUSED this one. Forwarded RAW; Core/audit's `_capIncitedBy` is the
      // single normalizer, so this seam never has to know the shape. Dropped there without system+id.
      ...(e.incitedBy && typeof e.incitedBy === 'object' ? { incitedBy: e.incitedBy } : {}),
      // AU-6 (v2.74.2204, §12.4) — THE WARM WINDOW COMES FROM THE LEG, and it is resolved HERE because this is
      // the only seam that knows which recipe wrote the record. `warm: '60d'` is catalog data; `warmWindowMs`
      // parses it and falls back rather than throwing, so a malformed catalog string costs a default window and
      // never the create. A leg that declares nothing gets DEFAULT_WARM_MS — warm decays either way, which is
      // the point: a record nobody has looked at in weeks must stop costing per-record reads.
      warmUntil: Date.now() + warmWindowMs((CONNECTOR_RECIPES || []).find((r) => r && r.id === e.recipeId)),
    };
    await appendCreateEntry(fields);
    // AUDIT ▸ — BODY-BLIND (§5/§7-7): system · verb · kind · who only, NEVER the id/label. Registered metric:true
    // in Core/decisionMarkers.js so both the decisions view and the CloudWatch count pick it up (Invariant #1).
    try { Logger.info('audit', `AUDIT ▸ ${fields.system || '?'} ${verb} ${kind} by ${who}`); } catch { /* */ }
  } catch { /* fail-safe — never break the observed write */ }
}
