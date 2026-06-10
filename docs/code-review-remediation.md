# Code-Review Remediation Spec (CR arc)

**Source:** full-codebase review @ working tree v2.74.916 (2026-06-10), five-area agent sweep + hand verification.
**Verification status:** every P1 below was independently re-verified against the working tree (file:line + quoted evidence checked). Suite green at 687 passing / 0 failing under the Node-16 harness. The .913–.916 batch was uncommitted at review time.
**Conventions:** each slice = one turn-sized change; bump `manifest.json` patch + inline `v2.74.X` markers per slice; `bcp` gates a batch. Pure logic lands in `Core/` with a paired `Core/*.test.js`. Slice IDs are stable — reference them as `CR-S1`, `CR-D2`, etc.

**Snapshot of scale (for orientation):**
`contentScript.js` 9,560 · `studio.js` 7,663 · `background.js` 7,240 (≈170-case switch) · `AnthropicService.js` 6,830 · `ExecutionEngine.js` 5,382 · `TemplateWalker.js` 4,574 · `chat.js` 3,747 · `background/handlers/sg.js` 3,000 (48 handlers) · Core = 69 modules / 49 tested. No package.json, no CI, test harness lives OUTSIDE the repo in `%TEMP%\ahub-harness\`.

---

## Phase 1 — safety + trust (do first, in order)

### CR-S1 · Stop reaches every long-running surface, not just the walk
**Problem (verified):** `_stopLongRunning` sets the abort flag only `if (_walkLive)` (chat.js:1820), and `_walkLive` is set only by `_orchWalkWorkflow` (chat.js:1835). A foreach/loop plan launched via `_orchConfirmPlan → _orchRunPlanIR` (the 22:58 runaway path the stop feature was BUILT for) runs with `_walkLive === false`: typing "stop" replies "Nothing is running right now" while the loop keeps opening tabs. REPLAYs are not in `_activeInvocations`, so the cancel half does nothing either.
**Change:**
- Replace the single boolean with a module-scope `_runLive = { walk: 0, plan: 0 }` (or one refcount) — `_orchRunPlanIR` increments/decrements in try/finally; `_orchWalkWorkflow` likewise.
- `_stopLongRunning` sets `_walkAbortFlag.requested = true` when **either** count > 0, and reports which ("stopping the walk" / "stopping the running plan").
- `_orchRunPlanIR` clears any stale flag at ENTRY (mirror of the walk's v2.74.907 clear).
**Accept:** manual: run a ≥3-iteration foreach plan from chat (not via a walk), type "stop" mid-run → halts at next node with `STOP ▸ plan halted between nodes`; "stop" with nothing running still says nothing is running.
**Files:** chat.js. **Size:** S.

### CR-S2 · Abort propagates OUT of loops instead of being swallowed as a per-item skip
**Problem (verified):** `_stopHit()` consumes the flag on first hit (chat.js:917-918, `requested = false`), returns `{ok:false}` from `exec.fragment` — and `Core/orchRun.js:160` treats that as a lenient per-item failure: `if (!r.ok) { skipped++; continue; }`. One "stop" skips ONE iteration of N; the flag is already cleared so the rest run.
**Change:**
- `_stopHit()` no longer clears the flag; it only reads it. The flag is cleared ONCE in `_orchRunPlanIR` after `walkPlan` returns (and at entry per CR-S1).
- exec callbacks return `{ok:false, aborted:true, error:'stopped by user'}`.
- `Core/orchRun.js` walker: any child result with `aborted:true` propagates immediately out of `foreach`/`loop`/`_walk` (trace entry `{kind:'foreach', aborted:true, done, items}`) instead of lenient-skip. Same check in the `loop` case.
**Accept:** unit tests in `Core/orchRun.test.js`: a body whose exec returns `aborted:true` on iteration 2 of 5 → foreach returns `{ok:false, aborted:true}`, trace shows `done:1`, NOT `skipped:4`; lenient behavior unchanged for plain `{ok:false}`.
**Files:** chat.js, Core/orchRun.js, Core/orchRun.test.js. **Size:** S. **Depends:** CR-S1.

### CR-S3 · Every walk exit path ends the walk (shared `endWalk`), and stop-at-end reads correctly
**Problem (verified):** all three walk "Stop" buttons just `bar.remove()` (chat.js:1956 etc.) — `next()` never runs, recap never renders, `_walkLive` stays true forever (resets exist only at chat.js:1855/1862); the `catch` at ~1935 doesn't reset either. A later "stop" then arms a stale flag that instantly aborts the NEXT plan run. Separately, the abort check precedes the done check, so stopping during the last step renders "Stopped the walk at step N+1 of N" for a walk that actually finished (chat.js:1854 ordering).
**Change:**
- One `_endWalk(st, i, reason)` helper: marks step i (`'stopped'`), renders `_walkRecap`, sets `_walkLive=false` (decrements per CR-S1), clears the flag. Called from: all Stop buttons (incl. `_walkReteach`'s), the no-tab Stop, the `catch` block, the abort branch, and the done branch.
- Swap the order at the top of `_walkStep`: `i >= steps.length` first (finished → normal recap, clear flag), abort second.
- Reentrancy guard: `_orchWalkWorkflow` refuses (chat message) if a walk is already live, or aborts the prior one explicitly first.
**Accept:** manual matrix: Stop button mid-walk → recap renders, later "stop" says nothing running; stop typed during final step → "Walk finished" recap, not "step 5 of 4". Walk ledger entries unchanged for normal paths.
**Files:** chat.js. **Size:** M. **Depends:** CR-S1.

### CR-S4 · Cancellation threads into mid-step waits (TemplateWalker + engine + LLM)
**Problem (verified):** `checkConditions` (TemplateWalker.js:1409, poll loop ~1616) has NO `isAborted` parameter — gate retries and 5s postcondition probes run out their windows after cancel. The WAIT action is one unsliced sleep (TW:4049). `AnthropicService.#call` (AS:5044) has no AbortSignal, so a frontier sieve finishes its ~29s call post-cancel. The engine's WAIT **node** already does this right (EE:1163, 100ms-sliced) — copy that pattern.
**Change:**
- `checkConditions(..., { isAborted })` optional param, checked each poll tick → returns `{failures:[{condition:{type:'aborted'}, reason:'cancelled'}], passed, aborted:true}`; callers (executeFragment pre/post, gate retry) treat aborted as terminal-cancelled, not failed.
- WAIT action sleep sliced at 100ms with the same check.
- `#call` accepts an optional `signal`; CapabilityAPI's invocation wires an AbortController aborted by the same cancel that flips `STATUS.CANCELLED`. (Full retry/timeout work is CR-E5 — here only the signal plumb.)
**Accept:** manual: start a strategy with an 8s WAIT_FOR gate, cancel at t≈1s → invocation ends within ~1 poll tick, log shows cancelled (not failed). Unit: a fake isAborted=true makes checkConditions return aborted on first tick.
**Files:** Services/TemplateWalker.js, Services/ExecutionEngine.js (call sites), Services/AnthropicService.js, Services/CapabilityAPI.js. **Size:** M.

