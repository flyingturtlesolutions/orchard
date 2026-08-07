# DESIGN — Creates-audit ledger: a durable, queryable record of everything Orchard makes

**Status:** design note (2026-08-07). Not built. Produced by a 4-scout (write-funnel / stores / privacy-scope /
reversibility-surface) + synthesizer + 2 adversarial-reviewer pass (both ok; grounding + design/scope). Their
corrections are folded in-line, not footnoted: the seam is the two WRITE-capable branches only (:1819 is
reads-only), `createdRecordId/Label` are GraphQL-shaped so AU-0 adds a REST extractor branch, a customer row is
id-only (no `name`/`title`), the fleet marker needs `metric: true`, and the connector.js seam is node --check +
live-eyeball (outside the unit gate). Every claim is file:line-grounded against the code as of v2.74.2073.
The just-built Shopify draft-order write suite (create by email+name / discount / tags; delete-by-`#D` gated) is
the first live write path this audits; the capability is transport-general.

**One-line problem:** ask "what have I created — customers, orders, tickets?" and there is **no store to read.**
The ingredients to answer exist — every write funnels through one outcome seam, the created id/#label are dug out
of the mutation reply, the who-confirmed distinction is computed and logged — but they are **scattered across five
capture paths of unequal fidelity, and the common case (an ad-hoc chat create) persists nothing durable at all.**
This is a real gap, not an ergonomics nit: it is the difference between Orchard *remembering what it did for you*
and the user having to keep their own ledger — which is the **iron principle** (Orchard fails the moment the user
becomes a state manager; `docs/MEMORY iron_principle`, falsifiable via `connect_ui_visits=0`). An agent that
creates records the user cannot later enumerate has quietly handed the bookkeeping back.

---

## 1. The gap — the ingredients exist, scattered; the store does not

The honest current answer, verified and sharpened: **there is no cross-system, cross-workflow durable store of
created entities.** Five paths capture a create today, at five different fidelities, and only one of them survives
a reload — and it is the wrong shape for the question.

### 1.1 What each write path persists today

| # | Path | Where | Created id? | Who? | Durable? |
|---|---|---|---|---|---|
| 1 | Ad-hoc cookie-ride write (INVOKE_SESSION) | chat.js:14938-14943 | ✅ `createdRecordId`+`Label` | ✗ | **✗ — reply bubble + in-memory `_lastGroundedRead` only** |
| 2 | Ad-hoc header-replay write (SESSION_REPLAY) | chat.js (`Sent — …`) | ✗ never dug | ✗ | ✗ |
| 3 | Broker / OAuth write (INVOKE_CONNECTOR) | chat.js:14912-14914 | ✗ | ✗ | ✗ (bypasses the ride funnel entirely) |
| 4 | Pipeline per-item write (workflow) | chat.js:6241 → :10199 | ✅ `id:c.ref` | ✗ | ✅ but **workflow-scoped, lossy summary** |
| 5 | Headless SW auto-write (scheduled) | Core/headlessWrite.js:204-207 | ✗ **id dropped** (label = source row) | ✗ | ✅ same store as #4 |

