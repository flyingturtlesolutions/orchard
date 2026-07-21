# DESIGN — the PER-ITEM PIPELINE (BRANCH · UPSERT · the reach)

**Status:** PP-1's pure core is BUILT and committed (`Core/branchClause.js` + 16 tests). Nothing is wired. PP-0 is
answered (§2.0); PP-0b/0c/0d are open. Written 2026-07-21 after PM-9 (per-item field read) proved out live.
**Read §9 before building anything** — it lists what this spec asserts without having verified.
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

**Three states, deliberately distinguished.** `EXISTS` = the part is there. `COMPOSES` = it has been observed
working in the arrangement this pipeline needs. `PROVEN` = observed live, end to end. An earlier draft of this
table marked everything green and read as "all assembled, just wire it", which is a different and much stronger
claim than the evidence supports.

| stage | exists | composes as needed | where |
|---|---|---|---|
| list read | ✅ | ✅ **PROVEN** — 121 divisions → 22 rows | `RIDE_EACH` |
| per-item field read | ✅ | ✅ **PROVEN** — 22/22, term extraction | `Core/fieldRead.js`, `_runFieldReadClause` |
| cross-system lookup | ✅ | ✅ **PROVEN** — 7-rung ladder, 21/22 | `Core/peritemMap.js`, `_runMapClause` |
| **branch** control flow | ✅ | ❌ **UNVERIFIED** — never run from the clause path, never with a per-item record scope | `detect` — `nodeRegistry.js`, `ExecutionEngine.#executeDetectNode` |
| **branch predicate** | ✅ | ⚠️ **partial** — `evaluateDataCondition(cond, scope)` needs no tab (§2.0), but `scopeFor(item)` is unwritten (PP-0b) | `Services/DataAssertion.js` |
| **upsert** shape | ✅ | ❌ **UNVERIFIED** — what triggers `try`'s `recover` is unknown (§3) | `try` node |
| case per item | ✅ | ⚠️ **shape unread** — the fan-out already emits cases; §5.7 specs a parallel shape without having read theirs | dossier fan-out |
| approval queue | ✅ | ✅ **PROVEN** — staleness CAS + ledger | `Core/proposals.js`, `ProposalStore.js`, `_approveMany` |
| write core | ✅ | ❌ zero importers by design | `Core/writeMap.js` |
| **undo / rollback** | ❌ | ❌ **ABSENT** — no Shopify delete leg exists at all (PP-0d) | — |

**The honest claim: no stage requires a NEW PRIMITIVE. That is not the same as "it assembles."** Six times this
session a planned build collapsed into wiring once an existing contract was read (`coerceParams` already dropped
placeholders; the fleet queue already WAS batch approval; `detect` already branches; `field_contains` exists; the
assertion vocabulary is single-sourced; the wizard already IS the trial gate). That track record is why the
optimistic reading is tempting — and exactly why the two ❌ rows must be verified before being counted on.

### §1.1 The branch predicate, concretely

`detect` evaluates `branch.condition` via `TemplateWalker.checkConditions({tabId, conditions, scope, timeoutMs: 0})`
— a one-shot probe, first match wins, with a `default` arm when none match. Conditions carry a
`family` tag (`'page' | 'scope' | 'reference'`); **page**-family route to the content script, **scope**-family
evaluate engine-side against `scope` — i.e. against RECORDS, not the DOM.

