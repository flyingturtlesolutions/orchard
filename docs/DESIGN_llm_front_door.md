# DESIGN — LLM Semantic Front Door (router over deterministic tools)

> Status: **proposed** · Author: design pass + deep-research synthesis · Supersedes the deterministic
> `orchComprehend → orchRoute → orchBind` chat front door.

## 1. Problem

The chat entry is a **deterministic comprehension pipeline**: `orchComprehend` (substrate-free shape
decomposition; the LLM is only an *escalation fallback*) → `orchRoute` → `orchBind` (match to saved
capabilities) → `orchRun`, plus a cross-site "workflow" path for compound asks.

It **under-uses the LLM at the one place it is strongest — interpretation + world knowledge.** A trivial
ask any LLM trivially understands — *"go to pixabay home page"* — falls through deterministic
comprehension, fails to bind to a page capability, and **mis-escalates** to the cross-site workflow path,
surfacing mismatched candidates ("Search for videos", duplicated). Every ask pays the full
comprehend→route→bind→workflow tax, even trivial ones.

**Framing (the user's, validated):** the chat is the *semantic surface* (the LLM's job); the T1–T3
artifacts are *tools* (deterministic execution). The fix is to **invert control**: an LLM front door
interprets the ask and **selects + parameterizes** a deterministic tool — it never touches the DOM.

## 2. Verdict — this is validated prior art (not a novel risk)

- The inversion is the canonical **routing/dispatcher** pattern: *"Routing classifies an input and directs
  it to a specialized followup task,"* and *"add multi-step agentic systems only when simpler solutions
  fall short."* — Anthropic, *Building Effective Agents* (primary).
- The **alias flywheel is almost exactly Stagehand's production caching** (Browserbase, primary): the LLM
  comprehends an action **once** cold; the system caches the **grounded selector/params** (not the
  reasoning trace, not secrets) and replays with **no LLM, no token cost** thereafter. Their `ActCache`
  (single resolved selector) ↔ our **T1 fragment**; `AgentCache` (step sequence) ↔ our **T2/T3**.
- **Caveat:** pure "routing" only *dispatches*; it does not parameterize args or decompose. Our contract
  (`tool + params + needs_decompose`) is broader = native **tool-calling / orchestrator-workers** on top
  of routing. So routing validates "select one path"; parameterize + decompose need tool-calling.

**Where the direction is RIGHT:** cold interpretation, world knowledge, gap-detection, parameterization.
**Where it OVER-GENERALIZES** (keep these deterministic): (a) letting the LLM emit raw DOM, (b) skipping
the trial gate on LLM selections, (c) routing *warm/known* asks through the LLM (waste).

## 3. Target architecture

### 3.1 Front-door contract (one constrained/structured LLM call)
```
route(ask, pageContext, retrievedTools) →
  { tool, params, confidence, needs_decompose, needs_demonstration }
```

### 3.2 Routing cascade (strict, cheapest-first)
| Tier | Stage | LLM? | Orchard mapping |
|---|---|---|---|
| 0 | **Exact-alias short-circuit** | none | `ORCH_RECORD_ALIAS` flywheel → `REPLAY_SG_CAPABILITY` |
| 1 | **Tool retrieval** (small candidate set) | none | reframe `orchBind` as a *retriever*, not a binder |
| 2 | **LLM select + parameterize** (small/fast model) | 1 call | new router → emits the contract |
| 3 | **Decompose** (only if `needs_decompose`) | strong model, plan **+ replan** | gate the cross-site path here |
| ✓ | **Trial / verify** — bounds *every* cold selection | — | `RUN_SG_TRIAL` → tier2 → `ACCEPT_SG_TRIAL` |

