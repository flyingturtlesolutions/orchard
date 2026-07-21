# DESIGN — the PER-ITEM PIPELINE (BRANCH · UPSERT · the reach)

**Status:** spec, nothing built. Written 2026-07-21 after PM-9 (per-item field read) proved out live.
**Scope rule, stated by the user and load-bearing:** *"Do not design to support this specific workflow — build the
structures that will support any workflow with this abstract shape."* Every example below is an INSTANCE. If a
decision here only makes sense for warranty tasks, it is wrong.

---

## §0 The shape

```
list read
  → per-item FIELD READ           (a field on the item's own record)
  → per-item BRANCH               (classify from the item's data → choose an arm)
  → per-item LOOKUP               (find the item in another system)
  → per-item UPSERT               (found → act · missing → create, then act)
  → materialize each item as a reviewable CASE
  → GATE by declared risk class
```

Read that as a pipeline over ONE item, applied to N items. Every stage is per-item; the list read is the only
collective step. That framing matters: it is why `map` (PM-2) and `fieldRead` (PM-9) are peers rather than one
being a special case of the other, and it is why BRANCH must not be modelled as a whole-list filter.

### §0.1 One instance, for grounding only

Warranty tasks → read `Instructions` → if it describes sending replacements, look the homeowner up in Shopify and
draft an order (creating the customer first when absent); if it describes reaching out, look them up in Zendesk and
draft an email (same create-if-absent) → each item becomes a case → a human approves the outward/irreversible steps.

**Do not encode any of that.** No warranty vocabulary, no Shopify/Zendesk special-casing, no "replacement" keyword
in code. All of it is catalog + declaration.

---

## §1 What already exists (verified against source this session)

| stage | state | where |
|---|---|---|
| list read | **proven live** — 121 divisions → 22 rows | `RIDE_EACH` |
| per-item field read | **proven live** — 22/22, term extraction | `Core/fieldRead.js`, `_runFieldReadClause` |
| cross-system lookup | **proven live** — 7-rung ladder, 21/22 | `Core/peritemMap.js`, `_runMapClause` |
| **branch** | control flow EXISTS, unreached from the clause path | `detect` node — `Services/Engine/nodeRegistry.js`, executor `Services/ExecutionEngine.js` `#executeDetectNode` |
| **branch predicate** | EXISTS — data predicates over `scope` | scope-family assertions, `Services/Assertion.js` |
| **upsert** | shape EXISTS (`body` + `recover`), unreached | `try` node |
| case per item | **proven live** | dossier fan-out (`RIDE_DRILL ▸ dossier … (fan-out spawn)`) |
| approval queue | **exists, proven** | `Core/proposals.js`, `Services/Storage/ProposalStore.js`, `_approveMany` (staleness CAS + ledger) |
| write core | built + tested, runtime deliberately unwired | `Core/writeMap.js` |

**Nothing in the shape needs inventing.** This is the single most important finding of the session, and it was
reached by reading contracts rather than designing — five separate times a planned build collapsed into wiring
(`coerceParams` already dropped placeholders; the fleet queue already WAS batch approval; `detect` already
branches; `field_contains` already exists; the assertion vocabulary is already single-sourced).

### §1.1 The branch predicate, concretely

`detect` evaluates `branch.condition` via `TemplateWalker.checkConditions({tabId, conditions, scope, timeoutMs: 0})`
— a one-shot probe, first match wins, with a `default` arm when none match. Conditions carry a
`family` tag (`'page' | 'scope' | 'reference'`); **page**-family route to the content script, **scope**-family
evaluate engine-side against `scope` — i.e. against RECORDS, not the DOM.

Available data predicates:

```
field_contains · field_equals · field_starts_with · field_ends_with · field_present
field_gt · field_gte · field_lt · field_lte
all_of · any_of                       (composition)
```

So *"this item's Instructions mentions a replacement"* is expressible **today** as declared data:

