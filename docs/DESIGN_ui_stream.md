# DESIGN — the UI stream (the visual counterpart of the textual trace)

Status: PROPOSED (v2.74.1949). Companion to `DESIGN_cloud_logs.md` (the transport it rides) and the gl/gc log discipline.

---

## 1. The idea

The textual trace (`gl`/`gc`) is a **time-ordered stream of events** at varying signal density. The panel's visual behaviour has no counterpart, which is why every UI fix ends "live-eyeball still owed" — panel state, DOM feel, and cross-reload survival can't be confirmed headless.

The UI stream is that counterpart: **a time-ordered stream of UI events**, keyed and scoped exactly like the log trace, so the panel's behaviour becomes *readable, greppable, diffable, testable, and fleet-shippable* the way reasoning already is.

The correspondence is literal, and the design follows from it:

| Textual trace | UI stream |
|---|---|
| stream of log lines | stream of UI events |
| `gl` — full depth (every line) | `gu` — every UI event |
| `gc` — decisions (story-carrying markers) | `guc` — UI-decisions (story-carrying transitions) |
| `glf` — fleet scope | UI stream over the CW mailbox |
| version-keyed; `findings.md` synthesis | version-keyed; correlates with the textual trace |
| one marker = one event | one event, encoded at a chosen **fidelity** |

The last row is the crux: a log line is always text, but a UI event can be encoded at varying fidelity (semantic → pixels). Fidelity is a **per-entry dial**, not a separate artifact — the same insight as "a UI trace is a stream, not a screenshot."

---

## 2. Core model — keyframes + deltas

The stream is built like a video codec (and like the log trace, whose full state is implicit in its event sequence):

- **Keyframes** — periodic full *semantic snapshots* of the panel's logical state (the view-model). Self-contained; a reader can start here.
- **Deltas** — the individual UI events between keyframes (a pane switch, a card mount, a badge change).

State at any time `t` is reconstructed by taking the last keyframe ≤ `t` and replaying deltas up to `t`. This unifies the two things the earlier catalog wrongly split: **the snapshot is the keyframe, the journal is the deltas.** One stream, two entry kinds.

```
KF ────Δ──Δ──Δ────KF ──Δ──Δ────KF ──Δ──►   (t →)
▲ full view-model     ▲ pane switch, card mount, badge…
```

Keyframe cadence: session start · every major transition (pane switch, desk open, reload) · every N deltas (N≈25, bounded so replay stays cheap).

---

## 3. Event vocabulary — the `UI ▸` marker family

A new marker family in `Core/decisionMarkers.js` (the one manifest that backs gl/gc and generates the CloudWatch metric filters). Each entry is one line; the marker names the category, the payload is a compact delta.

| Marker | Fires on | Payload (delta) |
|---|---|---|
| `UI ▸ pane` | active pane change | `from→to` (rail/thread/canvas) |
| `UI ▸ rail` | rail render / tab switch / peek / pin | `tab`, `rows`, `pinned`, cause |
| `UI ▸ thread` | thread render / message append | `conv`, `msgs`, `+card`/`-card` |
| `UI ▸ card` | card mount + lifecycle state | `id`, `kind`, `state` (mounted/running/step-k/done/failed) |
| `UI ▸ badge` | pending / count change | `target`, `pending`, `delta` |
| `UI ▸ canvas` | canvas open / render / compose | `open`, `kind`, `rows` |
| `UI ▸ anim` | animation start/end (the timing signal) | `name`, `target`, `phase`, `ms` |
| `UI ▸ overlay` | HITL bar / disclosure drawer / relearn bar | `kind`, `shown`/`dismissed` |
| `UI ▸ kf` | a keyframe (§2) | the full view-model (§4, L1) |

Story-carrying vs noise (the `guc` filter, §5): `pane` · `card` · `badge` · `canvas` · `anim` · `overlay` · `kf` carry the story; a bare `thread`/`rail` re-render is noise unless it changes the roster.

---

## 4. The fidelity ladder — encoding one entry

Every event defaults to the cheapest encoding; deeper levels attach on keyframes, on-demand, or on-anomaly. Depth is also a **PII dial** (§9) and a **cost dial**.

