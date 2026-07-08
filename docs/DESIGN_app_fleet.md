# DESIGN_app_fleet — the FLEET app (workflow-anchored)

**Status:** FL-1..5 BUILT v2.74.1346 (propose-only sweep · pending queue · gated executor + staleness CAS · action
ledger · `ticket-manager` preset). **FL-1b + FL-1c BUILT v2.74.1347** (evidence round · ground-truth links,
reuse-then-navigate) · FL-1d read provenance v1349 · FL-1e work trace v1352 · FL-2b minimize-don't-truncate v1353 ·
**FL-6 clock trigger BUILT v2.74.1355 (§6b)** · FL-6b seed cadence v1356 · FL-6c card chip v1357 ·
**FL-8 UNATTENDED admin BUILT v2.74.1358 (§7)** — autonomy policy + headless executor + quota + digest/spike.
Live verification owed (real queue; the write path end-to-end; a scheduled unattended run).

## 1b. The evidence round (FL-1b, v1347 — from the first live sweep's lesson)

The first live run found a solve candidate but proposed nothing: phase A picks reads BLIND (3 breadth lists), and
the baseline rule ("look for the agent's last message actually resolving it") demands conversation-level evidence
the sweep never fetched — honest conservatism, starved of depth. Fix: phase B may return `needs` — targeted reads
(validated against the OFFERED read legs, ≤3) — the panel serves them and calls ONE final round (hard cap, never a
loop). Round 2's prompt says FINAL; needs are ignored. Honesty tweak alongside: a 0-proposal sweep with a non-empty
summary says "no actionable proposals — here's what I saw", never "nothing needs doing"; the `SWEEP ▸ reads` log
names the picked read keys.

## 1c. Ground truth: every claim links to its source (FL-1c, v1347)

The evidence quotes are the model's EXCERPTS; approval needs the RECEIPT. **The model never mints URLs** — links
assemble from TRUSTED data only: connection origin + the recipe's curated `itemUrl` template (`/agent/tickets/{id}`
on the Zendesk recipes; threaded recipe → `leg.tool.itemUrl`) + the target id sanitized to a plain token
(Core/proposals.targetUrls, tested against `../../evil`-class escapes). Surfaces: proposal-card targets render as
links; ledger targets too (`urls` on entries); `show N` verb + a 🔍 button on multi-target proposals.

