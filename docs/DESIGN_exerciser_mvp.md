# DESIGN — the EXERCISER (MVP, local)

**Status: SPEC ONLY.** Written 2026-08-08. Deliberately small: the previous attempt at this problem
(`DESIGN_exec_channel.md`) grew a cloud-authorization project before anything ran, and its rung 1 was built and
torn down the same day. That spec stays parked with its trigger (§6); this is the local path that does not need it.

## 1. The model (user, 2026-08-08)

> *"The builder edits the code, creates validation criteria, and creates the exercise steps. The exerciser
> implements the steps on the app and the grader reviews results."*

Three roles. Two are automated:

| Role | Produces | State |
|---|---|---|
| **Builder** | code · validation criteria · **exercise steps** | code ✓ · criteria ✓ · **steps ✗** |
| **Exerciser** | effects on the app, which become log lines | **human** |
| **Grader** | verdicts from the logs | ✓ (`lane-cron`) |

**Measured 2026-08-08:** across all open bus tests, ACTION steps are **171 `[human]` : 2 `[auto]`** — and both
`[auto]` lines are grader work ("grep the newest hour-files"), not exercise steps. So the builder writes its third
artifact as prose for a person. **That is the first gap, and it comes before the executor:** automating the
executor first yields an executor with nothing to run.

## 2. What already exists (do not rebuild)

- **`tools/exercise/exercise.cjs`** — the executor. Verbs `status` · `reload` · `ask "<text>"`. Drives CDP, finds
  the panel by extension id derived from `manifest.key`, and sends ONE `chrome.runtime.sendMessage`. The ask
  travels panel → SW → panel → `sendChatMessage`, so **an exercised ask is indistinguishable from a typed one**.
  No `--eval` (deliberate). Refuses when >1 Orchard panel is open rather than guessing.
- **`background/handlers/exerciser.js`** — `DEV_RUN_ASK` / `DEV_RELOAD_EXTENSION`, answering `panel-closed`
  when there is nowhere to dispatch, and logging `EXERCISE ▸` on every invocation.
- **`CHAT ▸ ask` / `CHAT ▸ reply`** (v2.74.2104) — the ask and the reply now cross the fleet wire, so an
  exercised turn is *self-evidencing*: the grader reads what was asked and what came back.
- **The write belt** — an exercised ask that routes to a non-GET write is blocked exactly as a typed one is.
  Nothing here needs its own gate.

- **`DEV_EXERCISE` + `_drainExerciseQueue`** (`exerciser.js:70` → `chat.js:19629`) — takes an ask list **plus
  `reload`**, persists it, and drains it on the next boot: serial, spaced past the 3s duplicate-send belt,
  cleared-before-running (never replays), abandoned after 10 minutes, asks-only, **max 10**. Its own comment
  states why it exists: *"'reload, then run the asks' cannot be written as a sequence — the reload tears down the
  panel that would run them."* `exercise.cjs:221` already calls it. **M2 does not re-sequence anything.**

**Three preconditions, not one** *(review fix — the first draft named only the port)*:
1. Chrome running with `--remote-debugging-port=9222`. **Verified closed today.**
2. **Exactly one Orchard panel open**, or `ORCHARD_PANEL=<n>` set. `exercise.cjs` refuses to guess — and its own
   header notes this machine runs Orchard in three profiles with four typically open. On this setup that refusal
   is the normal case, not an edge case.
3. **A person to run it.** See §4 — the MVP is on-demand.

## 3. M1 — the step artifact (no permissions needed; do this first)

An `[auto]` step becomes **executable text, not an instruction to interpret**:

```
ACTION:
  - [auto] reload
  - [auto] ask: get all open warranty tasks
  - [auto] ask: who is the CSR for each?
  - [human] Judge whether the CSR reads as a CSR and not as the homeowner.
```

