# DESIGN — The Inference Layer (the "brain")

**Status:** proposal · design-only (the loop is not yet built) · 2026-06-16 · v2.74.x era
**Relation:** companion to `DESIGN_dev_bridge.md` (the brain for the *codebase*) and `DESIGN_background_agents.md` (the parallel-agent runtime). This doc is the brain for the *page/browser/frontend*.

> One line: today Orchard is **a single-shot LLM router over a mature grounded substrate — the brain minus the loop.** This doc specifies the loop and the contracts that make it safe.

---

## 0. Thesis

An **LLM controller/companion on the page/browser layer**, mirroring the dev-bridge (the LLM controller+effector on the *code*). The brain is an **agent loop** — `think → act → observe → re-think` — over browser **legs**, exactly the Claude Code pattern: *provide the legs, define a task, let it operate.*

What Orchard adds over "Claude Code in a tab": the legs are **learned and self-healing** (taught once by demonstration, recovered on selector drift), not fixed; and they operate the user's **real logged-in sessions**. Fixed tools + an adversarial browser is precisely why the loop needs heavier guardrails than a coding agent — which is what §2.3 (policy), §2.4 (access), and §3 (#1–#9) are for. They are the browser equivalent of Claude Code's permission modes.

---

## 1. Where it stands today (grounded, honest)

Orchard has nearly every *component* of a brain built — except the loop that binds them.

| Part | State | What's real |
|---|---|---|
| **Think** (select a tool) | **Built** | `Core/route.js` cascade: alias → tool-RAG retrieve (R-2) → `routeAsk` structured select+bind (R-3) → `RouteDecision`. Wired into `sendChatMessage` (R-4: `_tryRouterNav`, `_tryRouterFallback`). **Single-shot.** |
| **Act** (execute) | **Built / mature** | T1 fragments, T2 strategies, T3 workflows, landmarks (probe-or-recover), browser ops (`CLOSE_TABS`, `FOCUS_TAB`, `OPEN_URL`) |
| **Verify** (the gate) | **Built** | postconditions (SG-T2-2/9), trial/verify + fidelity (PB-4/5), completeness + intent-coverage (PB-6/PB-10), effect reconciliation (PB-8) |
| **Memory** (the flywheel) | **Built** | capability library, OUTCOMES (success/fail + decay), aliases, run history (DB-3), trace archive (P3-A) |
| **The LOOP** (observe → re-think → re-act → supervise) | **Not built** | the LLM is invoked *point-wise* at seams (`routeAsk`, `matchCapability`, `comprehendCrossGround`, `locateRoleRegion`, OBS-4) — never in an iterating cycle |
| **Orchestrate** (shapes, policy, connectors, multi-brain) | **Design-only** | this doc + `DESIGN_background_agents.md`; the Connector domain is empty |

The closest thing to iteration today — `ORCH-X/L` (loops, in progress), the cross-Ground chain, the walk runner — executes a **pre-built plan or a taught list**; it does not re-plan via the LLM each step. That's *plan-once, execute deterministically*, not a loop. The **one real agent loop** in the repo is the dev-bridge (Claude Code via the native host), but it operates the codebase, not the page — it is the template, not the thing.

**The gap is the loop.** It is a single, well-scoped, not-yet-written core that slots exactly where `route.js`'s one decision sits, turning "decide once" into "decide, act, observe, decide again."

---

## 2. The model

### 2.1 Two axes — the grid

Every intent is `(interaction mode) × (target domain)`:

- **Mode:** **ACT** (mutates the world; owns the confirm/trial gates) · **ASK** (changes the user's knowledge; read-only; ends in synthesis).
- **Domain:** **Page** (grounded substrate) · **Browser** (tabs/windows/nav) · **Connector** (off-web data via API) · **Self** (the tool + agent: dev-bridge / library / routing-policy / run-state).

|  | Page | Browser | Connector | Self |
|---|---|---|---|---|
| **ACT** | run T1/T2/T3 | close/focus/open tab | write via API ⚠ | dev-bridge ⚠ · save/delete cap · set routing rule |
| **ASK** | grounded read | "what tabs are open?" | "how many tickets?" | "what can I do here?" · "what's running?" |

Coverage: **Page** rich, **Browser** partial (close only), **Self** partial, **Connector** empty. The thin cells are the roadmap. CONTROL ("stop"/"pause") is a **pre-dispatcher reflex**, not a cell; TEACH is a dispatcher **outcome** (`needs:demonstrate`), not a mode.

### 2.2 Legs as tools

The grid's cells are **legs** — the tools the loop selects over, mirroring Claude Code's tool palette. Leg spec (the tool definition):

```
leg { name · does · mode(ACT|ASK) · domain(page|browser|connector|self)
      params · source(learned|builtin) · verified_by(trial|postcondition|n/a)
      safety(auto|confirm|gated) }
```

`name/does/params` is the Claude-Code tool schema; `mode/domain/source/safety` is the Orchard metadata that makes selection and autonomy safe. Legs are retrieved (tool-RAG, R-2), never dumped.

### 2.3 Selection policy — *LLM proposes, policy disposes*

Tool choice is constrained, not free. The constraint flips on read-vs-write:

| Goal class | Optimize for | Default leg | Why |
|---|---|---|---|
| **ASK** (read) | speed/cost | **connector/API first**, grounded fallback | low-risk; structured fetch beats scrape |
| **ACT** (write) | observability + verifiability | **grounded T2/T3 first**, even if an API exists | trial gate, visible trace, reversible-ish |

The policy is a **fixed safety floor + a user-editable rule table**. The floor (writes→grounded; never type credentials; gate the irreversible) cannot be relaxed by the loop. The table is edited *conversationally* via the **Self** effector ("only use grounded on Shopify" → a saved routing rule), with three guardrails: **user-origin only** (a page can't reprogram routing — the injection wall), **tighten-free / loosen-gated** (rules can raise the floor silently, lowering it needs elevated consent), and **confirm-the-scope at author time**. Precedence: most-specific scope wins, the floor always wins, recency breaks ties; the chosen leg + rationale is logged (a `_DECISION_RE` marker).

### 2.4 Access — subtractive

Unlike the dev-bridge (granted *up* from zero), the brain is code inside the extension and **inherits a near-total ceiling** (`tabs`, `scripting`, `<all_urls>`, `identity`, the user's logged-in sessions). So access design **gates down**, not up. Real access = `(legs exposed) ∩ (extension permissions) − (gates)`.

- **Rings (the ceiling):** current page → browser → the user's authenticated web (sessions/identity/clipboard — the powerful ring) → its own memory → user/model/cloud.
- **Boundary:** *never* (passwords/cards/SSN, trades/transfers, permission changes, CAPTCHA) · *gated* (sends/posts/purchases, account writes, irreversible clicks, downloads, settings/rule changes) · *free* (reads/observation).
- **Principle: read-only buys autonomy.** Reads are wide and mostly free; writes are wide but gated; credentials/money are walled off. The more a task mutates, the shorter the leash.

### 2.5 Execution shapes — one loop that plans or discovers

Three shapes, by how known-up-front the plan is:

- **Immediate** (seconds; fully known) — "close youtube tabs".
- **DAG** (minutes; structure known) — "do A while B then C" → siblings = concurrent, joins = `gate:{after:[…]}`. A **resource-aware scheduler** runs it: foreground is a mutex (the *user* owns it), each ground/tab is a mutex, I/O fans out freely. Concurrency is *requested* by the plan, *granted* by the scheduler.
- **Controller** (minutes–hours; only the goal+envelope known) — research. A budgeted, resumable frontier-expander that emits dynamic sub-steps; map-reduce synthesis; runs background in its own window. This *is* the deep-research pattern pointed at the live browser.

**The dividing line (compile-ahead vs runtime-loop):** the compiled Tier-2 graph (`observe → analysis → foreach → fragment`) beats the loop whenever the plan is *knowable* — it's cheaper and verifiable. The brain only earns its keep on the **un-compilable residue**: a plan is un-compilable when a node's *target* (which Ground/leg) is a function of a value an earlier node produces **and** isn't in the enumerable set at lower-time (data-dependent control flow over an open target set). Example: "find the cheapest NYC→Lisbon flight under 8h; if under $500 start booking and show me" — the winning airline site is unknown until you read, possibly ungrounded → must Explore-and-ground a runtime-discovered target → un-lowerable.

### 2.6 Cost

The LLM is touched **at the think seams, never during the do** — the grounded substrate executes with zero LLM. A taught task costs ~**one** call (select+bind), then deterministic replay; a novel/un-compilable task runs a per-step loop (one call per decision). The **teach-once flywheel is a cost optimizer**: every accepted capability moves a task from "N calls/run" to "1 call, then free." Model tiering (R-6) keeps the routine call on the cheap model.

### 2.7 Promotion — brain paths become substrate

A brain run produces a transcript of landmark-backed acts — the same raw material as a demonstration or a trial — so it feeds the **existing** accept pipeline: segment (OBS-2) → generalize params (OBS-4) → re-trial verify → **accept** promotes protos into saved Landmarks/Fragments/Strategy(T2)/Workflow(T3) (SG-LM-4), with dedup (GA-6), integrity (GA-8), alias accretion. **Selective:** you can only compile the compilable — linear segments harden into T2/T3; the data-dependent branch points stay as brain decisions or become Analysis/param holes in a **partially-compiled** T3. The flywheel **shrinks the un-compilable residue**: a path that needed mid-task grounding on run 1 is mostly a leg-selection on run 2. A brain-promoted artifact passes the *same* trial/fidelity gate (the brain proposing never bypasses verification) and is stamped `brain-derived` for re-verify (GA-3).

---

## 3. Resolved design decisions (#1–#9)

Worked one at a time, each grounded in existing mechanisms with the genuine residual flagged.

### #1 — The brain↔substrate seam: *delegate with an escalation rule*
The brain delegates a whole capability (cheap) — it does **not** supervise every step (that would delete the value of the learned library). The substrate self-heals small drift deterministically (probe-or-recover, in the content script, **no LLM**: probe the selector → recover by role + tiered accessible-name match → synthesize a fresh selector). On a failure it can't fix, it surfaces a **structured failure** — already carrying `matchMethod / nameSimilarity / authoredName vs matchedName / reason` — and the brain re-engages **only there**. The brain's moves above a structured failure: **repair the descriptor** (corrected role/name) and re-run the *same* deterministic recovery; escalate to the **visual locate** (`locateRoleRegion`, currently authoring-only); or **re-plan**. The brain does not enter probe-or-recover; it consumes its verdict. *Residual:* make the runtime verdict rich enough to act on; wire visual-locate as a runtime fallback.

### #2 — Loop control policy: *done / stuck / re-plan*
~80% inherited. **Done is a gate, not the LLM's opinion** — observable postconditions (SG-T2-2/9) + completeness (PB-6) + intent-coverage (PB-10) → terminal verdict (PB-7). **Stuck is a budget** — foreach cap (#189/CR-E4), `#call` timeout + bounded retry (CR-E5), `channelRetry`, bounded `WAIT_FOR` (BA-1). **Retry-vs-fail is an envelope decision** already (CR-E1 nav-relax). The brain adds only a **bounded outer loop**: on a *terminal* failure, choose **re-plan** vs **ask** (HITL / `demonstrate` / §7 handoff), with **anti-cycling** powered by OUTCOMES (don't re-pick a just-failed leg) + a no-repeat rule + the outer budget (#5). *Residual:* the anti-cycling discipline.

### #3 — Context management
The substrate is **already a compaction engine** — the brain reasons over Locales (not raw DOM), landmark *identities*, **data-only** observations held in scope not prompt (SG-INV-1), collapsed traces (#139/#140), a *retrieved* palette. The loop's new problem is **count, not size** (a growing transcript). Spec: carry **goal + live scope (HS-2) + a signal-only step ledger + the current observation only**; collapse finished sub-goals to one line (the subGoal DAG gives the boundary); archive the full trace (P3-A). Research is **map-reduce** — reduce each read to its finding immediately, don't carry raw reads. ACT compacts deterministically (free); ASK uses an LLM-reduce (= the synthesis map step, not extra cost). Doubles as the **context-bleed privacy mitigation**. *Residual:* the synthesis accumulator still grows → bounded by the budget (#5).

### #4 — Runtime home + durability
MV3's only tab-driver (the service worker) is also the only thing that won't stay alive. So **the loop is not a process — it's a journaled, reattachable state machine.** Compose what already ships: **per-step journal** to the runtime partition (S1–S3) — the ground truth; **`chrome.alarms`** to wake the SW and re-drive (the orchard-sync precedent); **DB-3 journal-reattach + mid-run persist + stale-lock fix** as the proven pattern. Architecture mirrors the dev-bridge: **loop in a persistent home (offscreen document for in-browser compute, cloud for cross-session) + the SW as a thin, re-spawnable effector relay + the durable journal as truth.** An SW eviction = *pause at a checkpoint, resume on wake*. **A continuously-working run stays alive** (pending tab work / fetches reset the idle timer) **and runs at full speed; only a *waiting* run sleeps and ticks** via alarm (≥1-minute floor — fine, since waited-on external events change on a minutes-to-hours scale). *Residual:* the 1-minute wake floor; reattach idempotency (two-phase about-to-act/acted marker — the stale-lock precedent); per-leg home assignment.

### #5 — Budget
The governor is **cost** (tokens/$), metered at the managed LLM proxy (P3-C) — the only non-arbitrary resource. Steps/wall-clock/tabs are **generous safety backstops, not the bound** (honoring "don't create artificial bounds"). Owner: the **user** — a per-task **envelope** (set at launch, part of research consent), a per-policy **standing rule** (the Self/policy layer), and a system runaway seatbelt. At the limit, **degrade → checkpoint+ask → safe-boundary halt**: drop to the cheap model / narrow the frontier first; then journal + report *"spent $X, found N of ~M — continue (raises budget) or stop?"* (**no silent caps**); halt only at a safe ACT boundary (no half-submitted forms). Enforced at the proxy (refuse a call that would exceed remaining). *Residual:* cost is reactive, not predictive — OUTCOMES-based cost history is the path to estimation.

### #6 — ASK verification gate
ACT verifies "did the effect happen?"; the ASK analog is "is the answer grounded in, and complete over, what I read?" — two sub-gates. **Acquisition:** target (the read's landmark identity covers the asked subject — PB-10 on the observation) + **completeness** (generalize EX-3's capped flag to runtime reads — "saw all of it?"). **Synthesis faithfulness:** *take the arithmetic away from the model* — for quantities the read returns a **structured list**, the LLM only identifies items, the count is `list.length` in code; for prose, every claim must **trace to an extraction** (the `route.js` anti-hallucination rule); for hard cases, a cheap **faithfulness critic** (deep-research's verify pattern). Output = a **qualified answer** (complete / capped-and-qualified / claim-flagged). **Render-don't-synthesize** makes the sensitive single-value case trivially faithful. *Residual:* generalize the capped flag; structured-extraction-for-compute; gate the critic's cost.

### #7 — Partial completion / rollback
**The world is not transactional — there is no undo for a sent email or a submitted form**; that's a property, not a gap. So the contract is *prevent → account → resume → compensate*, not roll back. **Form atomicity** (SG-RES-5) already makes the single-form partial benign (fills reversible, submit the one commit). For a **multi-commit sequence** (3 applies, 3 sends): checkpoint before each commit, **reconcile** the exact partial (PB-8), **resume idempotently** from the failed item (the #4 two-phase marker), and **never auto-retry an irreversible commit** (re-send = new harm). The gate **moves earlier** (confirm the whole batch up front; JIT-confirm the `ACT×Connector` corner). Honest reconciliation is the deliverable ("2 of 3 done — can't reverse the 2 — resume the 3rd, or stop?"). **Compensation** (a *forward* offsetting action — "cancel the order") is offered where a known compensator exists, user-confirmed, never automatic. *Residual:* commit-granular resume across separate commits; the compensation catalog.

### #8 — Identity & multi-brain
The brain is **always an ephemeral loop; continuity is the persistent substrate**, never a live process (the Claude Code / dev-bridge model). Memory = the library + OUTCOMES + routing rules + run history + aliases + conversation store; a *suspended* task is the #4 journal; a *standing goal* ("tell me when my order ships") is a journaled task an alarm re-wakes — always-there (memory persists), never always-running (the loop is fresh each wake). **Multi-brain is a supervised tree, not one fanning loop**: a parent spawns children, each with its **own context** (a sub-goal + substrate slice, not the parent's transcript — #3 isolation), **own budget slice** (#5), and a **structured return**. A child brain is *just another leg* — the parent re-engages only on the child's structured failure (the **#1 seam recursed**), with #2's control over child results. The tree exists only for the task, then **collapses back into the substrate**. *Residual:* sub-brain budget slicing+reclaim; cross-child merge at a DAG join; a standing-goal store.

### #9 — Injection / trust *under the loop*
The loop changes the threat model: every step the brain **reads page content and feeds it into the next think call**, so untrusted content becomes a recurring input to *tool selection* — more entry points, it can steer *actions* (not just answers), and it persists across steps. R-5/R-Spike's boundary must extend from the front door to **every observe→think edge**: observations enter a **structurally-fenced "untrusted" channel** (reason *about*, never *follow*); the **action space is bounded and gated** — the loop can only act through the retrieved palette (`route.js`: "a selected tool MUST be one we offered") and the policy gates, so **a corrupted thought cannot fire an irreversible act without hitting a confirm** (this is the real backstop); data-handoff stays **deterministic** (values flow via scope, never as instructions); render is **escape-first**. *Residual:* the core of injection is unsolved — this is **defense-in-depth, not a solve**; the load-bearing claim is the bounded gated action space.

---

## 4. The muscle — runtime mechanism (the loop's I/O)

§3 specified the loop's *contracts* (what the brain may do). This section specifies the *mechanism* — how one iteration literally runs — grounded in `route.js`: **a loop step is `route.js`'s single decision, iterated with state.** Three data shapes, one dispatcher, one palette; `route.js` is the degenerate one-shot case.

### 4.1 The step contract (the spine)

**`StepContext`** — the brain's input, assembled fresh each step:
```
StepContext { goal, scope:{name→value}, ledger:[…signal-only…], observation, palette:[OfferedLeg…], budget:{remaining} }
```
`scope` = live values from prior reads, deterministic (HS-2), never narrated into the prompt. `ledger` = signal-only per-step summaries (#3 compaction); only the current `observation` is full. `palette` = §4.3.

**`Decision`** — the brain's structured output, generalizing `RouteDecision`:
```
Decision { kind:'act'|'ask'|'done'|'needs', leg?, params?, answer?, needs?, reason, confidence }
```
`leg` MUST be one of `palette[].key` — `route.js`'s anti-hallucination check ("a selected tool MUST be one we offered"). The loop maps `route.js`'s `action→kind`, `tool→leg`, and adds the `done` terminal + the `needs` hand-back.

**`Observation`** — execute → next step:
```
Observation { ok, value?, verdict?, structuredFailure?, effects? }
```
`structuredFailure` carries the #1 envelope (`{where, reason, matchMethod/similarity, pageState?}`) — the carrier that lets the brain re-engage.

**The loop:**
```
while (!terminal && budget.remaining() > 0 && !aborted) {
  ctx      = assemble(goal, scope, ledger, lastObs, palette(goal, scope, policy), budget)
  decision = callBrain(ctx)                      // structured output; leg ∈ palette enforced at validation
  if (decision.kind==='done')  → VERIFY via the #2 gate (postcondition/completeness/intent-coverage):
                                  pass ⇒ terminate(answer);  fail ⇒ "not done — keep going"
  if (decision.kind==='needs') → hand back (confirm / demonstrate / human-handoff); journal-pause (#4)
  obs = runTool(decision.leg, decision.params)   // §4.2
  ledger.append(summarize(decision, obs)); scope.update(obs)   // #3 compaction + HS-2
  lastObs = obs
}
```
**Done is brain-proposed, gate-confirmed** (#2) — no unilateral success. **`route.js` is the degenerate case** (one iteration, empty ledger, terminal-after-one): the loop is `route.js` *+ state*, not new machinery.

### 4.2 `runTool` — the executor dispatcher

`runTool(leg, params) → Observation` dispatches over the four domains to existing (or missing) executors, then normalizes and transports.

| Leg domain | Dispatches to | State |
|---|---|---|
| **Page** | unified node walker / `ExecutionEngine` (`REPLAY_SG_CAPABILITY` · `RUN_SG_TRIAL` · `RUN_OBSERVATION`) | built; carries the #1 verdict/failure |
| **Browser** | `CLOSE_TABS` · `FOCUS_TAB` · `OPEN_URL` + tab resolver + `list_tabs` | partial |
| **Connector** | new connector executor (auth + fetch / gated-write) | greenfield |
| **Self** | intent-menu · library accept/registry · routing-rule writes · run-registry introspection | partial |

Beyond dispatch it: **(1) normalizes** each native result into the uniform `Observation` (the #1 structured failure rides back on a Page miss); **(2) busy-marks** engine-driven tabs (Invariant #2 — a Page leg wraps `markEngineBusy` in try/finally so synthetic clicks drop from the interaction monitor as `engine-run`; Browser legs are `chrome.tabs` calls → no busy-mark; **a user-demonstration leg is never busy-marked**); **(3) resolves the target tab + `exec:fg|bg`** (`ensureTabForGround`/resolver; the **foreground is a mutex the user owns**).

**Transport — two modes, same dispatch table:**
- *In-SW loop (short runs):* a direct in-process call to the executor registry.
- *Persistent-home loop (long/background — #4):* a **journaled RPC** — `runTool` writes the op to the journal, messages the SW (which holds `chrome.tabs` + content scripts), then **awaits via a reattachable poll, not a single response**, because the SW can be evicted mid-leg. The executor journals progress (DB-3); on SW death+respawn `runTool` reattaches and reads the verdict. (DB-3 journal-reattach + `WAIT_FOR` SW-poll, at the loop↔executor edge.)

### 4.3 `palette` — the unified, filtered, biased leg set

`palette(goal, scope, policy) → OfferedLeg[]` unifies two sources that look nothing alike; tool-RAG (R-2) covers only the first today.
```
learned = toolRAG.retrieve(goal, scope.grounds, k)     // R-2, bounded (k≈8), Ground-readiness gated (G1-3)
builtin = registry.filter(availableIn(ctx))             // small fixed set, AVAILABILITY-gated (connector linked? dev on? tab exists?)
legs    = (learned ∪ builtin).map(toOfferedLeg)         // normalize both to the uniform leg spec
allowed = policy.filter(legs, scope)                     // A2.3 enforcement: drop routing-rule- + floor-forbidden
return    allowed.map(l => attachPrior(l, OUTCOMES, policy))  // bias: OUTCOMES success (GA-5) + read/write hint
```
- **Scale dissolves:** retrieval bounds the learned side (k≈8) at any library size; builtins are ~15 fixed → palette ≈ 23, always within reliable tool-selection range.
- **A leg is a `{descriptor, handler}` pair** registered together — `descriptor` is what `palette` offers, `handler` is what `runTool` dispatches. Learned caps have both (library entry + the engine); a new Browser/Connector/Self leg = writing both faces as one entry. **This is the unit of "add a leg," and the shared dependency between `palette` and `runTool`.**
- **Enforcement (A2.3)** = `policy.filter` (filter-before-offer) + the `leg ∈ palette` validation (validate-against-offered): a forbidden leg is never offerable — *why* injection can't fire it.
- **"Policy disposes" by shaping:** `attachPrior` pre-biases each leg (OUTCOMES success + read→speed / write→observability); the brain picks over a pre-filtered, pre-biased set.
- **Warm path preserved:** the alias short-circuit (`route.js` Tier-0) runs *before* palette assembly — an exact taught-alias hit skips the loop (deterministic replay). The palette is the cold path; re-assembled per step but cacheable (invalidate on a context change: new tab/Ground/connector).

### 4.4 Interlock + residuals
The palette offers `{descriptor}` → the brain returns a `Decision` picking one → `runTool` dispatches its `{handler}` → returns an `Observation` (the #1 envelope on failure) → the next `StepContext` carries it. That is the muscle's full inner loop.

**Muscle build-floor residuals:** the loop core (`callBrain`/`runTool`/`assemble`) is unwritten · the **builtin leg registry** must exist as descriptor+handler pairs (Browser partial, Connector greenfield, Self partial) · the **journaled-RPC transport** (offscreen↔SW reattachable relay) is unbuilt · `policy.filter` (the routing-rule table) and the read/write **prior hint** are design.

## 5. Privacy & data leakage (financial-grade reads)

The model gets ***where* the data is (the landmark identity), not *what* it is (the value).** A taught read, replayed, is **model-free** — the value is read locally and rendered or handed off in scope, never prompted. Leaks happen only at think-seams: **reasoning over a value** (not a plain read-and-show), the **visual/screenshot** channel (teach/heal only), **grounding with un-masked values**, demo generalization, heal fallback. Defenses: **mask values in everything sent for grounding**; **render-don't-synthesize** for sensitive reads; **sensitivity-tag landmarks** (balance/SSN/card → never screenshot, never send the value, route any unavoidable reasoning through the managed proxy / a local model); disable the visual channel on tagged Grounds. Plus **output + context bleed** — the model's *answer* re-materializes the value and the conversation re-sends it forward, so **scrub outputs (not just inputs)**, keep sensitive turns **out of the carried context** (an ephemeral conversation = context isolation), and de-tokenize only at the display edge. *Productizing other people's financial data crosses into compliance (PCI/GLBA/GDPR) — a real legal pass, not just good defaults.*

---

## 6. Why the brain (where it beats the current model)

Today's single-shot model fails on three structural limits; the brain targets each:
1. **Mid-run re-planning** — read→filter→per-item-adapt with heterogeneous targets + a mid-loop login wall (a fixed chain can't branch on what it observes). *(NB: the homogeneous happy path is already the Tier-2 `observe→analysis→foreach→fragment` graph — the brain only earns its keep at the heterogeneous edge.)*
2. **Background + temporal** — "when X happens, grab Y, act on Z" (no completion-gated background runtime today).
3. **Interpretation + state** — ambiguous/compound asks + reading browser/self state the regex gauntlet can't express (e.g. "close the noisy tabs and pull up where I left off").

The honest test for "does the brain help here?": **can this plan be compiled ahead?** If yes, the substrate wins. If no (data-dependent control flow over an open target set), the loop earns its keep — and then promotes what it can back into the substrate.

---

## 7. Build path

The loop is the **one unbuilt core** — its mechanism (the spine, `runTool`, `palette`) is now specified in §4. A pure `think→act→observe→re-think` controller with injected `callBrain` / `runTool` deps (the `route.js` pure-with-deps pattern, but iterating), it sits where `route.js`'s single decision sits. Everything around it exists: the legs, the verification gate, the memory/flywheel, the promotion pipeline, the journal/alarm durability primitives, the dev-bridge as the structural template.

Suggested sequencing: (1) the pure loop core + the **#1 seam** (rich structured verdict + brain re-engage) and **#2 control** (bounded outer re-plan/ask) — these two are the spine; (2) the browser legs (`list_tabs`, `focus`, `reload`) + the **Self** introspection legs; (3) the runtime home (offscreen + SW relay + journal, #4); (4) the budget/proxy metering (#5) and the ASK gate (#6); (5) shapes — DAG scheduler, then the research controller; (6) the connector domain.

**Genuine residual backlog** (flagged honestly, not hand-waved): anti-cycling discipline (#2) · synthesis-accumulator bound (#3/#5) · 1-min wake floor + reattach idempotency + per-leg home (#4) · cost estimation from OUTCOMES (#5) · capped-flag generalization + structured-extraction (#6) · commit-granular resume + compensation catalog (#7) · sub-brain budget slicing + cross-child merge + standing-goal store (#8) · observe→think fencing mechanics (#9).

## 8. Migration / coexistence

**Not a rewrite — a strangler-fig.** `route.js` is already the loop's degenerate single-shot case (§4), so the loop slots in *exactly where `route.js`'s decision already sits*. The loop changes the **orchestration** (one decision → iterate), not the **execution** (the legs/substrate are untouched) — which is why it coexists with a substrate that's still actively changing.

**Today's cascade** (`chat.js sendChatMessage`): reflexes (`_matchCloseTabs`, `devBridge.maybeHandle`, `targetCapability`) → warm fast-paths (`_tryIntentMenu`, `_tryExplore`) → router R-4 (`_tryRouterNav`, `_tryGroundedTurn`, `_tryRouterFallback` — `route.js`, single-shot, **already wired**) → floor (`ChatAPI.match`, legacy fuzzy matcher). `route.js` is already **additive** ("on anything other than a confident X it falls through; nothing that works changes") — that discipline is the template.

**Phased path** (each shippable, reversible, no big-bang):
1. **Parity** — `Core/agentLoop.js` at **`maxSteps = 1`** *is* one `route.js` decision; wire it as the body of the existing `_tryRouterFallback` slot. Ships the spine + `palette` + `runTool` with **zero behavior change**. *Start here.*
2. **Iterate on the cold path only** — raise `maxSteps` exactly where `route.js` returns `demonstrate`/`clarify`/`decompose` (the novel/compound cases single-shot fails). Warm paths (alias, a confident `_tryGroundedTurn`, a confident single-capability replay) stay deterministic — the loop catches only what currently breaks. Still additive.
3. **Reflexes → legs** — retire the regex reflexes into palette legs one at a time, keeping a **deterministic warm-alias short-circuit** for high-frequency exact forms (don't pay an LLM loop for "close tabs" × 100). The "LLM is default, determinism is the *optimization*" flip, applied incrementally.
4. **Retire the floor** — delete `ChatAPI.match` (already pending as **R-7**). The loop is the cold-path default; `route.js`'s cascade becomes its inner first-iteration machinery.

So **"replace vs. alongside" = alongside first (1–2, additive), then incrementally replace (3–4).**

**Coexistence:** the loop is a **new caller of stable executor interfaces** (`REPLAY_SG_CAPABILITY`, `RUN_OBSERVATION`, `CLOSE_TABS`, …), not a fork — so `sg.js` / `orchMatch` / the Tier-2 walker keep evolving untouched; the loop dispatches *into* them via `runTool`. The **only hot-file contention is the `chat.js` wire-in**, minimized at Phase 1 to one additive branch.

**Residuals:** a Phase-1 **parity test** (`loop@1` ≡ `route.js` — identical decision; the `palette`/structured-output paths must not diverge from `retrieveTools`/`callRouter`); **coordination on the `chat.js` wire-in** (the one shared hot file — land the additive branch when the dispatch region is quiet); the **reflex-retirement order** (which forms keep a warm alias vs. go loop-only, frequency-driven).

**The unblock:** start with `Core/agentLoop.js` at `maxSteps = 1` wired into the existing `_tryRouterFallback` slot — a reversible no-op that proves the entire muscle, fights nothing, and turns "where does it hook?" into "where `route.js` already does, then grow the step count."

## 9. Open / not yet decided
- **Connector layer** — auth model (session-reuse vs `chrome.identity.getAuthToken` vs OAuth vs MCP/cloud broker), which connectors, the deterministic read→write handoff. Greenfield.
- **Runtime-home fork** — offscreen vs cloud vs native-host for the persistent loop body (#4 resolves the *shape*; the concrete home is a build choice).
