# DESIGN — the PER-ITEM PIPELINE (BRANCH · UPSERT · the reach)

**Status:** PP-1's pure core is BUILT and committed (`Core/branchClause.js` + 16 tests). Nothing is wired. PP-0 is
answered (§2.0); **PP-0b is answered (§1.1c)**; PP-0c/0d/0e/0f are open. Written 2026-07-21 after PM-9 (per-item
field read) proved out live.
**Read §9 before building anything** — it lists what this spec asserts without having verified.

**The method rule, earned the expensive way:** *read before designing, and WRITE DOWN what you read.* Eight times
in the session this spec came from, a planned build collapsed into wiring once an existing contract was read
(`coerceParams`, the fleet queue, `detect`, the assertion vocabulary, the wizard-as-trial-gate, `runId`, the
predicate bridge). Reading does not persist across a long session; writing does. Every ⛔ and every §9 item below
exists because something was inferred from identifier names instead of read from a switch statement.
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
| **branch predicate** | ✅ | ⚠️ **partial** — vocabulary + binding granularity now READ (§1.1c); needs no tab (§2.0); `scopeFor(item)` still unwritten but fully specified | `Services/DataAssertion.js`, `Core/orchAnalyze.js` |
| **upsert** shape | ✅ | ❌ **UNVERIFIED** — what triggers `try`'s `recover` is unknown (§3) | `try` node |
| case per item | ✅ | ⚠️ **shape unread** — the fan-out already emits cases; §5.7 specs a parallel shape without having read theirs | dossier fan-out |
| approval queue | ✅ | ✅ **PROVEN** — staleness CAS + ledger | `Core/proposals.js`, `ProposalStore.js`, `_approveMany` |
| write core | ✅ | ❌ zero importers by design | `Core/writeMap.js` |
| **undo / rollback** | ❌ | ❌ **ABSENT** — no Shopify delete leg exists at all (PP-0d) | — |

**The honest claim: no stage requires a NEW PRIMITIVE. That is not the same as "it assembles."** Repeatedly this
session a planned build collapsed into wiring once an existing contract was read (`coerceParams` already dropped
placeholders; the fleet queue already WAS batch approval; `detect` already branches; the assertion vocabulary is
single-sourced; the wizard already IS the trial gate; the fleet sweep's `runId` may already be the run object;
the clause-path predicate engine is already reachable via `orch_predicate`). That track record is why the
optimistic reading is tempting — and exactly why the two ❌ rows must be verified before being counted on.

**One entry was struck from that list, and it is the instructive one.** An earlier draft counted *"`field_contains`
exists"* among the wins. **It does not** — not in the scope-side evaluator (§1.1's ⛔ block). So the very paragraph
arguing "read the contract before building" contained an item that had been grepped rather than read. The pattern
is real, and it is not self-verifying: *"I found it already existed"* is itself a claim that needs the read.

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
> ~~**NEXT READ (small, blocks PP-1):**~~ **DONE — see §1.1c.** Both were read against source. The answer:
> **no new condition type is required**, and the deterministic ceiling is meaningfully higher than this block
> implies — but it is governed by BINDING GRANULARITY, not by the condition list. §1.1c is the authoritative
> statement; the switch above remains accurate as the *native* set.

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

### §1.1c PP-0b ANSWERED — the real predicate ceiling *(read against source 2026-07-21)*

Both open reads are done. **No new condition type is required.** The deterministic floor is higher than the ⛔
block implies — but the thing that governs it is **binding granularity**, not the condition list, and that is the
finding that changes how `scopeFor` must be written.

**There are two routes to a branch predicate, not one.**

1. **Native scope conditions** — the switch in the ⛔ block. These address `cond.binding` **plus `cond.fieldName`**
   for the record family, so per-field structured tests work directly over a record binding:
   `record_has_field` (`DataAssertion.js:370`) and `record_field_non_empty` (`:382`).
2. **`orch_predicate`** (`DataAssertion.js:517`) — a bridge to `evaluatePredicate` (`Core/orchAnalyze.js:135`),
   the SAME evaluator the chat interpreter uses. Its op set, read from the switch:

