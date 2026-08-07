# DESIGN — Panel Surfaces (the side-panel UI architecture)

**Status:** specced 2026-07-24, nothing built. Motivated by the critical UI review of the same date; the evidence
base is the ten live UI reports of 2026-07-23/24 (appendix §13) — nearly every one traces to the handful of
structural causes this document exists to retire.

**Thesis:** the panel does not have a UI bug problem; it has a **surface ownership problem**. The Thread hosts
five kinds of content with five lifecycles (transcript · transient pages · eight bubble-menus · notifications ·
live run output) and no owner, so every new feature re-fights the same three battles: where do I render, who
cleans me up, and how does the user get back. This document names the surface classes, gives each a contract,
and migrates the existing violators. Everything here is panel-only (chat.js / chat.html / chat.css) — no SW, no
storage schema, no routing changes.

---

## 1. The ruling: FOUR surface classes, ONE owner token

### 1.1 The classes

| Class | Element home | Lifecycle | May contain |
|---|---|---|---|
| **TRANSCRIPT** | `#messages` | persistent (ConversationStore) | conversation only: user asks, agent replies, run output |
| **PAGE** | `#empty-state` slot | owned; replaced whole | the front page, desk landing, wizard, gallery |
| **OVERLAY** | appended to `#app-body` | stacked above; covers, never destroys | menus, history, pickers — anything ephemeral with structure |
| **CHROME** | fixed elements | permanent | Rail, composer, header, toasts, badges |

**RULING: the transcript carries conversation and nothing else.** Not menus, not notifications, not transient
pages. The desk landing currently renders INTO `#messages` as "transient DOM"; the eight bubble-menu views
(§2.2) render as assistant messages; the parked-run nudge appends a guarded bubble. All of these move (§2, §7).
The entire `_orchActionBar` staleness-scoping system (v1373) exists to manage buttons rotting inside a
persistent medium — under this ruling the system shrinks to its one legitimate use (action bars on genuine
conversation, e.g. a write confirm).

### 1.2 The owner token — `_surface`

The §6.4 page-slot trap has now fired live twice (the v1615 wizard blank-thread bug; the v1719
destroyed-front-page bug). The spec'd fix — "one explicit which-page-is-showing value" — is ruled here:

```js
// chat.js, module level — the ONE authority on what the main area shows.
let _surface = { kind: 'transcript', owner: null, release: null };
// kind: 'transcript' | 'page' | 'overlay'
// owner: 'landing' | 'wizard' | 'gallery' | 'front' | 'wf-history' | 'workflows' | …
// release(): the owner's own teardown — restore skeleton, unlock composer, remove nodes.
```

Contract, enforced by convention and one helper pair:

- `claimSurface(kind, owner, release)` — records the claim, first calling the PREVIOUS owner's `release()`.
  Claiming is what killed the previous owner — no more silent overwrites of `.empty-state-content`.