**Reuse-then-navigate (one tab per origin, ever):** `SHOW_SOURCES` (background/handlers/connector.js) re-validates
urls against the claimed https origin, resolves the origin's EXISTING tab with the same `pickRideTab` session-ride
uses (the session tab IS the evidence tab), focuses it, and navigates it to each target sequentially — Zendesk's
agent workspace accumulates them as internal workspace tabs, so a merge's two tickets land side-by-side in ONE
browser tab. Only with no tab on the origin does it create one. The driven span is busy-marked (Invariant #2);
`SHOW ▸` is in `_DECISION_RE`.

**v1349 — FL-1d read provenance ("show me" after an ANSWER):** a claim's ground truth is the READ that produced
it. The panel stashes `_lastGroundedRead {leg, params, at}` at the connector-answer render sites; a bare
"show me" (no targets bound) resolves there whenever the read is fresher than the last proposal batch — never a
stale pending or an arbitrary item. Two receipt kinds: item claims → `itemUrl`; COLLECTION claims → the new
`listUrl` recipe template (the agent search page running the SAME query the API counted — my_open/pending/solved
+ search_tickets carry it; param-filled via fillEndpoint). No template → origin root with an honest "exact view
isn't mapped" note. Hygiene: a new sweep SUPERSEDES the prior pending batch (stale, ledgered) — old proposals
stop lingering as show-me bait.

**v1348 (user direction — conversational, and no static semantic routing):** NO hyperlinks anywhere — targets
render plain; the trusted urls stay on proposal/ledger RECORDS as provenance, never as anchors. Viewing is
CONVERSATIONAL, routed through the IL (the v1166 inversion, never regex): `palette.fleetOfferedLegs` offers two
console legs to interpret for a connected app — **REVIEW_QUEUE** ("review the queue", "clean this up" → the sweep)
and **SHOW_ITEM_SOURCES** (params {proposal|targets|origin} bound from the ask: "show me both tickets", "open
zendesk") — dispatched panel-side (chat.js `_showItemSources` → SHOW_SOURCES). Deterministic guards remain ONLY
for terse number-addressed console commands (`sweep`, `pending`, `approve 1,3`, `reject 2 <why>`, `show 2`,
`ledger`) — zero semantics, CLI-shaped; every natural phrasing goes through interpret.

**The build discipline this doc exists to enforce (2026-07-07, the "this is all wrong" correction):** we build
workflows, not abstract infrastructure — but the workflow's *intelligence* is never code. Everything the app "knows"
is either the model's judgment, a memory rule (taught/learned), or the type's baseline DATA. The code below is a
GENERIC harness any fleet app reuses.

## 1. The workflow (the anchor)

A ticket manager that reviews the queue, merges duplicates, closes resolved tickets, and assigns tickets — with the
chat as its console: direct it ("assign billing to Sara"), review it ("how many merges in the last hour?"), and
approve its actions. Later: on a clock (FL-6). The conversation is the app's CONTROL PLANE, not where the work
happens (DESIGN_conversations.md §6A still holds; this doc adds the run shape).

## 2. The app is data

- **Seed** — the goal, propose-only phrasing (the `ticket-manager` preset, Core/appCatalog.js).
- **Fence** — setup-banked connections + `writePolicy: 'gated'`.
- **Baseline** — a few generalizable behavior RULES in preset memory (merge-into-older, replied≠resolved,
  never-invent-assignees). Overridable, visible via `memory`, never compiled.
- **Everything domain-specific is TAUGHT, not shipped**: what "duplicate"/"resolved" mean here, routing rules,
  exclusions — `remember:` turns and reasoned rejections (each banked as an observation-tier delta the ratchet
  corroborates).

## 3. The run: sweep → propose → approve → execute → ledger

- **FL-1 · Sweep (SWEEP_PROPOSE, background/handlers/sg.js).** Two think seams (Core/sweepPrompt.js, pure+tested):
  phase A offers the app's connector READ legs → the model picks ≤3 reads (validated against the offer); the panel
  executes them (`_runConnectorLeg`); phase B offers the ACT legs + the results (fenced DATA) → validated PROPOSALS.
  The palette is connector-domain (curated for the connections + harvested + broker), `policyFilter`ed — the
  `forbidden` floor holds. Anti-hallucination: every pick must resolve to an offered leg (Core/proposals.js
  `normalizeProposal`), at most one proposal per target, ≤20 per run.
- **FL-2 · Pending queue (Services/Storage/ProposalStore.js, `proposals:{instanceId}`).** Proposals park with
  status pending → approved/rejected/executed/stale/failed. Chat renders the numbered batch with per-item ✓/✗
  (once-guard) + "Approve all safe" — bulk covers safety `auto|confirm` ONLY; a `gated` (destructive-class)
  proposal always takes its own click. Verbs: `sweep` · `pending` · `approve all` / `approve 1,3` /
  `reject 2 <why>`. A reasoned rejection is a learning signal (recordGoalItem, provenance `proposal-reject`).
- **FL-3 · Executor (chat.js `_approveProposal`).** The approval click IS the CX-6 confirm: execution dispatches
  the proposal's leg through the EXISTING write path with `confirmed:true` — one HITL per action, moved from a
  modal bar to the queue; the fail-closed contract holds at both ends. **Staleness CAS:** a proposal carries
  `basedOn {readKey, path, value}` + its grounding read; execution re-runs the read and REFUSES (status `stale`)
  if the anchor moved — never act on a queue another human is also working (the canvas `ifRev` pattern).
- **FL-4 · Ledger (Services/Storage/ActionLedgerStore.js, `ledger:{instanceId}`; pure half Core/actionLedger.js).**
  Append-only sweep/proposal/decision/execution entries, provenance captured AT ACT TIME. Console: `ledger`
  (+`hour`/`today`) → totals + executed-by-action + recent lines. This is the trust instrument and, later, the
  earned-autonomy ratchet's evidence base (approval/reversal counts per rule → per-action-class unattended trust —
  deliberately NOT built yet).

## 4. Invariants honored (don't relearn)

- **Instance-keyed keyspaces** — `proposals:{instanceId}`, `ledger:{instanceId}` (never appId; the
  `canvas:sources:{appId}` lesson). Not sync-registered until StoragePaths carries instance-keyed records.
- **`SWEEP ▸` is in `_DECISION_RE`** (studio.js) — sweeps are verifiable from a decisions download.
- **Injection boundary** — tool lines sanitized; read results fenced as `<SWEEP_DATA>` data-not-instructions;
  proposal text renders through the escape-first markdown path.
- **No busy-marking needed** — sweeps ride connector fetches, never engine-driven DOM clicks.

## 5. The portability test (falsifiable)

Same four primitives + a different seed ("keep my inbox at zero…") + a Gmail connection ⇒ an inbox fleet app with
ZERO new code. If a new fleet app needs code, intelligence leaked into the harness and that leak is a bug.

## 6b. The clock trigger (FL-6, v1355 — BUILT)

The trigger is a SWAP, not a rewrite: a per-instance `chrome.alarms` alarm (`fleet-sweep:{instanceId}`,
Core/fleetSchedule.js) fires the SAME propose-only sweep the `sweep` verb runs — headless in the service worker
(background/handlers/fleet.js `runHeadlessSweep`, the panel loop's twin riding `_invokeSgHandler`, the in-SW
handler bridge). Same think seams, same evidence round, same minimize, same supersede — results park in the SAME
instance-keyed queue awaiting the same approval gate; every step ledgers under a runId whose plan step notes
`clock`, so `show work` audits scheduled runs identically.

- **Console:** `sweep every 30m` / `sweep off` / `sweep schedule` (terse commands) + the natural phrasings through
  interpret — REVIEW_QUEUE grew `{every, off}` params ("review the queue every hour", "stop the schedule").
  Interval grammar `parseEvery` clamps to [5m, 24h]; the schedule stores only `{convId, minutes}` — the headless
  run loads the conversation fresh each fire, so seed edits apply without rescheduling.
- **Signal without spam (FL-6c, v1357):** proposals minted → ONE persisted conversation note (`updateMessage`
  upsert) + a pending chip on the APP'S OWN Rail card (`⏳ N`) — never the extension-icon badge (app-blind, owned
  by other features). The chip DERIVES from the queue at render (`ProposalStore.pendingCounts`, batched via the
  index-mirrored `instanceId` + a one-time self-heal for pre-v1357 entries) — no clear-bookkeeping to drift: it
  appears when a sweep mints, updates live in an open panel (a `storage.onChanged` watch on `proposals:*` +
  `conv:index`, debounced), and disappears when the queue is decided or superseded. A clean sweep writes nothing.
  A signed-out / unreachable queue skips honestly (ledgered `no readable queue`), never throws.