The single durable capture (#4 / #5) lands in **run history** — `Services/Storage/WorkflowRunStore.js`, keyed
`wfruns:<workflowId>` (:17), record `{items, total, updatedAt}` (:58). Its item shape is `{kind:'created', label,
id}` (`Core/runHistory.js` `HISTORY_ITEM_KINDS` :29, `normalizeHistoryItem` :36-46). That is the closest thing to
a created-record store, and it disqualifies itself for the question four ways:

- **Workflow-keyed.** `appendRunEntry(workflowId, …)` (WorkflowRunStore.js:49) always keys on a workflow id, so
  the answer to "everything I created this week" requires a fan-out over every `wfruns:` key — and paths #1-#3
  (every **ad-hoc** chat create) are in none of them.
- **A run LOG, not a per-entity ledger.** `items[]` is a compact body-blind label list capped at 40
  (`HISTORY_ITEM_CAP`, runHistory.js:30) with lossy truncation that *prefers* keeping no-match/created
  (normalizeHistoryItems :57-63) — a summary, not a queryable row. It has no `system` / `entity-kind` / `who` /
  `itemUrl` / `reversal` field to tell a Shopify customer from a Zendesk ticket from a draft order.
- **Id captured only sometimes.** Path #5 (`Core/headlessWrite.js:204-207`) banks `{kind:'created',
  label:_rowLabel(row)}` with **no id** — even though the mutation reply `r.value` is in hand at :188 — so a
  scheduled create is auditable by its *source-row* label, not by the record it produced.
- **No who / when / reversal.** Nothing anywhere records the human-vs-gate approval provenance as a field, a
  per-create timestamp (only the coarse run-entry `at`), or a link from a create to its undo.

### 1.2 Why the other two "durable-ish" candidates are also wrong

- **`ActionLedgerStore` (`ledger:<instanceId>`, cap 500).** The one store literally named "ledger" is the app-
  fleet autonomy loop's record (`LEDGER_KINDS` proposal/decision/execution; keyed by instance). It is **never
  reached by the ride-write path**, and its silent shared `slice(-500)` (ActionLedgerStore.js:39) is the
  explicitly *disqualified* cautionary tale that run-history was built to avoid (runHistory.js:26 comment,
  WorkflowRunStore.js:8-11). Do not extend it.
- **The trace / fleet stream is not an audit store.** `RIDE_WRITE ▸ confirm` (chat.js:14929/14833) records the
  recipeId + endpoint of a write, **not what it produced** — no created id ever appears. The ring is ~48h,
  local, non-queryable; the fleet mailbox is heavy-scrubbed meta-only. Neither can answer "which `#D`-number did
  I create?".

**What is missing, stated positively:** one durable, queryable, append-only book — `{system, kind, created id +
human label, itemUrl link, who confirmed, when, runId/convId, reversal leg}` per create — that every write path
funnels into, readable in one shot for "what have I created?" and filterable per-desk.

---

## 2. The funnel — one seam, hooked once, covers ad-hoc + workflow + headless

There is a single seam every **ride** write already passes through, and it is the right and only place to hook.

**`reportLegOutcome(evt)` (background/handlers/vitals.js:144) is the ONE call every ride executor makes on every
outcome** — read and write, interactive and headless and canary. It is invoked at exactly the two ride-executor
success/failure branches:
- **INVOKE_SESSION** — success at connector.js:1393 (`void reportLegOutcome({…, ok:true, urlArgs})`), failure at
  :1397.
- **SESSION_REPLAY** — retry-ok at connector.js:1819, http-fail at :1837, ok at :1844.

