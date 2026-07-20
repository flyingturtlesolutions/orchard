# DESIGN — the per-item CROSS-SYSTEM MAP (`map`), a.k.a. "#2"

Status: **spec** (design-first; nothing built). Diagnosis is live-confirmed across three traces (20/07). This
doc is the executor for a decomposed *"for each `<item>` of a list, run `<read>` on `<another system>` keyed on
`<a field of the item>`"* — the join the fan-out and reduce can't express today.

---

## §0 — The problem, and the evidence

The user repeatedly wants: **"for each open warranty task, look up its homeowner in Shopify."** A per-item
JOIN across two systems — VendorSuite (the collection + the field) and Shopify (the lookup). Three live attempts
mapped the whole failure surface:

1. **`foreach result, use homeowner email to search shopify`** → `isFanoutAsk:false` (no case/analysis target) →
   collapsed to ONE ordinary read. The loop never fired.
2. **`for each open warranty task, open a case and look up its homeowner in Shopify`** → the fan-out fired, but
   `innerDirective(...)` returned **`''`**: the `/\b(in|into)\b.../` strip ate "in Shopify" (a cross-*system*
   target read as a conversation-tail) AND the residual began with the spawn verb "open" → the guard emptied it.
   20 cases spawned richly (`RIDE_DRILL ▸ … × 20`, vendor instructions present — the v1619 drill holds) but ran
   **no per-case action**. The worst outcome: silently did nothing useful.
3. **`for each open warranty task, look up its homeowner in Shopify`** (no spawn target) → routed RIGHT:
   `ORCH_MATCH` miss with the LLM rationale verbatim — *"iterating over multiple warranty tasks and performing
   Shopify lookups, but all candidates … [have no] Shopify integration capability"* — then `INTERPRET_ASK →
   decompose (conf 0.85)`. **The front door already CLASSIFIES this correctly and knows it can't do it.** The
   trace ends at the decompose verdict: nothing executes, because the EXECUTOR for the decomposed clause is what's
   missing.

**Conclusion (the settled diagnosis):** this is NOT a phrasing problem and NOT a lexical-grammar problem. The
fan-out's per-child directive is *same-context-only* by construction (an analysis verb over the spawned record —
`_ANALYSIS`: research/review/draft/summarize). A per-item action that names ANOTHER system is a genuinely
different execution shape. Its home is the interpret/decompose path (already proven to classify it), and what's
owed is one new executor.

---

## §1 — The shape: `map` is a third list-transform

Orchard already has two list transforms in the chain runner (`_orchRunChain`, chat.js):

| transform | trigger | what it does | output → `st.lastValue` |
|---|---|---|---|
| **read** | a connector clause | one leg, one call (or `RIDE_EACH` over a param domain) | the rows |
| **reduce** | `isReduceAsk` (summarize/digest/compare…) | ephemeral workers → synthesize in the parent | the synthesis |
| **fan-out** | `isFanoutAsk` (case/analysis target) | one child conversation per row (persistent) or reduce (ephemeral) | a spawn summary |

**`map` is the missing third:** *one leg on ANOTHER ground, run once per row, keyed on a field of that row, joined
back.* It consumes a list (`st.lastValue`) and produces a NEW list (the joined pairs) that the next clause
consumes — so `map` composes: read → map → (reduce | fan-out | render).

**The clause contract** (what interpret must emit, and the executor consumes):

```
MapClause = {
  kind: 'map',
  collection: 'prior' | { readAsk: string },   // the source list: the piped st.lastValue, or a self-contained read
  itemField: string,                            // the FIELD to pull per row, as the user named it ("homeowner email")
  target: {
    system: string,                             // the OTHER ground/connection ("shopify" / a host)
    readAsk: string,                            // the per-item read, templated on the field ("search Shopify for {value}")
  },
  join: 'table' | 'attach',                     // 'table' = task↔match rows; 'attach' = fold the match into each source row
  cap?: number,                                 // honest ceiling (default the RIDE_EACH window)
}
```

This is a STRUCTURED verdict, not a string — the last trace's `decompose` returned `subAsks: string[]`, which is
too thin (it can't carry `itemField` / `target.system`). §2 addresses how interpret emits the structure.

---

## §2 — Where it lives (three wiring points, no lexical grammar)

The front door already does the hard classification (trace 3). The build is three seams:

**PM-a — interpret emits a `map` verdict.** Extend the `INTERPRET_ASK` contract (`Core/interpret.js`
`normalizeInterpretDecision`, `INTENTS`) with `intent:'map'` carrying `MapClause`. The interpret prompt learns the
shape: a "for each `<X>`, `<read/act>` on `<other system>` using `<X>'s field>`" ask → `map`, with the LLM
extracting `{collection, itemField, target.system, target.readAsk}` ONCE (not per row). Decompose stays the
fallback when the map fields don't resolve.

