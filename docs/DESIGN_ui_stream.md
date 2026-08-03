# DESIGN — UI verification: the app narrates its own UI (self-logging) + the taste residual

Status: **PARTLY BUILT + LIVE-VERIFIED** (v2.74.1971). Supersedes this doc's original "UI stream" proposal (keyframes /
deltas / `gu`/`guc` / fleet-shipped snapshots), which a critical review collapsed — see §7. Companion to
`DESIGN_cloud_logs.md` (the transport the markers ride) and the gl/gc log discipline.

---

## 1. The principle — report, don't photograph

**The gap.** The textual trace (`gl`/`gc`) records what the agent *thinks*; the panel's *visual behaviour* had no
record, so every UI fix ended "live-eyeball still owed" — panel UI, DOM feel, and cross-reload survival could not be
confirmed headless.

**The instinct we rejected.** "Record the screen" — a UI trace of snapshots or screenshots. A recording still has to
be *watched* (it doesn't verify anything); screenshots are PII-heavy, non-diffable, and — decisively — the side panel
**cannot be captured in-browser at all** (`captureVisibleTab` sees the web page, not the panel).

**The reframe that works.** Don't photograph the UI — have the app **narrate its own UI outcomes as TEXT markers on
the existing log stream.** The app already narrates its *thinking* (decision markers); extend that to narrate its *UI*:
what it decided to show, and the *measured* result of showing it. This makes UI correctness a **`gl` grep** —
greppable, diffable, PII-safe (numbers/enums, not pixels), and interleaved with the reasoning trace by timestamp.

> **Report the geometry; don't photograph the screen.** The app is a tailor measuring its own suit — the measurements
> (rows, spacing, edges, colours) prove the fit; a mirror is needed only for "does it look *sharp*" (taste, §5).

---

## 2. The fidelity ladder (as it actually shook out)

Three rungs, each an event the app emits *about itself*, deepening decision → measurement → taste. The first two are
built and live-verified; the third is the only residual a text marker structurally cannot reach.

| Rung | Emits | Answers | Fidelity | Status |
|---|---|---|---|---|
| **0 · DECISION** | `SHAPE ▸ answer+records \| answer-only \| …` | *did it choose the right thing to show?* | semantic | ✅ built + verified (v1964) |
| **1 · MEASURED LAYOUT** | `LAYOUT ▸ rows=6 overflow=no chip-styled=yes …` | *did it render correctly — no overflow, right count, CSS applied?* | measured (live DOM) | ✅ built + verified (v1971) |
| **2 · TASTE** | (a pixel + a judge) | *does it read **well**?* | subjective | ⏳ **pending** (§5) |

Alongside the runtime markers sits a **test-time assertion harness** (L1): pure invariants over a PII-safe view-model
(`Core/uiViewModel.js` + `uiInvariants.js`), run in `npm test`. Markers verify a *live* render from the log; L1 asserts
*logical* structure headless. Different tools, same goal — retire the eyeball for correctness.

---

## 3. What is built (inventory)

- **L1 — the logical checklist** (v1949, commit `d059a63`). `Core/uiViewModel.js` projects persisted state
  (`buildRailTree` + pane/tab facts) into a frozen, PII-safe snapshot (ids/enums/counts/flags — titles/summaries
  *stripped*). `Core/uiInvariants.js`: exactly-one-active, ≤1-pinned, no-desk-leak, wfCount-matches, and the
  **`noFreeText` executable PII boundary**, plus a **cross-reload equality** test (derive → serialize round-trip →
  re-derive → `deepEqual`) — cross-reload survival as a headless assertion.
- **`SHAPE ▸` — the reply-shape decision** (v1964, `a349cf0`). Emitted at both `_ilRunBuiltin` twin tails after a
  connector reply renders. Distinguishes `answer+records +showRecords` (additive fired) / `answer-only` / `records-only`
  / `empty`. *Verified live* (trace 161904): 4× additive on non-empty reads, 1× answer-only on a status read —
  branch-correct, not inert.
- **`LAYOUT ▸` — the measured appearance** (v1971, `066bc94`). `Core/uiLayout.js` (pure verdict) + chat.js
  `_measureLayout`/`_reportLayout` (the impure DOM read: `getBoundingClientRect` + `getComputedStyle`). Reports
  `rows / chips / bold / overflow / chip-styled / list`, flags `overflow` and `chip-unstyled` (the L2 CSS gap — a
  `<code>` chip chat.css didn't style). *Verified live* (trace 173634): `rows=6` matched the read, `overflow=no`,
  **`chip-styled=yes`** — chat.css styles the chips, confirmed from a grep.
- **Marker discipline.** Every marker is registered in **`Core/decisionMarkers.js`** (invariant #1, the ONE manifest),
  so it rides `gl`/`gc` *and* the fleet metric filters — never visible in one world, invisible in the other.

---

## 4. Design rulings (the lessons that generalise)

1. **Report, don't photograph** (§1). A text marker the app writes about itself beats an image something else has to
   capture and interpret.
2. **Two boundaries, cleanly split.** *Verdict logic is PURE* (`Core/uiLayout.js`, `Core/uiInvariants.js`) — unit-tested,
   no DOM. The *impure live-DOM read* is a thin reader in chat.js that passes plain numbers to the pure verdict. Never
   mix them.
3. **PII = the depth dial.** Markers carry numbers / enums / ids — never free text, bodies, or pixels. `noFreeText` makes
   "semantic = fleet-safe" an *executable* invariant, not a hope. This is what lets the markers ride the CW mailbox.
4. **The eyeball is RETIRED for correctness.** Decision (`SHAPE ▸`) + geometry/style (`LAYOUT ▸`) + logical structure
   (L1) cover every bug class in this app's history. Only *taste* remains a human's job.
5. **Deterministic markers read the LIVE DOM.** `LAYOUT ▸` measures the *actual rendered reply in the actual panel*, so
   "does it break in the real panel context" is already answered — which is why capturing the live panel (screenshots)
   buys nothing over the marker for correctness.
6. **Join by adjacency now, corrId later.** `SHAPE ▸` and `LAYOUT ▸` fire on the same reply and sit adjacent in the
   trace, telling one story (decision → measured render). A formal `corrId` would make the join explicit across streams.

---

## 5. The taste component — PENDING direction

The one residual: *does it read **well***? Subjective, holistic — no text marker can judge it. Taste splits into **two
independent decisions: the render source × the judge.** (Full exploration + critical reviews in the build log; the
conclusions:)

### Render source — where the pixels come from
| | What | Verdict |
|---|---|---|
| **R1** | Puppeteer/CDP render of the reply HTML + real `chat.css`, **fixture data** | ✅ **recommended** — clean, deterministic, CI-able, PII-safe, no native app |
| **R2** | native desktop capture of the live panel | ❌ rejected — **safe ⊥ real** (fixture data guts the "in-situ" value), whole-desktop PII, no fleet, needs a native app |
| **R3** | in-extension html2canvas | ❌ approximate render — *can lie* about the CSS it's meant to check |
| **R4** | CDP capture of the **live** panel (remote-debugging port) | ❌ **dissolves into R1** — `captureScreenshot` is a renderer re-paint (same mechanism as R1), safe ⊥ real again, dev-only/no-fleet, and `LAYOUT ▸` already owns the live-context niche |

**The recurring wall:** capturing the *actual* panel (R2 or R4) always hits the same three — *safe ⊥ real*,
*dev-only / no fleet*, and *the human is already there when it's live*. So taste uses **R1 (a clean fixture render), not
a photograph of the live screen.**

### Judge — who rates the pixels
- **J1 · human glance** — the gold standard for taste, and *free/instant* for a solo dev. The baseline.
- **J2 · golden pixel-diff** — deterministic regression ("did it change from the blessed shot?"), but only detects
  *change*, and every intentional restyle needs re-baselining.
- **J3 · vision model, absolute** — judges quality + articulates why, no baseline; but non-deterministic, costs tokens,
  drifting standard → **advisory only, never a gate**.
- **J4 · vision model vs. golden** — the **sweet spot for automation**: give the model the new shot *and* the golden,
  ask "regression or improvement?" — grounded against a human-blessed reference, tolerant of trivial pixel churn.

### Recommended direction (parked, now unblocked)
1. **Build R1 once** — a small "render this reply HTML with real `chat.css` → PNG" harness (Puppeteer/CDP). It is
   **dual-use** with the paused L2/`railDom` extraction (option A) and is the foundation every judge reuses.
2. **Start with J1 as a gallery** — render the key reply scenarios (fixture data) into one page you eyeball in ~5s.
   Human taste, minimal infra.
3. **Add J4 only if scale/consistency demands it** — vision-vs-golden over the same gallery; keep it advisory.

**ROI caveat:** for a solo dev the glance is hard to beat — automate taste only when scale or drift makes glancing
impractical, and even then **ground the machine judge against a human-blessed golden** rather than judging beauty in a
vacuum. Taste is the one place a human is still the best instrument.

**Status:** parked by the user until the deterministic rungs were live-verified — they now are (§3), so taste is
**unblocked**. Smallest real step: the R1 render harness + the glance-gallery.

---

## 6. Open threads / next steps

- **`corrId`** to formally join `SHAPE ▸` ↔ `LAYOUT ▸` (and future markers) across streams (today: turn-adjacency).
- **More surfaces**, only if a bug demands: `LAYOUT ▸`-style markers for the rail render, card mount, pane switch.
- **The R1 render harness** (= the paused option A / L2 extraction) — the foundation for taste *and* for any pixel/
  geometry regression tests beyond the in-app `LAYOUT ▸`.
- **Wire L1 live?** The invariants run only in the harness today; they could run as a *settled-state* self-check in the
  panel (emitting `UI ▸ invariant` on a violation) — but only debounced on a settled state (they false-positive
  mid-transition, e.g. `active-not-one` during a create).

---

## 7. Superseded — the original "UI stream"

The first draft of this doc proposed a full event *stream*: keyframes + deltas (a video-codec model), `gu`/`guc` depth
projections, a scrubber, decision↔render correlation, and fleet-shipped snapshots up to a pixel tier. The critical
review found it **over-designed** — a large recording apparatus around a small need — and, crucially, that a *recording*
doesn't verify anything (you still have to read it). It collapsed to what §1–§5 describe: **narrate UI outcomes as
markers + assert structure as invariants.** Kept from the original: the marker family reusing `decisionMarkers.js`, the
join-to-the-log idea, and fleet-via-mailbox for *text*. Dropped: keyframes/deltas, the scrubber, `gu`/`guc`, snapshot
correlation, and any fleet-shipping of pixels.
