# Monitoring Phase — Status & Plan

*The **interaction-monitoring (Track)** phase: the deterministic sensor that turns the authored substrate into a live, classified evidence stream. Snapshot as of **v2.74.892** (originally drafted at .855; the ✅/⏳ sections below are updated through C4).*

---

## Where this sits — the main direction
The project's end-target (`DESIGN_user_intent_inference.md` §12) is **"substrate for a probabilistic agent that acts via deterministic operations."** The runtime is a three-tier **consent ladder**, each a phase:

- **Track** — *this phase*. Capture → resolve → classify → record **user interactions** against substrate. The deterministic **sensor**.
- **Interpret** — the inference engine. Subscribes to the classified stream (never re-parses DOM), maintains a **belief distribution over accepted Perspectives** + an `ActivityDescriptor`. Hot local <50ms / warm periodic LLM / cold offline.
- **Act** — entropy-gradient triggers: new `InterpretationMatcher` time-nodes (`confidenceAbove`, `entropyBelow`, `stableForMs`) fire **deterministic Workflows** when uncertainty collapses, threshold scaled by side-effect class.

Monitoring answers **"what happened, on what referent, with what label?"** — **not** "what is the user trying to do" (that's Interpret). It is the **explicit prerequisite** for the whole reactive arc: nothing in Interpret/Act exists until the classified stream does. Division-of-labor framing: the model can't natively be the **always-on sensor** — that sensor is project-only, and it is this.

## Authoritative specs (NOT in the app repo)
The app repo's `specs/` is a subset. The authoritative tree is the sibling **`…/2026_projects/docs/orchard/specs/`**:
- **`DESIGN_interaction_monitoring.md`** — phase requirements (4 layers L0–L3, slices C0–C6). Status: *design lock for v1*. Dated 2026-05-26.
- **`SPEC_INTERACTION_CLASSIFIER_C0.md`** — the L2 classifier (C0) implementation spec.
- **`DESIGN_user_intent_inference.md`** — the Phase-C consumer (Interpret/Act); monitoring's downstream. Status: *design lock, not implemented*.

## The pipeline (L0–L3) ↔ slices (C0–C6)
| Layer | Module | Output | Slice |
|---|---|---|---|
| **L0 Capture** | `InteractionCapture` (content script + bg) | `RawInteraction` | C1 (demand registry), C2 (listeners) |
| **L1 Resolver** | `InteractionResolver` (new) | `ResolvedInteraction` | C3 (`RESOLVE_INTERACTION_TARGET` reverse hit-test) |
| **L2 Classifier** | `InteractionClassifier` (pure) | `ClassifiedInteraction` | **C0** |
| **L3 Recorder** | `InteractionTrace` + outcomes adapter | append-only trace | C4 (pipeline), C5 (`op:'user-interaction'` + viewer) |

Invariants: **L2 is pure** `(ResolvedInteraction, Context) → ClassifiedInteraction` (no DOM/chrome/LLM). **Demand-driven**: listeners attach only for landmarks in *accepted* Perspectives. Bounded vocab (`tier ∈ {substrate, browser, unresolved}` + `semanticVerb` enum). No LLM on the hot path; <50ms.

---

## ✅ Completed — C0 + C1
- **C0 (L2 classifier)** — `Core/interactionClassification.js` (+ `.test.js`). **Conformance-audited against `SPEC_INTERACTION_CLASSIFIER_C0.md` §2–§10: FULLY CONFORMANT** — all 8 exports + constants; decision tree §4 in order line-for-line; `semanticVerb` algorithm + role map; scoring (+1000 active / +0–300 selector / +0–100 confidence / +50 recency, tie-break by `landmarkUid`); `ClassifiedInteraction` output + `page` enrichment; dependency rule (imports only `Core/outcomes.js`). Green in the Core suite. **DORMANT** — nothing produces a `ResolvedInteraction` to feed it yet.
- **C1 (InteractionDemand registry)** — `Core/interactionDemand.js` (pure) + `GET_INTERACTION_DEMAND` handler — `5dbbf63` (v2.74.856). `buildInteractionDemand(perspectives,{groundId,reason})` → demand rows (one per landmark, kinds unioned, sorted); role→kinds map covers Layer-2 *and* a11y roles; handler reuses `listLandmarksForGround` (accepted Perspectives × registry). +11 tests. *Note: C1 emits the demand SET; it does not itself feed C0.*
- **C2a (pure capture core + sink)** — `Core/interactionCapture.js` + `INTERACTION_RAW` handler — `52b2d66` (v2.74.857). `makeRawInteraction` shapes/validates the §4.2 record with the **privacy invariant enforced structurally** (NEVER a typed value — only inputType + lengthDelta, lengthDelta withheld for sensitive fields); `domEventToKind`, `isSensitiveTarget`, `toCaptureTargets` (enrich C1 demand with selectors). The `INTERACTION_RAW` background sink shapes incoming events + stamps url/id from the SENDER. +12 tests. **Dormant** until C2b feeds it.
- **C6-core (Track consent gate)** — `Core/monitorConsent.js` + `GET/SET_MONITOR_CONSENT` — `3810f7f` (v2.74.858). DEFAULT-DENY: `canTrack(consent,{host})` false unless explicitly granted (scope `all`|`hosts`); `withTrack` pure updater; persisted (`monitor:consent`). +7 tests. C2b's capture START gates on `canTrack`. *Landed before the live listeners so capture can never run without consent.*
- **C2b (live capture listeners) — VERIFY-LIVE** — `ContentScripts/contentScript.js` capture block + `INTERACTION_MONITOR_START/STOP` — `244405c` (v2.74.859). Inert-by-default delegated capture-phase listeners, demand-scoped (`closest(selector)`), VALUE-FREE descriptor (type = inputType + length-delta only, withheld for sensitive). START is the consent chokepoint (`canTrack(host)` before any listener attaches). Reuses the tested cores; both files syntax-clean. **Needs a live browser run to confirm the DOM capture actually fires.**
- **C3 (L1 reverse resolver)** — `Core/interactionResolve.js` + `INTERACTION_RAW` upgrade — `c482ca2` (v2.74.860). `resolveInteraction(raw,…)` → §5.2 `ResolvedInteraction`: dedups matches, sets resolutionStatus (suppressed/miss/ambiguous/hit), enriches with perspectiveId/role/confidence, carries groundId + live `activePerspectiveIds`. The content-script match (C2b) IS the hit-test, so no re-resolve; per-tab session map resolves the Ground without a per-event `getAllGrounds`. +9 tests **incl. an integration test proving a resolved hit classifies as `substrate` via C0** (the C3→C0 contract). *The classifier is now FEEDABLE.*
- **All four reuse dependencies exist** (the monitor consumes, doesn't reinvent): `PerspectivePredicates.listActivePerspectives` (active-perspective context), `GroundMatcher.matchGroundForUrl` (`groundId` from URL), `LandmarkResolver`/registry (forward selectors for the reverse test), `Core/outcomes.makeEvent` (recording).

## ✅ Landed after the original snapshot (.855 → .892)
- **C6-UI** — Track-consent toggle (settings/Studio) + the `SET_MONITOR_CONSENT` crash fix and START's ensure-content-script heal (the 2026-06-08 23:33 trace bugs). Live: every recent trace shows `INTERACTION_MONITOR_START: … consent ok, started=true`.
- **C2b/C3 LIVE-VERIFIED** — capture sessions start against the registry demand set (`from 7/7 registry landmark(s)`) after the landmark-registry write/read fix; the resolve path runs per event in `INTERACTION_RAW`.
- **C5-feed** — live interaction feed card on the Ground side panel (`INTERACTION_FEED` broadcast) + the landmarks/monitoring registry card.
- **C4 — classify + RECORD (v2.74.892)** — `Core/interactionTrace.js` (+ `.test.js`): pure session ring (cap 500, monotonic `seq` across trims, snapshot filters tabId/groundId/sinceSeq/limit, traceStats). `INTERACTION_RAW` now appends the FULL `ClassifiedInteraction` per event (was C4-lite: classify → keep only tier/verb for the feed → drop); `GET_INTERACTION_TRACE` reads the stream. The `INTERACTION` log line carries the trace seq (`#N`). **This completes L0→L3** — the classified stream Interpret subscribes to EXISTS. In-memory v1: cleared on a SW restart; durable persistence = C5's outcomes adapter.

- **C5-outcomes — durable usage signal (v2.74.893)** — `'user-interaction'` joined the OPS enum; `Core/interactionTrace.eventsFromEntries` AGGREGATES substrate-tier entries per (groundId, landmarkUid, verb) into ONE runtime OutcomeEvent each (count + ts span; lifts the primary's perspectiveId so perspective-usage rollups see real activity; browser/unresolved tiers stay in-memory only). `sg.js _flushInteractionOutcomes` batches: every 25 interactions (fire-and-forget after the `INTERACTION_RAW` ack — chrome.storage is never written per keystroke) + force-drain on `INTERACTION_MONITOR_STOP`; high-water mark = the trace seq, so a SW restart loses at most one unflushed batch. Logs `INTERACTION_OUTCOMES ▸ flushed N…`.

- **C5-viewer (v2.74.894)** — "Session trace" inspector inside Studio's Live-monitoring card (settings): expand-to-load + Refresh over `GET_INTERACTION_TRACE` (last 50, newest first — seq, time, verb, tier, landmark, ground) with the ring stats line (`N/cap recorded — substrate n, …`), so "is the recorder running?" is answerable at a glance.

## ⏳ Outstanding — live run only (the Track BUILD is complete)
- **Live verification of C4/C5** — turn monitoring on, interact on a Ground with accepted Perspectives, then: (a) Studio ▸ settings ▸ Live monitoring ▸ Session trace shows entries + stats; (b) the full log trace shows `INTERACTION … #N` seq stamps; (c) after ~25 events or a STOP, `INTERACTION_OUTCOMES ▸ flushed …` and `op:'user-interaction'` events in the Ground's outcomes stream. NB per-event `INTERACTION` lines log on the `monitor` channel at INFO and are NOT in `_DECISION_RE` (by design — they'd flood the signal-only view); use the FULL trace download.
- *(Above this phase: Interpret + Act — the inference engine. Now UNBLOCKED: the classified stream exists, durable, with a viewer.)*

**One-line state:** **the Track phase build is COMPLETE** — L0 → L3 wired, durable, and inspectable (C1 demand → C2b consent-gated capture → C2a shape → C3 resolve → C0 classify → C4 record → C5 outcomes flush + viewer); remaining: a live run to verify C4/C5, then the phase hands off to Interpret.

---

## C1 — scope (SHIPPED, `5dbbf63` / v2.74.856)
**Goal:** produce the **demand set** — *which landmarks to watch, and for which interaction kinds* — derived from a Ground's **accepted** Perspectives. This is the gate that makes capture demand-driven (perf bound = |demand set| per tab, not |all DOM|), and the policy home for "accepted Perspective → what we watch."

**Data contract** (spec §4.3):
```ts
type InteractionDemand = {
  groundId: string;
  landmarkUid: string;
  interactionKinds: string[];                 // e.g. ['click'] or ['type','focus']
  reason: 'accepted-perspective' | 'explicit-opt-in' | 'debug';
};
```

**Build it the GA/EX/G1 way — pure core + thin handler + tests:**

1. **Pure** `Core/interactionDemand.js`:
   ```js
   export function buildInteractionDemand(perspectives, { groundId, reason = 'accepted-perspective' }) → InteractionDemand[]
   ```
   - Input: normalized accepted Perspectives, each exposing its landmark composition as `{ landmarkUid, role }[]`.
   - Per landmark, emit a demand row with `interactionKinds` from a **role → kinds map (DATA, not LLM)** that mirrors the classifier's `ROLE_SEMANTIC_VERB_MAP`:
     `search-query|email-input|quantity-input|password-input → ['type','focus']`;
     `search-submit|primary-action|secondary-action|add-to-cart|result-link|navigation-link → ['click']`;
     unknown role → **`['click']`** (most interactions). A form-container landmark adds `'submit'`.
   - **Dedup by (groundId, landmarkUid)** — a landmark in two accepted Perspectives → one row with **unioned** kinds.
   - Deterministic: sort rows by `landmarkUid`. Pure — no `chrome`, no `Services/*` (testable like `outcomes`/`interactionClassification`).
2. **Handler** `GET_INTERACTION_DEMAND` (background): read the Ground's **accepted** Perspectives + their landmark composition (reuse the perspective store + `LandmarkResolver`/registry), normalize to `{landmarkUid, role}[]`, call `buildInteractionDemand`, return `{ success, demand }`. The storage-shape→normalized adapter is the only impure glue.
3. **Tests** `Core/interactionDemand.test.js`: search-query+search-submit perspective → `['type','focus']` + `['click']`; landmark in two perspectives → one merged row; unknown role → `['click']`; reason default + passthrough; empty/malformed → `[]`; determinism.

**Out of C1 (boundaries):** no listeners (C2), no capture/`INTERACTION_RAW` (C2), no resolution (C3), no pipeline (C4), no outcomes (C5), no consent UI (C6). C1 emits the demand **set** only.

**Why C1 first:** pure + testable (ships safely like the GA/EX/G1 bricks); reuses the existing perspective + landmark stores; and is the precondition every downstream slice reads — C2 attaches listeners to it, C3 scopes its reverse hit-test by it ("bounded by |demand set|", §5.3). **Note:** C1 does not itself feed C0 — the first live `ResolvedInteraction → classifyResolved` happens at **C3/C4**; C1 is the registry that makes that capture targeted and cheap.

## Open decisions (spec §12 — resolve as the slices land)
tab- vs session-scoped trace on same-Ground tab switch · iframe events (v1 top-frame + known `iframeContexts`?) · shadow DOM (composed path vs miss) · navigate-without-landmark (browser tier only, or also emit page archetype?) · max demand-set size before sampling.