### 3.3 Tool palette (the LLM's action space)
Saved capabilities (as callable tools) **+** primitives (`OPEN_URL`, `CLICK`, `TYPE`, `SCROLL`, `EXTRACT`)
**+** a `demonstrate` tool (gap branch → "show me"/record) **+** a `decompose` tool.
- *"go to pixabay home page"* → router picks `OPEN_URL` with world knowledge. Done. No comprehend/bind/workflow.
- **Do NOT dump all capabilities in the prompt** — prompt bloat *degrades* selection. Retrieve a small
  candidate set first (tool-RAG). Retrieval >3×'d accuracy in the cited test (13.62%→43.13%) **but only to
  ~43% absolute** → the trial gate stays mandatory. Tool definitions deserve as much prompt-engineering as
  the main prompt (ACI design). [RAG-MCP arXiv 2505.03275; Anthropic; Gorilla NeurIPS 2024; ToolLLM ICLR 2024]
- Scales to large palettes **via retrieval** (Gorilla 1.6k, ToolLLM 16k, AnyTool 16k), but **retriever
  quality is the bottleneck** — a weak retriever *hurts*. Keep the exact-alias short-circuit + trial gate
  as the safety net for retriever misses.

### 3.4 What to cache (warm path)
The **grounded** landmark/selector/params — **never** the reasoning trace, **never** secrets. Key =
`sha256(normalized-ask + page-state fingerprint)` with a **fuzzy** equivalence threshold (exact DOM-hash is
too brittle; randomized/over-parameterized URLs defeat normalization). [Stagehand]

### 3.5 Verification loop (the load-bearing safety pattern)
LLM proposes → **trial** → tier2 score → accept. On landmark drift, **don't force the cache**: probe-or-
recover; else treat as a **miss**, re-run the LLM, write a fresh entry. *"A wrong cached click is worse than
a slow click."* Agents must get ground truth from the environment each step; **pause for human confirmation
before irreversible actions** (submits/purchases/deletes). [Stagehand; Anthropic]

### 3.6 Model tiering
- **Tier-0** deterministic alias — no model.
- **Tier-1** small/fast model (Haiku-class) — single-tool select + parameterize over the retrieved set (the
  common cold case). Constrained/structured decoding to the tool schema + retry/repair.
- **Tier-2** stronger model — only for ambiguous grounding or `needs_decompose`. Use **plan-and-replan**,
  not interleaved ReAct (LLMCompiler won ~3.7× latency / 6.7× cost / ~9% accuracy on parallelizable
  tasks — but up-front plans are brittle in dynamic web settings, so allow replanning + keep the
  per-substep trial gate). [LLMCompiler ICML 2024; arXiv 2505.08477 / 2509.03581]

