# HANDOFF — the per-item pipeline, as of v2.74.1682

**Read this instead of the last twenty `findings.md` entries.** It is the durable record of one long session
(v1667 → v1682) that took the per-item pipeline from "cores built, nothing wired" to "the arc runs".

**State:** `main` @ `855e491`, tree clean, gate **2823/0**, `npm run undef` clean apart from four pre-existing
handler bugs. Every module has importers — there are no orphaned cores left.

---

## 1. What the arc is, and how much of it is REAL

The target workflow, decomposed into the five steps the system now generates for it:

| # | step | clause | status |
|---|---|---|---|
| 1 | get the open warranty tasks | `RIDE_EACH` list read | ✅ **PROVEN LIVE** — 121 divisions → 22 rows |
| 2 | read the instructions on each one | `fieldread` | ✅ **PROVEN LIVE** — 22/22 enriched via the drill |
| 3 | which of those ask for a replacement? | `branch` + PP-5 classify | ✅ **PROVEN LIVE** — 12 · 10 · 0, redacted before egress |
| 4 | look each homeowner up in Shopify | `map` 7-rung ladder | ✅ **PROVEN LIVE** — 20 matched, 2 no-match |
| 5 | create a Shopify profile for them | `write` | ⚠ **BUILT, NEVER RUN** — no create has been attempted |

Trace of record for 1–4: `logs/run/orchard-logs-20260721-225450.txt`.

**The single most important line in this document:** step 5 has never written anything. The next live run is the
first time this system creates a record in someone's Shopify.

---

## 2. Verified live vs built-and-unrun

Keep these apart. Roughly half of what exists has never executed.

**Proven by a real trace:**
- the list → fieldRead → branch → map chain (above)
- `FIELD_READ ▸ composed … → prior` — the composition fix without which branch gets pre-enrichment rows
- PP-5 batched classification **with redaction on the egress** (`BRANCH ▸ classify … — redacted before egress`)
- the run object opening/closing with a verdict; cases materialized (12 done, 10 skipped)
- the **plan gate** — `WORKFLOW ▸ plan approved — 5 step(s)`
- decomposition **with substrate facts**: the same intent went 4 steps → 5, matching the hand-derived answer
- `MAPQ7VALUEZ` in the interpret ask with the real value in `params:{email}` — row values ride as PARAMETERS,
  never into a prompt

**Built, tested, NEVER run:**
- the whole **write clause** (`WRITE ▸`, `UPSERT ▸`, `GATE ▸` lines have never appeared in a trace)
- the **branch narrowing** (single-arm filter → the next step sees only the matched rows) — shipped v1675/v1682
  AFTER the last trace
- **clause-pinned replay** (PP-0c) and its **stale-stop** path — the stale path is the branch most likely to be
  wrong, because it only fires when a catalog changes under a saved workflow
- the **case sidecar** read-back (`PIPELINE_CASES`), and `PIPELINE_OPEN_ITEMS` round-tripping the service worker
- the **INVOKE quiet fix** — needs an extension ↻; the decisions view is still ~98% `INVOKE ▸` noise until then
- the global **redactor toggle** (`settings:redact_pii`, default OFF). PP-5 redacts regardless.

---

## 3. Decisions taken — do not re-litigate these

Each cost real time to reach. The reasoning is in the code comments at the named sites.

1. **Decomposition is PREDICTIVE.** `interpret` is a router ("what is this ONE ask?") and `decomposeAsk` is a
   connective splitter (`and|then|;|,` — no period, no `if`). Neither splits on OPERATIONS. A dedicated prompt
   does. I flipped model-first → deterministic-first → model-first across three versions; all three were answers
   to a badly-framed question. → `Core/stepsPrompt.js`

2. **Model for meaning, CODE for guarantees.** The perspective panel's shape, copied deliberately: code derives
   the parameters and assembles the rules block, the model interprets, code sanitizes immediately after, and
   identity is never model-phrased. → `Core/intentShape.js` is the precedent; `deriveStepSpec`/`buildStepsDirective`
   are the transposition.

