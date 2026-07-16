# DESIGN — Target routing: the TR ladder, vocabulary affinity, and the desk membrane

**Thesis.** An ask has two halves — **content** (what to do) and **target** (where it runs) — and Orchard resolves only the first as a first-class problem. Target selection today is a *side effect* of route selection, scattered across ~7 branches with different orderings per path; every routing failure of the 2026-07 passes was a target/ownership mispick, not a capability gap. This spec makes target resolution one explicit, ordered, observable stage — the **TR ladder** — ranked by **derived vocabulary affinity** (never hand-curated keywords), with the **desk** as the primary implicit target and a **membrane** policy for asks that leave a desk's scope.

**Status (v2.74.1546 — TRT-1..6 v1 BUILT, same-day).** `Core/groundVocabulary.js` + `Core/targetResolve.js` (pure, 14 tests) ✓; `TARGET_RESOLVE` handler (sg.js — composes grounds/fingerprints/alias-index/live-origins; caps+alias context cached 60s; ride-leg vocabulary only for the bounded desk/tab grounds) ✓; both front doors resolve + log ONE `TARGET ▸` line per turn (in `_DECISION_RE` + the dev-bridge list) ✓. **Enforced tiers:** TR-1 explicit-named-ground off-tab (confirm-run-there via `_orchRunOnGround`, or the honest gap + Show me; nav-phrasings excluded) and TR-3 exact-alias-elsewhere (via `_tryGlobalMatch`). **§5 membrane** ✓: visitor fence in `_bankCapabilityOutcome`, per-desk adopt counter (`targetVisitor:<convId>`), adopt offer at the 2nd repetition (accept → connections + `patchMeta`; decline → never asks again), forward-only. **Deliberately NOT yet flipped** (graded from live `TARGET ▸` disagreement data, per §9): TR-2 desk-first enforcement (interpret's palette is already desk-scoped — the line records what TR-2 would pick), TR-5/6 affinity-ranked enforcement (logged only), TR-0 consolidation (the existing intercepts ARE TR-0; merging them is churn without new safety), and the §8 legacy-branch collapse. The §6 facade is folded into the handler; extract it when a second consumer appears.

**Neighbors.** `DESIGN_llm_front_door.md` (the routing inversion this constrains), `DESIGN_desks.md` (the unit TR-2 elevates; §2 cases), `DESIGN_connectors.md` (ride/drive/broker legs — the capability classes §6 unifies), `DESIGN_apps_learning.md` §10–11 (the two-tier memory the membrane fences), `DESIGN_injection_boundary.md` (targets are never minted from page content).

---

## §1 — The failure record (why this exists)

Three live mis-routes in two days, all the same class — a deterministically-recognizable ask shape reached the LLM front door, which confidently picked something else:

1. **`dedupe grounds`** → the LLM composed a Zendesk **ticket-merge WRITE proposal** on two real warranty tickets (HITL belt held; v2.74.1541 moved the action to a Studio button).
2. **`foreach division, open new warranty tasks in a new case`** → read as a *schedule* ("Setting the schedule… I didn't catch the interval") — the fused `foreach` missed the quantifier lexicon and the fan-out gate lived behind only one of two front doors (v1543–44).
3. Same ask, post-fix → the **planner** branch dead-ended it (`0 steps`), and the fallback single-match LLM misread "open **new** warranty tasks" as *create tasks* (v1545 routed fan-outs to the chain).

Diagnosis, one level up: each fix patched a branch; none fixed the missing abstraction. There is no stage that answers **"where does this ask run?"** before the branches compete for it — and no trace line that says which one won, so every mispick was a full-trace archaeology session.

## §2 — The model: content ∥ target

Resolve every ask in two coordinates:

- **Content** — the task: verb, object, params, quantifiers, spawn grammar ("in a new case"), cadence grammar ("every 30m"). Owned by the existing comprehension machinery.
- **Target** — the ground(s)/desk/leg it runs against. Owned by the TR ladder (§3), ranked by vocabulary affinity (§4), gated by the orthogonal belts (§7).

Command/spawn/cadence grammar is stripped **before** target scoring (it is content-structure, not site vocabulary — `case` is Orchard's noun, not a site's). The v1544 lesson generalizes: a quantifier prefix belongs to its body; grammar tokens belong to no ground.

## §3 — The TR ladder

Ordered tiers; first tier that produces a candidate wins; ambiguity within a tier → the user picks; every resolution logs one `TARGET ▸` line (§7.3).

| Tier | Name | Candidate set | Run authority |
|---|---|---|---|
| **TR-0** | COMMAND | Deterministic command shapes: `re-teach`, `dedupe`, `sweep every`, fan-out shapes, `canvas:`, `il:`/`tool:` | Not a target question — claimed before the ladder, before any LLM. Non-negotiable (§1 cases 1–2). |
| **TR-1** | EXPLICIT | The ask names a target: site word ("on vendorsuite"), known origin, desk name. Resolved against **known origins only** — never minted from world knowledge or page content (CX-9l). | Authoritative. Target lacks the capability → **honest gap + teach/connect offer** (TR-7 voice) — NEVER silent re-targeting. Runs under the normal ORCH-G gate. |
| **TR-2** | CONVERSATION | The desk's bound connections + active case context (the target-level analog of `_contextDivision`). **Outranks the focused tab** — the desk model makes the panel tab-independent; the live fan-out flows are desk-anchored. Vocabulary affinity (§4) picks the leg *within* the connection set ("division" → vendorsuite leg, "requester" → zendesk leg) with no LLM arbitration. *(FC-4, v2.74.1552 — "active case context" is now CONCRETE: the conversation's FOCUS provenance is this tier's second evidence class — its grounds join the pool, its entity nouns score, `why=focus affinity`. REFERENTIAL asks never reach the ladder at all: the referent stage dereferences them to the entity's home ground and logs `TARGET ▸ tier=TR-2/focus … auto`. Spec: `DESIGN_conversation_focus.md`.)* | Confirm unless promoted; effect gates §7.1. |
| **TR-3** | EXACT MEMORY | The global alias index — a previously-taught phrase runs **where it was taught**. The deterministic flywheel (built; today it only fires per-ground or last-in-line globally). | **Auto** — the one tier with standing run authority (the taught phrase IS prior consent, per ORCH-G). |
| **TR-4** | FOCUSED TAB | The active tab's ground (`_groundIdForUrl`: urlPatterns most-specific → origin). The user's strongest *present-tense* signal for page-referential asks. | Confirm unless promoted. |
| **TR-5** | LIVE SESSIONS | Open tabs / CONN-registry-**fresh** origins whose ground has a matching capability. Replaces the tempting-but-wrong "recently visited tabs" tier: recency ≠ capability — **session liveness** is the operational predicate (a ride leg is only invocable where a signed-in session rides; CP-3 already tracks freshness). | Confirm. |
| **TR-6** | GLOBAL | All grounds, ranked by affinity. 1 hit → confirm-run; ≥2 → the user picks (built: `_tryGlobalMatch`). | Confirm / pick. |
| **TR-7** | TEACH | No target can serve the content: **Show me** (Drive), harvest-or-connect (Ride), connect (Broker), adopt (desk §5.3). | The offer, never a guess. |