- `releaseSurface(owner)` — no-ops unless `owner` still holds the claim (a stale release can't kill a successor).
- Every render that touches the page slot or opens an overlay goes through `claimSurface`. The wizard's current
  three-point guard (`_wfForeign` / landing-yield / input intercept) collapses into this one mechanism; the
  wizard's v1719 `_wfReleasePageSlot` becomes its registered `release`.
- **Destruction sites call the token too**: desk delete and delete-all call `releaseSurface('*')` semantics via
  the current owner's release — the v1719 lesson ("a parked thing needs a death condition") made structural.

### 1.3 The z-order ladder (documented, not discovered)

```
30  toasts / param-modal (true modal — the only focus trap)
20  .rail
18  overlays (.wf-history-overlay and successors)
 0  page slot / transcript
```

The composer row lives OUTSIDE `#app-body` (the §6.3 structure, deliberate since the input-row move) — **no
overlay may ever cover it**. This is already true and is now a stated invariant.

---

## 2. The OVERLAY standard — and the bubble-menu migration

### 2.1 Anatomy (the `wf-history-overlay` is the reference implementation)

One helper replaces eight bespoke renderings:

```js
function openPanelOverlay({ id, title, titleMeta = '', render, onClose = null }) → { el, close() }
```

- Singleton per `id` (re-open replaces). Appends to `#app-body`; `claimSurface('overlay', id, close)`.
- Chrome: a pinned head — title left, meta (e.g. the schedule label) beside it, the **collapse arrow**
  top-right (§5.3) — and a scrollable body `render(bodyEl)` fills.
- Motion: the `.rail` pattern (absolute, inset 0, blur backdrop, translateY+opacity, `--t-med`), exactly as
  built at v1743.
- Close: the arrow, **Escape** (§6.1), or a successor's claim. Whatever was beneath is revealed untouched —
  the v1743 lesson: covering beats dismiss-and-rerender.

### 2.2 The migration table

| Today (a bubble in the thread) | Target | Notes |
|---|---|---|
| `_renderWorkflows` (`workflows`) | ~~overlay `workflows`~~ → **Rail desk-children** (v1777, §8.4) | SUPERSEDED: built as the overlay at v1765, retired at v1777 — workflow cards render as desk children beside case rows; the command/leg doors pin the section open. Parked runs = needs-action rows atop the section; the routine-rebuild offer lives in the routines overlay |
| `_renderWorkflowRuns` | overlay `wf-history` | **done (v1743)** — retrofit onto the helper, gaining Escape/focus for free |
| `_renderRoutines` | overlay `routines` | |
| `_listCasesMsg` (LIST_CASES) | overlay `cases` | the leg's `run` opens the overlay instead of printing rows |
| `_showKeepAlive` | overlay `keepalive` | currently re-renders by remove-and-reprint — the overlay re-render is one `render()` call |
| `_showRideOps` | overlay `ride-ops` | |
| `_renderWorkTraceMsg` | overlay `work-trace` | |
| `_renderParkedRuns` | **banner inside** `workflows` | not its own surface — it is the workflows view's needs-action strip (§7) |

**What stays in the thread:** single-shot answers ("Closed.", counts, one record), write-confirm bars, teach
offers, run output (§9). The test: *if re-showing it means re-typing a command, it was never conversation.*

**RULING: no `-decisions-`-style dual population.** A migrated view's leg/command keeps its key (`OPEN_WORKFLOWS`,
`LIST_CASES` — routing unchanged); only the `run:` body changes from print-bubbles to open-overlay. The six
"re-type `workflows`" copy strings die with the migration.

---

## 3. Navigation that survives — the one-shot-surface fix

### 3.1 The findings, restated as requirements

- The launch page — the best surface in the product — is unreachable after the desk's first message.
- The send path is a 41-regex command cascade; typed commands are the only door to most managers.
- CD-2's Rail glyph (specced in DESIGN_cadence.md §3.1: "the only always-visible per-desk affordance") was
  never built.

### 3.2 Rulings

1. **The desk landing becomes the desk's HOME, reachable always.** It stops being launch-state-only DOM inside
   `#messages` and becomes a PAGE-class render (or overlay when a thread exists beneath): workflow cards +
   starters + the descriptor. Auto-shown in launch state exactly as today; afterwards, one tap away. Its
   `render` source (`buildDeskLanding`) is already pure — this is a re-homing, not a rewrite.
2. **The Rail desk row carries the workflow glyph** (CD-2 §3.1, unconditional, every row) opening that desk's
   `workflows` overlay. Add its class to the click-target derivation (§8.2 — not the allowlist).
3. **The header names the surface and is the way back.** When a desk is open, the header area shows the desk
   name as an affordance → opens HOME. (Smallest honest form: make the existing title row a button.)
