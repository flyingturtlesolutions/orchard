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
