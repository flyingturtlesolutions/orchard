# SPEC_DEV — Spec Deviations Log

**Purpose.** This file is the authoritative log of every place where the
shipped implementation deliberately diverges from a written spec
(`LANDMARK_SPEC.md`, `02-CAPABILITIES.md`, `IFRAME_SCOPING_SPEC.md`, or
any successor). Each entry captures **what the spec says**, **what we
did instead**, **why**, and **who decided**.

**Maintenance rule (binding).**
- When implementation work surfaces a spec deviation, the implementer
  surfaces it for decision BEFORE coding.
- Once the user has decided, the implementer adds an entry to this file
  in the same change that ships the deviation.
- Entries are append-only. To reverse a decision, add a NEW entry that
  references and supersedes the old one — do not edit history.
- Entries are dated. Use ISO date (YYYY-MM-DD) at time of decision.
- Entries reference the manifest version at which the deviation
  shipped, so the codebase state can be reconstructed.

**Entry template.**

```
## [YYYY-MM-DD] <short title> — v<manifest version>

**Spec.** <Path/section> says <verbatim or paraphrased>.

**Deviation.** <What we did instead, concretely.>

**Justification.** <Why this is better here. Bullet list of concrete
reasons, ideally each tied to a measurable concern: cost, noise,
correctness, scope.>

**Trade-off accepted.** <What the spec's path would have given us
that we forgo.>

**Decision.** <user|implementer|joint>. <Optional: notes from the
discussion.>

**Reversibility.** <How hard to revert if we change our minds.>

**Touched.** <Files where the deviation lives, so future readers
can locate it.>
```

---

## [2026-05-22] Action-effect vocabulary expansion + LLM proposal — v2.74.303

**Spec.** The substrate spec defines `proposedEffect` heuristic at
authoring time (`_proposeActionEffect`) plus runtime observation. The
spec doesn't constrain the vocabulary itself nor mandate which heuristic
patterns the proposer should recognize. The earlier deviation entries
[v2.74.250, v2.74.266] established the observation pipeline and Apply
UX; this entry covers the AUTHORING-TIME proposer.

**Observed gap.** The original `_proposeActionEffect` heuristic
recognized only four patterns (anchor href, aria-haspopup=dialog,
aria-controls→dialog, form-action submit) and produced one of five
non-unknown values. In practice this left "always unknown" on:
filter dropdowns (aria-haspopup="listbox"), tab strips (role="tab"),
toggle widgets (checkbox/radio/switch), accordion headers
(aria-expanded), in-place form submits, and the long tail of
role-based interactive controls.

**Change.** Two-stage proposer:

1. **Rule-based heuristic expanded** (`_proposeActionEffect`).
   New branches recognize:
   - `aria-haspopup="menu|listbox|tree|grid|true"` → `opens-menu`
   - `aria-controls` → resolves target role: `tabpanel` →
     `switches-tab`, `menu/listbox/tree/grid` → `opens-menu`,
     `region/group` → `toggles-expansion`, `dialog` →
     `triggers-modal` (existing path)
   - `role="tab"` → `switches-tab`
   - `role="switch|checkbox|radio|menuitemcheckbox|menuitemradio"` →
     `toggles-state`
   - `<input type="checkbox|radio">` → `toggles-state`
   - `<input type="submit">` in a form WITHOUT action attr →
     `submits-in-place` (was `unknown`)
   - `<button>` with `aria-expanded` (any value) → `toggles-expansion`
   - `<button type="submit">` in a form WITHOUT action attr →
     `submits-in-place`
   - `<select>` → `opens-menu`
   - Any other element with `aria-expanded` → `toggles-expansion`

2. **LLM proposal in `generateLandmarkProfile`.**
   New `actionEffect` field added to the prompt's JSON schema.
   Claude picks from the same expanded vocabulary using DOM + the
   wider context screenshot with highlight box (v2.74.298). Parser
   clamps to the vocabulary; any out-of-vocab value normalizes to
   `unknown`.

**Two-stage seeding rule.** Sidepanel takes the heuristic value first,
then upgrades from Claude when the heuristic returned `unknown` and
Claude returned anything else. Author-set values (already non-null
when re-Picking) always win — neither stage overrides existing
author edits.

**Vocabulary additions.** Six new values (joining the original six):
`opens-menu`, `switches-tab`, `toggles-expansion`, `toggles-state`,
`submits-in-place`, `mutates-page`. The dropdown in the drawer
exposes all twelve.

**Justification.**
- The heuristic's narrow patterns missed the most common UI shapes
  (filter dropdowns specifically were "always unknown" on the user's
  pixabay test case).
- Expanding the heuristic is cheap, deterministic, and leverages
  the substrate's already-computed a11y role + ARIA attributes —
  no LLM cost, no extra round-trip.
- LLM proposal handles the residual cases where DOM signals are
  weak but visual cues are strong (chevron icons, dropdown affordances,
  selected-tab styling). Cost is marginal — adding one field to a
  prompt that's already running.
- Strict vocabulary clamping prevents Claude-hallucinated categories
  from leaking into the drift-detection pipeline.

**Trade-off accepted.** The heuristic now produces a definitive
classification more often, which means the drift-event pipeline
(observed ≠ proposed) fires more often. That's the intent — the
substrate previously skipped drift detection for unknowns and now
catches mismatches it couldn't before. Authors who don't want drift
events on a particular landmark can re-set its effect to `unknown`
manually.