> **Status (v2.74.956-.958):** R-4 wired (head nav fast-path + T3X decompose gate + dead-end full dispatch; all replays confirm-first). R-5 closed (palette carries `reversible` via the one toCandidate deriver; router prompt marks [IRREVERSIBLE]; dispatcher uses the can't-be-undone confirm). R-6: Tier-0 = the cascade placement (alias/ORCH_MATCH run before any router call); Tier-1 = routeAsk on MODEL_FAST; Tier-2 = the existing ORCH_PLAN/chain machinery on the complex branch (the plan-and-replan A/B stays an open spike); §3.4 cache = ROUTE_ASK's decision cache (ask+ground+fuzzy pageKey, 5-min TTL, never caches the miss class). R-7 (retire orchComprehend/orchRoute) gated on live proof of this path.

## 4. Migration (keep / demote / delete)
- `orchComprehend` (substrate-free decomposition) → **delete/demote** — root cause of the mis-escalation.
- The LLM → **promote** from escalation-fallback to **primary cold-path router**.
- `orchBind` → **keep, reframe** as the tool-retrieval stage feeding the LLM a small candidate set.
- `orchRoute` → **subsumed** into the LLM's tool selection.
- Cross-site workflow / T3X → **keep, but gate** behind `needs_decompose=true`.
- Alias flywheel + trial/verify gate → **keep verbatim**.

## 5. Top risks + mitigations
1. **Prompt injection (#1).** Every webpage is an attack vector; Anthropic's best layered defenses still
   leave **~1% residual** attack success ("meaningful risk… no browser agent is immune"; OpenAI: "may never
   be fully solved"). Classifiers alone are insufficient. Mitigations: the **fixed-palette design is a real
   structural win** (the LLM never free-types DOM from page content), **but** it does NOT stop injection that
   manipulates *which* tool/params get selected → **isolate untrusted page content from the router's
   instruction channel** (dual-LLM / CaMeL-style privilege separation) + **human-in-the-loop for irreversible
   actions** (non-optional). [Anthropic *Prompt Injection Defenses* Nov 2025; Willison/CaMeL; OWASP]
2. **Over-trust (#2).** The LLM **never** guess-and-clicks; it only selects + parameterizes grounded tools,
   and the **trial gate bounds every cold selection**. Never skip it.
3. **Cost/latency (#3).** Warm short-circuit (0 LLM) + tool-RAG (>50% prompt-token cut) + model tiering +
   "add complexity only when simpler solutions fall short."

## 6. Open questions (need our data, not more reading)
1. **MV3 injection-isolation boundary** *(highest-risk, unresolved)* — landmarks are derived *from* page
   content, so how do we guarantee untrusted DOM text can't steer the router's tool/param choice?
2. **`confidence` threshold** for route-vs-trial-vs-ask — needs an empirical sweep on *our* palette
   (cited work tops out ~43% absolute selection accuracy; no portable threshold).
3. **Train a domain retriever** (S-BERT-style, ~2× NDCG@1 over off-the-shelf at 16k tools) **vs** off-the-
   shelf embeddings + alias + gate — crossover palette size unknown.
4. **Plan-and-execute vs incremental** for cross-site — A/B on real asks (web is the dynamic setting where
   static plans are documented to be brittle).

## 7. Implementation slices (subtractive-leaning)
- **R-1** — `Core/route.js` (pure, tested): the cascade decision + contract shaping (alias-hit → retrieve →
  LLM-select → trial → demonstrate/decompose). LLM + retriever injected. Unit-tested.
- **R-2** — tool-RAG: index saved capabilities + primitives; `retrieveTools(ask, k)` → small candidate set.
  Reframe `orchBind`.
- **R-3** — `AnthropicService.routeAsk(...)`: the Tier-1 structured-output router (constrained to the tool
  schema, retry/repair).
- **R-4** — wire the cascade into `chat.js` entry; dispatch to existing handlers (`OPEN_URL` /
  `REPLAY_SG_CAPABILITY` / `RUN_SG_TRIAL` / demonstrate / decompose). Demote `orchComprehend`.
- **R-5** — injection isolation + HITL gate before irreversible actions *(do early — highest risk)*.
- **R-6** — warm-path cache key (normalized-ask + fuzzy page fingerprint) + model-tiering wiring.
- **R-7** — retire `orchComprehend` / `orchRoute` dead code once the new path proves out.
- **Spikes** — confidence-threshold sweep · retriever train-vs-offshelf · planner A/B (the open questions).

## 8. Sources (verified, 23/25 claims confirmed)
- Anthropic — *Building Effective Agents* (routing, ground-truth, start-simple). **primary**
- Browserbase — *Stagehand caching* (cache grounded selector, fuzzy-validate, miss-on-drift, no-LLM-on-hit). **primary** (vendor; mechanism corroborated, speedup figures NOT relied on)
- Anthropic — *Prompt Injection Defenses* (Nov 2025; ~1% residual). **primary**
- RAG-MCP (arXiv 2505.03275) — retrieve-then-select beats dump-all. **primary**
- Gorilla (NeurIPS 2024) / ToolLLM (ICLR 2024) / AnyTool (ICML 2024) — retrieval scales tool selection; retriever quality is the bottleneck. **primary**
- LLMCompiler (ICML 2024, arXiv 2312.04511) — planner vs ReAct. **primary**
- **Killed (do not rely on):** "classifiers are Anthropic's primary injection defense" (0-3); "hierarchical retrieval beats static RAG by +35%" (0-3).
- **Evidence gap:** OpenAI Operator/CUA, browser-use, Skyvern, WebVoyager, LaVague, MultiOn yielded no *surviving verified* claims in this batch — absence of evidence, not disagreement.

---

## 9. Reconciliation — the IL stand-in divergence + the *interpret* tier (v2.74.1167, 2026-06-24)

> Status: **target**, supersedes the §3 sketch where they conflict. Written after live testing exposed that the
> shipped front door diverged from its own spec. The §1–§8 research stands; this section is the corrected target
> + the migration from where the code actually is.

### 9.1 What shipped vs what §3 specced (the divergence)

§3 specced **one constrained LLM call that selects + parameterizes over a *retrieved* set** (Tier-1), with
`orchBind` reframed as a *retriever*. What actually shipped (the IL stand-in, `Core/ilStandin.js`, .1118→.1167)
is different in a way that matters:

- The **primary selector is `ORCH_MATCH`** — the *deterministic* substrate matcher — run **first, as a gatekeeper**.
- The **LLM only JUDGES** (`JUDGE_MATCH`) among what ORCH_MATCH already surfaced, or — on a miss — is demoted to a
  **greedy classifier** (`ROUTE_ASK` extracts `{tool,params}`), or finally a **prose answerer** (`IL_ANSWER`).

Net: the model never *interprets the whole ask as the first move*. It judges, classifies, or answers — three
narrow roles at three points, because no single call has the full context to reason. This is **reasoning-last**,
the opposite of §1's framing ("the chat is the semantic surface — the LLM's job"). The live failure that exposed
it: **`if go to youtube` navigated.** `_NAV_RE` correctly declined (good), ORCH_MATCH missed, and the miss-branch
`ROUTE_ASK` — a classifier, not a reasoner — extracted `OPEN_URL youtube.com`, *dropped the "if"*, returned it
**confident**, and `_dispatchRouteDecision` navigates a confident primitive **with no confirm**. Nothing in the
path ever read the ask and thought "this is malformed."

### 9.2 The *interpret* tier — one reasoning call, full context (the correction)

Replace the ORCH_MATCH-gatekeeper + JUDGE + classifier-fallback chain with **one reasoning call** that is given
the full context up front and *decides*:

```
interpret(ask, conversationContext, retrieved, affordances, primitives) →
  { intent: 'act'|'navigate'|'decompose'|'clarify'|'teach',
    capabilityId?|op?, params?, subAsks?, question?,
    confidence, why }
```

- **Fed by retrieval, not gated by it.** `ORCH_MATCH` is **demoted from gatekeeper to retriever** — it surfaces the
  affordance-aware candidate capabilities + the page's affordances as *context for the reasoner*, never a pre-filter
  the model can only pick within. (This is the §3.3 tool-RAG, finally wired as context.)
- **The LLM owns SELECTION + INTENT; the substrate owns BINDING + EXECUTION + VERIFY.** The reasoner picks *which*
  capability / *whether* to navigate / *whether* to decompose / *whether* to clarify — and the **substrate binds the
  pick to grounded landmarks** and runs it through the trial/verify gate. This is the load-bearing split that
  **honors the `.1118` lesson** (a thin LLM tool-palette underperformed the affordance-aware substrate *at binding*):
  binding stays deterministic; only *interpretation* moves to the LLM.
- **`enforcePalette` (`agentLoop.js:98`) + the trial gate stay** as the anti-hallucination floor — a selected tool
  the retriever didn't surface → demonstrate, never dispatch.

This *is* the §3.1 contract, plus the two things the shipped stand-in dropped: a real **interpret** step (not
judge/classify), and an explicit **clarify** branch.

### 9.3 The trust contract (why this is also the trust answer)

The chat is the surface the user must trust. Trust = four observable properties, and only a *reasoning* call can
deliver the second:

1. **Does the obvious thing** on a clear ask (`go to youtube` → navigates).
2. **Asks when unsure** instead of guessing (`if go to youtube` → "did you mean *go to youtube*?"). A classifier has
   **no representation of its own uncertainty**; a reasoner does. This is the property the shipped path lacks.
3. **Never irreversible without a confirm** (the §3.5 / R-5 HITL gate — money = human-click-only).
4. **Shows its reasoning** — `why` + `confidence` are surfaced, not hidden.

So a **confidence/clarify gate** is not polish — it is the trust mechanism. `interpret` returns `clarify` (or low
`confidence`) → the front door **asks**; it does **not** dispatch a primitive. Nav stops being fire-and-hope.

### 9.4 Migration — from the `.1167` cascade to the interpret tier

The post-inversion default route (`chat.js sendChatMessage`) today is: utility guards → `_tryRouterNav` (regex
nav) → `_tryIlCommand` (ORCH_MATCH → JUDGE → act/reject) → miss → `_tryRouterFallback` (ROUTE_ASK) → `IL_ANSWER`.
Target (keep / demote / delete):

| Live piece | Fate |
|---|---|
| Warm alias short-circuit (Tier-0) | **keep** — deterministic replay, no LLM |
| `ORCH_MATCH` | **keep, repurpose** — retriever (feeds interpret) + binder (resolves the pick). No longer a gatekeeper |
| `JUDGE_MATCH` (judge-among-prefiltered) | **subsume** into `interpret` (select with full context, not judge a pre-filter) |
| `_tryRouterNav` regex head-check | **demote** — a latency optimization for the warm nav case *only*; the interpret call is the real path. Gate its dispatch on confidence |
| `_tryRouterFallback` / `ROUTE_ASK` greedy extract | **replace** with `interpret` (reason, don't extract); keep `_dispatchRouteDecision` as the **executor** for the chosen intent |
| `_dispatchRouteDecision` primitive nav | **keep, gate** — confirm/decline a low-confidence or cruft-prefixed `OPEN_URL` (fixes 9.1) |
| `IL_ANSWER` | **keep** — the `intent:'clarify'|'teach'|answer` rendering; now reached *by decision*, not as a fallback |
| `agentLoop` `maxSteps>1` | **the real multi-step path** — `interpret` IS step-1; raising maxSteps turns it into observe→re-interpret with no new machinery |

This is **R-7 made concrete** (the board's "retire orchComprehend/orchRoute"): the cascade collapses to
**warm → interpret → execute-verify**, one brain fed by retrieval, gated by the trial/verify floor.

### 9.5 Slices (extend R-1…R-7)

- **F-1 (pure)** — `interpret` decision core: given `{ask, retrieved, affordances, primitives, conversationContext}`
  → the 9.2 contract. Pure, LLM injected, unit-tested (mirrors `Core/route.js` / `Core/ilStandin.js`). The clarify +
  confidence branches are first-class outputs, not afterthoughts.
- **F-2 (live)** — wire `interpret` as the IL step-1; `ORCH_MATCH` → retriever+binder; **confidence/clarify gate**
  on nav dispatch (closes 9.1's eager-fire). The single behavior-visible change.
- **F-3 (subtractive)** — retire `JUDGE_MATCH`-as-selector + the `_tryRouterFallback` greedy path once F-2 proves out
  (keep `_dispatchRouteDecision` as the executor). Collapse the cascade.
- **F-4 (spike)** — the confidence threshold sweep (§6 Q2, still our-data-only) on the interpret call's calibration.

**Conversations tie-in:** an *app* is a seeded conversation (`DESIGN_conversations.md` §6); its `seed` is the
`conversationContext` the interpret call already takes — so the apps layer rides this contract with no new
mechanism. The seed-reach problem (`memory/cv2_seed_reach_narrow`) dissolves once `interpret` is the single
front door, because the seed colours the *one* call every ask flows through.