3. **The model names steps; it never picks legs or writes parameters.** roles : selectors :: steps : legs. A
   model asked to both name and resolve invents the half it cannot check. `resolveRoles` says "a wrong selector
   is worse than a gap"; here **a wrong leg RUNS**.

4. **Substrate facts beat prompt wording.** The 4-step plan was missing a step because nothing told the
   decomposer that the warranty list carries a per-item `drill`. `Core/groundFacts.js` renders the catalog's own
   declarations as *splitting consequences*. Note the honest limit: `Instructions` is declared NOWHERE, so a
   per-field map would be a lie — the provable fact (*this list HAS a drill*) forces the same split.

5. **The write clause shape is EMPTY.** Target, fields, rows and permission all come from declarations. There is
   no slot a model could fill with an invention. Every other clause got safer by ADDING validation; this one got
   safe by giving the model nothing to say.

6. **`reversible`/`outward` are per-leg OPT-INS, not derived.** Deriving `reversible = !destructive` would make
   every ordinary write auto — the product-wide loosening refused at v1661. Absence means undeclared, and
   undeclared GATES. Currently declared on exactly one recipe: `shopify_create_customer` (user decision).

7. **Two gates, different scopes.** `hintToSafety` is raise-only and still floors every write at `confirm` for
   ad-hoc use; `pipelineGate` has the run/trial/case context and is the only thing that reads the axes. Verified:
   `leg.safety === 'confirm'` while `gateActionForLeg(leg) === 'auto'`.

8. **The duplicate guard re-runs the LOOKUP, not a `basedOn.path`.** A wrong path makes the staleness CAS read
   `undefined` and **fail OPEN** (v1639). `runUpsert`'s `recheck` re-runs the same lookup the map ran and asks
   hit/miss/unreachable. Fails CLOSED: unreachable blocks the row rather than creating it.

---

## 4. The bug classes that recur here

This session hit each of these more than once. They are worth checking BEFORE writing, not after.

| class | count | the check |
|---|---|---|
| **truthy-object coercion** — `String(obj)` → `"[object Object]"`, survives `filter(Boolean)` | 3× (`summarizeItem`, `decomposeAsk`, `joinKey`) | when a helper's return type is not obvious at the call site, **read it**; pin the shape in a test |
| **identifier with no binding** — throws only when that line runs | 3× (`readouts`, `INTENTS`, `_str`, `upsertTally`) | `npm run undef` — it has caught four |
| **disabling a declaration** — `{displayId: null}` reads as "no preference", means "ignore the curated answer" | 2× | a declaration beats a smarter guess; `grep "displayId: null"` |
| **a duplicated rule needs a duplicated fix** | 2× (three copies of "what is this row called") | count the copies before declaring a fix complete |
| **scripted-edit escaping** (`\'`, raw control chars, a replace that silently misses) | 6× | syntax-check EVERY file the script wrote; grep for what should be **gone** |
| **a default is not a runtime value** | 2× | `Logger.#minLevel` defaults to INFO and `background.js:148` sets DEBUG — grep for the setter |
| **hand-built fixtures miss threading bugs** | 2× | for anything crossing declared hops, assert on the FAR END from the REAL source |
| **observability fails at scale first** | 1× | ask of any new INFO line: what does this look like inside a `RIDE_EACH` of 121? |

Two invariants, both earned:
- **Invariant #1 (existing):** a new marker must be ADDED to `_DECISION_RE` or its feature is invisible.
- **Its counterpart (new, v1670):** a marker that fires PER ITEM must not sit in `_DECISION_RE` unsummarized, or
  it drowns the run it belongs to. `INVOKE ▸` put 242 of 246 lines into one decisions view.

---

## 5. Open work, roughly by value

**Immediate — verification, not building.** One live run of the five steps. It is the first write, and it also
first-exercises the narrowing, the case sidecar, and clause pinning. Before it: **reload the extension** (↻) so
the SW picks up the INVOKE fix, or the trace will be unreadable again.