```
any_of[ field_contains(Instructions,"replacement"),
        field_contains(Instructions,"replace"),
        field_contains(Instructions,"send ") ]
```

Deterministic, no model call, no egress, and it composes.

### §1.2 The BRANCH clause contract *(missing from v1 — the largest gap)*

`map` and `fieldRead` each have an explicit verdict shape and a normalizer. BRANCH had a described MECHANISM and
no contract — precisely the omission that produced three of this session's worst bugs (§7.1): an unspecified slot
does not stay empty, it gets filled with an invention.

```js
normalizeBranchVerdict(v) → {
  kind: 'branch',
  collection: 'prior' | { readAsk },                                  // same contract as map/fieldRead
  arms: [ { when: <Assertion>, label: <string>, then: <clause[]> } ], // REQUIRED, >= 1
  otherwise: <clause[]> | null,     // OPTIONAL — absent means "no arm matched, and that is reported"
  mode: 'first' | 'all',            // §3.1; DEFAULT 'first'
} | null                            // null when arms is absent/empty → the caller degrades honestly
```

Rules, each earned by a specific failure:
- **`arms` is the only required slot.** A required `otherwise` would force the model to invent one (§7.1).
- **`when` is an Assertion, never prose** — the SAME scope-family vocabulary §1.1 enumerates. Not a new
  mini-language, not a natural-language string re-interpreted downstream. One vocabulary (§7.3).
- **An unmatched item is a REPORTED outcome, not a silent skip.** With no `otherwise`, the case records
  `branch: none` and the tally counts it.
- **`could-not-evaluate` is DISTINCT from `no-arm`.** A predicate that throws, or reads a field that is absent,
  is UNKNOWN — not FALSE. Conflating them routes items to `otherwise` on a transport blip: the v1637 bug
  (unreachable read as miss) in a new costume. Three outcomes: matched-arm · no-arm · unknown (§7.5).

### §1.3 Who authors the predicate *(unstated in v1 — the central design axis)*

`field_contains(Instructions, "replacement")` is declared data. **By whom** decides what this system is:

| source | when it is right | precedent |
|---|---|---|
| **catalog** (recipe-declared per record type) | the branch is a property of the DOMAIN, stable across users | `joinKey`, `drill`, `writeMap` (v1633/1634) |
| **workflow** (saved with the chain, editable) | the branch is THIS user's rule | the WF-1 workflow record |
| **model** (extracted from the ask) | one-off and conversational | the `map`/`fieldRead` verdicts |

**Decision: catalog and workflow are authoritative; the model may only PROPOSE.** A model-extracted predicate is
shown and banked before it becomes durable — the trial-then-bank gate the rest of the system already uses. This is
declaration-over-heuristic (v1617, v1633, v1634, v1636), and it is what stops a rephrasing from silently changing
which items get acted on. A workflow whose predicate came from a model and was never banked must **re-propose,
not re-guess**.

---

## §2 The actual work: THE REACH

`detect` and `try` run inside a **strategy**, walked by `ExecutionEngine` over strategy nodes. The per-item field
read and map run in **chat.js's clause path**. Two execution contexts. Joining them is the whole job.

Two candidate designs. **This spec does not choose — the choice needs one careful read of
`StrategyTree.normalizeNode` and `ExecutionEngine.#NODE_EXEC` that has not been done.**

**A — LOWER the pipeline into strategy nodes.** The clause path compiles a per-item pipeline into a strategy body
(`foreach` over rows, containing `detect`/`try`/fragment nodes) and hands it to the engine.
*For:* one execution model; `detect`/`try`/`foreach` and the pause/resume, abort, and progress-emit machinery come
free; authoring in Studio comes free. *Against:* the clause path's steps (connector legs, drills) must be
expressible as nodes; a lowering layer is real work; the strategy engine is DOM/tab-oriented and per-item reads are
transport calls.

