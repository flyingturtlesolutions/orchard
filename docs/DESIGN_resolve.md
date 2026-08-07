# DESIGN — Lookup-resolve: human input → resolved id (the generalized resolve capability)

**Status:** design note (2026-08-07). Not built. Produced by a 5-researcher + 2-critic deep-research pass; this
is the *revised* design — the critique-driven corrections are folded into the relevant sections, not footnoted.
The `shopify_create_order` (draft order) leg is the first user; the capability is general.

**One-line problem:** users type a customer **email** and a product **name**; the write legs demand a **Customer
gid** and a **ProductVariant gid**. `shopify_create_order` (Core/connectorRecipes.js:664, authored v1388,
LIVE-UNVERIFIED per its own comment) takes raw gids and declares no resolution at all — so it is unreachable by
any real ask. That is the unreachable-clause safety property (built-but-unnameable is worse than unbuilt), not an
ergonomics nit.

---

## 1. Where it sits — the fourth resolver

Three mature resolvers already turn human input into ids; the draft-order case straddles the axis they split on:

- **`resolve`** (Core/rideParamResolve.js:73) — filters a **params-free same-origin GET corpus** in memory
  (`_rideResolveVia` forces `method:GET, body:null`, chat.js:12727). Works for VendorSuite because `/State`
  returns all ~121 divisions inline; exact-matches one flat scalar → one id.
- **`joinKey` + the map step** (Core/peritemMap.js:307 `ladderValues`) — the live warranty→Shopify email→customer
  resolver: a per-row **parameterized search** leg.
- **`writeMap`** (Core/writeMap.js:114 `resolveWriteValue`) — constructs a create's param bag from a
  **row already in hand**.

**Lookup-resolve is the missing fourth: invoke a search leg with a human phrase, rank its rows under a
data-driven gate, extract the (possibly nested) gid, and assemble it into the write's params.** It is a *new
mechanism*, not an extension of `resolve`, because (a) the source is a **search API** (query-param'd GraphQL
POST), not a dumpable GET corpus; (b) ranking is fuzzy/relevance, not exact-over-a-corpus; (c) the id is two
edges deep (`products.edges[].node.variants.edges[].node.id`, `_GQL_PRODUCTS` connectorRecipes.js:131); and (d)
`line_items` needs **array construction paired with a parsed quantity** — cardinality the scalar `resolve` cannot
express.

It reuses, verbatim where possible: `resolveRideParam`'s verdict shape and exact-match/ambiguity logic
(rideParamResolve.js:98-116), `getPath` (rideParamResolve.js:18), `invokeRideRecipe` (Core/rideStep.js:211),
`toShopifyGid` (connectorRecipes.js:217), the HITL write-confirm chassis, and the `goalMemory` belief store. The
**one genuinely new surface is a candidate PICKER card** (today all disambiguation is a text ask-back that
re-runs the whole resolve — "asks the same disambiguation twice" with no memory).

---

## 2. Grammar — the `lookup` marker

A new per-leg marker `lookup`, keyed by the **destination param name**, beside `resolve`/`writeMap`/`joinKey`/
`drill` (same per-Ground record field, same additive projection). Two shapes, distinguished by `each`:

```
SCALAR (customer_gid):
  lookup: { customer_gid: { from:'email', viaLeg:'shopify_customer_by_email', valueParam:'email',
    rows:'customers.edges[].node', match:['email'], id:'id', label:['firstName','lastName','email'],
    exact:true } }

ELEMENT/array (line_items):
  lookup: { line_items: { each:'line_items_request', from:'product', quantityFrom:'quantity',
    viaLeg:['shopify_product_by_sku','shopify_search_products'], valueParam:['sku','query'],
    rows:'products.edges[].node', pick:'variants.edges[].node', id:'id',
    label:['title','sku','price','inventoryQuantity'],
    require:[ { field:'status', equals:'ACTIVE' }, { field:'inventoryQuantity', op:'>', value:0 } ],
    into:{ variantId:'$pick.id', quantity:'$each.quantity' } } }
```

`from` = which bound human param carries the phrase; `viaLeg` as an array = try-in-order (exact-SKU first — the
auto path — then relevance search).