### CR-T1 · Fix the Logger×ErrorCapture echo (every WARN/ERROR double-logged with a garbage source)
**Problem (verified):** ErrorCapture's console patch sets `__agentHubInsideLogger` only on the console→Logger path (ErrorCapture.js:152-158). `Logger.#emit`'s own console mirror (Logger.js:274-276) runs unguarded → re-enters the patch → second Logger entry whose source is the extracted `[timestamp]` (the `WARN background:2026-06-10T04:32:38.240Z […] [WARN] [TemplateWalker]` duplicates in live traces). Doubles ring churn; breaks grouping.
**Change:** in `Logger.#emit`, set `globalThis.__agentHubInsideLogger = true` in a try/finally around the four console mirror calls. (Do NOT add prefix-sniffing in ErrorCapture — the guard is the contract.)
**Accept:** new `Core/Logger.test.js` (Logger is currently untested): patch a fake console capturing calls, install ErrorCapture-style wrapper, call `Logger.warn` → exactly ONE persisted entry. Manual: next `gl` trace shows no `background:<timestamp>` duplicate lines.
**Files:** Core/Logger.js, Core/Logger.test.js (new). **Size:** S.

### CR-M1 · Refcount `_engineBusyTabs` and route every marker through the helper
**Problem (verified):** plain Set (sg.js:100-107) — chat stays interactive during a minutes-long EXPLORE; an alias-hit REPLAY on the same tab `finally`-deletes the flag mid-sweep → the rest of the sweep's pokes are recorded as user interactions (the .908/.911/.912 bug re-opened by overlap). REPLAY bypasses the helper with raw `add`/`delete` (sg.js:2782/2875).
**Change:** `const _engineBusy = new Map(); // tabId → depth`; `markEngineBusy(tabId, busy)` increments/decrements (floor 0, delete at 0); `INTERACTION_RAW` checks `_engineBusy.has(tabId)`. REPLAY's raw calls routed through the helper.
**Accept:** unit-ish (export a probe or test via handler harness if impractical, else assert by code review + live retest): explore + replay overlapping on one tab keeps the tab busy until BOTH finish. Live: trigger a replay mid-explore → zero `INTERACTION miss` lines.
**Files:** background/handlers/sg.js. **Size:** S.

### CR-M2 · Cover the unmarked engine click-emitters (incl. the twin that missed .912)
**Problem (verified):** `CLICK_SELECTOR` (sg.js:2436 — the per-item action of click-in-place loops), `INVOKE_WORKFLOW` (background.js:4226), and `RUN_PERSPECTIVE_TRIAL` (background.js:6047 — the un-migrated twin of RUN_SG_TRIAL that silently missed the .912 busy fix) all drive synthetic DOM events with no busy marking. NOTE: the demonstration recorder must stay UNMARKED — its clicks are the signal.
**Change:** mark inside the shared `_runTrialBundle` helper (covers both trial entry points at once); wrap CLICK_SELECTOR with the try/finally pattern. Uses CR-M1's refcount. **Implementation finding (.923):** INVOKE_WORKFLOW needs NO handler-level wrap — the executor runs its per-step capabilities through `ctx.runCapability` → the REPLAY_SG_CAPABILITY handler, which marks busy itself (transitively covered). Known gap: a trial with `targetTabId:null` lets the engine open its own tab, invisible to the helper — closes with CR-X3.
**Accept:** live: a tier2 trial from the SIDE PANEL (not chat) produces zero `INTERACTION miss` lines; a demonstration still produces OBS/`INTERACTION_RECORD` lines.
**Files:** background.js, background/handlers/sg.js. **Size:** S. **Depends:** CR-M1.