Rules:
- Two verbs only, mirroring the executor: `reload` and `ask: <literal>`. Anything else stays `[human]`.
- The text after `ask:` is sent **verbatim**. If a step needs interpretation, it is not an `[auto]` step.
- Order is significant; steps run top to bottom.
- `[human]` is unchanged and still surfaces in the census.
- **At most ten `[auto]` steps per test** — the queue's `MAX_ASKS` is 10 and it truncates. A test with more is a
  **malformed test**, refused loudly by the runner; it is never a silently shortened run. *(Review fix: the first
  draft did not mention the cap, which is exactly the silent-truncation class `CRON_PROMPT` warns about.)*

**Retrofit the three open tests as the proof.** Most of their steps already are asks — `open #4908619`,
`who is the CSR`, `get all open warranty tasks`, `draft the replacements`. The genuinely non-ask steps ("open a
warranty CASE from the Rail case card") stay `[human]` until an ask form is known to work.

## 4. M2 — the runner

`tools/exercise/exercise-run.cjs` — **plain node, no `claude`, no model, ~zero cost.** Run **on demand** by a
session that is already open:

```
node tools/exercise/exercise-run.cjs
```

```
read open tests (testbus) → pick the OLDEST that is LIVE/LIVE* and has unrun [auto] steps
  → preflight: port reachable · exactly one panel (or ORCHARD_PANEL) · panel open   (any failure → log + exit 0)
  → hand the WHOLE step list to exercise.cjs in ONE call (DEV_EXERCISE: {asks, reload})
  → append {testId, build, at, outcome, conversationId} to logs/run/exercise-log.jsonl
```

- **It does not sequence anything** *(review fix)*. The first draft ran steps "~15s apart", which reimplements
  `_drainExerciseQueue` badly and breaks outright on `reload` — the reload destroys the context mid-sequence.
  One call; the queue owns ordering, spacing and reload survival.
- **On demand, NOT scheduled** *(review fix)*. A timer driving the browser unattended IS the
  arrival-causes-action property this whole line of work exists to be careful about — the cloud spec was
  criticised for it, and the first draft quietly reintroduced it with a `.cmd`. Scheduling is a separate decision
  after it is proven, and skipping it also removes the need for a kill switch the spec never had.
- **Idempotency:** one run per `(testId, build)` via the ledger. A rearm onto a new build makes it runnable again
  — the same rule the grader uses for evidence. Without this the runner re-drives the same test on every
  invocation.
- **Oldest first**, matching the grader's own "grade the OLDEST LIVE test" discipline.
- **Preconditions are not errors.** Port closed / panel closed / two panels → record and exit cleanly.
- **Never runs `[human]` steps** and never marks them done.

## 5. M3 — proving it, by the loop's own rules

The exerciser must be gradeable by the grader it serves, or it is the thing it was built to prevent:

```
SCOPE   = an [auto] step ran this window · grep: `EXERCISE ▸ ask dispatched`
MECH    = the runner claims it drove          · grep: `EXERCISE ▸`
VALUE   = the ask's LEADING TEXT appears as `CHAT ▸ ask` in the window AND the turn produced a `CHAT ▸ reply`
FAIL    = `EXERCISE ▸ ask dispatched` with no matching `CHAT ▸ ask`  — it claimed to drive and did not
INCONCLUSIVE = panel-closed · port closed · conversationId ≠ the test's desk
```

*Leading text, not the whole string (review fix): `CHAT ▸ ask` clips at 600 chars and collapses whitespace, so a
whole-string match would fail a long ask for a formatting reason and read as a FAIL.*

`MECH` is the runner's own claim; `VALUE` is the ask actually landing as a turn. The distinction is the point —
a dispatcher's self-report is a tally, and a tally is not a correctness signal.

**Done when:** one open test's `[auto]` ACTION steps run **with no human present**, and the grader reaches a
verdict from the resulting window. *(Review fix: the first draft said "a verdict with zero `[human]` steps run",
which is unreachable for the current corpus — all three open tests carry `[human]` JUDGEMENT arms, and M1
retrofits ACTION steps only. Whether that verdict is PASS or INCONCLUSIVE is the test's business, not the
exerciser's. Moving VALUE arms off `[human]` is separate work and stays out of this MVP.)*

## 5b. The missing capabilities — what independence actually requires

*Added 2026-08-08 on the user's direction: "the MVP should be as independent as possible — it defeats the purpose
if a human is still in the loop." Derived from the corpus, not from guesswork.*

**Measured across all open tests — 192 non-empty `[human]` steps:**

| What the step demands | n | Door today |
|---|---|---|
| `open …` — a desk · a case on a record · the workflow gallery · a Rail tab | 49 | **mostly missing** |
| **reload** | 47 | `RELOAD_EXTENSION` **is** routed — blocked by panel survival, not by a missing door |
| **run / ▶** a workflow or card | 40 | `INVOKE_WORKFLOW` exists but is **NOT** in the routed builtin table |
| **check / verify / read the reply** | 46 | genuinely human — judgement, not navigation |
| send / ask / type | 11 | already asks |

≈¾ of what a human does for this loop is **mechanical**. It is human because the door is missing, not because a
machine could not walk through it — which is `DESIGN_panel_surfaces.md` §3.2 ruling 4 read in the mirror: *a
surface reachable only by CLICK is unshipped navigation just as surely as one reachable only by command.*

### The four doors

1. **`OPEN_DESK <name>`** — select/switch the active desk. **The blocking one.** The routed table
   (`chat.js:13578-13608`) has no `OPEN_DESK` / `SELECT_DESK` / `SWITCH_DESK` under any name; the only
   `*_DESK*` identifier in `chat.js` or `Core/` is `DESK_USER`. Every *"in the Warranty desk, …"* step is human
   solely for this. Switching already exists as a function (`_selectConvForInput`) — it is reachable from Rail
   clicks and from case-spawn, but from no ask.
2. **`OPEN_CASE` on an existing RECORD.** Today `_openCaseFromLeg` takes a *title* and derives an id from it —
   an ad-hoc case. What the tests need is the FC-0 shape: *a case born holding its record*. `open #N` currently
   drills a list row instead, which is exactly the defect chased all of 2026-08-08 (`NO SIDECAR` → `none of 0
   contact(s)`), and it is why `v2.74.2112` still carries *"open a warranty CASE (Rail case card, not `open
   #N`)"* as `[human]`.
3. **`RUN_WORKFLOW <name>`** — ▶ from an ask. The executor exists (`INVOKE_WORKFLOW`, `runWorkflow` via the
   cadence path) but has no entry in the routed table, so 40 steps say "press ▶".
4. **Rail-tab navigation** (`Automate` · `Records` · `Connect`) — several steps read *"in Automate, ▶-run …"*.
   Lower value than 1–3; list it, do not build it first.

### The one that is NOT a capability gap

**Opening the side panel cannot be automated.** `chrome.sidePanel.open()` must run on a live user gesture —
`background.js:557` documents a real bug where awaiting *anything* first consumed the gesture token and open()
failed silently. No ask, no injected script, no capability changes this. **Consequence for reload:**
`chrome.runtime.reload()` tears down the panel, and `_drainExerciseQueue` runs *in the panel* — so the queue only
drains if the panel comes back. **Whether Chrome restores the side panel after an extension reload is UNVERIFIED
and is the single most load-bearing unknown in this MVP.** If it does not, reload steps require a human click and
47 of 192 steps stay human no matter what else is built. **Verify this before building any of the four doors.**

### Order (by steps unblocked per unit of work)

`OPEN_DESK` → `OPEN_CASE`-on-record → `RUN_WORKFLOW` → Rail tabs.

### 5b.1 The contracts

*A capability in this codebase is four things, not one: a **palette entry** (`Core/palette.js` — what the router
is told exists), a **handler** (the routed builtin table, `chat.js`), a **decision marker** (`DECISION_MARKERS`,
invariant #1 — absent from it, the capability is invisible to a decisions download), and **refusals that say
what happened**. Any door missing one of the four is half-built.*

**1. `OPEN_DESK` — BUILT v2.74.2104. The blocking one.**

| | |
|---|---|
| palette | `mode:'act'` · `domain:'self'` · `safety:'auto'` · `params:['name']` |
| does | switch the panel to a desk/view by name, so later asks land there |
| ask forms | *open the warranty desk* · *switch to Warranty* · *go to the vendorsuite desk* |
| calls | `_selectConvForInput(conv)` — already exists; reachable from Rail clicks and case-spawn, from no ask |
| marker | `DESK ▸ open name="…" → <id>` · `DESK ▸ no match "…" (n desks)` · `DESK ▸ already there "…"` |
| refusals | no match → **name the desks that exist**, never guess · ambiguous prefix → list the candidates · already there → no-op, still logged |
| verify | MECH `DESK ▸ open` · VALUE the NEXT ask answers in that desk (its `CHAT ▸ reply` names the desk's data) |

Matching is deliberately **exact → case-insensitive → unique prefix**, and stops there. A fuzzy match that picks
the wrong desk sends every subsequent step to the wrong place and the trace still looks clean — the silent-wrong
class this project keeps paying for.

**2. `OPEN_CASE` on an existing RECORD — NOT built.** Extend the existing entry with `record` (an id/number) so a
case is *born holding it* (FC-0), rather than minting an ad-hoc case from a title. Marker: reuse `CASE ▸`.
Refusal: record not found in the current view → say so, never open an empty case. **Deliberately not built
here:** it touches case-spawn semantics, which the parallel lane is actively changing (`contacts: walk UP to the
parent leg…`, `cases list`, `case-store failure`) — landing on top of that invites a merge over live code.

**3. `RUN_WORKFLOW <name>` — NOT built.** The executor exists (`INVOKE_WORKFLOW` / `runWorkflow`); it needs a
palette entry + table row + a by-name lookup. `safety:'confirm'` — a workflow can write, and a chat door to it
must not be cheaper than the ▶ button. Marker: `WORKFLOW ▸`, already in `DECISION_MARKERS`.

**4. Rail-tab navigation — NOT built.** Lowest value; `SHOW_SECTION`-shaped. Listed for completeness.

## 6. Known limits (stated, not solved)

- **The ask lands wherever the panel is.** `DEV_RUN_ASK` dispatches into the open conversation; choosing it
  "belongs to whoever opens the panel". This caused a real INCONCLUSIVE on 2026-08-02 (*an ask sent in a
  conversation that lacked the connection*). MVP mitigation: record the returned `conversationId`; the grader
  treats a mismatch as INCONCLUSIVE, not FAIL. Not solved here.
- **The panel must be open**, and a person must have opened it. This automates the *asking*, not the *being there*.
- **The CDP port is real exposure** — it lets any local process drive that profile, including the live sessions
  the connectors ride. Opened per session by the human, closed after. Not a permanent flag in a shortcut.
- **Judging still needs a human where the answer needs taste** — but far less than before: with `CHAT ▸ reply`
  live, "did it say the right thing" is now readable from the window in most cases.
- **Cloud stays parked.** Re-open `DESIGN_exec_channel.md` only when a second machine genuinely exists AND M1–M3
  have proven insufficient for the recurring cases. Not before.

## 7. Order

1. **M1** — step format + retrofit the three open tests. No permissions. Do this first; the executor is worthless
   without it (the corpus is 171 `[human]` : 2 `[auto]`, and both `[auto]` lines are grader work).
2. **Open the port** (user's call, per session) and get to one panel.
3. **M2** — the runner + ledger. One call, no sequencing, on demand.
4. **M3** — the bus test, and the first run with no human present.

Scheduling, more verbs, conversation targeting, and the cloud channel are all **out of this MVP** and each has
its own trigger. The point of stopping here is that every piece above already exists except the parser and the
ledger.