> ## ⛔ THE PREDICATE LIST BELOW IS **WRONG**. DO NOT BUILD AGAINST IT. *(falsified by PP-0b, 2026-07-21)*
>
> An earlier draft listed `field_contains · field_equals · field_starts_with · field_ends_with · field_present ·
> field_gt/gte/lt/lte · all_of · any_of` as the scope-family predicates a branch can use. **`evaluateDataCondition`
> — the scope-side evaluator — supports NONE of them.** Its actual switch is:
>
> ```
> binding_is_list · binding_is_scalar · binding_length_{min,max,range,exactly}
> every_record_{has_field, field_non_empty, field_equals, field_starts_with, field_in_set}
> binding_is_record · record_has_field · record_field_non_empty
> scalar_{non_empty, is_number, equals, number_range, in_set}
> binding_is_{section,image,document} · document_{min_length,contains} · orch_predicate
> ```
>
> The `field_contains` family lives in `SieveExecutor.#evalSieveAssertion` — the SIEVE's row-filter language — and
> in a `StrategyTree` comment. **Same names, different subsystem, not reachable from `detect`.**
>
> **How the error was made:** the list was assembled by grepping identifier names across the tree rather than
> reading the evaluator's switch. That is the same mistake as the earlier "SieveExecutor duplicates the
> vocabulary" worry — matching names inferred to mean a shared vocabulary — made twice, in opposite directions,
> in one session.
>
> **What survives and is genuinely useful for per-item branching:** `binding_is_record` · `record_has_field` ·
> `record_field_non_empty` (single-record tests — "does this task have instructions at all?"), `document_contains`
> (the ONLY contains-style predicate, on a *document* binding), and `orch_predicate` (an escape hatch, unread).
> `every_record_*` is collection-shaped and therefore the wrong shape for per-item.
>
> **NEXT READ (small, blocks PP-1):** `binding_is_document` / `document_contains` semantics — does a long
> free-text field qualify as a document? — and what `orch_predicate` permits. Those decide whether
> structured-field branching is expressible today or needs a new condition type.

~~Available data predicates:~~ *(superseded — see the block above)*

```
field_contains · field_equals · field_starts_with · field_ends_with · field_present   ← NOT AVAILABLE
field_gt · field_gte · field_lt · field_lte                                            ← NOT AVAILABLE
all_of · any_of                                                                        ← unverified
```

These are exact string/number tests over a record. **They are the right tool for STRUCTURED fields and the wrong
tool for FREE TEXT** — see §1.1b, which corrects an earlier draft of this section.

### §1.1b Predicate kind follows FIELD kind *(corrects the first draft)*

The first draft proposed expressing *"this item's Instructions mentions a replacement"* as
`any_of[field_contains(…,"replacement"), field_contains(…,"replace"), …]` and called it "deterministic, no model
call, no egress." **That was wrong, and the reason it was wrong matters more than the fix.**

**The decisive counter-example is negation, not synonyms:**

```
Instructions: "Homeowner asked about replacements — do NOT send one,
               we're repairing under warranty instead."
```

`field_contains(Instructions,"replacement")` → **true** → the item routes to the replacements arm and a draft
order is created. Not uncertain, not a near-miss — **confidently wrong**, and no amount of added keywords fixes
it. `"replacement already sent"`, `"replacement declined"`, `"not covered for replacement"` all fail the same
way. Paraphrase ("ship a new unit", "swap it out") is the milder, better-known problem.

**Three of the four arguments for determinism did not survive scrutiny:**

| argument | status |
|---|---|
| cost | **wrong** — implied N items = N model calls. One BATCHED call classifies all N. ~1 call per run. |
| privacy | **already resolved the other way** — the user permits item text to reach the model (addresses redacted). |
| latency | **irrelevant** — milliseconds vs a few seconds, on a workflow run over tens of items. |
| **determinism** | **survives** — and is recoverable without avoiding the model. See below. |

**THE RULE — predicate kind follows field kind, and the DECLARATION says which:**

| field kind | predicate | why |
|---|---|---|
| enumerated / structured (`TaskStatus`, `IsOpen`, `Age`, ids) | **deterministic** (`field_*`) | values come from a fixed set; exact, free, exhaustively testable |
| **human-authored free text** (`Instructions`, `VendorExplanation`, notes) | **model classification** | no schema, paraphrase, negation, surrounding context |

The original error was picking the mechanism that fit **the example in hand** (a field that happened to contain
the literal token "DEAKO") rather than **the field's nature** — while the user had already stated plainly that the
field has *"no strict formatting rules"*. The same session accepted that for EXTRACTION (`readFieldSection` is
term-matched precisely because structure cannot be assumed) and then designed the BRANCH around literal matching
anyway: one field, one session, two incompatible assumptions.

**Determinism is recovered by BANKING THE VERDICT, not by avoiding the model** — the same move §8.3 makes for
resolved clauses:

```
item 10834758 → arm: 'replacements'
                why: "instructs sending a replacement switch to the homeowner"
                classifiedAt: …, by: 'model', reviewed: true
```

That buys stability (an item does not flip arms between runs), auditability (a rule can never tell you WHY;
this can), reviewability (a wrong call is visible and correctable per item), and cheap re-runs (only new or
changed items are classified).