- **Honest v1 constraint:** the headless sweep rides the signed-in session (cold-start uses the §16 ephemeral-tab
  path). It runs while Chrome runs; nothing fires when the browser is closed — chrome.alarms persist across SW
  restarts natively, so no re-registration bookkeeping.
- **Countdown on the card (FL-6d, v1361; timer format v1363; corner placement v1364):** a scheduled app's card
  ticks down to its next sweep in the TOP-RIGHT corner (beside the × slot, accent color, always visible,
  tabular-nums) as a clock — "⏱ 23:14" per second, "1:05:42" above an hour ("⏱ …" while firing) — the alarm's
  own `scheduledTime` is the ground truth (one
  `alarms.getAll()` per Rail render, keyed back by alarm name; never derived from createdAt + periods). The 1s
  rail timer keeps ticking while a countdown is visible; the storage watch now includes `ledger:*`, so the fire
  itself (every sweep writes steps) re-renders the Rail and the countdown resets to the new cycle.
  `sweep schedule` shows "next in Xm" too.

**FL-6b (v1356) — the cadence lives in the SEED.** The workflow's opening clause ("at a fixed interval") is part
of the app's DEFINITION, so the seed is its home: "Review the queue every hour." written there arms the clock with
no separate command. Mechanism honors the v1348 rule — never regex over seed text: a seed-save (creation +
`seed:` edit) runs SEED_DIRECTIVES, a tiny think seam where the model reads the fenced seed and returns strict
JSON (`{"every":"1h"}` / `{"every":null}`); the harness operationalizes only the validated return (`parseEvery`
clamps to [5m, 24h]; instanceId never comes from the model). **Provenance-aware precedence:** the schedule stores
`source: 'seed'|'command'` — commands always win in the moment (`sweep off` stops anything); a seed re-save
re-applies its cadence, and a seed that no longer states one clears ONLY a seed-owned schedule, never a hand-set
`sweep every`. A failed/no-LLM extraction touches nothing. No new gate: the cadence is human-authored seed text
(the HITL happened at authoring); the arming is announced in-thread (creation persists the note to the record so
the empty-state greeting survives) and `sweep schedule` says "(from the seed)". The `ticket-manager` preset now
ships the hourly cadence — the archetype's own phrasing; edit-to-taste. Portability: "keep my inbox at zero,
check every 30m" + a Gmail connection self-schedules with zero new code.

## 7. FL-8 (v1358) — the unattended Zendesk admin (the workflow's actual point)

The user's refocus: "review all open · merge duplicates · solve resolved · requester-fix · assign to a daily
quota · on an interval, WITHOUT intervention — offload the admin task." Propose-then-approve becomes
**do-then-report** for the reversible classes; chat/ledger/`show work`/card chip flip from approve-before to
review-after instruments. The panel `sweep` still parks everything — the human standing there IS the reviewer;
only the CLOCK executes.

- **FL-8a · Recipes (data only):** admin-view reads — `all_open_tickets` (whole queue, oldest first),
  `unassigned_tickets`, `tickets_last_day` (the volume pulse) — and the requester-fix write pair `create_user`
  (role hard-coded `end-user` — a sweep can never mint agents) + `set_ticket_requester`. Merge/solve/assign/tags
  writes already existed (v1341); merge is `destructive:true` → safety-floor gated.
