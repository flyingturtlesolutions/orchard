# DESIGN — The Canvas (the app presentation layer)

*Status: spec + build path (no code yet). Companion to `DESIGN_conversations.md` (apps structure), `DESIGN_apps_learning.md` (the goal store), `DESIGN_inference_layer.md` (the IL leg loop), `DESIGN_surfaces.md` (the surface registry). v2.74.1203 baseline.*

## 1. Painpoint & decision

The side panel (~380px) is the **control plane** — the **Rail** + **Thread** panes (`DESIGN_conversations.md` §7.1): quick navigation + conversation + actions. The Canvas is the third pane, the **presentation plane**. Many app use-cases are **presentation**-heavy and the strip degrades them:

- a **finance** app maintains a personal-finance **HUD** that the app refreshes on a cadence;
- a **support** app **composes** a personalized troubleshooting guide (with capability-fetched screenshots) before sending;
- a **news anchor** app composes a daily **digest** of scraped events.

So an app may define a **canvas**: a roomy browser **tab** (mirroring Studio) that is the app's *presentation plane*. The panel stays the *control plane*. The canvas is **optional and app-defined — never required for any app to operate.**

## 2. The model (locked)

1. **Two planes.** Panel = control (talk + act). Canvas = presentation (the app's living output). An app with no canvas works entirely in the panel.
2. **The canvas is a dumb target, not an engine.** It renders the current state the app pushed. It runs nothing, schedules nothing, fetches nothing.
3. **Cadence / fetch / compute / send all live in the APP layer**, independent of the canvas (alarm → refetch → recompute → *optionally* push to the canvas). They are existing app/backend territory, **out of scope here** (§7).
4. **Interface = a primitive the app invokes** (chosen over "the answer targets the canvas"). Two `self`-domain legs:
   - `display(spec)` — push a read-only rendered view (HUD, digest).
   - `compose(spec)` — open an **editable** region (a reply, a guide).
   The IL selects/parameterizes them like any leg (DESIGN_inference_layer.md §4.3). Rationale: the primitive **generalizes** to data-driven renders *and* authored prose, and a **cadence refresh has no answer to attach to** but always has a `display()` call — one mechanism serves conversation- and alarm-driven rendering. (Answer-targeting can't express a data refresh; the primitive can carry authored prose as an argument. A→B subsumes, not B→A.)
5. **Effects are the renderer's job.** Animation, transitions, typewriter reveal, skeleton loaders, count-ups are 100% presentation-layer. The primitive ships a **structured spec**, never pre-baked HTML; the **stateful** canvas diffs successive specs and animates the delta (a HUD value ticks, a new digest item slides in). True token-streaming is achievable later by forwarding the streaming tool-call argument — orthogonal, deferred.
6. **Acting on composed content = the app's existing capabilities + rules + gates.** "Send the reply and set the ticket to pending" is an app *act* (a learned/grounded capability governed by the object-model transitions + standing rules, through the CX-6a write gate). The canvas only **exposes its compose-region content as a referenceable value**; it owns no send semantics.

## 3. Where it plugs in (real integration points)

| Concern | Mechanism | File |
|---|---|---|
| The two legs | `DISPLAY` / `COMPOSE` added to `BUILTIN_LEGS` — `domain:'self'`, `mode:'act'`, `safety:'auto'`, `requires:['canvas']` | `Core/palette.js:23` |
| Availability gate | `env.canvas` truthy only when the bound app defines a presentation layer → `availableBuiltins` offers the legs | `Core/palette.js:69`, set where `assemblePalette` is called (sg.js IL loop) |
| Surface to the LLM | automatic — palette legs feed the IL step prompt | `Core/stepPrompt.js` / `interpretPrompt.js` |
| Dispatch plan | new `self`-canvas branch in `planExec` → `channel:'RENDER_CANVAS'`, `busyMark:false`, payload = `{op, spec, anchor, mode}` | `Core/execPlan.js:75` |
| Executor | `createCanvasHandlers({...})` answers `RENDER_CANVAS`: validate spec → `CanvasStore` write → ensure/open canvas tab → broadcast | `background/handlers/canvas.js` (new), spread at `background.js:1674` |
| Persistence | `Services/Storage/CanvasStore.js` per-anchor chrome.storage RMW + broadcast (mirror `GoalMemoryStore`); `canvas` kind registered in `StoragePaths` (sync filter-gated OFF until additive activation) | new |
| The tab | `canvas.html` + `canvas.js` + `assets/canvas.css` (base `assets/sidepanel.css`, mirror `studio.html`); boots from `#anchor=`, reads `CanvasStore`, renders, listens for broadcasts → diff → animate | new; `web_accessible_resources += canvas.html` (`manifest.json:61`) |
| Open affordance | `btn-open-canvas` (mirror `btn-open-studio` `chat.js:132`): query existing tab → focus or create | `chat.js` |
| App defines canvas | `appDef.presentation` field → enables `env.canvas` | `Core/appDef.js` |

**Busy-mark (Invariant #2): N/A.** A canvas render does not drive a page with synthetic events — it writes a store + paints a tab. Like the connector domain (`execPlan.js:82`), it is **never** busy-marked. Do not add busy-marking here.

**Decisions log (Invariant #1):** add `RENDER_CANVAS` / `DISPLAY ▸` / `COMPOSE ▸` markers to `_DECISION_RE` (`studio.js:5888`) so a canvas render is visible in a `gc` decisions download.

## 4. The render spec (`Core/canvasSpec.js`, pure)

A `CanvasSpec` is the materialized view the app pushes — a **closed, safe-by-construction vocabulary** (constrained-rich, §5):

```
CanvasSpec = { anchor:{appId, conversationId|null}, title:string, blocks:Block[], rev:number }
Block      = { id, kind, …per-kind…, effect?:'none'|'fade'|'typewriter'|'count' }
```

| `kind` | fields | renders as | edit |
|---|---|---|---|
| `markdown` | `{ text }` | `renderMarkdown` (escape-first) | read-only |
| `metric` | `{ label, value, delta? }` | a HUD tile; `delta` animates a count/flash | read-only |
| `chart` | `{ chartType, data, options? }` | a vetted chart lib from the **data spec** — never code | read-only |
| `image` | `{ src, alt }` | `<img>`; `src` sanitized to `https:`/`data:` only | read-only |
| `compose` | `{ text, editable:true, ref }` | an editable region; `ref` ties it back to the conversation/draft so a capability can read its current content (§2.6) | **editable** |

Pure ops: `normalizeCanvasSpec`, `normalizeBlock` (drops unknown kinds — closed vocabulary), `sanitizeImageSrc`, `diffSpec(prev,next)→{added,removed,changed,moved}` (stable `id` match → the renderer's animation input), `composeContent(spec, ref)` (the value handed to the act layer). No clock/DOM/LLM — headless-testable.

`rev` is a monotonic revision per anchor (staleness guard + ordering for diff). Stamped by `CanvasStore` on write (the pure layer never reads a clock).

## 5. Safety

Rich rendering breaks the project's **escape-first** boundary (which works *because* nothing renders as live HTML). The canvas keeps the boundary by a **closed vocabulary**, not by escaping alone:

- **No `html`/`script`/arbitrary-JS block in v1.** Every kind renders through a safe path: markdown escape-first (`markdown.js`), `image` src-sanitized, `chart` from a **data spec** interpreted by a vetted lib (no eval, no remote code).
- **Untrusted data (scraped HTML, customer text, account data) is always a VALUE inside the spec, never executable.** Effects are the **trusted renderer** styling validated values — they do not widen the injection surface.
- **Single choke point.** Every spec passes `normalizeCanvasSpec` at the handler (write) *and* the renderer (paint) — two gates, one vocabulary.
- A future **`sandboxed-html` artifact kind** (full Claude-artifacts power: arbitrary HTML/JS in a hardened, network-less, CSP-locked iframe) is a **separate, gated slice** — not v1. See `DESIGN_injection_boundary.md`.
- **The compose→act handoff stays gated:** the canvas never sends. A capability reads `composeContent` and writes through the existing CX-6a gate (`confirmed:true` only after the human's review-in-canvas).

## 6. Build path (arc `CA-*`, pure-first)

Safe to build now (pure / inert) vs. needs a live panel eyeball (⚠):

| Slice | What | Files | Safe? |
|---|---|---|---|
| **CA-1** | render-spec schema + `normalize`/`diffSpec`/`sanitizeImageSrc`/`composeContent` + tests | `Core/canvasSpec.js` (new) | ✅ pure |
| **CA-2** | `DISPLAY`/`COMPOSE` legs + `planExec` canvas branch (`RENDER_CANVAS`, busyMark:false) + tests. Inert: `requires:['canvas']` + no handler yet → never offered, never dispatched | `Core/palette.js`, `Core/execPlan.js` | ✅ pure/inert |
| **CA-3** | `CanvasStore` (per-anchor RMW + broadcast) + `canvas` kind in `StoragePaths` (sync filter-gated OFF) + tests | `Services/Storage/CanvasStore.js`, `StoragePaths.js` | ✅ local-only |
| **CA-4** ⚠ | `createCanvasHandlers` → `RENDER_CANVAS`: validate→store→open/notify tab→broadcast; wire into `background.js`; add markers to `_DECISION_RE` | `background/handlers/canvas.js`, `background.js`, `studio.js` | ⚠ live (SW) |
| **CA-5** ⚠ | the tab: stateful safe renderer (markdown/metric/chart/image/compose), `diffSpec`→animate, broadcast listener; `web_accessible_resources += canvas.html` | `canvas.html/.js`, `assets/canvas.css`, `manifest.json` | ⚠ live (the renderer + safety — biggest slice) |
| **CA-6** ⚠ | `btn-open-canvas` (mirror `btn-open-studio`) + `env.canvas` from `appDef.presentation` + panel "shown in canvas" chip | `chat.js` | ⚠ live |
| **CA-7** | `appDef.presentation` field (an app declares it has a canvas + default blocks) | `Core/appDef.js` | ✅ pure (+ live env wiring in CA-6) |
| **CA-8** ⛔ | compose→act handoff: a capability reads `composeContent` and sends via the CX-6a gate | act path | ⛔ gated: eyeball **and** explicit go |

The pure spine (**CA-1 → CA-2 → CA-3 → CA-7**) is the safe build, mirroring the apps-learning arc (schema → store → wiring). CA-4–CA-6 are the live tab + renderer (the real engineering: safe rich rendering). CA-8 touches the world and waits.

## 7. Out of scope / deferred

- **Cadence firing** — `chrome.alarms` re-invoking an app's refresh is **app-layer**, not the canvas (the parked apps "cadence" dimension, `DESIGN_conversations.md` §6A). The canvas only receives the resulting `display()`.
- **`sandboxed-html` artifacts** — full arbitrary-HTML/JS artifacts in a hardened iframe; a separate gated slice (§5).
- **Cloud sync of canvas state** — `canvas` kind is registered but filter-gated OFF; additive activation later (the `GoalMemoryStore` pattern).
- **True token-streaming into the canvas** — forwarding the streaming tool-call argument; an enhancement to CA-4's transport, not v1.

## 8. External presentation backends — Google Docs/Sheets as the canvas (designed 2026-07-02)

The canvas is a *plane*, not a *tab*: the same `display`/`compose` primitives + the same `CanvasSpec` can render into an **external document** — a Google Doc (composed prose) or Sheet (live data) — via the broker's GA REST channel (`DESIGN_connectors.md` §5.2). The app's presentation becomes a **durable, shareable artifact** (versioned by Google, viewable by people who never installed Orchard) while everything else in the model stays put.

**8.1 The model (all §2 axioms hold, two get sharper):**
- **Panel = control plane, ALWAYS.** The human steers conversationally from the Thread ("change the first line", "include account information") — they do **not** edit the Doc. The IL revises the **spec** and re-renders. The Doc is **display-only by contract**: a re-render overwrites external edits (v1 documents the rule; v2 may diff-detect foreign edits and warn before overwriting).
- **The spec is the single source of truth**, held in `CanvasStore` exactly as for the tab backend. The Doc is a projection; **nothing is ever read back from it** — delivery, revision, and reference all work from the spec. (No read-back ⇒ no named-range requirement; named ranges demote to a v2 partial-re-render efficiency.)
- **Backend selection is app config**: `appDef.presentation.backend: 'tab' | 'gdoc' | 'gsheet'` (default `'tab'`). The dispatch/executor path is unchanged up to `RENDER_CANVAS`; the handler routes to the tab broadcast or the external-render adapter per backend.
- **Ownership boundary enforced by scope**: the external doc is created by the app under **`drive.file`** — the token can only touch files the app created, so auto-rendering the app's own presentation doc is safe *at the API level*, and every other document is unreachable. No per-render HITL (same stance as tab renders, `safety:'auto'`); the CX-6a gate still owns anything that leaves the app (8.4).

**8.2 Spec-revision turns (the workstation feel).** "Change the first line" is not a fresh compose — it is an **edit bound against the current spec** (which block, which line) producing a **minimal delta**, then a re-render. Contract: the compose/interpret call for an edit-ask receives the current `CanvasSpec` as fenced context (extends CA-9 compose-live from "compose next state" to "revise addressed state"); the reply is a revised spec (or block-level patch), `rev` bumps, the backend repaints. Cadence-realtime: seconds, not keystrokes — Docs/Sheets write quotas sustain ~1 request/sec, which compose-live cadence fits comfortably.

**8.3 Format-fidelity contract (WYSIWYG by construction).** The preview and the sent reply are **two lowerings of the same spec**, so fidelity is a vocabulary rule, not a scraping problem:
- **Two tiers.** *Presentation-only* blocks (context summary, timeline, metrics, charts) may use the full canvas vocabulary — they never ship. The **deliverable block** (`compose`) is constrained to the **delivery-safe subset**: paragraphs, bold/italic, links, bulleted/numbered lists — exactly what Zendesk `html_body` / Gmail `text/html` render. The Doc preview of the reply block therefore cannot over-promise.
- **Per-surface lowerings from one parser** (`Core/canvasLower.js`, pure): spec → Docs `batchUpdate` (preview) · spec → semantic HTML (delivery) · spec → plain text (degrade). One markdown-subset parser feeds all three ⇒ **preview/delivery parity is a unit test**, not a hope.
- **Escape-first extends to the HTML lowering**: interpolated untrusted values (ticket text, names) are escaped; link hrefs sanitized to `https?:`. Same boundary as the panel's markdown path.

**8.4 Delivery (the CS-agent workflow's last hop).** "Send it" in the panel → the reply text/HTML comes **from the spec's compose block** (`composeContent`) → one of:
- **Ride-write** (Zendesk comment `html_body` / Gmail MIME): **full formatting fidelity**, deterministic, behind the existing CX-6a confirm gate — the default for rich replies;
- **Drive-fill** (fill the site's composer; the human clicks Send): the conservative outward-send stance, but **plain-text fidelity** — the confirm bar says so ("delivers as plain text"), never a silent downgrade.
CA-8's gate applies unchanged — the canvas exposes content; the act layer sends.

**8.5 The motivating workflow (CS agent):** get tickets (Ride reads) → get context (Ride + interrogator) → **compose in the Doc** (display/compose → gdoc backend; IL streams context + draft) → **revise conversationally from the panel** (8.2) → **deliver** (8.4). The draft→accepted-edit deltas are labeled learning signal for the app's preset memory (`DESIGN_apps_learning.md`).

**8.6 Build path (arc `GD-*`, pure-first):**
| Slice | What | Safe? |
|---|---|---|
| **GD-1** | `Core/canvasLower.js` — markdown-subset parser + spec→Docs `batchUpdate` (replace-body v1, parameterized `bodyEndIndex`) + spec→HTML + spec→plain + parity tests | ✅ pure |
| **GD-2** | `googleRest.cjs` docs section (`documents.create`/`batchUpdate`/`get` for bodyEndIndex) + `google-docs` catalog/channel entries + `documents`+`drive.file` scopes (one re-link grants all) | ✅ headless (injected fetch); deploy-gated live |
| **GD-3** | backend registry: `appDef.presentation.backend` + the `RENDER_CANVAS` handler's gdoc route (create-once per anchor, store docId, render on display/compose) | ⚠ live |
| **GD-4** | spec-revision turns: current spec into the compose/interpret context; block-addressed edits | ⚠ live (prompt + loop) |
| **GD-5** | delivery: `composeContent` → Ride-write `html_body` (confirm-gated) / Drive-fill plain (+format notice) | ⛔ gated (CA-8's go) |
| **GD-6** | `gsheet` backend (spec `metric`/table blocks → `values.update` — naturally diffable; the dashboard case) | after GD-3 |