| Level | Encoding | Source | When | Machine-checkable | Appearance-truthful |
|---|---|---|---|---|---|
| **L0** | semantic delta | module state (`_railTab`, ids) | every event | ✅ | ✗ |
| **L1** | full view-model (keyframe) | **pure model** — `buildRailTree`, `ConversationStore`, active pane | keyframes | ✅ diffable | ✗ (model-derived) |
| **L2** | structural DOM clone (scrubbed) | `panel.cloneNode` → strip/scrub | on-demand / on-anomaly | ✅ | partial |
| **L3** | geometry — `getBoundingClientRect` + salient `getComputedStyle` + scroll/overflow/stacking, for the changed subtree | live DOM | on layout-relevant events / on-demand | ✅ **assertable** | ✅ (it *is* the layout) |
| **L4** | pixels — screenshot (debugger `Page.captureScreenshot`, or html2canvas) | live compositor | explicit request only | ✗ | ✅ ground truth |

L0/L1 are **derivable from the pure model → capturable and assertable headless** (the whole point: UI-state *tests* in the `npm` harness). L2–L4 need the live DOM and are impure, so they sit behind explicit/anomaly gates. L3 (geometry) is the high-value middle rung the first catalog omitted: it catches overflow/z-index/spacing/vanishing-cards *without pixels* and *can't lie* (it measures what laid out).

### L1 keyframe schema (the view-model)

```json
{ "t": 1730000000000, "v": "2.74.1949", "kind": "kf",
  "pane": "thread",
  "rail": { "tab": "automations",
            "rows": [ {"id":"admin_desk","role":"admin","active":true,"pinned":false,"cases":2,"wfCount":1} ] },
  "thread": { "conv":"admin_desk", "msgs":3,
              "cards":[ {"id":"wf-run:w1","kind":"workflow-run","state":"running:step2"},
                        {"id":"vtc_a","kind":"case"} ] },
  "canvas": { "open": false } }
```

### L0 delta schema

```json
{ "t": 1730000000420, "v": "2.74.1949", "kind":"ui",
  "marker":"rail", "target":"rail", "from":"conversations", "to":"automations", "cause":"tab-click" }
```

---

## 5. Depth projections & shorthands (the gl/gc analogue)

Same stream, two densities, plus scope — exactly mirroring gl/gc/glf:

- **`gu`** ("grab UI") — the FULL stream: keyframes + every delta at L0/L1. The `gl` twin.
- **`guc`** ("grab UI-decisions") — keyframes + story-carrying deltas only (§3). The `gc` twin — the signal-only visual story.
- **fleet** — the stream over the CW mailbox (`orchard-ui-*` hour-files), semantic depth only (PII-safe, §9). The `glf` twin.
- **join** — every entry is version-keyed and millisecond-stamped through the same Logger ring, so it interleaves with the textual trace (§8).

Shorthands follow the existing memory discipline (`gl`/`gc`/`gch`/`glf`): move the file from Downloads into `logs/run/`, read incrementally since the last findings boundary, no commit/bump.

---

## 6. Capture — the seams

One thin API, `uiTrace.mark(marker, delta)` / `uiTrace.keyframe()`, emitting through the **existing Logger ring** so scrub, ring-eviction, Download, and CW shipping come for free.

Instrument the render/transition seams that already exist in `chat.js`:

- `_switchRailTab` → `UI ▸ pane` / `UI ▸ rail`
- `_renderActiveRailTab` / `_renderRailList` → `UI ▸ rail` (roster deltas only)
- `_setMessageBody` / `appendMessage` → `UI ▸ thread` (+card/-card)
- card mount + the workflow-run step highlighter → `UI ▸ card`
- `_slideOpen` / `_slideClosed` → `UI ▸ anim` (start + end, with measured ms — the timing signal that no static capture carries)
- pane changes, canvas open/compose, HITL/relearn bars → `UI ▸ canvas` / `UI ▸ overlay`

Keyframes: `uiTrace.keyframe()` serializes the L1 view-model from `buildRailTree(...)` + the active pane + the thread roster — **pure inputs**, so the serializer is unit-testable and needs no DOM.

Purity split: L0/L1 pure (testable, always on). L2–L4 touch the live DOM and are gated (on-demand / on-anomaly).

---

## 7. Reconstruction — the scrubber

The stream is text (JSONL), so it reads/greps/diffs like gl. For appearance:

- **State-at-t** — replay from the last keyframe to any event index → the L1 view-model at that moment.
- **Pixels-at-t** — feed the reconstructed L2 structural snapshot + the real `chat.css` into the headless-Chrome replay already proven on the slide-animation bug → reconstructed pixels *on demand*, without storing images.
- **Motion** — the `UI ▸ anim` deltas (start/end + ms) give the timing sequence a single frame can't, closing the animation/defer-under-engagement class.

---

## 8. Correlation with the textual trace — the payoff

Both streams flow through the same ring, so they **interleave by timestamp + version**:

```
14:03:12.100  ROUTE ▸ "show open tickets" → connector:LIST_TICKETS
14:03:12.540  INVOKE_SESSION ▸ ok (12 rows)
14:03:12.560  UI ▸ thread conv=support +card=results (12)
14:03:12.560  UI ▸ anim slide-open thread:results 180ms
```

This is the artifact neither stream has alone: **decision → render causality.** "The router chose the read — did it actually reach the screen, in the right pane, without a phantom re-render?" is answerable from one merged view. It also catches the desync class directly (a decision with no matching `UI ▸`, or a `UI ▸ card` with no upstream decision = a phantom render).

---

## 9. Scrub / PII — depth is the PII dial

- **L0/L1 (semantic)** — ids, kinds, counts, flags. Low PII; reuse the Logger `#scrubEntry` that already runs at append. Fleet-safe.
- **L2 (structural)** — text nodes carry data → scrub the clone before serialising. Local by default.
- **L3 (geometry)** — numbers + style; PII-light. Local by default.
- **L4 (pixels)** — renders real customer data, unscrubbable → **explicit request only, never fleet.**

The fidelity dial and the transport gate move together: deeper = more PII = more restricted scope. Clean and enforceable.

---

## 10. Storage / transport

- **Local** — `logs/run/orchard-ui-*.jsonl`, one event per line (greppable), keyframes + deltas interleaved. Rides the existing Download button as a ride-along (the pattern `_downloadChats` already uses — one click exports logs + chats + UI stream).
- **Fleet** — the CW mailbox (`DESIGN_cloud_logs.md` §12), semantic depth only, UTC hour-files, glf grammar. Opt-in with the existing `settings:cloudLogs` gate.
- **Join key** — `manifest` version, same as every other stream.

---

## 11. Invariant layer — assertions over keyframes

The highest signal-per-byte isn't a capture, it's a **contract check** run over each L1 keyframe (pure → in the `npm` harness):

- exactly one pinned rail row;
- no case/card leaks across desks (parentId integrity);
- active pane ⟺ exactly one active rail row;
- no workflow-run card stuck `running` past a keyframe with no `anim`/`card` progress;
- (with L3) no element overflows its container; no negative-z occlusion of an interactive control.

A violation is a `UI ▸ invariant` event — a failure line in the stream, and a red test in the harness. This is where "cross-reload survival" finally becomes a headless assertion: capture a keyframe, reload, capture again, assert equality of the logical view-model.

---

## 12. Build phases

- **UI-1** — the `uiTrace` bus + `UI ▸` markers in `decisionMarkers.js`; instrument the §6 seams (L0 deltas through the Logger ring). *The stream exists.*
- **UI-2** — L1 keyframe serializer from the pure model; unit-tested. *Snapshots exist and are testable.*
- **UI-3** — depth projections + `gu`/`guc` shorthands + Download ride-along. *The gl/gc twins.*
- **UI-4** — the scrubber (replay → view-model at any t).
- **UI-5** — L2 structural + L3 geometry on-demand encodings + the puppeteer pixel-replay.
- **UI-6** — the interleaved decision↔render view (§8).
- **UI-7** — fleet via the CW mailbox (semantic depth).
- **UI-8** — L4 pixels as the explicit escape hatch (debugger `Page.captureScreenshot` preferred over html2canvas for fidelity; §4/§9 gates).
- **UI-inv** — the invariant layer (§11), folded in from UI-2 onward as keyframes land.

Ordering rationale: UI-1..3 deliver the whole *stream* (the actual analogue of gl/gc) using only pure model + existing transport — cheapest, testable, fleet-safe, and already covering the logical + timing bug classes. Pixels (UI-8) come last because they're the least pipeline-friendly and most of their value is recovered by L3 geometry + L2 replay.

---

## 13. Open questions

1. **Keyframe cadence** — is every-N-deltas + major-transition enough, or do we need a keyframe on every user turn (cheap, and aligns the UI stream to the chat stream)?
2. **Delta granularity** — does every `_setMessageBody` emit, or only roster-changing renders? (Noise vs completeness; the `guc` filter mitigates, but the full `gu` size is set here.)
3. **Geometry scope** — L3 on the whole panel, or only the changed subtree? (Cost vs coverage.)
4. **Replay fidelity** — the L2 clone is static; live-only state (hover/focus/mid-animation) needs either an `anim`-driven reconstruction or an L3 computed-style capture at the moment. Which?
5. **Retention** — UI stream in the same ring as the textual trace (shared eviction budget) or its own ring? (A busy UI could evict decisions.)