**The three-outcome contract (§1.2) is what makes this safe.** The classifier MUST be able to answer *"I cannot
tell"* and drop the item into `unknown` rather than guessing — and a negated or context-dependent instruction is
exactly what should land there for a human to read. A model forced to pick an arm is no better than a keyword.

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

## §2 The reach — **RESOLVED by PP-0**

> **PP-0 is ANSWERED. The A/B dilemma below dissolved on reading; it is kept for the record because the reasoning
> that produced it was wrong in an instructive way.** Read §2.0 first; §2.1 is history.

### §2.0 What PP-0 found

The condition system is **three deliberate layers**, unified at v2.70.0 — not the two divergent evaluators the
first draft feared:

| module | role |
|---|---|
| `Services/ConditionVocabulary.js` | the SCHEMA — single source of truth, every type tagged `family: 'page' \| 'scope' \| 'reference'` |
| `Services/Assertion.js` | the **page-side** evaluator (DOM / URL / cookies — needs a tab) |
| `Services/DataAssertion.js` | the **scope-side** evaluator — `evaluateDataCondition(cond, scope)`, engine-side |

`DataAssertion.js`'s own header states the design: *"Where Assertion.js handles page-side conditions, this module
is the engine-side evaluator for scope conditions… The unified evaluator (used by call-sites that mix families,
like strategy DETECT/LOOP) lives elsewhere; this module remains scope-side-only by design."*

**Q1 — does a branch need a live tab?** No, not for data predicates. `evaluateDataCondition(cond, scope)` takes
**scope only, no tabId**. Only page-family arms would need one, and a per-item branch over record data uses none.

**Q2 — does `SieveExecutor` duplicate the vocabulary?** No — the concern was misplaced. `SieveExecutor` imports
`evaluateDataAssertionEnvelope` / `flattenScopeAssertionRefs` from `DataAssertion.js` for envelope evaluation; its
inline `#evalSieveAssertion` switch is a *fourth, different thing* — a row filter over sieve items, which merely
shares verb names. Nothing to unify.

### §2.0.1 The consequence: the reach is an ADAPTER, not a lowering layer

Neither §2.1 option is needed. The per-item pipeline calls the **existing canonical scope-side evaluator**
directly, and `Core/branchClause.js` already has the right shape because `evalBranch` injects its evaluator:

```js
import { evaluateDataCondition } from '../Services/DataAssertion.js';
evalBranch(item, verdict, (assertion, it) => evaluateDataCondition(assertion, scopeFor(it)));
```

The injection chosen to DEFER the A/B decision turned out to BE the design. PP-1's reach is one adapter function.

**The one unknown left is bounded and is not architectural:** what `Scope` shape `evaluateDataCondition` expects.
`Services/Scope.js` exports `Scope, scalar, list, record, document`; the open question is only whether a per-item
record wraps as `record(...)` and under what binding name the `field` of a condition resolves. Read
`evaluateDataCondition`'s field-resolution path and `Scope.js` before writing `scopeFor`.

**A correctness note for that adapter, carried from §1.2:** `evaluateDataCondition` returns a boolean. The
three-outcome contract needs UNKNOWN distinguishable from FALSE, so `scopeFor`/the adapter must return
`undefined` when the condition names a field the record does not carry — do NOT let "absent field" collapse into
"false". If `evaluateDataCondition` cannot express that distinction, the adapter must pre-check field presence
(`field_present` semantics) before delegating.

### §2.1 The original A/B framing *(history — superseded by §2.0)*

Kept deliberately. The draft posed "lower the pipeline into strategy nodes" vs "call the assertion evaluator from
the clause path" and called it the central open question. Both were wrong-shaped: the first over-built (a lowering
layer for something already reachable), the second under-read (it assumed calling the evaluator meant duplicating
semantics, when a scope-side evaluator is exactly the supported entry point). **The error was reasoning about the
architecture from function names instead of reading the module headers** — the same failure that cost the most
time in the session this spec was written from. It took two greps to dissolve.

## §2.2 The original text of the reach section

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

**§1.1b makes this load-bearing rather than optional.** The first draft claimed the branch needed no model at all,
which made egress a hypothetical. It is not: free-text branch arms classify with the model, so item text WILL be
sent on every run that has unclassified items. The redaction is therefore on the hot path, not an edge case.
What still never leaves: row values used as lookup keys — the map threads them into a search PARAMETER, never a
prompt, which is why the address (the join key since v1633) has never reached a model and must not start now.

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