- **FL-8b · Autonomy policy + headless executor.** `config.autonomy = {recipeId: 'auto'|'gated'}` — preset DATA
  (ticket-manager: solve/assign/requester-fix/create-user/tags auto, **merge gated**), instance-overridable;
  read-through to the preset's defaults so pre-v1358 instances need no migration. `autonomyFor` is fail-closed
  three ways: absent from the map → gated; safety `gated` (destructive) → config can NEVER auto it; only the
  clock consults it. Execution = the panel's `_approveProposal` ported headless (`_executeHeadless`): same
  staleness CAS, same fail-closed write dispatch — `confirmed:true` supplied by the policy as the user's STANDING
  approval — same decision/execution ledger under the runId.
- **FL-8c · Daily quota.** `config.dailyCaps = {assign_ticket_to_me: 10}`. Two layers: the propose prompt gets a
  fenced `<SWEEP_CONTEXT>` with today's executed-by-action + remainders (derived from the queue —
  `executedTodayByRecipe`, no separate counter to drift), and the executor re-checks the cap per execution
  (defense in depth). Capped proposals PARK pending — the human can approve past the cap by hand.
  **v1360 (user correction): the quota NUMBER is seed-owned** — "assign up to 10 per day" in the seed; the
  seed-directives seam extracts `assignQuota` (validated int [1,200]) and writes it onto the effective
  `dailyCaps` keys (config's, else the preset's — the harness never maps prose to a recipe id itself). Stated-only:
  a seed silent on quota leaves config alone. Edit the seed to "20 per day" → the enforced cap follows. Same
  correction tightened the seed itself: duplicates = same requester + same issue + 5-day window; solve applies
  ONLY to tickets assigned to me (the whole-queue read is for merge/requester/assign work, not solving strangers').
- **FL-8d · Digest + spike.** The schedule record accrues rolling per-day inflow counts (cap 14) whenever the
  sweep's reads included an `inflow`-pulse read. **Pulse classes (v1359):** each digest-relevant read RECIPE
  declares its generic role — `pulse: 'inventory' | 'backlog' | 'inflow'` — and the harness keys its digest/spike
  bookkeeping on the CLASS, never a recipe id (the v1358 first cut named three Zendesk ids in fleet.js — caught by
  the "are these steps hardcoded?" audit; a Gmail fleet app tags its own reads and gets the digest free).
  `spikeVerdict` is CODE (≥2 baseline days, ≥5 items, ≥2.5× mean) —
  the model only interprets the cluster (baseline rule: one tracker ticket, not per-ticket actions). The run's
  note reports: queue counts · spike · ran-unattended (with `ledger` pointer) · capped · pending.
  **FL-6e (v1367) — no chat-invisible runs:** every scheduled fire reports. Eventful runs (minted / executed /
  first-of-day digest) post a per-run note; a QUIET run upserts one `sweep_idle` bubble in place (time-stamped);
  every early-exit failure (no connections / unreadable queue / think-seam error) upserts one `sweep_status`
  bubble saying why, pointing at `show work`. And the panel now LIVE-APPENDS SW-persisted messages into the OPEN
  thread (a `conv:{id}` storage watch, diff-by-messageId, render-only) — the first live clock test failed
  precisely because the note landed in the record while the user watched the DOM.

Deliberately NOT unattended: merge (irreversible — earns promotion via FL-7 or stays human), spam purge, user
merge, ticket delete. Coverage honesty: reads are one page (≤100; ~30 shown post-minimize + true counts) — a
several-hundred-ticket queue needs paginated reads (open).

## 8. FL-9 (v1370) — rejections stick

First live clock run exposed it: a reject-with-reason at 09:02 was re-proposed verbatim at 09:08. A human "no"
now binds to (action, targets, reason) and is enforced at THREE layers, both sweep paths: the learning delta
names its targets (semantic memory); `rejectionContext` lines ride the fenced SWEEP_CONTEXT (the model sees
recent nos + reasons); and `filterRejectedRepeats` structurally suppresses a rejected (recipeId+targets) pair at
mint time for 24h — ledgered as a `rejected-repeat` step — with one mechanical escape: the grounding anchor
(basedOn.value) moved ⇒ the item changed ⇒ re-proposing is legitimate. Memory shapes judgment; the harness
honors decisions.

## 6. Next slices

- **FL-7 · Earned autonomy** — per action-class promotion (N approvals, 0 reversals → one HITL "always do this?" →
  auto within the fence), reversal detection as demotion. Reads the ledger; reuses the promotion gate. With FL-8's
  policy map in place, FL-7 reduces to: the ratchet FLIPS map entries (gated→auto) instead of a new mechanism.
- **Live verification** — the sweep on the real Deako queue (proposal quality, param binding on the write legs,
  staleness behavior under concurrent agent activity).