4. **Typed commands become aliases, never sole doors.** Standing rule, extending invariant #4's spirit to UI:
   *a surface reachable only by typed command is unshipped navigation.* New managers must land in an overlay
   with a Rail/header/landing entry; the command stays as the power-user alias. The 41-regex cascade is frozen —
   additions need the same justification a new pre-door intercept needs today.

---

## 4. The composer — modality made visible

### 4.1 The findings

One input serves chat, wizard steps, names, intents, setup answers — signaled only by placeholder text and
`disabled`. Failure record: the v1622 lock, the v1719 zombie lock, send-button disable leaks, the v1697
intent-flag. Placeholder-as-instruction is invisible the moment anything refills or covers it.

### 4.2 Rulings

1. **The mode chip.** A slim strip rendered ABOVE the input (inside the composer row, so never covered) whenever
   any flow owns the composer: `⚙ Workflow builder · step 2 of 4   ✕`. The ✕ invokes the owner's registered
   release (below). No owner → no chip → plain chat. Placeholder becomes supplementary hinting, never the sole
   signal.
2. **Composer ownership registers a release.** `claimComposer(owner, { placeholder, locked, chip, release })` /
   `releaseComposer(owner)` — mirroring §1.2. The release restores input/send/placeholder in ONE place;
   `_wfAbandon`, `_wfExitPage`, setup-cancel, the intent flag, and the delete paths all call it instead of five
   hand-rolled unlock snippets. The zombie-lock class (v1719) becomes structurally unrepresentable: a surface
   owner dies → its composer claim dies with it (the `claimSurface` release chains to `releaseComposer`).
3. **Locked means labeled.** A disabled input ALWAYS has a visible chip stating who locked it and how to exit.
   `disabled` without a chip is a bug by definition (a conformance check greps for the pairing, §6.3).

---

## 5. One icon system

### 5.1 The findings

Chrome mixes emoji (▶ ⚡ ⏱ 📜 🗑 ⤴ ✕ ● ◎ ✨ 👍), text buttons, and inline SVG. Dismiss alone shipped four
metaphors in one week (✕ → ‹ → ⌄ → SVG arrow), each a user correction. Emoji ignore `currentColor`, render
platform-dependently, and none carry `aria-label` (6 in the whole panel).

### 5.2 Rulings

1. **`assets/icons.js` — one registry.** `Icons = { run, runHeadless, schedule, history, delete, close,
   collapse, back, add, subtask, … }` — each an inline-SVG string: `viewBox 0 0 24 24`, `fill:none`,
   `stroke:currentColor`, `stroke-width:2`, round caps/joins (the family the Rail subtask button and the v1745
   history arrow already use). Sizes 14/16/20 via width/height at call site.
2. **`_mkIconBtn(iconName, ariaLabel, fn, { title } = {})`** — the aria-label is a REQUIRED positional
   parameter; there is no way to mint an unlabeled icon button. `_mkBtn` stays for text buttons.
3. **Emoji are banned from CHROME, allowed in CONTENT.** Buttons, badges, and headers use the registry; an
   agent reply may still say ⚠ or ✓ (copy voice unchanged).
4. **The dismiss metaphors, fixed forever:**
   - **collapse arrow (down)** — closes an overlay, revealing what's beneath (the v1743/45 user directive).
   - **✕** — cancels/destroys the thing itself (a wizard, a form, a draft).
   - **‹ back** — navigates within a stacked flow (a wizard step, a drill-in), never closes a surface.
   One metaphor per behavior; a control may not use another class's glyph.
5. Migration order: new code uses the registry immediately; existing emoji chips flip surface-by-surface with
   the §2.2 migrations (no big-bang restyle commit — it would collide with the racing lane).

---

## 6. Accessibility — a contract, not spot-treatment

### 6.1 The overlay a11y contract (part of `openPanelOverlay`, so it is free everywhere)

- On open: focus moves to the overlay (the close control); the opener is remembered.
- **Escape closes the topmost surface** (overlay above rail above page) — one document-level handler consulting
  `_surface`, replacing today's two lone Escape sites (SlashPicker only).