**Decision.** Joint (user explicitly chose "Paths A + B — heuristic
floor + Claude proposal").

**Reversibility.** Easy.
- Heuristic rollback: revert `ContentScripts/contentScript.js`
  `_proposeActionEffect` to its v2.74.244 shape.
- LLM rollback: remove the `actionEffect` field from the prompt
  schema in `Services/AnthropicService.js#generateLandmarkProfile`
  and the corresponding extractor in the parsed block.
- Vocabulary rollback: revert `_renderActionEffectRow`'s `<option>`
  list. Existing landmarks with the new values would render as
  unknown labels in the dropdown but the stored value persists
  unchanged.

**Touched.**
- `ContentScripts/contentScript.js` — expanded `_proposeActionEffect`.
- `Services/AnthropicService.js` — `actionEffect` field added to
  `generateLandmarkProfile` schema + prompt section explaining the
  vocabulary + parser with VOCAB-set clamp.
- `Sidepanel/modes/locale-capture.js` — expanded vocabulary in
  `_renderActionEffectRow`; two-stage seeding rule in the
  Pick→Claude post-call block; diagnostic log shows both
  `heuristicEffect` and `claudeEffect`.

---

## [2026-05-22] ACTION_SPEC full-compliance pass — v2.74.305–v2.74.308

**Spec.** `ACTION_SPEC.md` (canonical Tier 0 Action substrate doc),
received 2026-05-22. § 5 defines the effect taxonomy as exactly five
substrate-level browser effects with structured parameters; § 5 puts
effect on the Action record (not the Landmark); § 10 defines Fragment
`aggregatedEffects`; § 3 defines the bounded 12-kind action list
including KEY and three browser-modal kinds.

**Supersedes [v2.74.303].** That entry's 12-value single-string
`actionEffect` vocabulary conflated two orthogonal concepts:
substrate-level browser effects (spec § 5) and DOM-level interaction
patterns (our addition). This pass splits them correctly.

**Changes (this pass is ALIGNMENT toward spec, narrowing prior
deviation rather than widening it):**

1. **Effect taxonomy split (v2.74.305).** `landmark.actionEffect`
   (string) → `landmark.effect` ({kind, form?, modalKind?}, spec § 5's
   exact 5-kind vocabulary) + `landmark.interactionPattern` (string,
   our DOM-pattern intel: opens-menu / switches-tab / toggles-expansion
   / toggles-state / submits-in-place / mutates-page). Heuristic
   (`_proposeActionEffect`), Claude prompt+parser, drawer (two
   controls), hydration migration (`_hydrateLandmarkEffectShape`),
   and the drift classifier (`classifyEffectDrift` — 4-way severity
   per § 8: expected-missing / unexpected / parameter-mismatch / null).

2. **Effect on Action (v2.74.306).** Per § 5, effect lives on the
   Action; the landmark provides a DEFAULT copied onto the action at
   link time (`_applyActionLandmarkRef`). Same landmark can carry
   different declared effects in different fragments. rawJson
   serialize (defaults omitted) + hydrate; runtime treats `step.effect`
   authoritative over the landmark default (TemplateWalker); schema
   validation rules added.

3. **Fragment aggregatedEffects (v2.74.307).** Per § 10 — deduped
   union of constituent action effects (opens-new-thread by form,
   triggers-modal by modalKind, others globally; none never
   aggregated). Persisted on the fragment record. Consumption by
   Workflow directive coverage is future (no Workflow tier yet).

4. **KEY action (v2.74.308).** Per § 3 — sends a named key to the
   resolved element (value = key name). `handleKey` in content script
   (keydown/keypress/keyup + key-code map; Enter delegates to
   handleEnter for implicit-submit). Schema kind + capability op
   (focusable element) + fragment dropdown entry.

**DEVIATION — interactionPattern is a substrate ADDITION not in spec.**
The spec's effect taxonomy is bounded to 5 kinds. We keep a SEPARATE
`interactionPattern` field for DOM-level intel (dropdown / tab / toggle
shapes) because it's genuinely useful at authoring time even though
it's not a substrate-level effect. It does NOT pollute the spec's
effect field — the two are orthogonal. interactionPattern carries no
orchestration weight (no Workflow directive responds to it); it's
display + authoring-assist only.
**Decision.** User chose "Full spec compliance pass." interactionPattern
retained as a deliberate, isolated extension.

**DEVIATION — Fragment perspective anchor is DERIVED, not authored (v2.74.318).**
LOCALE_SPEC § 13 describes a description-first authoring flow where the
user starts from a Locale (perspective) and authors operations within
it. Our fragment authoring predates that model: the author adds actions
and links landmarks ad hoc. So instead of an explicit up-front Locale
pick, we DERIVE the fragment's perspective anchor (`fragment.localeIds`)
from the Locales that own its linked landmarks (`_fragmentPerspective-
LocaleIds`). Recomputed on every save. The active-perspective banner
surfaces both the page's active Locales (§ 8) and the fragment's
authored-against Locales, flagging when an authored-against perspective
isn't active on the current page. This gives the spec's perspective-
scoping benefit (the runtime/Workflow tier can see which perspectives a
fragment depends on) without restructuring the authoring flow around a
mandatory up-front Locale selection.
**Decision.** Implementer (conformant intent, pragmatic mechanism).
Reversible: drop `localeIds` from the save record + the banner's
authored-against line.

**DEVIATION — KEY is focus-targeting, not landmark-targeting (v2.74.315).**
ACTION_SPEC § 3 lists KEY among the landmark-targeting actions (`target`
required, § 6 step 2 validates a focusable resolved element). We
implement KEY like ENTER: the authoring UI has NO selector field; the
key dispatches to `document.activeElement`. Rationale: keys are almost
always sent to the just-focused element (Escape to close a popover,
ArrowDown through an open listbox, Tab to advance, Enter to submit) —
the action that focused the element is the preceding step. Requiring a
landmark target added friction with no real benefit, and ENTER already
set this precedent. The content-script `handleKey` still accepts an
optional selector for forward-compat; only the UI omits it. KEY's value
row is a dropdown of common keys + a separate `{{PARAM}}` field (the
dropdown doubles as the verify-time literal when a param is bound).
**Decision.** User-directed ("Remove selector field" + "dropdown for key
name, {{PARAM}} in a separate field"). Reversible: restore KEY's meta
`selector: 'required'` and remove it from SchemaValidator's
selectorOptional list.

**DEFERRED — Phase 5 browser-modal handling.** Spec § 7 (ACCEPT/
DISMISS/RESPOND_TO_PROMPT + alert/confirm/prompt hooks) NOT
implemented. `window.confirm()` blocks the JS thread synchronously,
so a content-script hook (the spec's stated approach, § 7 + § 14.4)
cannot honor § 7.4's `autoAccept:false` "pause and surface to user"
default — it must return synchronously. True async modal handling
needs chrome.debugger CDP (Page.handleJavaScriptDialog), which adds
the "AHuB is debugging this browser" banner and a complex attach
lifecycle. Browser modals are rare on the target sites.
**Decision.** User chose "Skip Phase 5 for now." Revisit via CDP if a
real site needs it. The effect taxonomy already RESERVES
`triggers-modal { modalKind }` so the annotation is forward-compatible
when handling lands.

**DEVIATION — effect source vocabulary extended (Phase 6, v2.74.309).**
Spec § 5 defines `effect.source: 'observed' | 'authored'`. Our pipeline
has more sources, so we extend to `'heuristic' | 'claude' | 'authored'
| 'observed'`. 'authored' and 'observed' match the spec; 'heuristic'
(rule-based proposer) and 'claude' (LLM proposal) are AHuB-specific
proposal stages the spec doesn't model. Informational metadata only.

**Reversibility.** Moderate. The split touches the storage shape
(landmark.effect/interactionPattern, action.effect), but the
hydration migration is idempotent and reads all legacy field names,
so a rollback would need a reverse-migration. Per-phase reverts are
documented in each version's commit.

**Touched.**
- `ContentScripts/contentScript.js` — `_proposeActionEffect` returns
  {effect, interactionPattern}; `_diffObservationSnapshots` emits
  spec-aligned observedEffect object + observedInteractionPattern;
  `handleKey` + key-code map; KEY in EXECUTE_STEP switch.
- `Services/AnthropicService.js` — `generateLandmarkProfile` schema +
  prompt split (effect object + interactionPattern); parser clamps both.
- `Services/ActionEffectObserver.js` — `classifyEffectDrift` (4-way
  severity); `shouldObserveStep` generalized to any declared effect.
- `Services/TemplateWalker.js` — `declaredEffect` precedence
  (step.effect > landmark default); drift severity in event payload.
- `Services/LandmarkResolver.js` — `_resolvedFromLandmark` carries
  effect + interactionPattern; legacy proposedEffect derived for
  back-compat.
- `Services/SchemaValidator.js` — KEY kind; effect + interactionPattern
  step rules.
- `Services/LandmarkProfile.js` — KEY operation (focusable elements).
- `Sidepanel/modes/locale-capture.js` — two-control effect/pattern
  drawer; `_hydrateLandmarkEffectShape` migration; seeding from
  {effect, interactionPattern}; save persists both.
- `Sidepanel/modes/fragment-author.js` — action effect seed at link;
  rawJson serialize/hydrate; `_aggregateActionEffects`; KEY action.

---

## [2026-05-21] Phase 6.5 — Selective action effect observation — v2.74.250

**Spec.** `02-CAPABILITIES.md` § Phase 6.5 (paraphrased from inline
substrate spec comments): "Runtime observation will refine actual
observed effects as Actions run." Read straight, this implies every
action execution observes its effect over a 1–3 second window and
persists the observation.

**Deviation.** Observation is INVOKED, not automatic. The engine
brackets an action with observation only when one of four documented
triggers fires:
- `step.observeEffect === true` (explicit opt-in)
- `step._isTerminal === true` (set by the iterator on the last
  dispatchable step in a chain)
- `desc.proposedEffect === 'triggers-navigation'` (navigation-likely
  click, where the downstream step would race against a new
  document)
- Authoring/learning loops (caller sets the opt-in flag when it wants
  grounded feedback for AI proposals)

Observation is further restricted to action types where the signal is
meaningful: `CLICK`, `CLICK_BY_LABEL`, `FIND_AI`. `TYPE`, `EXTRACT`,
`SCROLL_TO` are skipped — they don't normally change page structure.

**Justification.**
- **Cost.** Spec-as-written added ~800ms–1.5s × every CLICK. A
  10-step chain would gain 10–15s of pure wait time. Selective
  observation keeps the default path uninstrumented.
- **Duplication.** Most steps are followed by another step whose
  assertions (URL match, element existence, text content) implicitly
  validate the prior step's effect. Observation duplicates that
  signal where it already exists.
- **Mutation noise.** Production pages mutate constantly without our
  action causing it (analytics pixels, lazy-load observers, polling
  fetches). A naïve before/after diff is dominated by noise. Filtering
  is its own project the spec didn't specify.
- **No specified feedback loop.** The spec mentions observations
  "refining future predictions" but doesn't say HOW. Auto-updating
  `proposedEffect` is silent self-modification (risky). Without a
  learner or confirmation UX, universal observation is write-only
  telemetry — cost with no benefit.
- **Where observation IS better, we DO observe.** Terminal steps and
  navigation-likely clicks were genuinely under-served by the
  "downstream pre-conditions validate" pattern; this phase fixes them
  precisely.

**Trade-off accepted.** A landmark whose heuristic `proposedEffect`
was wrong at authoring time won't self-correct on every run — only
when one of the triggers fires. Drift events are still emitted when
observation runs and detects mismatch; auto-correction is deferred
until a confirmation UX exists.

**Decision.** Joint (user explicitly requested: "implement where
observation is genuinely better than current model").

**Reversibility.** Easy. The selectivity lives in
`Services/ActionEffectObserver.js#shouldObserveStep` — flipping to
unconditional observation is a single function. The content-script
handlers and dispatch-site bracket are agnostic.

**Touched.**
- `ContentScripts/contentScript.js` — `OBSERVE_ACTION_BEGIN/END`
  handlers; `_captureObservationSnapshot`, `_diffObservationSnapshots`.
- `Services/ActionEffectObserver.js` — new; `begin`/`end`/`bracket`/
  `shouldObserveStep`/`isEffectDrift`.
- `Services/TemplateWalker.js` — dispatch site at line ~3778
  (bracket); fragment runner at line ~527 (terminal flag).
- `Services/LandmarkResolver.js` — `_resolvedFromLandmark` carries
  `proposedEffect`.
- `Services/GroundEventBus.js` — `LANDMARK_EFFECT_OBSERVED` and
  `LANDMARK_EFFECT_DRIFT` event kinds.

---

## [2026-05-21] Phase 7d — `iframeLoaded` respects observer's cross-origin policy — v2.74.248

**Spec.** `IFRAME_SCOPING_SPEC.md` § 8 commits to "load-event canonical"
for `iframeLoaded` predicate evaluation. § 5 fail-closed principle:
"don't activate when unverifiable."

**Deviation.** For same-origin iframes, the substrate uses
`contentDocument.readyState === 'complete' | 'interactive'` (spec-
aligned). For CROSS-ORIGIN iframes — where browser security prevents
reading the iframe's internal state — the content-script handler
returns `loaded: true` when the iframe element is present in the DOM.
`LocalePredicates._evaluateIframeLoaded` respects that decision rather
than overriding it with `null` (fail-closed).

**Justification.**
- The author explicitly declared an `iframeContext` predicate for
  this iframe; element presence is the strongest signal available.
- Fail-closed at this leaf would make every cross-origin iframe
  context permanently inactive — locales scoped to e.g. Stripe's
  embedded checkout could never activate.
- Fail-closed semantics ARE preserved at the locale-activation level:
  null leaves combine to null in AND, and `isLocaleActive` converts
  final null to false. We only override for one specific signal
  where browser security (not authoring error) is the obstacle.

**Trade-off accepted.** A cross-origin iframe that's structurally
mounted but not actually loaded (rare; pre-load placeholder) would
falsely trigger activation. The author can compensate with an
additional `visible` predicate on a landmark inside that iframe if
they need stricter gating — though that would itself fail cross-
origin (refused per spec § 6).

**Decision.** Implementer (documented in code; not previously
surfaced for user decision — surfacing retroactively here so it
can be challenged).

**Reversibility.** Easy. Single condition in
`Services/LocalePredicates.js#_evaluateIframeLoaded`: change
`return res.loaded === true` to add `&& res.sameOrigin === true`.

**Touched.**
- `Services/LocalePredicates.js` — `_evaluateIframeLoaded`.
- `ContentScripts/contentScript.js` — `RESOLVE_IFRAME_BY_PREDICATE`
  handler's cross-origin branch.

---

## [2026-05-21] Phase 7c — Active-locale filter falls back to unfiltered pool — v2.74.247

**Spec.** `LANDMARK_SPEC.md` § 5 (paraphrased): "use the first-active
Locale's declaration (deterministic order; document ordering)."

**Deviation.** `findLocaleIframeContext` narrows candidates to active
locales when a runtime context is supplied. If the active-filter
rules out everything but candidates exist overall, falls back to the
unfiltered pool rather than returning null.

**Justification.**
- During the transition (legacy locales authored before Phase 7c
  carried no `predicates` field; some carry only legacy
  `urlPattern`), strict "first-active wins" would silently break
  existing locales whose authors haven't migrated.
- Graceful degradation surfaces as a `Logger.warn` (callers can
  trace it) rather than a silent resolution failure.
- The fallback only kicks in when active-filter yields zero
  candidates — when ANY locale is active, the spec's first-active
  semantic holds.

**Trade-off accepted.** A locale that SHOULD have been ruled out by
its (deliberately-authored) predicates may still contribute its
iframeContext if it's the only locale on the ground. This is a
permissive failure mode rather than a strict one.

**Decision.** Implementer (documented in code; surfacing here for
retroactive challenge).

**Reversibility.** Easy. In
`Services/LandmarkResolver.js#findLocaleIframeContext`, change
`const pool = candidatePool.length > 0 ? candidatePool : locales;`
to `const pool = candidatePool;`. Migration would need to ensure
all production locales declare predicates before this flip.

**Touched.**
- `Services/LandmarkResolver.js` — `findLocaleIframeContext` pool
  selection.

---

## [2026-05-21] Phase 8 — Landmark drift events do NOT auto-update the landmark — v2.74.250

**Spec.** Substrate spec mentions observations "refining future
predictions" (see Phase 6.5 deviation above for the source quote).
Read aggressively, this implies the substrate auto-applies observed
effects back to the canonical `proposedEffect` field on the landmark.

**Deviation.** `landmark-effect-drift` is emitted as a substrate
event. The landmark's `proposedEffect` field is NOT auto-updated. A
future Studio "drift sidebar" surfaces these events with a "confirm
new effect" affordance for the author.

**Justification.**
- **Silent self-modification is a debuggability nightmare.** If an
  author hand-authored `proposedEffect: 'triggers-modal'` and the
  substrate silently flipped it to `triggers-navigation` after one
  flaky observation, the author's mental model of the landmark
  decouples from reality.
- **Single observation is not authoritative.** A modal that opens
  briefly then redirects, a flash message, a stale dialog state —
  any of these can produce a single misleading observation.
- **Author intent is sometimes correct against current page state.**
  The author may have set `proposedEffect` based on a configuration
  state that's currently off. Auto-update erases that intent.
- **Drift events are a strict superset of auto-update.** Anything
  auto-update would do, drift events enable via a downstream
  consumer with proper UX. The reverse is not true.

**Trade-off accepted.** Drift is informational, not actionable, until
a Studio surface lands. Authors who never check Studio will accumulate
silent drift without correction. (The lifecycle-flip path for resolution
failures is separate and does auto-update — that's a binary "selector
works/doesn't" signal, not a categorical hint.)

**Decision.** Implementer (documented in code comments;
surfacing here so the user can challenge or confirm).

**Reversibility.** Easy. In
`Services/TemplateWalker.js`, the drift-emit branch could be augmented
to also call `StorageManager.updateLandmark(uid, { proposedEffect:
observation.observedEffect })`. Currently NOT done by design.

**Touched.**
- `Services/TemplateWalker.js` — dispatch-site emit block.
- `Services/GroundEventBus.js` — `LANDMARK_EFFECT_DRIFT` event kind
  description.

---

## [2026-05-21] Phase 7d UI — MVP authors only flat AND-of-leaves — v2.74.260

**Spec.** `02-CAPABILITIES.md` § Locale predicates: the predicate tree
supports operators `and` | `or` | `not` plus four leaf kinds
(`urlMatches`, `visible`, `hasText`, `iframeLoaded`). Authors should
be able to compose arbitrary trees.

**Deviation.** The Phase 7d authoring UI exposes only single-level
AND-of-leaves authoring for `visible` / `hasText` / `iframeLoaded`.
`urlMatches` stays in the dedicated URL pattern field (legacy shape).
`or` / `not` operators and nested trees are NOT authorable here.

Locales that hydrate with an existing operator-tree predicate field
are preserved verbatim via `_locDraft._predicatesOriginalTree`; the
author sees a warning at load time and can't edit the tree without
losing operator structure. If they add leaves, the tree is replaced
with the new leaves array (operator structure lost — but they were
warned). Editing operator trees requires hand-editing storage until
a tree editor lands.

**Justification.**
- **Coverage of common case.** Empirically, locale predicates are
  almost always conjunctions of 1-3 conditions. OR is rare; NOT is
  rarer. The MVP covers ~95% of authoring needs at a fraction of the
  UI cost.
- **Scope.** A drag-and-drop tree editor with operator nodes, leaf
  forms, validation, and live preview is a 500-1000 line UI. The MVP
  is ~250 lines and ships in one phase.
- **Hydration preserves intent.** Locales with operator trees keep
  them when saved unchanged; the author can still review the tree
  raw in chrome.storage if needed. No silent data loss.
- **Runtime semantics already exist.** Phase 7d evaluator handles
  full trees; authoring is the only restriction. Future tree editor
  unlocks more authoring without backend changes.

**Trade-off accepted.** Authors who need OR / NOT predicates must
either: (a) edit storage directly, or (b) wait for a tree editor.
Tree editor is on the roadmap; no firm date.

**Decision.** Implementer scope decision, surfaced retroactively
for the user to challenge.

**Reversibility.** Easy. The MVP doesn't write tree-form shape on
save when leaves are present, but it doesn't actively destroy any
existing tree shape either. A future tree editor would supersede
this MVP without backward-compat concerns.

**Touched.**
- `Sidepanel/modes/locale-capture.js` — new section between
  instructions and landmarks; `_renderPredicates`,
  `_renderPredicateRow`, `_handlePredicateAction`, `_addPredicate`;
  hydration path with operator-tree preservation sentinel; save-time
  validation per kind.
- `assets/debugger.css` — `.dbg-locale-predicate*` styles.

---

## [2026-05-21] Phase 6.5 closure — Drift-apply UX shipped — v2.74.266

**Spec.** The original Phase 8 deviation [2026-05-21 v2.74.250]
documented that `landmark-effect-drift` events would emit but the
landmark's `proposedEffect` field would NOT auto-update — instead
"Studio shows these in the drift sidebar with a 'confirm new effect'
affordance."

**Closure.** That affordance now exists, but in the SIDEPANEL events
panel rather than Studio. For each `landmark-effect-drift` event row,
the trailing action column shows an "Apply" button. Click → sends
`UPDATE_LANDMARK` with `{ proposedEffect: observedEffect }` →
landmark's `proposedEffect` updated server-side → row marker swaps
to "✓ Applied" (session-scoped visual state).

**Why sidepanel, not Studio.** Per the substrate-wide pattern
established earlier (predicates, replace, verify, events, active-
state preview), all substrate authoring lives in the sidepanel
where authors actually work. Studio mirroring is a separate
deferred-pri item (#8 in "what's left"). The original entry's
mention of "Studio" was aspirational; sidepanel is the canonical
surface.

**No new deviation.** This is the consumer for an explicitly-
deferred decision. The original "no auto-update" policy is preserved
— the substrate still doesn't silently modify landmarks. The Apply
button is an EXPLICIT, AUTHOR-DRIVEN update — confirms human intent
to accept the observed value as canonical.

**Touched.**
- `background.js` — new `UPDATE_LANDMARK` handler (partial patch).
- `Sidepanel/modes/locale-capture.js` — `_eventsAppliedDrift` +
  `_eventsApplyInFlight` state sets; `_applyDriftEffect` function;
  apply column injected into event row renderer for drift events;
  unmount cleanup extended.
- `assets/debugger.css` — `.dbg-locale-events-action*` and
  `.dbg-locale-events-apply-btn` styles; event row grid template
  gains a trailing column.

---

## [2026-05-21] Phase 7d partial closure — Top-level operator authoring — v2.74.271

**Supersedes (partially):** [2026-05-21] Phase 7d UI — MVP authors only
flat AND-of-leaves — v2.74.260.

**Spec.** `02-CAPABILITIES.md` § Locale predicates: full operator tree
with `and` / `or` / `not` plus four leaf kinds; arbitrary nesting.

**Closure achieved.** Top-level operator authoring is now supported:
- AND of N leaves (default, legacy shape, flat array)
- OR of N leaves (tree object with operator: 'or')
- NOT of single leaf (tree object with operator: 'not')

Authors switch operator via a dropdown at the top of the predicates
section. NOT is constrained to a single child (confirmed switch
discards extras with author confirmation).

**Still deviation.** Nested operator trees (e.g., `AND(OR(...), ...)`)
still require storage edit. Hydrating from a nested tree preserves it
via `_locDraft._predicatesOriginalTree` sentinel — author warned at
load time; editor stays empty.

**Justification.**
- ~95% of operator-tree authoring needs covered by top-level operator
  (per empirical reasoning — most authors compose at most one level).
- Nested tree builder is a significantly larger UI (drag-and-drop
  rearrangement, recursive validation). Not worth the cost when
  top-level covers the common case.
- Cleanly composes with the active-state preview I built — preview
  wraps the predicate set in the operator on the fly for evaluation,
  so the preview accurately reflects authored semantics.

**Trade-off accepted.** Authors with genuine need for `AND(OR(visible,
hasText), urlMatches)` shapes still hand-edit storage. Lower
priority — empirically very rare.

**Decision.** Implementer scope, closing approximately 80% of the
prior deviation incrementally.

**Reversibility.** Easy. Reverting the operator-selector UI to MVP-
only-AND is a small revert. Saved data stays compatible: AND saves
as flat array (same as before); OR/NOT save as tree, which the
evaluator already handles natively. No data migration needed
either direction.

**Touched.**
- `Sidepanel/modes/locale-capture.js` — `_predicatesOperator` state
  variable; operator dropdown + `_onPredicatesOperatorChange` handler
  + `_updatePredicatesHint`; hydration extended to detect
  `{operator, children}` shape and load directly when all-leaves;
  save serialization branches by operator (flat for AND, tree for
  OR/NOT); `_evaluateActiveState` wraps predicates per operator
  before calling `isLocaleActive`; `_diagnoseLeaves` reads leaves
  from either array or tree shape.
- `assets/debugger.css` — `.dbg-locale-predicates-op-label` +
  `.dbg-locale-predicates-operator` styles.

---

## [2026-05-21] Landmark "role" field cleanup — rename to alias, soften Pick gate — v2.74.274

**Spec.** The substrate spec defines `role` as the **computed a11y role**
(`button`, `textbox`, `link`, etc.) derived from ARIA + HTML AAM at
Pick time. Identity = canonicalUrl + role + accessibleName + context
→ UID.

**Pre-cleanup state (deviation).** A UI text field labeled "role" on
every landmark row held an **author-typed kebab-case nickname** —
`search-input`, `submit-button`, etc. Not the spec's role at all. The
storage shape (`lm.role`) was a literal field unrelated to
`lm.a11yRole` (which IS the spec's role). The field was REQUIRED
before Pick — author couldn't pick an element without typing this
nickname first.

This is a long-standing UI deviation: the field pre-dates the
substrate's three-layer identity model (Phase 1, v2.74.239) and
never got reconciled with it.

**Cleanup applied.**

1. **UI label rename**: `role` → `alias`. New placeholder reads
   "alias (e.g. search-input — auto-fills after Pick)". Title-attr
   tooltip clarifies it's an author-chosen short identifier, NOT
   the a11y role (which is computed and displayed in the profile
   drawer's Identity section).

2. **Pre-Pick gate removed**. Author can click Pick on a row with
   an empty alias. The post-Pick path auto-fills alias from
   `accessibleName` via `_slugifyForAlias` (lowercase, kebab-case,
   48 chars). Common case needs zero typing.

3. **Save-time validation preserved**. Alias is still required at
   save (uniqueness within locale + legacy { localeId, role } ref
   shape compatibility). Save error wording updated to say "alias"
   and explain the auto-fill behavior.

4. **Storage shape unchanged.** `lm.role` field name preserved
   verbatim — no migration, no breakage of legacy
   `{ localeId, role }` refs, no impact on the substrate's actual
   role concept (`lm.a11yRole`).

**Why the field still exists.** Five genuine roles it plays that the
spec model doesn't cover:
- Pre-Pick row identity (no accessibleName exists yet)
- Stable short nickname for code/automation references
  (accessibleName drifts; v2.74.270 fuzzy match exists because of
  this)
- Disambiguating identical accessibleNames in different contexts
  within a locale
- AI semantic anchor for Claude (stronger than passing the full
  computed name)
- Legacy ref shape compatibility

**Justification for the cleanup approach.**
- The conceptual collision between author-typed "role" and spec's
  a11y role was actively confusing — two things named the same,
  visible at the same time, with different meanings.
- The required-before-Pick gate forced an authoring sequence that
  doesn't match the natural flow ("pick first, label later").
- Auto-fill makes the common case zero-friction while preserving
  authorial override.
- Renaming the UI label resolves the naming collision without
  touching storage (so no migration, no data loss, no breakage of
  any downstream consumer).

**Reversibility.** Easy. Storage shape never changed. Reverting:
restore the old placeholder text + reinstate the pre-Pick gate. The
auto-fill path can stay (it's harmless on the gated flow because
the author would have already typed something).

**Touched.**
- `Sidepanel/modes/locale-capture.js` — landmark row markup
  (placeholder + title attr); `startLocalePick` gate removed;
  `_slugifyForAlias` helper; Pick→Claude integration sets `lm.role`
  from accessibleName when blank; save validation messages updated.
- `manifest.json` — 2.74.274.

---

## [2026-05-21] Aggressive legacy cleanup — all previously-authored primitives wiped — v2.74.275

**Supersedes:** This is a global cleanup; supersedes the alias-only
deviation v2.74.274 (which preserved `lm.role` for backward compat)
and the predicate-tree sentinel from v2.74.260 / v2.74.271.

**Context.** User instruction: "Remove all legacy support — all
previously authored primitives will be deleted." Existing fragments,
observations, locales, strategies wiped from storage. Code can drop
backward-compatibility paths.

**Four cleanups executed in one turn:**

### 1. Legacy `{ localeId, role }` ref shape REMOVED

All landmarkRef refs must now carry `{ uid }` pointing into the
per-Ground registry.

- `Services/LandmarkResolver.js` — `resolveLandmarkRef` throws on
  any ref lacking `uid`; legacy localeId/role fallback (~60 lines)
  deleted. `applyLandmarkRefToStep` no longer stashes `localeId`.
- `Services/LandmarkReplacer.js` — `_rewriteActions` /
  `_rewriteExtracts` no longer track `skippedLegacyRefs`. The
  legacy-embedded skip-detection in the locale branch removed.
  Result-shape fields `skippedLegacyRefs` and `rolePresentMismatch`
  removed/renamed (latter → `aliasPresentMismatch`).
- `Services/LandmarkImpactAnalysis.js` — `_countRefsInFragmentActions`
  and `_countRefsInObservationExtracts` simplified to uid-only.
  `targetRole`/`localeIdsForUid` parameters dropped.
- `Sidepanel/modes/fragment-author.js` — `_applyActionLandmarkRef`
  now writes `{ uid }` directly.

### 2. Embedded `locale.landmarks[]` saved shape REMOVED

Locales store `landmarkRefs[]` (uid array) exclusively. Registry
is the sole source of landmark records.

- `Services/LandmarkResolver.js#listLandmarksForGround` — legacy
  embedded scan loop (~30 lines) deleted.
- `Services/LandmarkImpactAnalysis.js` — locale match by registry
  refs only; no `viaEmbedded` flag in result.
- `Sidepanel/modes/locale-capture.js` — hydration removed the
  embedded `prefilled.landmarks[]` branch. **Exception preserved:**
  fresh Claude suggestions (no UIDs) still hydrate via
  `prefilled.landmarks[]` as draft entries. Distinction: legacy
  PERSISTED state vs fresh PROPOSED state. The legacy persisted
  case no longer exists; the fresh-proposed case is the "+ Auto"
  workflow.
- `Sidepanel/modes/ground-view.js` — `+ Edit Locale` payload swaps
  to `landmarkRefs[] + predicates[]` shape.
- `Sidepanel/modes/fragment-author.js` — locale-load now fetches
  landmarks via `GET_LANDMARKS` and stashes onto `locale.landmarks`
  for synchronous dropdown rendering. Hydration is the only place
  `locale.landmarks` is now populated (as a cache, not storage).

### 3. Predicate tree sentinel `_predicatesOriginalTree` REMOVED

Nested operator trees (e.g., `AND(OR(...), ...)`) can no longer
exist in stored data; sentinel-preservation path deleted.

- Top-level operator authoring (AND / OR / NOT) still works
  (v2.74.271 retained).
- Save serialization: AND saves as flat array; OR/NOT save as
  `{ operator, children }` tree.

### 4. Legacy `urlPattern` string field REMOVED

URL gating now flows through the predicates tree as a `urlMatches`
leaf (kind already supported by the runtime evaluator since Phase 7d).

- `Services/LocalePredicates.js#isLocaleActive` — `urlPattern`
  fallback removed; predicates field is the sole gating mechanism.
- `Sidepanel/modes/locale-capture.js` — URL pattern input field
  removed from the form. `_locDraft.urlPattern` field gone.
  `onPatternInput` handler deleted. `updateLocaleSaveButtonState`
  now requires at least one `urlMatches` predicate. Save
  validation requires a urlMatches predicate (else "would match
  every page on this Ground" warning).
- New locales auto-seed a urlMatches predicate from the current
  tab URL on first tab load (in `refreshLocaleActiveTab`).
- The predicate-authoring UI gained `urlMatches` as a 4th leaf
  kind option (alongside visible / hasText / iframeLoaded). Body
  shows pattern input + mode selector (contains / regex / exact).

### Plus: storage rename `lm.role` → `lm.alias`

The v2.74.274 cleanup renamed UI labels but kept the storage field
named `role` for backward compat. With legacy data wiped, the
storage rename is now safe.

- `Sidepanel/modes/locale-capture.js` — all references migrated
  (file-wide replace_all on `lm.role`).
- `ContentScripts/contentScript.js` — `showLocaleOverlays` payload
  reads `lm.alias`; label text uses alias.
- `Services/LandmarkReplacer.js` — result field `roleOld/roleNew`
  renamed `aliasOld/aliasNew`.
- `Services/LandmarkReplacementCandidates.js` — `lm.role` fallback
  removed; `a11yRole` is now sole role-hard-filter source.
- `Services/LocaleDescription.js` — `_humanizeRole` reads `lm.alias`.
- `Services/AnthropicService.js#suggestLocale` — Claude prompt
  template returns `{ alias, selector }` shape; parser updated.
- `Sidepanel/modes/fragment-author.js`, `ground-view.js`,
  `observation-author.js` — alias-aware display + ref handling.
- Storage field name in `SAVE_LANDMARK` record is `alias`.

**Justification.** User instruction was unambiguous: existing data
is being wiped, code can clean up. All four cleanups were either
already-deprecated transitional paths (legacy ref shape, embedded
landmarks), or explicit deviation closures (predicate sentinel,
urlPattern field). The alias rename completes the conceptual
separation between author-typed nickname (`alias`) and computed a11y
role (`a11yRole`) that v2.74.274 began.

**Trade-offs accepted.**
- Authors who had locales with nested-tree predicates (rare;
  hand-edit only) lose them on next load.
- Cross-locale `{ localeId, role }` refs that survived from pre-
  Phase-2 fragments no longer resolve (data wipe makes this moot).
- Auto-discover ("+ Auto") flow still works because fresh-
  suggestion hydration is distinct from persisted-state hydration.

**Reversibility.** Hard to revert — code paths are deleted, not
behind feature flags. But the substrate is cleaner: every shape
is now spec-aligned with no transitional cruft.

**Decision.** User-directed aggressive cleanup. Multi-file refactor
shipped in one turn.

**Touched.**
- `Services/LandmarkResolver.js` — legacy ref shape + embedded scan
  removed.
- `Services/LandmarkReplacer.js` — legacy ref tracking gone;
  rolePresentMismatch → aliasPresentMismatch.
- `Services/LandmarkImpactAnalysis.js` — uid-only ref counting.
- `Services/LandmarkReplacementCandidates.js` — `lm.role` fallback
  removed.
- `Services/LocalePredicates.js#isLocaleActive` — urlPattern path
  removed.
- `Services/LocaleDescription.js` — alias-aware.
- `Services/AnthropicService.js#suggestLocale` — alias schema in
  Claude prompt + response parser.
- `Services/StorageManager.js` — log message uses alias.
- `ContentScripts/contentScript.js` — `showLocaleOverlays` uses
  `lm.alias`.
- `Services/TemplateWalker.js` — display fallback strings use
  `desc.alias`.
- `Sidepanel/modes/locale-capture.js` — section markup, hydration,
  save, validation, draft shape, render, all UI labels.
- `Sidepanel/modes/ground-view.js` — `+ Edit Locale` payload.
- `Sidepanel/modes/fragment-author.js` — locale load hydrates
  landmarks via registry; `_flatLandmarksForGround` uses alias;
  landmarkRef writes `{ uid }`.
- `Sidepanel/modes/observation-author.js` — display alias.

---

<!--
ADDING A NEW ENTRY: Copy the template at the top of the file, fill in
each section with concrete detail (no hand-waving), and append BELOW
this comment. Do not edit existing entries — supersede with a new entry
if a decision changes.
-->

---

## v2.74.325 — Ground foundational shape alignment (GROUND_SPEC § 6), partial

**Date:** 2026-05-22
**Decision by:** user ("Approve as planned" — foundational storage-shape slice).

**What.** Upgraded the Ground record to the GROUND_SPEC § 6 shape
(`name`, `urlPatterns[]`, `localeIds[]`, `metadata{createdAt,updatedAt,
lifecycle}`) via additive normalization on read+write, with no destructive
migration. `Services/StorageManager.js#normalizeGroundRecord` is the single
chokepoint (applied in saveGround/updateGround/getGround/getAllGrounds).

**Deliberate deviations / partials (the reason this is logged):**

1. **Existing ids are NOT re-keyed to `gnd_<uid>`.** Only NEW grounds get
   the prefix (GroundManager.create, Studio ground form). Re-keying a live
   ground id would require rewriting `groundId` on every Locale, Fragment,
   Landmark, Strategy and every `*:index:<groundId>` key — a high-risk
   flag-day migration with no functional benefit (ids are opaque keys).
   The user approved new-id-only.

2. **`url` and `aiName` retained as deprecated read-mirrors.** GROUND_SPEC
   replaces single `url` with `urlPatterns[]` and `aiName` with `name`.
   ~18 sites read `ground.url` and several read `ground.aiName`. Rather than
   a flag-day rewrite of all of them, normalize keeps `url` = primary
   pattern and `aiName` = name so legacy readers keep working. Converting
   those readers (and removing the mirrors) is deferred to a follow-up.

3. **`urlPatterns[]` is single-entry, driven by the one editable `url`.**
   The only URL editor today is the Studio ground form (writes `url`), so
   `url` is authoritative and normalize rebuilds a single-pattern array
   from it. Multi-pattern authoring + glob/regex/template matching +
   specificity conflict resolution is the separate "URL pattern matcher"
   slice (GROUND_SPEC § 3 / priority 2), not yet done.

4. **`localeIds[]` and effective `lifecycle` are read-time projections,
   not separately persisted.** `localeIds` is read from the existing
   `locales:index:<groundId>` (already the composition source of truth +
   order), avoiding a second copy that could drift. `lifecycle` is derived
   as `deprecated` (persisted, future slice) else `active` if locales exist
   else `draft`. The draft→active→deprecated state machine + soft-delete
   (GROUND_SPEC § 9) is the separate "lifecycle" slice, not yet done.

5. **`aliases` kept as a tolerated non-spec extension.** Not in the
   GROUND_SPEC Ground shape (AI-product-era field), but currently shown as
   ground alias-tags and populated by DiscoveryService — kept to avoid
   removing a working feature. User approved keeping it.

**Still missing vs GROUND_SPEC (separate future slices, acknowledged):**
URL pattern matcher (§3), derived description pipeline (§5),
Ground-owned events (§7), active-Ground-per-thread tracker (§8),
lifecycle state machine + cascade ref-integrity (§9, §11), sharing (§12).

**Touched.**
- `Services/StorageManager.js` — `#normalizeGroundRecord`; saveGround,
  updateGround, getGround, getAllGrounds; Ground/UrlPattern typedefs.
- `Core/GroundManager.js` — `create()` emits new shape + `gnd_` id.
- `studio.js` — `saveGroundFromForm` new-ground id gets `gnd_` prefix.

---

## v2.74.326 — Ground URL pattern matcher (GROUND_SPEC § 3)

**Date:** 2026-05-22
**Decision by:** user ("Spec-strict glob" — chosen over backward-compatible
and strict+auto-migrate, after reviewing the justifications for each).

**What.** New `Core/GroundMatcher.js` (pure, storage-free) implements the
GROUND_SPEC § 3 URL-pattern matcher: `canonicalizeUrl` (lowercase
scheme/host, drop default ports + fragment, strip session params, sort
query), `compilePattern` for glob / regex / template kinds, and
`matchGroundForUrl` with most-specific-wins (more literal chars → fewer
wildcards → alphabetical-by-id) conflict resolution. Wired into
`Sidepanel/modes/ground-view.js#_findMatchingGround`, replacing the old
host/subdomain heuristic. Validated with a 15-case harness.

**Spec-strict semantics (the user-facing behavior change):**
- A bare-origin pattern (`https://site.com`) matches ONLY the exact
  canonical URL (its root). Subpaths require `https://site.com/*`;
  subdomains require `https://*.site.com/*`.
- This is a deliberate behavior change from the prior `_normalizeHost`
  matcher, which treated any bare URL as "whole site incl. subdomains."
  **Existing bare-URL Grounds will stop matching their subpages until
  re-authored** with a `/*` suffix (edit the Ground, set its URL to e.g.
  `https://pixabay.com/*`). The user accepted this in exchange for spec
  compliance.

**Not a deviation** — this implements GROUND_SPEC § 3 as written. Logged
here for the migration note (existing Grounds need pattern re-authoring)
and the cross-reference from the v2.74.325 entry's deferred list.

**Still deferred (separate slices):** active-Ground-per-thread tracker
(§8), derived description (§5), events (§7), lifecycle state machine +
cascade ref-integrity (§9, §11), sharing (§12).

**Touched.**
- `Core/GroundMatcher.js` — new module (canonicalize / compile / match).
- `Sidepanel/modes/ground-view.js` — import + `_findMatchingGround` now
  uses `matchGroundForUrl` (kept `_normalizeHost` for the non-http guard).

---

## v2.74.327 — Ground deletion cascade completeness (GROUND_SPEC § 11)

**Date:** 2026-05-22
**Decision by:** user ("Reference-integrity fix" — contained correctness
fix; full draft/active/deprecated soft-delete state machine deferred).

**What (bug fix, not a deviation).** `StorageManager.deleteGround` cascaded
only Fragments + Strategies, leaving the Ground's **Locales, Observations,
Analyses, and Assertions orphaned** in storage (their
`<kind>:index:<groundId>` keys + records survived a deleted Ground,
polluting `getAll*` and risking dangling references). Now the cascade
removes all four additional Tier-1 artifact types. Studio's delete-confirm
message updated to list the full cascade.

**Spec-aligned decision (logged for the trail).** Landmarks are
**preserved**, not deleted — GROUND_SPEC § 11 commits "v1: orphaned
landmarks remain in storage for user-initiated cleanup; no auto-cleanup."
The per-Ground landmark registry (`landmarks:index:<groundId>` +
`landmarks:<uid>`) is intentionally left in place. (Caveat noted to the
user: with hard-delete + new `gnd_` ids on recreate, there's currently no
reattach path, so this is dead-but-recoverable substrate; revisit if a
Ground-recreate/reattach flow is built — or hard-delete landmarks too on
request.)

**Still deferred:** draft/active/deprecated lifecycle + soft-delete +
deprecation cascade + deletion-impact surfacing (GROUND_SPEC § 9 / § 11),
active-Ground-per-thread tracker (§8), derived description (§5), events
(§7), sharing (§12).

**Touched.**
- `Services/StorageManager.js` — `deleteGround` full Tier-1 cascade.
- `studio.js` — delete-confirm message lists the full cascade.

---

## v2.74.328 — Ground `url` mirror is navigable, not the raw pattern (bug fix)

**Date:** 2026-05-22
**Context:** bug pass after v2.74.325/326.

**The bug.** v2.74.325 stored the `url` mirror as the *primary pattern*.
That was harmless while patterns were bare origins, but the spec-strict
URL-matcher (v2.74.326) means users must author `https://site.com/*` to
match subpages — at which point `ground.url` became `https://site.com/*`.
Several consumers **navigate to `ground.url`** (`__findOrOpenTabForLocale`,
`ExecutionEngine.#openTab`, `DiscoveryService` seed, the bg `1265`
fallback) and `CapabilityAPI` does `new URL(ground.url)` — a `/*` (or
host-wildcard) "URL" would open a literal `/*` path or throw. Latent until
a Ground was re-authored with a wildcard.

**The fix.** `#normalizeGroundRecord` now treats `urlPatterns[]` as
authoritative when present (form/create writers still send only `url`, from
which the pattern is built), and stores `url` as the **navigable** form of
the primary pattern (`#navigableUrlFromPattern` strips everything from the
first `*`/`?`/`{` onward; `https://x/*` → `https://x/`; host-wildcard →
`''`). All `tabs.create({url: ground.url})` consumers now get a real URL
for free. The Studio edit form prefills its URL field from
`urlPatterns[0].pattern` (the real pattern) so editing doesn't silently
drop a `/*` on re-save. Validated with a 6-case derivation harness.

**Note for future devs:** to change a Ground's URL/pattern, write a fresh
record via `saveGround` (as the Studio form does) — `updateGround({url})`
patches are ignored because `urlPatterns` is authoritative when present.
(Currently moot: `updateGround` has no callers.)

**Touched.**
- `Services/StorageManager.js` — `#navigableUrlFromPattern`; normalize URL
  handling + `url` mirror; Ground typedef.
- `studio.js` — ground form prefills URL from `urlPatterns[0].pattern`.

---

## v2.74.329 — Ground derived description pipeline (GROUND_SPEC § 5)

**Date:** 2026-05-22
**Decision by:** user ("Lazy / manual" trigger — derive only on explicit
request; mark stale on Locale change but don't auto-spend tokens).

**What.** Implemented GROUND_SPEC § 5 derived intent: a Ground's description
is synthesized from its constituent Locales' descriptions, cached, and
overridable.
- **Storage** (`#normalizeGroundRecord` defaults): `derivedDescription`,
  `derivedAt`, `derivationVersion`, `derivationInputsHash`,
  `descriptionOverride` (null = use derived).
- **Derivation:** `AnthropicService.deriveGroundDescription({name,
  urlPrimary, locales})` → plain-text summary; prompt registered in
  `getPromptTexts()` + Studio `PROMPT_REGISTRY` (id `deriveGroundDescription`).
- **Cache:** `Core/groundDerivation.js` (shared by background + Studio) —
  `derivationInputsHash(locales)` (order-independent; includes
  `DERIVATION_VERSION`), `isDerivationStale`, `effectiveDescription`.
- **Background:** `DERIVE_GROUND_DESCRIPTION` (cache-validated; `force`
  bypasses) + `SET_GROUND_DESCRIPTION_OVERRIDE`.
- **Studio surface:** Ground card shows effective description
  (override ?? derived ?? placeholder) + derived/overridden/stale badges +
  ↻ refresh + ✎ override (prompt-based edit/clear).

**Trigger model (the logged decision).** Derivation is **lazy/manual** —
runs only on the ↻ button. A Locale change makes the cached description
read **stale** (badge) but does NOT auto-call the LLM. The ↻ button is
cache-aware (`force=false`): re-derives when stale/never-derived, otherwise
reports "already up to date" without spending tokens.

**Deferred (Phase 2+ per spec):** periodic background refresh; the
constituent-Locale "which Locale contributed which themes" contributions
inspector; surfacing the description in the read-only sidepanel ground-view
(Studio is the canonical Ground editor per § 10).

**Touched.**
- `Core/groundDerivation.js` — new (hash / stale / effective-description).
- `Services/StorageManager.js` — 5 derived-intent fields in normalize.
- `Services/AnthropicService.js` — `deriveGroundDescription` + prompt snapshot.
- `background.js` — `DERIVE_GROUND_DESCRIPTION` + `SET_GROUND_DESCRIPTION_OVERRIDE`.
- `studio.js` — Ground-card description row + handlers + `PROMPT_REGISTRY` entry.
- `assets/sidepanel.css` — `.ground-group-desc` + badge styles.

---

## v2.74.330 — Ground lifecycle: deprecate / reactivate (GROUND_SPEC § 9), partial

**Date:** 2026-05-22
**Decision by:** user ("Add Deprecate alongside ✕" — keep ✕ as permanent
hard-delete; add a separate soft Deprecate + Reactivate).

**What.** Completed the Ground lifecycle state surface. `draft`/`active`
were already derived from Locale presence (v2.74.325); this adds the
persisted `deprecated` state + transitions + matching effect + Studio UI.
- **Transitions:** `SET_GROUND_LIFECYCLE` (background) — `deprecated`
  persists `metadata.lifecycle`; `active` clears it (null) so getGround
  re-derives active/draft.
- **Matching (GROUND_SPEC § 9):** `matchGroundForUrl` now skips `draft`
  Grounds ("not active for URL matching"). `deprecated` Grounds still match;
  Studio flags them visually (we have no event bus for the spec's "match but
  emit warning", so the visual flag is the surface).
- **Studio:** dimmed card + `deprecated`/`draft` badge; a **⤓ Deprecate**
  action (soft, confirm) and **↑ Reactivate** for deprecated Grounds. **✕
  stays permanent hard-delete** (the v2.74.327 full cascade), per the user's
  choice — both paths coexist.

**Deliberate partials / deviations:**
1. **No cascade-deprecation to Locales/Workflows.** GROUND_SPEC § 9/§ 11
   says deprecating a Ground cascade-deprecates its Locales and anchored
   Workflows. Those entities **have no lifecycle field** — adding one is a
   separate, larger effort. For now deprecation is Ground-level only:
   the Ground is hidden from active matching; its constituent artifacts are
   untouched (still reachable if reactivated). Deferred.
2. **✕ remains hard-delete** rather than the spec's "delete = soft-first"
   (§ 11). User chose least-surprise: ✕ permanent + separate Deprecate.
3. **No Intent "review needed" flagging, no export gating** (§ 9) — Intents
   / export aren't built. Deferred.

**Touched.**
- `Core/GroundMatcher.js` — skip `draft` Grounds in `matchGroundForUrl`.
- `background.js` — `SET_GROUND_LIFECYCLE` handler.
- `studio.js` — deprecated card class, lifecycle badge, deprecate/reactivate
  buttons + handlers.
- `assets/sidepanel.css` — deprecated-card dim + lifecycle badge styles.

---

## v2.74.331 — Complete Locale predicate vocabulary (LOCALE_SPEC § 4)

**Date:** 2026-05-22
**Decision by:** user (Locale audit → "Complete predicate vocabulary").

**What (spec completion, not a deviation).** LOCALE_SPEC § 4 defines six
leaf predicate kinds. Four were implemented (`urlMatches`, `visible`,
`hasText`, `iframeLoaded`); the two missing kinds previously hit the
unknown-kind path in `LocalePredicates._evaluateLeafPredicate` → returned
`null` → fail-closed (a Locale using them could never activate). Now both
are implemented end-to-end:
- **`attributeEquals { target, attribute, value }`** — landmark's attribute
  === value (string compare; absent attribute never matches).
- **`landmarkExists { target }`** — landmark's selector resolves to a DOM
  element (present; visibility not required, unlike `visible`).

Wired through all three layers: evaluator (`LocalePredicates.js`),
content-script DOM checks (`EVALUATE_PREDICATE_ATTRIBUTE_EQUALS` /
`EVALUATE_PREDICATE_EXISTS`), and the locale-capture predicate-authoring UI
(kind choices + per-kind editors + `predicate-attribute` field handler).
All six § 4 kinds are now authorable + evaluable.

**Touched.**
- `ContentScripts/contentScript.js` — 2 predicate DOM-check handlers.
- `Services/LocalePredicates.js` — 2 leaf evaluators + switch cases + docstring.
- `Sidepanel/modes/locale-capture.js` — 2 kind choices + 2 editors + handler.

---

## v2.74.332 — Locale Layer 2 composition shape foundation (LOCALE_SPEC § 3, Phase A)

**Date:** 2026-05-22
**Decision by:** user. The LOCALE_SPEC was **updated 2026-05-22**: § 3 now
mandates "Layer 2" structured composition (`landmarks: LandmarkNode[]` with
typed relationships `contains`/`alternatives`/`references`/`triggers`/
`derivedFrom`, per-node `role`/`multiplicity`, + `groupings`/`sequences`
overlays) and **explicitly rejects** the flat `landmarkRefs: string[]` shape
the implementation used. User chose "Phase A — shape foundation".

**What.** Introduced the Layer 2 shape via a mirror strategy (parallel to the
Ground url/urlPatterns approach):
- `Core/localeComposition.js` (new) — `flattenLandmarkNodes` (node tree →
  ordered unique UIDs, recursing contains+alternatives), `deriveLandmarkNodes`
  (legacy `landmarkRefs[uid]` / legacy embedded records → `[{ref}]` nodes;
  preserves authored structure when nodes already present), `localeLandmarkUids`.
- `StorageManager.#withLocaleComposition` — canonical `landmarks: LandmarkNode[]`
  + derived `landmarkRefs` flat mirror (= full flatten). Applied in
  `#migrateLocaleShape` (read), `saveLocale` + `updateLocale` (write).
- `TemplateWalker` `getLocale` resolver — now ALWAYS hydrates `loc.landmarks`
  from the `landmarkRefs` mirror (the old "only if landmarks empty" gate would
  skip now that migrate fills `landmarks` with nodes, regressing the v2.74.320
  locale_ref fix and feeding Assertion.js structureless nodes).

**Deliberate partials / deviations:**
1. **Mirror, not flag-day.** `landmarkRefs` is RETAINED as a derived flat
   mirror so the many consumers reading it (`_loadGroundCatalog`,
   locale-capture hydration, EVALUATE_GROUND_PREDICATES landmarkCount,
   Assertion.js via resolver) keep working without per-call flattening. The
   mirror is the complete flatten of the node tree, so it stays correct even
   once nodes gain nesting (Phase B).
2. **Flat nodes only.** Phase A nodes are `{ref}` — no relationships, roles,
   multiplicity, groupings, or sequences yet. Those are **Phase B**
   (relationship authoring UI) + **Phase C** (LLM structured proposal +
   per-node authoringMetadata). The shape is now in place for them to land.
3. **Storage location** (§ 5 file-tree `workspace/grounds/.../locale.json`)
   NOT adopted — `chrome.storage.local` keying is a pre-existing impl choice.

**Touched.**
- `Core/localeComposition.js` — new (flatten / derive / uids helpers).
- `Services/StorageManager.js` — import + `#withLocaleComposition`;
  `#migrateLocaleShape`, `saveLocale`, `updateLocale` apply it.
- `Services/TemplateWalker.js` — `getLocale` resolver always hydrates from refs.

---

## v2.74.333 — Fix: draft-skip in the matcher deadlocked new-Ground creation

**Date:** 2026-05-22
**Context:** regression fix; supersedes the draft-skip from v2.74.330.

**The bug.** v2.74.330 made `matchGroundForUrl` skip `draft` Grounds (per
GROUND_SPEC § 9 "draft not active for URL matching"). But the matcher's only
consumer is the **authoring entry point** (`ground-view._findMatchingGround`),
and a brand-new Ground has no Locales → derives as `draft`. So after creating
a Ground, the sidepanel couldn't match it → re-rendered the "new Ground card"
→ the user was stuck, unable to enter the Ground to author its first Locale
(and re-discovering just made another draft, skipped again). Chicken-and-egg
deadlock.

**The fix.** The § 9 "draft not active" rule is a RUNTIME concern (operations
resolving landmarks), owned by the deferred § 8 active-Ground tracker — NOT
the authoring matcher. `matchGroundForUrl` now INCLUDES draft by default;
draft-exclusion is opt-in via `matchGroundForUrl(url, grounds, { activeOnly:
true })`, which the future runtime tracker will pass. `ground-view` uses the
default (includes draft) so new Grounds are reachable immediately.

(Note: spec-strict glob still applies — a bare-origin Ground `https://site.com`
matches only the root; author `https://site.com/*` to match subpages. That's
the v2.74.326 decision, unrelated to this deadlock.)

**Touched.**
- `Core/GroundMatcher.js` — `matchGroundForUrl` gains `{ activeOnly }`;
  draft included by default.

---

## v2.74.334 — New-Ground URL authoring defaults to a whole-site glob

**Date:** 2026-05-22
**Context:** spec-strict matching (v2.74.326) makes a bare-URL Ground match
only the exact root. To stop that footgun biting on every new Ground:
- **Studio ground form** (`studio.html`): URL field relabeled "URL pattern",
  `type="url"` → `type="text"` (so the `*` glob doesn't trip native URL
  validation; the handler validates via `new URL`, which accepts globs),
  placeholder `https://example.com/*`, + a glob hint (`/*` = all pages;
  `*.site.com/*` = subdomains).
- **Sidepanel new-Ground card** (`ground-view.js`): URL field now defaults to
  `<root>/*` (whole-site) instead of the bare root, relabeled "URL pattern",
  + the same glob hint.

The stored `url` mirror is still the navigable (wildcard-stripped) form, so
discovery's seed-URL navigation and other tab-open consumers are unaffected;
only `urlPatterns` (used for matching) carries the glob.

**Touched.**
- `studio.html` — URL field type/label/placeholder + glob hint.
- `Sidepanel/modes/ground-view.js` — `_renderNewGroundCard` seeds `<root>/*`
  + glob hint.

---

## v2.74.335 — Locale lifecycle: deprecate / reactivate (LOCALE_SPEC § 12)

**Date:** 2026-05-22
**Decision by:** user (Locale audit → "Locale lifecycle § 12").

**What.** Soft-delete for Locales, mirroring the Ground § 9 work.
- **Storage:** `#withLocaleComposition` defaults `lifecycle: 'active'`;
  `'deprecated'` persists. (Top-level field, matching the Locale's flat shape
  — NOT nested in a `metadata{}` block; see deviation 2.)
- **Transitions:** `SET_LOCALE_LIFECYCLE` (background) deprecate/reactivate.
- **Active-set exclusion:** `isLocaleActive` returns false for deprecated;
  `EVALUATE_GROUND_PREDICATES` skips deprecated; fragment-author
  `_flatLandmarksForGround` won't offer a deprecated Locale's landmarks.
- **Studio UI:** locale row gets a `deprecated` badge + dim + ⤓ Deprecate /
  ↑ Reactivate (next to delete).
- **Ground cascade (unblocks the v2.74.330 deferral):** `SET_GROUND_LIFECYCLE`
  deprecating a Ground now cascade-deprecates its Locales (GROUND_SPEC § 11).

**Deliberate partials / deviations:**
1. **Active-set EXCLUSION vs spec's "evaluate-but-filter".** LOCALE_SPEC § 12
   says deprecated Locales "evaluate normally but downstream consumers filter
   them out." We simply exclude them from the active set — same observable
   result (no contribution to authoring), simpler, no impact-analysis consumer
   exists that needs the evaluate-anyway behavior.
2. **`lifecycle` is a top-level field, not `metadata.lifecycle`** (§ 5). The
   Locale record uses a flat shape (top-level createdAt/updatedAt/authoredBy);
   a top-level `lifecycle` matches it. Adding a `metadata{}` block is a larger
   shape change, deferred.
3. **Reactivation does NOT cascade up.** Reactivating a Ground does not auto-
   reactivate its Locales (spec § 11: opt-in, user reviews each) — they stay
   deprecated until reactivated individually in Studio.
4. **No 'draft' Locale state.** Locales are saved=active; the draft state isn't
   modeled (only active/deprecated). Sidepanel ground-view deprecate UI not
   added (Studio is the management surface); follow-up.

**Touched.**
- `Services/StorageManager.js` — `#withLocaleComposition` lifecycle default.
- `Services/LocalePredicates.js` — `isLocaleActive` excludes deprecated.
- `background.js` — `SET_LOCALE_LIFECYCLE`; `EVALUATE_GROUND_PREDICATES` skip;
  `SET_GROUND_LIFECYCLE` Locale cascade.
- `Sidepanel/modes/fragment-author.js` — `_flatLandmarksForGround` skip.
- `studio.js` — locale-row badge + deprecate/reactivate buttons + handlers.
- `assets/sidepanel.css` — `.locale-row-deprecated` dim.

---

## v2.74.336 — Locale Layer 2 Phase C-lite: LLM structured proposal (LOCALE_SPEC § 3/§ 13)

**Date:** 2026-05-22
**Decision by:** user (Locale audit follow-up → "Phase C-lite: LLM structured
proposal").

**What.** Realizes the Layer 2 shape (Phase A, v2.74.332): the LLM proposes a
structured composition over a Locale's already-picked landmarks; the author
reviews + keeps it.
- **`AnthropicService.proposeLocaleStructure({name, description, landmarks})`**
  → `{ nodes: LandmarkNode[], groupings, sequences }`. A **safety sanitizer**
  clamps refs to the picked-UID set, dedupes (first wins), salvages valid
  children of dropped nodes, clamps role/multiplicity, and **guarantees every
  picked landmark appears exactly once** (omitted ones appended as flat
  roots) — so stored composition never loses a landmark. Prompt registered in
  `getPromptTexts` + Studio `PROMPT_REGISTRY` (id `proposeLocaleStructure`).
- **Background `PROPOSE_LOCALE_STRUCTURE`** (stateless; landmarks in payload).
- **locale-capture:** "🧬 Structure with Claude" button above the landmark
  list; applies the proposal to the draft with per-node `authoringMetadata:
  {capturedBy:'llm-proposed'}`; renders a read-only indented tree preview
  (alias + role + multiplicity) + groupings/sequences. Invalidated on any
  pick/remove (landmark-set change). On save, persists as
  `landmarks: LandmarkNode[]` (+ groupings/sequences) when it still covers
  exactly the picked set; else flat.

**Scope / partials:**
1. **Post-pick enrichment, not role-scaffolding.** Spec § 13's canonical flow
   is description → LLM proposes roles → user fills landmarks per role. Our
   flow is bottom-up (pick landmarks, then structure over them), which fits
   the existing picker. Same Layer 2 output; different authoring order.
2. **Preview is read-only** (Phase B = manual relationship editing, deferred).
3. **Structure invalidated wholesale** on landmark-set change (no incremental
   re-structuring); the author re-runs the button.

**Touched.**
- `Services/AnthropicService.js` — `proposeLocaleStructure` + sanitizer +
  prompt snapshot.
- `background.js` — `PROPOSE_LOCALE_STRUCTURE` handler.
- `Sidepanel/modes/locale-capture.js` — structure bar/preview, propose
  handler, invalidation, save-path persistence; imports `flattenLandmarkNodes`.
- `studio.js` — `PROMPT_REGISTRY` entry.
- `assets/sidepanel.css` — structure bar/preview styles.

---

## v2.74.340 — Fix: landmark reuse left primary alias empty / crossed grounds

**Date:** 2026-05-22
**Context:** bug fix surfaced during clean-slate chain verification.

**Symptom.** Saving a Locale failed with `Landmark "<accessibleName>" needs an
alias` even though the alias field showed values.

**Root cause.** The pick-time "reuse existing landmark from registry" path
(locale-capture, `GET_LANDMARK` by canonical UID) had two defects:
1. It restored `aliases` (secondaries) but NOT the singular `alias` (primary)
   — a leftover from the role→alias rename (v2.74.275) — so a reused landmark
   kept an empty primary alias and failed save validation.
2. The match is a GLOBAL by-UID lookup, so it matched landmarks **orphaned
   from a deleted ground** (GROUND_SPEC § 11 preserves landmark records on
   ground delete). Reusing such a cross-ground record would also have thrown
   at `SAVE_LANDMARK`'s groundId guard ("cannot reassign to ground").

**Fix.**
- Restore the primary `alias` from the registry record in the reuse block
  (with a fallback that promotes the first secondary if the stored primary
  is empty).
- Gate reuse on `existing.groundId === _locGroundId` — a cross-ground/orphaned
  match now falls through to Claude refinement, minting a fresh per-ground
  landmark record. (Re-homing orphaned landmarks into a new ground — the
  GROUND_SPEC § 11 "recreate similar ground" reuse case — is deferred; it
  needs a registry re-home affordance, not silent cross-ground reuse.)

**Touched.**
- `Sidepanel/modes/locale-capture.js` — reuse block: alias restore +
  same-ground gate.

---

## v2.74.341 — saveLandmark re-homes orphaned landmarks (GROUND_SPEC § 11 reuse)

**Date:** 2026-05-22
**Context:** continuation of the v2.74.340 fix during clean-slate verification.

**Why.** Canonical landmark UIDs are deterministic (same element → same UID),
so re-capturing the same element in a NEW ground produces the same UID even
when we skip metadata reuse (v2.74.340). `saveLandmark` then threw at its
groundId guard against the record orphaned from the deleted ground
(`Landmark lmk_… already exists on ground gnd_old; cannot reassign to
gnd_new`), blocking the first locale save on a freshly-recreated ground.

**Fix.** `saveLandmark`, on a groundId mismatch, now checks whether the
existing record's ground still exists:
- **Old ground deleted (orphaned)** → RE-HOME: drop the stale old-ground
  index entry, overwrite the record with the new groundId, add to the new
  ground's index. This implements GROUND_SPEC § 11's "recreate a similar
  Ground → reuse captured landmarks" (which v2.74.340 had deferred).
- **Old ground still exists** → refuse as before (genuine live cross-ground
  conflict; the per-Ground registry model doesn't support one landmark in two
  live grounds).

**Touched.**
- `Services/StorageManager.js` — `saveLandmark` orphan re-home branch.

---

## v2.74.342 — Clickable detection for JS-wired buttons + softer role/type verdict

**Date:** 2026-05-22
**Context:** bug fix during clean-slate verification.

**Symptom.** A search button (SVG magnifying-glass inside a `<div>`) failed
verification: `role "search-button" implies button/clickable, but matched
element is <div>` → hard `mismatch`, blocking the landmark.

**Root cause.** The capability model derived `isButton`/`clickable` only from
`tag=button`, `role∈[button,link,…]`, or an inline `onclick` attribute. A
`<div>`/`<span>`/SVG icon button whose click handler is attached via
`addEventListener` (the norm for modern frameworks) has none of those, so
`clickable=false` → `typeMatchesRole=false` → `mismatch`.

**Fix (two parts).**
1. **`cursor: pointer` ⇒ clickable.** `_classifyElementShapes` now adds the
   `button` shape when the fingerprint's computed `cursor` is `pointer` — a
   strong, already-captured clickability signal for JS-wired icon buttons.
   This makes the element verify clean AND become CLICK-capable
   (`operationsAllowed` includes CLICK). Semantically correct: a
   cursor:pointer element is one the site presents as clickable.
2. **Role/type mismatch ⇒ caveat, not mismatch.** `computeVerificationScore`
   no longer hard-fails on `typeMatchesRole=false`; only an absent/invisible
   element is a true `mismatch`. The element resolves + is visible, and the
   capability model gates ops by ACTUAL capability regardless of the score —
   so a type label that disagrees with the element shape is advisory, not
   blocking. (Safety net for clickability signals cursor:pointer can't catch.)

**Touched.**
- `Services/LandmarkProfile.js` — `_classifyElementShapes` cursor:pointer
  signal; `computeVerificationScore` mismatch→caveats for type-role.

---

## v2.74.343 — Locale_ref hint count via landmarkRefs (hardening pass)

**Date:** 2026-05-22
**Context:** post-verification hardening (the recurring "shape change left a
reader behind" class).

`locale.landmarks` is now `LandmarkNode[]`; `.length` is the ROOT-node count,
which undercounts structured (nested) locales. The locale_ref condition-hint
renderers in `studio.js` and `Sidepanel/modes/observation-author.js` now count
via the flat `landmarkRefs` mirror, and show the node `role` (falling back to
legacy `alias`). fragment-author's equivalent was already correct (it hydrates
a flat landmark array).

---

## v2.74.344 — Locale Layer 2 Phase B-lite: per-node structure review (LOCALE_SPEC § 3/§ 5)

**Date:** 2026-05-22
**Decision by:** user ("B-lite: per-node review").

**What.** Completes the "user-as-reviewer" half of the Layer 2 LLM-as-author
premise. The structure preview in locale-capture is now interactive:
- Per node: editable `role` (text) + `multiplicity` (select), and ✓ accept /
  ✗ reject buttons.
- Each action records `authoringMetadata.userJudgment` on the node
  (`accepted` | `edited` | `rejected-but-kept`) + `reviewedAt` — the
  LOCALE_SPEC § 3/§ 5 training signal. Visual: left-border tint per state.
- role/multiplicity edits update in place without re-render (preserve input
  focus); judgment buttons re-render to reflect state. Persisted with the
  structured `landmarks` nodes on save.

**Scope (B-lite, per the chosen option).** Re-nesting (move into/out of
`contains`), groupings/sequences editing, and the full typed-relationship
vocabulary (alternatives/references/triggers/derivedFrom/presenceCondition)
are NOT editable yet — deferred to B-mid / B-full. "Reject" is metadata-only
(flags the proposal; the landmark + node stay), not a structural delete.

**Touched.**
- `Sidepanel/modes/locale-capture.js` — `_findStructNode`,
  `_markStructJudgment`, editable `_renderStructNodeRow`, review handlers.
- `assets/sidepanel.css` — interactive node-row + judgment-state styles.

**Locale audit — still open (acknowledged):** `isPrimary` + primary-Locale
UX (§ 8), Locale lifecycle draft/active/deprecated + soft-delete (§ 12),
per-field `authoringMetadata` + `proposalContext` (§ 5/§ 6), description
required-at-save (§ 6, currently auto-backfilled), Locale events (§ 10),
deletion impact analysis / orphan detection (§ 11), event-driven/per-thread
active-set (§ 9), description-first intent-driven authoring flow (§ 13).

## v2.74.345 — Locale Layer 2 Phase B-mid: re-nesting outline controls (LOCALE_SPEC § 3)

**Date:** 2026-05-22
**Decision by:** continuation of the Locale Layer-2 thread (B-lite → B-mid).

**What.** The structure preview now lets the reviewer correct Claude's
containment proposal directly, not just flag it. Each node row gains two
outline controls:
- ➡ **nest** — moves the node into its preceding sibling's `contains`.
  Disabled for the first child at any level (no preceding sibling).
- ⬅ **promote** — moves the node out one level, inserted just after its old
  parent in the grandparent's list; tidies an emptied `contains`. Disabled at
  the root (depth 0).

Both reuse the existing B-lite re-render path and mark the moved node
`authoringMetadata.userJudgment = 'edited'` (the § 3/§ 5 training signal), so a
structural correction is logged exactly like a role/multiplicity edit.

**Why outline buttons, not drag.** Indent/outdent can only ever move a node
relative to its current tree position, so cycles are structurally impossible —
no validation pass needed — and there is no drag/drop hit-testing complexity.

**Scope.** Containment only. Groupings/sequences editing and the full typed
relationship vocabulary (alternatives/references/triggers/derivedFrom/
presenceCondition) remain deferred to B-full.

**Touched.**
- `Sidepanel/modes/locale-capture.js` — `_locateStructNode`,
  `_indentStructNode`, `_outdentStructNode`; `_renderStructNodeRow` gains an
  `index` param + ⬅/➡ buttons; indent/outdent click handlers.
- `assets/sidepanel.css` — `.loc-struct-move-btn` styling.

## v2.74.346 — Locale Layer 2 Phase B-mid (overlays): grouping/sequence review (LOCALE_SPEC § 3/§ 5)

**Date:** 2026-05-22
**Decision by:** continuation of the Locale Layer-2 thread.

**What.** Closes the last gap in the "user-as-reviewer" loop. Claude proposes
`groupings` (cross-cutting ▣) and `sequences` (ordered →) alongside the
containment tree, but until now they rendered read-only — the author could see
them but not judge or fix them. Each overlay row is now interactive, mirroring
the node row:
- editable **name** (flags `userJudgment: 'edited'`),
- ✓ **accept** / ✗ **reject-but-kept** judgment buttons (records
  `authoringMetadata.userJudgment` + `reviewedAt` — the § 3/§ 5 training
  signal; left-border tint per state), and
- 🗑 **delete** — drops the overlay entirely. Safe because overlays are pure
  annotations: deleting one removes no landmark from the Locale (the flatten
  only follows `contains`/`alternatives`, never overlays).

`onProposeStructure` now stamps overlays with the same
`{capturedBy:'llm-proposed'}` provenance as nodes so judgments have somewhere
to land; `_markStructJudgment` is reused since it only touches
`.authoringMetadata`. Overlays persist via the existing `..._locDraft` spread
in `saveLocale` (only when a valid structure is saved).

**Consumer note.** As with the rest of the structure feature, the runtime
`locale_ref` predicate path consumes only the flat landmark-UID set
(`flattenLandmarkNodes`), which ignores overlays. The overlays' value is the
LLM-as-author/user-as-reviewer training signal + human comprehension — the
premise already accepted for C-lite/B-lite/B-mid, not a new abstraction.

**Touched.**
- `Sidepanel/modes/locale-capture.js` — `_overlayArr`, `_findOverlay`,
  `_deleteOverlay`; `_renderOverlayRow`; overlay stamping in
  `onProposeStructure`; `[data-overlay-action]` handlers.
- `assets/sidepanel.css` — `.loc-struct-overlay-row` + inner styles; judged
  tints generalized to cover overlay rows.

## v2.74.347 — Structure gets a consumer: judgment-aware Re-structure (LOCALE_SPEC § 5/§ 13)

**Date:** 2026-05-22
**Decision by:** user ("Give structure a consumer").

**Why this shape.** An Explore pass confirmed that **no downstream authoring
prompt consumes locale landmarks via the LLM** — actions/fragments are authored
manually + grounded on raw DOM (`suggestSelector`/`proposeNextStep` never see a
landmark list). So there was no existing flat-list prompt to upgrade, and the
structured tree (roles/containment/overlays) + the B-lite/B-mid review
judgments had **no consumer at all** beyond being saved. Building a brand-new
"author actions from landmarks" LLM surface would be a large, separate feature.
The tightest genuinely-valuable consumer is the structure's own iterate loop.

**What.** "🧬 Re-structure" previously discarded the reviewed structure and
proposed from a blank slate — silently throwing away every accept/edit/reject.
It now sends the current structure back to `proposeLocaleStructure` as
`priorStructure`, turning the call into a **refine**:
- The prior nodes + overlays are serialized to a compact outline with each
  item's `[judgment]` (accepted / edited / rejected-but-kept) surfaced.
- New system instructions: preserve accepted/edited arrangements verbatim;
  re-think ONLY rejected ones + landmarks added since the last proposal.
- First-time "Structure" (no prior) is unchanged — `priorStructure` is omitted
  and the refine block is absent.
- **Judgment carry-forward.** After a refine returns, the prior `userJudgment`
  is re-applied to any node/overlay whose placement is unchanged (node: ref +
  role + multiplicity + parent all match; overlay: name + exact members/steps
  match). Without this, the post-refine re-stamp wiped every judgment —
  forcing a full re-review and discarding the § 5 training signal each cycle.
  Anything the LLM altered (or anything new) resets to unreviewed.

This makes both the structured tree AND the § 5 `userJudgment` training signal
an actual input to the LLM — closing the LLM-as-author / user-as-reviewer loop
into an iterate cycle. Output path (sanitizer, completeness backfill) is
untouched, so refine answers are still clamped to the allowed UID set.

**Touched.**
- `Services/AnthropicService.js` — `proposeLocaleStructure` gains
  `priorStructure` param + conditional refine instructions; new
  `#serializePriorStructure` (refs clamped to allowed set, dropped-ref children
  promoted, judgments surfaced); `getPromptTexts` snapshot notes refine mode.
- `background.js` — `PROPOSE_LOCALE_STRUCTURE` passes `priorStructure` through.
- `Sidepanel/modes/locale-capture.js` — `onProposeStructure` builds
  `priorStructure` from the draft on a re-structure.

## v2.74.348 — Locale description-first proposal flow (LOCALE_SPEC § 13 / § 16.6)

**Date:** 2026-05-22
**Decision by:** user ("Build the full flow").

**Gap closed.** The spec's canonical authoring flow (§ 13 "LLM-mediated
proposal flow", § 16 implementation-priority 6) was unimplemented. The two
existing LLM touchpoints were both capture/page-first: `suggestLocale`
(page-only autofill of concrete landmarks) and `proposeLocaleStructure`
(structure imposed AFTER free-form capture). Neither is intent-seeded or
role-scaffolded. This builds the missing inverse: **intent → propose roles →
fill**.

**What.** A new "Perspective (LLM-assisted)" card in locale-capture:
1. The author writes the intent in **Description** (now the proposal seed).
2. **✨ Propose perspectives** sends intent + page DOM to the new
   `AnthropicService.proposePerspectives`, which returns 2-3 perspective
   OPTIONS — each a name, rationale, named landmark **roles** (role +
   description + multiplicity, NOT selectors), and urlMatches predicates.
3. The author picks an option (**Use this**) → its name seeds the Locale name
   (if blank), its predicates seed the Additional-predicates section.
4. A **role checklist** appears; each role's **Pick** button enters the picker
   bound to that role. On `PICK_RESULT` the landmark is tagged `roleFill` +
   `roleMult` and its alias is seeded from the role; the checklist marks ✓.
5. At save, if every landmark filled a role and no explicit structure exists,
   a flat structured composition is synthesized (`role` →
   `LandmarkNode.role`, `userJudgment: 'accepted'`) so the role authoring
   lands in the composition rather than being discarded.

**Also (§ 6 / § 15).** Description is now **required at save**
(`EmptyDescriptionError` equivalent) — fixes the legacy "blank-page" Locale.
`authoringMetadata.description` records `source` ('direct' | 'proposal') +
`proposalContext.seedText` when the description seeded a proposal.

**Faithful-but-bounded.** Roles do NOT carry suggested selectors — per "LLM as
proposal layer, user as committer", the LLM names roles and the user picks the
real elements. Predicates proposed are urlMatches-only (landmarks don't exist
at proposal time). The manual/direct path (+ Pick landmark) is unchanged and
still available; the proposal card is optional.

**Touched.**
- `Services/AnthropicService.js` — `proposePerspectives` (+ sanitizer) and its
  `getPromptTexts` snapshot.
- `background.js` — `PROPOSE_LOCALE_PERSPECTIVES` handler (inject +
  `DOM_SNAPSHOT_RICH` + call; uncached since intent-dependent).
- `Sidepanel/modes/locale-capture.js` — perspective card template + state;
  `_renderPerspectivePanel`, `onProposePerspectives`, `onChoosePerspective`,
  `onPickForRole`, `_perspectiveRoleFilled`; `startLocalePick`/`PICK_RESULT`
  role binding; description-required save gate; role→structure synthesis;
  `authoringMetadata.description` tracking.
- `assets/sidepanel.css` — perspective panel + option/role styles.
- `studio.js` — `proposePerspectives` prompt-registry entry.

## v2.74.349 — Bug pass on the Locale Layer-2 + proposal-flow work

**Date:** 2026-05-22
**Decision by:** user ("bug pass").

Hardening review of v2.74.345–348. Fixes:

1. **In-flight unmount/switch crash (real).** `onProposeStructure` and
   `onProposePerspectives` wrote to `_locDraft` after their `await`, with no
   guard. If the panel unmounted (or remounted onto a different Locale) during
   the multi-second LLM call, the result handler hit `_locDraft.X =` on a null
   or wrong draft — TypeError or cross-Locale contamination. Both now capture a
   `draftToken = _locDraft.id` before the await and bail if it changed.

2. **Structured composition didn't round-trip on edit (real).** Re-opening a
   saved Locale hydrated only the flat `landmarkRefs`; the structured
   `landmarks` tree + overlays were dropped — so judgment-aware Re-structure
   (§ 5) silently proposed from scratch and role authoring (§ 13) vanished.
   Now `ground-view._editLocale` passes `landmarks`/`groupings`/`sequences`,
   and locale-capture rehydrates them into `structuredLandmarks` — but ONLY
   when non-trivial (a node carries role/multiplicity/contains/alternatives, or
   overlays exist), since StorageManager normalizes every Locale's `landmarks`
   to at least flat `{ref}` nodes (else every edited Locale would falsely show
   as "structured"). `roleFill` is reconstructed from node roles.

3. **Over-constrained predicates from perspective choice (real footgun).**
   Choosing a perspective APPENDED its `urlMatches` to the full-URL predicate
   auto-seeded on mount; ANDed, the Locale would never match sibling pages.
   Now the option's first `urlMatches` REPLACES existing `urlMatches`
   (non-URL predicates preserved); only one is seeded (multiple under AND can't
   all match one URL).

4. **Mixed role/manual authoring dropped all roles (correctness).** The
   save-time role→structure synthesis only fired when EVERY landmark was
   roled. Now it fires when ANY landmark is roled, mapping each landmark to a
   node (roled → role; free-picked → bare `{ref}`), covering the exact set.

5. **Stale chosen-perspective after Re-propose (UX).** Fresh options now clear
   `_chosenPerspective` so the role checklist can't render against an option no
   longer in the list. Chosen-option highlight switched to object identity
   (robust to same-named options).

**Touched.** `Sidepanel/modes/locale-capture.js`, `Sidepanel/modes/ground-view.js`.

## v2.74.350 — Perspective proposal: enhanced context + A/B benchmark (LOCALE_SPEC § 13)

**Date:** 2026-05-23
**Decision by:** user ("your pick … but with a benchmark … add second button").

**What.** Two propose buttons in locale-capture — **baseline** and
**enhanced** — so proposal quality can be compared empirically instead of by
feel. Both call the same `proposePerspectives` with the **same system prompt**;
they differ only in the context the enhanced arm adds, so the A/B isolates the
value of that context (the DOM is held constant in both):

- **Screenshot** — `chrome.tabs.captureVisibleTab` of the page, passed as a
  multimodal image block (layout / visual prominence / repetition signal the
  text DOM can't convey). Captured only when the target tab is active (else the
  wrong page would be grabbed); failure degrades, never aborts.
- **Sibling Locales** — `StorageManager.listLocales(groundId)` → each Locale's
  name + description + role set, with an instruction to avoid duplicating them
  and reuse role vocabulary (consistent library; the differentiated,
  on-architecture signal a stock LLM can't have).
- **Landmark registry** — `listLandmarksForGround(groundId)` → alias +
  a11yRole + description, so a role can map to an already-captured landmark
  (substrate reuse).

Each run renders side-by-side under a header summarizing exactly what it used
and how long it took (e.g. *"Enhanced · screenshot + 3 locale(s) + 12
landmark(s) · 3.4s"* vs *"Baseline · DOM only · 2.1s"*). "Use this" works from
either run; the chosen option drives the role checklist as before.

**Design notes.**
- Enhanced context is purely **additive** in the user message; when omitted the
  call is byte-identical to baseline — clean A/B.
- One variant runs at a time (avoids tab-capture races); the unmount/switch
  guard (v2.74.349) applies to both.
- The screenshot stays in the background process; only `options` + a `meta`
  summary cross back to the sidepanel (no large payload over the wire).

**Touched.**
- `Services/AnthropicService.js` — `proposePerspectives` gains `screenshot`/
  `siblingLocales`/`registryLandmarks` (additive blocks + image content).
- `background.js` — `PROPOSE_LOCALE_PERSPECTIVES` gathers the enhanced context
  (screenshot + listLocales + listLandmarksForGround) on `enhanced:true` and
  returns a `meta` summary.
- `Sidepanel/modes/locale-capture.js` — per-variant state (`_perspectiveRuns`,
  `_perspectiveInFlightVariant`), two buttons, side-by-side render + timing,
  `onProposePerspectives(variant)` / `onChoosePerspective(variant, idx)`.
- `assets/sidepanel.css` — button row + per-run group styles.
- `studio.js` — prompt-registry note on the benchmark.

## v2.74.351 — Proposal on-page/downstream tagging + linked-perspectives design note

**Date:** 2026-05-23
**Decision by:** user ("tag on-page vs downstream and capture as a design note").

**Context.** The benchmark surfaced that the intent-first proposal reasons about
the whole *journey*, not just the current page — e.g. on a homepage it proposes
both `music-search-homepage` (on the page) AND `music-results-grid` (a
downstream page reached after searching). The latter's roles can't be picked in
a single-page session, and the relationship between such perspectives is
undefined by the Locale spec ("linked / compound perspectives").

**What (built — the pragmatic half).**
- `proposePerspectives` now tags each option `onPage: boolean` (default true)
  and, for downstream options, a short `reachedVia` phrase ("after submitting
  the search"). The LLM judges on-page vs downstream from the DOM/screenshot.
  Option cap raised 3→4 to accommodate multi-stage flows.
- locale-capture renders downstream options with a `⤳ downstream` badge + the
  `reachedVia` note and **no "Use this"** (their roles aren't pickable here);
  on-page options are fillable as before. Navigate to the downstream page and
  re-propose → it returns `onPage:true` and becomes fillable; combined with the
  v2.74.350 sibling-Locale context, flow knowledge accumulates across sessions
  without an explicit link.
- Keeps Locales flat / spec-conformant; preserves the LLM's flow foresight as
  guidance.

**What (captured — the design half).** `DESIGN_linked_perspectives.md` — the
concept, why it arises, the affordance-vs-operation split, why it belongs at
**Tier 2 (Ground)** not in Locale (per LOCALE_SPEC § 3's deferred "Inter-Locale
relationships"), a candidate `Ground.localeTransitions` model (`from / via{
landmarkRef, action } / to / condition`), its relationship to Workflow (the
executor), and open questions. Nothing in § 4 of that note is built.

**Touched.**
- `Services/AnthropicService.js` — `proposePerspectives` option `onPage` +
  `reachedVia` (prompt + sanitizer); cap 3→4.
- `Sidepanel/modes/locale-capture.js` — downstream rendering (badge + reachedVia,
  no choose button).
- `assets/sidepanel.css` — downstream option styles.
- `DESIGN_linked_perspectives.md` (new) — the design note.

## v2.74.352 — "Resolve roles": auto-fill a perspective's roles → selectors (LOCALE_SPEC § 13)

**Date:** 2026-05-23
**Decision by:** user ("add a second button … spec its use … write into spec and implement — we'll iterate with performance").

**What.** A second button — **⚡ Resolve roles** — next to "Use this" on each
*on-page* proposed perspective. The inverse of the picker: instead of the user
clicking N elements, Claude resolves every role to a CSS selector in ONE call,
the sidepanel verifies each, and the user reviews. See
`DESIGN_resolve_roles.md` for the full spec (incl. the not-yet-built
set-of-marks north-star).

**Flow (v1).**
1. Clicking it adopts the perspective (= "Use this": name, URL predicate, role
   checklist) then calls the new `RESOLVE_LOCALE_ROLES`.
2. Context for accuracy: screenshot (`captureVisibleTab`) + rich DOM
   (`DOM_SNAPSHOT_RICH`) + the Ground's landmark registry (reuse). One LLM call
   (`AnthropicService.resolveRoles`) returns a selector — or `null` (abstain) —
   per role, with confidence + justification. Non-CSS selectors are rejected
   (`_looksLikePlaywrightSelector`).
3. Each returned selector becomes a draft landmark and runs through the
   EXISTING `verifyLocaleLandmark` (INSPECT_ELEMENT → multi-axis score +
   canonical uid + a11y profile — **no extra LLM call**, N cheap probes).
4. Selectors that don't resolve / score `mismatch` are dropped, so that role
   stays unfilled (○) in the checklist for manual picking. Abstentions likewise.
5. Toast summary: *"resolved N, M didn't match, K skipped · pick the rest
   manually."* Roles still become `LandmarkNode.role` at save (existing synthesis).

**Why this shape.** Cost = 1 LLM call + N content-script probes (not 1+N LLM
calls). Verification — not faith — gates what lands, so a hallucinated selector
is caught and routed to manual. Consistent with LLM-as-author / user-as-reviewer.
Downstream (off-page) perspectives get no Resolve button — their elements aren't
on the page.

**Guards.** One propose/resolve op at a time; the v2.74.349 draft-identity token
discards results that land after unmount/switch (checked again after the
per-role verify await).

**Iteration note.** v1 has Claude write selectors directly (+ verify + manual
fallback). If accuracy is weak, the documented next step is set-of-marks
(label real candidates → Claude chooses by label → system synthesizes the
selector) + region-first scoping + a verify-repair loop — `DESIGN_resolve_roles.md` § 4.

**Touched.**
- `Services/AnthropicService.js` — `resolveRoles` (+ sanitizer reusing
  `_looksLikePlaywrightSelector`).
- `background.js` — `RESOLVE_LOCALE_ROLES` handler (inject + DOM snapshot +
  screenshot + registry → `resolveRoles`).
- `Sidepanel/modes/locale-capture.js` — `⚡ Resolve roles` button on on-page
  options; `onResolveRoles` (adopt → resolve → per-role `verifyLocaleLandmark`
  → drop failures); `_resolveInFlightKey` state + unmount reset.
- `assets/sidepanel.css` — option-actions button row.
- `DESIGN_resolve_roles.md` (new) — the spec.

## v2.74.353 — Resolve-difficulty complexity metric + run logging (testing instrument)

**Date:** 2026-05-23
**Decision by:** user ("quantify site complexity … rate performance and verify improvements … visually tag to the site page").

**Why.** Resolve roles succeeds on simple sites, fails on complex ones. To make
"we improved it" measurable, every page gets a deterministic difficulty score
(the x-axis) and every Resolve run is logged against it (the y-axis).

**What.** `computePageComplexity()` (content script, no LLM, stable per page)
scores 0–100 (↑ = harder), tuned to selector-resolution difficulty across two
channels — the user's insight that the *screenshot* Claude is sent must also be
qualified:
- **Synthesis (DOM, 60%)** — can a durable selector be written? hook scarcity
  (25), class obfuscation (15), div-soup ratio (8), shadow DOM/custom els (7),
  scale & depth (5).
- **Matching (visual, 30%)** — can Claude tell which element it is, given the
  viewport-only screenshot? off-screen-candidate ratio (18), opaque controls
  (12).
- **Blockers (10%)** — iframes (cross-origin heavier).
Tiers: Simple / Moderate / Complex / Severe.

**Surfaced** as a tiered colored badge in the locale-capture header
(`🧩 Complex · 61`); hover shows synthesis/matching sub-scores + factor
breakdown, so a failure reveals *which channel* is the bottleneck (→ set-of-marks
vs better visual capture). Recomputed on tab-change / navigation.

**Run logging.** Each Resolve run appends `{ts,url,variant,rolesTotal,resolved,
failed,abstained,ms,score,synthScore,matchScore,tier}` to
`chrome.storage.local['resolveRoles:perf']` (capped 200), and the score rides in
the toast. Weights are first guesses, meant to be re-tuned from this data.

**Touched.**
- `ContentScripts/contentScript.js` — `computePageComplexity()` + `PAGE_COMPLEXITY`
  message.
- `background.js` — `GET_PAGE_COMPLEXITY` (inject + relay).
- `Sidepanel/modes/locale-capture.js` — header badge + `_refreshComplexity` /
  `_renderComplexityBadge`; recompute on tab change; `_logResolveRun`; state +
  unmount reset.
- `assets/sidepanel.css` — tiered badge styles.
- `DESIGN_resolve_roles.md` — § 7 (the metric).

## v2.74.354 — Robust JSON extraction (fix resolveRoles parse crash)

**Date:** 2026-05-23
**Decision by:** bug report — `resolveRoles error: Unexpected non-whitespace character after JSON at position 1433`.

**Cause.** All the structured-output methods extracted JSON with
`text.slice(indexOf('{'), lastIndexOf('}')+1)`. When the model appends prose
after the JSON object (and that prose contains a `}`), the slice over-captures,
so `JSON.parse` parses the object then chokes on the trailing content.

**Fix.** New `AnthropicService.#firstJsonObject(text)` brace-matches from the
first `{` (tracking string literals + escapes) to its matching `}`, returning
the first complete object and ignoring anything after it (also tolerates
markdown fences). Applied to `proposeLocaleStructure`, `proposePerspectives`,
and `resolveRoles`.

**Scope note.** ~11 other pre-existing methods (suggestLocale,
generateLandmarkProfile, proposeNextStep, …) use the same `firstBrace/lastBrace`
pattern. Left as-is for now (working, out of this feature area); the helper is a
drop-in if they later hit the same failure.

**Touched.** `Services/AnthropicService.js`.

## v2.74.355 — Resolve roles: surface WHY each role failed verification

**Date:** 2026-05-23
**Decision by:** bug report — "there's no logging on why verification failed."

**Gap.** When a Claude-resolved selector failed verification, `onResolveRoles`
silently dropped the landmark and bumped a `failed` counter — no reason
recorded, so there was nothing to debug complex-site failures with.

**What.** Each role's outcome is now captured + surfaced three ways:
- **Console log panel:** per role, `resolveRoles[<role>] resolved …` /
  `verify FAILED — selector="…" — <reason>` / `abstained — <reason>`, plus a
  done summary line.
- **Persisted:** the run-log entry (`resolveRoles:perf`) gains a `details[]`
  array — `{role, status, selector, reason, matchedCount, confidence}` per role
  — so failure reasons are analyzable alongside the difficulty score.
- **Inline:** under each unfilled role in the checklist, a note —
  `⚠ <reason>` (verification failure) or `∅ <reason>` (Claude abstained).
  Cleared when the role is filled manually.

`_verifyFailReason(v)` derives the reason from the verdict the verifier already
computes (issues / checks / matchedCount): "selector matched 0 elements",
"matched element is not visible", "type does not match the role", "matched N
elements (expected one)", etc. Abstain reason = Claude's `justification`.

**Touched.**
- `Sidepanel/modes/locale-capture.js` — `_verifyFailReason`, `_roleResolveNotes`
  state, per-role logging + details in `onResolveRoles`, inline note render,
  clear-on-manual-pick, unmount reset.
- `assets/sidepanel.css` — role-note styles.

## v2.74.356 — Verification feedback loop (opt-in repair round) — LOCALE_SPEC § 13 / DESIGN_resolve_roles § 8

**Date:** 2026-05-23
**Decision by:** user ("complete the loop … is this valuable? … Opt-in button").

**Value call (recorded).** Feeding verification verdicts back to Claude is the
highest-leverage v1 accuracy step for *fixable* failures (wrong-but-on-page
selector, count mismatch, wrong element) — the reason tells Claude exactly what
to change. Its ceiling is the *synthesis* ceiling: it can't manufacture a hook
that doesn't exist (shadow DOM / iframe / no durable hook). Token cost ignored;
latency cost = one extra LLM round-trip per round, so it's **opt-in** (user pays
only on demand).

**What.** After a Resolve run, unfilled roles that have a failure/abstain note
get a **"↻ Retry K with feedback"** button under the role checklist. One click =
one repair round:
- `resolveRoles` gains a `priorAttempt` arm — `{confirmed:[{role,selector}],
  attempts:[{role,selector,reason}]}`. Confirmed successes are shown as the
  site's working selector conventions (not re-emitted); each failed role's prior
  selector + verification reason is fed back, asking for a corrected selector.
- `onRetryFailedRoles` re-resolves ONLY the still-unfilled noted roles through
  the shared `_runResolve` driver (same create→verify→drop→note→log path,
  `mode:'repair'`). Repaired roles light ✓ and clear their note; still-failing
  ones update the reason. The user is the round cap (click again for another).
- Run logged to `resolveRoles:perf` with `mode`, so repair lift is measurable
  vs the difficulty score.

**Refactor.** `onResolveRoles`' result-processing extracted into `_runResolve`
(shared by initial + repair). Initial run clears `_roleResolveNotes`; repair run
updates only retried roles. JSON parse for all three LLM methods already
hardened in v2.74.354.

**Touched.**
- `Services/AnthropicService.js` — `resolveRoles` `priorAttempt` arm.
- `background.js` — `RESOLVE_LOCALE_ROLES` passes `priorAttempt` through.
- `Sidepanel/modes/locale-capture.js` — `_runResolve` extraction;
  `onRetryFailedRoles`; chosen-variant/idx state; retry button render + wiring;
  notes store prior `selector`.
- `assets/sidepanel.css` — retry-button spacing.
- `DESIGN_resolve_roles.md` — § 8 marked built.