**`require` is a DECLARED, system-neutral candidate-quality axis** (§9 explains why this generality matters). It
is a **list of N clauses, ANDed** — not a fixed two. Each clause is `{ field, op?, value? | values? | equals? }`
over a path in the returned row (`getPath`, so `variant.inventoryQuantity` or a parent-product field lifted into
the row both work). Supported ops: `equals` · `!=` · `>` `<` `>=` `<=` · `in [...]` · `exists`. A candidate that
fails ANY clause is **not** auto-fillable — it surfaces as `inactive` / `outOfStock` / a generic `unusable`
verdict (the clause names which). Shopify declares the two above; a site that needs five declares five; a site
that needs none omits `require`. The specific fields (`status`, `inventoryQuantity`) are Shopify vocabulary and
live ONLY in the catalog entry, never in the resolver — the resolver reads the DECLARATION.

**The `require` list is a post-search AND-filter, deliberately NOT a query language.** A candidate can be
constrained in two places: *in the search* (the `viaLeg`'s own query — e.g. `shopify_admin_search` already
carrying `status:active`, or a purpose-authored leg that queries name+color+size at once) and *in the gate*
(this `require` axis, on the returned rows). Hard/compound constraints — OR logic, cross-entity relationships,
multi-attribute search — belong in a **purpose-authored search leg the site controls** (the reason
`shopify_admin_search` / `shopify_search_products` / `shopify_product_by_sku` already coexist), NOT in a richer
`require` grammar. `require` stays a flat AND-list forever; the site's own search is the authority for anything
it can't express. This is the codebase's standing posture: declaration over cleverness, the site's API over an
invented mini-language.

**`line_items_request` is a REAL declared param, not a synthetic slot** (resolves critique open-Q #6, a safety
fork). `missingRequiredParams`, `inventedIdentifierParams`, `coerceParams`, and the interpret binder all key off
the leg's declared param list (`recipeParamSchema`, connectorLeg.js:110-138); a synthetic slot would be invisible
to them and a directly-bound `line_items` could bypass the resolver entirely. So: **the raw `line_items` param
and its "bare variant id ok" hint (connectorRecipes.js:677) are REMOVED**; `line_items_request` (an array of
`{product, quantity}` descriptors) replaces them as the model-bound surface, and `line_items` becomes a
resolver-filled destination the model cannot bind directly. One binding path, no fork.

### Invariant-#3 hops the `lookup` field must survive
1. `recipeFromCatalogEntry` (rideRecipe.js:105) — add `lookup` to the additive marker loop.
2. `harvestedRecipeLegs` — automatic (the v1432 record-spread).
3. `recipeToLeg` (connectorLeg.js:377) — add the `lookup` reader beside `resolve` (unread here = dropped on the
   seeded path — the exact class this session already fixed twice).
4. `execPlan` INVOKE_SESSION — **N/A**: resolution stays panel-side; `lookup` never rides the executor payload,
   so hop 4 stays sealed.

Plus a hop-seal test entry, so a dropped `lookup` field reddens.

---

## 3. The confidence gate — data, not the model's self-report

Explicitly **not** `applyConfidenceGate` (interpret.js:168), which gates on the LLM's self-reported confidence —
the wrong axis. The gate reads DECLARED data conditions (`require`, §2), never hardcoded field names.

**AUTO-FILL (resolve, no ask) iff ALL hold — none of these names a system-specific field:**
- the phrase yields exactly **one** row (or an exact-key hit — e.g. `sku:` via a by-key leg — that names one);
- exactly **one** candidate qualifies after the pick (`pick` path applied);
- **every declared `require` clause passes** on that candidate (Shopify's are `status===ACTIVE` and
  `inventoryQuantity>0`, but the resolver only knows "the declared clauses passed", not their field names);
- **the matched field EXACTLY equals the human phrase** — enforced for products too, not just customers
  (critique risk: "smart switch" auto-filling a single-variant "Smart Switch Wall Plate" is the confidently-wrong
  case; near-exact match is required before auto, matching the customer near-match rule).

**ELSE ASK** — surface the candidate list. Verdict set: `resolved | ambiguous(>1) | none(0) |
require-failed(<clause>) | unreachable(leg errored → STOP, per headlessMap.js:103's lookup-failed-≠-miss rule)`.
A `require-failed` verdict NAMES the failing clause (Shopify surfaces it as "inactive" / "out of stock"; the
copy comes from the clause, the mechanism is generic). Only `resolved` proceeds; **never silently pick.**
(A `require` clause may be marked `relaxable` for a value-policy exception — e.g. a zero-price warranty
replacement can proceed past `inventoryQuantity>0` — §4.)

