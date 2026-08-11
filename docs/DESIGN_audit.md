# DESIGN — Creates-audit ledger: a durable, queryable record of everything Orchard makes

**Status:** design note (2026-08-07). Not built. Produced by a 4-scout (write-funnel / stores / privacy-scope /
reversibility-surface) + synthesizer + 2 adversarial-reviewer pass, then **narrowed by a 3-critic adversarial
review** (grounding / honesty / scope — all "flawed" on the first §10 draft, convergent recommendation: ship
smaller). Their corrections are folded in-line, not footnoted: the seam is the two WRITE-capable branches only
(:1819 is reads-only); `createdRecordId/Label` are GraphQL-shaped so AU-0 adds a REST extractor branch; **the hook
gates on a real success predicate that rejects nested `userErrors`** (SESSION_REPLAY-ok would otherwise bank a
phantom row for a vendor-rejected write — §10.1); the fleet marker needs `metric: true`; and the connector.js seam
is node --check + live-eyeball (outside the unit gate). **v1 scope is deliberately narrow (§10.0): a flat,
per-event, CREATES-only book + a flat table** — the per-record card, the update/delete writes-expansion, the `via`
run-context, and the "check current" re-probe are sequenced later (AU-6/AU-8), not built now. Every claim is
file:line-grounded against the code as of v2.74.2073. The just-built Shopify draft-order write suite (create by
email+name / discount / tags; delete-by-`#D` gated) is the first live write path this audits; transport-general.

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
  verb,          // 'create' (v1) | 'update' | 'delete' (AU-6)   ← from the reply DATA FIELD KEY, not axes (§10.3)
  kind,          // 'customer' | 'order' | 'ticket' | 'draft' | 'user' | …   ← from the reply op key / recipeId
  id,            // createdRecordId(reply.value)   — internal id (gid → numeric tail)   (connectorRender.js:135)
  label,         // createdRecordLabel(reply.value): the entity's name/title — the HUMAN number "#D29684"/"#1001"
                 //   for an order/draft; a CUSTOMER has no name/title, so v1 captures a MINIMAL human label from
                 //   the create INPUT (firstName or email-local-part, truncated — §10.5), same at-rest posture as
                 //   the #D-number (§5), so "what customers did I create?" answers for real, not id-only
  itemUrl,       // FILLED ONCE: fillEndpoint(leg.tool.itemUrl, {...urlArgs, id})       (§ below; durable link)
  who,           // clearedBy: 'human' (a person clicked) | 'gate' (internal+reversible, no person)
  at,            // Date.now()
  recipeId,      // shopify_create_order — the leg that made it (join key to the catalog)
  runId,         // pin/run join key when the create ran inside a workflow/cadence   (if on payload)
  convId,        // the owning conversation                                          (if on payload)
  reversalLeg,   // 'shopify_delete_order' — the human-confirmed undo (§5; PP-0d makes this durable)
})
```

- **`verb` — from the reply DATA FIELD KEY, not the axes** (a review correction, §10.3). Create and update are
  BOTH `write:true` / `reversible` varies, so `reversible`/`destructive` do **not** separate create from update —
  only `destructive:true` cleanly marks delete. The clean signal is the GraphQL reply's data field key
  (`draftOrderCreate` vs `…Update` vs `draftOrderDelete`); for the ambiguous REST/POST case, an explicit per-leg
  `verb` hint on the recipe. v1 is **create-only** and needs none of this — it fires only where a created id
  extracts; the create-vs-update-vs-delete generalization is AU-6, added with a real per-leg `verb` field.
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
number — for a customer, a **minimal human label**: the first name or email-local-part in the create input,
§10.5, the same full-fidelity-at-rest treatment #D-numbers get) and must, or it cannot answer "what did we
create?". That is safe **only** under a strict posture, all of it grounded in the existing boundary docs.

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
no export (verified — grep across `*.js` finds none). The v1 **primary** surface is a persistent **Rail "Records"
section** rendering a **flat per-event table** (1:1 with the store); the ask is its shortcut; link/undo ride
alongside. The per-record card + CRUD-timeline drill is the surface's *destination*, sequenced as **AU-8** (§7,
§10.6) once a per-entity index exists — never render-time grouping over a lossy `slice(-CAP)` window.

1. **The Rail "Records" section — the v1 surface (a flat creates table).** A persistent section in the
   Conversations Rail accordion (`buildRailTree`, Core/railTree.js), **not a top-level tab** — a tab is too heavy
   for a low-frequency read surface, and it sidesteps the dev-only Connect tab (SGV-4 retires Connect for non-dev,
   `chat.js:359`, but dev keeps it — a *section* never collides). **The inversion still holds as narrative:** SGV-4
   removes the surface that made you a *state manager* (managing connections); "Records" is its opposite — a
   read-only surface where Orchard shows you *what it did*. **v1 row = one create EVENT** (system icon · kind ·
   human label · created-when · `who` badge human/gate), newest-first, 1:1 with the flat store. Sectioned by system
   (Shopify · Zendesk) or time; per-desk `.filter()`. The **per-RECORD card** (an entity's create→…→delete
   timeline in the run-history overlay idiom `.wf-history-overlay`, chat.js:7888/11242 — a record → its events, as
   a run → its items) is **AU-8**, gated on the per-entity index and the writes-expansion (§10.6). **Attention:
   a quiet count on the header (N this week), never an unread/urgency badge** — an audit trail is a record to read,
   not a to-do that nags (§10.6).
2. **The ask (the shortcut).** "what have I created" / "…this week" → a parser (sibling to `parseDashboardAsk`,
   `Core/vitalsDashboard.js`) reads `loadCreates()`, **filters to `verb==='create'`** (v1 stores creates only, but
   the filter makes the ask honest the moment writes are added — §10.0), and renders the flat table as a canvas
   list — the direct one-shot answer, the iron-principle payoff (read, not maintain).
3. **Link to record — honest about removal.** A create card's stored `itemUrl` (§3) opens the record via
   `SHOW_SOURCES` (durable, survives reload). Once deletes are captured (AU-6), a **deleted card does NOT offer a
   live link** — it shows "deleted <when> by <who>" as a terminal event and the link is struck through, never a
   404 (§10.2).
4. **Link to undo.** A `live` card offers an inline "undo" firing its `reversalLeg` **through the HITL gate** — a
   Shopify draft's `shopify_delete_order` is `destructive:true` → `safety:'gated'` → `gateActionForLeg` REFUSES
   unattended (pipelineGate.js:97) → a human click (the delete-by-`#D` flow exists, chat.js:14921-14934). The view
   *offers*; the gate *requires the click*. Needs `reversalLeg` real (AU-5 / PP-0d).