- On close: focus returns to the remembered opener (if still attached; else the composer).
- The param-modal remains the ONLY focus trap (true modal); overlays are dismissible, not trapping.

### 6.2 The Rail

- Hover-revealed row actions (subtask/preview/delete/glyph) become **visible on `:focus-within`** too — CSS
  only. `_wireRowKeyboard` stays; the actions become reachable by Tab.
- Row badges get `title` + `aria-label` (§8.3).

### 6.3 The conformance checks (the hardening-arc pattern applied to UI)

The `await import(` lesson: platform/convention bans need grep-class checks, because the harness can't see
them. Add a small `Core/panelConformance.test.js` (pure text scans over chat.js/chat.html):
- every `_mkIconBtn(` call has a non-empty label argument (trivially true by signature — the check guards
  regressions to raw `createElement('button')` with an icon and no label: flag `innerHTML = ..svg..` buttons
  outside the helper);
- `disabled = true` on `chat-input` appears only inside `claimComposer` (§4.3);
- no new `appendMessage` call sites inside the migrated view functions (the junk-drawer regression tripwire).
These are advisory greps at first (report-only), promoted to red once the migrations land.

---

## 7. The notification policy — four channels, one rule each

| Channel | Carries | Rules |
|---|---|---|
| **Rail badge** | standing state (pending count, ⏱ next-run, parked count) | always current, never announces; tooltip says the number's meaning |
| **Toast** | ephemeral outcome confirmation | ≤ 5s, no actions, never for needs-action |
| **Surface banner** | needs-action, in the surface that owns the action | e.g. parked runs banner at the top of the `workflows` overlay; adopt/rebuild offers likewise |
| **Transcript** | conversation | agent replies, run output, write confirms — never system nudges |

Migrations this implies:
- The parked-run nudge (v1700) retires from the thread → a Rail **badge** on the desk row (`⚠ n`) + the banner
  inside the workflows overlay. The `WORKFLOW_PARKED_CHANGED` broadcast updates the badge — no page-slot guards
  needed ever again, because badges can't collide with surfaces.
- `_maybeWarnDeskConnections` (already "at most a pointer") becomes a badge + one-line banner on the desk HOME,
  not a thread append.
- `toast()` sites audit against the table (10 sites — most already conform).

---

## 8. The Rail — registry over hand-coding

### 8.1 The findings

The handoff's own words: "the Rail is the cautionary tale — no section registry, every fixture hand-coded in
two coupled places." Plus: the `_isRowActionTarget` allowlist (a manual list every new affordance must join —
the `_DECISION_RE` invariant class), and the hard-coded right-edge arithmetic
(`padding-right: 72px` vs a timer at `calc(var(--sp-2) + 34px)`).

### 8.2 Rulings

1. **`Core/railSpec.js` (pure, tested):** `buildRailSpec({ conversations, fixtures, badges }) → sections[]` —
   section order, fixture placement (Front top, Admin bottom, cases nested), row composition (title line, meta
   line, badge set, action set). chat.js renders the spec; it stops deciding structure. New fixtures/sections
   become data.
2. **Click-target derivation replaces the allowlist.** Every row action carries `data-row-action`; the row click
   handler ignores any target with (or inside) that attribute. `_isRowActionTarget`'s hand-list — and the
   invariant-shaped bug where forgetting it makes a button also select the row — is deleted, not extended.
3. **The right edge becomes a flex cluster.** One `.rail-item-actions` flex container holds timer/subtask/
   preview/delete/glyph; the title truncates against it naturally. The 72px arithmetic dies.

### 8.3 Badges

`view` / `case` single-word badges become icon + tooltip chips from the registry (§5) with `aria-label`
("Warranty — a view", "a case under Warranty"). Standing-state badges (§7) join the same cluster: `⏳ n`
pending, `⚠ n` parked, ⏱ next-run.