**Multi-line + quantity:** the model does **one** interpret pass parsing "2 smart switches and 1 dimmer" →
`line_items_request:[{product:'smart switch',quantity:2},{product:'dimmer',quantity:1}]` — structured extraction
is the model's strength; resolving names→gids is not. The resolver then GATHERS: **N deterministic search
invokes, no per-item LLM** (the explicit `viaLeg`/`valueParam` make `_mapResolveTarget`'s INTERPRET_ASK
unnecessary per element — reuse its result-ranking, not its LLM round-trip). Quantity is **copied** from the
parsed pair, never inferred. If any element gates to ask, the **whole write pauses** — never partial-dispatch a
draft with one wrong variant.

---

## 4. Safety — fail-closed, and the belts stay params-blind

The write is safe-by-construction and this design **must not weaken that**: the executor belt
(connector.js:884-887) requires `confirmed|gateCleared`; `gateCleared` comes only from `stampWriteAuthority` on a
literal `'auto'` verdict (rideStep.js:60-67); `gateActionForLeg` reads **only** `leg.tool` axes, never params
(pipelineGate.js:94-105). **A resolved gid can never LOWER the gate.**

**Enforcement is the resolver returning needs/park BEFORE assembly, not a gate member** (critique correction:
both create-order gate sites — panel `_runWriteClause` chat.js:6016, headless `headlessWrite` — call
`gateActionForLeg`, which is single-leg and params-blind; `gateComposite` is not on this path). So an unclean
resolution (ambiguous/none/inactive/outOfStock/unreachable) **stops at the resolve seam** (chat.js:6833) and the
write is never assembled. This is a cleaner mechanism than raising a gate member, and it keeps `gateActionForLeg`
params-blind — the property the belts depend on.

- **Never-invent — stated honestly.** `inventedIdentifierParams` runs *pre-resolution* on model-bound params, so
  it catches a directly-fabricated `customer_gid` or `variantId`. It does **not** re-check the *resolved* gid
  (the model bound a phrase, not the gid). The confidently-wrong-but-REAL resolution is guarded by **the ranker
  (exact-match required) + the confirm card (panel) or recall-not-guess (headless)** — not by the fabrication
  gate. **Add a post-resolution sanity check** (the resolved gid must be a well-formed gid the search read
  actually returned, not a value the resolver synthesized) as the RC-2 belt.
- **Provenance-in-confirm.** Thread `{param, human, resolvedLabel, sku, price, stock, id, via, nearMatch}` into
  the confirm/park preview (headlessWrite.js:131 samples raw gids today): the human confirms "dmonk@ → Divine
  Monk" / "smart switch gen 2 → Smart Switch Gen 2 · DK-SW-02 · $49 · 12 in stock", the gid demoted to a
  parenthetical. The preview still shows the id that ships (the truth) — but **labeled**.
- **Money = human click.** Draft creation is reversible; completing it stays a human click (connectorRecipes.js:
  661). A 100%-discount/above-threshold draft PARKS even at gate-`auto` — see open-Q on where the threshold reads
  from (a warranty desk drafts 100%-off routinely, so it likely reads the desk/preset, not a catalog constant).
- **`none` is a HARD STOP, never an auto customer-create** (critique risk): a typo email must not chain
  `shopify_create_customer` (which is itself gate-`auto` + curated and would mint a customer unattended).
  none → ASK (panel) / park (headless), full stop.
- **Idempotency.** A draft has no natural find key, so client-mint a stable token from `(customer_gid + sorted
  line-items)` (scope: dedup a same-customer/same-items draft within a window regardless of runId — re-drafting
  the identical thing is not a legitimate double), stamp it as findable residue (tags/note — the trial-tag
  precedent), and pre-create-search for it; a prior hit = already-created. Without a resolvable idempotency path
  the unattended draft **parks**.

---

## 5. Learning — asked once (the headline, corrected)

A picked resolution banks as a per-instance `goalMemory` belief and the resolver **consults it before
invoking/prompting** — the concrete fix for re-ask-forever, and the only way the unattended path can disambiguate
without an operator.