5. **Export.** Download the book (local file). Local-only; no egress minted (§5).

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
  SESSION_REPLAY-ok — **not** :1819, the reads-only retry-ok path). **Gate on a real success predicate, NOT bare
  `ok && isWrite`** (§10.1): SESSION_REPLAY-ok reaches :1844 with `ok:true` for a 200-with-nested-`userErrors`
  (:1802 screens only top-level `body.errors`), so a naive hook there banks a **phantom row for a vendor-REJECTED
  create**. `recordCreate` must apply the same nested-`userErrors` rejection INVOKE_SESSION already does
  (connector.js:1276) before it banks — a row is never born false. Dig id/label centrally (fixes the header-replay +
  headless dropped-id asymmetry); bank `{system, verb, kind, id, label, who=clearedBy, at, recipeId, groundId,
  origin}` — **only fields actually on the evt at the seam** (`_evtBase` carries groundId/recipeId/origin,
  connector.js:1390; runId/convId are NOT threaded — deferred, §10.4). Store to the new `audit:creates` book
  (WorkflowRunStore idiom: `_chained` RMW + `total` + `truncationNotice`). Register `AUDIT ▸` with `metric: true` in
  `decisionMarkers.js` (Invariant #1; body-blind). **Verification honesty:** `recordCreate` lives in
  `background/handlers/connector.js`, which CLAUDE.md places OUTSIDE the unit gate (node --check + `npm run undef`
  only, never a unit test); the unit-testable slice is the pure `auditEntry`/`classifyCreate` (AU-0) + the
  `AuditCreateStore` I/O + **the success predicate itself as a pure function** (a `{draftOrder:null,userErrors:[…]}`
  fixture banks nothing) — the seam wiring is node --check + a **live eyeball** (a create round-trips one durable
  row; a read, a failed write, AND a nested-userErrors reject all bank nothing). *First durable capture of an
  ad-hoc chat create* — closes the §1 primary gap.
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
- **AU-6 (the writes-expansion — update/delete + broker coverage).** Generalize `verb` from create-only to
  update/delete: derive it from the **reply data field key** (`draftOrderCreate`/`…Update`/`draftOrderDelete`), NOT
  the inconsistent `operationName` (§10.3), with a per-leg `verb` hint for the ambiguous POST/REST case (`verb` is
  NOT derivable from axes — create and update are both `write:true`). Extend the extractor with a `deletedId`
  branch that **normalizes gid→tail** (createdRecordId normalizes only `v.id`/`k==='id'`; a raw `deletedId` returns
  the full gid and would NOT group with the create's stored tail — the live grouping bug). Verify the delete reply
  shape `data.draftOrderDelete.deletedId` against a real delete first (the leg is LIVE-UNVERIFIED,
  connectorRecipes.js:749) — never code it blind. Add the `INVOKE_CONNECTOR` broker success branch (chat.js:14912)
  as a **third** hook so broker writes leave the §2 bypass. Test: create→delete of one `#D` banks two events keyed
  to one entity; a nested-userErrors update banks nothing.
- **AU-7 (cross-system correlation — optional).** Bank `corrKeys` (connectorRender.js:265, the read-side join
  already computed) against creations so a Shopify draft, a Zendesk ticket, and the source warranty item group as
  one issue (`toWorkItem`, connectorRender.js:290). Test: three creates sharing an email group.
- **AU-8 (the per-record card — the surface's destination).** Once AU-6 supplies the write chain and a per-entity
  index exists (§9 shard), render the per-RECORD card: one entity → its create→update→delete timeline in the
  run-history overlay idiom (`.wf-history-overlay`). A partial history (create rolled past CAP) is **labeled**
  "earlier history rolled off (of \<total\>)", never presented as complete (§4 visible-total). This is the Rail
  card the surface (§6.1) is built toward — deferred here because grouping over a lossy `slice(-CAP)` window as the
  *primary* surface would silently drop opening events; the flat AU-3 table is the honest v1.

---

## 8. Consolidations — what to reuse, not reinvent

1. **Hook seam** — the two WRITE-capable ride-executor success branches where `reportLegOutcome` already sits
   (connector.js:1393 INVOKE_SESSION / :1844 SESSION_REPLAY-ok). **NOT :1819** — that is the reads-only retry-ok
   path (`reportLegOutcome` fires there for read vitals, but a write never lands on it), so a `recordCreate` there
   would only ever see reads. A *sibling* `recordCreate`, not a widening of the body-blind funnel (§2) — one seam,
   both write paths; the broker write path (chat.js:14912) is a third hook at AU-6.
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

## 10. Post-critical-review scope + resolutions (the honest v1)

A 3-critic adversarial pass (grounding / honesty / scope — 2026-08-07, all "flawed") found the first draft of this
section **over-reached**: it turned a flat creates store into a per-record WRITES ledger with a re-probe and a
`via` field the store, the extractors, and the executor payload cannot yet support, and left a creates-named ask
over a writes-shaped store. The convergent recommendation was **narrow**. This section is the corrected, buildable
v1; the deferred ambition (the per-record card, writes, `via`, re-probe) is sequenced, not dropped.

### 10.0 Scope — ship the flat CREATES book; the per-record card is a later VIEW
**v1 = a flat, per-EVENT, CREATES-only append book + a flat table**, 1:1 with the store (§4). The per-RECORD card
(entity grouping + CRUD-timeline drill), the writes-expansion (update/delete), `via`, and the "check current"
re-probe are **deferred** — each needs machinery v1 lacks (a per-entity index, threaded run context, a by-id read
leg) and each earns its own rung (§7). This is not a retreat from the Rail card the surface wants — it is its
correct sequencing: the flat book is the substrate the card is a later view over.

### 10.1 A real bug the review caught — the seam must AGREE on "successful write"
`recordCreate` fires on `ok && isWrite` at both branches, but they DISAGREE. INVOKE_SESSION converts a
200-with-nested-`userErrors` into `reply.success=false` (connector.js:1263-1280), so its :1392 guard blocks a
rejected write; **SESSION_REPLAY-ok (:1844) has no nested-userErrors screen** (:1802 checks only top-level
`r.body.errors`), so a server-REJECTED mutation `{data:{draftOrderCreate:{draftOrder:null,userErrors:[…]}}}`
reaches :1844 as `ok:true` — a naive hook there banks a **phantom "created" row for a create the vendor refused**
(exactly the header-replay / workflow draft path §2 covers). **AU-1 must gate `recordCreate` on a real success
predicate that also rejects nested `userErrors`** (mirror connector.js:1276), or apply the 200-not-ok conversion
inside SESSION_REPLAY before the ok-hook. A row must never be born false at the seam — §10.2's after-the-fact
honesty cannot rescue a phantom.

### 10.2 Status — a create is "created \<when\>", never "live"
v1 captures creates only, so a card is a **past-tense fact: "created \<when\> by \<who\>"** — NOT "live". "live"
reads as a present-tense current-state claim Orchard never re-checked; a create it made and never looked at again
is not known-live. `reversed`/`deleted` status arrives with the writes-expansion (AU-6), derived from the surviving
event chain — `reversed` is honest ONLY for a delete whose matching create is in-window; a delete with no
in-window create is "deleted", not "reversed" (never assume the create). The "check current" re-probe is deferred
(§7), and when built reconciles by the stored **label** (the #D-number as `shopify_draft_orders` `query`, then
match the returned row's id) via a declared create-leg→read-leg map — NOT "by id" (no read leg accepts the
internal id; `shopify_draft_orders` matches on `name`).

### 10.3 Extractors — CREATE-only in v1; the write-generalization is AU-6
AU-0 ships a **create-only** extractor: `createdRecordId`/`createdRecordLabel` (GraphQL `{data:…}`) + a non-`.data`
REST branch (`{ticket:{id}}`). The canonical key is the create's normalized id (`<system>:<gid-tail>`). The
generalization to update/delete — a `deletedId` branch WITH its own gid→tail normalization (createdRecordId
normalizes only `v.id`/`k==='id'`, so a raw `deletedId` returns the full gid and would NOT group with the create's
stored tail), and `verb` from the **iterated reply data field key** (`draftOrderCreate`), NOT the `operationName`
(inconsistent: `DraftOrderCreate` suffix vs `DeleteDraftOrder` prefix) — all move to **AU-6**, with the delete
reply shape `data.draftOrderDelete.deletedId` a **first-live-delete assumption to verify** (the delete leg is
itself LIVE-UNVERIFIED, connectorRecipes.js:749), never coded blind in the pure AU-0. `verb` is NOT derivable from
axes alone (create and update are both `write:true`); a real per-leg `verb` field is added to the recipe before
the ambiguous/REST case relies on it.

### 10.4 who — the immediate authority is enough for v1; `via` is DEFERRED
`who ∈ {human, gate}` (the `clearedBy` at the seam) already answers the load-bearing question — "you approved
these 3; the scheduler auto-created these 12 (all reversible)". The two-level `via:{runId, workflowId}` story is
**dropped from v1**: none of runId/workflowId/convId reaches the seam (the evt `_evtBase` carries only
groundId/recipeId/origin, connector.js:1390), so it needs new payload threading through `_rideExecOnce` and
`headlessWrite.invokeRideRecipe` — an unbudgeted rung. First thread runId/convId (a small rung under AU-1) only if
a join key is needed; add `via`+workflowId only if the two-level story is actually asked for (matching §3's honest
"(if on payload)" hedge, not an over-claim).

### 10.5 Customer label — capture a MINIMAL human label (consistent with §5)
The review caught an internal inconsistency: §5 stores #D-numbers + ids un-redacted at rest precisely because a
pseudonymized audit "could not answer the question", yet an id-only customer is a **hollow answer** to the
headline "what customers did I create?" (a bare internal Shopify id) AND the opposite treatment under the same
logic. **Resolution: capture a minimal human customer label at the seam** — the create input carries
firstName/lastName/email (`shopify_create_customer`), so store the first name or email-local-part (truncated),
same full-fidelity-at-rest posture as §5 (local-only, never synced, never in a `#call` payload). The customer ask
then answers for real, not link-only.

### 10.6 Surface — flat table first (see §6.1)
Rail **section, not tab** (never collides with the dev-only Connect tab); v1 is a **flat per-event table** (system
· kind · label · created-when · who), 1:1 with the store. The **per-record card + CRUD-timeline drill is AU-8**,
gated on the per-entity index (§9) — never render-time entity grouping over a lossy `slice(-CAP)` window as the
primary surface. Attention = a quiet count, never a badge.

---

## 11. Build arc — the execution-ready v1 (AU-0 → AU-3), file-grounded

**STATUS: v1 BUILT (2026-08-07).** AU-0 + AU-1 landed at v2.74.2079 (f1cdd03), AU-3 at v2.74.2080 (2c068e7), and
**AU-8 (the RECORDS rail tab — the visible surface) at v2.74.2081 (21fb93e)** — pulled forward from "deferred" after
the user reported the pull-only ask read as "nothing visible on rail" (the surface-not-capture lesson). Built:
`Core/audit.js` (pure, 37 tests), `Services/Storage/AuditCreateStore.js` (6 tests), `background/handlers/audit.js`
(the hook), the two connector.js wire points, the `AUDIT ▸` marker (capture LIVE-PROVEN 22:33Z), the chat.js "what
have I created?" intercept, and the **Records tab** (`_renderRailRecords` — a persistent card per create, drillable).
`npm test` green (4407); live eyeball owed (bus tests v2.74.2079/2080/2081). AU-2 folded into render (below).
Remaining: AU-4 (export), AU-5 (gated undo), AU-6 (update/delete writes-expansion), AU-7 (cross-system), plus a
live SW→panel push so the Records tab updates without re-opening, and the drill-to-record link (AU-2-at-render).

§7 is the full AU-0..8 ladder; this section is the **buildable v1 only** (creates → durable link → read), each rung
independently landable, `npm test`-green, and bump-per-rung. It names the exact new files, the function signatures,
the wire points (file:line as of v2.74.2076), and the per-rung test — so each build turn is mechanical, not a
re-derivation. Land order is strict: a later rung imports the earlier one's pure core.

### AU-0 — the pure core (`Core/audit.js` + `Core/audit.test.js`); NO behavior, unit-gated
Mirrors `Core/runHistory.js` (pure, tested; the store in AU-1 is the I/O around it). Exports:

- `AUDIT_VERBS = ['create']` (v1) · `AUDIT_KINDS = ['customer','order','draft','ticket','user','record']` — the
  closed enums `classifyCreate` maps into; an unknown kind falls to `'record'`, never throws.
- `auditEntry(fields) → {system, verb, kind, id, label, itemUrl, who, at, recipeId, groundId, origin}` — the
  **field-whitelist normalizer** (the `runHistoryEntry` idiom, runHistory.js:148): drops unknown keys, coerces
  types, defaults `verb='create'` / `who='gate'` / `at` from a passed-in clock (NEVER `Date.now()` inside — pass
  `at` in, so the pure module and its test stay deterministic; the seam supplies `Date.now()`).
- `classifyCreate(replyValue, recipeId, method) → {system, verb, kind}` — `verb` from the reply **data field key**
  (`data.draftOrderCreate` → the op key names entity+verb, connectorRender.js:138), else create-only from the
  recipeId (`create_ticket`→`ticket`); `kind` from the op key / recipeId; `system` from origin/apiHost. Never
  invents — unknown ⇒ `kind='record'`.
- `createRecordFrom(replyValue) → {id, label} | null` — wraps `createdRecordId` + `createdRecordLabel`
  (**import from `Core/connectorRender.js:135/:156`**, GraphQL `{data:…}`-shaped) and **adds a non-`.data` REST
  branch** (`{ticket:{id,subject}}` / `{user:{id,name}}` → id + label) so both transports extract an id.
- `auditSucceeded(replyValue) → boolean` — **the phantom-row guard as a PURE function** (§10.1, the load-bearing
  review fix). Returns false when: top-level `errors[]` non-empty, OR any `data.<op>.userErrors` non-empty (mirror
  connector.js:1274-1278), OR `createRecordFrom` extracts no id. A rejected mutation banks NOTHING. This is the
  screen SESSION_REPLAY-ok lacks upstream, lifted to where BOTH seams can call it.
- `customerLabelFrom(inputParams) → string|null` — the §10.5 minimal label: first name, else email-local-part,
  truncated ≤24. Fed the create INPUT (`shopify_create_customer` carries firstName/lastName/email), not the reply.
- `appendCreate(prev, entry, {cap}) → items[]` + `truncationNotice(shown,total)` + `AUDIT_CAP=500` — reuse
  runHistory.js's `appendRun`/`truncationNotice` verbatim if importable; else the same 3 lines.

**Test** `Core/audit.test.js` (in the `Core/*.test.js` gate): `_GQL` fixtures `customerCreate`/`draftOrderCreate`
→ id + `#D`/name label; a Zendesk REST `{ticket:{id,subject}}` → id, `kind='ticket'`; the **rejected** fixture
`{data:{draftOrderCreate:{draftOrder:null,userErrors:[{message:'…'}]}}}` → `auditSucceeded=false`; a customer
input → `customerLabelFrom` = first name; `auditEntry` drops an unknown field and defaults `at`. **Nothing wired —
`npm test` is the whole gate for AU-0.**

### AU-1 — the store + the hook (`Services/Storage/AuditCreateStore.js`, `recordCreate` at the two seams)
Two pieces, one landable rung:

1. **`Services/Storage/AuditCreateStore.js`** — mirrors `WorkflowRunStore.js` exactly, but a **single global key**
   `'audit:creates'` (not per-id): `_chained` serialized RMW, `loadCreates() → {items,total,notice}`,
   `appendCreateEntry(fields,{cap=AUDIT_CAP})` (normalize via `auditEntry`, `appendCreate`, bump lifetime `total`,
   store `{items,total,updatedAt}`). **Test `AuditCreateStore.test.js`** (in the `Services/Storage/*.test.js`
   gate): append banks a row; eviction past cap keeps `total` > `items.length` and a non-empty `notice`.
2. **`recordCreate(evt)`** — a sibling to `reportLegOutcome`, in a NEW `background/handlers/audit.js` (keeps
   connector.js's diff minimal; `reportLegOutcome` stays body-blind, §2). Body: `if (!auditSucceeded(evt.value))
   return;` → `classifyCreate` + `createRecordFrom` (+ `customerLabelFrom(evt.inputParams)` when kind==='customer')
   → `auditEntry` → `AuditCreateStore.appendCreateEntry` → `Logger.info('audit', 'AUDIT ▸ …')` **body-blind**
   (system·kind·verb·who only — never the label/id in the marker text; §5/§7-7).
3. **Wire at the TWO write branches** (guarded `if (isWrite)`, `try/void` so it never blocks the response):
   - `connector.js:1393` (INVOKE_SESSION ok): `recordCreate({ ..._evtBase, value: reply.value, method, who: clearedBy, inputParams: (payload && payload.params) })` — `reply.value` already passed the :1263-1280 screen here, so `auditSucceeded` is belt-and-suspenders.
   - `connector.js:1844` (SESSION_REPLAY ok): `recordCreate({ transport:'ride', origin: sessionHost, groundId, recipeId, value: r.body, method, who: clearedBy, inputParams: (payload && payload.params) })` — **here `auditSucceeded` is load-bearing** (no nested-userErrors screen upstream; §10.1).
   - **NOT `:1819`** — reads-only retry-ok (§8.1).
4. **Register `AUDIT ▸`** in `Core/decisionMarkers.js` `DECISION_MARKERS` with `metric: true` + a body-blind
   `metricPattern` (Invariant #1 — else the marker is view-only and never reaches the CloudWatch count).

**Verification honesty:** `recordCreate` + the two wire edits live in `background/handlers/*.js`, OUTSIDE the unit
gate — `node --check` + `npm run undef` + a **live eyeball**: a create banks exactly one durable row; a read, a
failed write, AND a nested-`userErrors` reject each bank nothing. The unit-gated slice is AU-0 (`auditSucceeded`
included) + the store I/O. *First durable capture of an ad-hoc chat create — closes the §1 primary gap.*

### AU-2 — the durable link — VARIANCE (BUILT as store-ingredients + resolve-at-render, not fill-at-capture)
The seam does NOT carry the leg's `itemUrl` template — the `{handle}` lives on the ride tab, not the record
(connector.js:1297), so fill-at-capture would need the template threaded through the executor, which it isn't. The
built approach is strictly more robust: `recordCreate` stores `recipeId` + a capped `urlArgs` snapshot on the entry
(a small string-valued bag — `_capUrlArgs`, Core/audit.js), and the **surface resolves the durable link at render**
via `fillEndpoint(catalogItemUrl(recipeId), {...urlArgs, id})`. This survives reload (the pieces are stored, not the
reload-volatile `_lastGroundedRead`, chat.js:7074) AND lets a catalog `itemUrl` upgrade reach already-banked rows.
*(v1's AU-3 answer lists rows without the inline link yet; the render-time resolution is the small remaining rung.)*

### AU-3 — the surface (read): the "what have I created" ask → flat table
An ask parser (sibling to `parseDashboardAsk`, `Core/vitalsDashboard.js`) matches "what have I created / …this week"
→ `loadCreates()` → **filter `verb==='create'`** (§6.1-2: honest the moment writes are added) → a `CanvasSpec`
table (system · kind · label · created-when · who). The Rail "Records" **section** (not tab) renders the same flat
list. **Test:** the ask lists the AU-1 rows with link + who + when; a window with only reads/failed writes lists
nothing. *First user-facing answer to the question.*

### Land discipline (every rung)
Bump `manifest.json` (behavior change from AU-1 on; AU-0 is pure but still bump on land). `node --check` every
touched `background/handlers/*.js`; `npm test` green (AU-0 + store are IN the gate; the seam wiring is not). Stage
**by name** (shared checkout). One bus test per rung (AU-0: the pure fixtures pass; AU-1: a live create banks a row
+ a rejected write banks nothing; AU-3: the ask answers). Deferred rungs AU-4..AU-8 stay as §7/§10 describe.

---

*Provenance: 2026-08-07 4-scout (write-funnel / stores / privacy-scope / reversibility-surface) + synthesizer pass.
Every landmark re-verified against the code at v2.74.2073: the funnel (vitals.js:144, connector.js:1393/:1819/:1844),
the extractors (connectorRender.js:135/:156), who-confirmed (rideStep.js:61, connector.js:884-885/:1655-1656), the
store idiom (WorkflowRunStore.js, runHistory.js:26/:148/:196, ActionLedgerStore.js:39), the write axes
(connectorRecipes.js:296/:622/:669/:753), the privacy boundary (redact.js, DESIGN_llm_privacy.md, DESIGN_cloud_logs.md,
StoragePaths SYNCABLE_KINDS), and the surface (vitals.js:562, vitalsDashboard.js). The store decision reconciles the
two scout recommendations — a sibling book (Scout B) over the action ledger, carrying Scout C's local-only /
not-sync / body-blind-marker posture as fields rather than a key.*

---

## 12. Record LIFECYCLE (AU-6 substrate) — the watch, the hand-off, the decay

*(v2.74.2148. Rulings 2026-08-10, recorded inline. Stages 0–2 are BUILT; this section specs 3–8.)*

> **BUILD STATE, v2.74.2204** — the SUBSTRATE landed; the TRIGGERS mostly have not.
>
> **Built + unit-gated** (`Core/recordLife.js`, 33 tests, §12.7's list in its order): the three-state machine
> (§12.2) with `gone` terminal and absorbing and no `settled` · the one append-only timeline with the `create`
> entry never evicted (§12.1a) · `applyTransition` — same row, `kind`/`id` immutable, `currentKind`/`currentId`
> advancing, warm restarted, and a re-read that confirms appending nothing · `applyUpdate` appending only on a
> real change · `applyGone`, idempotent · `warmWindowMs` reading `warm: '60d'` as recipe data (§12.4), resolved
> at the write seam and banked as `warmUntil` · `asOfLine` (§12.6) · `mayRead`, where `cold` suppresses per-record
> reads and NOT collection reconciliation (§12.3, the corrected rule).
>
> **Built, in the surfaces**: `auditEntry` births a row warm with its one-entry timeline · the record card renders
> the hand-off (`draft → order #1234`) and the as-of line · **the §12.1a AU-2 defect is closed** — the eye resolves
> from `currentKind`, so a completed draft can no longer build a draft URL carrying an order id.
>
> **Triggers (§12.3): ONE of five.** `verify-at-view` is wired only in its cheapest form (the card reads the
> banked state); a delete WE perform records `gone`. **Not built:** the tee hint, the `webNavigation` trigger, the
> targeted per-record re-read, and the collection poll on `vitals:tick` (§12.4) — which is the one that catches a
> change made ELSEWHERE, and therefore the one that makes the watch mean anything against another machine.
> Until it lands, Orchard learns of a vendor-side change only when it did the change itself.
>
> **Also not built:** §12.5's `readTransition` adapter (still LIVE-UNVERIFIED per §10.3 — a real order must be
> created first) and §12.9's `observe` extractor. `applyUpdate` accepts the fields §12.9 would produce; nothing
> produces them yet.

### 12.0 The principle everything else follows from

**A ledger row is one of ORCHARD'S ACTS. `kind` and `id` are the CURRENT STATE of the artifact that act
produced.** Ruled 2026-08-10: when draft `#D1099` is completed into order `#1234`, **no new row is created** — it
is the same record changing kind.

Orchard created one thing. A human completing it did not make Orchard create a second thing; Shopify minted an
Order as a consequence of a *human* act. A second row would double-count an act that happened once, and would
corrupt the AU-3 answer ("you've created 12 records" becoming 24 because half completed). It also matches where
§7's AU-8 always pointed — *one entity → its create→update→delete timeline*. **A completion is an EVENT, not a
row.**

### 12.1 Identity — the vendor id stops being the key

Today `auditEntry.id` is both the vendor's id and the row's identity. Under §12.0 those separate, because the
vendor id CHANGES (`DraftOrder/1099` → `Order/1234`). The row needs a stable key while `kind`/`id` move.

Cheapest form, and it needs **no migration of existing rows**: keep the row keyed by its **original create id**
(already banked, already the drill's join key) and add the current pointer plus the event timeline (§12.1a).

    id            '29685'        // IMMUTABLE. the create id. the row's identity, forever.
    kind          'draft'        // IMMUTABLE. what Orchard CREATED. never rewritten.
    currentId     '1234'         // the artifact NOW (absent until a hand-off)
    currentKind   'order'        // the artifact's type NOW (absent until a hand-off)
    events        [ … ]          // append-only. ONE timeline. §12.1a
    source        {…}            // what CAUSED this act. §12.8
    watch         'warm'|'cold'|'gone'
    warmUntil     <ms>           // when warm decays; absent when cold/gone
    lastSeenAt    <ms>           // when state was last CONFIRMED (drives "as of", §12.6)
    outwardAt     <ms>           // §13 — when something left the boundary on this record

### 12.1a ONE timeline, not three arrays

An earlier draft of this section carried a `chain[]` of prior kinds and would have grown a second array for
observed values. That is two mechanisms for one idea. A record has **one append-only `events[]`**, and every
entry is `{at, type, …}`:

    { at, type:'create',     kind, id, label }
    { at, type:'update',     fields:{…} }              // §12.9 — observed values changed
    { at, type:'transition', fromKind, fromId, toKind, toId }
    { at, type:'gone',       why:'404'|'deleted' }

`currentKind`/`currentId` are a **derived cache** of the newest `transition`; the timeline is the truth. This is
exactly what §7's AU-8 named as the destination — *one entity → its create→update→delete timeline* — and it means
AU-6's `verb` generalization and this section's watch machinery produce entries in the SAME list rather than two
parallel histories that can disagree. Capped like `TIMELINE_CAP`, oldest non-`create` evicted first (the `create`
entry is never evicted — it is the row's reason for existing).

`kind` and `currentKind` are **both** kept because one value cannot do both jobs: `describeCreate` renders `kind`,
and a completed draft rendering as `order` would report that you created an order, which you did not. The card
renders the transition — `draft → order #1234` — which is also the warranty question answered at a glance (the
replacement actually went out).

**Consequence — a live defect in AU-2 as shipped.** `_recordOpenUrl` resolves `itemUrl` from `recipeId`
(`shopify_create_order` → `/store/{handle}/draft_orders/{id}`). After a hand-off that builds a **draft URL
carrying an order id** — not a visible 404, potentially a different record. The link must resolve from
`currentKind || kind` (kind `order` → `shopify_order` → `/store/{handle}/orders/{id}`), so it follows the
artifact rather than freezing at the act. **This lands WITH AU-6 or the eye silently misleads.**

### 12.2 The state machine — three states, and only observed facts leave

       create ──▶ WARM ◀──────── re-warm (any observed change)
                   │                        ▲
                   │ warm window elapses     │
                   ▼                        │
                 COLD ─────────────────────┘
                   │
                   │ observed non-existence (404 / delete confirmed)
                   ▼
                 GONE   (terminal; the only eviction)

**There is no `settled`.** An earlier draft of this spec had one, derived from a status enum meaning "this can
never change again." Ruled out 2026-08-10: *an order can be returned after it ships.* `settled` was a
**prediction**, and Orchard cannot know a record's future from its present — the same class of error as reporting
a decided row as `not run`. Refunds, unarchives and chargebacks all falsify it.

Dropping it costs **nothing**, which is what makes the ruling free rather than a trade: `cold` is view-only
(§12.3), so a cold record consumes zero background work, and `AUDIT_CAP` already bounds the book at 500 with a
visible notice. Eviction was never needed for cost control.

**GONE is an observation, never a forecast** — the object returned 404, or a delete we performed succeeded.

**Hand-off is NOT an exit.** Under §12.0 it is a `transition` event on a surviving row (§12.1a): `currentKind`/
`currentId` advance, the timeline appends, and the warm window RESTARTS (something just changed). This also
removes the blind-spot risk of migrating a watch to a different row and abandoning the original.

The **tracking-number case is why this matters concretely**: the number appears on the ORDER, days after the
DRAFT was created. A model that ended the draft's life at completion would stop watching immediately before the
thing worth seeing happened.

### 12.3 Triggers — four, cheapest first; the poll is the BACKSTOP

| trigger | cost | catches | fires when cold? |
|---|---|---|---|
| tee hint — `harvestTee` `{method,url,status}` | free | the human changing it **in this browser** | **yes** |
| navigation — `webNavigation` onto the record's `itemUrl` | free | them looking at it | **yes** |
| verify-at-view — Records tab render / eye click | 1 read, on demand | whatever is true right now | **yes** |
| collection poll | 1 read for **N** records | changes made **elsewhere** | **yes** — see below |
| targeted per-record re-read | 1 read **per record** | confirming one row | **no** |

**`cold` suppresses PER-RECORD reads, not collection reconciliation.** *(Corrected 2026-08-10 — the tracking-number
case falsified the first version of this rule, which said cold suppressed the poll outright.)*

The reasoning: a collection read (`orders updated since X`) is **O(1) in records** — covering a cold row costs
nothing extra, because it is the same single request either way. Excluding cold rows from reconciliation saves
zero and buys a blind spot precisely where it hurts: a draft that sat long enough to go cold, then was completed
on someone else's machine, would go unseen until a human opened the Records tab. So the poll runs on its leg
cadence and its results are reconciled against **every** row; `warm`/`cold` governs only the reads whose cost
scales per record.

**Nothing suppresses OBSERVATION at any tier.** A return processed in this browser lands immediately on a record
cold for months. That is what makes view-only decay safe (ruling 2026-08-10, open question 1).

The tee is **body-blind by construction** (`DESIGN_llm_privacy.md`): it yields *"something changed"*, never a
value. That is the correct primitive — it triggers a targeted re-read without ever reading a body.

### 12.4 Cadence attaches to the LEG, not the record

Ruled 2026-08-10. Neither "one cadence for every record" (re-reads records that cannot change) nor "a bespoke
cadence per record" (config nobody maintains — the chore burden the iron principle forbids).

- **The unit of polling is the COLLECTION.** `shopify_draft_orders` (`DraftOrderList`) answers for N drafts in ONE
  request; per-record polling is O(N) requests on a live user session and is untenable near the 500 cap.
- **The `pulse: {kind, scope, status}` marker already on recipes is the descriptor** — "the read's GENERIC digest
  semantics, as DATA" (connectorRecipes.js:257). Reuse it; do not invent a parallel one.
- **The warm window is recipe DATA, not code**: `warm: '60d'`. An order's meaningful window tracks the merchant's
  return policy, which is not derivable and differs per store; a ticket's is days. Declared, visible, editable.
- **A per-record override may exist, but never as the mechanism** (ruling: "agree") — only once someone asks.

**Reuse the scanner; do NOT add an alarm.** `vitals:tick` is explicitly *"one alarm — the window is the cadence,
the tick is just the scanner"* and already absorbed `conn:heartbeat`; a second alarm regresses that
consolidation, and under MV3 alarms are the only durable timer. The precedents to extend, not re-derive:

- `dueForDaily(recipes, now, windowMs)` (Core/vitals.js:73) — the staleness gate
- `kaCadenceMs(rec)` (Core/vitals.js:303) — **learned** cadence, and its `futile === true → null` is already the
  "stop probing this" shape
- `invokeRideRecipe` — the shared runner the canary and workflow steps both use

### 12.5 The transition adapter — the seam the HAR gap hides behind

The completed-draft reply shape, the transition field, and the delete reply are **LIVE-UNVERIFIED**; §10.3's rule
is never to code them blind, and a real order must be created first. That must not block the design, so the
unknown is isolated behind ONE per-platform function:

    readTransition(replyOrRecord, { kind, id }) -> null | { toKind, toId, at }

- **If the reply carries the new order id** → the hand-off is recorded free, at the write seam.
- **If it does not** → the tee hint says *something changed* and we do ONE targeted re-read (§12.3's C1→A1 path,
  already specced).

**The unknown therefore fails toward a RE-READ, never toward a guess** — the same fail-open posture as
`tools/glf/precheck.cjs`. When the HAR lands it either deletes a read or confirms one is needed; nothing else in
this section changes. A hand-off must be **observed** (an `order` link populated), never inferred from a status
string, and the `transition` event records what it handed off to so the change is auditable rather than assumed.

### 12.6 Staleness is rendered, never implied

Under session-ride the poll runs ONLY while the user has a live session, so a cadence is a **ceiling, never a
guarantee** — "at most every N", not "every N". Every surface therefore renders **"as of \<lastSeenAt\>"**, the
same visible-total honesty §4 forces on `truncationNotice`. A record may have changed without Orchard knowing;
the surface must not imply completeness it does not have.

### 12.7 Per-rung tests (pure half, unit-gated)

- `nextWatch(row, now)` → warm→cold at the window; any change re-warms; gone is terminal and absorbing
- `applyTransition(row, {toKind,toId,at})` → same `id`, `kind` UNCHANGED, `currentKind`/`currentId` set, a
  `transition` event appended, `warmUntil` restarted — and asserts **no second row**
- `recordOpenUrl` resolves from `currentKind` after a hand-off (the §12.1 defect, as a regression test)
- `describeCreate` still reports what was CREATED after a hand-off (never "you created an order")
- a cold row still accepts an observed change, AND is still reconciled by a collection poll (§12.3)
- `sourceRef` survives the three hops and is never invented when the caller supplied none (§12.8)
- `observeFields` extracts declared paths only; an absent path yields no key, never `undefined` (§12.9)
- an `update` event is appended only when a watched value CHANGED — a re-read that confirms the same tracking
  number must not grow the timeline (§12.9)

### 12.8 PROVENANCE — the record must name what caused it

*(Pulled forward 2026-08-10. §7's AU-7 is `corrKeys` — fuzzy grouping on a shared email via `toWorkItem`. This is
a DIFFERENT, stronger thing: a direct causal pointer. Specced as **AU-7a**, ahead of the correlation work, because
four separate design questions have now stalled on it.)*

Today a row knows the Shopify chain (`draft → order`) and nothing about WHY it exists. A tracking number for
order `#1234` with no link to warranty task `#4899327` has nowhere to go — and the same gap blocks "which
homeowner is this for", "show me everything this task produced", and any future write-back.

    source: { system:'vendorsuite.drhorton.com', kind:'task', id:'4899327', label:'#4899327', url?:'…' }

**Available at the write seam, merely unthreaded.** When `_runBranchClause` invokes the draft-order create it is
iterating warranty rows and already holds the item — `PIPELINE_RECORD_ITEM` carries `record:{ref,host,url}` for
the same reason. Three hops, named so none is forgotten (the invariant-#3 discipline):

1. the panel puts `source` on the invoke payload at the call site
2. `connector.js` passes it into `recordCreate(evt)` beside `recipeId`/`urlArgs`
3. `auditEntry` whitelists it — unknown shapes dropped, strings capped, exactly like `urlArgs`

**Never inferred.** If the caller supplied no source, the row has none; a guessed provenance is worse than an
absent one, because everything downstream would trust it. Ad-hoc chat creates legitimately have no source.

**Privacy** — ids and a short label only, never a contact block. §5's local-only / un-redacted-at-rest posture
applies unchanged; nothing here reaches a wire.

#### 12.8.1 Viewing the INCITING object — the asymmetry with the eye

Provenance implies the symmetric affordance: AU-2 lets a user view the object Orchard CREATED on its native
platform, so they must also be able to view the object that CAUSED it. Same intent, and — for VendorSuite —
**a fundamentally different mechanism**, which is the whole content of this subsection.

**VendorSuite has no per-record URL.** `vs_warranty_task` declares `itemUrl: '/#warranty'` — the SPA's warranty
*section*, not task `#4899327`. Every `vs_*` URL template is a section route (`/#warranty`, `/#dashboard`).

> **This defeats AU-2's guard, and that is a live trap.** `recordOpenUrl` refuses a template with an UNFILLED
> `{…}` placeholder ("no button beats a 404"). `/#warranty` has no placeholder to leave unfilled, so it fills
> cleanly, returns a valid-looking absolute URL, and opens the warranty LIST while claiming to open the task. The
> failure is invisible — the user lands on a real page and has to notice it is the wrong one. **A source whose
> `itemUrl` carries no record-identifying placeholder must be treated as HAVING NO LINK**, not as having a
> working one; the eye is suppressed and the drive (below) is offered instead.

**The drive already exists — do not build a second one.** `_openRecordOnSite` (chat.js:15003) is the deterministic
drill: *API read → navigate to `listUrl` → text-click the row*, explicitly described there as "landmark-free — the
RELIABLE path", serving as both the cold route and the fallback when a taught capability fails to replay. It
selects any leg carrying `drill.matchOn` + `listUrl`, and **VendorSuite already satisfies it**:

    vs_warranty_tasks:  listUrl: '/#warranty',
      drill: { via:'vs_warranty_task', param:'taskId', from:'TaskId', matchOn:'address',
               label:['AddressLine1','CityStateZip','TaskNumber',…,'SearchField'], also:['vs_task_contacts'] }

The leg's own `does` already advertises it — *"or say 'on the site' / 'on vendorsuite' to open that record on the
warranty page itself instead"*. So the button is a **new ENTRY POINT to an existing capability**, not a new
artifact. `source.id` (the TaskId) is sufficient: the drill reads the task, takes its address, and matches the row
by `matchOn:'address'` — the id is not visible on the page, the address is, which is why that config reads the way
it does.

**Consequences that must not be skipped:**

- **Invariant #2 — busy-mark the tab.** This drive is ENGINE-driven clicks on a user tab. Every such emitter wraps
  its span in `markEngineBusy(tabId, true/false)` in a `try/finally` (connector.js:745/785, explore.js:59). A new
  entry point that forgets it re-introduces phantom `INTERACTION hit/miss` lines in the trace — the exact failure
  that was re-diagnosed four times (§Invariant 2). The card button is not the user demonstrating; it is the engine
  driving.
- **It is SLOW and it MOVES THE USER'S TAB.** Unlike the eye's instant link, this is a read plus a navigation plus
  a click, and it can fail. The control must show in-flight state and report failure honestly ("couldn't find that
  row on the warranty page") rather than appearing to do nothing.
- **Tab discipline is already solved** — `SHOW_SOURCES { focusOnly: true }` ensures/focuses the ground's tab and
  deliberately does NOT navigate an existing one (v1555 navigated to the site root, a full reload that broke a
  hash-route start). Reuse it; do not re-derive tab handling.

**Surface.** The card's action row keeps ONE eye — the created object, the primary act. Provenance rides the card
as a TEXT chip on the meta line ("from #4899327"), not a second identical eye: two eyes side by side cannot say
which is which, and the icon registry has no honest glyph for "the thing that caused this" (`back` is reserved by
§5.4's fixed dismiss metaphors). The chip states its cost in its title — *"Open warranty task #4899327 on
VendorSuite (drives your VendorSuite tab)"* — and the drill overlay renders the full `source` line with the same
action, where there is room for the explanation.

**Generalization.** A source is viewable by LINK when its kind resolves a record-identifying `itemUrl`, and by
DRIVE when its ground has a `drill.matchOn` + `listUrl` leg. Neither → no affordance, and the drill overlay says
why. Zendesk sources take the link path (`/agent/tickets/{id}` — a real per-record URL); VendorSuite takes the
drive. The record card never encodes which platform is which.

#### 12.8.2 The SAME affordance on a desk CASE — `Show task`

*(Ruling 2026-08-10. The record card is not the only surface that owes "view the inciting object": a case opened
because warranty instructions were AMBIGUOUS is precisely where a human needs the task in front of them.)*

`Core/contactReview.js` `controlsFor(channel, …)` today yields three sets, all of them **mutating**:

    email       [ Send to <email> ]* [ Edit the draft ] [ Call instead ] [ Leave unresolved ]
    call        [ Mark called — <phone> ] [ Email instead ] [ Leave unresolved ]
    unresolved  [ Close — nothing owed ] [ Email them anyway ] [ Call them anyway ]

**`Show task` is a fourth `kind`, and the distinction is load-bearing.** The existing kinds — `primary`,
`secondary`, `override` — all decide or mutate. Showing the task decides nothing: it can be taken freely, any
number of times, at any point in the review, and it leaves the case exactly as it was. That is a real safety
property for a reviewer facing a `danger` control two positions away, so it is encoded rather than left to
styling:

    { id:'show-task', kind:'reference', label:'Show task' }

**`reference` controls mutate nothing** — a renderer may never give one the `danger` treatment, and a mis-click
costs nothing.

**It belongs on ALL THREE channels, not just `email`.** The motivating case is *ambiguous instructions*, which
resolves to the `unresolved` channel — the row where reading the task matters most. A reviewer needs the source
regardless of which way the decision went.

**Ordering:** after the decision controls in DOM order so the primary stays dominant, and rendered plainly rather
than as a competing chip. The decision is the point of the card; the reference is support.

**No new plumbing — this is buildable NOW.** Unlike the record card (which waits on §12.8's three hops), a case is
already born FROM the warranty row: `PIPELINE_RECORD_ITEM` carries `record:{ref,host,url}` for exactly this
reason. The case surface therefore already holds what the drive needs.

**Same drive, same obligations.** It routes to `_openRecordOnSite`'s drill (§12.8.1), so: Invariant #2
busy-marking is REQUIRED (engine-driven clicks on a user tab), `SHOW_SOURCES {focusOnly:true}` owns the tab, and
failure is reported honestly on the card rather than silently doing nothing. `contactReview.js` stays PURE — it
emits the control descriptor; the renderer performs the drive.

**Test delta:** `controlsFor` gains a case per channel asserting the `reference` control is present in all three,
that it is never `danger`, and that it never appears before the channel's `primary`.

### 12.9 OBSERVED FIELDS — the payload dimension (tracking, and its kind)

*(Folded in 2026-08-10. §12.0–12.7 track lifecycle STATE; a tracking number is DATA. That was a hole in this
section, not merely an unbuilt rung: nothing said "capture this value when it appears.")*

#### 12.9.1 Why a flat `{name: path}` map is wrong

The first draft of this subsection was `observe: { tracking: 'fulfillments[].trackingInfo.number', … }`. That
handles exactly ONE shape — a scalar — and silently mangles the rest. Three real observation shapes exist, and the
Zendesk-reply and return-status cases are the second and third:

| shape | example | what a flat map does |
|---|---|---|
| a **scalar** moves | `displayFulfillmentStatus: UNFULFILLED → FULFILLED` | works |
| a **collection gains a member** | a Zendesk ticket gets a reply | diffs whole arrays — pagination and re-ordering read as change; the NEW member is never isolated |
| a **member's own state moves** | `returns[].status: REQUESTED → CLOSED` | cannot express it at all: there is no per-member identity to hang the change on |

So `observe` is not a path map. It is a set of **observers, each declaring its KIND**, and the vocabulary is the
one `lookup` already established (`rows` / `pick` / `id` / `each`) rather than a new one.

#### 12.9.2 The three observer kinds

**A · `field` — a scalar on the record.**

    shipStatus: { of:'field', at:'displayFulfillmentStatus' }
    tracking:   { of:'field', at:'fulfillments[].trackingInfo.number' }

Emits `{type:'update', fields:{shipStatus:'FULFILLED'}}` when the value changes, absent→present included.

**B · `set` — a collection whose MEMBERS are the news.** (the Zendesk reply case)

    replies: { of:'set', rows:'comments[]', id:'id',
               keep:{ author:'author_id', at:'created_at', public:'public' } }

Emits `{type:'update', added:[{id, author, at, public}]}` for members never seen before.

- **`id` is REQUIRED.** Without member identity you cannot distinguish an append from a re-order, and every poll
  looks like change.
- **Additions only, by default.** A member that vanishes is far more often pagination (`first: 10`) or a filter
  change than a deletion. Concluding "removed" from a truncated read manufactures false events — the same
  silent-truncation failure §5.6 exists to prevent. A removal that MATTERS is its own `gone`-shaped observation,
  declared explicitly.

**C · `member` — a collection whose members have their own state.** (the return-status case)

    returns: { of:'member', rows:'returns[].edges[].node', id:'id',
               track:{ status:'status' } }

Emits `{type:'update', changed:[{id, status:'CLOSED'}]}` when a tracked field on an ALREADY-KNOWN member moves.
This is B composed with A, which is why it needs no third mechanism — a new member arrives via the `set` rule, and
its subsequent state changes via this one.

#### 12.9.3 Non-goal: no predicates, no derived values

`observe` will NOT gain a comparison/predicate syntax (`shipped: 'displayFulfillmentStatus == FULFILLED'`, counts,
computed booleans). That is the first step of a query DSL, and a DSL needs its own parser, tests, docs and error
surface — and then someone puts business logic in a recipe string where no test can see it.

**Observe raw values; let the RENDER decide what to say.** "Shipped" is a rendering of `shipStatus === 'FULFILLED'`,
in code, next to `describeCreate` — pure functions over stored facts, unit-tested. Counts are derivable from a
`set`'s member list and need no kind of their own.

#### 12.9.4 Which leg carries `observe` — the READ leg, not the create

Ambiguous in the first draft, and it matters because the record's kind changes. `observe` lives on the leg that
**refreshes** a kind, not the one that made it: `shopify_order` (kind `order`), not `shopify_create_order`. So
after the draft→order hand-off the record is read — and observed — through the leg appropriate to its CURRENT
kind, the same resolution §12.1 already forces on `itemUrl`. A kind with no read leg is simply unobservable, and
says so, rather than silently observing nothing.

**No new read is needed for the worked case.** `shopify_order`'s existing query already returns
`fulfillments { status displayStatus estimatedDeliveryAt deliveredAt trackingInfo { number company url } }` and a
`returns(first:10){ … status … }` block (connectorRecipes.js:126) — `observe` only names which of those to keep.

#### 12.9.5 Rules common to all three kinds

- **Named fields only, never the whole record.** `at` / `keep` / `track` ARE the minimization boundary; a record
  body is never banked because one field was wanted (§5).
- **Metadata by default for free text.** A `set` over ticket comments keeps `{id, author, at}` — knowing a reply
  HAPPENED is the observation; its prose is customer correspondence. Banking a body requires naming it explicitly
  in `keep`, and it stays display+comparison only: observed values never widen the LLM or wire path
  (`DESIGN_llm_privacy.md` channel map).
- **An unchanged re-read appends NOTHING.** Otherwise a daily poll manufactures a timeline of identical entries.
- **Absent yields no key** — never `undefined`, never `''`. "Not shipped yet" and "we did not look" must stay
  distinguishable, the rule §5.7 applies to a stage that never ran.
- **A partial read is not a change.** If the reply is truncated or errored, observers emit nothing rather than
  inferring absence. Fail toward silence, since a false event is worse than a late one.
- **Per-event cap.** A busy ticket must not append fifty `added` members in one entry; cap the members carried per
  event and state the overflow in it, never drop silently (§4's visible-total posture).
- **Surfacing** (ruling: *"listing the tracking info on the record updates is good enough for now"*): the drill
  renders `events[]` as dated lines — *"12 Aug · shipped · 1Z999AA10123456784 (UPS)"*, *"12 Aug · 1 reply"*,
  *"14 Aug · return CLOSED"* — and the card's meta may carry the newest material one. The tracking URL rides the
  existing eye idiom rather than a new control.

#### 12.9.6 Tests

- `field`: absent→present emits; unchanged emits nothing; present→absent emits nothing (a partial read)
- `set`: a new member emits once and never again; a re-ordered array emits nothing; a truncated array emits
  nothing; a member with no `id` is refused at config validation, not silently skipped at runtime
- `member`: a tracked field moving on a known member emits; an untracked field moving emits nothing; a NEW member
  routes to the `set` rule, not `changed`
- all three: an errored/partial reply emits nothing; `keep`/`track` extract only declared paths

**Explicitly OUT of scope** (ruling 2026-08-10): acting on the value — writing it back onto the warranty task, or
emailing the homeowner. VendorSuite has **no write leg** today (all seven `vs_*` legs are reads), so write-back is
blocked until VendorSuite writes are tackled; and an email is an `outward` act which would set `outwardAt` and
suppress the undo (§13). Detection and display land now; delivery is a later, separately-gated rung.

---

## 13. The REVERSAL affordance (AU-5 surface) — when a record card may offer to un-make it

*(Answers "should a delete button be added to the record card?", 2026-08-10.)*

### 13.1 Three questions that get conflated

1. **CAN it be un-made?** — does a reversal leg exist for the record's *current* kind?
2. **SHOULD it be?** — has anything already left the boundary on this record?
3. **Is it STILL un-makeable?** — does current state still match what that leg can act on?

### 13.2 The derivation — the button is DERIVED, never decided per kind in the UI

    offer reversal  ⟺  reversalLeg(currentKind || kind) exists
                    ∧  outwardAt is unset            (nothing has left the boundary)
                    ∧  state is fresh                (verified read, not a cached row)
                    ∧  watch !== 'gone'

### 13.3 Why the leg axes alone are NOT sufficient — the finding

The recipes already declare `write` / `reversible` / `outward` / `destructive`, and `pipelineGate` already gates
on `outward || !reversible`. It is tempting to derive the button from those alone. **It does not work**, and the
reason generalizes:

> **The declared axes describe the ACT, not the RECORD'S HISTORY.**

`delete_ticket` (connectorRecipes.js:410) is `destructive: true, outward: false` — and it is right to be, because
*deleting* is an internal act. But the TICKET may have accumulated an outward effect since creation: the warranty
contact arm **emails the homeowner**. Deleting the ticket does not unsend that email; it only destroys the record
of a message the customer already holds.

So propriety cannot be read off the delete leg. The RECORD must carry `outwardAt`, accumulated from its own
events (§12) — set the moment any `outward: true` act touches it. This is the second input the axes cannot give.

### 13.4 The cases, resolved by one rule

| record | reversal leg? | outward? | offer |
|---|---|---|---|
| **Shopify draft order** | yes — `shopify_delete_order`, already named as the reverser in the create recipe's `does` | no — a draft is not sent | **shown** |
| **Shopify draft, invoice sent** | yes | **yes** — the invoice email left | **suppressed** (same rule, non-Zendesk — evidence it generalizes) |
| **Sent Zendesk ticket** | yes — `delete_ticket` exists | **yes** — the reply was emailed | **suppressed** |
| **Shopify order** | **no** — no reversal leg for kind `order`; cancel/refund is a DIFFERENT act with different semantics, not an undo | n/a | **no button** |

### 13.5 Suppression must EXPLAIN itself

A card that silently lacks a button teaches nothing, and the iron principle is *zero chore visits, decisions
always VISIBLE*. But a permanently disabled button is clutter.

**Resolution:** no dead control on the card; the **drill overlay** states the reversal status in words —
*"Reversible until completed"* · *"Can't be undone — the invoice was sent 12 Aug"* · *"Orders can't be deleted;
refund or cancel on Shopify"*. The eye keeps working in every case, so there is always a way to go look.

### 13.6 Naming and gate

- **The verb is UNDO, not Delete.** The ledger is "what Orchard made", so the reversal is un-making Orchard's act;
  `trash` (already in the registry) is honest as its icon precisely because the button only appears when the act
  *is* a delete. The concrete act is named in the confirm ("Delete draft #D1099 on admin.shopify.com").
- **Freshness is REQUIRED, not optional.** Offering undo on an already-completed draft is worse than offering
  nothing, so the control is gated on a verify-at-view read (§12.3), never on the cached row.
- **Human-click only, never auto** — money = human-click (§6, PP-4). The gate *requires* the click; the card only
  *offers*.