```
exists · none · contains · not_contains · gt · gte · lt · lte · eq        + spec.negate (flips LAST)
```

`contains`/`not_contains` lowercase both sides; `gt/gte/lt/lte/eq` compare either `_count` (when
`spec.target === 'count'`) or the first number parsed out of the coerced scalar. It ships `predicateLabel`
(`orchAnalyze.js:160`), which renders an arm in English — *"it mentions X"*, *"it's over 30"* — which is exactly
what §10.2's review-before-acting needs, already built.

> #### THE BINDING-GRANULARITY RULE — the actual PP-0b finding
>
> **`orch_predicate` carries NO `fieldName`.** It takes `{binding, specJson}` and coerces the WHOLE binding
> through `_coerceForPredicate` (`DataAssertion.js:57`). For `kind:'record'` that coercion is
> `Object.values(fields).join(' ')` — **every field value flattened into one string.**
>
> So over a *record* binding, `orch_predicate contains "replacement"` searches **all fields at once**, and
> `gt` parses the first number out of a concatenated blob of every field value — which is not a numeric test on
> anything meaningful.
>
> **Therefore: a field that needs a rich predicate must be bound as its OWN binding.** `scopeFor(item)` is not
> "wrap the record"; it is:
>
> ```
> scopeFor(item) → Scope with
>    record(item)                    under a stable binding name   // record_has_field / record_field_non_empty
>    document(item.<longTextField>)  under its own binding name    // document_contains, orch_predicate contains
>    scalar(item.<numericField>)     under its own binding name    // orch_predicate gt/gte/lt/lte/eq
> ```
>
> This corrects the shorthand carried out of the PP-0b session (*"record(item) + document(item.Instructions)"*),
> which is right about the two constructors and silent about the rule that makes them necessary. **Which fields
> get their own binding is a declaration** (§1.3), not something the adapter can infer — and that is a genuine
> new obligation on the declaration, not a free consequence.

**Three hazards found in the same read. Each is small, each fails in the unsafe direction, none is hypothetical
once branch arms are being authored:**

1. **Two contains-style predicates with DIFFERENT case semantics.** Native `document_contains` (`:503`) is
   `content.includes(needle)` — **case-SENSITIVE**. `orch_predicate`'s `contains` lowercases both sides —
   **case-INSENSITIVE**. Same verb, same document, different answer. Pick one per project and say which;
   `orch_predicate` is the better default because case-sensitivity on human-authored text is a bug generator.
2. **`exists` is not a presence test.** It routes through `_countFromValue`, where any non-empty scalar → 1 but
   the literal words `no|none|zero|nothing|n/a` → 0. So a field containing the string `"none"` reads as ABSENT.
   That is defensible for observation results and actively wrong for a record field whose value is legitimately
   the word "none". **Use `record_field_non_empty` for presence, not `exists`.**
3. **Unknown op + `negate:true` returns TRUE — a fail-OPEN,** contradicting `evaluatePredicate`'s own doc comment
   (*"Unknown op → false … a closed gate is a safe default"*). The `default:` arm sets `r = false` and the negate
   flip is applied afterwards, unconditionally. A typo'd op in a negated arm therefore matches **every item**.
   Given §4's DEFAULTS-FAIL-CLOSED rule this is the wrong direction, and a branch arm is precisely a place where
   generated specs will contain typo'd ops. **PP-1 must not rely on the evaluator failing closed here** — either
   validate the op against the known set before evaluating, or fix the flip to skip the default arm.

**What this does NOT rescue.** `orch_predicate`'s `contains` is still `String.includes` with a lowercase. It is
better provisioned than §1.1 claimed and it does not touch §1.1b's conclusion: *"do NOT send a replacement"* still
satisfies `contains "replacement"` and still routes confidently wrong. `not_contains` and `negate` permit
*"mentions replacement AND does not mention 'do not'"*, which is keyword logic wearing a better suit — it breaks
on `"declined"`, `"already sent"`, `"under repair instead"`. **Model classification for free text; deterministic
predicates for structured fields; the declaration says which.** Unchanged.

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

A predicate — `document_contains(Instructions, "replacement")`, or the `orch_predicate` equivalent — is declared
data. **By whom** decides what this system is:

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