**Recall-key correction (critique's single biggest fix):** `normalizeBelief` (goalMemory.js:45) keeps only
`{id, kind, epistemic, confidence, provenance, tier, body, ref}` — it **strips** top-level `entityType`/
`groundId`. So the recall key cannot live as sibling fields; it must be **encoded into `body`** as a canonical
string:

```
body: "lookup:<groundId>:ProductVariant:<normalizedHumanKey>"      ref: "<resolved variant gid>"
```

Recall then matches on `body` prefix — which survives `normalizeBelief`, `presetMemory` promotion, and every
read. (The alternative — widening the shared pure normalizer — is rejected: it touches every belief consumer.)
The belief graduates 0.7 → confirmed on 2nd reuse (the tier ratchet) and stays **instance-private**; the pin
channel is the wrong home (`sanitizeBindings` strips gids/emails by the body-blind rule).

**Multi-store prerequisite (critique risk, promoted to a build gate):** two Shopify stores both live on
`admin.shopify.com`, differing only by `{handle}`. Encoding `groundId` in the recall key is store-safe **only if
`groundId` separates the two stores** — which requires **AP-0 per-instance identity to land before RC-4 banks any
store-specific gid**. The ladder is reordered so RC-4 does not ship ahead of that.

---

## 6. Panel vs headless — recall-or-park is the whole unattended contract

**Panel (operator present):** live invoke-resolve at the shared seam (`_resolveRideParamsCore` chat.js:12787 is
the one resolver every dispatch path calls; the new `lookup` branches in here — and the **act-door gate at
chat.js:14213 needs its own `if (leg.tool.lookup)` branch** beside the `resolve` branch, or a lookup-only leg
skips resolution entirely — critique correction). ambiguous/none → the candidate PICKER; the human picks; the
pick banks; the draft is reviewed and completed by hand.

**Headless (scheduled, no operator):** never live-resolves. The **resolved-envelope carrier** (the load-bearing
fix both critics named) is how a recalled gid reaches the write without the strip eating it:

> A recalled/confirmed pick is written into the pin bindings not as a bare value but as a **code-minted envelope**
> `{ __resolved: true, param: 'customer_gid', value: '<gid>', from: '<belief id>' }`. The `literalSafeParams`
> strip (rideStep.js:220-223) is extended to: **drop an unresolved lookup key, but PASS a `__resolved` envelope**
> (checking the shape, not a gid-looking value — a fabricated gid cannot mint `__resolved` because only the
> recall path, reading a *confirmed* belief, produces it; a model binding or a pin binding never can).
> `fillBody`/`coerceParams` unwrap `__resolved` to `value` at assembly. This makes the strip's decision
> **provenance-based, not value-shape-based** — closing the "either always-parks or fabricated-gid-rides" fork.

So the headless proceed-case is: **recall a confirmed pick → envelope survives the strip → re-run the status/
stock gate on the recalled gid** (a stale belief whose variant is now archived/out-of-stock must re-park — the
recall path does NOT skip the gate) → idempotency token resolves → curated provenance → write. **Anything else
parks.** With no operator it can never auto-pick; recall-or-park *is* the contract, mirroring `replayPlan`'s
stop-rather-than-reinterpret posture.

**Open reachability question (do not skip at RC-6):** verify `shopify_create_order` can be a scheduled
`runWriteStep` target at all — that chassis is the per-item map/upsert path (misses → resolveWriteValue →
create); a single draft from a phrase is not a list→map shape. RC-6 must either establish the write can enter
that path or define the headless draft as the map-sourced warranty shape explicitly.

---

## 7. Build ladder (smallest-safe-first, each slice landable + testable)

- **RC-0 (pure, no behavior).** Land the `lookup` grammar + invariant-#3 hops 1+3 + hop-seal test. Write pure
  `rankLookupCandidates(rows, spec, humanKey) → verdict` (six outcomes), unit-tested over `_GQL_PRODUCTS`/
  `_GQL_CUSTOMERS` fixtures. Register the `missingRequiredParams` exemption for lookup destinations **at the
  resolve seam, not the shared reader** (critique: a shared-reader exemption kills the honest "no call spent"
  clarify for everyone). Extend the `literalSafeParams` strip to the envelope rule + test. Nothing wired live.
- **RC-1 (panel, customer scalar).** Wire `lookup.customer_gid` (exact email); the resolve-seam needs/park
  enforcement; the act-door `lookup` branch. Confirm the resolution in the card; money stays human-click. Golden
  ask "create a draft order for dmonk@deako.com" with `expectParams {customer_gid: a Customer gid}`. line_items
  still raw. Independently landable.
- **RC-2 (panel, product→variant — the NEW invoke-and-rank kind).** by-SKU-then-search, nested variant pick, the
  **declared `require`-list gate** (§2 — lift the Shopify vocabulary out of the resolver here, as the ACTIVE/
  in-stock clauses; this is the slice that proves the axis is system-neutral) + exact-match, the
  **post-resolution gid sanity belt**, the candidate PICKER card. Golden asks: exact SKU→auto; two-variant
  name→ambiguous (card, `mustNotWrite` until picked); DRAFT product→refuse (a `require-failed` negative). First
  **live single-line draft**.
- **RC-3 (panel, multi-line + quantity).** interpret-once parse → `line_items_request`; the GATHER fan
  (N invokes → one array); any-element-ambiguous pauses the whole write. Golden ask "2 smart switches and 1
  dimmer for dmonk@…" `expectParams {line_items: 2 elements, qty 2 and 1}`. **The SH-T5 live proof vehicle.**
- **AP-0 (prerequisite gate).** Per-instance identity must land before RC-4 banks store-specific gids.
- **RC-4 (learning).** Bank the pick as an instance belief with the `body`-encoded recall key; consult-before-
  prompt. Test: two identical asks → the second skips the picker.
- **RC-5 (idempotency + dry-run + value policy).** Client-mint the token, stamp residue, pre-create dedup; the
  100%/threshold park policy (reading desk/preset).
- **RC-6 (unattended pipeline).** Headless recall-or-park in `runWriteStep`: envelope recall → re-run status/stock
  gate → idempotency required → else park. **First establish the write can be a scheduled target (§6).** Unit +
  live cadence eyeball.
- **RC-7 (policy rise).** The disambiguation *habit* ("prefer the ACTIVE in-stock variant for a nickname") rises
  as a preset delta; the resolved gid stays instance-private.

---

## 8. Definition of done — proven, not asserted

1. **Live SH-T5:** one real `DraftOrderCreate` round-trips against a live store from a NATURAL ask, resolved
   customer AND variant(s), resolution shown in the confirm card, completed as a human click. Nothing headless
   substitutes (the persisted-op variables envelope and input spellings are server-only-validated; live
   inventory/status accuracy is server-only too). This is the proof the leg has owed since v1388.
2. **Golden asks with `expectParams`** frozen per slice (customer resolves; exact-SKU→auto; two-variant name→
   ambiguous `mustNotWrite`; multi-line quantities; DRAFT-product→refuse). Coverage meta-test holds.
3. **Scoreboard + decision-gate** show no regression on frozen decisions; the pure ranker's six verdicts, the
   resolve-seam veto, the hop-seal, the pre-flight-gate registrations, and the strip envelope rule are all
   unit-covered.
4. **Honesty line:** syntax + `npm test` + the pure units are provable headless and stated as such; the live
   `DraftOrderCreate`, the picker feel, the cadence recall-or-park, and cross-reload pick survival need a live
   eyeball — reported as owed, never implied from a green suite.

---

## 9. Portability — general capability, Shopify is the first user

The **mechanism is system-neutral by design** (this was the point of building a resolve *capability* rather than
patching draft-order). What is genuinely portable — declared per-spec, no Shopify assumptions:
- the `lookup` marker on any write leg, keyed by any destination param (a leg referencing three entities has
  three lookup destinations — it is a map, not a fixed pair);
- `viaLeg` / `valueParam` (invoke any search leg; `viaLeg` an array = try-in-order);
- `rows` / `pick` / `id` / `label` — **dotted paths through `getPath`**, so a Relay `edges[].node`, a REST
  `results[]`, a `data[]` are all just a different string. No response shape is baked in;
- the cardinality gate, the exact-match rule, the candidate picker, `each`/`quantityFrom`/`into` element
  construction, the learning/recall, the resolve-seam enforcement, the invariant-#3 hops.

**The two Shopify-shaped pieces, and how they stay contained:**
1. **Candidate-quality vocabulary** (`status===ACTIVE`, `inventoryQuantity>0`) — lifted to the declared `require`
   list (§2). The specific field names live ONLY in the catalog entry; the resolver reads "the declared clauses
   passed", never a field name. A non-Shopify leg declares its own clauses, or none.
2. **Id coercion** (`toShopifyGid`, the `gid://shopify/Kind/id` envelope) — **opt-in per param**: a lookup that
   declares no `gid`/`elementGid` gets no coercion, so systems with numeric/string ids are portable by omission.
   Only a system needing a *different* id-envelope adds its own coercion — a small declared addition, not a
   rewrite. This is the one place a second system might touch code rather than only catalog data.

**Where it would be used elsewhere in this repo, concretely:** Zendesk ("assign ticket to Sarah" = agent
name→id; "add the VIP tag"), the broker/MCP legs (Slack channel/user by name, HubSpot contact by email/name),
and any write that names another entity by human identifier. Even VendorSuite, if a division list were
search-backed rather than the dumpable `/State` GET corpus the existing `resolve` kind reads. The
"phrase → search → confirm/recall → resolved id → write" pattern is what a router-over-tools system needs
everywhere; draft-order is merely where it lands first, and the RC-2 slice is the moment to confirm the `require`
axis and the opt-in coercion are lifted cleanly BEFORE a second leg adopts it.

---

## 10. The resolver family — reference, the missing half, consolidations

`lookup` is the fourth *named* member of a family the codebase already runs but never wrote down. This section is
the family's first written contract (census + gap/redundancy analysis, 2026-08-07 deep-research pass, all
file:line verified). It exists because a reader shouldn't have to trust §1's one-liners about `resolve`/
`writeMap`/`joinKey` — they now have specs.

