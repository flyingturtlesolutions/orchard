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
import { auditSucceeded, classifyCreate, createRecordFrom, customerLabelFrom, chooseAuditMutator } from '../../Core/audit.js';
import { bankAct } from '../../Services/Storage/AuditCreateStore.js';
import { CONNECTOR_RECIPES } from '../../Core/connectorRecipes.js';   // AU-6 (v2204) — the leg's declared `warm` window
import { warmWindowMs } from '../../Core/recordLife.js';

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
    const _recipe = (CONNECTOR_RECIPES || []).find((r) => r && r.id === e.recipeId) || null;   // the leg that wrote it — its declared warm window and outward axis
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
      warmUntil: Date.now() + warmWindowMs(_recipe),
      // §13.3 (v2.74.2206) — DID THIS ACT LEAVE THE BOUNDARY? Stamped at birth when the creating leg declares
      // `outward: true`, because that record was outward-facing from the moment it existed (a sent SMS, an
      // emailed reply) and no undo can call it back. Absent otherwise, and a LATER outward act touching the same
      // record stamps it through `markOutward` — which is the case the axes alone cannot see.
      ...(_recipe && _recipe.outward === true ? { outwardAt: Date.now() } : {}),
    };
    // AU-6 (v2.74.2207, §12.0) — AN ACT ON A RECORD WE ALREADY HOLD IS AN EVENT, NEVER A SECOND ROW. Updating a
    // draft we created did not create a second thing, and a second row would corrupt the AU-3 answer the same way
    // a hand-off would ('you've created 12 records' becoming 24 because half were edited). A row is headed by
    // `update`/`delete` only when the record it touched was never ours — which is a genuinely different act.
    //
    // v2.74.2222 — the routing is PURE and elsewhere now: `chooseAuditMutator` (Core/audit.js, unit-gated) picks
    // the mutator an act applies to a known row (delete → gone, update → an act event, create → never mutates),
    // and `bankAct` (the store, unit-gated) does the find and the write in ONE chained turn — the old
    // findCreate-then-updateCreate pair here was two chain entries with a race window between them. This seam is
    // wiring again, which is all `background/handlers/*.js` (outside the unit gate) is allowed to be.
    const _banked = await bankAct(fields, () => chooseAuditMutator(verb, { who, at: fields.at, windowMs: warmWindowMs(_recipe) }));
    // AUDIT ▸ — BODY-BLIND (§5/§7-7): system · verb · kind · who only, NEVER the id/label. Registered metric:true
    // in Core/decisionMarkers.js so both the decisions view and the CloudWatch count pick it up (Invariant #1).
    try { Logger.info('audit', `AUDIT ▸ ${fields.system || '?'} ${verb} ${kind} by ${who}${_banked && _banked.action === 'event' ? ' → event on the existing row' : ''}`); } catch { /* */ }
  } catch { /* fail-safe — never break the observed write */ }
}