**B — CALL the assertion evaluator from the clause path.** Keep per-item execution in chat.js; import the
scope-family evaluator to decide branches.
*For:* small; no lowering; reuses the predicate vocabulary immediately. *Against:* a SECOND place that interprets
branch semantics — exactly the "one vocabulary, two implementations" shape that produced this session's two-door
bug and the `SieveExecutor`-vs-`Assertion` duplication noted below. Would need the evaluator to be genuinely
shared, not copied.

**Open question that decides it:** is `#executeDetectNode` usable with a `scope` that is a plain record and no
meaningful `tabId`? If yes, B is nearly free and A is optional. If `detect` presumes a live tab, A is the honest
path.

**Second open question:** `SieveExecutor.#evalSieveAssertion` implements `field_contains` etc. directly. Does it
delegate to `Services/Assertion.js` or duplicate it? If duplicated, **fix that first** — a third consumer of a
vocabulary with two implementations will diverge, and this codebase has been bitten by that twice in one day.

---

## §3 UPSERT

Find-or-create-then-act, branches converging. Shape already present as `try` (`body` + `recover`).

```
UPSERT(find, create, act):
  r = find(item)
  if r is HIT        → act(item, r)
  if r is MISS       → c = create(item); act(item, c)
  if r is UNREACHABLE→ stop; report; DO NOT create
```

**The third outcome is mandatory.** Twice this session a two-outcome design produced a confident wrong answer:
the map ladder treated an unreachable rung as a miss and descended to a weaker key (v1637), and a truthy-but-
pathless resolver result rendered a field named "undefined" (v1653). For UPSERT the failure is worse than either —
*miss* creates a record, *unreachable* must not, and conflating them means duplicate records on every transport
blip. `try`'s `recover` arm reached on ANY failure would be exactly this bug; **confirm what triggers `recover`
before using it.**

### §3.1 Multi-arm items *(unresolved in v1)*

`detect` is FIRST-MATCH-WINS. An item can satisfy two arms — an instruction describing both a replacement and a
customer contact — and first-match silently drops the second: a wrong answer that looks right.

`mode` (§1.2) makes the choice explicit rather than accidental:
- **`'first'`** (default) — first matching arm only. Correct when arms are mutually exclusive states.
- **`'all'`** — every matching arm runs, in declared order. Correct when arms are independent obligations.

**Default is `'first'` because it is the safer wrong answer:** doing less than asked shows up in the tally; an
unrequested extra write does not. When `mode:'first'` and more than one arm matched, the case MUST record the
skipped arms — the silent drop is the failure this section exists to prevent.

`mode:'all'` carries a second-order hazard: two arms that both UPSERT the same entity can create it twice. Arms
sharing an upsert target resolve it ONCE per item, before the arms run.

**Idempotency:** the proposal queue's staleness CAS (`_approveProposal`) re-checks immediately before executing.
For a CREATE, absence is the normal case and presence is the stale case — the inverse of the UPDATE case it was
built for, so `basedOn.path` must be verified against a real response or it fails OPEN (recorded at v1639). An
UPSERT that runs unattended needs the same re-check inline.

---

## §4 The GATE

Current classifier (`hintToSafety`, `Core/connectorLeg.js`) grades on two inputs — `readOnlyHint`,
`destructiveHint` — yielding `auto | confirm | gated | destructive`. It **cannot express** the policy the user
actually wants, which is not about warranties:

> Approval only where the effect is **outward-facing** (leaves the system) or **irreversible** (cannot be undone).
> Creating an internal record, or a draft, is neither — so it is un-gated.

**Add two declared axes to the leg/artifact declaration, and derive the gate from them:**

```
reversible : true | false      — can this be undone by us, without a third party?
outward    : true | false      — does this leave our boundary (email sent, order confirmed, message posted)?

gate = outward || !reversible
```