**PM-b — a `map` clause kind in the chain runner.** `_orchRunChain` gains a `map` branch (beside the connector /
fan-out / nav branches). It reads `st.lastValue` (or runs `collection.readAsk` self-contained, the v1545 pattern),
extracts the field per row (§3), dispatches the target read per row (§4), and sets `st.lastValue` to the joined
rows (§5). Logs one `MAP ▸` line (add to `_DECISION_RE`, invariant #1).

**PM-c — the executor generalizes `RIDE_EACH`.** `RIDE_EACH` (chat.js `_rideEachFanOut` / the each-mode dispatch)
already runs "one leg × N param values → merged group-tagged rows." The per-item map is the SAME executor with two
generalizations: the N values come from **a piped field of the prior read** (not a `resolve` spec's via-read), and
the leg is on **another ground** (the connection palette, cross-ground). Same abort latch, same 16-per-pass window
+ continue, same no-LLM-per-item property. This is the load-bearing reuse: the map is not a new engine, it's
`RIDE_EACH`'s value-source and target-ground made pluggable.

---

## §3 — Field extraction (`itemField`): name → value, per row, deterministically

Each row must yield the lookup value. "homeowner email" → the row's `HomeownerEmail` (or the email in the drilled
`vs_task_contacts` sidecar — the record is already detail-rich post-v1619).

- **Resolve the field PATH once, apply per row.** Mirror `resolveRideParam` (`Core/rideParamResolve.js`,
  `getPath`): the phrase "homeowner email" → a field path on the row shape, resolved ONCE (deterministic
  name-match on the row's keys + its dossier; `_EMAIL_RE`/typed-key heuristics already exist in
  `connectorRender.js` for corrKeys). One LLM assist ONLY if the name doesn't match a key — and it maps
  phrase→path (a field NAME), never sees the values.
- **Apply the path to every row deterministically** (no per-row LLM). A row missing the field → the row drops to
  the "no field" bucket (§7), never a guess.
- **Privacy:** the extracted VALUE is a search parameter to the target system (legitimate — the user asked for the
  lookup), but it must not ride to the LLM. Interpret picks the target leg from the field NAME + intent; the N
  invokes are deterministic. This preserves `RIDE_EACH`'s "interpretation stays with the model, iteration stays
  deterministic" property (`resolveRideParam` header) and keeps map on the right side of the `DESIGN_llm_privacy.md`
  egress boundary. If values ever reach the LLM (a fuzzy match join, PM-6+), the R-1..R-4 redactor pseudonymizes
  first.

---

## §4 — The target read (interpret once, N deterministic invokes)

- **Pick the target leg ONCE.** `target.readAsk` ("search Shopify for {value}") → `INTERPRET_ASK` on the target
  SYSTEM's palette (the connection's legs — `connectorLegsForConnections`/`harvestedRecipeLegs` for that host),
  resolving the leg + which param takes `{value}`. One interpret, cached for the whole map.
- **Invoke per row, keyed on the extracted value.** The RIDE_EACH generalization: substitute each row's field into
  the target leg's chosen param, invoke on the target ground (cross-ground — `_rideDrillLeg`'s ground-by-origin
  resolution, v1619, is the precedent for reaching another ground's leg). Reads only in v1 (§6). Merge into
  group-tagged results, one group per source row.