### 8.4 One class — workflows are desk children (RULING, v2.74.1777)

A workflow is a desk's chat history condensed to its replayable skeleton — the INTENSIONAL record of a strand
of work beside the case's extensional one. Both render as desk children through one mechanism:

- `buildRailTree` emits typed children (`role: 'workflow' | 'subtask'`); `workflowsByConv` feeds it from ONE  *(dead-code pass 2026-08-07: retired — the accordion emits no workflow rows; the Automations tab renders them)*
  `listAllWorkflows()` sweep per render (counts + content for every desk — no per-peek fetch).
- Each desk group holds up to two `.rail-section` slide blocks — workflows above cases, mirroring the button
  order. Sections share the peek/pin machinery: hover the button (150ms intent) peeks, leaving the group
  (300ms grace) closes, click pins (`_expandedWfs` / `_expandedApps`, aria-pressed → accent). Case rows and
  workflow rows are ALWAYS in the DOM; a class hides them (hover must never re-render).
- The workflow/cases buttons are one look: icon + count chip, always visible when count > 0.
- A workflow row's primary click opens ITS history (`wf-history` overlay — its transcript, re-condensed per
  run): the same "click a child, see its history" semantics as a case row. Action chips hover-reveal on the
  row: run · headless · schedule (inline picker) · history · delete.
- Parked runs = always-visible needs-action rows atop their desk's workflows section; the ✋ badge pins the
  section open. The `workflows` command / `OPEN_WORKFLOWS` leg stay aliases: pin + reveal the Rail.
- Divergences that stay: a workflow is never an input target; cadence attaches only to workflows; cases
  cascade-die with the desk while workflows orphan-and-survive.
- Named for later (NOT built): "distill this case" (case → workflow), and runs landing as cases (run → case),
  which would make run history a list of addressable case references.

---

## 9. Run output — one progress component, tied to the reporter

### 9.1 The findings

Long operations overwrite a single bubble via `_setMessageBody`; each path re-invents progress (DK-8c's
`onEach` ticks, wizard re-parenting, fan-out summaries). CD-1a built a clean reporter interface
(step/progress/result/gate/done) for the SW — the panel never adopted it *visually*.

### 9.2 Rulings

1. **`_progressBubble(msg)` — the panel DOM reporter, materialized.** One component implementing the §11.2
   reporter interface over a transcript bubble: a step line (`Step 2 of 5 — "read each ticket"`), a live tick
   region (`37/121 · Greensboro`), elapsed time, and a result region that becomes the persisted body on
   `done()`. `_orchRunChain`'s call sites hand it `msg`; the chain's bespoke `_pfx`/`_setMessageBody` weaving
   migrates INTO it incrementally (per-clause, the CD-1a phase-2 discipline — never a big-bang rewrite of the
   working chain).
2. Run output STAYS in the transcript (it is conversation — the answer to an ask). What changes is that its
   in-flight rendering is one component, so every future executor path gets progress + elapsed + honest
   truncation for free — and the §6.5 history write can hang off the same `done()`.

---

## 10. Build ladder

Ordered by leverage; each rung is panel-only and independently shippable. Risk notes are honest: everything
here is live-eyeball territory (no headless UI harness exists), so rungs are sized small.