Under that rule the user's policy falls out with no special-casing: create-customer (`reversible:true,
outward:false`) → free; draft order (`reversible:true, outward:false`) → free; **confirm order**
(`reversible:false, outward:true`) → gated; **send email** (`outward:true`) → gated. Money and inventory remain
human-click-only on top, as today.

**DEFAULTS FAIL CLOSED.** A leg declaring NEITHER axis is treated as `outward:true, reversible:false` → **gated**.
This is the one default here that must not be permissive: an undeclared write is an unreviewed write, and the
failure is *silent* — the action simply happens. Every other unknown in this design surfaces as a visible gap;
this one does not. Declaring the axes is therefore part of adding a write leg, not an enhancement — add it to the
invariant-#3 hop checklist so a new leg cannot ship un-classified.

**Composite safety derives from members, never independently declared** — the `driveArtifacts` lesson ("tier-2
params derive as the UNION of the composed tier-1 entries' params — catalog-derived, no drift"). An UPSERT
containing a gated create is gated.

---

## §5 LLM egress

The user resolved this: item TEXT may go to the model; **addresses must be redacted when present**.

Note what is already true: the map threads row values into a search **parameter**, never a prompt, so the join key
(the address, since v1633) has never reached the model. **The branch as specced needs no model at all** —
`field_contains` is deterministic. Egress only arises if §6's optional classifier is built.

If it is: batch one call for N items (not per-item — the cost property), strip addresses before sending, and keep
the result to a label the branch consumes. See `docs/DESIGN_llm_privacy.md` (R-1..R-4 redactor).

---

## §5.5 Observability — what the pipeline MUST log

This session's clearest lesson: the traces recorded DECISIONS and not DISPOSITIONS, so "never ran" and "ran and
found nothing" were indistinguishable — 12 of 17 passes were that ambiguity, and one version (v1660) removed it.
**The pipeline logs dispositions from day one, not after the first bad week.**

Per run: `PIPELINE ▸ start items=N stages=<list> cap=<n>`. Per stage per item, the VERDICT and not just the
attempt:

```
BRANCH ▸ item=<label> → arm=<label> | none | unknown(<why>)   [skipped: <arms>]
UPSERT ▸ item=<label> → hit | created | unreachable(<why>)
GATE   ▸ item=<label> <action> → auto | queued(<reason>)
```

Close with a tally naming every outcome class, including the zeroes. Non-negotiable, each from a real failure: an
outcome no branch claimed is logged LOUDLY (§7.3); a throw in any stage reaches the trace, not only the UI
(v1660 `CLAUSE_ERROR`); a cap that truncated says so; and every new marker enters `_DECISION_RE` when it is added
— invariant #1, skipped for `FIELD_READ ▸` and invisible to `gc` for eleven versions as a result.

## §5.6 Execution policy — isolation, caps, ordering

- **One item's failure never aborts the run.** Per-item try; the case records the failure; the pipeline continues.
  A run dying at item 7 of 22 has done partial work with no record of where it stopped.
- **Caps are declared and REPORTED.** The existing caps disagree (`_MAP_WINDOW` 24, `WRITE_BATCH_CAP` 25, the
  dossier fan-out 20). The pipeline declares ONE, and a truncated run states it. Silent truncation reads as
  "covered everything".
- **Stages run in declaration order per item; items are independent** — no cross-item state. That is what makes
  partial failure recoverable and the cap meaningful.
- **Abort is checked between stages and between items** (the existing `_walkAbortFlag` contract).

## §5.7 What a CASE contains, and what a re-run does

The case is the human-facing artifact and the thing the gate reviews, so its shape is contract, not rendering:

```
case: { item:    <label + source record ref>,
        branch:  { arm | none | unknown, why, skippedArms },
        stages:  [ { name, verdict, detail, error? } ],
        actions: [ { what, state: done | queued-for-approval | refused, ref } ] }