~~**The one unknown left is bounded…**~~ **ANSWERED — see §1.1c.** `Services/Scope.js` exports
`Scope, scalar, list, record, document`; a condition addresses `cond.binding` (+ `cond.fieldName` for the record
family), and the load-bearing consequence is the **binding-granularity rule**: `orch_predicate` has no
`fieldName` and flattens a record binding to one joined string, so any field needing a rich predicate must be
bound separately. `scopeFor` is specified in §1.1c and is now a writing job, not a reading one.

**A correctness note for that adapter, carried from §1.2 — and it is HARDER than this section first claimed.**
`evaluateDataCondition` does **not** return a boolean; it returns `{ ok: boolean, reason: string }`. That sounds
like it helps, and it does not: **every failure path returns `ok:false`** — unbound binding, wrong `kind`, missing
field, empty needle, and a caught throw alike. FALSE and COULD-NOT-EVALUATE are therefore **already merged** at
this layer, separated only by the prose in `reason`.

**Do not parse `reason` to recover the distinction.** Those strings are diagnostic text, not an API; they are
formatted for humans, they vary per case, and pinning the three-outcome contract to their wording makes an
unannounced string edit a silent routing change. **The adapter must PRE-CHECK before delegating** — confirm the
binding exists and is of the expected `kind`, and for a field test confirm the field is present
(`record_has_field` semantics, *not* the falsified `field_present`) — and return UNKNOWN itself. Only when the
pre-check passes does a returned `ok:false` mean a genuine FALSE.

This is the §1.2 three-outcome contract's real cost, and it lands entirely on the adapter. It is also the v1637
bug's exact shape (unreachable read scored as a miss) waiting one layer down: without the pre-check, a per-item
branch routes items to `otherwise` whenever a field is merely absent.

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
blip. ~~`try`'s `recover` arm reached on ANY failure would be exactly this bug; confirm what triggers `recover`
before using it.~~

> ## ✅ CONFIRMED, AND THE ANSWER IS NO: **`try` IS THE WRONG HOST.** *(read 2026-07-21, built around at v1661)*
>
> `Services/ExecutionEngine.js:1515-1531` chooses `recover` by ELIMINATION on a three-valued status —
> `ok` returns, `aborted` propagates, **everything else runs recover**. The result shape is `{status, error?}`
> where `error` is a bare STRING (`:560-567`): no code, no category, no cause.
>
> And unreachability is normalized INTO that bucket before `try` ever sees it. `TemplateWalker.#msg` retries a
> never-delivered channel 6× then throws, and every `#executeStep` call site catches that throw and converts it
> to a success-false string. So a dead tab, an uninjected content script, a Cloudflare interstitial, and a
> lookup that legitimately matched nothing all arrive as the SAME `status:'failed'`.
>
> A find-or-create on `try` would therefore create a duplicate record every time the lookup merely failed to
> reach the service — the v1637 bug with a write on the end of it. The engine even COMPUTES a structured cause
> (`PreconditionGate` returns a `classification`) and then discards it at exactly this point, putting it in the
> emitted event and not the returned result.
>
> **`Core/upsert.js` therefore owns its own control flow** over a find that must report three outcomes, and
> `normalizeFindResult` is deliberately strict: an unrecognized shape is `unreachable`, never `miss`.
>
> *(Same read, relevant to §9.1: `detect` cannot give the three-outcome contract either.
> `TemplateWalker.js:1602-1606` catches a throwing predicate into `matched = false`, so "no arm matched" and "a
> predicate threw" are indistinguishable, and `#executeDetectNode` reads only `probe.ok`. This is why BRANCH
> reaches the evaluator through an adapter that PRE-CHECKS, rather than through `detect`.)*

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