Ordering rationale worth recording: **exact memory sits BELOW conversation but ABOVE tab** — an alias is a taught contract and beats present-tense browsing context, but a desk's role-scope is *standing* context the user chose by opening that desk. **Fuzzy** memory ("this kind of task last succeeded on X") is deliberately NOT a tier — it is a ranking signal inside TR-5/TR-6 (§4), because ranking fuzzy history above the focused tab yanks users cross-site on ambiguous asks.

## §4 — Vocabulary affinity: the ranking layer (derived, never curated)

**The idea (user's, 2026-07-16):** "foreach division" should resolve to vendorsuite because that site *has* an explicit division category. Generalized: each ground has a **vocabulary fingerprint**, derivable entirely from what the library already banked —

| Fingerprint source | Example (vendorsuite) |
|---|---|
| Ride leg param schemas (names + hints + enums) | `divisionId` ("the DIVISION — a name…"), `status: new/open/fixed/closed` |
| Leg names / `does` prose | "**warranty** tasks by status", "vendor announcements" |
| Taught walk params + their option vocabularies | `DIVISION` + 61 division names → "Raleigh", "Greensboro" are vendorsuite words |
| Capability intents + aliases | "Search **ticket** by **division**" |
| Read-result field keys | `TicketId`, `TaskNumber`, `ProjectName`, `ClaimNumber` |

**Rules:**
1. **Derived only.** A hand-keyed list is another `_QUANTIFIER`-style lexicon that rots (the `foreach` lesson). The fingerprint rebuilds itself when a walk is taught or a leg harvested (cache per ground; invalidate on capability/leg change via GroundEventBus).
2. **Weight by distinctiveness** (IDF across fingerprints): "warranty"/"division" appear in one fingerprint → strong; "ticket" appears in zendesk *and* vendorsuite → weak, and honestly so — collisions stay ambiguous → confirm/pick, never a guess.
3. **Score content, not grammar.** Strip TR-0/spawn/cadence/quantifier grammar first (§2); exclude Orchard's own nouns (`case`, `desk`, `sweep`) from every fingerprint or every fan-out smells like every ground.
4. **Ranking authority, never run authority.** Affinity picks *candidates*; ORCH-G still decides auto vs confirm. It is a deterministic, zero-LLM, pre-model signal — `TARGET ▸ … (division→vendorsuite)` would have made §1's cases one-line diagnoses.
5. Where it applies: **TR-2** (leg choice within a desk's connections — its highest-value home), **TR-5/TR-6** (candidate ranking), and as the honesty check for the implicit-ask-desk-can't-serve case (§5.4).

**Contract (pure, `Core/groundVocabulary.js`):**
```
vocabularyFingerprint(ground, {legs, capabilities, recentReadKeys}) → { term → weight }
scoreAskAffinity(contentTokens, fingerprints) → [{ groundId, score, matchedTerms }]
```

## §5 — The desk membrane

TR-2 makes the desk the primary implicit target: **an ask typed in a desk resolves first against the desk's connections, tab open or not.** That raises the boundary question — an ask with an explicit target *outside* the desk's connections. Policy: **run it, fence it, offer membership only on repetition** — the *visitor pass*.

### §5.1 It runs — explicit wins
TR-1 is authoritative. No refusal, no "switch desks" friction. Normal global resolution, normal gates.

### §5.2 It runs as a VISITOR — the desk's memory is fenced
The two-tier memory split (DESIGN_apps_learning §10–11) already provides the seam:
- **Ground/capability-level learning still happens** — aliases, capability outcomes, confirmations are ground-scoped; the flywheel warms for next time *anywhere*. Nothing is wasted.
- **The desk-instance memory write is SKIPPED** — the belief write keyed to the desk's `memoryId` doesn't fire for an off-desk target. The desk's learned role stays coherent: its memory describes its work, not errands run from its window.
- **The transcript keeps the turn** (the ledger is honest), tagged off-desk so recall/distill-up exclude it.

**The safety property this preserves: connections are the desk's *autonomous authority boundary*.** Sweeps, routines, fan-outs, seed directives touch connected sites only. A visitor run is human-driven, one-shot, and never silently widens what the desk may do unattended.

### §5.3 The adopt offer — threshold, not per-ask
One stray ask is a one-off; per-ask "add pixabay to this desk?" is nag fatigue that trains dismissal. The **2nd–3rd** off-desk ask to the *same* target from the *same* desk is real role signal → offer **once**, through the existing adopt flow (CP-1):
> "You've used shopify from this desk 3 times — adopt it as a connection? That brings it into the desk's scope: memory, sweeps, routines."

Accepting is the consent moment (scope-widening stays HITL, like every promotion gate). Declining keeps visitor status and stops the counter — it never asks again. Adoption is **forward-only**: previously-fenced turns are not retroactively admitted to desk memory (simplicity; revisit only if a real case demands it).

### §5.4 The inverse case falls out for free
An *implicit* ask the desk's connections can't serve ("how many youtube subscribers…" in the Warranty desk): TR-2 fails honestly (affinity ~0 against the desk's fingerprints), the ladder continues (TR-3+), whatever runs is the same visitor pass — same fence, same counter.

## §6 — The capability facade

The piece that makes TR-1's "does the target have the capability?" checkable *anywhere* instead of per-path:

```
capabilitiesForTarget(groundId) → {
  drive:  [capability…],          // sg capabilities (active, non-orphan)
  ride:   [leg…],                 // harvestedRecipeLegs (armed, fresh)
  broker: [leg…],                 // when connected
}
```
One answer, every tier, every door. Class preference per the router-over-lattice principle: **Ride ≻ Drive for data reads** (credential-free API beats DOM), **Drive for on-page effects** (show/open/act-on-screen), **Broker as reach-extender**. The facade *reports*; preference is applied by the consumer per the ask's effect class.

## §7 — Orthogonal gates (unchanged, restated as ladder invariants)

1. **EFFECT** — reads may auto-run on TR-3 (and promoted TR-2/4); writes always confirm with the exact request shown; **a write never fans**; money/inventory is human-click-only. The ladder resolves *where*; effect resolves *whether unattended*.
2. **TRUST** — targets resolve against known origins only; a domain is never minted; **page-derived content never names a target** (injection boundary). Desk seeds/routines name only connected origins.
3. **TRACE** — one line per turn: `TARGET ▸ tier=<TR-n> target=<ground|desk> why=<matchedTerms|alias|tab|explicit> [visitor(desk=…, nth)]`. Added to `_DECISION_RE` at build time (invariant #1) — this line is the difference between one-glance diagnosis and this week's archaeology.

## §8 — Migration map (which existing branch collapses into which tier)

| Existing (as of v2.74.1545) | Becomes |
|---|---|
| Pre-door intercepts: `re-teach`, `sweep every`, section-show, v1545 fan-out gate, `canvas:` | TR-0 (formalized as ONE claimed-commands pass, not N scattered regexes) |
| `_openRecordOnSite` site-word scoping; `namesAnySite`/`m.otherGround` → `_tryCrossGroundFallback` (today: miss-time) | TR-1 (moved **up-front**; the intercept keeps its record-open specifics, loses private target parsing) |
| Interpret palette's `[TARGET-SITE]` legs (CX-9l) | TR-1 input |
| `_boundConnections()` + the interpret palette's connector legs | TR-2 (+ §4 leg choice) |
| `ORCH_MATCH` alias-exact (per-ground) + `ORCH_MATCH_GLOBAL` alias pass (v1525, today last-in-line) | TR-3 (a global alias index consulted EARLY) |
| `_groundIdForUrl` tab ground → tab-scoped `ORCH_MATCH` | TR-4 |
| `pickRideTab`, CONN registry freshness (CP-3) | TR-5 |
| `_tryGlobalMatch` / `ORCH_MATCH_GLOBAL` (1→run, ≥2→pick), `GET_CAPABLE_SITES` | TR-6 |
| `_orchOfferRecord` (+ v1540 retire-on-replace), harvest/connect offers, CP-1 adopts | TR-7 |
| **Unchanged**: ORCH-G three-way gate, HITL write belts, injection boundary, the v1166 inversion for *content* interpretation (the LLM keeps world-knowledge interpretation of WHAT; it loses unilateral authority over WHERE) |

**Two front doors, one resolver.** Both the default (LLM) door and the `tool:` cascade consult the SAME resolver before dispatch. The LLM door passes the resolved target into interpret (constraining its palette); the cascade replaces its per-branch target logic with tier lookups.

## §9 — Build path (shadow-first; observability before behavior)

- **TRT-1** — `Core/groundVocabulary.js` (fingerprint + affinity, pure + tested) and `capabilitiesForTarget` facade (sg.js, read-only composition of existing reads).
- **TRT-2** — `resolveTarget(ask, ctx)` pure resolver over the facade + fingerprints, run in **SHADOW MODE**: both doors log `TARGET ▸ (shadow)` with what the ladder *would* pick; zero behavior change. Compare against live routing for a few passes — the disagreements ARE the bug list.
- **TRT-3** — flip TR-0/TR-1: commands one pass; explicit targets resolved up-front (authoritative; honest-gap on no-capability).
- **TRT-4** — flip TR-2/TR-3: desk-first + global alias index early. The tab demotes to TR-4.
- **TRT-5** — the desk membrane: visitor fence on the `memoryId` write + off-desk transcript tag + adopt counter → CP-1 adopt offer.
- **TRT-6** — collapse the legacy per-branch target parsing; TR-5/TR-6 ranking by affinity; retire the shadow tag.

Each slice lands behind the trace line first — the `TARGET ▸` disagreement log is the acceptance test.

## §10 — Open questions

1. **Fan-out grouping semantics** — "foreach division, open new tasks in a new case": per-task cases (the built per-item shape) vs one case per division holding its tasks. A product call to make from a live run; orthogonal to targeting.
2. **Preset vs instance fingerprints** — does a desk PRESET ship a seed fingerprint (its object model's nouns) that the instance's connections then sharpen? (Likely yes — cheap and helps a fresh desk.)
3. **Visitor-run alias asymmetry** — a visitor run records a ground-level alias; typing the same phrase later in the SAME desk will TR-3-hit and run again as a visitor. Correct (the fence holds), but confirm the adopt counter increments on alias-hit visitor runs too, or repetition never triggers the offer.
4. **TR-5 candidate cost** — scoring N open tabs × fingerprints per ask is cheap (local, lexical), but bound it (open tabs only, not history).
