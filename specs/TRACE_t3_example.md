# TRACE — a cross‑Ground Workflow intent, Intent → DOM (worked example)

> **Status:** synthesized end‑to‑end trace (v2.74.779), verified against source `file:line`. Structure / control‑flow / transforms / citations are exact; concrete IDs + the example job URL + tab/invocation ids are **illustrative** (they depend on the user's actual saved Grounds/Strategies/Fragments/landmarks). See §Caveats.
> **Example intent:** *"find a senior software engineer job on LinkedIn and save it to my Notion job tracker"* — one ask, two Grounds (linkedin.com, notion.so), one cross‑Ground data dependency (`job_url`).

> ## ⚠ Load‑bearing finding (the next change)
> **The cross‑Ground data flow is an UNWIRED SEAM in the integration handler.** The pure core supports it and is unit‑tested (`tier3.js:37‑40`), but `COMPREHEND_CROSS_GROUND` never populates it:
> - `_bindStrategyOnGround` returns only param **names** (`sg.js:60`) — no literal values, no output declarations.
> - The handler never sets `resolved[].literals` / `resolved[].scopeReads` (`sg.js:890‑896`).
> - So `_stepParamBindings` sends **every** param (KEYWORD, URL, TITLE) down the else‑branch → `strategy_param` (`tier3.js:42`), i.e. all become Workflow *inputs*.
>
> **Consequence:** for this exact ask, the emitted record has **no `job_url` wiring** — step 0 declares no output, and step 1's `URL` is a plain input asked of the user, *not* the value carried from LinkedIn. It would **run** but the two Grounds wouldn't share data. L2–L5 below are traced against the *idealized* record (`KEYWORD=literal`, `URL=scope_binding(job_url)`, step 0 `outputs:[{name:'job_url'}]`) — the form the runtime actually needs. **Closing this seam — populate `literals` from the intent's stated constraints + infer `scopeReads` from upstream outputs — is the concrete next slice.**

---

## 1. The Intent

One NL string → a durable, replayable **Workflow record** whose `steps[]` are Strategy invocations, one per Ground. Entry: `COMPREHEND_CROSS_GROUND` (`background/handlers/sg.js:859`), `{ ask, save:false }` (read‑only proposal — chat reviews before run).

| sub‑intent | clause | Ground (host hit) | Strategy | params |
|---|---|---|---|---|
| s0 | "find a senior software engineer job on LinkedIn" | `gnd_linkedin` ("linkedin") | "Search jobs" | KEYWORD |
| s1 | "save it to my Notion job tracker" | `gnd_notion` ("notion") | "Save a page" | URL, TITLE |

**Control thread:** 1 ask → 2 sub‑intents → 2 Strategies → N Fragments → M Actions → landmark engagements. **Data thread:** one value `job_url`, emitted on LinkedIn, consumed on Notion via `workflowScope`.

---

## 2. Layer‑by‑layer

### L1 — Cross‑Ground COMPREHENSION (ask → Workflow record) · `sg.js:859`
1. **Ground catalog** (`sg.js:865‑872` → `groundCatalog.js:38‑61`): every Ground + its Strategy goal labels → `{groundId, hostTokens, terms}`. `_hostTokens('https://www.linkedin.com/*')` → `['linkedin']`.
2. **Decompose** (`sg.js:876‑877`): `AnthropicService.comprehendIntent({userIntent:ask})` → `spec.subGoals` (page‑independent), fallback `[{id:'s0',label:ask}]`.
3. **Resolve Ground per sub‑intent** (`sg.js:882‑887` → `resolveGround`): host‑name hit adds **+1** (`groundCatalog.js:83`) so a named site dominates → s0→`gnd_linkedin`, s1→`gnd_notion`. Band: resolved / ambiguous (within `margin 0.34`) / miss.
4. **Bind a Strategy per Ground** (`sg.js:889` → `_bindStrategyOnGround:47‑62`): the within‑Ground matcher (`toCandidate`→`rankAndDecide`) scoped to `c.strategyId` → `strat_li_searchjobs` / `strat_no_savepage`. *(Returns only names — see finding.)*
5. **Lower** (`sg.js:899‑901` → `buildWorkflowRecord`, `tier3.js:70‑113`): one `{type:'workflow', workflowId, groundId, groundUrl, paramBindings}` step per sub‑intent. `runnable = steps===subs` ⇒ true. `save:false` ⇒ no persist.

**Handoff:** `workflow.steps[]` — the executor reads each step's `groundId`+`groundUrl` (the hop), `workflowId` (the Strategy), `paramBindings` (resolved against `workflowScope` + inputs).

### L2 — Workflow EXECUTION (step loop + cross‑step scope) · `WorkflowExecutor.js:409`
- `workflowScope = {}` (`:461`) — the `{name→TaggedValue}` map carrying `job_url` between steps.
- `executeSteps` (`:518‑548`) walks steps in array order; `executeWorkflowStep` (`:349`) → `resolveWorkflowStepParams` → `resolveBinding` (`:162‑192`): `literal`→value · `strategy_param`→`paramValues[name]` · **`scope_binding`→`workflowScope[name]` then `unwrapTagged` (`:136‑143`)** · `iteration_variable`→iterStack.
- Dispatch (`:374‑381`): `ExecutionEngine.executeStrategy({ strategyId:step.workflowId, strategyParamValues:innerParams, … })`.
- **Merge** (`:555‑558`): on success, `extractedValues` merge into `workflowScope` — *this* is how `job_url` becomes visible to step 1. **`job_url` is NOT in scope when step 0's bindings resolve — only after step 0 returns.** Step 0 fail ⇒ step 1 never runs (`:553`).

Two sequential calls: **A** `executeStrategy(strat_linkedin_search_jobs, {KEYWORD:'senior software engineer'})` → `{extractedValues:{job_url:scalar(…)}}` → merged → **B** `executeStrategy(strat_notion_save_page, {URL:'…/jobs/view/3901234567', TITLE:'…'})`.

### L3 — Strategy EXECUTION (one Strategy → one tab on its Ground) · `ExecutionEngine.js:126` — *fires twice*
- Load Strategy (`:171`) + its Ground (`:177`); `ground.url` is the tab target.
- **THE CROSS‑GROUND HOP** (`:303‑311`): no `targetTabId` ⇒ `#openTab(ground.url)` (`chrome.tabs.create`, `:5279`) → **Call A lands on linkedin.com, Call B on notion.so**. Each call opens + (in `finally`) closes its own tab.
- Seed scope from params (`:260‑294`); preconditions (`:319`); walk `fragmentSteps`; `#resolveFragmentBindings` (`:5175‑5241`) turns `strategy_param` into the concrete value injected into the fragment; dispatch `TemplateWalker.executeFragment` on the SAME tab threading the SAME `scope` by reference (`:841`).
- **Bubble‑up** (`:472‑505`): `extractedValues` = the final scope **filtered to `strategy.outputs`** (e.g. `{job_url}`). *(Requires step 0's Strategy to declare `job_url` as an output.)*

> Every fragment of one `executeStrategy` runs on that ONE `ground.url` tab. step0(linkedin) and step1(notion) are *two calls*, never two fragments of one Strategy.

### L4 — Fragment EXECUTION (action walk) · `TemplateWalker.js:623`
- Load Fragment; optional antecedent replay (`:646`, e.g. Login/land‑on‑search).
- `actions = JSON.parse(frag.rawJson)` (`:672`); **`InjectionService.injectParams`** (`:679` → `InjectionService.js:356‑370`) replaces every `{{NAME}}` in `value`/`selector` → `{{KEYWORD}}` becomes `'senior software engineer'`.
- Walk each action (`:722‑1364`): read/control ops inline (`EXTRACT`→`scope.set('job_url', …)`); plain TYPE/CLICK/NAVIGATE → generic dispatch → `#executeStep`.

### L5 — LANDMARK ENGAGEMENT (the leaf) · `TemplateWalker.js:3724` (`#executeStep`)
The action handed in: `{ action:'TYPE', landmarkRef:{uid:'lmk_li_jobs_keyword'}, value:'senior software engineer' }` — value injected, **selector absent (lives in the registry)**.
1. **Guard** (`:3743`) → `applyLandmarkRefToStep`.
2. **Registry resolve** (`LandmarkResolver.js:46‑128`): `StorageManager.getLandmark(uid)` → copies saved `selector` onto `step.selector`, stashes `{a11yRole, accessibleName, hierarchicalContext}` under `step._resolvedFromLandmark`.
3. **Frame** (`:3866`): `frameUrl=null` → frame 0.
4. **Probe‑or‑recover** (`:3875‑3933`): `LANDMARK_PROBE_OR_RECOVER` → content script (`contentScript.js:7034‑7102`): `querySelectorAll(cached)` filtered to visible. **1 visible ⇒ `via:'selector'` (happy path).** 0 visible (e.g. LinkedIn's ember id rotated) ⇒ recover by `role + exact accessibleName` → `_synthesizeSelectorForElement` mints `input[aria-label="Search by title, skill, or company"]` (`via:'heuristic'`) → **overwrite `step.selector`**, persist back (`updateLandmark(uid,{lifecycle:'stale-suspected', selector, lastRecoveredTs})`, `:3922`), emit `LANDMARK_RESOLUTION_DEGRADED`.
5. **Dispatch** (`:4052‑4091`): `chrome.tabs.sendMessage(tabId, {type:'EXECUTE_STEP', payload:{action:'TYPE', selector:<resolved>, value:'senior software engineer'}}, {frameId:0})` (`#msg:3327`).
6. **Content‑script router** (`contentScript.js:5801`): TYPE → `handleType`.
7. **THE ENGAGEMENT** (`handleType`, `contentScript.js:2419‑2448`): `resolveElement` (`:440‑491`) `document.querySelector` → the real `<input>` → `focus()` → React‑compatible native value setter → clear → `typeStringPaced` per‑char keystrokes (keydown/input/keypress/keyup, 50‑150ms jitter) → `change` event → `{success:true}`. **The keyword box now contains "senior software engineer."**

---

## 3. The two threads

**Control (fan‑out):** `1 ask → COMPREHEND_CROSS_GROUND → [s0,s1] → 2 Strategies → executeWorkflow → 2× executeStrategy (each #openTab its Ground) → executeFragment → actions[] → #executeStep → DOM`.

**Data (`job_url`, one value, the only thing the Grounds share):**
```
LinkedIn EXTRACT → scope.set('job_url', scalar('…/jobs/view/3901234567'))      [contentScript / L4]
  → Strategy scope (Call A, by ref) → outputs filter → {job_url}               [ExecutionEngine.js:472‑505]
  → executeStrategy(A) returns extractedValues                                  [L3→L2]
  → workflowScope merge (last‑write‑wins)                                       [WorkflowExecutor.js:555]
  → step1 URL = scope_binding('job_url') → resolveBinding → unwrapTagged        [WorkflowExecutor.js:166‑176]
  → executeStrategy(B) seeds scope.set('URL', scalar(…))                        [ExecutionEngine.js:260]
  → injectParams fills {{URL}}                                                  [InjectionService.js:356]
  → Notion handleType writes the LinkedIn URL into the Notion URL field         [DOM]
```

---

## 4. Funnel

```
        "find a senior SWE job on LinkedIn and save it to my Notion job tracker"   (1 NL ask)
                                        │
   L1  COMPREHEND_CROSS_GROUND  sg.js:859   comprehendIntent→[s0,s1]  resolveGround(+host)→gnd_li,gnd_no
        buildWorkflowRecord tier3.js:70 → WORKFLOW RECORD {steps:[2]}
                                        │  workflow.steps[]
   L2  executeWorkflow  WFExec.js:409   workflowScope={}  STEP0 ─(job_url)─merge─► STEP1
              CALL A │ executeStrategy(linkedin)          CALL B │ executeStrategy(notion)
   L3  executeStrategy EE.js:126        #openTab(linkedin.com) EE.js:308   #openTab(notion.so)  ── HOP ──
        seed scope(KEYWORD)  outputs→{job_url} ───job_url───►  seed scope(URL=job_url,TITLE)
                                        │ executeFragment
   L4  executeFragment TW.js:623        JSON.parse(rawJson)→actions  injectParams {{KEYWORD}}→literal
        walk: TYPE → CLICK(submit) → EXTRACT(job_url)
                                        │ #executeStep
   L5  #executeStep TW.js:3724          landmarkRef.uid→getLandmark→selector+desc
        PROBE_OR_RECOVER → (ember rotated) → heuristic recover → step.selector := input[aria-label="…"]
        sendMessage {EXECUTE_STEP, TYPE} → {frameId:0}
                                        ▼  document.querySelector
        LIVE DOM (linkedin.com, frame 0): <input aria-label="Search by title, skill, or company">
                                          focus → React value‑setter → typeStringPaced keystrokes
```

---

## Caveats / idealizations
- **Load‑bearing (above):** L1 as wired does not produce the `job_url` flow; L2–L5 trace the idealized record. Closing that seam is the next slice.
- **Illustrative values:** all concrete IDs (`strat_*`, `frag_*`, `lmk_*`, `gnd_*`, `wf_*`), the example job URL, `tabId=1734`, `invocationId` — fabricated; they depend on the user's actual storage (not enumerated here).
- The Fragment `rawJson` (TYPE keyword → CLICK submit → EXTRACT job_url) + the Notion fragment are reconstructed from the layer contract, not read from a stored record.
- `comprehendIntent`'s subGoal output is model‑dependent.
- The probe **miss → heuristic recovery** is one branch; the `via:'selector'` happy path (cached selector still unique‑visible, `contentScript.js:7052`) is the more common outcome and skips the overwrite/persist/degraded‑event steps.
- Whether `frag_li_jobsearch` has a Login antecedent (`TemplateWalker.js:646`) is unknown — noted as optional.