> **⚠ THIS POLICY HAS NO OWNER YET, AND THAT IS THE SPEC'S BIGGEST STRUCTURAL HOLE.**
> The codebase has no "pipeline" object. `_orchRunChain` runs clauses sequentially, threading `st.lastValue` —
> each clause owns its own loop, its own cap and its own error handling. The caps already disagree
> (`_MAP_WINDOW` 24 · `WRITE_BATCH_CAP` 25 · the dossier fan-out 20), which is a symptom, not an accident: there
> is nowhere for a shared policy to live.
>
> So the rules below are currently **aspirations addressed to nobody.** Before PP-1, decide which:
> **(a)** introduce a real pipeline/run object that owns cap, isolation, abort and the run verdict, and have
> clauses execute under it; or **(b)** keep the chain, and push each rule down into every clause that loops —
> accepting that "one declared cap" becomes "three caps that must be kept equal by discipline," which is the
> arrangement that already drifted.
>
> **(a) is almost certainly right** — §5.5's per-run logging, §5.7's re-run rule and the run verdict (§9.7) all
> presuppose a run entity too. But it is a real object that does not exist, and pretending otherwise is how a
> build discovers at wiring time that its policy has nowhere to attach.

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

- **PP-0** — ~~answer §2's two open questions~~ **DONE.** Both answered by reading two module headers (§2.0): the
  condition vocabulary is single-sourced with family-tagged evaluators; scope-side needs no tab; `SieveExecutor`
  does not duplicate anything. The reach is an adapter, not a lowering layer.
- **PP-0b** *(the residue, bounded)* — read `evaluateDataCondition`'s field resolution + `Services/Scope.js` to
  write `scopeFor(item)`. Confirm how a per-item record wraps and how a condition's `field` resolves against it.
  **This is the only thing PP-1's reach still waits on.**
- **PP-0c** *(gates GENERATION, not PP-1)* — §8: add `clause?` to `steps[]`, bank it at wizard-approve time, and
  make replay prefer it over re-interpreting `text`. Independent of the per-item work and worth doing on its own
  merits: today every banked workflow re-asks the model on every run, and `ready` does not pin what a step
  resolved to. **Intent→workflow generation should not be built before this** — generated prose re-interpreted
  per run, with no author who knows what was meant, is worse than the manual wizard it would replace.
- **PP-0e** *(check before building — §10.3)* — does the fleet sweep's `runId` + ledger generalise into the run
  identity §5.6 needs? Read `appendLedger`/`ledgerEntry` call sites. **If yes, run ownership is wiring, not a
  build.** Seventh candidate this session for "reading the contract collapses the build".
- **PP-0f** *(§10.2 — cheapest high-value item in this spec)* — the read-only CLASSIFICATION PASS: classify every
  item in one batched call, show the distribution, act on nothing. Independently useful (it answers "what is
  actually in my queue?"), and it is the prerequisite for stratified trialling.
- **PP-0d** *(now gates only the REJECTION path — §10.1)* — `reversible` becomes a leg REFERENCE, not a
  boolean, and every reversible write declares its undo leg. **Downgraded from blocking:** §10.1's adopt-don't-undo
  model means a SUCCESSFUL trial keeps its output, so undo is needed only when a trial is rejected. Add
  `orchard-trial-<runId>` tagging alongside, so residue is findable even when the created id was never captured. The catalog currently has `shopify_create_customer`,
  `shopify_update_customer`, `shopify_create_order` and **no Shopify delete leg at all**. This is not a generation
  problem: the wizard proves a step BY RUNNING IT, so the first workflow containing a create will leave real
  records behind with no cleanup path. Needs the three-outcome contract too (`undone | failed | unreachable`),
  reverse-order rollback, and the created id captured durably at creation or there is nothing to undo with.
- **PP-1** — reach: BRANCH from the per-item pipeline, whichever of A/B §2 selects. Pure core + tests first.
- **PP-2** — UPSERT with the three-outcome contract and the inline re-check.
- **PP-3** — the `reversible`/`outward` axes + `gate = outward || !reversible`; thread per invariant #3 (three
  catalog→leg hops) and refresh through `mergeRecipes`.