> ## ⚠ AMENDED AT BUILD TIME (v2.74.1661). ONE axis was added, not two — and it RAISES ONLY.
>
> **`reversible` was NOT added.** §9.4's suspicion was correct: `destructive` already means exactly
> `!reversible`, and `reversible` is separately already a live boolean on the capability side. Three names for
> one predicate is the §7.3 failure. **`outward` was added** — it had no name anywhere.
>
> **The derived rule above was NOT implemented as written, because it LOOSENS.** Read literally,
> `gate = outward || !reversible` makes every reversible internal write free — `shopify_create_customer`,
> `shopify_update_customer`, `shopify_create_order`, `create_user`, `add_tags`, `set_ticket_requester` are all
> `reversible:true, outward:false`. Today every one of them floors at `confirm` via `hintToSafety` and
> fail-closes without `confirmed:true` at both executor belts. Shipping the rule as stated would have **un-gated
> that entire class across every existing surface** as a side effect of a per-item pipeline change.
>
> That is not what the user's policy asks for. "Profile creation is un-gated, it's a system-internal reversible
> step" is a statement about what a PIPELINE may do unattended within a reviewed run — it is not a request to
> lower the global floor for every ad-hoc write in the product. **So the gate relaxation belongs at the
> pipeline's own gate, where the run, the trial and the case give it context; the global classifier keeps its
> floor.** `hintToSafety` gained `outward` as a raise-only input and nothing else.
>
> **Still owed:** the param-conditional case. `add_comment`'s outward-ness depends on `public:true`, but
> `hintToSafety` runs at leg-BUILD time before params bind, so a static declaration would over-gate internal
> notes. That needs an invoke-time `outwardWhen` evaluated where the bound params exist. Until it lands, a public
> customer reply still goes out on one click while an SMS needs two.

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

