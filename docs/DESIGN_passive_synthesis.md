# DESIGN — Passive Accretion & Compose-Time Synthesis

**Status:** proposal · design-only · 2026-06-19 (rev: demand-driven harvest) · v2.74.x era
**Relation:** extends `DESIGN_inference_layer.md` (Orchard / loop) and `DESIGN_llm_front_door.md` (ask → select tool). This doc specifies the **generative complement to `matchCapability`**: how Orchard authors a capability on a match-miss instead of dead-ending at "show me," and how the interaction monitor — *targeted by Orchard's own world-knowledge gap-list* — feeds it a passively-grown vocabulary to author *from*.

> One line: **match** handles "I've seen this," **synthesize** handles "I haven't, but I have the vocabulary to build it," **demonstrate** handles "the page is too opaque to infer." This doc adds the middle leg — and lets the user's *ordinary* behavior supply the vocabulary, with no explicit teaching.

---

## 0. Thesis

Two hard problems sit between "watch the user" and "author a capability": **segmentation** (a continuous interaction stream has no natural task boundaries) and **signal-to-noise** (most touches aren't reusable). Both dissolve with two moves.

**Move 1 — decouple capture granularity from composition granularity.** Capture is *pointwise*: each trusted interaction yields/reinforces *one* landmark (a verified anchor — `selector` + a11y `role`/`name` identity). A landmark is a *point*, not a span; there's no boundary to infer. Composition is *deferred to ask-time*: on a miss Orchard reasons "what sequence over these accreted landmarks satisfies the ask?" and emits a draft. You synthesize the *span* from the *points* on demand — never segment history.

**Move 2 — let Orchard's world knowledge generate the demand.** When Orchard answers "what could you do better here?" it enumerates, from world knowledge, the capabilities a page *should* afford (on YouTube: play/pause, scrub, subscribe, captions…). That list isn't a UX nicety — it's a **capability-demand generator**. The user already performs those actions in ordinary use. So Orchard supplies the *targets*; the user supplies the *demonstrations*; the monitor is the bridge. The gap-list is also a **principled noise filter** and a *second* dissolution of segmentation: you no longer cut a stream into tasks, you match observed touches against *pre-labeled intents* — a click on `name="Subscribe"` self-labels against the "subscribe" gap.

**The flywheel:** Orchard enumerates gaps → gaps become monitor harvest-demand → user acts naturally → monitor captures the fulfilling interaction → synthesis trials & promotes it → gap closes → "what can you do" grows and "how could you do better" shrinks. **Self-closing, teach-zero.**

This is "LLM proposes, policy disposes" tightened: Orchard proposes *which gaps to watch for* and *how to compose*, but only over a closed, verified vocabulary that real interaction proved real — it cannot hallucinate a selector — and the trial gate arbitrates every promotion.

---

## 1. Where it stands today (grounded, honest)

Surprisingly little is greenfield. The composition primitive, the trial gate, the landmark model, and a *demand-driven* monitor all exist. The genuinely-new pieces are a per-Ground **gap registry**, a **harvest/retention** change in the monitor, and a **wiring** change in Orchard's miss path.

| Part | State | What's real (file:line) |
|---|---|---|
| **Compose a T1 from page vocab + a goal** | **Built** | `synthesizeCapabilityDraft(goal, locale, opts)` → `{actions:[{action,selector,value}], params, runnable}` — `Core/capabilitySynth.js:63` |
| **Run a draft as a trial → score → accept** | **Built** | `RUN_SG_TRIAL` (tier2 at `sg.js:806`) → `scoreTier2` (`Core/tier2Lower.js:257`, *tier2-pass* = all required phases) → `ACCEPT_SG_TRIAL` (`sg.js:955`) promotes to durable cap + landmarks + alias |
| **Landmark mint + self-heal + `observed` origin** | **Built** | `featureToProtoLandmark` (`Core/landmark.js:45`); `buildLandmarkRecords`/`mintLandmarkUid` (`Core/accept.js:102`) already stamps `source:'sg-accept'\|'observed'`; probe-or-recover `verifyLandmark` (`Services/LandmarkVerifier.js:112`) + `LANDMARK_PROBE_OR_RECOVER` content-script |
| **Page vocabulary (live + durable)** | **Built** | `localeAffordanceLabels(model)` (`Core/orchMatch.js:404`); Perspectives `buildPerspectiveRecord` + dedup `findMatchingPerspective` (`Core/accept.js:329/360`) |
| **Demand-driven monitor (demand → listen → classify → trace)** | **Built** | demand from accepted Perspectives' landmarks `buildInteractionDemand` (`Core/interactionDemand.js:69`); `INTERACTION_RAW` (`sg.js:1441`), value-free `makeRawInteraction` (`Core/interactionCapture.js`), `resolveInteraction` → `hit\|ambiguous\|miss\|suppressed`; ring `_interactionTrace` (`sg.js:79`); consent `canTrack` default-deny (`Core/monitorConsent.js`) |
| **The miss dead-end** | **Built (the gap)** | `_tryIlCommand` (`chat.js:3048`): on `decision:'miss'` → `IL_ANSWER` → "want to show me?" — **no synthesis attempted** |
| **Capability-gap registry (the demand)** | **Not built** | Orchard's "how to do better" enumeration is generated on ask and **thrown away**; nothing persists it or arms it into `buildInteractionDemand` as harvest-demand |
| **Demand-driven harvest + long-tail pool** | **Not built** | `miss`/`unresolved` trusted interactions are **dropped** (only `substrate`-tier flushes, `interactionTrace.js:80`); nothing matches them to open gaps or pools the remainder |
| **SYNTHESIZE leg** | **Not built** | nothing wires `capabilitySynth` → trial gate into Orchard's match-miss |

**The gaps are small and connective.** Persist what Orchard already says, stop dropping the touches that fulfill it, and wire compose→trial into the miss path. Everything between exists.

---

## 2. The pieces

### 2.1 The capability-gap registry — *the demand*

The **inverse of a Perspective.** A Perspective records *what I can do here* (accepted, verified). The gap registry records *what I should be able to do here* — world-knowledge-declared, unfulfilled.

- **Source:** the same enumeration Orchard already produces for "how could you do better?" (today ephemeral — `answerPrompt.js`). Each item: `{ groundId, intent, verbHint, expectedIdentity?, status:'open'|'armed'|'harvested'|'promoted'|'dismissed', seenCount, createdAt }`. `intent` is the semantic label ("play/pause the video"); `expectedIdentity` is Orchard's guess at the fulfilling control's a11y identity (`role~button`, `name~/play|pause/i`) — used to match cheaply (§2.2).
- **Grounding gate (pushback #2).** Orchard *will* hallucinate gaps the page can't fulfill ("download the video"). Before a gap is **armed** as harvest-demand, cross-check it against the live affordance model (`localeAffordanceLabels`) and/or an Orchard "is this plausibly present here?" pass. Ungroundable gaps are recorded but never armed — never set the monitor watching for a fulfillment that can't come.
- **Storage:** `gaps:<groundId>`. Persisted, inspectable, per-Ground clearable (§5).

This makes Orchard's reflective answer *durable and actionable* instead of thrown away — the single change that turns a chat reply into a learning signal.

### 2.2 Demand-driven harvest (primary) + the long-tail pool

**Primary — gap-targeted harvest.** Extend the monitor's demand: `buildInteractionDemand` (`Core/interactionDemand.js:69`) already builds the watch-list from accepted Perspectives' landmarks; add **armed gaps** as a second demand source. When a trusted (`isTrusted`), consent-OK interaction resolves `miss`/`unresolved` (an unknown control) **and matches an open gap**, retain it as a **harvested fulfillment** — the gap's `intent` *labels* the captured landmark identity. No segmentation: the touch self-labels against the pre-declared intent.

**Long-tail — the pool.** Trusted `miss`/`unresolved` touches that match *no* gap append to a low-priority per-Ground **observed pool** (`{ role, accessibleName, kind, verb, seenCount, lastSeq }`, de-duped) — the catch-net for capabilities Orchard never imagined, surfaced only on a later ask-miss. Lower precision, kept cheap. (Keeps Move-1's exhaustiveness without letting it dominate.)

**Capture stays value-free *and* selector-free.** Retain only a11y identity; the privacy invariant — `makeRawInteraction` never carries a typed value — is preserved structurally. The selector is materialized on demand at synthesis via the existing probe-or-recover heuristic (`_findLandmarkCandidatesByDescription` by `role + accessibleName`). Both tiers are **latent** — never run — until a synthesis trial promotes an entry to a verified Landmark.

**The match hop (pushback #1) is the crux.** Deciding "was that click the 'subscribe' gap?" is a semantic call. Keep it cheap: gate it to `miss`/`unresolved` × *open* gaps for this Ground; prefer deterministic `expectedIdentity` matching; fall back to a **batched** LLM match over the pool (never per-event), or the cost balloons. A mis-match only mislabels a candidate — the trial gate still verifies before anything durable exists.

### 2.3 The SYNTHESIZE leg — compose-time, trial-gated

On a match-miss, **before** the `IL_ANSWER` dead-end (`chat.js:3066`):

1. **Gather vocabulary:** live affordances `localeAffordanceLabels(readLocaleCache(groundId).model)` ∪ harvested fulfillments for matching gaps ∪ the long-tail pool, for this Ground.
2. **Compose (Orchard):** reason `(ask, vocabulary, observed-adjacency §4)` → an ordered draft — which anchors, what verb each (CLICK/TYPE/SELECT), which carry a `{{PARAM}}` slot, in what order. `synthesizeCapabilityDraft` driven by Orchard's ordering; the WHERE/verb/param come from the vocabulary, the ORDER from Orchard + adjacency; **no raw-selector invention** (closed vocabulary).
3. **Bind params:** `bindClauseParams({clause: ask, params})` (`AnthropicService.js:2529`).
4. **Trial:** `RUN_SG_TRIAL {tier2:true}` → `scoreTier2`. Runs as a *trial*, not a commit.
5. **Accept on pass:** `acceptEligible` → `ACCEPT_SG_TRIAL` promotes to durable cap + verified landmarks (harvested/observed → `verified`) + alias, and marks the gap `promoted`. **Zero new trust surface** — identical to the demonstration path's accept.
6. **Degrade on fail:** trial fails or vocabulary too thin → today's dead-end ("show me"). Synthesis degrades *into* needs-demonstration (§7).

**Two triggers.** (a) *Reactive* — the user asks; if a harvested fulfillment exists, synthesis is pre-seeded and likely passes first try. Ships first. (b) *Proactive* (later, §8) — a harvested + repeated gap may be offered ("you've subscribed here a few times — save it as a one-click capability?"), opt-in, behind a repetition threshold.

**Read-first / write-confirm.** Synthesis prefers `read`/`extract` shapes (safe to trial). A synthesized artifact whose intent trips the irreversible floor (`_IRREVERSIBLE`, `orchMatch.js:25`) routes through the existing HITL confirm (`decision:'propose'` → "Yes, go ahead", `chat.js:2825`) before its trial *writes*. A Orchard-invented *write* sequence never auto-runs.

---

## 3. The routing change — the third leg

The front door gains one leg. The miss stops being a dead end:

```
ask
 → warm alias (deterministic, instant)
 → matchCapability        ── hit ──▶ judge + run        (I've seen this)
 → SYNTHESIZE (new)       ── pass ─▶ trial + accept     (I can build it from vocabulary)
 → needs-demonstration                                   (page too opaque — show me)
```

Order matters: synthesize is tried **only after** match misses and **only before** demonstrate. It never competes with a real saved capability, and it always yields to a human when it can't compose.

---

## 4. Temporal adjacency as the ordering prior

A bag of landmarks gives WHERE + verb + param-slot but **not ORDER** ("select the category before typing, or after?"). That knowledge lives in observed *sequences*:

- `GET_INTERACTION_TRACE` (`sg.js:1515`) returns interactions ordered by monotonic `seq`, filterable by `groundId`/`tabId`/`sinceSeq`.
- At synthesis, feed Orchard the **observed adjacency** on this Ground (which anchors the user tends to touch in sequence) as a **soft ordering prior** — grounding the WHEN, not just the WHERE.
- A *prior*, not a hard segmentation requirement: Orchard may reorder, and the trial gate is the final arbiter. Re-imports a little of the sequence value Move-1 set aside — deliberately, cheaply.

---

## 5. Privacy & consent posture

This widens *retention* and adds a *declared watchlist*, so the posture is load-bearing. The guards exist; the design **must preserve** them:

1. **Value-free is structural.** `makeRawInteraction` never carries a typed VALUE — only `inputType` + `lengthDelta`, withheld for `sensitive` fields (`interactionCapture.js`). Harvest retains only the a11y *identity* (WHERE/verb), never WHAT was typed. The value is bound at compose-time *from the ask*. **Do not add a value field to the pool or the harvest.**
2. **Consent is default-deny.** `canTrack` is `false` until the user enables Track, per-host excludable (`Core/monitorConsent.js`). Harvest inherits this gate unchanged.
3. **Engine actions never accrete.** Only `isTrusted` (non-`_engineBusyTabs`) touches enter harvest/pool. The substrate's own clicks already drop as `dropped:'engine-run'`.
4. **The gap registry is a declared watchlist — surface it (pushback #3).** "Here's what you should be able to do, and we're watching for you to do it" is *more* intentional than passive pooling. Benign on YouTube (play/pause); on a bank it's a declared watch over your transactions. This is **better for trust if surfaced** — the user sees exactly what's being learned and why — but only if the armed-gap list is **visible and per-Ground revocable**, never hidden. On sensitive Grounds, gap-arming is **off by default** even with global Track on.

---

## 6. Signal-to-noise — the gap registry IS the filter

The earlier hand-waving is now principled: **harvest preferentially what fulfills an armed gap.** A random misclick matches no gap → long-tail pool at most. Tiers, strongest first:

- **Armed-gap fulfillment** — a touch matching a declared, grounded gap. Self-labeled, high-precision, promotable.
- **Repetition** (`seenCount`) — a control touched repeatedly is a stronger candidate than a one-off, in either tier.
- **Novelty** — synthesize only on an actual match-miss; dedup the composed draft vs the library before trial.
- **Legibility gate** — composition quality is bounded by page a11y; icon-only/`<div class="x7">` → thin → decline → demonstrate. Passive-synthesis degrades *exactly where* a human should show it.

---

## 7. Failure & graceful degradation

| Failure | Detection | Behavior |
|---|---|---|
| Gap not groundable on this page | grounding gate (§2.1) | record but never arm; no harvest demand set |
| Vocabulary too thin to compose | Orchard declines / `runnable:false` | fall through to needs-demonstration |
| Composed draft fails trial | `scoreTier2` verdict `tier2-fail` | discard draft; fall through; **never** persist a failed synthesis |
| Selector won't materialize | probe-or-recover `via:'fail'` | drop that step; if draft incomplete → fail → demonstrate |
| Synthesized write intent | `_IRREVERSIBLE` match | HITL confirm before the trial writes (no auto-run) |
| Harvest mislabel | trial verifies before promote | bad candidate fails trial; gap stays `harvested`, not `promoted` |
| Already covered | library dedup pre-trial | route to the existing capability (it was a match-miss false-negative) |

The invariant: **a synthesis that doesn't pass the trial leaves no durable trace** — same safety contract as a failed demonstration.

---

## 8. Non-goals (this iteration)

- **Not** *unprompted* "want me to do X?" the moment you do something. Harvest is latent; the **reactive** trigger (ask-miss) ships first. The **proactive** offer (§2.3b) is gated behind repetition + opt-in and stays parked until reactive proves out. (The intrusive proactive-push UX/privacy tradeoff stays parked — see the IL-2 #3 deferral in `DESIGN_inference_layer.md`.)
- **Not** a replacement for explicit demonstration — it's the fallback *before* it. Demonstration stays the authority for opaque pages and complex orderings.
- **Not** cross-Ground synthesis (T3). First iteration is single-Ground T1, optionally T2 via the existing tier2 path.
- **Not** new raw-DOM execution. Orchard never executes; it composes over verified anchors and the substrate runs them.

---

## 9. Build order (pick-up-able)

Each phase is independently shippable and testable; pure-core phases are `*.test.js` first.

1. **PS-0 — gap registry (pure + persist).** `Core/gapRegistry.js`: derive gaps from Orchard's enumeration, the grounding gate (§2.1), append/dedup/status, serialize to `gaps:<groundId>`. Wire the `IL_ANSWER` handler to **persist its "how to do better" output instead of discarding it.** Pure core + tests. *This is the smallest first slice — it just stops throwing away what Orchard already says.*
2. **PS-1 — param-free single-click harvest (the easy win).** Arm grounded gaps into `buildInteractionDemand`; on `isTrusted` + consent-OK + `miss`/`unresolved` × open-gap-match, retain the fulfillment labeled by the gap intent. **Target the trivial case first: parameter-free single-click UI actions** (play/pause, subscribe, fullscreen) — one landmark, one verb, no ordering, no value. Lowest-risk synthesis, and exactly what a YouTube gap-list is made of. Gate behind a per-Ground arm flag (§5).
3. **PS-2 — long-tail pool (pure + retain).** `Core/observedPool.js` for unmatched `miss`/`unresolved` touches; surfaced only on ask-miss.
4. **PS-3 — SYNTHESIZE handler.** `SYNTHESIZE_CAPABILITY_TRIAL {tabId, groundId, ask, intent}`: gather vocab (live ∪ harvested ∪ pool ∪ adjacency) → Orchard compose → `bindClauseParams` → `RUN_SG_TRIAL{tier2}` → on pass `ACCEPT_SG_TRIAL` + mark gap `promoted`. Returns `{synthesized, accepted, capabilityId?, reason}`.
5. **PS-4 — wire the miss path.** In `_tryIlCommand` (`chat.js:3048`), between miss-detection and the `IL_ANSWER` dead-end, call `SYNTHESIZE_CAPABILITY_TRIAL`; on `accepted` → `_orchRun`; else → existing dead-end. New marker `SYNTH ▸` → **add to `_DECISION_RE` (`studio.js:5888`, Invariant #1).**
6. **PS-5 — adjacency prior** (§4) into the compose prompt.
7. **PS-6 — gap-registry inspector + per-Ground arm/clear + sensitive-Ground default-off** (§5).
8. **PS-7 (later) — proactive promotion** (§2.3b), opt-in, behind repetition.

**Invariant checklist for this arc:**
- **#1** — `SYNTH ▸` → `_DECISION_RE` at PS-4.
- **#2 (and its inverse).** The synthesis *trial* runs through `RUN_SG_TRIAL`, which already busy-marks (`sg.js:806`) — confirm the new dispatch keeps it. But the **harvest path is the documented OBS exception to #2**: it must capture *user* (`isTrusted`) clicks; engine runs are already excluded upstream (`dropped:'engine-run'`), so do **not** busy-mark the harvest — that would erase the signal.

---

## 10. Open questions

- **Gap dedup / lifecycle.** When does an armed-but-unfulfilled gap expire? Merge near-duplicate intents ("subscribe" vs "follow the channel")?
- **`expectedIdentity` reliability.** How often does Orchard's a11y-identity guess match the real control? Tune the deterministic-vs-LLM match split after a live read.
- **T2 synthesis.** When does a miss warrant a multi-fragment compose vs a single T1? Lean: start T1-only; let the tier2 path absorb T2 when Orchard proposes >1 fragment.
- **Pool / gap decay.** TTL entries that never promote, or let `seenCount` + recency rank and cap? (Mirror OUTCOMES decay.)
- **Promotion provenance.** Mark `authoredBy:'synthesis'` vs `'demonstration'` so the flywheel can measure passive-authoring yield and the user can audit "where did this come from?"
- **Adjacency confidence.** How strong a prior is "touched in sequence" really? Needs a live read once PS-5 runs.