- **Cross-ground session:** the target ground rides its own session (Shopify's cookie-ride), independent of the
  source ground. A signed-out target → the §7 honest stop (Sign in `<target>`), not a silent empty — reuse the
  CP-4 sign-in recovery (now v1624-clean, owner-supplied retry).

---

## §5 — The join + output

Each output row pairs the SOURCE item with its target MATCH:

```
{ source: { id, label },        // the warranty task's displayId + address (summarizeItem, displayId-aware v1617)
  match:  <record> | null,      // the Shopify customer, or null (no match)
  via:    { system, leg } }     // provenance, display-only
```

- **`join:'table'`** → render a joined table: one row per source item, columns = source identity + match identity
  (+ a "no match" / "N found" cell). The canvas already has a `table` kind (VT-2d) with chip/bar/text cells —
  render there for N>a-handful; thread lines for a few. Untrusted page text → escaped (the injection boundary).
- **`join:'attach'`** → fold the match into each source row (`{...row, _shopify: match}`) and set that as
  `st.lastValue`, so a following clause ("…open a case for each unmatched one") composes. This is the map-feeds-
  fan-out chain.
- The join is `st.lastValue` either way → map is a first-class chain transform, not a terminal.

---

## §6 — Safety + privacy (the hard lines)

- **v1 is READS ONLY.** A map whose target read is a write ("for each task, create a Shopify draft order") is
  REFUSED in v1 with an honest message — the §9 money/inventory line and the write-gate are per-item and the
  blast radius of an unattended N-write map is exactly what HITL exists to stop. A write-map is a later,
  separately-gated primitive (each item parks at the §9 confirm; likely never unattended). State this ceiling in
  the code, don't leave it implicit.
- **No per-item LLM** (§3/§4): interpretation is once-per-map; iteration is deterministic. This is both a cost
  property (24 rows = 2 interprets, not 24) and a privacy property (row values never fan out to the model).
- **Cap + honest** (§8): never a silent truncation.
- **The egress boundary holds:** each row's field value goes to the TARGET system's API (the lookup the user
  asked for) and nowhere else — not to the LLM, not to a third host. `DESIGN_llm_privacy.md`'s R-1..R-4 redactor
  is the backstop if a future fuzzy-join needs the model to compare values.

---

## §7 — Honest failure (surface the gap the front door already computed)

Three failure classes, each with a truthful surface (never a silent no-op — the recurring lesson):

1. **The cross-system capability is absent** (no target leg — trace 3's exact case). The `matchCapability`
   rationale ALREADY says why (*"no Shopify integration capability"*) — today it's buried in the trace. A `map`
   verdict that can't resolve its target leg SURFACES that sentence to the user: *"I can list the tasks, but I
   don't have a Shopify lookup wired yet — connect Shopify or show me the lookup once."* → the §17 forage/teach
   door. This is the buried-rationale fix named in the 20/07 findings DIRECTION.
2. **A row has no field value** → it drops to a counted bucket: *"18 of 24 matched; 3 had no homeowner email; 3
   found no Shopify customer."* Counts, not silence.
3. **A target read errors** (auth / rate / drift) → the CP-4 sign-in recovery for signed-out, a per-row error tag
   otherwise; the map completes the rest and reports the failed count (the RIDE_EACH `→ N ok, M failed` shape).

---

## §8 — Cardinality + budget

- N source rows → N target reads. The RIDE_EACH window governs: 16 per pass + a "continue" (live: 121 divisions
  proved the window). A map over 24 rows runs in ≤2 passes.
- `cap` (default the window; user-overridable "the first 5") bounds the spawn; the render states "N of M" when
  capped.
- The abort latch (`_walkAbortFlag`) threads in — "stop" lands at the next row boundary, same as RIDE_EACH.

---

## §9 — Build ladder

- **PM-0** — pure core: `Core/peritemMap.js` — `parseMapVerdict` (validate/normalize a `MapClause`), `pickItemField`
  (phrase → field-path over a row shape, deterministic + the one-assist seam), `joinRows` (source × match →
  output rows). Tested pure, no I/O. (Mirrors `orchChain.js` / `rideParamResolve.js` purity.)
- **PM-1** — interpret emits `map` (PM-a): contract + `INTENTS` + prompt; the decompose fallback stays. Grade from
  a live `MAP ▸ verdict` line.
- **PM-2** — the executor (PM-b/PM-c): the `map` clause branch in `_orchRunChain`, generalizing the RIDE_EACH
  value-source to a piped field + a cross-ground target leg. Reads only. `join:'table'` → thread lines first.
- **PM-3** — the honest-gap surface (§7.1): a target-legless map speaks the matcher rationale + the teach door.
  (Cheap, high-value — ship close to PM-1 so the feature FAILS honestly before it SUCCEEDS.)
- **PM-4** — the joined-table render on the canvas (§5, `join:'table'` → the `table` kind).
- **PM-5** — `join:'attach'` + composition (map feeds fan-out/reduce): the joined rows as `st.lastValue`.
- **PM-6** — (deferred) fuzzy match (name/address when no exact key), the R-redactor gate; the write-map (separately
  gated, §6).

---

## §10 — What `map` is explicitly NOT

- **Not a fan-out to cases.** "open a case per task" (persistent fan-out) and "look up each in Shopify" (map) are
  orthogonal — you can chain them (map → attach → fan-out over the unmatched), but the map itself spawns no
  conversations.
- **Not a lexical-grammar extension.** `innerDirective`/`isFanoutAsk` stay same-context; map lives in
  interpret/decompose (the layer that already classifies it). Do NOT teach the regex stripper about "in Shopify".
- **Not a write primitive** in v1 (§6).
- **Not per-item LLM.** If a design pulls toward interpreting each row, stop — that's the wrong shape (cost +
  privacy). The value is data threaded into a param, not a prompt.

---

## Appendix — the one-line mental model

`RIDE_EACH` runs **one leg × N values (a param domain) on one ground.** `map` runs **one leg × N values (a piped
field) on another ground, joined back.** Same executor; pluggable value-source and target-ground. Everything else
in this doc is the honest handling around that one generalization.