What to look for:
```
BRANCH ▸ narrowed prior → 12 of 22        ← the narrowing (never run)
GATE   ▸ Create a Shopify customer → auto ← the user's declared axes
WRITE  ▸ 12 × shopify_create_customer → N created, … 
UPSERT ▸ item=#… → created | hit(…) | unreachable(…)
```
A row whose required fields do not resolve reports `can't fill` rather than creating a bad record — that is the
expected first-run failure mode, not a bug.

**Known gaps, unbuilt:**
- **PP-5 banking is not persisted.** `bankedVerdict`/`unbankedItems` exist and are tested; nothing writes them,
  so every run re-classifies. Correctness-neutral, one call per run.
- **PP-0d undo legs.** §10.1's rejection path. No Shopify delete leg exists at all. Only needed to REJECT a
  trial, not to run one.
- **The step FLOOR under-reports.** `deriveStepSpec` said 2 where the truth was 5 (`_COLLECTION` wants an
  explicit quantifier; the live sentence carried per-item-ness implicitly). It is a lower bound by design, but
  this loose provides no pressure. The facts carried it instead — consider whether the floor earns its keep.
- **`Services/*` is unchecked by `npm run undef`** — the lexer declines files it cannot vouch for. Those are
  class-heavy and the checker's parser-free scope analysis gives up there honestly.

**Spun off as task chips (real, self-contained):**
- 4 ReferenceErrors in `background/handlers/` (`syncGroundAssetsAfterSave` ×3, `broadcastStorageChanged`,
  `deleteRecordWithSync`) — bare calls to non-exported `background.js` functions from real ES modules.
- `evaluatePredicate` unknown-op + `negate:true` returns TRUE — a fail-open contradicting its own doc comment.
- `add_comment` with `public:true` is outward-facing and sits at single-click confirm; needs a param-conditional
  `outwardWhen` evaluated where bound params exist.

**Found in passing, unfixed:** `ConversationStore.patchMeta`'s allow-list silently drops `summary` and
`resolvedAt`, so `conv.resolvedAt` is never set and every `VITALS_CHANGED` re-patches and re-logs.

---

## 6. Where things live

```
Core/stepsPrompt.js      intent → steps (dedicated prompt, derived params, sanitizer, re-split)
Core/groundFacts.js      the catalog's declarations → splitting consequences for the decomposer
Core/branchClause.js     arm decision, three outcomes (arm | none | unknown)
Core/branchScope.js      the reach adapter — binding granularity + the PRE-CHECK obligation
Core/branchClassify.js   PP-5 batched free-text classification, identity seeded from the record
Core/writeClause.js      the write verdict (empty by design), preflight, tally
Core/writeMap.js         row → create params BY DECLARATION; the proposals half
Core/upsert.js           find/create with three outcomes + the inline re-check
Core/pipelineRun.js      run identity, per-item records, the run VERDICT
Core/pipelineCase.js     the case sidecar (the vitals pattern, not the fan-out)
Core/pipelineGate.js     the pipeline's own gate; reads the leg's declared axes
Core/redact.js           R-1..R-3 — pseudonymize before egress, JSON-aware restore
tools/undef-check/       the no-binding checker (`npm run undef`)
```

Specs: `docs/DESIGN_peritem_pipeline.md` (the ladder, §9's "asserts without having verified", §10's decisions) ·
`docs/DESIGN_llm_privacy.md` §7 (what shipped, and why R-4 defaults OFF).

---

## 7. If you read nothing else

The pipeline computes correctly more often than it presents correctly. Three consecutive live results this
session were **right and unusable** — every row rendered `#01`, the map line buried its answer behind two
lookalike separators, and a failure message named a cause that was false and offered a remedy that could not
work. Where the next step is a human answering "does this look right?", **an unreadable render is the gate
failing open**, because a reviewer who cannot read the evidence approves on trust.

So: when you change what a clause DOES, look at what it SAYS, in the panel, with real rows.