### 10.1 Shape — two halves plus a seal

The family is **one pipeline in two halves**, wrapped by a **provenance seal**:
- **MATCH** — turn a human phrase *or* an in-hand row into a resolved value / id / path.
- **CONSTRUCT** — turn resolved parts into a concrete wire request.
- **SEAL** — `recipeParamSchema` (the single hop-3 seal, connectorLeg.js:110, feeding every coercion/identity
  consumer) + the two never-invent gates, enforced **asymmetrically and never together**: the PANEL door runs
  `inventedIdentifierParams` (judge a bound value against the conversation corpus); the SW door runs the
  `literalSafeParams` strip + required-gate (delete resolve-marked / `each` keys). *A regression removing one is
  invisible to any test that exercises only the other* — a standing hazard worth a paired fixture.

### 10.2 The four axes (how to place any member)

1. **INPUT-KIND** — human-phrase (MATCH's usual front door) vs in-hand-row (CONSTRUCT always starts from a row).
2. **SOURCE** (the sharpest discriminator, and *why* `lookup` is a new member): `GET-corpus` (dump + exact-match,
   corpus-is-complete → a definite negative) · `parameterized-search` (invoke a query leg, relevance not exact,
   near-matches) · `rows-in-hand shape` (candidate-path scan) · `shape-regex registry` (`identifierShapes.SHAPES`)
   · `template` (substitute args into a declared string/body) · `conversation-corpus` (ask+turns+focus, by
   containment) · `catalog-declaration` (rung/writeMap/paramSchema).
3. **CARDINALITY** — `1→1` · `1→N` fan-out · `N→1` gather · `N→N` with drops. (The `resolve.each` fan-out vs
   `lookup.each` gather **inversion** is a real, preserved distinction — §10.4 consolidation 3.)
4. **WHERE-IT-RUNS** — both · panel-only (needs the LLM/`INTERPRET_ASK`) · SW-executor-only (last hop) ·
   headless-only (the strip — the SW has no resolver, so it strips the unresolvable instead of judging it).

### 10.3 The members (finally, one contract each)

| Member | half · source · card. · runs | one-line contract | sites |
|---|---|---|---|
| **`resolve` / resolveRideParam** | MATCH · GET-corpus · 1→1 (each: 1→N) · both | market word/blank/`each` → canonical id, exact-match over the app's own option corpus; verdict `value\|defaulted\|ambiguous\|unknown\|null`, never silently picks | rideParamResolve.js:73; hop-sealed (rideRecipe.js:105, connectorLeg.js:377) |
| **`lookup`** (proposed) | MATCH · search · 1→1 / N→1 gather · panel live, headless recall | invoke a search leg, rank rows under `require`, extract the (nested) gid, assemble into the write's param | §2; hops 1+3 to add |
| **resolveJoinField** | MATCH · rows-in-hand · N+phrase→1 · panel | which row field keys a cross-system lookup: named-phrase wins, else declared `joinKey`, else ask | peritemMap.js:239 |
| **pickFieldPath** | MATCH · rows-in-hand shape · N+phrase→1 · panel | human field phrase → dotted path; name-match then value-shape; ties/orphans surfaced, never guessed | peritemMap.js:127 |
| **targetKeyRung** | MATCH · shape-regex · N→1 · panel | find the rung the *target* system owns by VALUE shape (a `1Z…` for UPS), prepend it so a third-system hop keys right | peritemMap.js:481 |
| **probeValue** | MATCH · template · 1→1 · panel | build a router probe that keeps the target's id SHAPE so `INTERPRET_ASK` routes the per-item ask correctly | peritemMap.js:513 |
| **map-step matcher** | MATCH · search · N→1 join · both | per-row: run the target search, ladder the join key, tally matched/no-match/failed (the live warranty→Shopify resolver) | peritemMap.js / headlessMap.runMapStep |
| **`writeMap` / resolveWriteValue** | CONSTRUCT · catalog-decl · 1 row→N params · both | source a create's param bag from a matched row (rungs: `{contact,type}` / `{cityStateZip,part}` / `{literal}` / field-path / name-match) | writeMap.js:114 |
| **ladderValues / normalizeRungs** | CONSTRUCT · catalog-decl · N rungs→≤N attempts · both | the **shared rung engine** `joinKey` and `writeMap` both call (declared once) | peritemMap.js:307/289 |
| **drill** | CONSTRUCT · rows-in-hand · N rows→N reads · both | a list row joins a detail READ leg by its own matched field (idempotent → ask-back, not confirm) | connectorLeg.js drill reader |
| **fillBody / fillEndpoint** | CONSTRUCT · template · 1→1 · SW-executor | substitute the coerced arg bag into `{param}` slots (transport-general; no row model) | connectorRecipes.js:71 |
| **coerceParams / toShopifyGid / elementGid** | CONSTRUCT · catalog-decl · N→N drops · both | type/gid SHAPE coercion + nested-member gid wrap + JSON-text parse + placeholder scrub (`toShopifyGid` is a helper *inside* coerceParams — one contract, not two) | connectorRecipes.js:1163/217 |
| **inventedIdentifierParams** | SEAL · conversation-corpus · panel | refuse a model-bound identifier that doesn't trace to context (never-invent) | connectorLeg.js:249 |
| **literalSafeParams strip + required-gate** | SEAL · headless | drop resolve-marked/`each` keys the SW can't resolve; then `needs-<param>` | rideStep.js:220 |

### 10.4 Consolidations — all "share the grammar, keep the engines", none collapses a distinction

The critique confirmed **no proposed merge is unsound**; each is a share-grammar / keep-separate / already-merged
call that preserves a load-bearing property:

1. **`resolve` + `lookup` → unify the grammar, NOT the code.** Share the marker vocabulary (`via`/`rows`/`match`/
   `id`/`label`) and the six-outcome verdict + never-silently-pick discipline (`lookup` already reuses
   `resolveRideParam`'s verdict shape + `getPath` verbatim). **Keep the engines separate:** `resolveRideParam` is
   PURE, derives rows internally from `spec.lists`, and exact-matches over a *complete* corpus (the
   definite-negative epistemic); `lookup` must invoke a live search, relevance-rank near-matches, and require-gate.
   *Merging would force one impure or make search rows masquerade behind the wrong exact/flat matcher.* This is
   what makes "the fourth resolver" literally true rather than asserted.
2. **`drill` + `lookup` → share only the match-then-`getPath`-extract primitive.** `drill` matches rows in hand,
   keys a READ by the matched row's field, loose-matches, asks back; `lookup` keys a SEARCH by the raw phrase,
   exact-matches after, feeds a WRITE (confirm card). *The gate lives on the OUTPUT side* — merging would over-gate
   reads or under-gate writes.
3. **`resolve.each` + `lookup.each` → keep separate (inverse cardinalities).** `resolve.each` is a boolean flag →
   fan ONE sentinel out to N leg runs; `lookup.each` is a param name → gather N descriptors into ONE array for ONE
   write. A merged handler just re-introduces the mode flag, with a live risk of fanning a WRITE.
4. **`writeMap` rungs + `joinKey`/`ladderValues` rungs → already optimally merged.** They ARE one code path
   (`writeMap` imports `ladderValues`/`normalizeRungs`, delegates `{contact,type}`/field rungs straight down).
   `writeMap` *supersets* with write-only kinds (`{literal}`, `{cityStateZip,part}`) resolved BEFORE it delegates
   — pushing those into the shared resolver would treat a fill constant as a cross-system lookup. Leave the base
   merged, keep the write-only kinds above it.
5. **`fillBody` + `writeMap` → keep separate (different layers).** `writeMap` answers "what value, from where";
   `fillBody` answers "where in the request it goes" and serves every write leg transport-generally. Merging
   conflates resolution with serialization.

### 10.5 The family's missing half — VALIDATE (the highest-leverage next build)

The family has MATCH and CONSTRUCT, and a *narrow* validate seam (`missingRequiredParams` = presence,
`inventedIdentifierParams` = provenance). What it **lacks is DOMAIN / value-membership validation** — nothing
checks a bound value against its declared domain (enum / date / format) before the wire; `coerceParams` validates
SHAPE (int/bool/gid) only. The top absent types all live in that gap:

1. **ENUM word → member + post-bind membership check** *(highest — live incident, zero validation today; scope to
   STRING enums)*. A non-blank out-of-enum value rides to the wire and 4xx's: `status:'active'` against VS's
   `[new\|open\|fixed\|closed]` (connectorRecipes.js:769), or an availability preference the model fails to map
   (connectorRecipes.js:932). `coerceParams` never reads `slot.enum` though the enum reaches the schema
   (connectorLeg.js:118). **Build:** a pure `resolveEnumValue(word, enumList, {synonyms})` reusing
   `resolveRideParam`'s verdict + a `coerceParams` branch that **refuses-to-ask** on a not-in-enum value instead
   of spending the call (findings: the model bailed on the opaque enum, then a false "success" polluted memory).
   *Critique correction:* this is **not** aimed at `add_comment public:true` — that is a boolean enum a membership
   belt can't help; its "public reply vs internal note" risk needs word→visibility *resolution* + a louder
   confirm, and it's already `required:true` + confirm-guarded.
2. **RELATIVE-DATE → ISO / site filter token** *(silent-wrong, ships in the corpus)*. The `NOW`-resolution rule
   exists (interpretPrompt.js:198) but is gated on a date-time *type*; the Shopify date rides inside a free-text
   `query` string (connectorRecipes.js:541), so the rule never fires — an unrecognized filter field is dropped
   server-side and 50 UNFILTERED rows come back presented as filtered (the code's own "fabrication engine"
   warning). **Build:** a `dateFilter` param marker + a pure `resolveDatePhrase`, and refuse rather than return
   unfiltered when a declared date filter doesn't parse.
3. **PLACE-NAME → geo code + freeform-address split** *(silent address drop, non-US)*. `parseCityStateZip`
   hard-requires a 2-letter state (writeMap.js:70), so "Georgia" → `{}` → the whole address (incl. the resolved
   street) drops silently; country is a literal `'US'`. Bites any user-typed / non-VendorSuite source.
4. **COMBINED name → first/last split** *(lower — self-reports unproposable, never ships wrong)* — a `{contact,
   type:'firstOfName'}` rung extension reusing the rung vocabulary.
5. **QUANTITY word → integer** *(lowest — design-acknowledged punt, leg unbuilt)*.

**Recommendation:** the single most valuable family move is to **build the VALIDATE half — a post-bind
domain-validation belt at the `coerceParams` choke point, enum-first (STRING enums)** — reusing
`resolveRideParam`'s verdict contract. It is un-owned, spans the top three absents (enum/date/geo all bind a value
none checks), has a live incident, and is the cheapest fix (the enum already rides `paramSchema.slot.enum`). It
lands the seam date and geo then plug into, while the `lookup` RC-0..7 ladder proceeds as the already-owned track
(RC-0 also lands consolidation 1's verdict-vocabulary unification as code).

---

## 11. Open questions (carried, not resolved)

- **Belt staleness.** A banked "smart switch gen 2 → variant/456" goes wrong if the variant is re-SKU'd/archived.
  RC-6's recall re-runs the status/stock gate, which catches archived/out-of-stock — but a *re-SKU'd-but-still-
  active* variant that no longer matches the phrase is not caught. TTL vs re-verify-on-recall, and its cost to
  the touchpoint-minimization win, is open.
- **by-SKU-then-search try-order** shadowing (a phrase that is both a SKU and a title word) — confirm against a
  live disagreement corpus.
- **Value/discount park threshold** — catalog-fixed vs desk/preset-configurable (a warranty desk drafts 100%-off
  routinely; a blanket rule parks its whole workload).

---

*Provenance: `logs/run/` findings around v2.74.2054-2055 (the draft-order leg review + door fixes) and the
2026-08-07 deep-research passes. The lookup-design critiques' corrections are folded into §4 (gate wiring), §5
(recall key + multi-store gate), §6 (the resolved-envelope carrier + recall re-gate + reachability), and §2
(line_items_request as a real param, raw line_items removed). The portability pass (§9 + the declared `require`
axis in §2/§3) lifts the Shopify candidate-quality vocabulary out of the resolver. §10 (the resolver family —
taxonomy, member contracts, consolidations, the VALIDATE gap) is the resolver-family census + gap/redundancy
research, with its critique's corrections applied (the enum belt scoped to STRING enums, not `add_comment`'s
boolean; "no VALIDATE half" narrowed to "no DOMAIN validation").*