| Rung | Builds | Depends on | Risk |
|---|---|---|---|
| **PS-0** | `claimSurface`/`releaseSurface` + the z-ladder comment + retrofit the THREE existing claimants (wizard, landing, history overlay) | — | medium (touches the wizard's guard trio — its tests are manual) |
| **PS-1** | `openPanelOverlay` helper + retrofit `wf-history` onto it (Escape/focus arrive here) | PS-0 | low |
| **PS-2** | migrate `workflows` to the overlay (flagship), parked banner + rebuild offer move inside; retire the six "re-type" strings | PS-1 | medium |
| **PS-3** | Rail workflow glyph + landing-as-HOME (reachable always) + header-name affordance | PS-2 | medium |
| **PS-4** | `assets/icons.js` + `_mkIconBtn` + flip the workflows/history surfaces' chips | PS-2 | low |
| **PS-5** | `claimComposer` + the mode chip + retire the five hand-rolled unlock snippets | PS-0 | medium (wizard/setup flows) |
| **PS-6** | notification policy: parked nudge → badge+banner; desk-connection warning → badge+HOME banner | PS-2/3 | low |
| **PS-7** | remaining overlay migrations (routines, cases, keepalive, ride-ops, work-trace) | PS-1/4 | low, mechanical |
| **PS-8** | `Core/railSpec.js` + data-row-action derivation + flex action cluster + badge chips | PS-4 | medium (the Rail is load-bearing chrome) |
| **PS-9** | `_progressBubble` + first chain call-site adoption | PS-4 | medium (touches run rendering) |
| **PS-10** | `Core/panelConformance.test.js` (advisory → red as rungs land) | any | low |

Livability checkpoints: after PS-2/3 the "re-type it" era ends; after PS-5 the composer can never lock
anonymously again; after PS-8 the Rail stops being hand-coupled.

---

## 11. What this deliberately does NOT decide

- **Visual redesign.** No color, spacing, or typography changes — the token system stays as-is. This document
  is architecture and affordance, not styling.
- **The Canvas.** Its contract (DESIGN_canvas.md) is untouched; it is a separate plane, not an overlay.
- **Studio.** A different surface with different rules; nothing here applies to it.
- **Touch/mobile.** The panel is desktop Chrome; hover-reveal fixes are keyboard-driven, not touch-driven.
- **The 41-command cascade's contents.** Frozen, not redesigned — routing ownership belongs to the
  interpret/decision-gate arc, not this document.

---

## 12. How this document was reached

A critical review (2026-07-24) was asked for after ten live UI reports in two days. The decisive observation:
**every report was an architecture symptom, not a cosmetic one** — and three were the SAME symptom (content in
the transcript that was never conversation) reported against three different features. The spec therefore leads
with ownership and lifecycle, not appearance.

**LESSON[the-thread-is-not-a-layout-manager]:** rendering into the transcript is free the day you do it and
expensive every day after — persistence, staleness scoping, re-render-by-retyping, and notification collisions
are all rent paid on that choice. A surface with structure gets a surface with a contract.

**LESSON[user-corrections-cluster]:** four dismiss-metaphor corrections in one week were not four preferences —
they were one missing system (§5.4). When corrections cluster on the same control class, spec the class.

---

## 13. Appendix — the motivating findings (live reports → causes)

| Live report (2026-07-23/24) | Root cause | Retired by |
|---|---|---|
| wizard save page survives desk delete (v1719) | page-slot had no owner; parked wizard had no death condition | PS-0 |
| "saved workflows still not listed" (v1721/22) | recovery lived behind a typed command | PS-2/3 |
| workflow card missing icons (v1724) | affordances split across surfaces with no standard | PS-2/4 |
| history "couldn't load / no close / persists" (v1739) | menu-as-message; no overlay standard | PS-1 |
| "not part of the chat blob" (v1743) | same — the transcript as junk drawer | PS-1/2 |
| chevron placement/centering/icon (v1743-45) | no icon system, no dismiss metaphor ruling | PS-4 |
| "case isn't dismissed" (v1737) | notification state living in a surface with no reconcile trigger | PS-6 (+the v1737 fix) |
| Rail badges wrong vocabulary (v1733) | hand-coded rows, bare-word badges | PS-8 |
| adopt ceremony rejected (v1722) | needs-action ceremony in the wrong channel | PS-6/7 |
| one-row history "what else should it show" (v1748) | (data, fixed by §6.5) — but FOUND only because history finally had a surface | — |

---

## 14. The timeline carries conversation ONLY — the hygiene arc (added 2026-07-25, post-live-review)

### 14.1 The finding (a single live screenful)

One paste of the Warranty desk timeline contained FOUR content classes fighting one scroll:

1. a fan-out completion summary — conversation (belongs; bloated: ~30 words of repeated coaching),
2. a `deako.zendesk.com looks signed out` bubble WITH an "Open Admin view" button — system status
   (violates the §1 transcript ruling AND the VT-2/§7 channel policy; persisted, so it stays visible —
   and stale — after the case auto-resolves),
3. the desk LANDING (greeting · description · workflow launch cards · ＋ Workflow) — a page, interleaved
   mid-thread between the warning and a live run (the one-shot-surface disease; the launch-state gate either
   failed or re-asserted after the fan-out),
4. live run-step bubbles (`Step 1 of 2 … 11s`) — conversation in the wrong SHAPE (per-step bubbles; the §9
   one-component ruling is built only in its PS-9 minimal form).

Post-§8.4, (3) is also REDUNDANT: the landing's workflow cards duplicate the Rail workflows section in a
second styling system (the three emoji chips the §6.3 conformance advisory already flags).

### 14.2 Rulings

**TL-1 — the landing never interleaves with a thread.**
- The landing renders ONLY in true launch state (zero thread messages) and never re-asserts into `#messages`
  once a thread exists. Its self-gate becomes a hard precondition, not a courtesy check.
- The landing's workflow LAUNCH CARDS retire — the Rail workflows section (§8.4) is the one workflow surface.
  The three emoji chips die with them (closes the §6.3 advisory).
- ＋ Workflow keeps two doors: the empty landing's card (unchanged) and a trailing "＋ Workflow" row at the
  bottom of the Rail workflows section — so creation is reachable while a thread is up without re-entering
  launch state.
- The `from "X"` provenance tag shows only when the workflow's class ≠ this desk's class (post-1780 it is
  stale on-desk).

**TL-2 — no status bubbles in the transcript, ever.** The presence/signed-out warning bubble is DELETED, not
compressed: the fact is already fully carried by its channel-correct surfaces (the Admin incident CASE + the
Rail badge, §7). A status claim must never persist in a transcript — the transcript is durable and the claim
is not ("signed out" outlives the re-sign-in). If a desk-local hint proves necessary live, it is a TRANSIENT
chip in the composer area (the §4 chip infrastructure), never a message.

**TL-3 — one run, one bubble (§9 finished).** The full `_progressBubble`: the step line updates IN PLACE
(`Step i of N — "text"`), the tick region carries `onEach` progress, elapsed rides it (PS-9's ticker folds
in), and the result region replaces the whole thing on `done()` — which is also where the §6.5 history write
already hangs. The chain's per-step `appendMessage` calls migrate INTO it per-clause (the CD-1a phase-2
discipline; never a big-bang rewrite of the working chain).

**TL-4 — fan-out summaries are result lines, not coaching.** `✓ 2 cases · "show contacts" ran in each` +
case links. The how-to prose ("Open any to see its result; ask me to…") moves to a title tooltip; the Rail
cases section is the roster. The transcript records WHAT happened; the chrome teaches how to see more.

### 14.3 The ladder continues (§10 numbering)

| Rung | Builds | Depends on | Risk |
|---|---|---|---|
| **TL-1** | landing de-interleave (hard gate) + launch-card retirement + the Rail "＋ Workflow" row | §8.4 | medium (the landing's self-gate interacts with the wizard/fan-out re-render paths) |
| **TL-2** | delete the presence thread bubble (`_maybeWarnDeskConnections` path) | §7 | low |
| **TL-3** | full `_progressBubble`, adopted per-clause | PS-9 | medium-high (live run rendering; per-clause, verify each) |
| **TL-4** | compact fan-out summary line | — | low |

Order is by clutter-per-effort: TL-1 deletes the biggest block AND a dual-maintenance burden; TL-2 is a
deletion; TL-3 is the careful one; TL-4 is copy.