### CR-B1 · Finish v2.74.913: typeable disclosures pass bind's five `kind==='input'` gates
**Problem (verified):** .913 made a combobox (kind=disclosure + fieldType:'text') a FILL in trialSynth/accept but bind.js still gates on `kind === 'input'` at FIVE sites: `_formEssential` (bind.js:132 — goal expansion won't admit the keyword field when only the submit anchored → empty-q submit re-opened via the expansion path), inputRoles seed (156), goalInputBound (172), expansion input-branch (177), and `filledInputIds` (272 — FILLS-must-SUBMIT won't pull Search for a combobox-only fill). Also the .880 same-label dedup no longer sees comboboxes anywhere (they left `acts`) → two same-label search boxes TYPE twice.
**Change:** export `isFillableFeature(f)` from trialSynth (input OR typeable disclosure — reuse `isTypeableDisclosure`'s feature-side logic); bind imports it and uses it at all five gates (the `.880` collapse includes typeable disclosures in its input scan).
**Accept:** `Core/bind.test.js`: (1) goal with submit + combobox member (kind=disclosure, fieldType text) anchored only by the submit → combobox bound; (2) two same-label comboboxes both anchored → ONE survives; (3) combobox-only selection on a goal with a submit → submit pulled in. Re-run full suite.
**Files:** Core/trialSynth.js, Core/bind.js, Core/bind.test.js. **Size:** M.

### CR-T2 · Quick-truth batch: missing EXIT lines, lying envelopes, dead counts, the 4s tax
**Problem (verified, four small items):**
1. RUN_SG_TRIAL's "every exit logs" invariant misses the no-bindable-roles return (sg.js:584) and the page-drift return (~592 — plain warn, no `▸ EXIT` marker) — exactly the exits a walk hits on a wrong page.
2. `OPEN_URL_NEW_TAB` answers `success:true, ok:false` on failure (sg.js:2465) and `_tryRouterNav` checks only `success` (chat.js:~2406) → failed nav renders "Opened host."
3. The .910 explore verb reads `s.features`/`s.goals` off a response that carries `{surface, controls, planned, stats…}` — counts are always null (chat.js:2436 vs background.js:5391). The real counts are computed at background.js:~5504 (Locale build).
4. The "TESTING (v2.74.647)" unconditional 4s inter-phase pause (sg.js:516-523) shipped ~270 patches ago; `_settleAfterNav` (SG-T2-8) made it redundant. Every multi-phase trial pays 4s×(phases−1).
**Change:** add the two `RUN_SG_TRIAL ▸ EXIT` lines; return `success:false` from OPEN_URL when the tab didn't open (and align `_tryRouterNav`); attach `featureCount`/`goalCount` to the EXPLORE response from the Locale-build values and read those in chat; delete the 4s pause (or gate behind a `_SG_DEBUG_PACING` flag, default off).
**Accept:** live trace shows `▸ EXIT` on a wrong-page trial; "go to <unopenable>" reports failure; explore reply shows real counts; multi-phase trial wall-clock drops ~4s/phase.
**Files:** background/handlers/sg.js, chat.js, background.js. **Size:** S.

### CR-I1 · Bring the test harness INTO the repo + package.json
**Problem (verified):** the ONLY way to run the 687-test suite is `node --experimental-loader %TEMP%/ahub-harness/loader.mjs %TEMP%/ahub-harness/runner.mjs Core/*.test.js Services/*.test.js` — four files (`loader.mjs`, `runner.mjs`, `shim.mjs`, `dfcheck.mjs`) in a temp dir Windows can clean any day. No package.json, no pinned node assumption (machine runs 16.15.1, which lacks `node:test`).
**Change:** copy the harness to `tools/test-harness/` (commit it); add root `package.json` (`"private": true`, `"type": "module"` if compatible with `node --check` usage — VERIFY first; if `type:module` breaks anything, omit it and keep loader-based runs) with `"scripts": { "test": "node --experimental-loader ./tools/test-harness/loader.mjs ./tools/test-harness/runner.mjs Core/*.test.js Services/*.test.js" }`; README-stub `tools/test-harness/README.md` documenting the node-16 constraint. Update the `bcp` habit to `npm test`.
**Accept:** `npm test` → 687+ passing from a clean checkout path. `node --input-type=module --check < background.js` still works.
**Files:** tools/test-harness/* (new), package.json (new). **Size:** S.

### CR-I2 · Mirror-sync test (turn silent drift into a red test)
**Problem (verified):** 7 hand-synced contentScript↔Core mirror pairs; 6 byte-identical today (`isStableIdent`, `isAutoGeneratedClass`, `classifySelectorTier`, `mostDurableUnique`, `TRIAL_SELECT_FIRST`, `DESTRUCTIVE_LABEL`), and the NEWEST has already drifted: the interaction-monitor mirror (CS:5821-5838) lacks Core/interactionCapture's `focusout:'blur'` mapping and the `role==='password-input'` sensitivity rule despite a "verbatim" comment.
**Change:** new `Core/mirrorSync.test.js`: reads `ContentScripts/contentScript.js` source text, regex-extracts each mirrored definition, asserts string equality with the Core export (or its source slice). First fix the interactionCapture drift (add `focusout` listener + kind-map entry + the password-role rule to `_imSensitive`) or — decision — document blur as intentionally uncaptured and assert the documented subset.
**Accept:** test fails if anyone edits either side of any mirror alone.
**Files:** Core/mirrorSync.test.js (new), ContentScripts/contentScript.js. **Size:** S. **Depends:** CR-I1 (suite entry).

---

## Phase 2 — engine + storage correctness

### CR-E1 · Postcondition nav-relax reads the failure envelope (the .815 feature has never fired)
**Problem (verified):** EE:937 filters on `f.type === 'url_matches' && f.pattern`, but `checkConditions` emits `{condition, reason}` (TW:1595) — `f.type` is always undefined, the early-return keeps every failure, the relax branch + its .818 explainer log are unreachable. The "click that navigates is failed by its own auto-derived url_matches" symptom still occurs.
**Change:** destructure `const c = f?.condition ?? {}` and filter on `c.type`/`c.pattern` (mirror the sibling formatter at EE:5259).
**Accept:** unit test (new `Services/ExecutionEngine` pure-helper extraction OR a focused test via a tiny exported `_relaxNavPostFailures(failures, nav)` — extract the filter into a pure exported helper to make it testable): a real-shaped failure `{condition:{type:'url_matches',pattern:'p'},reason}` with nav from-matches/to-doesn't → relaxed; third-page pattern → kept.
**Files:** Services/ExecutionEngine.js (+ small pure helper + test). **Size:** S.

### CR-E2 · Split the retry regex — never re-send possibly-executed actions
**Problem (verified):** TW:3347's RETRYABLE includes `message channel.*closed`, which can mean the content script EXECUTED the step then tore down (click-triggered nav) before responding; retry re-clicks on the new page (double-submit hazard).
**Change:** RETRYABLE keeps only `Receiving end does not exist|Could not establish connection|back\/forward cache`. `message channel.*closed` becomes retryable ONLY for an allowlist of idempotent message types (`DOM_SNAPSHOT`, `CHECK_CONDITION`, `WAIT_FOR_ELEM`, `FOCUS_CHECK`, reads); for EXECUTE_STEP it surfaces as a distinct error (`'channel closed mid-step — page may have navigated; not retried'`) so the caller's nav-detection handles it.
**Accept:** unit test on the exported predicate (extract `#isRetryable(err, messageType)` as a testable pure function). Manual: a CLICK that navigates away still completes the fragment via the existing navigation handling, with the new log line.
**Files:** Services/TemplateWalker.js (+ test). **Size:** S.

### CR-E3 · Content-script hardening: XPath guard, WAIT_FOR poll safety, OBSERVE_START
**Problem (verified):** (a) `resolveElement`'s XPath branch calls `document.evaluate` unguarded (CS:503-505) — malformed LLM-authored XPath throws; inside `WAIT_FOR_ELEM`'s setTimeout poll the throw kills the loop with `sendResponse` never called → caller hangs to timeout; sync handlers (FOCUS_CHECK/CHECK_ELEM) die with port-closed. (b) `OBSERVE_START` observes `document.body` which is null at document_start/XML docs → sync TypeError before sendResponse; an aborted run leaks a whole-body MutationObserver until the next OBSERVE_*.
**Change:** try/catch around the `document.evaluate` call returning null; wrap `handleWaitFor.attempt()` body in try → `sendResponse({success:false, error})`; `OBSERVE_START`: `if (!document.body) return {success:false, error:'no body'}`, try-wrap the case, add a 60s auto-disconnect timeout on the observer (cleared by OBSERVE_READ/next START).
**Accept:** manual via Studio: WAIT_FOR with selector `"//["` returns a structured failure fast instead of hanging.
**Files:** ContentScripts/contentScript.js. **Size:** S.

### CR-E4 · Loop budgets everywhere + IN_NEW_TAB leak
**Problem (verified):** (a) engine-side FOREACH (EE:1060) is unbounded — LOOP self-caps at 100 (EE:3103), the chat plan interpreter got .915's cap/confirm, the deterministic engine got nothing; (b) .915's own confirm gate checks only DIRECT body children for fragments (orchRun.js:111 `s.body.some(b.kind==='fragment')`) — `foreach → gate → fragment` skips the confirm (cap still applies); (c) IN_NEW_TAB's failure paths return without clearing the 5s timer or catching `newTabPromise` → unhandled rejection + stray timer per trigger failure (EE:4884-4924).
**Change:** (a) honor optional `node.maxItems` in `#executeForEachNode` with engine default 200 and a loud `max_exceeded`-style failure mirroring LOOP's; (b) make `bodyActs` a recursive scan over `body`/nested control nodes; (c) `newTabPromise.catch(()=>{})` + `clearTimeout` on every early return.
**Accept:** orchRun.test.js: nested `foreach→gate→fragment` with 9 items triggers the confirm callback; engine change verified by a focused test if extractable, else live + code review. No unhandled-rejection log on a failed IN_NEW_TAB trigger.
**Files:** Services/ExecutionEngine.js, Core/orchRun.js (+test). **Size:** M.

### CR-E5 · AnthropicService `#call`: timeout, bounded retry, robust extraction
**Problem (verified):** `#call` (AS:5044) is single-attempt, no AbortSignal/timeout, no 429/529 handling; text read as `content?.[0]?.text` (breaks on multi-block). Sync/Cloud layers also have zero retry (separate, out of scope here).
**Change:** one bounded retry (e.g. 2 attempts, jittered 1–3s backoff) for 429/5xx/network-fail; AbortSignal timeout (default 60s, callers can pass less; the proxy's hard 29s makes >35s pointless for ops-tier — pick per-role); extraction via `data.content.find(b=>b.type==='text')?.text`. Honor CR-S4's cancel signal (one signal, two sources: timeout + user-cancel).
**Accept:** existing live behavior unchanged on success; manual fault-injection (bad URL) shows one retry then clean failure. NOTE the 29s proxy ceiling — retry must not push a route past wall-clock limits on the walk path; ops-tier calls get max 1 retry.
**Files:** Services/AnthropicService.js. **Size:** M. **Depends:** CR-S4 (signal plumb).

### CR-ST1 · Serialize record-level read-modify-writes (landmarks/fragments)
**Problem (verified):** v2.74.119 serialized INDEX ops only; `updateLandmark` (SM:2273), `updateFragment` (~1524), and `saveLandmark`'s merge (~2193) are unserialized get→merge→set — with three real concurrent landmark writers (TemplateWalker's mid-run recovery persist at TW:3962/4002 fire-and-forget, accept-time profile enrichment background.js:1421-1444, LandmarkVerifier). Lost updates of lifecycle/profile/recovered-selector fields.
**Change:** add a generic `#updateRecord(key, patchFn)` that runs get→patch→set inside the existing chain (or a per-key chain map to avoid serializing unrelated records); route the three methods through it.
**Accept:** unit test with a mocked storage layer: two interleaved updateLandmark patches both land. Suite green.
**Files:** Services/StorageManager.js (+ test if the storage mock pattern exists; else assert via focused harness test). **Size:** M.

### CR-ST2 · Serialize GroundEventBus + sgCapabilities; close the alias-template gap
**Problem (verified):** (a) `GroundEventBus.emit` is unserialized RMW (GEB:119) with fire-and-forget callers — adjacent landmark probes drop events; (b) `sgCapabilities:<ground>` whole-array rewrites race: chat fires ORCH_RECORD_ALIAS unawaited per step while REPLAY's self-heal prunes — a stale snapshot can resurrect a just-pruned capability (background.js:1347, sg.js:1749-1761; the de-poison loop does one write per pruned cap, widening the window); ORCH_RECORD_ALIAS also reads the list twice back-to-back; (c) the .905 alias template guard misses spaced placeholders: `/\{[a-zA-Z0-9_]+\}/` doesn't match `{job title}` (sg.js:1748).
**Change:** chain-promise around GEB's get-push-set; per-ground write chain for sgCapabilities writers (`_writeSgCapability`, alias record, prune); single read reused in ORCH_RECORD_ALIAS; guard regex → `/\{[^}]{1,40}\}/`.
**Accept:** unit: template guard rejects `{job title}`; race tests as feasible with mocked storage. Live: alias accretion + replay in one walk doesn't resurrect pruned caps (observe via Studio).
**Files:** Services/GroundEventBus.js, background.js, background/handlers/sg.js. **Size:** M.

### CR-M3 · Monitor session resilience across SW restarts + tab cleanup
**Problem (verified):** `_interactionSessions` (sg.js:72) is module-scope — an MV3 idle restart wipes it while content-script listeners keep posting; events then resolve `groundId:null` and the C5 outcomes flush silently drops them (`if (!groundId…) return`). No `chrome.tabs.onRemoved` cleanup exists for `_interactionSessions` or `_engineBusyTabs`.
**Change:** INTERACTION_RAW: on session-map miss, fall back to `_groundIdForUrl(raw.url, grounds)` and re-seed the map; add one `tabs.onRemoved` listener clearing both maps.
**Accept:** manual: kill the SW (chrome://serviceworker-internals or extension reload of worker), click on a monitored ground → events still carry groundId (visible in the ground panel feed).
**Files:** background/handlers/sg.js, background.js. **Size:** S. **Depends:** CR-M1.

### CR-B2 · Typeable-disclosure follow-throughs: volatile reads + landmark identity
**Problem (verified):** (a) trialSynth's volatile-suggestion drop filters `fills`+`acts` but not `reads` (trialSynth.js:218-226) — a collection revealed by a typed combobox stays as the EXTRACT proof target → guaranteed extractQuality=0; (b) `landmark._roleFromKind` maps ALL disclosures to `'button'` (landmark.js:22) — recovery for a typed combobox probes for a BUTTON named like the text box (only when no a11yRole was captured).
**Change:** extend the volatile predicate to `reads` (skip + same reason); `_roleFromKind`: disclosure + `fieldType==='text'` → `'combobox'`.
**Accept:** trialSynth.test.js: read role hidden←typed-combobox is skipped, EXTRACT falls to a stable read or `runnable` reflects honestly; landmark.test.js: proto-landmark role for typeable disclosure is `combobox`.
**Files:** Core/trialSynth.js, Core/landmark.js, tests. **Size:** S. **Depends:** CR-B1 (shares predicate).

### CR-U1 · Persist grounded-path assistant output (transcript survives reload)
**Problem (verified):** `appendMessage` persists only `role === 'user'` (chat.js:388); `_persistMessageUpdate`/finalize run only on the legacy match path (5 call sites ~2646-3208). Every ORCH bubble — run results, read values, recaps, intent menus — vanishes on panel reload; rehydration shows a user-only transcript. The PRIMARY surface doesn't survive reload.
**Change:** `_orchFinalize(msg)` helper persisting `{role:'assistant', body: msg's text}` via the existing ConversationStore path; call it at the TERMINAL `_setMessageBody` of each flow: run result, read value, walk recap, plan summary, explore result, intent-menu render (persist title list as text; chips don't need to rehydrate as buttons — text fallback acceptable, note in code).
**Accept:** manual: run a capability + a walk, close/reopen the panel → assistant turns visible. No double-persist on streamed legacy paths (guard: only messages never touched by the legacy finalize).
**Files:** chat.js. **Size:** M.

### CR-U2 · Stale-tab + double-explore guards
**Problem (verified):** (a) `_walkEnsureTab` swallows `tabs.update` rejection and returns the dead id (chat.js:1795) — walks seeded from stale intent cards fail every step; (b) EXPLORE_PAGE_STRUCTURE has no per-tab in-flight guard while chat's 120s `_orchReq` timeout invites a second concurrent sweep (interleaved scrolls/pokes, double Locale writes, busy-flag fights) — background.js:5151; compare START_DISCOVERY's guard (background.js:6762).
**Change:** (a) on update/get failure, fall through to the `chrome.tabs.create(si.groundUrl)` branch; (b) module-scope `_exploreInFlight = Map<tabId, Promise>` — second caller gets `{success:false, error:'explore already running on this tab'}` (or awaits the same promise; pick coalesce — friendlier for the .910 chat verb).
**Accept:** manual: click a stale chip with its tab closed → walk opens a fresh tab; type "explore" twice fast → one sweep, second reply explains.
**Files:** chat.js, background.js. **Size:** S.

### CR-U3 · Chat pick + pending-bar lifecycle
**Problem (verified):** (a) `_orchPickOnce` hand-rolls START_PICK (chat.js:1175), bypassing shared.js's frame-aware `broadcastStartPick`, and on its 120s timeout (or walk Stop/Skip) never sends CANCEL_PICK — the page picker stays armed and a later click emits an unconsumed PICK_RESULT; (b) pending walk/loop button-bar promises (e.g. `exec.confirmLoop`, chat.js:955) never settle when the conversation is cleared/switched — `_cancelOpenParamForms` covers only `.param-form/.param-modal` → `walkPlan` awaits forever (+`_walkLive` wedge pre-CR-S3).
**Change:** (a) import `broadcastStartPick`/`broadcastCancelPick`; `finish()` sends cancel when resolving null; (b) module-scope Set of pending bar resolvers; every `_orchActionBar` promise registers a canceller; `_cancelOpenParamForms` (rename `_cancelPendingInteractions`) drains it resolving `{ok:false, cancelled:true}`.
**Accept:** manual: abandon a chat pick → page overlay disarms; clear chat mid-confirm → no hung walk (recap renders 'cancelled' via CR-S3's endWalk).
**Files:** chat.js. **Size:** M. **Depends:** CR-S3.

---

## Phase 3 — duplication consolidations (each pure, tested, mechanical)

### CR-D1 · One `pageKey(url)` — and heal the slash fork WITHOUT forking identities
**Problem (verified):** 6+ URL canonicalizers; live disagreement: accept's `_urlScopePattern` KEEPS the trailing slash (accept.js:37) while siteMap's `normalizePattern` STRIPS it (siteMap.js:38) → `/jobs` vs `/jobs/` mint different `mintPerspectiveId`s and `findMatchingPerspective` fails to dedup. GroundAssetStore's copy is byte-identical to accept's; observedSegment/postcondition/GroundMatcher are deliberate other tiers (keep, documented).
**Change:** new `Core/pageKey.js` (origin + pathname, trailing slash stripped, no query) + tests. **Identity-compat rule:** do NOT change the bytes feeding EXISTING `mintPerspectiveId` retroactively — instead (a) adopt pageKey for NEW mints, and (b) make `findMatchingPerspective`'s comparison slash-insensitive (compare via pageKey on both sides) so old `/jobs/`-keyed records still match. siteMap + GroundAssetStore adopt pageKey directly (their keys are comparison-time).
**Accept:** unit: `/jobs` ≡ `/jobs/` for match; existing fixture perspectives still found; siteMap merge dedups the pair.
**Files:** Core/pageKey.js (new), Core/accept.js, Core/siteMap.js, Services/Storage/GroundAssetStore.js, tests. **Size:** M.

### CR-D2 · One `slugUpper(label, {maxLen, maxWords, fallback})` — HS-2's wiring depends on it
**Problem (verified):** five UPPER_SNAKE builders with drifted caps (tier2Lower `_scopeName` uncapped; capabilitySynth `_paramName` 40 chars; observedSegment 40; observe 3 words; orchChain 3 words) and four fallbacks (RESULT/INPUT/PARAM/VALUE). HS-2 (capabilitySynth wiredParams) wires by NAME EQUALITY between an observation `output` and a param name — different builders on a long label silently fail to wire.
**Change:** `Core/slug.js` exporting `slugUpper` (and optionally `slugKebab` for accept's `_paramKey`); all five adopt with their current per-site options EXCEPT the two HS-2-coupled sites (tier2Lower outputs + capabilitySynth params) which MUST share identical options — set both to `{maxLen:40, fallback}`.
**Accept:** test: a 60-char label round-trips identically through the observation-output path and the param path → HS-2 wiring connects. Existing tests green (fallbacks preserved per site).
**Files:** Core/slug.js (new), tier2Lower.js, capabilitySynth.js, observe.js, observedSegment.js, orchChain.js, tests. **Size:** M.

### CR-D3 · Single READ_VERB + intentShape tests
**Problem (verified):** trialSynth.js:48 and intentShape.js:32 define same-tier READ_VERB lexicons that have forked (intentShape knows discover/count/fetch/locate/understand; trialSynth knows capture/check) — "count the results" is read-shaped at SG-1 but gets no proof EXTRACT at synth. intentShape has NO test file.
**Change:** union the lexicons in intentShape, export `READ_VERB`; trialSynth imports it; new `Core/intentShape.test.js` pinning the lexicon + shape classification. (`observe._READVERB` is anchored/leading-verb — a different tier; leave, with a comment pairing them.)
**Accept:** trialSynth test: "count the results on the page" with fills+reads emits the EXTRACT.
**Files:** Core/intentShape.js (+new test), Core/trialSynth.js. **Size:** S.

### CR-D4 · One binding resolver
**Problem (verified):** paramBindings resolution ×4 with divergent semantics — `#resolveFragmentBindings` (EE:5180, missing→unset, list→join', '), `#resolveSieveParamBindings` (EE:2863, missing→'', records JSON-stringified), NAVIGATE inline (EE:3290-3305, list→error), WorkflowExecutor.resolveBinding (WE:206). v2.50's `field` support exists in one copy.
**Change:** `Services/Engine/Bindings.js` (or Core if chrome-free — it is): `resolveBinding(binding, source, {onMissing:'unset'|'empty'|'error', list:'join'|'error'|'first', field})` + `resolveBindings(map, source, policy)`. Four call sites adopt with their current policies EXPLICIT. Unit tests for each policy + the `field` path.
**Accept:** suite green; behavior table in the module doc comment matches the four legacy behaviors exactly (no semantic change in this slice — consolidation only).
**Files:** new module + EE, WorkflowExecutor, tests. **Size:** M.

### CR-D5 · One `waitForTabReady`
**Problem (verified):** six implementations (EE:5294 resolve-on-timeout/1000ms grace; TW:4028 resolve/800ms; TW:4322 REJECTS; PageProbe:123 15s; WorkflowExecutor:472; DiscoveryService:309), divergent on timeout behavior and the already-complete race.
**Change:** `Services/TabUtils.js` → `waitForTabReady(tabId, {timeoutMs=30000, graceMs=800, rejectOnTimeout=false})` handling the already-complete race via parallel `tabs.get` poll; six sites adopt with their current flags.
**Accept:** suite green; manual smoke on navigate-heavy strategy.
**Files:** new module + 6 call sites. **Size:** M.

### CR-D6 · One LLM transport: fold the three frontier fetches into `#call`
**Problem (verified):** `invokeAnalysisRecovery` (AS:6192, hardcoded 'claude-sonnet-4-5'), `invokeAnalysisFrontierPrimary` (AS:6493), `invokeObservationFrontier` (AS:6697) hand-roll fetch — bypassing the audit ring (#audit lives only in #call), cost logging, and model policy. Two duplicate brace-matching JSON scanners (#firstJsonObject AS:4981 vs #extractJson AS:5118) with different failure contracts.
**Change:** extend `#call` with `{tools, tool_choice, model, maxTokens, system}` options (keeping the audit/cost/usage plumbing); migrate the three; replace hardcoded model strings with the policy constants. Keep ONE scanner with `{bestEffort}` flag; migrate the 3 `#extractJson` callers; delete the other.
**Accept:** audit ring shows entries for a frontier observation run; cost log present; live frontier observation still works (retest on a vision-tier read).
**Files:** Services/AnthropicService.js. **Size:** M. **Depends:** CR-E5 (lands the retry/timeout these calls then inherit).

### CR-D7 · Extract chat's pure logic: walk ledger, plan scanners, step-runner, plan renderer
**Problem (verified):** `_walkRecap` + outcome rules are untested pure logic in the DOM file (the stop-at-end bug proves the cost); three near-identical recursive plan walkers (`_collectBindings`, driver scans); `_orchRunPlan` vs `_orchRunChain` duplicate ~40 lines of step-runner (read/REPLAY/alias/settle/offer-record) that have ALREADY drifted; the gate-folding plan renderer is verbatim-duplicated (chat.js:843 vs 1550).
**Change:** `Core/walkLedger.js` (recap/fold + tests incl. stop-at-end, preSkipped); `scanPlan(steps, visitor)` added to Core/orchRun.js (three walkers adopt); `_runResolvedStep` shared helper in chat.js (per-caller deltas stay at call sites); `renderPlanLines(steps)` moved to Core/orchVisual.js + tests; both confirm-cards consume it.
**Accept:** new tests for ledger + renderPlanLines; suite green; visual smoke of confirm cards.
**Files:** chat.js, Core/walkLedger.js (new), Core/orchRun.js, Core/orchVisual.js, tests. **Size:** L (can split ledger/renderer vs step-runner). **Depends:** CR-S3 (endWalk consumes the ledger).

### CR-D8 · Small-dup batch
**Problem (verified):** bind `_fillType` mirrors trialSynth.fillOpFor (no drift, unnecessary — bind already could import); workflows `_normLabel` byte-copies siteMap.normalizeGoalLabel (whose export comment promises exactly this reuse); sg.js demand-set block duplicated (GET_INTERACTION_DEMAND vs INTERACTION_MONITOR_START, sg.js:1216 vs 1077) and the substrate preamble duplicated (PROPOSE_RICH_INTENTS vs GET_INTENT_MENU, sg.js:1027 vs 987); `handleInvocation{Started…Cancelled}` family duplicated chat.js:2808 vs strategy-debug.js:347; `truncate` ×4; intentContext `_PLACEHOLDER_RE` `/\{[^}]*\}/` accepts `{}`/`{two words}` that chat's extractor will never fill — tighten to `/\{[a-zA-Z0-9_]+\}/` (note: keep consistent with CR-ST2's alias-guard decision — the GUARD stays broad on purpose; the REPAIR target stays narrow; comment the asymmetry).
**Change:** bind imports fillOpFor; workflows imports normalizeGoalLabel; extract `_demandForGround`/`_groundSubstrate` in sg.js; move invocation handlers + truncate into shared.js (or a shared events module); tighten `_PLACEHOLDER_RE`. **Status (.942):** DONE — fillOpFor adoption (bind's `_fillType` mirror deleted), normalizeGoalLabel import, `_PLACEHOLDER_RE` tightened to the fillable-slot shape (+ test; the broad alias GUARD stays broad by design — asymmetry documented at both sites). **DEFERRED to the CR-X3/X4 passes:** the sg.js `_demandForGround`/`_groundSubstrate` helper extraction (touches the same handlers X3 migrates) and the shared.js truncate/invocation-handler moves (UI refactor, pairs with X4's studio work).
**Accept:** suite green; intentContext test for the `{two words}`-is-not-a-slot rule.
**Files:** Core/bind.js, Core/workflows.js, Core/intentContext.js (+test), background/handlers/sg.js, chat.js, Sidepanel/modes/strategy-debug.js, Sidepanel/shared.js. **Size:** M.

---

## Phase 4 — structural (the big seams; each its own mini-arc)

### CR-X1 · Strategy node-type registry (kills the 8-site dispatch)
**Problem (verified):** node.type dispatch at EE:596 (#executeNodes), EE:663 (#describeNodeForPause), EE:5001 (#executeSingleNode), EE:5061 (#executeBodyWithIterationLabel — exists ONLY to inject iterationLabel without changing a signature) + StrategyTree normalize(:~380-676, unknown→silent null)/walkNodes(:740)/computeIterationScopes(:777)/validateStrategyBody(:842) + ~12 Studio sites. Unknown-type handling disagrees (skip-warn vs hard-fail vs silent-null). Adding a node type = ~8 non-UI edits.
**Change (3 sub-slices):**
- **X1a:** `Services/Engine/nodeRegistry.js`: `{ type → { execute(node, ctx, opts), describe(node), childLists(node) } }`; `#executeNodes` consumes it; the registry's `execute` receives `{topLevelIndex, iterationLabel, iteration}` so…
- **X1b:** …`#executeSingleNode` + `#executeBodyWithIterationLabel` collapse into the one walker (delete both).
- **X1c:** StrategyTree's normalize/walk/validate read the registry's type table + childLists (single source for "what types exist + where children live"); unify unknown-type policy: validate=error, execute=fail-loud, normalize=null-with-warn.
**Accept:** suite green after each sub-slice; a grep proves one `node.type` switch remains in Services; a doc note in the registry: "to add a node type, edit THIS file + Studio form."
**Files:** Services/ExecutionEngine.js, Services/StrategyTree.js, new registry. **Size:** L (X1a M, X1b S, X1c M).

### CR-X2 · Extract SieveExecutor + ObservationExecutor (~2,400 lines out of the engine)
**Problem (verified):** `#executeObservationNode` ~850 lines (EE:3545), `#executeSieveNode` ~725 + four tier sub-executors — both leaf executors touching ctx only via `{tabId, scope, emit, isAborted}`; the sieve span contains ZERO isAborted checks.
**Change:** move to `Services/Engine/ObservationExecutor.js` + `SieveExecutor.js` registered via CR-X1a; add isAborted checks at sieve tier boundaries + per-record loops while moving.
**Accept:** suite + live smoke (one cache observation, one sieve strategy); engine file shrinks ≥2,000 lines.
**Files:** Services/ExecutionEngine.js → two new modules. **Size:** L. **Depends:** CR-X1a.

### CR-X3 · Finish the handler migration (domain slices) + validated ctx
**Problem (verified):** the seam is now measurably harmful: `ctx` has 18 keys, docs list 13, validated nowhere (sg.js:387 vs background.js:1681); three hand-rolled sendResponse→Promise bridges (background.js:4236, 1717, _autoMonitorTab); RUN_PERSPECTIVE_TRIAL vs RUN_SG_TRIAL proves fixes land one-sided (it missed .912).
**Change:** (a) `assertCtx(ctx)` throwing at startup listing missing keys + JSDoc updated to all 18; (b) export ONE `invokeSgHandler(type, payload): Promise` used by the three bridges; (c) migrate domains in slices — X3a explore (EXPLORE_PAGE_STRUCTURE + ensureGroundForUrl + locale cache helpers), X3b discovery, X3c workflow-debug — each moving state + helpers together so no new cross-seam exports appear; retire RUN_PERSPECTIVE_TRIAL into the registry beside RUN_SG_TRIAL (sharing `_runTrialBundle` + busy marking).
**Accept:** per sub-slice: suite green + live smoke of the moved domain; background.js switch shrinks measurably (track case-count in the slice log).
**Files:** background.js, background/handlers/*. **Size:** L (a/b S, then M per domain).

### CR-X4 · Navigability mechanics: contentScript router map + studio renderer split
**Problem (verified):** contentScript's onMessage is ONE anonymous listener spanning ~5920-7986 (~80 cases, ~2,066 lines; the file header's type list names 6 of them); studio's `_refreshGroundListImpl` is ~1,263 lines re-running fully on every STORAGE_CHANGED (microtask "debounce" doesn't span macrotasks).
**Change:** contentScript: `const HANDLERS = { TYPE: fn, … }` map + a 10-line dispatcher (same file — no build step exists; mechanical move); studio: split `_refreshGroundListImpl` into per-section render functions (same file or `Studio/sections/*.js` — studio IS an ES module), and swap the microtask flag for a 150ms trailing `setTimeout` debounce.
**Accept:** suite untouched; live smoke: picker, explore, monitor still work; studio refresh visibly debounced on a cascading delete.
**Files:** ContentScripts/contentScript.js, studio.js. **Size:** L (split into two slices).

---

## Phase 5 — hygiene backlog (batch when convenient)

### CR-H1 · Dead/impure surface
- Delete `Core/ExtractionEngine.js` (zero importers, calls chrome from Core, @version 1.0.0).
- `Core/GroundMatcher.canonicalizeUrl` + `patternSpecificity`: zero importers while contentScript reimplements with different rules — delete the exports OR adopt as the single source with a mirror-sync entry (CR-I2). Decide when touching ground-matching next.
- `Core/locale.js` query API (7 exports, no consumers since task #22): demote to non-exported or delete.
- `Core/runtimeState.js`: documented landed-ahead-of-wiring — keep, add the ticket reference, or delete.
- Studio T3 'frontier' strategy tier: authorable but permanently stubbed since v2.72.27 (EE:195 vs StrategyForm.js:2088) — disable the button with a tooltip; keep storage tolerance.

### CR-H2 · @version header policy
Headers are a third, unmaintained version stamp (AnthropicService 2.19.0, EE 2.28.3, contentScript 2.17.12, trialSynth 2.74.645 … vs manifest 2.74.916). **Decision: delete all `@version` lines** — the inline `v2.74.X` markers + git are the convention. One mechanical sweep.

### CR-H3 · Tests for the four live-path untested Core modules
`intentShape` (lands with CR-D3), `GroundMatcher` (or deleted per CR-H1), `formCoverage` (two exports feed AnthropicService prompts; mark the unwired half with the PB-10 ticket), `outcomes` (hashId keys intentContext fingerprints). Logger gets its test in CR-T1.

### CR-H4 · Studio polish
`escAttr` on the raw `${ground.id}`/`${p.id}` attribute interpolations (ids arrive via cloud sync/import — not strictly trusted); drop `_DECISION_RE`'s dead `GET_GROUND_READINESS` alternative; consider word-prefix anchors on `STOP ▸`/`EXPLORE ▸`.

### CR-H5 · Recorder/monitor frame nits
Recorder dedupe uid is `seq-Date.now()` with frame-local seq — two frames can collide and drop a legit action: salt with a per-frame random token. Monitor `type` debounce is one shared timer — fast field-to-field typing (<400ms) drops the first field's event: key pending timers per element (WeakMap). Document the deliberate top-frame-only monitor scope. Convert the double-injection guard's `throw` to a silent no-op (it works correctly but logs an uncaught error in every frame's console on each redundant executeScript).

---

## Execution order (recommended)

| Batch | Slices | Theme |
|---|---|---|
| 1 | CR-S1 → S2 → S3, CR-T1, CR-M1 → M2 | stop works; traces truthful; monitor clean |
| 2 | CR-B1, CR-T2, CR-I1, CR-I2 | finish .913; quick truths; suite in-repo; mirrors guarded |
| 3 | CR-E1 → E3, CR-S4, CR-E4 | engine correctness |
| 4 | CR-ST1 → ST2, CR-M3, CR-E5 | storage + transport |
| 5 | CR-U1 → U3, CR-B2 | UX + teach follow-through |
| 6 | CR-D1 → D8 (any order; D3 with H3) | consolidations |
| 7 | CR-X1 → X4 | structure |
| 8 | CR-H1 → H5 | hygiene |

**Retest hooks (live, via `gl`):** after batch 1 — runaway-foreach + "stop" (halts), trace has no duplicate WARN lines; after batch 2 — Indeed-class combobox walk (trial TYPEs, no delete clicks, explore counts render); after batch 3 — cancel mid-WAIT_FOR (ends fast), nav-click capability scores pass (relax fires, log line appears).