> ⛔ **A first-draft paragraph was removed here.** It read: *"The branch as specced needs no model at all —
> `field_contains` is deterministic. Egress only arises if §6's optional classifier is built."* It contradicted
> the paragraph directly above it and rested on `field_contains`, which does not exist in the scope-side
> evaluator (§1.1's ⛔ block). Both of its claims are false: the branch DOES need a model for free-text arms
> (§1.1b), so egress is on the hot path and not conditional on an optional build.

If it is: batch one call for N items (not per-item — the cost property), strip addresses before sending, and keep
the result to a label the branch consumes. See `docs/DESIGN_llm_privacy.md` (R-1..R-4 redactor).

> **DONE at v2.74.1662.** The redactor exists (`Core/redact.js`, R-1/R-2/R-3 wired at the transport boundary) and
> PP-5 uses it **unconditionally** — it does not consult the global `settings:redact_pii` toggle, because this
> section makes redaction a PRECONDITION of this egress rather than a preference about it.
>
> **How the address requirement is actually met, since it is not obvious:** no regex reliably detects a street
> address. `identityValues` (`Core/branchClassify.js`) reads the record's OWN address/name/contact fields and
> redacts *those values* out of the instruction text. The address is redacted because the record told us what it
> is — not because a pattern guessed. The map stays in the panel; the service never receives it, and the model's
> returned reasons are restored locally so the user reads real words the model never saw.

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

## §5.8 REACHABILITY is part of the shape — *(added 2026-07-22, from a live misroute)*

Every clause in §0's shape must be nameable by the front door. This is not a build-order note; it is a **safety
property**, and it was learned the hard way.

`Core/pipelineCase.js` was built, tested (19) and specified at §5.7 from v1665. It was not in `Core/interpret.js`'s
`INTENTS` array. Live (2026-07-22, trace 070307) the ask *"create a new case listing the number and type of
replacement"* therefore resolved to `act` on `me.zendesk.create_ticket@deako.zendesk.com` — a different ground, a
real CS queue, an outward write, dispatched twice. The interpret prompt made it worse: it explicitly said
*"spawning a case per item is `decompose`"*, steering the ask away from the clause built to serve it.

**The rule.** A clause absent from the vocabulary does not degrade to "unavailable". The front door must choose
*something*, so it substitutes the nearest expressible thing, **confidently**. An unreachable clause is therefore
strictly worse than an unbuilt one: unbuilt fails visibly, unreachable succeeds at the wrong act. "Built" means
reachable from the front door — the ten seams (§6's ladder note), not the pure module alone.

**The corollary, and the second half of the same live bug.** §1's narrowing comment assumed *"an empty prior makes
the next clause report 'nothing to work with'"*. That holds for a per-item clause, which consults the prior. It
does **not** hold for `act`, which resolves a leg from the ask alone and never looks at the working set. So
`BRANCH ▸ narrowed prior → 0 of 1` was followed by a dispatched write.

A pipeline must therefore stop **at the step boundary**, not inside each clause: if a prior step produced a
collection that came back EMPTY *and* the next step's own words point back at it ("each", "those", "them"), the
step does not dispatch. Both conditions are required — a step that never depended on the prior ("open shopify.com")
must still run. `Core/priorScope.js`.

**And the gate must narrate itself.** The same trace could not answer *"did it write?"*: two `INVOKE_SESSION`
dispatches, no result line, and zero gate lines in the whole file. The confirm bar logged only *after* a confirm,
so a write **awaiting a human emitted nothing** — the most decision-worthy moment in the system was the one it did
not record. A gate that holds must log the HOLD (`WRITE_GATE ▸ held`) and the DECLINE, not only the release.

---

## §6 Build ladder

- **PP-0** — ~~answer §2's two open questions~~ **DONE.** Both answered by reading two module headers (§2.0): the
  condition vocabulary is single-sourced with family-tagged evaluators; scope-side needs no tab; `SieveExecutor`
  does not duplicate anything. The reach is an adapter, not a lowering layer.
- **PP-0b** — ~~read `evaluateDataCondition`'s field resolution + `Services/Scope.js`~~ **DONE (§1.1c).** No new
  condition type needed. Three things came out of it that PP-1 must honor: the **binding-granularity rule** (a
  field needing a rich predicate gets its own binding — `orch_predicate` has no `fieldName`), the **pre-check
  obligation** (§2.0.1 — `ok:false` merges FALSE with COULD-NOT-EVALUATE; do not parse `reason`), and three
  small hazards (case-semantics split, `exists` ≠ presence, unknown-op+`negate` fails OPEN).
  **PP-1's reach is now unblocked** — `scopeFor` is a writing job.
- **PP-0c** *(gates GENERATION, not PP-1)* — §8: add `clause?` to `steps[]`, bank it at wizard-approve time, and
  make replay prefer it over re-interpreting `text`. Independent of the per-item work and worth doing on its own
  merits: today every banked workflow re-asks the model on every run, and `ready` does not pin what a step
  resolved to. **Intent→workflow generation should not be built before this** — generated prose re-interpreted
  per run, with no author who knows what was meant, is worse than the manual wizard it would replace.
- **PP-0e** — ~~does the fleet sweep's `runId` + ledger generalise?~~ **READ. NO — build the run object.** The
  full evidence is in §9.2. Short version: capped-and-evicting at 500 shared across kinds, a strict field
  whitelist that would silently swallow an `itemId`, a run verdict that is computed and discarded, and
  run-openness living outside the ledger behind a 5-minute timer only one of the two sweep twins writes.
  **This is the first time this session that reading the contract did NOT collapse the build** — worth noting,
  because seven prior candidates did, and the streak was starting to feel like a law.
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
- **PP-1** — ~~reach: BRANCH from the per-item pipeline~~ **BUILT AND WIRED (v2.74.1661).**
  `Core/branchScope.js` (the adapter: `planBindings` + `precheckCondition` + `makeBranchEvaluator`, pure and
  injected) + `_runBranchClause` in chat.js. Threaded through every seam the clause path has: `INTENTS`,
  `normalizeInterpretDecision`, `parseInterpretOutput`'s payload whitelist, the prompt vocabulary + shape line,
  the `INTERPRET ▸` payload probe's third whitelist, **both** dispatcher doors *and* the chain's execution half,
  the child-lane drop site, and `_DECISION_RE`. Confidence-gated like `map`. 27 tests.
  **Blocker fixed in the same pass:** `fieldRead` never set `st.lastValue`, so it was a composition DEAD END —
  `list → read instructions → branch on instructions` could not work at all, and every predicate on the read
  field would have evaluated UNKNOWN. It now returns and threads its enriched rows.
- **PP-2** — **CORE BUILT (v2.74.1661), runtime deliberately unwired.** `Core/upsert.js`: three-outcome contract,
  inline re-check, `upsertOnce` for §3.1's shared-target hazard, trial-tag passthrough. 21 tests. NOT built on
  `try` — see §3's confirmed block. Wiring it to real create legs is the write path and stays behind the
  existing `Core/writeMap.js` boundary until a human drives a trial.
- **PP-3** — **BUILT, AMENDED (v2.74.1661).** `outward` only, raise-only; `reversible` rejected as a duplicate of
  `destructive`. Threaded per invariant #3 (`rideRecipe.js` hop 1 · `harvestedRecipeLegs` spread hop 2 ·
  `connectorLeg.js#recipeToLeg` hop 3), with a seeded-path test that asserts on the LEG. See §4's ⚠ amendment
  for why `gate = outward || !reversible` was NOT implemented as written.
- **PP-4** — declare the gate on existing write legs; verify the user's policy falls out unchanged.
  *Partly done:* `aw_send_sms` now declares `outward` honestly. **Owed:** the param-conditional case
  (`add_comment public:true`) needs an invoke-time `outwardWhen`, since `hintToSafety` runs before params bind.
- **PP-5** — **BUILT (v2.74.1662).** `Core/branchClassify.js` (26 tests) + `AnthropicService.classifyBranch` +
  the `CLASSIFY_BRANCH_ITEMS` handler + the `classify` arm form in the interpret prompt. All four requirements
  are honored: ONE batched call per run · `unknown` is first-class (and an INVENTED arm label is downgraded to
  unknown and counted, never guessed) · the banking shape exists with change-detection by text hash ·
  **addresses redacted before egress**.
  Two things worth knowing. **The redaction is SEEDED, not detected** — no regex finds a street address, so
  `identityValues` reads the record's own address/name/contact FIELDS and redacts those values; the address has
  been the map's join key since v1633, and it still never rides into a prompt. **The unavailable path degrades to
  UNKNOWN, never to keywords** — a keyword fallback is exactly the confidently-wrong answer this rung exists to
  prevent, so when the model is unreachable every classified arm answers unknown and a human reads them.
  *Owed:* the banking is BUILT but not yet PERSISTED — `bankedVerdict`/`unbankedItems` exist and are tested, and
  nothing writes them to storage yet, so today every run re-classifies. That is correctness-neutral and costs a
  call per run.
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

### §9.2 The orchestration owner does not exist — **READ 2026-07-21: build it (option a)**
See §5.6. **PP-0e is answered, and the answer is that the ledger cannot own a run.** The fleet sweep's `runId` is
a copy-pasted template literal in two files (`chat.js:4407`, `background/handlers/fleet.js:198`) that already
disagree — one stamps an in-flight marker, one does not — and it is never returned from the function that mints
it. `Core/actionLedger.js` is a **narration substrate, not run state**:
- `LEDGER_CAP = 500` and silently evicting (`ActionLedgerStore.js:9,39`), shared across all kinds for the
  instance. A per-item run writing ~3 entries per item starts evicting **its own earliest entries** near N≈150.
- `ledgerEntry` is a strict field WHITELIST (`:20-34`) — an `itemId` or an outcome enum would be dropped with no
  error — and an unrecognized `kind` silently coerces to `'proposal'` (`:17`).
- **The run verdict is computed and thrown away.** The `sweep` entry is written BEFORE the execution loop
  (`fleet.js:340` vs `:347`), so its counts predate every outcome; the real tallies are locals that reach a chat
  note and a log line and are never ledgered.
- Run-openness lives outside the ledger entirely, as a **5-minute wall-clock guess** (`fleetSchedule.js:86`) that
  only the headless twin participates in.

So: `runId` is reusable as a CONVENTION (extract the mint), per-item outcome records are a small extension, and
the run verdict + "already processed in an open run" are **absent**. Build the run object.

### §9.3 The CASE shape is reinvented, not read — **READ 2026-07-21: WRONG SHAPE, and there is a better precedent**
Read theirs first, and the answer is that neither existing shape fits. A "case" is a `Conversation` row, and the
two paths that mint them do not share a definition:
- **Dossier fan-out case** — a sub-task conversation. **No status field at all**; existence IS open, and the only
  close is deletion. `patchMeta`'s allow-list (`ConversationStore.js:279`) is closed, so a verdict field is a
  store change, not a field addition.
- **Vitals incident case** (`vtc_`) — a near-empty conversation SHELL whose real state (`status`, `openedAt`,
  `closedAt`, `evidence[]`) lives in a **sidecar store** (`Core/vitals.js:89-95`).

Three things a per-item pipeline needs are unrepresentable today: **failed vs never-ran** (`_runChildTask`
collapses three outcomes into `'needs-you'` and then discards the status entirely — `chat.js:2045`, `2107`),
per-stage verdicts (the container is a `messages[]` transcript; stage results are prose bubbles), and
actions-with-approval-state at the right grain (ledger and proposals key by `instanceId`, which every case under
a desk SHARES).

**The precedent to copy is the vitals sidecar, not the fan-out** — real state in an owned store, conversation as
a render shell, with `evidence[]` + open-or-append (`vitals.js:79`) as the closest existing analogue to
per-stage verdicts.

*(Found in passing, unrelated to this design: `patchMeta` silently drops `summary` and `resolvedAt` because
neither is on its allow-list, while `chat.js:11598-11600` writes both. So `conv.resolvedAt` is never set, the
`!conv.resolvedAt` guard is permanently true, and every `VITALS_CHANGED` re-patches and re-logs
`VITALS ▸ case resolved` for every closed incident.)*

### §9.4 `reversible` may be a third name for `destructive` — **CONFIRMED. Only `outward` was new.**
It is. `Core/proposals.js:124` is a literal rendering ternary:
`p.safety === 'destructive' ? 'hard to reverse (source closes)' : 'reversible'` — the codebase already prints a
non-destructive proposal to the user as the word **"reversible"**. And `reversible` separately exists as a live
boolean on the capability side (`Core/orchMatch.js:25` → `sg.js:553` → `chat.js:6487,7390`, where it is a hard
veto on auto-fire). Adding a third spelling would have given one predicate three names.

`outward` genuinely had no name — it was smuggled in by **mislabeling** outward legs as destructive
(`aw_send_sms` is flagged `destructive` while destroying nothing, with a comment explaining an SMS "can't be
unsent"). The cost was visible one entry away: `add_comment` with `public:true` REPLIES TO THE CUSTOMER, is
equally unsendable, and sat at single-click `confirm` because it is merely a write.

**Built at v2.74.1661: `outward` only, and RAISE-ONLY** — see the §4 amendment.

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
question — both dissolved once the condition layering was read rather than inferred. **PP-0b removed a third**
(§1.1c): the predicate vocabulary is settled and needs no new condition type. What remains genuinely open:
whether `try`'s `recover` is reached on ANY failure or specific classes (§3), the execution-policy owner
(§9.2 — decide (a) or (b) before PP-1), and PP-5 (deferred by design).

*(Revised. The first draft ALSO left the BRANCH contract, predicate authorship, multi-arm semantics, gate
defaults, observability, execution policy, case shape and re-run behaviour unstated. Those were not deliberate —
they were gaps, and §1.2, §1.3, §3.1, §4, §5.5, §5.6 and §5.7 close them. Two of them — the missing clause
contract and a permissive gate default — were the dangerous kind, because both fail SILENTLY: an underspecified
clause yields confident garbage, and an unclassified write simply executes. What follows is the genuine
remainder.)*

- ~~A/B in §2 — needs PP-0.~~ **RESOLVED** (§2.0.1): an adapter, not a lowering layer.
- ~~Whether BRANCH is a new node type or a new reach to `detect`.~~ **RESOLVED — neither.** `Core/branchClause.js`
  owns the arm logic and takes an INJECTED evaluator; the adapter hands it `evaluateDataCondition`. `detect` is
  not on the per-item path at all. (The injection chosen to DEFER this choice turned out to be the design.)
- Whether `try` is the right host for UPSERT — still open; depends on what triggers `recover` (§3).
- The classifier (PP-5) — deferred until measured, on purpose.
- **Which fields a record declares as separately-bound** (§1.1c's binding-granularity rule) — a new obligation on
  the declaration, surfaced by PP-0b and not yet designed. It belongs with §1.3's authorship question.

Leaving these open is the point. Every expensive error this session came from deciding one of these by inference
instead of by reading.