```

A failed stage appears with its error; a stage that never ran appears as not-run. **A case missing a stage and a
case with a failed stage must not look identical** — that distinction is the artifact's whole value to a reviewer.

**Re-run:** the pipeline is re-runnable and NOT idempotent by default. Re-running over the same list creates new
cases *unless* an item already has an open case for that pipeline, in which case it is skipped and counted as
`already-open`. UPSERT's inline re-check protects the external system; this rule protects the review queue. Both
are needed.

---

## §6 Build ladder

- **PP-0** — answer §2's two open questions (`detect` without a tab? `SieveExecutor` delegate or duplicate?). One
  careful read. **Nothing else starts until this is answered.**
- **PP-1** — reach: BRANCH from the per-item pipeline, whichever of A/B §2 selects. Pure core + tests first.
- **PP-2** — UPSERT with the three-outcome contract and the inline re-check.
- **PP-3** — the `reversible`/`outward` axes + `gate = outward || !reversible`; thread per invariant #3 (three
  catalog→leg hops) and refresh through `mergeRecipes`.
- **PP-4** — declare the gate on existing write legs; verify the user's policy falls out unchanged.
- **PP-5** *(only if measured)* — model classification as a fallback for unmatched items. **Threshold, stated so
  it can actually fire:** build PP-1, run it over a real list twice, and if **>20% land unmatched AND spot-checking
  shows they SHOULD have matched an arm**, the deterministic predicates are insufficient and PP-5 is justified. If
  they are genuinely unmatched, it is not — the honest `none` is the right answer, and a model would manufacture
  matches. (v1655's `11 found / 11 whole-field` is what a *healthy* unmatched population looks like: half the
  records simply had no such part.)

---

## §7 Failure modes this spec exists to prevent

Each cost real time this session; each has a one-line preventive.

1. **A required slot the caller cannot always fill generates confident garbage.** `itemField` (v1636), the
   bulk-write shape (v1638), `target.system` (v1643-48) — three times. *Any optional concept must be OPTIONAL with
   an explicit absent-branch.* BRANCH's `default` arm is this, structurally.
2. **Guarding a route instead of a value.** The placeholder guard went in at one call site, missed the other, and
   the real fix was one pattern at the binding choke point (v1656→v1657). *Guard where the value is ADMITTED.*
3. **Wiring a new clause into one of N dispatchers.** `fieldread` reached one of two doors; classified at 0.95 and
   silently dropped at the other for three passes (v1658). *Grep every `d.intent === '<peer>'` site before adding
   a sibling; better, assert at startup that every registry entry has a dispatcher — `ExecutionEngine` already
   does this for node types and it is the model to copy.*
4. **Proving one path and claiming the feature.** "PROVEN AT SCALE" after one run; the honest count was 5 of 17.
   *A live success proves the path it traversed. Count.*
5. **Two-outcome verdicts.** hit/miss without unreachable; found/missing without ambiguous. *Three outcomes, and
   the third is usually "I could not tell" — say it rather than guessing.*
6. **Building before the shape is expressible.** Five versions of guards preceded one missing intent. *If the user
   restates the same goal while each attempt fails differently, the capability is missing — stop guarding.*
7. **Reading the contract last.** Five builds collapsed into wiring once the existing contract was read. *Read
   what exists before designing what should.*

---

## §8 What this spec deliberately does NOT decide

*(Revised. The first draft ALSO left the BRANCH contract, predicate authorship, multi-arm semantics, gate
defaults, observability, execution policy, case shape and re-run behaviour unstated. Those were not deliberate —
they were gaps, and §1.2, §1.3, §3.1, §4, §5.5, §5.6 and §5.7 close them. Two of them — the missing clause
contract and a permissive gate default — were the dangerous kind, because both fail SILENTLY: an underspecified
clause yields confident garbage, and an unclassified write simply executes. What follows is the genuine
remainder.)*

- A/B in §2 — needs PP-0.
- Whether `try` is the right host for UPSERT — depends on what triggers `recover`.
- Whether BRANCH is a new node type or a new reach to `detect` — likely the latter, unconfirmed.
- The classifier (PP-5) — deferred until measured, on purpose.

Leaving these open is the point. Every expensive error this session came from deciding one of these by inference
instead of by reading.