All four ride write paths (#1 cookie-ride, #2 header-replay, #4 workflow per-item, #5 headless SW) reach one of
these two branches: the workflow per-item write (#4) dispatches through `_rideExecOnce` (chat.js:6233 → def
:13432 → SESSION_REPLAY :13448 or INVOKE_SESSION :13453); the headless SW write (#5) through `invokeRideRecipe`
(`Core/headlessWrite.js:187` → INVOKE_SESSION). Both land on the **same two executor branches**, so a hook there
covers #4 and #5 regardless of which dispatcher fed them. **Hook here once and all four are covered at a single
seam** — that is the property the scattered per-caller reply code (§1.1) never had. (Correction from review: the
seam list is the two **write-capable** branches only — INVOKE_SESSION :1393 and SESSION_REPLAY-**ok** :1844; the
SESSION_REPLAY retry-ok branch :1819 is guarded `!isWrite` at :1812 and can never carry a write, so no hook there.)

**But the funnel is body-blind by construction, and must stay that way.** `reportLegOutcome` classifies presence →
drift only (`classifyLegOutcome`, Core/vitals.js), and its durable writes are all body-blind — a counts-only
rolling tally `vitals:tally {ok,auth,miss,other}` (`_tallyWrite`, vitals.js handler :87-96) **and** the ride-recipe
drift/`lastUrlArgs` tick (`_ctx.writeRideRecipes`, vitals.js:180-183; still counters + a trusted tab-derived
`{handle}`, never a reply body). Its evt (:147-149) carries no reply
value, no write-vs-read flag, no who-confirmed; success is fire-and-forget (`void`). Its whole design ethos —
"the funnel must never break the call it observes" (vitals.js:206), body-blind counts (DESIGN_vitals.md §307) — is
the opposite of a body-bearing audit write.

**Design decision: a SIBLING recorder `recordCreate(evt)` beside `reportLegOutcome` at the same two success
branches — not a widening of the funnel.** Reasons:
- It keeps `reportLegOutcome` body-blind (its invariant) while placing the body-bearing capture at the *same one
  seam*, so "hook once" is preserved without coupling presence/drift to audit.
- Everything it needs is **already in the executor's local scope at that branch**: the write discriminator
  `isWrite` (connector.js:871 / :1637); who-confirmed `clearedBy ∈ {'human','gate',''}` (connector.js:884-885 /
  :1655-1656, already logged as `write cleared by <clearedBy>` at :887 / :1658); the reply value (`reply.value`
  INVOKE_SESSION / `r.body` SESSION_REPLAY); `origin`/`apiHost`; `groundId`+`recipeId` (payload); `urlArgs`
  (already banked by the funnel, vitals.js:177); `Date.now()`.
- It **fixes the fidelity asymmetry centrally.** `recordCreate` digs `createdRecordId`/`createdRecordLabel`
  (Core/connectorRender.js:135 / :156) *once at the seam*, so the capture **supersedes both chat.js reply
  branches** — the digging block (chat.js:14921-14948) AND the non-digging `Sent —` block (:14815-14841) — making
  which branch rendered the reply irrelevant to id capture (do not later also patch the `Sent —` line). **Caveat
  (review):** `createdRecordId`/`Label` are **GraphQL-shaped** — both require `value.data` and walk `data.<op>.<entity>`
  (connectorRender.js:136/:157), so they extract the id/label for the Shopify/GraphQL path (`{data:{draftOrderCreate:
  {draftOrder:{id,name}}}}` — the primary audited path works) but return `null` for a REST reply like Zendesk's
  `{ticket:{id,…}}`. AU-0 therefore adds a **non-`.data` REST extractor branch**; `kind` still derives from the
  recipeId for REST, but the id/label are NOT free there.

`recordCreate` fires only when **`ok === true && isWrite === true`**; a read banks nothing, a failed write banks
nothing (a failure is an incident, §5). It appends fire-and-forget through the same serialized RMW the tally uses,
so it can never race or break the call.

**The two structural bypasses** a ride-seam hook cannot see (state them; do not paper over them):
- **Broker / OAuth writes** (`INVOKE_CONNECTOR`, chat.js:14912) never touch a ride executor (transport `'broker'`,
  VT-6/7 unbound). Mitigant: session-ride is the PRIMARY path and the Shopify draft suite is ride, not broker.
  Covered later by a second hook at the broker success branch (AU-6).
- **Page-drive creates** (`INVOKE_DRIVE_ARTIFACT`, chat.js:14785 — the "open = drive the page" verb) fill a form
  and click submit with **no ride leg and no created id**, so they are structurally invisible to a ride-seam
  ledger and out of scope until a form submit yields a findable id (open question §9).

---

## 3. The entry shape

One normalized, body-blind-disciplined record per create, minted by a pure `auditEntry(f)` modeled field-for-field
on `runHistoryEntry` (runHistory.js:148 — whitelist, truncate, unknown enum → safe value):

```
auditEntry({
  system,        // origin / apiHost  (e.g. "admin.shopify.com", "deako.zendesk.com")
  verb,          // 'create' | 'update' | 'delete'         ← from method + reversible/destructive axis
  kind,          // 'customer' | 'order' | 'ticket' | 'draft' | 'user' | …   ← from the reply op key / recipeId
  id,            // createdRecordId(reply.value)   — internal id (gid → numeric tail)   (connectorRender.js:135)
  label,         // createdRecordLabel(reply.value): the entity's name/title — the HUMAN number "#D29684"/"#1001"
                 //   for an order/draft; but a CUSTOMER has firstName/lastName (no name/title) so it falls back to
                 //   the numeric id (connectorRender.js:156-175) — a customer row is id + itemUrl, resolvable but
                 //   not name-at-a-glance unless AU-6 opts to capture a human customer label (raises §5 exposure)
  itemUrl,       // FILLED ONCE: fillEndpoint(leg.tool.itemUrl, {...urlArgs, id})       (§ below; durable link)
  who,           // clearedBy: 'human' (a person clicked) | 'gate' (internal+reversible, no person)
  at,            // Date.now()
  recipeId,      // shopify_create_order — the leg that made it (join key to the catalog)
  runId,         // pin/run join key when the create ran inside a workflow/cadence   (if on payload)
  convId,        // the owning conversation                                          (if on payload)
  reversalLeg,   // 'shopify_delete_order' — the human-confirmed undo (§5; PP-0d makes this durable)
})
```

- **`verb` (create/update/delete)** is derivable at the seam: the create/update/delete axis lives on the recipe
  (`connectorRecipes.js` — `shopify_create_order` POST reversible:true outward:false :669; `shopify_update_customer`
  PUT reversible:false :652; `shopify_delete_order` DELETE destructive:true :753), and the leg's `method` +
  `reversible`/`destructive` flags are on the payload. A pure classifier reads them; it does not invent.
- **`kind` / `system`** — the GraphQL reply names both: `createdRecordId` already iterates `data.<op>` (e.g.
  `customerCreate` / `draftOrderCreate`, connectorRender.js:138), so the op key *is* the entity+verb; for REST
  legs (Zendesk `create_ticket` :296, `create_user` :356) `kind` derives from the recipeId. Pure
  `classifyCreate(reply, recipeId, method) → {system, verb, kind}`, unit-tested over `_GQL` fixtures + a REST id.
- **`who`** is the load-bearing audit field, and it already exists as a first-class, audit-*intended* distinction.
  `stampWriteAuthority` (Core/rideStep.js:61) mints exactly two authorities — `confirmed` (a person clicked) vs
  `gateCleared` (`Core/pipelineGate.gateAction` returned `'auto'`: internal + reversible + declared, no person) —
  and its own doc (rideStep.js:46-56) says they must be kept apart "because they answer different questions after
  the fact ('who approved this?')". `clearedBy` (connector.js:884-885) is that value, computed and logged today,
  thrown away after the log line. Persist it; do not recompute.
- **`itemUrl` — the durable link.** The create legs declare `itemUrl` (`shopify_create_customer`
  `/store/{handle}/customers/{id}` connectorRecipes.js:625; `shopify_create_order`
  `/store/{handle}/draft_orders/{id}` :689). Today `_showGroundedReadView` (chat.js:7730) fills it from the
  reload-volatile module var `_lastGroundedRead` (chat.js:7074), so "show it" reaches only the **last** create in
  the session and dies on reload. The fix: fill the link **once** at capture — `fillEndpoint(leg.tool.itemUrl,
  {...urlArgs, id})` — and store the filled string, so the `{id → live record}` link survives forever. `urlArgs`
  (the trusted-provenance `{handle}`) already rides the outcome (vitals.js:149/177). This needs the `itemUrl`
  template to ride the INVOKE_SESSION payload (a declared leg field, threaded through Invariant #3's hops per the
  ride-recipe arc) — confirm it reaches the seam, else thread it (AU-2).
- **`reversalLeg`** — see §5; the create→undo pairing is declared as *prose* today (shopify_create_order `does`
  names `shopify_delete_order`, connectorRecipes.js:670) and becomes a real field when PP-0d lands.

Every string field truncates (label ≤ 80, id ≤ 60 — the runHistory discipline, runHistory.js:41-44). The entry is
never a raw reply body; it is these named fields only.

---

## 4. The store — a sibling book, modeled byte-for-byte on run-history

**Decision: add a new sibling store `audit:creates`; do NOT extend run-history, do NOT extend the action ledger.**

- **Not run-history:** it is workflow-keyed (`wfruns:<workflowId>`) and a lossy 40-item summary — it cannot hold
  a non-workflow create or a per-entity cross-system row (§1.1).
- **Not the action ledger:** silent shared `slice(-500)` (ActionLedgerStore.js:39) is the disqualified anti-pattern
  (runHistory.js:26), instance-keyed defeats the cross-system query, and the ride-write path never reaches it.

**Reuse the run-history I/O idiom verbatim** — it is the freshest, best-designed durable append store in the repo,
and it fixes exactly the action-ledger disease:

```
KEY = 'audit:creates'                       // ONE global book (see scope, §5)
record = { items:[…auditEntry], total, updatedAt }        // WorkflowRunStore.js:58 shape
```

- **Serialized RMW** — the per-key `_chained(key, fn)` chain (WorkflowRunStore.js:20-27), so concurrent appends
  from the fire-and-forget seam cannot clobber (the same reason `_tallyWrite` is serialized, vitals.js:86).
- **Append + cap** — `[...prev, entry].slice(-CAP)` (`appendRun`, runHistory.js:185).
- **Visible eviction — the discipline the action ledger lacks.** Keep a lifetime `total` counter and surface
  `truncationNotice(shown, total)` → "showing the last 500 of 1240" (runHistory.js:196-200). "Auditable" and
  "silently evicts" cannot both be true; a truncated book that *says so* is honest, a silent `slice(-500)` is not.
- **Read API** — `loadCreates() → {items, total, notice}`, mirroring `loadRuns` (WorkflowRunStore.js:37).

**Global vs per-desk key.** The question — "what have I created across systems?" — is inherently cross-desk, so a
single global book answers it in one read while a per-instance key (the ledger shape) would force a fan-out. Each
entry carries `deskInstanceId` / `convId` as **fields**, so per-desk filtering is a `.filter()`, not a separate
key (matching CS-1's desk+preset scope as a filter, not a partition; `docs/DESIGN_desks.md` §CS-1). Creates are
**human-gated, low-frequency events** (money = human-click bounds the rate; §5), so a generous global cap with a
visible total is safe to start; if one desk ever dominates the book, shard to `audit:creates:<instanceId>` with a
global index (open question §9). Register the key as **local-only, never sync-registered** (§5).

---

## 5. Privacy + scope — local-only, un-redacted at rest, body-blind on any wire

The audit store holds real identity (a `#D`-number, a created record's id + link; for an order/draft the human
number — for a customer, id-only per §3) and must, or it cannot answer "what did we create?". That is safe
**only** under a strict posture, all of it grounded in the existing boundary docs.

- **Local-only, un-redacted at rest.** The reversible redactor (`Core/redact.js`) is the **device boundary** —
  it stops identity crossing into the `#call` model payload (redact.js:5-16), and its pseudonyms are "never
  persisted, never sent". It is the **wrong tool for a store**: an audit trail that pseudonymized its own subjects
  could not answer the question. `chrome.storage.local` is the same trust tier that `runHistory items[]`
  (un-redacted label/id, runHistory.js:36-46) and `ledger targets[]` already occupy. Full fidelity at rest is the
  *point* of audit. Register `audit:creates` **outside `SYNCABLE_KINDS`** (`Services/Storage/StoragePaths.js`) —
  never `chrome.storage.sync`, never the cloud partition, matching `ActionLedgerStore`'s not-sync-registered rule
  (ActionLedgerStore.js:6).
- **Never feed a row back to the model without minimization.** The `<RECORD>`/`<FINDINGS>` reasoning path is not
  yet minimized and R-4 (`settings:redact_pii`) defaults OFF (`docs/DESIGN_llm_privacy.md` §3/§87-90). If a future
  feature ever routes an audit row into a `#call` payload, it must go through `redactDeep` **with an
  `identityValues` name-set** — names and street addresses are not pattern-detectable (redact.js:103-112), only
  seeded. Today the ledger has no egress; keep it that way, and gate any future one on this.
- **Fleet / dashboard visibility = a body-blind marker only, never a second pipe.** The cloud rule is
  scrubbed-ring-only: the shipper adds no second scrubber and the structured `data` block never crosses the wire
  (`docs/DESIGN_cloud_logs.md` ruling 3; `Core/logShipping.js` `normalizeRingEntry`). A raw audit row *is* a data
  block and cannot ride by construction. For fleet-level "N created this week", emit a **body-blind** `AUDIT ▸`
  decision marker (counts + recipeId + verb — **never** the label / email / `#D`), registered in
  `Core/decisionMarkers.js` (Invariant #1). **Review correction:** a *plain* registration reaches the
  decisions-VIEW filter only; to reach the CloudWatch **metric** (the actual fleet "N created" count) the entry
  must carry `metric: true` + a body-blind `metricPattern` (count/recipeId/verb, never the label), which is what
  `metricMarkers()` (decisionMarkers.js:196-201) derives the metric filter from. So AU-1 registers `AUDIT ▸` with
  `metric: true`, not a bare entry. **Scrub hazard, called out:** the
  Logger's `LONGNUM` floor is `\d{8,}` (redact.js), so a 5-digit draft number like `#D29684` survives every scrub
  — an `AUDIT ▸` line that put the human label in the message would **leak** it to the fleet. The marker subject
  must be `recipeId`/count only.
- **Scope.** One global book per install; entries carry `{system, deskInstanceId, convId}` so the surface filters
  per-desk (CS-1 desk+preset scope, `DESIGN_desks.md`), **never per-conversation** (CS-1's own lesson:
  per-conversation scoping was the bug). The desk render lives on the Admin/Connect surface tier (per-install,
  all-grounds; `DESIGN_vitals.md` §8) — a user-facing "what did Orchard create for me" answer (§6) is the new
  surface CS-1's operator view never provided.

**Money = human-click, made durable.** Creates that are outward/money stay human clicks by construction —
the gate keeps `outward` and `destructive` legs off the unattended path (an `outward` leg is QUEUED at `gateAction` :65; a `destructive`/gated leg is REFUSED at `gateActionForLeg` :97), and completing a
draft into a real order stays navigate-only (the catalog encodes this by exclusion, pipelineGate.js:37
`NEVER_UNATTENDED`). The ledger's `who` field makes that provenance **auditable**: a `gate`-cleared row is an
internal + reversible create that ran unattended; a `human` row is one a person approved. The audit view can
therefore honestly show "you approved these 3; the scheduler auto-created these 12 (all reversible)".

---

## 6. Surfacing — the ask, the desk view, the link, the undo, the export

Nothing surfaces created records today: there is no "what have I created" ask parser, no created-record card kind,
no export (verified — grep across `*.js` finds none). Five surfaces, layered:

1. **The ask.** "what have I created" / "what did you create this week" → a parser (sibling to
   `parseDashboardAsk`, `Core/vitalsDashboard.js`) reads `loadCreates()` and renders a **canvas table** (columns:
   system · kind · label · when · who · link) via a `RENDER_CANVAS` `CanvasSpec` (the table/cards/cells kinds the
   vitals dashboard already added, `DESIGN_vitals.md` §VT-2d). This is the direct answer to the question — and the
   iron-principle payoff: the user reads it instead of maintaining it.
2. **The desk view.** A "Creations" card on the Admin/Connect surface (per-install), and a per-desk slice filtered
   by `deskInstanceId` on a work desk — reusing the one-model-two-renderers scope resolution the dashboard already
   does (Admin = all · desk = its slice · Front = overview, vitals.js `VITALS_DASHBOARD` :562).
3. **Link to record.** Each row's stored `itemUrl` (§3) opens the live record via `SHOW_SOURCES` — the durable
   version of today's session-only "show it" (chat.js:7730), now surviving reload because the link was filled once
   at capture, not re-derived from a dead module var.
4. **Link to undo.** Each row offers an inline "undo" that fires its `reversalLeg` **through the HITL gate** — for
   a Shopify draft that is `shopify_delete_order`, which is `destructive:true` → `safety:'gated'` → `gateActionForLeg`
   REFUSES unattended (pipelineGate.js:97) → a human-confirmed click (the delete-by-`#D` flow already exists,
   chat.js:14921-14934). Money = human-click holds: the audit view *offers* the undo, the gate *requires* the
   click. This depends on `reversalLeg` being a real field (AU-5 / PP-0d).
5. **Export.** Download the book (gl-style local file) for an offline record. Local-only; no egress channel is
   minted (§5).

---

## 7. Build ladder (AU-0..N — smallest-safe-first, each landable + testable)

- **AU-0 (pure, no behavior).** `auditEntry(f)` (field-whitelist normalizer, modeled on `runHistoryEntry`,
  runHistory.js:148) + `classifyCreate(reply, recipeId, method) → {system, verb, kind}` + a `createdRecordFrom(reply)`
  that reuses `createdRecordId`/`createdRecordLabel` verbatim for the GraphQL `{data:…}` shape **and adds a
  non-`.data` REST branch** (a Zendesk `{ticket:{id}}` / `{user:{id}}` → id + label) so both transports extract an
  id, not just GraphQL + the `AUDIT_VERBS` / `AUDIT_KINDS` enums. Unit-tested over `_GQL` fixtures (`customerCreate`
  / `draftOrderCreate`) AND a Zendesk `create_ticket` REST reply (proves the REST branch extracts an id; `kind`
  from recipeId). Nothing wired.
- **AU-1 (the universal hook — capture ad-hoc + workflow + headless at one seam).** Add `recordCreate(evt)` beside
  `reportLegOutcome` at the two WRITE-capable success branches (connector.js:1393 INVOKE_SESSION, :1844
  SESSION_REPLAY-ok — **not** :1819, the reads-only retry-ok path); fire only on `ok && isWrite`; dig id/label
  centrally (fixes the header-replay + headless dropped-id asymmetry); bank `{system, verb, kind, id, label,
  who=clearedBy, at, recipeId, runId, convId}` to the new `audit:creates` store (WorkflowRunStore idiom: `_chained`
  RMW + `total` + `truncationNotice`). Register `AUDIT ▸` with `metric: true` in `decisionMarkers.js` (Invariant
  #1; body-blind). **Verification honesty:** `recordCreate` lives in `background/handlers/connector.js`, which
  CLAUDE.md places OUTSIDE the unit gate (node --check + `npm run undef` only, never a unit test); the
  unit-testable slice is the pure `auditEntry`/`classifyCreate` (AU-0) + the `AuditCreateStore` I/O — the seam
  wiring itself is node --check + a **live eyeball** (a create round-trips one durable row; a read and a failed
  write bank nothing). *First durable capture of an ad-hoc chat create* — closes the §1 primary gap.
- **AU-2 (the durable link).** Thread the leg's `itemUrl` template to the seam (or fill at the call site for the
  ad-hoc path and thread for headless); `recordCreate` fills it **once** via `fillEndpoint({...urlArgs, id})` and
  stores the filled string. Test: the banked row carries a fillable `itemUrl` that survives a reload.
- **AU-3 (the surface — read).** The "what have I created" ask parser → `loadCreates()` → a canvas table. Test:
  the ask lists the AU-1 rows with link + who + when. *First user-facing answer to the question.*
- **AU-4 (desk view + scope filter + export).** The Admin "Creations" card and per-desk slice (filter by
  `deskInstanceId`); the local export. Test: a desk sees only its own creates; export writes the book.
- **AU-5 (reversal linkage — gated on PP-0d).** Populate `reversalLeg` (from `reversible:{by}` once PP-0d lands,
  `DESIGN_peritem_pipeline.md`; interim: a curated create→delete map); the surface offers the inline HITL "undo".
  Test: a draft row's undo routes through the gated delete (money = human-click; never auto).
- **AU-6 (update/delete + broker coverage).** Extend `verb` to update/delete and bank them (so the gated
  delete-by-`#D` and a create become one story); add the `INVOKE_CONNECTOR` broker success branch (chat.js:14912)
  as a **second** hook so broker creates leave the §2 bypass. Test: create→delete of one `#D` reads as one entity's
  history.
- **AU-7 (cross-system correlation — optional).** Bank `corrKeys` (connectorRender.js:265, the read-side join
  already computed) against creations so a Shopify draft, a Zendesk ticket, and the source warranty item group as
  one issue (`toWorkItem`, connectorRender.js:290). Test: three creates sharing an email group.

---

## 8. Consolidations — what to reuse, not reinvent

1. **Hook seam** — the two ride-executor success branches where `reportLegOutcome` already sits (connector.js:1393
   / :1819 / :1844). A *sibling* `recordCreate`, not a widening of the body-blind funnel (§2). One seam, all four
   ride paths.
2. **Extractors** — `createdRecordId` (connectorRender.js:135) + `createdRecordLabel` (:156) verbatim for the
   GraphQL `{data:…}` shape, wrapped by a `createdRecordFrom` that adds a non-`.data` REST branch (Zendesk
   `{ticket:{id}}`), called once centrally.
3. **Who-confirmed** — the existing `clearedBy` value (connector.js:884-885 / :1655-1656), which *is*
   `stampWriteAuthority`'s `confirmed`/`gateCleared` (rideStep.js:61). Persist it; do not recompute.
4. **Store mechanism** — `WorkflowRunStore`'s `_chained` serialized RMW + lifetime `total` + `truncationNotice`
   visible-eviction (WorkflowRunStore.js:20-61, runHistory.js:196). NOT the action ledger's silent `slice(-500)`.
5. **Entry base shape** — run-history's normalized `{kind,label,id}` (runHistory.js:36-46), widened to the §3
   fields via a `runHistoryEntry`-style whitelist normalizer.
6. **Link fill** — `fillEndpoint` + the leg's declared `itemUrl` (connectorRecipes.js:625/689); `urlArgs` already
   ride the outcome (vitals.js:177).
7. **Trace signal** — add `AUDIT ▸` to the `DECISION_MARKERS` manifest with `metric: true` + a body-blind
   `metricPattern` (decisionMarkers.js:12; `metricMarkers()` :196-201) so BOTH the decisions-view AND the
   CloudWatch fleet-metric derivations pick it up (a bare entry reaches the view only) — **body-blind** (§5).
8. **Surface** — the `CanvasSpec` table/cards kinds + the scope-resolved dashboard (`VITALS_DASHBOARD`,
   vitals.js:562; `DESIGN_vitals.md` §VT-2d); the incident-case idiom (`upsertIncident` open/closed lifecycle,
   Core/vitals.js:89 — `recentlyResolved` is *already* framed as "the AUDIT record", vitals.js:141) is available
   if a per-entity create→delete *lifecycle* view is ever wanted, but a flat append book is the right start (an
   audit row is immutable fact, not an open/closed case).

---

## 9. Open questions (carried, not resolved)

- **Global cap fairness.** A single global `audit:creates` with `slice(-CAP)` could let a high-volume desk evict a
  quiet desk's creates. Creates are human-gated and rare, so a generous cap with a *visible* total is honest and
  likely sufficient — but if one desk dominates, shard to `audit:creates:<instanceId>` + a global index. Which
  threshold triggers the shard is open.
- **Broker + page-drive coverage.** Broker creates (`INVOKE_CONNECTOR`, chat.js:14912) are covered only at AU-6;
  page-drive creates (`INVOKE_DRIVE_ARTIFACT`, chat.js:14785) have no ride leg and no created id and stay
  structurally invisible until a form submit yields a findable id. Is the page-drive case worth a DOM-scrape
  capture, or is it honestly out of scope?
- **Reversal linkage timing.** `reversalLeg` is durable only once PP-0d (`reversible:{by:'<leg id>'}`,
  `DESIGN_peritem_pipeline.md` — unbuilt) lands; the interim is a curated create→delete map. Wait for PP-0d, or
  ship the map?
- **`kind` classification robustness.** The GraphQL op key names the entity cleanly (`customerCreate`); a REST
  recipeId (`create_ticket`) is parsed. What is the fallback when neither is unambiguous (a generic
  `POST /records` leg)?
- **Store retention horizon.** The audit book's own retention (a local-store cap decision) is **distinct** from the
  `retention` recipe marker, which governs the upstream *source's* data horizon (`Core/sourceHorizon.js`,
  `connectorRecipes.js:1080`) — do not conflate. How long should Orchard keep its own audit rows?
- **Egress, if ever.** Local-only is the contract today. If an export-to-cloud is ever asked for, it needs
  `redactDeep` + an `identityValues` name-set (names/`#D` are not pattern-detected) and the fleet marker must stay
  body-blind — the `\d{8,}` LONGNUM floor lets `#D29684` through any scrub. Keep this a hard gate, not a default.

---

*Provenance: 2026-08-07 4-scout (write-funnel / stores / privacy-scope / reversibility-surface) + synthesizer pass.
Every landmark re-verified against the code at v2.74.2073: the funnel (vitals.js:144, connector.js:1393/:1819/:1844),
the extractors (connectorRender.js:135/:156), who-confirmed (rideStep.js:61, connector.js:884-885/:1655-1656), the
store idiom (WorkflowRunStore.js, runHistory.js:26/:148/:196, ActionLedgerStore.js:39), the write axes
(connectorRecipes.js:296/:622/:669/:753), the privacy boundary (redact.js, DESIGN_llm_privacy.md, DESIGN_cloud_logs.md,
StoragePaths SYNCABLE_KINDS), and the surface (vitals.js:562, vitalsDashboard.js). The store decision reconciles the
two scout recommendations — a sibling book (Scout B) over the action ledger, carrying Scout C's local-only /
not-sync / body-blind-marker posture as fields rather than a key.*