- **PP-4** — declare the gate on existing write legs; verify the user's policy falls out unchanged.
- **PP-5** — **model classification for FREE-TEXT branch arms. NOT a fallback: for a free-text field this is the
  PRIMARY mechanism** (§1.1b). Deterministic `field_*` predicates stay primary for structured fields, and the
  declaration says which kind a field is. Requirements: ONE batched call per run (never per item); the verdict
  BANKED per item with its reason (§1.1b), so re-runs are stable and only new/changed items are classified;
  `unknown` is a first-class answer the classifier must be able to give; addresses redacted before the text is
  sent (§5).
  *(The earlier ">20% land unmatched, then consider a model" threshold is withdrawn — it measured the wrong
  thing. Literal matching does not FAIL LOUDLY on free text, it fails SILENTLY and confidently: "do NOT send a
  replacement" matches `contains "replacement"`. An unmatched-rate metric cannot see that class of error at all.)*

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

## §8 A banked workflow is a saved PHRASING, not a saved PLAN *(verified 2026-07-21)*

Relevant because it gates the intent→workflow generation pivot, and because it is true **today**, before any of
that is built.

### §8.1 The finding

All three workflow replay sites do the same thing:

```js
_orchRunChain(m, { clauses: wf.subAsks.map((t) => ({ text: t })), ask: wf.ask });
```

`subAsks` are STRINGS, wrapped as `{text}` clauses and pushed through the same chain runner that interprets a
freshly typed ask. **Replay re-interprets prose.** The `steps[]` array — the WW-1 body-blind provenance
`{text, via:{kind,host,name}, bankedAt}` — is display and audit only; nothing consumes it at replay time.

### §8.2 Three consequences

1. **A banked workflow re-asks the model on every run.** If interpretation shifts — a prompt edit, a model
   change, a differently-populated palette — the workflow does something different, with no edit and no signal.
2. **`status:'ready'` proves less than it appears to.** `buildWorkflowSave` sets `ready` only when EVERY step was
   approved, and stamps `qualifiedAt` — but what was approved is that a step's TEXT produced a good result ONCE.
   It does not pin what that text RESOLVED to. **Direct evidence from the session this spec came from:** the ask
   `"for each result, read task instructions"` classified as `fieldread` in one trace and `decompose` in another
   — same words, different plan. A workflow banked on the first would silently take the second path later.
3. **It is the hard dependency for generation.** Generating prose sub-asks inherits all of the above AND removes
   the one thing currently holding it together — a human who typed the words and watched them run. Generated
   prose, re-interpreted per run, with no author who knows what was meant, is strictly worse than what exists.

### §8.3 The fix: bank the RESOLUTION alongside the text

`steps[]` already exists per step and already records `via` — the resolution site. It wants one more field:

```
steps[i] = { text, via:{kind,host,name}, bankedAt, clause? }
```

Replay prefers `clause` when present, falls back to re-interpreting `text` when absent. **Warm path and cold
path — the alias flywheel this project already runs on**, applied to workflow steps instead of single asks. The
model is consulted at AUTHOR time and not at run time, which is the same move §1.3 makes for branch predicates
and the same one that makes intent→generation safe rather than merely possible.

Two things it also buys: a `reverifyCapability`-style drift check finally has something to compare against
(does this step still resolve to the leg it was banked with?), and a generated workflow becomes reviewable as a
PLAN rather than as a paragraph.

### §8.4 What is NOT yet decided here

- **Can every step type express a clause?** `map` / `fieldRead` / `branch` / `upsert` can. A step that resolved
  to a page capability or a walk may not have a clause form — those may stay text-only, which is fine as long as
  the record says WHICH it is rather than leaving the reader to guess.
- **Migration.** Existing banked records have no `clause`. The fallback covers them, but a record banked before
  this change and one banked after are not equally trustworthy, and nothing currently distinguishes them.
  Consider stamping the schema version rather than inferring from field presence.
- **When a banked clause is stale.** A clause pinned to a leg that has since been re-declared should re-resolve,
  not run blind. That is the drift check above, and it needs a trigger.

---

## §9 What this spec ASSERTS WITHOUT HAVING VERIFIED — read before building

Distinct from §11. §11 is "chosen not to decide." **This is "stated as though settled, on evidence that does not
support it."** Each item is a place a confident build would go wrong. Produced by adversarially reviewing this
spec against itself; the four in §9.1–§10.4 are the ones that would cost the most.

### §9.0 A predicate mechanism was chosen from ONE example *(found by user challenge, 2026-07-21)*
The first draft specced literal  for a FREE-TEXT branch and justified it on cost, privacy and
determinism. Cost was wrong (batching), privacy was already settled the other way by the user, latency was
irrelevant — and the decisive failure was not synonyms but NEGATION: "do NOT send a replacement" satisfies
 and routes confidently to the wrong arm. §1.1b now ties predicate kind to FIELD kind.
**The generalisable error: the mechanism was chosen to fit the example in hand rather than the data's nature,
while the user had already said the field has no consistent format.** Check every other place this spec picks a
mechanism — especially §3 (UPSERT on ) and §5.7 (case shape) — for the same move.

### §9.1 Composition is assumed from part-existence
The §1 table now says this outright, but it bears repeating as a rule: **`detect` running inside a `foreach`,
reached from the clause path, over a per-item record scope, has never been observed.** Neither has `try`'s
`recover` arm under a failed lookup. Verify both before treating BRANCH or UPSERT as wiring rather than building.

### §9.2 The orchestration owner does not exist
See §5.6. Policy for caps, isolation, abort and the run verdict is specified against an object the codebase does
not have. **Decide (a) or (b) before PP-1.**

### §9.3 The CASE shape is reinvented, not read
§5.7 proposes a structure while the dossier fan-out already emits cases with a shape of its own. **Read theirs
first.** This is the write-batch mistake — inventing an approval flow that already existed — and it is being
repeated inside the document that records it as a lesson.

### §9.4 `reversible` may be a third name for `destructive`
§4 adds `reversible` / `outward`. But `hintToSafety` already consumes `destructiveHint`, and the catalog already
declares `safetyClass: 'destructive'`. **If `destructive` already means `!reversible`, then §4 introduces a
competing vocabulary for a concept that has one** — precisely the failure §7.3 warns about. Check before
building PP-3; the real gap may be only `outward`.

### §9.5 Nesting is structurally possible and completely unspecified
`arms[].then` is `clause[]`, so a branch can contain a branch. Depth limit, cycle detection, whether a nested
branch sees the same item scope, how §5.5 logs depth — none of it is decided. Someone will nest on day one.

### §9.6 Concurrency is neither permitted nor forbidden
§5.6 calls items independent, which invites parallelism; the map runs sequentially. With writes involved,
parallel UPSERTs against the same entity is a real hazard. Say **sequential, and why** — or specify the guard.

### §9.7 No run-level verdict
Per-item outcomes are specified in detail; a run has only a tally. **When is a run done vs partially done vs
failed?** A run that processed 3 of 22 and stopped needs a verdict, not just counts. (Needs §9.2 resolved —
there is nowhere to put a verdict without a run object.)

### §9.8 No policy for an empty or enormous collection
Zero rows? Four thousand? There is a cap but no behaviour for "far more than expected", which is exactly the
moment a human should be asked rather than silently truncated to 24.

### §9.9 Clause-pinning (§8.3) is a TRADEOFF, presented as a strict improvement
Re-interpretation is drift, but it is also adaptability: a workflow banked before a leg existed can start using
it. Pinning freezes that. §8.3 should state what makes a pinned clause re-resolve, and admit it trades
adaptability for determinism rather than being free.

### §9.10 §1.3's friction is unpriced
"The model may only propose" means a user cannot say *"if it mentions replacements"* and have it simply work —
they must review and bank. That is the right call, but the spec neither acknowledges the cost nor argues it
against the alternative.

### §9.11 This document does not stand alone
Dense back-references ("the v1637 bug", "the v1620 rule") are meaningless without `logs/run/findings.md` open,
and §7 is a retrospective smuggled into a design doc — it lists failures that already happened rather than
failures specific to THIS design. The predictive ones live here in §10, which is where §7's energy should have
gone.

---

## §10 Trial · sampling · ownership · drift — **DECIDED 2026-07-21**

Four holes named in review, four decisions taken. Each replaces an earlier hand-wave.

### §10.1 The trial model: **prefix first, then ADOPT — do not "undo" by default**

Rejects the framing that a trial is a rehearsal to be cleaned up.

1. **First pass — the reversible PREFIX.** Run reads and lookups, stop at the first write, and show what *would*
   be written. **Zero residue, needs nothing that does not exist, available today.** Proves the plan resolves and
   finds the right records; does not prove the write succeeds.
2. **Real trial — ADOPT, don't undo.** Run the whole plan on ONE item. If it is right, **that item is done** —
   its draft is the outcome you wanted, so keep it and continue with the rest. The trial is not a rehearsal, it
   is the first item performed carefully. **Undo is therefore only needed on the REJECTION path**, which is the
   minority case. This is the user's own sequencing ("prove the unit, then fan out") taken literally: the unit is
   not discarded.
3. **Rejection path — undo legs + tagging.** `reversible: { by: '<leg id>' }` (PP-0d), plus every trial-created
   record carrying `orchard-trial-<runId>` in a tag/note. **The tag matters more than the id:** it survives a lost
   response or a service-worker restart, so residue is findable even when nothing was captured — and a human can
   see what is trial residue in the vendor's own UI without Orchard's help.

Consequence: PP-0d stops being a blocker for trialling and becomes a blocker only for *rejecting* a trial. Still
needed, no longer first.

### §10.2 Sampling: **classify ALL items before acting on ANY**

Rejects "prove on item 1". A one-item trial proves the MECHANISM, never the POPULATION — and this project's own
data disproves the assumption that item 1 is representative (`11 found / 11 whole-field`: half the records had the
part, half did not).

**A read-only classification pass runs over every item first** — one batched call, no writes, no effects — and
its distribution is shown before anything acts:

```
22 items — replacements 11 · outreach 6 · no arm 4 · couldn't tell 1
```

Then trial a **stratified sample**: one item per matched arm, plus one `unknown`, plus one with a missing field
if any. That proves coverage rather than mechanism.

Two properties worth stating: it surfaces a bad classifier BEFORE any write, and it converts a leap of faith into
a visible distribution the user can sanity-check against their own knowledge of the queue. **Cheapest high-value
addition in this spec.**

### §10.3 Run ownership: **CHECK for an existing run identity before building one**

§5.6's policy still has no owner — but do not design a `Run` object yet. The fleet sweep already threads a
`runId` through its ledger (`ledgerEntry('sweep', { counts, runId })`, `ledgerEntry('proposal', { …, runId })`),
which is **a run identity with an append-only ledger, already built**.

**PP-0e: read whether that generalises.** If it does, run ownership is wiring. If it does not, build the `Run`
object — §5.5's per-run logging, §5.7's re-run rule and §9.7's run verdict all need somewhere to live.

This is deliberate: six times this session reading an existing contract collapsed a planned build into wiring,
and this is the seventh candidate. Ten minutes of reading before a day of building.

### §10.4 Drift: fingerprint + version stamp + **FAIL LOUDLY, never silently re-interpret**

Three parts, and the third **corrects a fail-open introduced in §8.3 of this same document**:

1. **Dependency fingerprint** — hash the legs and fields a workflow depends on; a catalog change marks dependents
   stale. `driftHash` already exists for this purpose; reuse it rather than inventing a second mechanism.
2. **Version stamp** — a workflow records the catalog version it was banked against, so staleness is computable
   rather than inferred from field presence.
3. **The completion.** §8.3 says replay prefers the banked clause and falls back to re-interpreting the text
   *when absent* — which is right, and is **silent** on the other case: clause present, no longer resolvable.
   Silence there is the hazard, because the obvious implementation reuses the same fallback. Both cases must be
   named explicitly:
   - clause **ABSENT** (banked before the feature existed) → fall back to text. Expected, fine.
   - clause **PRESENT but no longer resolves** (the leg changed, the field vanished) → **STOP AND FLAG.**
     Never silently re-interpret.
   Falling back in the second case is a fail-open of exactly the kind recorded at v1639: the workflow keeps
   running and quietly does something else, with no signal. A drift check that can be bypassed by a fallback is
   not a drift check.

---

## §11 What this spec deliberately does NOT decide

**PP-0 removed two of these** (§2.0): the A/B reach choice, and whether `try` sits under the same evaluator
question — both dissolved once the condition layering was read rather than inferred. What remains genuinely open:
`scopeFor(item)` (PP-0b, bounded), whether `try`'s `recover` is reached on ANY failure or specific classes (§3),
and PP-5 (deferred by design, with a threshold).

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
