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

## v2.74.357 — Studio "Resolve" tab: perf viewer over resolveRoles:perf

**Date:** 2026-05-23
**Decision by:** user ("continue with resolveRoles:perf").

**What.** A new Studio tab turns the run log into the success-vs-difficulty
instrument the metric was built for:
- **Success by difficulty tier** — per tier (simple→severe): initial resolved%
  (resolved/roles), after-retry% (+repair contribution), run counts, avg time.
  Shows whether Resolve degrades with complexity and how much retry recovers.
- **Failure modes** — every failed role's reason classified **synthesis**
  (wrong/unreachable/ambiguous selector → feedback loop §8 / set-of-marks §4)
  vs **matching** (wrong element → better visual capture / region scoping), with
  a split % + interpretation hint + a top-reason histogram. This is the
  actionable read: it names which lever to pull next.
- **Recent runs** table (last 25): time, mode (initial/retry), tier·score,
  resolved/total, fail, abstained, ms, site.
- Refresh / Copy JSON / Clear controls.

Read-only over `chrome.storage.local['resolveRoles:perf']` (written by
locale-capture per ⚡ Resolve run). No new storage; analytics only.

**Touched.**
- `studio.html` — "Resolve" tab button + panel.
- `studio.js` — `renderResolvePerf` + reason classify/normalize helpers + tab
  hook + Refresh/Copy/Clear wiring.
- `assets/studio.css` — viewer table, tier pills, failure-mode histogram styles.

## v2.74.358 — LLM-call role framework (audited invoke + Studio LLM tab)

**Date:** 2026-05-23
**Decision by:** user ("role based framework of the LLM calls … better audited" → "Spec + invoke + audit view").

**What.** Replaces the unaudited generic `#call` with a role-aware, audited
path. See `DESIGN_llm_roles.md`. Roles (the judge-axis): **propose** (user
judges), **resolve** (verification judges), **describe** (soft/staleness),
**plan** (execution outcome), **extract** (schema), **classify** (threshold);
modifier **refine/repair**.

- **Audited call path.** `#call` gains an optional `meta = {role, operation}`
  and records every invocation — `{ts, role, operation, latencyMs, ok,
  outputChars, model}` — to `chrome.storage.local['llm:audit']` (capped 300,
  write-serialized through a promise chain so concurrent calls don't clobber).
  100% coverage regardless of labeling; un-labeled calls audit as
  **`unclassified`** = the visible migration backlog.
- **Core migration.** Labeled the Locale/Resolve/Propose/Describe pipeline:
  `proposePerspectives`, `suggestLocale`, `proposeLocaleStructure`
  (+`:refine`), `resolveRoles` (+`:repair`), `suggestSelector`,
  `generateLandmarkProfile`, `deriveGroundDescription`. Long-tail methods read
  `unclassified` until labeled.
- **Studio "LLM" tab.** Generalizes the Resolve tab to all calls: by-role and
  by-operation (calls, OK%, avg + p95 latency), recent calls, and a count of
  `unclassified` calls. Refresh / Copy JSON / Clear.

**Why low-risk.** Names + unifies patterns that already exist
(propose→userJudgment, resolve→verification, describe→staleness); `#call`'s
request/response is unchanged — the wrapper only times + records. Role labels
are additive metadata; partial migration loses no audit coverage.

**Discipline rule.** New LLM calls declare `{role, operation}`; the `unclassified`
bucket surfaces any that don't — "no role ⇒ shows up as debt".

**Touched.**
- `Services/AnthropicService.js` — `#audit` + serialized ring; `#call` `meta`
  param + per-call audit; 7 core methods labeled.
- `studio.html` / `studio.js` / `assets/studio.css` — "LLM" tab + `renderLlmAudit`
  + role pills.
- `DESIGN_llm_roles.md` (new) — the framework spec.

## v2.74.359 — LLM audit: token cost + model columns

**Date:** 2026-05-23
**Decision by:** user ("add cost column to LLM tab in tokens and model used column").

**What.** The audit record now captures `inTokens`/`outTokens` (from the API
`usage` `#call` already received) and the existing `model`. The Studio "LLM"
tab surfaces both: a **Tokens** column on the by-role and by-operation tables
(summed, compact `1.2k` formatting), Tokens (in→out on hover) + **Model** columns
on recent calls, and total tokens in the summary line. Old records (pre-359)
lack tokens and render `—`.

**Touched.**
- `Services/AnthropicService.js` — `#call` audit records `inTokens`/`outTokens`.
- `studio.js` — `renderLlmAudit` token aggregation, `fmtTok`/`shortModel`
  helpers, Tokens + Model columns.
- `DESIGN_llm_roles.md` — audit-record shape updated.

## v2.74.360 — Role→model policy + $ cost column

**Date:** 2026-05-23
**Decision by:** user (asked whether roles profit from different models → "yes").

**Rationale (recorded).** The roles cluster into cost/quality tiers: cheap+fast
(classify, simple extract, trivial describe) vs capable (propose, resolve, plan,
rich describe), with a vision constraint cutting across. The codebase already
did model-per-call ad hoc (Opus frontier); this systematizes it on the role axis.

**What.**
- **`pickModelForCall(role, operation, hasVision)`** resolves the model inside
  `#call`: op override → role default → `MODEL`; then a vision guard (image-
  bearing call → must be a vision-capable model). Tiers: `MODEL_FAST` (haiku,
  new), `MODEL` (sonnet, default), frontier (opus, unchanged + still bypasses
  `#call`). `ROLE_MODEL_POLICY` defaults everything to `MODEL` (zero regression)
  and demonstrates the fast tier on two harmless ops (`generateConversationTitle`,
  `generateSampleQuestion`, now labeled). Flipping a cheap role to `MODEL_FAST`
  is a one-line edit — deferred until the haiku id is verified + measured.
- **$ cost.** `#call` stores `costUsd` per call (via existing `estimateCostUSD`
  + pricing table; added a haiku pricing estimate). The Studio "LLM" tab gains a
  **Cost** column on by-role / by-operation / recent + total $ in the summary —
  no Studio↔pricing coupling (cost computed at source).

**Caveat flagged.** `MODEL_FAST = 'claude-haiku-4-5'` is a best-guess id; only
two non-critical ops route to it in v1, and the constant is the single place to
fix if wrong.

**Touched.**
- `Services/AnthropicService.js` — `MODEL_FAST` + pricing; `VISION_CAPABLE`,
  `ROLE_MODEL_POLICY`, `pickModelForCall`; `#call` resolves model + records
  `costUsd`; labeled 2 trivial describe ops.
- `studio.js` — `renderLlmAudit` cost aggregation, `fmtUsd`, Cost columns.
- `DESIGN_llm_roles.md` — § 4b model policy.

## v2.74.361 — Structure: capture dynamic depth (triggers + presenceCondition) — LOCALE_SPEC § 3 (partial B-full)

**Date:** 2026-05-23
**Decision by:** user (structure should capture "dropdown → reveals menu → option", conditionally present).

**Context.** The structure feature captured static containment (`contains`) +
roles + multiplicity + overlays, but not the *dynamics* — that a control reveals
its menu on interaction, and that the menu/options are only present in that
state. Those are LOCALE_SPEC § 3's `triggers` + `presenceCondition`, previously
deferred (the unbuilt "B-full"). This adds the two that capture the user's
dropdown case; `alternatives`/`references`/`derivedFrom` remain deferred.

**What.**
- **Proposal** (`proposeLocaleStructure`): the prompt + example now ask Claude
  for `triggers` (ref ids whose presence/content this node's interaction reveals
  or changes — cross-link, must also appear as nodes) and `presenceCondition`
  (short phrase for when a not-always-present node exists, paired with
  multiplicity conditional/optional). The example shows the canonical dropdown:
  control `triggers` its menu; menu is `multiplicity:conditional` +
  `presenceCondition:"after the control is opened"`; menu `contains` options.
- **Sanitizer**: `triggers` clamped to the allowed UID set (deduped, no self,
  ≤6); `presenceCondition` string ≤120.
- **Review UI**: per node, a "when present" editable note (shown when
  multiplicity is conditional/optional) and `⚡ triggers` removable chips. Edits
  flag the node `edited`; mult change re-renders to toggle the presence input.
- **Refine** (`#serializePriorStructure`): triggers + presence surfaced so a
  Re-structure preserves them. **Edit rehydration**: a triggers/presence-only
  node now counts as non-trivial structure.

**No coverage regression.** `flattenLandmarkNodes` follows only
`contains`/`alternatives`, so `triggers` (a cross-link) and `presenceCondition`
(a string) don't affect the save-time coverage check; they ride along on the
nodes via the existing spread.

**Consumer note.** Still authoring metadata — no runtime executor reads
`triggers`/`presenceCondition` yet (that's a Tier-2/Workflow consumer). Value is
the richer perspective + training signal + the substrate a future runtime needs.

**Touched.**
- `Services/AnthropicService.js` — `proposeLocaleStructure` prompt + sanitizer;
  `#serializePriorStructure` outline.
- `Sidepanel/modes/locale-capture.js` — `_renderStructNodeRow` detail rows;
  presence/untrigger handlers; mult-change re-render; rehydration guard.
- `assets/sidepanel.css` — detail-row + trigger-chip styles.

## v2.74.362 — Automated structure verification (static checks + poke-and-observe)

**Date:** 2026-05-23
**Decision by:** user ("automate structure verification … A and C").

**What.** A **✓ Verify** button on a structured Locale auto-checks the
composition against the live page, producing a per-node verdict (verified /
failed / unverifiable) so the human reviews only exceptions instead of
confirming every node. Two layers, routed by claim kind:
- **A — static (deterministic, no LLM):** content-script `verifyStructure`
  checks **resolution** (selector matches), **multiplicity** (match count vs
  one/many/optional), and **containment** (child element is a DOM descendant of
  its declared parent). Covers the bulk instantly.
- **C — poke-and-observe (behavioral):** for nodes with `triggers`, snapshot the
  targets' visibility, fire ONE synthetic click on the (safe-to-click — never a
  link/submit) source, wait, re-check → did the claimed targets get revealed?
  Conditional nodes (a menu) verify their presence by being revealed.

Verdicts: `failed` (0 matches, wrong count, not-contained, trigger revealed
nothing), `unverifiable` (no selector / iframe-bound / unsafe-to-poke /
conditional with no demonstrating trigger), else `verified`. Conditional/optional
nodes correctly treat absent-at-rest as expected, not a failure.

**UI.** Per-node badge (✓ auto / ✗ <reason> / ? <reason>) next to the manual
judge buttons; a toast summary. The transient `autoJudgment`/`autoNote` are
stripped at save (point-in-time verdict, not authored structure).

**Caveats (recorded).** Synthetic clicks mutate the page (menus left open) —
acceptable for an explicit verify action. Top-frame only (iframe-bound nodes →
unverifiable). It verifies *structural* claims, not semantic role correctness
(that's the deferred critic/self-consistency option D/E).

**Touched.**
- `ContentScripts/contentScript.js` — `verifyStructure` + `VERIFY_STRUCTURE` (async).
- `Sidepanel/modes/locale-capture.js` — `onVerifyStructure`, `_structVerdict`,
  ✓ Verify button + wiring, auto-badge render, save-time strip.
- `assets/sidepanel.css` — auto-verdict badge styles.

## v2.74.363 — Structure verify: portal-aware containment + check-after-poke

**Date:** 2026-05-23
**Decision by:** bug report — "✗ not a DOM descendant of its declared parent" for a custom dropdown/modal.

**Cause.** v2.74.362 verified `contains` with strict DOM ancestry
(`parentEl.contains(childEl)`). But `contains` is *logical* containment
(LOCALE_SPEC § 3 — "DOM-*like*… logically belong inside"), and custom dropdowns/
menus/modals are routinely **portaled** to `<body>` level, so they're not DOM
descendants of their trigger. Strict ancestry hard-failed every portaled popup.
Also, the static check ran before the poke, so a closed dropdown's
conditional subtree didn't exist yet → spurious resolution failures.

**Fix.**
- **Containment never hard-fails now.** Verdicts: `ok` (DOM descendant),
  `ok-portaled` (linked via ARIA `aria-controls`/`owns`/`labelledby` OR the
  popup pattern — parent has `aria-haspopup`/`expanded`/combobox + child is a
  menu/listbox/dialog/…-role or `*menu/dropdown/popover/modal/portal*` class) —
  both pass; `detached` (resolves, no link) → **unverifiable** "likely portaled
  — review", not ✗; `parent-missing` → unverifiable.
- **Static check runs AFTER poke**, so revealed conditional subtrees (the open
  menu + its options) exist when checked. Trigger reveal-diff snapshots target
  visibility before poking, as before.

**Known limit.** Sequential pokes can leave multiple menus interfering (last
opened wins); fine for the common 1–2 dropdown case. Top-frame only.

**Touched.** `ContentScripts/contentScript.js` (`isLogicallyContained`,
reordered poke→walk), `Sidepanel/modes/locale-capture.js` (`_structVerdict`
containment mapping).

## v2.74.364 — Structure verify: visual-critic escalation for the residual

**Date:** 2026-05-23
**Decision by:** user ("poke → monitor → unsure → screenshot → claude … yes").

**What.** After the deterministic pass, the residual claims determinism can't
settle escalate to a strict visual critic (one post-poke screenshot + one
`classify` call) — the tiered "cheap-first, LLM only on the residual" pipeline.
Determinism stays authoritative; only two residual kinds escalate:
- **`detached` containment** — portaled popups DOM ancestry can't prove. Critic
  judges visual association → `yes` = verified-visual, `no` = failed-visual,
  `unsure` = soft review.
- **`no-change` triggers** — DOM `getBoundingClientRect` visibility is
  unreliable for canvas/animated/transform widgets. Critic judges whether the
  target became visible after the poke → rescues false negatives.

`AnthropicService.adjudicateStructure({claims, screenshot})` (classify role, so
it auto-lands in the LLM audit tab with latency/token/$); claims carry the
elements' aliases + visible text for grounding; verdicts merge back into the
results and `_structVerdict` consumes them. Visual verdicts are labeled (badge
shows "✓ visual" / a 👁 on ✗/?) since they're softer than deterministic ones.

**Boundaries.** Single post-poke screenshot (state may be imperfect for
multi-dropdown). The critic is prompted to be STRICT (a wrong "yes" is worse
than "unsure") and never overrides a deterministic ✓/✗ — it only adjudicates the
residual. `unsafe-to-poke` / absent-conditional are NOT escalated (no visual
evidence to judge).

**Touched.**
- `Services/AnthropicService.js` — `adjudicateStructure` (classify critic).
- `background.js` — `ADJUDICATE_STRUCTURE` (screenshot + critic).
- `ContentScripts/contentScript.js` — per-node `rect` + `text` for grounding.
- `Sidepanel/modes/locale-capture.js` — escalation in `onVerifyStructure`,
  visual-aware `_structVerdict`, `autoVisual` badge, save-time strip.

## v2.74.365 — Virtual container nodes (model an unlandmarked modal/menu holding sections)

**Date:** 2026-05-23
**Decision by:** user ("dropdown opens a modal with sections … the whole menu can't be selected, only sections" → "Virtual container nodes").

**Problem.** The structure tree was built only from picked landmarks, so a real
container (modal/dropdown-menu) that wasn't itself landmarked had no node to be
the parent. Worse, the sanitizer DROPPED any ref-less node and promoted its
children — so even if Claude proposed a container, its sections were flattened
into peers, each redundantly carrying the shared trigger/presence (or one
section mislabeled as the whole menu).

**Fix — virtual nodes.** The composition may now include a **virtual container
node**: `{ virtual: true, vid, role, multiplicity?, presenceCondition?,
triggers?, contains: [...] }` — no `ref` (not a landmark), a structural wrapper
holding the section landmarks, with the shared presence/condition expressed
ONCE on the container.
- **Prompt + example**: the dropdown example now shows a virtual `dropdown-menu`
  (conditional, "after control opened") containing two section landmarks; a rule
  explains when to use it (and not to duplicate conditions or mislabel a
  section).
- **Sanitizer**: keeps ref-less role+contains nodes as virtual (synthetic
  `vid`), instead of flattening them.
- **`isLandmarkNodeArray`**: accepts virtual nodes (else the whole structure was
  misclassified as non-Layer-2). `flattenLandmarkNodes` already skips ref-less
  nodes + recurses `contains`, so save coverage / landmarkRefs are unaffected
  (virtual nodes contribute no refs; children flatten normally).
- **Review UI**: virtual rows render with a ▢ container label (italic, dashed
  left border), editable role/multiplicity/presence, judge + re-nest — keyed by
  `vid`. `_findStructNode`/`_locateStructNode` match `ref` OR `vid`.
- **Verification**: virtual nodes are skipped (no element → no resolution/
  containment verdict, no badge); their members verify normally and
  containment-against-a-virtual-parent is skipped (never a false fail). The
  shared presence is carried by the members' trigger reveal.
- **Refine** (`#serializePriorStructure`) renders virtual containers so a
  Re-structure preserves them. Runtime unaffected (locale_ref uses the flat
  landmarkRefs, never the node tree).

**Touched.** `Core/localeComposition.js`, `Services/AnthropicService.js`
(prompt + sanitizer + refine outline), `ContentScripts/contentScript.js`
(skip virtual in checkNode), `Sidepanel/modes/locale-capture.js` (node-id =
ref∥vid, virtual render + verdict skip), `assets/sidepanel.css`.

---

## v2.74.366 — Perspective propose: collapse baseline/enhanced A/B → single canonical (always-enhanced) run

**Date:** 2026-05-23
**Decision by:** user ("Enhanced is better and should be canonical — remove baseline").

**Context.** v2.74.350 introduced a two-arm benchmark for the "✨ Propose
perspectives" button: a **baseline** run (DOM snapshot + intent only) and an
**enhanced** run (also screenshot + the Ground's sibling-Locale roles +
registry landmarks). The A/B confirmed enhanced consistently produces richer,
more grounded perspectives. The benchmark plumbing (per-variant runs, variant
keys, dual buttons) is now dead weight.

**Change.** One button, one run, always enhanced.
- **Sidepanel (`locale-capture.js`)**: replaced `_perspectiveRuns =
  {baseline, enhanced}` / `_perspectiveInFlightVariant` /
  `_chosenPerspectiveVariant` with single `_perspectiveRun` /
  `_perspectiveInFlight` / `_chosenPerspectiveIdx`. `_renderPerspectivePanel`
  renders one run; options key on `data-idx` (no `data-variant`); resolve /
  retry in-flight keyed by `String(idx)` / `retry:${idx}`. Dropped the
  `variant` parameter from `onProposePerspectives`, `onChoosePerspective`,
  `onResolveRoles`, `onRetryFailedRoles`, `_runResolve`,
  `_perspectiveRunSummary`, `_logResolveRun`. Unmount reset + intent-toggle
  guard updated to the new var names. Payload no longer sends `enhanced`.
- **Background (`background.js`)**: `PROPOSE_LOCALE_PERSPECTIVES` removed the
  `enhanced` gate — it ALWAYS gathers screenshot (when target tab active) +
  sibling locales + registry landmarks (best-effort; any failure degrades, not
  aborts). `meta` dropped the `enhanced` field.

**Why this first.** Small, isolated, and unblocks the pivot: the next phases
build a **pageStructure** exploration artifact (poke→observe→verify sweep over
the whole page) that feeds depth-aware context INTO this same enhanced propose
call. Collapsing to one canonical path first keeps that wiring single-headed.

**Touched.** `Sidepanel/modes/locale-capture.js`, `background.js`,
`manifest.json`.

---

## v2.74.367 — pageStructure artifact foundation: page-depth sweep (poke→observe→restore), no LLM

**Date:** 2026-05-23
**Decision by:** user ("fires poke loop on all candidate selectors and generates
a page depth structure … this is then fed to propose for depth-aware
roles/landmarks" → "change to pageStructure — build"). Phase 2 of 3.

**Problem (the depth gap).** propose-perspectives authors from ONE static DOM
snapshot, so any content that exists only AFTER an interaction — a dropdown's
menu, a modal's sections, a tab panel, an accordion body — is invisible to it.
Those landmarks can today only be user-authored, because capture requires the
reveal to have already happened. The fix is a page-level exploration pass that
discovers that depth automatically, BEFORE proposing.

**This phase (foundation, no LLM yet).** A content-script sweep + a Ground-scoped
artifact cache.
- **`explorePageStructure(payload)`** (`contentScript.js`): enumerates the
  visible interactive **surface**, then the **disclosure candidates** (things
  likely to reveal hidden content: `[aria-expanded]`/`[aria-haspopup]`/`summary`
  /`[role=tab]`/`[role=combobox]` + toggle-ish class/label hints). For each
  candidate (bounded by `maxPokes`, default 24): snapshot the visible
  interactive set, fire ONE safe synthetic click (reuses the verify poke guard —
  never navigates/submits), wait to settle, diff for **novel visible
  elements** (the revealed depth), record their selector/role/label/rect, then
  **restore** (re-click to toggle closed → Escape fallback) so the next poke
  starts clean. Aborts the whole sweep if a click navigates. Per-control
  baseline (fresh visible set each time) so a sibling's reveal isn't
  miscounted. NO screenshots (captured fresh at propose-time) — text + geometry
  only. `payload.plan` is a Phase-3 hook: when present, only the planned
  selectors are poked.
- **Artifact shape** (`pageStructure`): `{ version, url, title, capturedAt,
  driftHash, viewport, surface[], controls[], stats }`; each control =
  `{ cid, selector, role, label, rect, expanded, haspopup, revealed[],
  revealCount, observation, restored }`; observation ∈ `reveal | no-change |
  unsafe | navigation-suppressed`.
- **driftHash**: cheap djb2 fingerprint over DOM size + candidate count +
  pathname + sorted control labels — for staleness detection at read-time.
- **Cache** (`background.js`): `pageStructureCache` keyed
  `{[groundId]:{[normalizedUrl]:{structure,url,capturedAt}}}`, mirroring
  `localeAutoDiscoveryCache` (reuses `_normalizeUrlForLocaleCache`, origin+
  pathname). `_readPageStructureCache`/`_writePageStructureCache`; 7-day TTL.
- **Handlers**: `EXPLORE_PAGE_STRUCTURE` (inject CS → run sweep → write cache →
  return artifact) and `GET_PAGE_STRUCTURE` (read cache, report `fresh` vs TTL,
  no sweep).

**Not yet (Phase 3).** No LLM planner, no "+ Locale" wiring/consent UI, no
feed into propose. Skeleton/surface elements are scaffolding, NOT landmarks.

**Touched.** `ContentScripts/contentScript.js` (sweep + message case),
`background.js` (cache helpers + 2 handlers), `manifest.json`.

---

## v2.74.368 — pageStructure Phase 3: LLM-planned sweep, "+ Locale" exploration UI, depth-aware propose

**Date:** 2026-05-23
**Decision by:** user ("LLM-planned … the + locale trigger was conditional on
if there wasn't already an artifact" → "change to pageStructure — build").
Phase 3 of 3 — the integration that makes the Phase-2 foundation pay off.

**1. LLM-planned sweep (the `plan` role).** The depth sweep is now two-pass:
- Content-script `explorePageStructure` gained an **`enumerateOnly`** mode:
  returns the disclosure candidates (selector/role/label/rect/safe) WITHOUT
  poking — so the planner can choose before the page is mutated.
- New `AnthropicService.planPageExploration({ url, title, candidates,
  screenshot, maxPokes })` (`plan` role, op `planPageExploration`): given the
  numbered candidates (+ optional screenshot for prominence), returns a
  budget-limited subset of indices worth activating, with a one-phrase reason
  each. Validates every pick is a real candidate and `safe!==false`. A bad pick
  wastes a poke, never corrupts the artifact (the sweep stays deterministic).
- Background `EXPLORE_PAGE_STRUCTURE` orchestrates enumerate → plan → sweep,
  passing the planned selectors to the content-script `plan` filter. **Graceful
  fallback**: planner failure/no-API degrades to poking all candidates (bounded
  by `maxPokes`). Annotates the artifact with `planned` + `plannerReasons`.

**2. "+ Locale" exploration UI (`locale-capture.js`).** The perspective panel
now carries a depth-exploration row, conditional on artifact freshness:
- On mount, `_refreshPageStructureStatus()` asks `GET_PAGE_STRUCTURE` — a FRESH
  artifact (within 7-day TTL) is reused silently (status `fresh`); otherwise the
  row offers **🔍 Explore / Skip**.
- **Explore** runs the sweep with a cancellable **"⏳ Exploring…"** state
  (soft-cancel via `_exploreToken` — invalidates the landing result, since the
  content-script sweep can't be truly aborted), then shows **"✓ Page depth
  explored — N control(s) revealed content · ↻ Re-explore"**. Failure → retry.
  Skip → static-only. Propose is disabled while exploring.
- New state: `_pageStructureStatus`/`_pageStructureInfo`/`_exploreToken`
  (reset on unmount). Handlers: `onExplorePageStructure(force)`,
  `onSkipExplore`, `onCancelExplore`, `_summarizePageStructure`.

**3. Depth-aware propose (`proposePerspectives` + `PROPOSE_LOCALE_PERSPECTIVES`).**
- `proposePerspectives` gained a `pageStructure` param: renders ONLY the
  reveal-confirmed controls with their revealed children into a "PAGE STRUCTURE"
  block, plus a system-prompt rule telling the author these elements are NOT in
  the static DOM — propose roles for them and note how each is revealed (they
  stay `onPage:true`; `onPage:false` remains navigation-only).
- The background reads the cached artifact at propose-time (cache is the channel
  — the UI just ensures it exists) and threads it in. `meta` gains
  `pageStructure` + `revealingControls`; the run header shows `depth(N reveal)`.

**Scaffolding, not landmarks.** Surface/revealed elements are exploration
signal that informs proposals; they are not auto-saved as landmarks — the author
still picks/resolves real elements per role.

**Touched.** `Services/AnthropicService.js` (planPageExploration + pageStructure
render), `background.js` (two-pass orchestration + propose-time read),
`ContentScripts/contentScript.js` (enumerateOnly), `Sidepanel/modes/locale-capture.js`
(exploration UI + state + handlers), `assets/sidepanel.css` (explore row),
`manifest.json`.

---

## v2.74.369 — pageStructure: fix "0 reveals" (chevron recognition, pointer-event poke, panel reveals, scroll depth)

**Date:** 2026-05-23
**Reported by:** user ("✓ explored — 0 control(s) revealed … impossible, multiple
dropdown buttons visible … does Claude not recognize chevrons? what about
vertical depth (scrolling)?").

**Root causes of the false 0.**
1. **Enumeration too narrow.** `isDisclosureCandidate` only matched
   `aria-expanded`/`aria-haspopup`/`summary`/`tab`/`combobox` or keyword class
   names. A real chevron dropdown is often a `<button>`/`<div>` with an SVG
   icon and hashed CSS-module classes — none of those — so it was never a
   candidate.
2. **`.click()` doesn't open many menus.** Lots of dropdown/menu libraries open
   on `pointerdown`/`mousedown`, not `click`.
3. **Reveal detection too narrow.** Only newly-visible INTERACTIVE_SEL elements
   counted; a revealed menu/dialog/tabpanel of non-interactive content scored 0.
4. **Planner pruned icon controls it couldn't label**, and an empty plan meant
   "poke nothing."
5. **No scrolling** — lazy / below-the-fold content was never triggered.

**Fixes (`contentScript.js`).**
- **Wider candidate net** (`CANDIDATE_SEL`): adds `[aria-controls]`,
  `[data-toggle]`/`[data-bs-toggle]`/`[data-state]`/`[data-headlessui-state]`,
  and `[class*=dropdown|chevron|caret|accordion|expand|disclosure|menu-toggle]`.
- **`candidateHint(el)`** classifies WHY an element qualifies — `aria-expanded`,
  `haspopup`, `aria-controls`, `details`, `tab`, `combobox`, `data-toggle`,
  **`arrow-glyph`** (▲▼▴▾◀▶∨⌄⌃ in short text), **`icon`** (svg/use/i with a
  chevron/caret/arrow class or href), **`icon-only`** (icon + ≤2 chars text),
  `keyword`. Drives candidacy + is surfaced to the planner + artifact.
- **`pokeOpen(el)`** fires the full sequence: `scrollIntoView` → `focus` →
  pointerdown → mousedown → pointerup → mouseup → `click()`.
- **`REVEAL_SEL`** widens the before/after diff to menu/menubar/listbox/dialog/
  tooltip/tabpanel/region/grid/tree/group; `aria-expanded` flipping
  `false→true` also counts as a reveal (CSS-only expansions).
- **Scroll depth**: steps down the page (≤12 × ~0.9 vh), re-collecting surface +
  candidates at each step to trigger lazy content, stops at bottom / stable
  height, then **restores scroll**. `stats.scrollSteps` recorded.
- Candidates now carry `hint` + `context` (nearby text) so the planner can
  identify an icon-only control ("the chevron near 'Sort by'").

**Planner changes (`background.js` + `AnthropicService.js`).**
- **Planner only prunes when it must**: skip it entirely when
  `candidates.length ≤ budget` (poke them all); an empty plan is ignored
  (poke-all-bounded) rather than poking nothing.
- Planner prompt renders each candidate's `hint` + `near "context"` and a rule:
  an icon/arrow-glyph control with an empty label is very likely a dropdown —
  prefer it.

**UI (`locale-capture.js`).** The done-chip now shows diagnostics —
"N revealed (C candidate(s), P poked, scrolled S×)" — so a 0 is explainable.

**Touched.** `ContentScripts/contentScript.js`, `background.js`,
`Services/AnthropicService.js`, `Sidepanel/modes/locale-capture.js`,
`manifest.json`.

---

## v2.74.370 — pageStructure: navigation guard (stop page transitions), extensive logging

**Date:** 2026-05-23
**Reported by:** user ("page transitions are occurring", "everything happens
extremely fast", "log depth exploration extensively").

**Diagnosis.** #3 explained #2: the richer pointer-event poke + wider candidate
net (v2.74.369) started poking nav links / SPA route triggers. The first poke
navigated, the sweep hit its navigation-abort (`break`), and finished in one
step — hence "extremely fast". So the real fix is to STOP transitions, not just
detect them.

**Navigation guard (`contentScript.js`).** Installed for the duration of the
sweep, removed in a `finally`:
- **Don't poke navigators**: `isSafeToClick` now refuses `a[href]`,
  `[role="link"]`, `[target="_blank"]`, and anything with `closest('a[href],
  [role="link"]')` (a chevron INSIDE a nav link is skipped).
- **Capture-phase click guard**: `preventDefault()`s anchor clicks (the JS
  handler still runs — a menu still opens — only the browser navigation is
  cancelled; no `stopImmediatePropagation`, so disclosure handlers fire).
- **SPA guard**: `history.pushState`/`replaceState` are no-op'd during the
  sweep (records the attempt) so client-side routers can't change the route.
- **Loop behavior**: a BLOCKED nav (guard caught it) is no longer a hard stop —
  the control is marked `navigation-blocked` and the sweep continues. Only a
  REAL URL change that slips the guard (e.g. `window.location =`) aborts.

**Extensive logging (`contentScript.js` + `background.js`).** The sweep builds a
structured `log[]` — begin params, enumerated counts, every candidate
(hint/role/label/context), each poke + observation (reveal/no-change/
navigation-blocked) + restore result, scroll steps, nav-guard hits, final
stats. Each line is `console.debug('[AHuB explore]', …)` in the page console
AND returned in the artifact; the background mirrors every line to the SW
console via `Logger.info('explore', …)` (enumerate + sweep passes), plus
planner decisions. The `log` array is stripped before caching (diagnostic
only). Planner now also logs "skipped (≤budget) — poking all" / "picked N".

**Touched.** `ContentScripts/contentScript.js` (nav guard + try/finally + log),
`background.js` (mirror log to SW console + strip before cache), `manifest.json`.

---

## v2.74.371 — pageStructure: "Page Structures" section on the Studio Ground card

**Date:** 2026-05-23
**Decision by:** user ("it's part of the ground, it should be on the ground card
in studio — a list of discovered page structures").

**What.** The discovered `pageStructure` artifacts are now listed on each Ground
card in Studio, alongside Locales — they belong to the Ground (one per explored
URL), so that's their home (not a separate audit tab).

- `_refreshGroundListImpl` reads `chrome.storage.local['pageStructureCache']`
  once and indexes it per ground.
- A new **"Page Structures"** `ground-section-row` (after Locales) lists each
  cached artifact, newest first: the URL path, a ⚡ badge when the poke set was
  LLM-planned, and a stat summary — *N reveals · C candidate(s) · P poked ·
  scrolled S× · M nav blocked · relTime(capturedAt)*.
- Per row: **{ }** opens the full structure JSON (controls + revealed children +
  stats + plannerReasons) via the existing read-only `showJsonModal` (kind
  `page-structure` → falls through `saveJsonModalEdits`' final else, so it's
  view-only like `locale`); **✕** deletes that entry from the cache (next "+
  Locale" on the page runs a fresh sweep) and refreshes the list.
- Empty state explains what page structures are (auto-discovered depth maps that
  feed depth-aware perspective proposals).
- Styles mirror `.locale-row` (`.page-structure-row` etc. in `sidepanel.css`,
  which Studio loads).

**Touched.** `studio.js` (cache read + Page Structures section + JSON/delete
wiring), `assets/sidepanel.css` (row styles), `manifest.json`.

---

## v2.74.372 — pageStructure: target the TOP frame + stop result-tile pokes (fix mid-sweep navigation)

**Date:** 2026-05-23
**Reported by:** user (log showed the sweep ran on `url:"about:blank"` with 0
candidates, yet the page navigated pixabay.com → a butterfly photo result).

**Two root causes.**
1. **Message fanned out to every frame.** `chrome.tabs.sendMessage(tabId, …)`
   with no `frameId` delivers to ALL frames. An ad/`about:blank` iframe answered
   first (0 candidates — what the log showed), while the real top frame ALSO ran
   the sweep, poked a result, and navigated — its response discarded. Fix: both
   the enumerate and sweep passes now send with **`{ frameId: 0 }`** (top frame
   only). The sweep is inherently a top-frame operation.
2. **Result/product tiles became "icon" candidates.** `candidateHint`'s icon
   branch did `el.querySelector('svg, …icon…')` over the WHOLE subtree, so a
   large result card containing an overlay heart/download icon qualified as an
   `icon-only` disclosure control — poking it navigated. Fix: the icon branch
   now requires the element to be **small** (≤96×96) and to NOT wrap a link or
   image (`a[href]`/`img`). A real icon toggle is small + self-contained; a
   navigation tile is large or wraps a link.

**Extra navigation insurance.** The sweep nav-guard now also no-ops
`window.open`, `location.assign`, and `location.replace` for its duration
(restored in `finally`), on top of the existing anchor-`preventDefault` +
`history.pushState/replaceState` blocks. The begin-log line now records
`top: <bool>` so the target frame is visible.

**Touched.** `background.js` (`frameId: 0` on both passes),
`ContentScripts/contentScript.js` (icon size/link guard + open/location guards +
frame log), `manifest.json`.

---

## v2.74.373 — pageStructure: catch labeled dropdown buttons ("Explore ▾"), keep carousels, plan less timidly

**Date:** 2026-05-23
**Reported by:** user, from a pixabay.com artifact: (1) carousels/sliders ARE
depth (advancing one surfaces additional selectable landmarks), and (2) the
top "Explore ▾" dropdown (a modal of real value) was missed.

**Bug #2 cause — my own width guard.** v2.74.372's tile-exclusion required an
icon control to be ≤96px WIDE. The "Explore" button is 103×40, so the icon
branch was skipped → never a candidate → never poked. The discriminator was
wrong: a labeled dropdown button is wide-but-SHORT; a content tile is large in
BOTH dimensions and wraps a link/image.
- **Fix** (`contentScript.js` `candidateHint`): the tile-guard now keys on
  HEIGHT + wrapping nav content (`wrapsNav && height>80`), not width. Added a
  **`labeled-icon`** hint: a `button`/`[role=button]`/`summary`/`[role=tab]`
  with an icon child and a short (≤24 char) label — the classic "Label ▾"
  dropdown pattern — qualifies even when the chevron `<svg>` has no telltale
  class. (Result tiles, large + wrapping `a`/`img`, stay excluded; navigation
  is independently blocked by the v2.74.370/372 guards.)

**#1 — carousels are depth (no exclusion).** Confirmed the earlier "false
positive" framing was wrong: advancing a carousel reveals more selectable items
that are otherwise unreachable. No carousel/slider filter was added; the planner
prompt now explicitly lists carousels/sliders as worth poking.

**Planner under-picked (1 of 34).** Prompt now: "USE THE BUDGET … err toward
INCLUDING (poking is safe)"; documents the `labeled-icon` hint with "ALWAYS
include" for "Label ▾" buttons; lists carousels among preferred targets; trims
the skip-list (play/pause cosmetic, not whole categories).

**Touched.** `ContentScripts/contentScript.js` (height-based tile guard +
labeled-icon hint), `Services/AnthropicService.js` (planner prompt), `manifest.json`.

---

## v2.74.374 — pageStructure: generalize candidacy — broad net + vision planner (stop recognizing affordances by heuristic)

**Date:** 2026-05-23
**Decision by:** user ("we are designing for this specific page … how is any of
this generalizable? is the heuristic the best approach for candidates?").

**The problem with the heuristic gate.** Candidacy was deciding "is this a
disclosure control?" by recognizing affordances — chevron class regexes, icon
shape, size thresholds, glyph matching. That's brittle by construction: it
whack-a-moles per site, and the class/keyword matching is *dead on obfuscated
sites* (pixabay's own classes — `button--af32y`, `prevButton--iYnGM` — matched
no regex; the catches came from structural guesses). "Does activating this
reveal hidden content?" is **not knowable statically** — only poke→observe knows.

**The reframe (separate the three jobs).**
- **Recall** — a dumb, broad enumerator (not affordance-recognition).
- **Precision** — the **LLM planner WITH the screenshot** (vision sees a chevron
  regardless of class; this is where generalization comes from).
- **Truth** — poke→observe→diff (already deterministic + general).

**Changes (`contentScript.js`).**
- **Candidacy = `isSafeToClick(el) && !looksLikeContentTile(el)`** — safe to
  click, plausibly interactive, not a big link/image-wrapping content tile. No
  chevron/size/glyph in the GATE.
- `CANDIDATE_SEL` widened to a recall net: roles (button/menuitem/tab/treeitem),
  `aria-expanded/haspopup/controls`, `data-*` toggles, `[tabindex]:not(-1)`, and
  common clickable class patterns; cursor:pointer confirmed via `isSafeToClick`.
- `candidateHint` is now **pure metadata** (never null) — classifies the
  affordance for the planner (`labeled-icon`/`icon`/`arrow-glyph`/`haspopup`/
  `menuitem`/…/`clickable`), but doesn't gate.
- **`pokeOpen` now hovers first** (pointerover/mouseover/enter) before the
  click sequence — hover-opened mega-menus/nav dropdowns would otherwise never
  reveal; restore fires mouseout/leave too. (A real generalization gap, not a
  pixabay quirk.)
- Enumerate cap 80 → 120 (broad net produces more; planner prunes).

**Planner prompt (`AnthropicService.js`).** Reframed: the candidate list is a
deliberately BROAD net (many irrelevant); the planner is the precision filter,
and **the screenshot is its strongest signal** — pick anything that visually
looks like a menu/▾/tab regardless of hint (hints come from imperfect markup);
`clickable` hint = judge from the screenshot. Candidate slice 80 → 120.

**Residual limits (documented, not fixed):** event-delegated/signalless
controls (no role/cursor) still escape the net; very dense pages can exceed the
120 cap; the planner is one model call (recall/budget tradeoff, not a
correctness one — observe still gates truth).

**Touched.** `ContentScripts/contentScript.js` (broad candidacy + hover poke +
caps), `Services/AnthropicService.js` (planner prompt + slice), `manifest.json`.

---

## v2.74.375 — pageStructure: close modals after poking them (don't leave a login dialog open)

**Date:** 2026-05-23
**Reported by:** user ("a log-in popup is triggered (expected and good) but never
closed — remains open after exploration").

**Cause.** A poke that opens a MODAL (login, etc.) is a valid reveal, but the
old restore only re-clicked the opener + dispatched a document-level Escape.
Neither dismisses a modal: re-clicking "Log in" doesn't close it, and a
focus-trapped dialog's Escape listener is bound to the dialog/focused element,
not `document`. So the modal stayed open — blocking later pokes and the
propose-time screenshot.

**Fix — deliberate, escalating close (`contentScript.js`).** Per control, until
the revealed UI is gone:
1. **Toggle** → re-click the opener (only for genuine toggles: aria-expanded
   true / haspopup / summary / tab / data-state).
2. **Modal** → locate the dialog among the revealed nodes (`modalScopeOf`:
   `[role=dialog|alertdialog]`/`[aria-modal]`, else the largest revealed box)
   and click its close affordance (`findCloseControl`: `aria-label*=close`,
   `[data-dismiss]`, `.close`, or a button whose text is ×/✕/"Close"), scoped to
   the dialog so we don't click stray ×'s.
3. **Escape** dispatched on the FOCUSED element + the dialog + document (covers
   modal-bound listeners), plus mouseout/leave for hover menus.
4. **Backdrop** click (`[class*=backdrop|overlay|scrim]`) as last resort.
Plus a **final safety net** after the loop: up to 2 passes that close any
remaining visible `[role=dialog]`/`[aria-modal]` (close-control + Escape), so a
lingering modal from the last poke can't survive the sweep.

**Touched.** `ContentScripts/contentScript.js` (close machinery + escalating
restore + post-loop cleanup), `manifest.json`.

---

## v2.74.376 — pageStructure: only "restore" OVERLAYS; actually close the (class-based) login modal

**Date:** 2026-05-23
**Reported by:** user log — every control logged "restore failed (left open)",
incl. carousel arrows + Collections/Playlists tabs; the Log-in modal really did
stay open.

**Two issues.**
1. **In-place reveals were treated as needing restore.** Advancing a carousel
   (c2/c3) or switching a Collections/Playlists tab (c4/c5) is the depth we
   WANT — there's nothing to "restore", and re-clicking a tab/arrow won't undo
   it. They were falsely logged as restore failures.
2. **The modal close failed** because pixabay's login modal isn't
   `[role=dialog]`/`[aria-modal]` — it's a class-based `<div>`, so the old
   `modalScopeOf` couldn't find it and the close-button search was mis-scoped.

**Fix (`contentScript.js`).**
- **Classify reveal as OVERLAY vs IN-PLACE** (`isOverlayReveal`/`isOverlayEl`):
  overlay = a dialog/menu/listbox/tooltip role, OR a `position:fixed` ancestor
  (modals), OR `position:absolute` with `z-index > 10` (dropdowns/portals).
  Carousels (absolute, low z) and tab panels (in flow) are IN-PLACE → marked
  `restored:true`, no close attempt, no failure log. Only overlays are closed.
- **Find the close control among the REVEALED nodes** first (the × is usually a
  revealed button — `isCloseControl`), then within the overlay host
  (`overlayHostOf`: nearest dialog/`[class*=modal|dialog|popup|overlay]`),
  before Escape (focused element + host + document) and backdrop click. Works
  for class-based modals with no ARIA.
- **Final safety net** broadened to class-based overlays:
  `[role=dialog|alertdialog]`,`[aria-modal]`,`[class*=modal|dialog|popup|lightbox]`
  that are visible AND sizable (area > 50000, so a `.modal-trigger` button isn't
  mistaken for one); 3 passes of close-control + Escape + backdrop click.
- Per-control `ctl.overlay` recorded; "restore failed" now only logged for
  overlays. Removed the dead `modalScopeOf`.

**Touched.** `ContentScripts/contentScript.js` (overlay classification + close
search over revealed nodes + class-based final cleanup), `manifest.json`.

---

## v2.74.377 — pageStructure: deterministic bottom-to-top sweep, no budget, planner off by default

**Date:** 2026-05-23
**Decision by:** user ("re-running explore no longer clicks Login/Join
consistently … can the plan be better organized? start from the top and
sequentially poke + verify + scroll" → chose **bottom-to-top, deterministic, no
budget**).

**Why.** The plan was an LLM call (`planPageExploration`) picking ≤budget(12) of
the broad candidate set; with ~34+ candidates its picks varied run-to-run, so
Login/Join (hence the login modal) were inconsistently captured. The candidacy
was stable — the *selection* was a lottery.

**Change — deterministic spatial sweep.**
- **No LLM planner by default.** `EXPLORE_PAGE_STRUCTURE` `usePlanner` now
  defaults to **false**; the sidepanel sends `usePlanner:false` (no `maxPokes`).
  The background skips the enumerate + planner passes and runs ONE sweep. The
  planner remains opt-in (`usePlanner:true`) — enumerate → plan → sweep — and is
  only used to prune when candidates exceed the budget.
- **No budget.** Content-script `maxPokes` is now `Infinity` unless a positive
  value is passed (then clamped ≤1000 as a runaway guard). Every candidate is
  poked.
- **Bottom-to-top order.** Before the poke loop, candidates are sorted by
  absolute document Y **descending** (snapshotted with scroll restored to top).
  The sweep starts at the footer and works UP to the header, so the top-nav
  modal-openers (Login/Join) are poked LAST — any modal interference lands at
  the very end of the sweep, not mid-page. Deterministic + exhaustive; the login
  modal is captured every run.

**Tradeoff.** Poking all candidates is slower (≈20–30s on a busy page); the
"Exploring…" state is cancellable. The deterministic sweep is fully predictable
and needs no model call.

**Touched.** `ContentScripts/contentScript.js` (unlimited maxPokes + bottom-to-top
sort), `background.js` (planner opt-in, default deterministic single sweep),
`Sidepanel/modes/locale-capture.js` (request `usePlanner:false`), `manifest.json`.

---

## v2.74.378 — pageStructure: BANDED WALK (per-band LLM planning), revert the no-planner sweep

**Date:** 2026-05-23
**Reported by:** user — v2.74.377 (no planner, poke everything) "entirely wrong
and predictably broke the depth explorer" by reopening the navigation problem.
Clarified intent: scroll to bottom → screenshot + candidates → LLM plan → poke
→ scroll up, repeat. The planner was right; the ONE-SHOT was the problem.

**Why no-planner broke it.** Poking every broad-net candidate (incl. div-tiles
with JS click handlers) navigated despite the guards. The planner's whole value
is choosing NOT to poke navigators — dropping it removed that protection.

**Banded walk (background-orchestrated; only the background can screenshot
between content-script calls).** `explorePageStructure` is now PHASE-based:
- **metrics** — scroll to the bottom (trigger lazy content), report
  `scrollHeight`/viewport so the background can compute band stops.
- **band(scrollY)** — scroll to a band and enumerate the candidates + surface
  VISIBLE there (no poking).
- **poke(selectors, cidStart)** — poke ONLY the planned selectors for this band
  (resolve + scrollIntoView each), observe each reveal, restore overlays; nav
  guard installed for the duration; returns the band's controls + `aborted`.
- **cleanup** — close any leftover overlay, scroll to top.

**Background loop (`EXPLORE_PAGE_STRUCTURE`):** metrics → bands BOTTOM-TO-TOP
(`y` from `scrollHeight-vh` down to 0, step 0.85·vh) → for each band: enumerate
→ `captureVisibleTab` (screenshot of THIS band) → `planPageExploration`
(candidates+matching screenshot, `bandBudget` default 8) → poke the planned
(deduped across bands via `seenCand`/`seenPoked`). Stops if a poke really
navigates. Assembles the artifact (surface, controls, stats, driftHash) from the
per-band results and caches it. Per-band planning = piecemeal, with a screenshot
that actually matches the candidates — fixes the one-shot's poor grounding AND
the Login/Join inconsistency.

**Sidepanel** now sends just `{ tabId, groundId }` (banded always plans).

**Tradeoff.** One planner call per non-empty band (≈7–8 on a tall page) — more
LLM calls + latency than one-shot, but far better grounded and safe (only
planned controls poked + nav guard). "Exploring…" stays cancellable.

**Touched.** `ContentScripts/contentScript.js` (phase dispatch: metrics/band/
poke/cleanup; reuses the per-control poke→observe→restore body), `background.js`
(banded orchestration + artifact assembly), `Sidepanel/modes/locale-capture.js`
(payload), `manifest.json`.

---

## v2.74.379 — pageStructure: carry-forward candidate coverage + background navigation recovery

**Date:** 2026-05-23
**Reported by:** user — banded walk still "sometimes failing to capture every
reveal and sometimes opening navigation pages." Two distinct root causes, two
fixes (both in `background.js` + a planner-prompt nudge).

**1. Missed reveals — cross-band dedup burned skipped candidates.** The band
loop deduped candidates on ENUMERATION (`seenCand`): a control enumerated in an
early (overlapping) band but NOT chosen by that band's planner was added to
`seenCand` and then excluded from every later band — so "skipped once = never
poked." **Fix:** dedup on what's been **poked** (`seenPoked`), not enumerated.
A candidate the planner passes over reappears in the next overlapping band and
gets another chance when it's more central / better framed in the screenshot.
(`seenCand` is kept only for the candidate count.)

**2. Opening pages — `location.href=` can't be guarded in-page.** The nav guard
blocks anchor clicks, `pushState`/`replaceState`, `window.open`,
`location.assign`/`replace` — but NOT a direct `location.href = …` /
`window.location = …` assignment (the `Location` href setter is unforgeable).
So an occasional planner mispick onto a JS-navigating control still left the
page, aborting the whole sweep. **Fix — recover in the background:**
`ensureOnPage()` runs at the top of each band; if the tab URL no longer matches
`pageUrl` it navigates back (`chrome.tabs.update`), waits for load, re-injects,
and the loop continues the REMAINING bands. The navigator is already in
`seenPoked` (marked before poking) so it's never re-poked → no nav loop. Capped
at 3 recoveries; a poke message that rejects (frame torn down) is treated the
same way. The sweep no longer aborts on navigation — it heals and finishes.

**Planner nudge:** added a rule to SKIP controls that navigate to another page
(logo/home, breadcrumbs, "see more / view all", category links, pagination) and
prefer in-place disclosure — a sign-in MODAL is good, a sign-in PAGE is not.

**Touched.** `background.js` (poke-dedup + ensureOnPage/waitForTabLoad recovery),
`Services/AnthropicService.js` (planner skip-navigators rule), `manifest.json`.

---

## v2.74.380 — pageStructure: true viewport banding, selector dedup, last-band restore

**Date:** 2026-05-24
**Reported by:** user log — banding worked (All images / Explore / Upload / Log
in / Join modals all captured) but exposed three bugs: every band reported the
SAME 85 candidates, "Go to slide 1/2" + "Collections" got poked twice with
identical selectors, and a poke in the LAST band (y=0) navigated to a photo page
and the tab was left there.

**1. Banding wasn't viewport-scoped.** `visible()` is true for off-screen-but-
rendered elements (their rect still has size), so each `band` phase enumerated
the WHOLE page (85 candidates) — the per-band screenshot didn't match the list,
the planner ground through 85 each call (8–10s), and it could pick off-screen
navigators (the y=0 → photo-page nav). **Fix:** added an `inViewport(el)` gate
(rect intersects the current viewport) to the band enumeration for BOTH
candidates and surface. Now each band yields only what's actually on screen, the
screenshot matches, planner calls are small/fast, and off-screen mispicks are
impossible.

**2. Non-unique selectors poked twice.** computeUniqueSelector emitted stateful
`.active--…` selectors, so two distinct controls ("Go to slide 1" / "2",
"Collections" ×2) shared one selector and the second poke hit the wrong element
(`no-change`). **Fix:** the band phase now dedupes candidates by selector
(`selSeen`) and drops empty ones — one poke per unique selector.

**3. Last-band navigation stranded the tab.** Recovery (`ensureOnPage`) ran only
at the TOP of each band; a nav in the final band (y=0) had no next band, so the
user's tab was left on the navigated-to page and cleanup ran there. **Fix:** an
UNconditional restore after the loop (bypasses the 3-recovery cap) — if the tab
URL ≠ `pageUrl`, navigate back, wait for load, re-inject, then cleanup.

**Also:** band surface rects are now ABSOLUTE document coords (was viewport-
relative), so the background's cross-band surface dedup (`role|label|x,y`) is
stable and no longer duplicates the same element seen in overlapping bands.

**Touched.** `ContentScripts/contentScript.js` (inViewport gate + selector dedup
+ absolute surface rects), `background.js` (post-loop unconditional restore),
`manifest.json`.

---

## v2.74.381 — Reveal-aware Resolve: poke the trigger to resolve roles in hidden layers

**Date:** 2026-05-24
**Decision by:** user — depth-aware proposals now emit roles like
"google-signin (revealed after clicking the login trigger)", but Resolve only
filled the visible trigger because the others are in a closed modal. Chose
**Both** (structured links + artifact fallback).

**Problem.** Resolve + its verification both ran against the STATIC DOM, so a
role inside a closed modal could neither be selected by Claude (not in the
snapshot) nor verified (PROBE_SELECTOR → 0). Only `login-trigger` resolved.

**Fix — resolve hidden roles in the REVEALED state.**
- **Propose (`AnthropicService.proposePerspectives`):** roles gain optional
  `hidden:true` + `revealedBy:<role>` (the trigger role, listed before its
  children). Prompt + example + sanitizer updated; dangling `revealedBy` refs
  are dropped.
- **Content script:** two standalone messages — `POKE_AND_SNAPSHOT {selector}`
  (full pointer+click on the trigger, wait, return a rich DOM snapshot of the
  revealed state, LEAVE it open) and `CLOSE_OVERLAYS` (close-control → Escape →
  backdrop, 3 passes).
- **Background `RESOLVE_REVEALED_ROLES`:** resolve the trigger selector
  (structured: the already-resolved trigger role's selector; else match the
  cached pageStructure artifact by label/overlay) → `POKE_AND_SNAPSHOT` →
  screenshot the open state → `resolveRoles` against the revealed DOM → verify
  each selector via `PROBE_SELECTOR` WHILE OPEN → `CLOSE_OVERLAYS`.
- **Sidepanel `_runResolve`:** after the normal pass, group still-unfilled
  HIDDEN roles by `revealedBy`, call the reveal flow per group, and fill the
  successes as landmarks carrying `hidden:true` + `revealedBy` + `triggerSelector`
  and a `verified{revealState:true}` (so static re-verify won't later flag them).
  Role checklist shows a `⤿ via <trigger>` badge for hidden roles.

**Result:** for "I'd like to login using Google" on pixabay, Resolve fills
`login-trigger` (visible), then opens the modal and resolves + verifies
`google-signin` and `alternative-signin-options` against the revealed DOM, then
closes the modal.

**Touched.** `Services/AnthropicService.js` (role schema + prompt),
`ContentScripts/contentScript.js` (POKE_AND_SNAPSHOT + CLOSE_OVERLAYS),
`background.js` (RESOLVE_REVEALED_ROLES), `Sidepanel/modes/locale-capture.js`
(reveal-aware pass + hidden badge), `assets/sidepanel.css`, `manifest.json`.

---

## v2.74.382 — Propose prompt: "depth is not downstream"

**Date:** 2026-05-24
**Decision by:** user ("the propose prompt should note page structure depth
doesn't equal downstream — downstream means other pages").

Added an explicit rule to `proposePerspectives`: content revealed by an
interaction on the SAME page (dropdown / modal / expanded panel / accordion /
tab — URL unchanged) is in-page **DEPTH** → `onPage:true`, modeled with
hidden/revealedBy roles. **`onPage:false` (downstream)** means a DIFFERENT page
you NAVIGATE to (URL changes). Spelled out the contrast — a login MODAL is depth
(onPage:true); a separate login PAGE is downstream — so the model stops marking
modal/dropdown content as downstream.

**Touched.** `Services/AnthropicService.js` (prompt), `manifest.json`.

---

## v2.74.383 — Resolve/propose/auto-discover: DOM_SNAPSHOT_RICH from the TOP frame (fix empty-DOM abstentions)

**Date:** 2026-05-24
**Reported by:** user — Resolve abstained on EVERY role with "sanitized DOM is
completely empty (only `<body url="blank" />`)".

**Cause.** Same wrong-frame bug fixed for Explore in v2.74.372, but in the older
handlers: `RESOLVE_LOCALE_ROLES`, `PROPOSE_LOCALE_PERSPECTIVES`, and
`AUTO_DISCOVER_LOCALE` all sent `DOM_SNAPSHOT_RICH` with NO `frameId`, so
`chrome.tabs.sendMessage` fanned out to every frame and an empty `about:blank`
iframe could answer first. Claude then resolved against an empty DOM →
everything abstained (the `<body url="blank">` is the iframe's body). Intermittent
(whichever frame replied first), which is why earlier runs sometimes worked.

**Fix.** All three `DOM_SNAPSHOT_RICH` calls now pass `{ frameId: 0 }` (top
frame only) — deterministic, real page DOM. (The reveal-aware resolve added in
.381 already used `frameId:0` for POKE_AND_SNAPSHOT/PROBE_SELECTOR.)

**Touched.** `background.js` (3× DOM_SNAPSHOT_RICH → frameId:0), `manifest.json`.

---

## v2.74.384 — Reveal-aware resolve: poll for the reveal + observability

**Date:** 2026-05-24
**Reported by:** user — after the frameId fix, `login-trigger` resolves but the
hidden modal roles still abstain with "modal not present in current DOM" (the
reveal pass isn't capturing the modal open).

**Changes (to diagnose + harden, since the failure point wasn't observable).**
- **`POKE_AND_SNAPSHOT` now polls for the reveal** instead of a fixed 550 ms
  wait: snapshots the visible interactive/dialog set BEFORE the poke, then polls
  up to ~2 s, stopping as soon as new visible elements appear (handles modals
  that animate or fetch content). Returns `opened` (count of newly-visible
  elements) and `navigated` (true if the trigger left the page). Adds
  pointerenter/mouseenter to the poke.
- **`RESOLVE_REVEALED_ROLES` logging:** the SW console now shows the trigger
  selector, `opened` count + snapshot size, a WARN when the poke revealed
  nothing (trigger likely isn't the real opener), each role's selector +
  matched-count, and the final verified tally — so the exact failure point
  (didn't open / opened-but-not-serialized / resolved-but-unverified) is visible.
- Aborts cleanly if the trigger navigates instead of revealing.

**Diagnostic, not yet a root-cause fix** — the SW log from a re-run will show
whether the modal opened (`opened > 0`) and, if so, why the roles still didn't
resolve/verify.

**Touched.** `ContentScripts/contentScript.js` (pokeAndSnapshot poll + opened/
navigated), `background.js` (RESOLVE_REVEALED_ROLES logging), `manifest.json`.

---

## v2.74.385 — Fewer roles + reuse Explore's verified selectors in Resolve

**Date:** 2026-05-24
**Reported by:** user log — propose returned 6 roles for "sign in using Google",
and `login-trigger` resolved to a generic `button[type='button']:nth-of-type(2)`
(matched 1, "verified" — but the wrong button), so the reveal opened the wrong
thing and the hidden roles got 0/5.

**Root causes.** (1) Propose over-produced roles. (2) On a hashed-class page the
"Log in" button has no stable CSS hook (its identity is its TEXT, which CSS
can't target), so Resolve fell back to a meaningless positional selector that
"matches one element" — a false positive verification.

**Fixes.**
- **Propose — MINIMAL roles.** New prompt rule: propose the FEWEST roles the
  intent needs (the elements acted on + the trigger to reach them), never enumerate
  a modal's every field. "sign in with Google" → login-trigger + google-signin.
- **Resolve — reuse verified selectors.** `resolveRoles` gains a `knownSelectors`
  param; the background flattens the cached **pageStructure** artifact (every
  control's verified selector + each control's revealed-children selectors, with
  labels + `via`) and passes it to BOTH the main resolve and the reveal resolve.
  Prompt: "REUSE verbatim when a role matches a KNOWN VERIFIED SELECTOR." So
  `login-trigger` reuses the button Explore PROVED opens the modal (not a
  positional guess) → the reveal pokes the right button → the modal's children
  (google-signin, …) reuse their verified selectors too.
- **Resolve — anti-positional rule.** A bare positional selector on a generic tag
  is flagged as almost-always-wrong; if no stable hook exists, scope it under a
  semantic ancestor, and for TRIGGER roles prefer abstaining over a positional
  guess (a wrong trigger opens the wrong thing).

**Net:** the verified trigger selector flows main-resolve → reveal-poke →
reveal-resolve, so the right modal opens and its roles resolve against verified
selectors. Requires a pageStructure artifact (built by "+ Locale" Explore); the
prompt rules are the fallback when none exists.

**Touched.** `Services/AnthropicService.js` (minimal-roles + knownSelectors +
anti-positional prompt), `background.js` (`_knownSelectorsForUrl` + wired into
both resolve handlers), `manifest.json`.

---

## v2.74.386 — Log known-selector reuse (diagnose "verified selector not reused")

**Date:** 2026-05-24
**Reported by:** user — `login-trigger` resolved to `button:has(div[role='img']
[aria-label='ChevronDown']):nth-of-type(2)` (matched 0; it's a CHEVRON dropdown
button, not Log in) — "how is this possible when explore verified the actual
selector?"

**Diagnosis.** That guess can only happen if resolve had no verified selector to
reuse — i.e. `_knownSelectorsForUrl` returned nothing for this page. The cached
pageStructure artifact either doesn't exist for this URL, is stale, or (because
the banded sweep's per-band planner is non-deterministic) didn't capture the
"Log in" control in the run that produced the current cache. v2.74.385 wired the
reuse but can't help when the artifact lacks the control.

**This change (observability):** both resolve handlers now log the
known-selector count + sample labels (`RESOLVE_LOCALE_ROLES: N known verified
selector(s) … "Log in", …` or `(none — page not explored …)`). A re-run will say
definitively whether the artifact fed a "Log in" selector — if N=0 the artifact
is the gap (Re-explore so it's captured); if N>0 yet still mis-resolved, the
prompt reuse needs forcing.

**Touched.** `background.js` (knownSelectors count logging in both resolve
handlers), `manifest.json`.

---

## v2.74.387 — knownSelectors: per-control cap so the giant nav menu stops crowding out the Log-in selector

**Date:** 2026-05-24
**Reported by:** user — log confirmed `RESOLVE_LOCALE_ROLES: 60 known verified
selector(s) … "All images", "Explore", …` yet `login-trigger` STILL resolved to
`button:nth-of-type(2)`. Why, when the artifact has the verified "Log in"
selector?

**Root cause (two truncations).** The artifact's "Log in" control is `c5`, but
`c0` "All images" (13 children) and especially `c1` "Explore" (a **42-link
mega-menu**) exhausted the flat 60-cap in `_knownSelectorsForUrl` BEFORE reaching
`c5` — so the verified login/modal selectors were never in the list. And
`resolveRoles` only rendered `slice(0, 40)`, cutting it further to pure nav
noise. The verified selectors existed but never reached the model.

**Fix.**
- `_knownSelectorsForUrl`: cap revealed children **per control** (10) with a
  higher total (140), so a single mega-menu can't dominate — every control
  (incl. "Log in" + its modal's Google/Facebook/username/password/close) gets
  represented.
- `resolveRoles`: render up to 140 known selectors (was 40).

Now `login-trigger` reuses the verified `div.desktopOnly--WxB0K:nth-of-type(2) >
button…` (proven to open the modal) instead of a positional guess, and the
modal's child selectors are available for the hidden roles.

**Known follow-up (not this fix):** "Sign up with Google" lives in the modal's
SIGN-UP tab (captured via the Upload/Join openers), while `login-trigger` opens
the LOG-IN tab — so google-signin may still need the modal's tab switched. The
known-selector reuse + present-but-hidden PROBE may cover it; if not, a
tab-aware reveal is the next step.

**Touched.** `background.js` (`_knownSelectorsForUrl` per-control cap),
`Services/AnthropicService.js` (render 40→140), `manifest.json`.

---

## v2.74.388 — Reveal snapshot: wait for the modal to FULLY render (poll-until-stable)

**Date:** 2026-05-24
**Reported by:** user — reveal-aware resolve "works much better but fails on the
first attempt, likely slow rendering — need a delay after the trigger click /
modal visible before DOM capture."

**Cause.** `pokeAndSnapshot` broke out of its reveal poll on the FIRST poll where
any new visible element appeared — but a modal renders its container/backdrop
first (1 element) and fills in the form/buttons over the next few frames. So the
snapshot caught a half-built modal and the child roles abstained; a retry
happened to catch it rendered.

**Fix.** Poll until the count of newly-visible elements **stabilizes** (held
steady for 2 consecutive 200 ms polls = fully rendered) rather than first
appearance, then a **final 300 ms settle** before snapshotting, and recount
`opened` after settle. Up to ~3.4 s. So the snapshot (and the child resolve +
verify that run against it) see the complete modal.

**Touched.** `ContentScripts/contentScript.js` (pokeAndSnapshot poll-until-stable
+ settle), `manifest.json`.

---

## v2.74.389 — Converge propose→resolve with "Structure with Claude": seed the 🧬 step with Resolve's roles + verified triggers

**Date:** 2026-05-24
**Decision by:** user — "propose→resolve should mirror Structure-with-Claude;
struct-with-claude is the user-authored path but they should produce the same
rich structure." Chose **"Seed the 🧬 button"** (structuring stays an explicit
click; Resolve feeds it priors).

**Context.** The two paths only differ in HOW landmarks get picked (LLM intent→
resolve vs. user-authored picks); the structuring job (the typed LandmarkNode
tree) should be identical. But propose→resolve's role + verified trigger
knowledge (`roleFill`/`roleMult`/`hidden`/`revealedBy`/`triggerSelector`) was
dropped before structuring, so `proposeLocaleStructure` re-inferred everything
from alias/description — and hidden modal landmarks (no UID) were excluded
entirely.

**Changes.**
- **Hidden landmarks get a local UID** at resolve time (`lmk_local_…`) so they're
  structurable now (their element only exists with the modal open, so a profile
  UID via static INSPECT isn't possible; save back-fills the same way).
- **`onProposeStructure` passes priors**: each landmark now carries its GIVEN
  `role`/`multiplicity`/`hidden` and a `revealedByRef` (the trigger landmark's
  UID, mapped from the `revealedBy` role name via a roleFill→uid index).
- **`proposeLocaleStructure` uses them**: renders the priors per landmark and a
  new rule — use GIVEN role/multiplicity verbatim; for a `revealedBy: X`
  landmark, add it to X's `triggers`, mark it conditional with a
  presenceCondition, and group all co-revealed landmarks under ONE virtual
  container (the revealed modal/menu) inside X's `contains`. So the structure
  reflects the VERIFIED interaction depth instead of re-guessing it.

**Net:** clicking 🧬 after propose→resolve yields the same rich, depth-accurate
LandmarkNode tree as the user-authored path — now grounded in what Resolve
actually proved (correct triggers + a virtual modal container), not inference.

**Touched.** `Sidepanel/modes/locale-capture.js` (hidden-landmark uid +
onProposeStructure priors), `Services/AnthropicService.js`
(proposeLocaleStructure priors + prompt rule), `manifest.json`.

---

## v2.74.390 — Auto-profile resolved landmarks (Resolve now fills description/ops/pitfalls like Pick→Claude)

**Date:** 2026-05-24
**Reported by:** user — auto-created (resolved) landmarks have empty Description
+ all Claude-authored fields (operationsCommon, pitfalls, expectedContent,
aliases). Chose **"Auto-profile during Resolve."**

**Cause.** The Pick→Claude path runs `generateLandmarkProfile` after each pick to
fill the rich profile; Resolve only set alias/selector/role + verified
capabilities, so those fields stayed empty.

**Fix.**
- New `_profileResolvedLandmark(idx, presetProfile?, presetReport?)`: INSPECT the
  selector (or use a preset report), call `GENERATE_LANDMARK_PROFILE_BG`, and
  apply ONLY the authored metadata (description / aliases / operationsCommon /
  pitfalls / expectedContent / effect / interactionPattern / profileConfidence) —
  keeps Resolve's selector + verified + role untouched.
- **Visible roles:** after the resolve loop, the newly-filled landmarks are
  profiled in PARALLEL (`Promise.all`) so N landmarks ≈ one call's latency; the
  "⏳ Resolving…" state holds during it.
- **Hidden (modal) roles:** can't be INSPECTed once the modal closes, so
  `RESOLVE_REVEALED_ROLES` now verifies via INSPECT (instead of PROBE) WHILE the
  modal is open and returns the report (`r.inspect`); the reveal pass profiles
  the hidden landmark from that report (the profile call is text-based — no live
  element needed).

**Net:** resolved landmarks (visible and hidden) come out with the same
Claude-authored profile fields as manually Pick→Claude'd ones.

**Touched.** `Sidepanel/modes/locale-capture.js` (`_profileResolvedLandmark` +
parallel visible profiling + reveal-pass profiling), `background.js`
(RESOLVE_REVEALED_ROLES INSPECT + return report), `manifest.json`.

---

## v2.74.391 — Auto-structure after Resolve

**Date:** 2026-05-24
**Decision by:** user ("auto struct after resolve" — superseding the earlier
"seed the 🧬 button" choice).

**Change.** `_runResolve` now calls `onProposeStructure()` automatically once
Resolve has filled the roles + profiled them — so propose→resolve ends with the
full LandmarkNode tree (contains/triggers/roles/virtual containers + overlays),
no manual 🧬 click. Gated on `filled > 0` and ≥2 uid'd landmarks (so it won't
fire on an empty/insufficient resolve, and won't hit onProposeStructure's
"needs ≥2" warning). On a later resolve/retry it refines the prior tree (the
existing refine path). Structuring is seeded with the v2.74.389 role + verified-
trigger priors, so the auto tree matches the verified interaction depth.

**Touched.** `Sidepanel/modes/locale-capture.js` (auto-call onProposeStructure
at the end of _runResolve), `manifest.json`.

---

## v2.74.392 — Remove the legacy auto-suggested-landmarks feature; "+ Locale" opens a blank draft

**Date:** 2026-05-24
**Decision by:** user ("remove legacy auto suggested landmarks + locale button no
longer suggests landmarks").

**Context.** The old path: "+ Locale" (sidepanel) → AUTO_DISCOVER_LOCALE →
`suggestLocale` (Claude proposes name + {alias,selector} landmarks) → locale-
capture pre-filled, with a Rediscover button to re-run. That's fully superseded
by the description-first propose → resolve → auto-profile → auto-structure flow,
so it's removed.

**Removed.**
- **ground-view:** "+ Locale" button switched from `locale-auto` to `locale`
  (opens a BLANK draft); the `locale-auto` dispatch branch + `_autoDiscoverLocale`
  deleted. (Studio's "+ Locale" already opened blank.)
- **locale-capture:** the Rediscover button (markup + `locRediscoverBtn` ref +
  wiring) + `onRediscoverLandmarks`; the prefilled `{alias,selector}` fresh-
  suggestion hydration branch (edit-mode `landmarkRefs` + structured-rehydration
  paths untouched).
- **background:** the `AUTO_DISCOVER_LOCALE` handler + the `localeAutoDiscovery
  Cache` helpers (`LOCALE_DISCOVERY_CACHE_KEY` / `_read`/`_writeLocaleDiscovery
  Cache`). KEPT `_normalizeUrlForLocaleCache` (pageStructure cache + resolve
  knownSelectors reuse it).
- **AnthropicService:** the `suggestLocale` method + its `getPromptTexts` entry.
- **studio:** the `suggestLocale` Prompts-tab list entry.

**Net.** "+ Locale" everywhere opens a blank locale-capture draft; landmark
authoring is the description-first LLM flow (or manual Pick→Claude). No code
references to the removed symbols remain (verified by grep).

**Touched.** `Sidepanel/modes/ground-view.js`, `Sidepanel/modes/locale-capture.js`,
`background.js`, `Services/AnthropicService.js`, `studio.js`, `manifest.json`.

---

## v2.74.393 — Intent grounding: cached page affordances + synthetic intent (editable proposal)

**Date:** 2026-05-24
**Decision by:** user ("Let's now focus on the locale's intent the main driver.
1. rename description field → intent. 2. use the LLM to enrich the user's intent:
a detailed page description of what goals are achievable, then a synthetic intent
that redescribes the user's intent in page terms while preserving its goal, which
then seeds propose→resolve"). Chosen via AskUserQuestion: **Architecture C —
cached affordance + synth** and **Apply mode: editable proposal**.

**Context.** The locale's free-text "description" is the main driver of the
propose→resolve pipeline (it seeds `proposePerspectives`). But a raw user intent
is unbounded — it can be vague, mis-scoped, or describe goals the page can't
actually serve. The goal: enrich the intent against what the page can really do,
without (a) paying to re-derive page understanding on every intent edit, (b)
silently overwriting the author's words, or (c) warping their goal.

**What we did.**
- **Rename (UI only).** The "Description" field is relabeled **Intent**
  (placeholder "What do you want to accomplish on this kind of page?"; propose
  intro updated). The storage key stays `description` (no migration) — it remains
  the seed `proposePerspectives` consumes.
- **Intent-independent affordance, cached on the artifact.** New
  `AnthropicService.describePageAffordances({url,title,surface,controls,
  screenshot})` returns plain text — "what goals can be accomplished on this kind
  of page" — derived from the explored structure (NOT from any intent). It is
  generated ONCE at the end of `EXPLORE_PAGE_STRUCTURE` and stored on the artifact
  as `structure.affordances`, so it is cached per (ground, normalized URL) for the
  artifact's 7-day TTL. No per-intent cost.
- **Per-intent grounding (cheap).** New `AnthropicService.groundIntent(
  {userIntent,affordances,url,title})` returns JSON `{groundedIntent, achievable:
  'yes'|'partial'|'no', note}`. It redescribes the user's intent in the page's
  terms while **preserving the goal**, and flags (does not silently fix) a
  goal/page mismatch via `achievable` + `note`. Background `GROUND_INTENT` reads
  the cached `structure.affordances`; if none exists it degrades to a pass-through
  (`{success:true, groundedIntent:intent, achievable:'unknown', note:'Run
  Explore…', hadAffordance:false}`) — NO LLM call when there's nothing to ground
  against.
- **Editable proposal (no silent overwrite).** locale-capture shows a "✨ Ground
  intent in this page" affordance under the Explore row. Clicking it renders a
  proposal card: the grounded intent + an achievability badge
  (yes/partial/no/unknown) + the note + **Use it / Dismiss**. The author's
  original Intent is untouched until they click **Use it**, which writes the
  grounded text into `_locDraft.description` (+ the input) and records provenance
  in `authoringMetadata.description` (`source:'grounded'`, `authoredBy:'llm'`,
  `originalIntent`, `achievable`). Then it seeds Propose as usual.

**Justification.**
- **Cost.** Affordance derivation is the expensive, screenshot-grounded step;
  caching it on the artifact means re-grounding a tweaked intent is one small
  text→JSON call. Editing the intent never re-explores the page.
- **Goal fidelity.** `groundIntent` is instructed to preserve the goal and only
  *flag* a mismatch (`achievable`/`note`) rather than rewrite it into something
  the page supports — the author stays in control of scope.
- **Transparency.** Editable proposal + preserved original + provenance metadata
  means the synthetic intent is a suggestion the author accepts, not a black-box
  mutation.
- **Non-redundancy.** The synthetic intent earns its keep by becoming the saved
  seed that drives propose→resolve; it isn't a throwaway.

**Trade-off accepted.** Grounding quality is only as good as the cached
affordance — if the page wasn't Explored (or the artifact is stale), grounding
degrades to pass-through and the badge reads "? not explored". The author must run
Explore first to get real grounding.

**Reversibility.** Additive. The two AnthropicService methods, the `GROUND_INTENT`
handler, and the locale-capture UI row are self-contained; removing them leaves
the plain free-text Intent field (still keyed `description`) fully functional.

**Touched.** `Services/AnthropicService.js` (`describePageAffordances`,
`groundIntent`), `background.js` (`EXPLORE_PAGE_STRUCTURE` affordance capture,
`GROUND_INTENT` handler), `Sidepanel/modes/locale-capture.js` (Intent rename,
grounding row + handlers), `assets/sidepanel.css` (`.dbg-locale-ground*`),
`manifest.json`.

---

## v2.74.395 — Resolve sees content landmarks: repeating-content-block snapshot pass + class-selector allowance

**Date:** 2026-05-24
**Decision by:** user (reported content roles failing verification — e.g. a
Pixabay `collection-card` resolved to `a[href*='/collections/'] > div` which
matched 0, while the hand-pick `div.layout--JZpqG.column--FuwM5…` worked).
AskUserQuestion: **"Content pass + allow classes"** and **"DOM-first, no scroll"**.

**Observed gap.** Resolve was structurally blind to non-interactive landmarks,
for three compounding reasons:
1. `DOM_SNAPSHOT_RICH` (`handleDomSnapshotRich`) selects elements via a
   CONTROL-centric `SEL` list (`button, input, [role=…], [aria-label],
   [data-testid], [title], img[alt]`, signals). A plain content card
   `<div class="layout--JZpqG…">` with no role/aria/data-testid/title is never
   matched → never in the snapshot. The resolver couldn't see the card at all.
2. The snapshot deliberately strips full `class` attributes ("hashed noise"),
   emitting only state-classes — so even an included element loses the
   CSS-module class that is its only stable handle.
3. `resolveRoles`' prompt told Claude to "AVOID hashed/auto-generated class
   names" — the exact selector type content cards need on CSS-module sites.
   Result: the resolver guessed a child chain off the nearest visible anchor.
   Separately, the Resolve screenshot is a single top-viewport `captureVisibleTab`
   (no scroll), so below-fold repeating grids aren't visible to the visual eval
   either.

**What we did.**
- **Repeating-content-block pass (content script).** New
  `detectRepeatingContentBlocks()`: groups elements by tag + sorted class
  signature, keeps groups that recur ≥3×, filters to "content-like" (block-sized,
  carrying text or an image), and emits each as a `<repeating-block tag count
  has-image selector sample-text />` line whose `selector` (the shared, CSS-escaped
  class signature) is `querySelectorAll`-VERIFIED to match N elements. Capped
  (≤6000 nodes scanned, ≤400 groups checked, ≤12 blocks emitted). `handleDomSnapshotRich`
  gained an opt-in `{ includeContentBlocks }` flag; when set, the blocks are
  PREPENDED to the snapshot (so Resolve's 12k-char slice never truncates them).
  Opt-in keeps the agent-walker's per-turn snapshots control-only (no token bloat).
- **Wiring.** `RESOLVE_LOCALE_ROLES` sends `DOM_SNAPSHOT_RICH` with
  `includeContentBlocks:true`; `pokeAndSnapshot` (the reveal-resolve path) also
  enables it (revealed mega-menus/modals can hold repeating content).
- **Prompt (resolveRoles).** Split the "durable hooks" rule: the AVOID-hashed-
  classes guidance now applies only to INTERACTIVE/CONTROL roles. Added a
  CONTENT/STRUCTURAL roles rule (class-based selectors — including hashed/module
  classes — are correct and expected; do NOT route a card through a clickable
  ancestor's child chain) and a REPEATING CONTENT BLOCKS rule (reuse a listed
  block's verified `selector` verbatim when a "many"/content role matches it).

**Justification.**
- **Root cause, not symptom.** The resolver now SEES content blocks and is
  ALLOWED to select them — fixing both the visibility and the policy gap.
- **Cost-bounded & opt-in.** The pass only runs for Resolve, is hard-capped, and
  reuses the existing snapshot round-trip (no extra messages, no screenshots).
- **Verification-backed.** Each emitted `selector` is already confirmed by
  `querySelectorAll` to match ≥3 elements, and the system still INSPECT-verifies
  the chosen selector — a wrong block is caught, not trusted.
- **DOM-first (no scroll).** Repetition is encoded in the DOM (same class on N
  siblings), so the enriched snapshot — not a costlier full-page screenshot — is
  the authoritative content signal; the single top screenshot stays as context.

**Trade-off accepted.** Hashed/module class selectors are stable within a
deployment but brittle across rebuilds; content-role selectors may need re-resolve
after a site redeploys. Acceptable — it's the same handle a human pick uses, and
re-resolve is one click. Tailwind-style utility-class grids can produce noisier
block candidates; the content-like filter + count ranking + sample-text/has-image
hints keep the right one pickable.

**Reversibility.** Additive + opt-in. Dropping the `includeContentBlocks` flag at
the two call sites reverts Resolve to the prior control-only snapshot; the prompt
rules are independent text.

**Touched.** `ContentScripts/contentScript.js` (`detectRepeatingContentBlocks`,
`handleDomSnapshotRich` opt-in flag, `pokeAndSnapshot`, `DOM_SNAPSHOT_RICH` case),
`background.js` (`RESOLVE_LOCALE_ROLES` flag), `Services/AnthropicService.js`
(`resolveRoles` prompt), `manifest.json`.

---

## v2.74.396 — Resolve Tier-2 VISUAL fallback ("Path C"): LLM locates a region → IoU hit-test → Pick→Claude refine

**Date:** 2026-05-24
**Decision by:** user ("create a third path C — mirrors A in certain areas but
LLM-driven … replace the user as the driver for the pick click event"). After a
design critique, AskUserQuestion chose **Tier-2 fallback of Resolve** (not a
standalone path) and **bounding-box + IoU match** (not single-point
`elementFromPoint`).

**Context.** Two authoring paths existed: **A** = manual Pick→Claude (human click
is ground truth; Claude profiles + may challenge the selector, gated by an IoU
check against the picked rect), and **B** = Resolve-from-roles (`resolveRoles`
returns a selector per role from the DOM + screenshot, one call for all roles;
verified, dropped if wrong). B is blind to landmarks with no DOM handle that are
nonetheless visually obvious. Path C fills that gap by letting the LLM do what a
human does — *look at the page and point* — but only for the roles B couldn't
resolve.

**What we did.**
- **`AnthropicService.locateRoleRegion`** (new): role + description + intent +
  cached page-affordances + the viewport screenshot → JSON `{ found, box:{x1,y1,
  x2,y2} (normalized, screenshot space, top-left origin), confidence, note }`.
  Returns `found:false` (no box) when the role isn't visible in this view — never
  guesses. JSON-via-`#call` (role `resolve` → vision-capable model, op
  `locateRoleRegion`); validates/clamps the box.
- **`locatePick` + `LOCATE_PICK` (content script):** given the normalized box →
  viewport px, hit-test by **IoU against REAL element rects** — sample a 4×4 grid
  of points (`elementsFromPoint`) + their ancestors (≤5 levels), score each
  candidate by `IoU(rect, box)`, skip wrappers >2.5× the box area, pick max IoU
  (≥0.2). Then `synthesizeSelector` + `_computeAccessibilityProfile` + rect +
  `viewportInfo` (dpr) + frame — a picker-shaped result. (Robust to pixel slop and
  the "topmost node isn't the container" problem: a card's own rect out-scores its
  inner image/label.)
- **`RESOLVE_ROLE_VISUAL` (background):** inject CS → `captureVisibleTab` → read
  cached affordances → `locateRoleRegion` → `LOCATE_PICK` (frameId 0) → return
  `{ found, box, confidence, pick }`. Degrades to `found:false` when the tab isn't
  active or the role isn't visible.
- **`_runResolve` Tier-2 orchestration + `_visualResolveRole` (sidepanel):** after
  the DOM resolve loop AND the reveal pass, for still-unfilled **visible** roles
  (those with a failure/abstain note; hidden roles excluded — the reveal pass owns
  them), run the visual fallback, **capped at 8**. Each success pushes a landmark
  and runs the **existing `_refineLandmarkSelectorWithClaude`** (Path A step 4 —
  INSPECT + screenshots + full profile + the geometric selector challenge), then
  verifies; failures drop the landmark and leave a note for manual pick. Resolve's
  counters/toast/run-log fold visual fills in.

**Justification.**
- **Restores A's independent verification anchor.** The known weakness of "LLM
  proposes a click" is that A's safety comes from cross-checking the *human* rect
  against Claude's selector — replace the human with an LLM and it becomes
  LLM-vs-LLM. We avoid that: the box only *selects a real element*; the refine's
  IoU selector-challenge then runs against that **resolved element's real DOM
  rect**, not the proposed box.
- **Cost discipline (Tier-2, not a path).** B's one-call resolve runs first;
  per-role vision is spent only on the residual hard roles, capped at 8.
- **Reuse over invention.** Box encoding mirrors the existing `locate_regions`
  screenshot-space convention; the resolved pick flows into the existing
  Pick→Claude refine unchanged (it already accepts `pickedRect` +
  `pickedAccessibilityProfile`).

**Trade-off accepted.** Viewport-only (no scroll/stitch): roles below the fold
return `found:false` and stay for manual pick — the visual tier helps with what's
on screen, deferring full-page banding to a future change. Vision coordinates are
imprecise, so the box is treated as approximate and resolved by IoU, never as an
exact click point.

**Reversibility.** Additive. Removing the Tier-2 block in `_runResolve` (and the
three new units) reverts Resolve to B + reveal; nothing else depends on them.

**Touched.** `Services/AnthropicService.js` (`locateRoleRegion`),
`ContentScripts/contentScript.js` (`locatePick` + `LOCATE_PICK` case),
`background.js` (`RESOLVE_ROLE_VISUAL`), `Sidepanel/modes/locale-capture.js`
(`_runResolve` Tier-2 block + `_visualResolveRole`), `manifest.json`.

---

## v2.74.397 — PageModel build slice 1: Locale capability catalog (L0 enumerate + query API)

**Date:** 2026-05-24
**Decision by:** user ("lock-in and write up" → "continue"). First build slice of
the `GROUND_SPEC.md` / `PAGEMODEL_SPEC.md` / `OUTCOMES_SPEC.md` architecture (clean
slate, agreed). Implements `PAGEMODEL_SPEC.md` § 10 step 1.

**Spec.** `PAGEMODEL_SPEC.md` defines a **Locale = PageModel**: an
intent-independent capability catalog (Features/Layers/Goals) built at tiered
fidelity (L0 enumerate / L1 depth / L2 goals), consumed via a query API. The
canonical architecture is **clean slate, no migration** (`GROUND_SPEC.md` § 0.5).

**Deviation (implementation, not design).** The build ships the new PageModel **in
parallel** with the existing `pageStructure` artifact rather than replacing it:
- New cache key `pageModelCache` (mirrors `pageStructureCache` keying + 7-day TTL);
  `pageStructure` stays the live artifact for resolve / intent-grounding / Path C
  until later slices rewire those consumers.
- This is a transitional *parallel-run*, not a contradiction of clean-slate: no
  migration of old data occurs; the old path simply isn't torn out mid-transition,
  so the running extension is never broken between slices.

**What shipped (slice 1, additive).**
- **`Core/pageModel.js`** (new, pure ES module — no chrome/DOM deps): `buildPageModel`,
  `buildIndex`, and the query API (`featuresForRole` with head-final role-affinity
  ranking, `featuresByKind`, `knownSelectors` spanning the whole page,
  `scrollTargetFor`, `collections`, `disclosureFor`, `goals`) + `driftHash`.
- **`contentScript.js` `enumeratePage()` + `ENUMERATE_PAGE`**: L0 read-only
  whole-page enumeration — scroll bands, enumerate interactive controls + content
  collections (reuses `detectRepeatingContentBlocks`) + regions, each with
  selector + `location {band, absRect, visibleAtRest, scrollToY}` + kind +
  interaction + a cheap stable id; dedup; restore scroll. **Read-only ⇒ no
  background banding/poke orchestration needed** (the key simplification vs Explore).
- **`background.js` `BUILD_PAGEMODEL` + `GET_PAGEMODEL`** + `_read/_writePageModelCache`:
  inject CS → `ENUMERATE_PAGE` → `PageModel.buildPageModel` → cache.

**Justification.** Delivers the whole-page Feature catalog with `scrollToY` per
feature — structurally fixing the "viewport-assumed-canonical" resolve bug — and a
pure, unit-tested query contract, **without disturbing the live runtime**.
Head-final affinity (last token is the noun) fixes "search-submit" mis-ranking as
an input because of the "search" qualifier.

**Trade-off accepted.** Two artifacts coexist transiently (more storage, two code
paths) until slices 2–4 re-label locales→perspectives, move
description/goals/conventions/chrome onto the Ground, and switch resolve to catalog
selection — at which point `pageStructure` is retired.

**Reversibility.** Fully additive: nothing reads `pageModelCache` yet except the
new `GET_PAGEMODEL`; deleting the three units + key reverts cleanly.

**Verification.** All edited files syntax-check; `Core/pageModel.js` query API
unit-tested (search-input→input, search-submit→action, collection-card/result-item→
collection, nav-link→navigation, whole-page knownSelectors, `scrollTargetFor`).

**Touched.** `Core/pageModel.js` (new), `ContentScripts/contentScript.js`
(`enumeratePage` + `ENUMERATE_PAGE`), `background.js` (import + cache helpers +
`BUILD_PAGEMODEL`/`GET_PAGEMODEL`), `manifest.json`. New specs:
`GROUND_SPEC.md`, `PAGEMODEL_SPEC.md`, `OUTCOMES_SPEC.md`.

---

## v2.74.398–399 — PageModel slice 1.5 (catalog inspector UI) + slice-2 start (Resolve consumes the catalog)

**Date:** 2026-05-24
**Decision by:** user ("continue" ×2). Slice 1.5 = make slice-1 captures visible;
slice-2 start = the catalog's first *consumer*. Both additive / non-breaking;
the structural locale→perspective re-labeling is intentionally deferred until a
real capture validates the L0 feature/kind classification.

**v2.74.398 — Catalog inspector (read-only UI).** locale-capture's perspective
panel gains a **🗂 Build page catalog (L0)** control + a read-only Features panel:
`onBuildPageModel` fires `BUILD_PAGEMODEL` for the active tab/ground, then
`_renderPageModelPanel` shows the result — `N feature(s), M band(s)`, a per-kind
counts line, and a scrollable list grouped by kind (colored kind badge + label +
`selectorKind · band · ✓`, capped 8/kind with "+N more"). State (`_pageModelResult`
/ `_pageModelInFlight`) resets on unmount; draft-token guarded. Not wired to
authoring — it exists to make captures inspectable while the architecture is built.
(CSS: `.dbg-locale-pagemodel*` / `.dbg-locale-pm-*`.)

**v2.74.399 — Resolve consumes the catalog.** `_knownSelectorsForUrl(groundId, url)`
now merges, after the pageStructure poked-control hints, the **whole-page PageModel
catalog** (`pageModelCache`): feature selectors ordered by kind priority
(input→action→collection→navigation→disclosure), deduped by selector, within the
existing 140 cap. This reaches off-screen controls (the top search box when the
author was scrolled away) and content collections the poke sweep never touches —
the architecture's "resolve = selection over the catalog" promise, delivered
additively into the existing resolve flow (`RESOLVE_LOCALE_ROLES` +
`RESOLVE_REVEALED_ROLES` both call this).

**Justification.** Safe because **resolve INSPECT-verifies every chosen selector**
— a stale/wrong catalog hint is dropped exactly like a wrong LLM guess, so feeding
catalog selectors as "known" hints cannot degrade correctness. Opportunistic: with
no cached PageModel the behavior is byte-for-byte unchanged (returns the
pageStructure list or null).

**Trade-off accepted.** Catalog hints are "observed at capture" (the element
existed when its selector was synthesized), a weaker guarantee than pageStructure's
"poked + reveal-confirmed" — but they're ordered AFTER the stronger hints and
gated by downstream verification, so the weaker provenance never wins on a tie that
matters. Requires the author to have built the catalog first (no auto-build yet).

**Reversibility.** Fully additive. Removing the catalog-merge block in
`_knownSelectorsForUrl` and the inspector panel reverts cleanly; no storage shape
changed (still the parallel `pageModelCache`).

**Touched.** `Sidepanel/modes/locale-capture.js` (`_pageModelResult`/`_pageModelInFlight`
state + reset, `_renderPageModelPanel`, `onBuildPageModel`, panel insertion +
button wiring), `assets/sidepanel.css` (`.dbg-locale-pagemodel*`), `background.js`
(`_knownSelectorsForUrl` merges `pageModelCache`), `manifest.json`.

---

## v2.74.400 — PageModel auto-built during Explore + Studio "Page Models" inspector

**Date:** 2026-05-24
**Decision by:** user ("continue"). Makes the catalog populate through the normal
Explore flow (so the v2.74.399 resolve-consumer has data without a manual click),
and makes captures inspectable across sessions in the durable inspector.

**What shipped (both additive / non-breaking).**
- **Auto-build during Explore.** At the end of `EXPLORE_PAGE_STRUCTURE` (after the
  `pageStructure` artifact is cached), a best-effort read-only `ENUMERATE_PAGE`
  pass → `PageModel.buildPageModel` → `pageModelCache`. The content script is
  already injected (the sweep used it). Wrapped so it never fails the Explore
  response. Result: every Explore now produces BOTH artifacts in sync; Resolve's
  catalog consumer gets data automatically.
- **Studio "Page Models" section.** Mirrors the existing "Page Structures" panel
  on the ground card: lists cached `pageModelCache` entries per ground with a
  per-kind feature summary (`12 input · 8 action · 1 collection · …`), band count,
  fidelity, and age; `{ }` opens the full PageModel JSON; `✕` deletes the entry.

**Justification.** Closes the loop opened in v2.74.399 — the catalog is only
useful to Resolve if it exists, and authors already run Explore. The extra
enumerate pass is read-only and bounded (it self-restores scroll). Studio
inspectability directly supports validating the L0 feature/kind classification
before the (deferred) locale→perspective storage re-labeling.

**Trade-off accepted.** Explore costs one extra whole-page scroll pass (~bands ×
110ms). Acceptable for an explicit, already-heavy action; the pass is read-only and
failure-isolated.

**Reversibility.** Additive. Remove the enumerate block in `EXPLORE_PAGE_STRUCTURE`
and the `pmRow` section in `studio.js` to revert; no storage shape changed.

**Touched.** `background.js` (`EXPLORE_PAGE_STRUCTURE` auto-build), `studio.js`
(`pageModelMap` load + "Page Models" section), `manifest.json`.

---

## v2.74.401 — L0 enumeration tuning (validation-driven): suppress per-card controls, collapse nested collections, class-based disclosures

**Date:** 2026-05-24
**Decision by:** user (shared a real Pixabay-homepage L0 capture for validation
before the locale→perspective re-labeling). The capture exposed the L0 classifier's
signal/noise problem.

**Observed (180 features on pixabay.com/):** the search box, login, nav, regions,
and collections all captured correctly — BUT ~140 features were **per-image-card
controls enumerated individually** with brittle positional selectors ("Edit image"
×~15, creator links ×~15, like-count buttons ×~30, each a deep `:nth-of-type`
chain), and **12 "collections" were one image grid detected at 6 nesting levels**
(`cell--uzyOP` ⊃ `contentContainer` ⊃ `container--mVjnq` ⊃ `overlay--Nk44Q` …).
Zero disclosures — Pixabay's "Explore"/"All images" dropdowns are class-based
(no `aria-haspopup`), so the ARIA-only check missed them.

**Root cause.** The interactive elements inside a repeating content card are a
TEMPLATE, not N separate landmarks. The card is the feature.

**What we did (`enumeratePage`).**
- **Collections detected FIRST**, then per-card controls **suppressed**: a
  repeating block whose items each contain a CLUSTER of controls (median ≥3
  interactive descendants) is a content card → its descendant controls are
  skipped during interactive enumeration. Crucially the discriminator is
  *control-count, not size/has-image* — a nav tile / collection thumbnail has ~1
  link (<3) so its link SURVIVES as a navigation feature (size/has-image would
  have wrongly hidden the media-type & collection nav links, which the capture
  showed are real).
- **Nested collections collapsed** for emission: sort blocks by median item area
  desc, keep a block only if its first item isn't `contains`-nested in an
  already-kept block → the outermost card wins, the 5 inner duplicates drop.
- **Class-based disclosure detection**: `classifyKind` now also flags
  `dropdown`/`flyout`/`menutrigger`/`hasmenu` classes and `dropdown`/`flyout`/
  `triggerWrapper` ancestor containers (non-anchor) as `disclosure`, catching
  custom menus that lack `aria-haspopup`/`aria-expanded`.

**Expected effect.** ~180 → ~40–50 features: one image-card collection instead of
6 collections + ~100 per-card controls, media-type/collection nav links preserved,
"Explore"/"All images" now `disclosure`. (To be confirmed by a re-capture.)

**Justification.** Makes the catalog clean enough to drive Perspective authoring —
the prerequisite for the (still-deferred) locale→perspective re-labeling. Control-
count suppression is principled (targets internal control clusters) and spares
genuine repeated nav.

**Trade-off accepted.** A medium product grid whose cards have <3 controls won't
suppress (some residual per-card noise); a card grid with exactly the threshold is
a judgment call. Tunable.

**Reversibility.** Contained to `enumeratePage` + `classifyKind`; revert restores
the prior flat enumeration.

**Touched.** `ContentScripts/contentScript.js` (`enumeratePage` collection-first +
suppression + collapse, `classifyKind` disclosures), `manifest.json`.

---

## v2.74.402 — L0 re-capture fixes: sticky-region position + stronger collection collapse

**Date:** 2026-05-24
**Decision by:** user (second Pixabay re-capture — 180→110 features confirmed the
v2.74.401 tuning worked: per-card noise gone, "Explore"/"All images" now
`disclosure`, search/nav/regions intact). Two issues the capture surfaced:

1. **Sticky-header mis-position.** Regions were measured at the END of enumeration
   (page scrolled to the bottom by the band loop), so the *sticky* header's
   scroll-relative rect reported `y≈4957` instead of `0`. Fix: `scrollTo(0,0)` +
   settle before measuring regions, so sticky/fixed regions get their at-rest
   absolute Y.
2. **Incomplete collection collapse.** The image grid still emitted ~4 overlapping
   collections (`cell` + `contentContainer` + `overlayContainer` + generic
   `layout--column`) because collapse only checked the *first* element and the
   nesting isn't 1:1 (12 cells vs 10 inner containers vs 25 images). Fix: collapse
   now drops a block when **≥50% of up to 8 sampled items share DOM ancestry**
   (bi-directional `contains`) with an already-kept larger block.

**Note.** The residual ~83 navigation features are mostly genuine distinct
destinations (footer link groups, search tag chips, media-type tiles, collection
thumbnails), not noise — the original 40-50 estimate undercounted them. Generic
utility-class collections (`layout--column`) and hidden overlay menu collections
(`menuItem`) remain mild noise; deferred (a later "is this a real content grid"
refinement) — acceptable for L0.

**Touched.** `ContentScripts/contentScript.js` (`enumeratePage` region scroll-to-top
+ overlap-based collapse), `manifest.json`.

---

## v2.74.403 — Propose seeds roles from the PageModel catalog (slice 2: route authoring through the Locale)

**Date:** 2026-05-24
**Decision by:** user ("continue" → slice 2). The architecture's core value is
*"a Perspective is authored by SELECTING from the Locale catalog."* The resolve
side already consumes the catalog (v2.74.399); this adds the propose side.

**Scope choice (transparent deviation from the literal slice-2 plan).** Slice 2 as
written also called for a `locale`→`perspective` storage/terminology RENAME +
introducing the Locale as a first-class stored entity. A big-bang rename across
storage / runtime / UI is mostly cosmetic churn with large breakage risk and was
**deferred** — the functional realization of the hierarchy (authoring grounded in
the page catalog) delivers the value safely and additively. The rename remains a
separate, optional, deliberate pass.

**What shipped (additive / opportunistic).** `proposePerspectives` gained a
`pageModel` param; when a fresh PageModel exists for the page, the background
(`PROPOSE_LOCALE_PERSPECTIVES`) reads `pageModelCache` and passes it, and the prompt
renders a **PAGE FEATURE CATALOG** block — the whole-page inventory grouped by kind
(input / action / disclosure / navigation / collection / region, with labels +
collection counts, off-screen features included). A prompt rule instructs the LLM
to GROUND roles in the catalog (map "many" content roles → a `collection` entry, a
`disclosure` entry → a hidden/revealedBy trigger). Propose meta now reports
`pageModel` + `pageModelFeatures`.

**Justification.** Propose previously guessed roles from a single top-of-viewport
screenshot + truncated DOM; it now starts from the page's *real, whole-page*
affordances (the same catalog the resolve step reuses). With both propose and
resolve catalog-aware, the Perspective-authoring loop is functionally "select from
the Locale" — the hierarchy realized without a risky rename. Opportunistic: no
cached model ⇒ behavior unchanged.

**Reversibility.** Additive. Drop the `pageModel` param + the handler read to
revert; no storage shape changed.

**Touched.** `Services/AnthropicService.js` (`proposePerspectives` catalog block +
rule), `background.js` (`PROPOSE_LOCALE_PERSPECTIVES` reads `pageModelCache` + meta),
`manifest.json`.

---

## v2.74.404 — PageModel L1 depth: merge the Explore poke→reveal sweep into Layers (no re-poking)

**Date:** 2026-05-24
**Decision by:** user ("continue"). Makes disclosures (Explore / All images)
resolvable by giving the PageModel its depth layer — the missing piece flagged in
the v2.74.402 validation (`triggers: []` at L0).

**Key insight.** The poke→reveal data already exists. Explore's sweep records, per
disclosure control, what it REVEALED (`structure.controls[].revealed`), and Explore
builds BOTH artifacts in the same handler. So L1 = **merge that reveal data into the
PageModel** — no new, flaky poke machinery (the thing that was historically brittle:
navigation, overlays not closing).

**What shipped.** New pure `PageModel.mergeDepthFromControls(model, controls)`: for
each control with `observation:'reveal'` + revealed children, it (a) finds the
matching L0 disclosure feature (by selector, then label) and upgrades it
(`kind:'disclosure'`, `reveals:layerId`, `selectorVerified:true`, evidence
`poke`), or mints a trigger if L0 missed it; (b) creates a **Layer** node
(`kind:'modal'` if `overlay`, else `dropdown`; `openedBy`); (c) adds the revealed
children as features tagged `hidden:true` + `revealedBy:trigger` +
`selectorVerified:true`, kind inferred from a11y role (link→navigation,
textbox→input, else action); (d) rebuilds `index` (so `index.triggers` populates)
and sets `coverage.fidelity:'L1'`. Wired into `EXPLORE_PAGE_STRUCTURE` after
`buildPageModel`, fed `structure.controls`. The manual 🗂 catalog stays **L0** (it
never poked).

**Justification.** Disclosures become first-class resolvable triggers with their
revealed layers — the depth half of the capability model — by reusing the proven
sweep rather than re-poking. Pure + unit-tested (trigger linkage, layer kind,
hidden/verified children, `index.triggers`, no-change ignored, L1 upgrade).

**Trade-off accepted.** L1 depth only attaches when Explore ran (the manual catalog
is L0-only). Revealed-child selectors inherit the sweep's `computeUniqueSelector`
output (often positional) — acceptable; they're poke-verified and resolve re-verifies.

**Reversibility.** Additive: drop the `mergeDepthFromControls` call to revert the
model to L0; the function is self-contained.

**Touched.** `Core/pageModel.js` (`mergeDepthFromControls` + `hashId`/`selectorTier`
helpers), `background.js` (`EXPLORE_PAGE_STRUCTURE` L1 merge), `manifest.json`.

---

## v2.74.405 — Manual 🗂 catalog reaches L1 by merging a fresh cached pageStructure

**Date:** 2026-05-24
**Decision by:** user (capture showed `fidelity:L0` / `triggers:[]` from the manual
🗂 button — L1 only attached via Explore). Closes the confusing gap where the
button literally named "Build page catalog" couldn't produce depth.

**What shipped.** `BUILD_PAGEMODEL` (the 🗂 button) now, after `buildPageModel`,
reads the FRESH cached `pageStructure` (a prior Explore's poke→reveal sweep) and
`mergeDepthFromControls` into the model — so the manual catalog reaches **L1** when
depth was previously captured. With no fresh pageStructure it stays **L0** (the
manual path is read-only and can't poke; run **Explore** to capture depth).

**Why not poke from 🗂?** Poking is the heavy/flaky path (navigation, overlay
close). The catalog stays read-only; it reuses Explore's proven depth data rather
than re-deriving it. (Future: unify the two into one "Explore = L0+L1" action.)

**Touched.** `background.js` (`BUILD_PAGEMODEL` depth merge), `manifest.json`.

---

## v2.74.406 — L1 depth: drop content-swap false disclosures (carousels/tabs)

**Date:** 2026-05-24
**Decision by:** user (first L1 Pixabay capture — login modal, Explore mega-menu,
and media-type dropdown all captured as resolvable hidden features ✓). It also
showed carousel arrows (next/prev/scroll) and a tab mis-captured as disclosures:
the poke sweep counts a carousel ADVANCE as a "reveal," surfacing 1 swapped slide.

**What shipped.** `mergeDepthFromControls` now skips a control whose reveal is
**non-overlay AND surfaces <2 new elements** — a content swap (carousel slide / tab
content change), not a menu/panel disclosure. Real disclosures are overlays
(modals/dropdowns) or reveal several items, so they're untouched. Removes the
false `next`/`prev`/`scroll`/single-item-`tab` layers; those triggers keep their L0
kind (`action`).

**Trade-off accepted.** A genuine in-place disclosure that reveals exactly one
element is dropped — rare, and the element is still in the L0 surface if visible.

**Known, deferred.** The shared auth modal is captured as 3 overlapping layers
(Log in / Join / Upload each open it). Redundant but not wrong; a layer-dedup pass
(merge layers with high feature overlap, point all triggers at one) is a later
polish.

**Touched.** `Core/pageModel.js` (`mergeDepthFromControls` content-swap filter),
`manifest.json`.

---

## v2.74.407 — L1 depth: consolidate the same overlay opened by several triggers

**Date:** 2026-05-24
**Decision by:** user ("continue"). The L1 capture showed Pixabay's auth modal as
THREE layers — Log in / Join / Upload each open it, each capturing a different tab
(login form vs signup form), so the layers held *complementary* fields, not pure
dups.

**What shipped.** New pure `dedupeOverlayLayers(model)` (run inside
`mergeDepthFromControls` before `buildIndex`): among OVERLAY layers (modals), merge
any that share members (≥3 shared selectors, or ≥50% of the smaller set) into one
survivor — union their features (dedup by selector), and repoint every trigger's
`reveals` at the survivor. Orphan-cleanup drops hidden features no surviving layer
references. In-place dropdowns are trigger-specific and untouched; non-overlapping
overlays (Explore mega-menu vs auth modal) stay separate.

**Net.** The auth modal becomes ONE layer holding login + signup fields, with all
three triggers (Log in / Join / Upload) pointing at it — cleaner and more useful
for authoring a "sign in" perspective (pick any auth field from one layer).
`index.triggers` still lists all triggers (multiple → same layer is correct).

**Justification.** Restricting to overlays + requiring shared members keeps it
safe: distinct menus don't share selectors, so they never wrongly merge (unit-
tested: Explore stays separate while Log in + Join consolidate).

**Touched.** `Core/pageModel.js` (`dedupeOverlayLayers` + call site), `manifest.json`.

---

## v2.74.408 — PageModel L2: synthesize structured Goals from the catalog

**Date:** 2026-05-24
**Decision by:** user ("continue"). The last capability tier: turn the L0+L1
feature catalog into structured **Goals** (the outcomes a user can accomplish),
each linked to the features that realize it — what intent-grounding and
perspective-seeding should reason over, vs the free-text `affordances`.

**What shipped.**
- **`AnthropicService.synthesizeGoals({ model, url, title, affordances })`**:
  presents the model as an INDEXED catalog (balanced per-kind so footer-link spam
  can't crowd out inputs/actions/disclosures/collections), asks the LLM for 3-8
  goals each referencing feature INDEXES, and maps indexes → feature ids (robust
  vs. copying cryptic ids). role `describe`, op `synthesizeGoals`.
- **`PageModel.attachGoals(model, goals)`** (pure): assigns stable goal ids, drops
  dangling feature refs, backlinks `feature.goals`, rebuilds `index` (so `byGoal`
  populates), upgrades `coverage.fidelity` → **L2**.
- **Explore wiring**: after the L1 merge, `EXPLORE_PAGE_STRUCTURE` synthesizes +
  attaches goals (best-effort; never fails the response). The manual 🗂 catalog
  stays L0/L1 (no LLM goals call).

**Justification.** Completes L0 (features) → L1 (depth) → L2 (goals). Goals are
grounded in the actual catalog (index-referenced, not invented) and give the
authoring loop a structured "what can be done here" to reason over. Pure/unit-
tested (goal linkage, dangling-ref drop, backlinks, `byGoal`, empty-label skip,
L2 upgrade).

**Follow-up (not yet wired).** `groundIntent` still reads the free-text
`affordances`; switching it (and perspective-seeding) to consume `model.goals`,
and surfacing goals in the inspectors, is the consumption slice.

**Touched.** `Services/AnthropicService.js` (`synthesizeGoals`), `Core/pageModel.js`
(`attachGoals`), `background.js` (`EXPLORE_PAGE_STRUCTURE` L2 wiring), `manifest.json`.

---

## v2.74.409 — Consumption: intent-grounding reasons over structured Goals

**Date:** 2026-05-24
**Decision by:** user ("continue"). First L2 *consumption* slice — make the goals
pay off where the author feels it: intent grounding.

**What shipped.**
- **`groundIntent`** gained an optional `goals` param. When present, the prompt
  renders the page's structured GOALS and instructs the model to MATCH the intent
  to the closest goal, base `achievable` on goal coverage, and return a new
  `matchedGoal` (the goal's label, or null). Free-text `affordances` is kept as a
  secondary/fallback signal.
- **`GROUND_INTENT`** now reads the cached PageModel's `goals` (fresh-gated) and
  passes them; falls back to `affordances`; still degrades to pass-through when
  nothing is explored (`hadAffordance:false`). Reports `hadGoals`.
- **Sidepanel** surfaces the match: the grounded-intent card shows
  "↳ matches page goal: **<label>**" when present.

**Justification.** Grounding moves from prose-similarity to *structured goal
matching* — sharper grounded intents, more reliable achievability verdicts, and a
visible link from the user's intent to a concrete page goal (whose `achievableVia`
features the propose→resolve pipeline can then target). Additive: no goals ⇒ prior
affordance-text behavior; `matchedGoal` is optional so the existing card/handler
are unaffected when absent.

**Follow-up.** Perspective-seeding (`proposePerspectives`) already consumes the
feature catalog (v2.74.403); feeding it the matched goal's `achievableVia` features
is a further refinement. Surfacing goals + layers in the catalog inspectors is the
remaining consumption UI.

**Touched.** `Services/AnthropicService.js` (`groundIntent` goals + matchedGoal),
`background.js` (`GROUND_INTENT` reads `pageModelCache` goals), `Sidepanel/modes/
locale-capture.js` (matchedGoal in the grounded-intent card), `manifest.json`.

---

## v2.74.420 — Terminology: `Locale` → `Perspective` (full end-to-end rename)

**Date:** 2026-05-24
**Decision by:** user ("update locale → perspective renaming … this should be end
to end … saved data isn't a concern - clean slate"). Realizes the locked
hierarchy (GROUND_SPEC § 0.1–0.3): **Ground → Locale → Perspective → Landmark**,
where the authored intent+landmark artifact (was "Locale") is now a **Perspective**,
and the capability catalog **is** the Locale (already implemented as `PageModel`).

**Why fully (not user-facing only).** Prior splits where internal names diverged
from user-facing terms caused recurring confusion. Per the user, this rename is
end-to-end: storage keys, message types, the runtime DSL (`locale_ref` →
`perspective_ref`), function/variable names, CSS classes, file names, UI strings,
comments — everything. No back-compat shim (clean slate; existing data is
discarded).

**Method (auditable, phased).**
- *Phase 0* — inventoried every `locale` token (2306 occurrences / 50 files) and
  built a definitive map: rename rules + exclusions.
- *Phase 1* — applied an ordered, sentinel-guarded `perl` rename across 101
  `.js/.html/.css` files (protect JS builtins → collapse special compound → swap
  case variants → restore builtins). A second pass collapsed the `loc`/`_loc`
  camelCase abbreviations (`_locDraft` → `_perspectiveDraft`, etc.) and
  `data-loc-action` → `data-perspective-action`.
- *Phase 2* — `git mv` of 5 files (`locale-capture.js` → `perspective-capture.js`,
  `LocaleForm`/`LocalePredicates`/`localeComposition`/`LocaleDescription` →
  `Perspective*`); collapsed two double-`Perspective` artifacts
  (`_fragmentPerspectiveIds`, `perspectiveBody`).
- *Phase 3* — verification.

**Special handling (preserved on purpose).**
- **JS builtins** — `localeCompare`, `toLocaleString`/`toLocaleDateString`/
  `toLocaleTimeString` are NOT domain terms; left intact.
- **OUTCOMES `localeId`** — in the OutcomeEvent schema `localeId` means the **new
  Locale = PageModel** (distinct from `perspectiveId`), exactly per OUTCOMES_SPEC
  § 5. `Core/outcomes.js` and the three emit-site `localeId` keys were kept as-is
  (renaming would have collided with `perspectiveId` and broken the schema).
- **Compound collapse** — `PROPOSE_LOCALE_PERSPECTIVES` → `PROPOSE_PERSPECTIVES`
  (the redundant prefix; the proposal options always were "perspectives").

**Verification.** `node --check` on every `.js` (classic for contentScript, module
for the rest) — all pass. Case-sensitive residual sweep: zero domain `locale`
remaining except the intentional OUTCOMES `localeId`. Cross-file contracts
confirmed consistent: message types match sender↔handler
(`BEGIN_PERSPECTIVE_CAPTURE`, `RESOLVE_PERSPECTIVE_ROLES`, `SAVE_PERSPECTIVE`,
`PROPOSE_PERSPECTIVES`, …), `StorageManager` methods (`getPerspective` /
`listPerspectives` / `savePerspective` / `deletePerspective`), the
`perspective_ref` condition kind (17 files), all renamed-file imports resolve,
`.dbg-perspective-*` CSS classes match their JS emitters, manifest clean. A
non-destructive `git stash create` snapshot (`2301c24`) was taken first as a
recovery point.

**Scope note.** The capability catalog keeps its implementation name `PageModel`
(the spec's "Locale = PageModel"); renaming PageModel → Locale was not requested
and is a separate concern. The word "Locale" now appears in code only as the
OUTCOMES `localeId` (= PageModel), consistent with the spec.

**Touched.** ~50 files across the repo (every layer); 5 files renamed;
`manifest.json`.

---

## v2.74.419 — OUTCOMES: provenance on the Feature + decay/correction visible in the inspector

**Date:** 2026-05-24
**Decision by:** user ("continue"). Completes the provenance half of OUTCOMES_SPEC
§ 3 (the gold label as durable artifact provenance, not only a stream row) and
makes the whole closed loop visible to the operator.

**What shipped.**
- **Provenance stamp** (`background.js`, in the `EMIT_RESOLVE_OUTCOMES` decay/
  write-back pass). For each `corrected` event whose featureId maps to a catalog
  Feature (the element the LLM wrongly proposed), it now sets
  `feature.provenance = { proposedBy:'llm-resolve', correctedByHuman:{ role, from→to,
  at }, corpusRef }` and persists it with the same write that applies decay. § 3's
  "the LLM was wrong here" now lives ON the Feature, with a backlink to the stream
  event.
- **Inspector markers** (`Sidepanel/modes/locale-capture.js`, `_renderPageModelPanel`
  from v2.74.411). Each feature row now shows `✎` when it carries
  `correctedByHuman` and `⚠` when its `lifecycle === 'stale-suspected'`, with the
  correction (`from → to`) and the staleness reason on hover. The operator can now
  SEE what the loop learned — which catalog features got corrected and which the
  decay flagged for re-capture.

**Justification.** Before this, the corrected/decayed signal lived only in the
stream + folded rollups; the artifact the author actually inspects (the page
catalog) looked unchanged. Putting provenance on the Feature and surfacing it
closes the perceptual loop: capture → use → correct/decay → *visible* on the
catalog. Best-effort and additive — features without corrections render exactly as
before.

**Touched.** `background.js` (`EMIT_RESOLVE_OUTCOMES` provenance stamp folded into
the existing write-back), `Sidepanel/modes/locale-capture.js` (inspector ✎/⚠
markers), `manifest.json`.

---

## v2.74.418 — OUTCOMES: the gold label — human re-picks emit `corrected` events

**Date:** 2026-05-24
**Decision by:** user ("continue"). Captures the signal OUTCOMES_SPEC § 3 calls
"the STRONGEST training signal" / "the gold label" — which until now was silently
discarded.

**What shipped.**
- **Emit at the manual-pick site** (`Sidepanel/modes/locale-capture.js`). When a
  manual pick fills a role, the handler already deleted the stale resolve note
  (`_roleResolveNotes[role]`). It now CAPTURES that note first and — if resolve had
  proposed/failed/abstained on this role — emits a synthetic single-detail run
  through `EMIT_RESOLVE_OUTCOMES` carrying `humanFinal:{selector}`. The adapter
  maps `humanFinal` → verdict `corrected`: an explicit "proposed X, truth was Y."
- **Adapter semantics fix** (`Core/outcomes.js`). `featureId` now tracks the
  element resolve PROPOSED (`d.selector`), not the human truth. So a `corrected`
  row debits the WRONG catalog feature (active decay flags it), while the human's
  selector rides in `humanFinal` for the corpus + the **conventions histogram**
  (`foldConventions` already reads the human selector for corrected rows). This
  corrects a latent slice-4 bug that would otherwise have penalized the feature
  the human confirmed CORRECT.

**Verified (10/10 node test).** corrected verdict; featureId = proposed/wrong
element (not the human's); health debits only the wrong feature; conventions learns
the human selector's tier; abstained-correction → corrected with null featureId
(corpus-only, no decay).

**Justification.** Every other event is the system grading itself; this is the
human grading the system. It feeds active decay (the proposed-but-rejected catalog
feature → stale-suspected) AND the conventions prior (the human's correct selector
tier), so both compounding mechanisms now learn from real corrections. Fire-and-
forget, gated on a prior resolve note — a first-time manual pick (no resolve
attempt) emits nothing.

**Touched.** `Sidepanel/modes/locale-capture.js` (corrected emit at the pick site),
`Core/outcomes.js` (`fidSelector` = proposed selector), `manifest.json`.

---

## v2.74.417 — OUTCOMES: poke-reveal emit (the free deterministic disclosure label)

**Date:** 2026-05-24
**Decision by:** user ("continue"). A v1 emit-hook the arc hadn't wired yet
(OUTCOMES_SPEC § 5 calls `op:'poke'` special — "the reveal observation is a free
deterministic label: is this element a disclosure, yes/no").

**What shipped.** The `EXPLORE_PAGE_STRUCTURE` handler, right after it builds +
caches the PageModel (with `mergeDepthFromControls`), now emits a `poke`
OutcomeEvent for every Explore control that ACTUALLY revealed something:
`{ phase:'author', op:'poke', verdict:'verified', featureId (mapped by selector),
llmOutput.selector, detail.matchedCount/reason }`, appended via `_appendOutcomes`.
This confirms each disclosure Feature's health (a poke-verified is a resolve-hit
in `foldFeatureHealth`) and banks a positive training pair — for free, from data
the sweep already captured.

**Design guard — only REVEALING pokes are emitted.** A control that (correctly)
opens nothing must not log a poke-miss: `foldFeatureHealth` counts a poke-failure
as a resolve-miss, which would decay a perfectly healthy action button. Positive
disclosure labels are clean; negative-label corpus enrichment (poke→nothing) is a
later refinement that must first decouple poke verdicts from the decay path.

**Justification.** The stream previously held only resolve events; Explore happens
far more often than authoring, so poke-reveal is the highest-volume *free* signal
available — and it directly strengthens disclosure-trigger health (the features
most likely to be brittle). The poke selectors also feed the conventions histogram
as additional deterministically-verified samples.

**Touched.** `background.js` (`EXPLORE_PAGE_STRUCTURE` poke-emit), `manifest.json`.
No studio change — the generic event renderer already shows `op:'poke'` /
verified ✓.

---

## v2.74.416 — OUTCOMES slice 5: studio viewer for the stream + rollups

**Date:** 2026-05-24
**Decision by:** user ("continue"). Final slice of the OUTCOMES v1 arc — make the
stream and its derived rollups inspectable.

**What shipped.** A new **Outcomes** section per Ground in the studio ground card
(`studio.js`), mirroring the Page Models section. It calls the background fold
(`GET_OUTCOMES` with `includeEvents`) and renders:
- **Header** — event count + a `{ }` rollups-JSON view + a `✕` clear control.
- **Summary line** — the conventions histogram (`data 60% · class 30% · …`), the
  Feature-health tally (`N tracked · M stale-suspected`), and the
  Perspective-usage tally (`N perspectives · X% avg success`).
- **Recent events** — the last ~12 events as verdict-icon + op + role/feature +
  relative time, color-coded (verified ✓ green / failed ✗ red / corrected ✎ violet
  / abstained ∅ grey). Empty state explains the stream fills via ⚡ Resolve.
- **Clear** — deletes `outcomesStream[groundId]`; rollups recompute empty (the
  pageModel features keep their decayed confidence — the stream is the source, not
  the artifact).

CSS for `.outcomes-*` added to `assets/sidepanel.css` (shared by studio).

**Justification.** The whole arc produced a stream that bias resolve and decay
features silently; the operator needs to see it — what's being learned (the
histogram), what's being flagged (stale-suspected features), and the raw training
pairs. Read-only + a clear control; no new authoring surface.

**This closes the OUTCOMES v1 arc** (slices 1–5): pure module → persistence → emit
hook → close-the-loop (featureId/decay/conventions) → viewer. Deferred per
OUTCOMES_SPEC § 8: the labeled-corpus store/exporter (bodies behind `corpusRef`),
age-based passive decay, `#audit` stream wiring (no groundId), and any
model-training consumer.

**Touched.** `studio.js` (Outcomes section + GET_OUTCOMES read + clear handler),
`assets/sidepanel.css` (`.outcomes-*`), `manifest.json`.

---

## v2.74.415 — OUTCOMES slice 4: close the loop (featureId map + decay + conventions bias)

**Date:** 2026-05-24
**Decision by:** user ("continue"). Fourth slice — the stream now flows BACK into
the artifacts and the next resolve.

**What shipped (three parts).**
1. **Feature health keys land.** `eventsFromResolveRun` now passes the resolved
   selector (the HUMAN-truth selector for a corrected row) to
   `featureIdForRole(role, selector)`. `EMIT_RESOLVE_OUTCOMES` builds a verbatim
   selector→Feature-id index from the cached pageModel for the ground+URL, so each
   resolve event is keyed to the catalog Feature it exercised.
2. **Active decay (§ 7, § 0.16).** After appending, the handler folds the full
   stream's `featureHealth` and runs `Outcomes.decayFeature` over the cached
   pageModel features — a resolve-miss lowers JUST that feature's `confidence` and
   flips its `lifecycle` toward `stale-suspected`, never touching siblings — then
   writes the pageModel back if anything changed.
3. **Conventions bias (§ 6, the compounding asset).** `RESOLVE_LOCALE_ROLES` reads
   the folded `conventions` histogram (gated at ≥5 verified selectors) and passes
   it to `resolveRoles`, which renders a SITE SELECTOR CONVENTIONS line ("80%
   data-testid, 15% class…"). A SOFT prior — when two interactive selectors are
   equally good, prefer the tier this site actually uses; content roles keep their
   class signature regardless.

**Justification.** This is the payoff of the stream: authoring signal becomes (a)
trust decay that flags stale catalog features for re-capture without disturbing the
rest of the model, and (b) a learned selector prior that makes each subsequent
Locale on the same Ground cheaper and more accurate (GROUND_SPEC § 9 compounding).
All three are best-effort and gated, so a cold Ground (no stream yet) behaves
exactly as before.

**`locateRoleRegion` excluded by design.** It returns a bounding BOX, not a
selector, so a selector-tier histogram doesn't apply; the conventions bias is
selector-only.

**Touched.** `Core/outcomes.js` (`featureIdForRole(role, selector)`),
`background.js` (`EMIT_RESOLVE_OUTCOMES` featureId index + decay pass;
`RESOLVE_LOCALE_ROLES` conventions read), `Services/AnthropicService.js`
(`resolveRoles` conventions block), `manifest.json`. Re-tested the adapter (5/5).

---

## v2.74.414 — OUTCOMES slice 3: emit hook — resolve-runs fill the stream

**Date:** 2026-05-24
**Decision by:** user ("continue"). Third slice of the OUTCOMES arc — the
consequential one: the corpus actually starts filling.

**What shipped.** The sidepanel's resolve-run now flows into the append-only
stream (OUTCOMES_SPEC § 9):
- `_logResolveRun` (`Sidepanel/modes/locale-capture.js`) — after persisting its
  `resolveRoles:perf` entry (unchanged), it fire-and-forgets an
  `EMIT_RESOLVE_OUTCOMES` message with `{ groundId: _locGroundId, run: entry,
  ctx: { localeId: url, perspectiveId: _locDraft.id } }`. Wrapped in try/catch +
  `lastError` swallow — an emit failure can never affect resolve.
- `background.js` — new `EMIT_RESOLVE_OUTCOMES` handler transforms the run via
  `Outcomes.eventsFromResolveRun(run, ctx)` (each per-role detail → one authoring
  `resolve` event; `resolved→verified`, `failed→failed`, `abstained→abstained`,
  and a row carrying `humanFinal` → `corrected`) and `_appendOutcomes`. Writes are
  centralized in background to avoid races on the shared `outcomesStream` map.

This immediately powers the **conventions histogram** (verified selectors' tiers,
§ 6) and the per-Perspective/run corpus. Feature-`health` keying by `featureId`
and the explicit human-correction linkage (`humanFinal`) are populated in slice 4
(`featureIdForRole` map + manual-repick hook); the adapter already supports both.

**`#audit` deferred (scoped, not skipped).** `AnthropicService.#audit` persists
operational telemetry to `llm:audit` and runs WITHOUT a `groundId`, so feeding it
into the per-ground stream would orphan the events. The `eventFromAudit` adapter
exists for a future consumer that has ground context; wiring it is left out of
this slice deliberately.

**Touched.** `Sidepanel/modes/locale-capture.js` (`_logResolveRun` emit),
`background.js` (`EMIT_RESOLVE_OUTCOMES`), `manifest.json`.

---

## v2.74.413 — OUTCOMES slice 2: persist the stream + lazy rollups (background)

**Date:** 2026-05-24
**Decision by:** user ("continue"). Second slice of the OUTCOMES arc — give the
pure module (v2.74.412) a home. Store + read/fold plumbing only; no emit yet.

**What shipped.** `background.js` imports `Core/outcomes.js` (as `Outcomes`) and
adds the ONE unified append-only stream (OUTCOMES_SPEC § 1, GROUND_SPEC § 0.13):
- **Store** — cache key `outcomesStream`, value `{ [groundId]: OutcomeEvent[] }`,
  bounded at `OUTCOMES_STREAM_CAP=1000`/ground via `Outcomes.appendEvents` (oldest
  dropped). Helpers `_appendOutcomes(groundId, events)` / `_readOutcomes(groundId)`.
- **Lazy rollups** — `_outcomeRollups(groundId)` folds the stream on demand into
  `{ featureHealth, perspectiveUsage, conventions, eventCount }` (§ 4) rather than
  maintaining per-event — recomputed lazily (§ 0.15).
- **Read handler** — `GET_OUTCOMES` returns the rollups (and the raw stream when
  `includeEvents`, newest-first, capped). Consumed by the studio viewer (slice 5)
  and resolve-bias / active-decay (slice 4).

**Justification.** Mirrors the existing `pageModelCache` plumbing (per-ground map,
read/write helpers, a GET_* handler). Keeping the stream per-ground matches the
conventions rollup, which is learned across a Ground's Locales (§ 6). Read-only and
additive — nothing emits into the stream yet, so behaviour is unchanged until
slice 3 wires the hooks.

**Touched.** `background.js` (import, `_appendOutcomes`/`_readOutcomes`/
`_outcomeRollups`, `GET_OUTCOMES`), `manifest.json`.

---

## v2.74.412 — OUTCOMES slice 1: pure `Core/outcomes.js` (schema + rollups + decay)

**Date:** 2026-05-24
**Decision by:** user ("continue"). First slice of the OUTCOMES "close the loop"
arc (OUTCOMES_SPEC § 8 v1 scope, GROUND_SPEC § 0.13–0.17). Pure module only —
mirrors how `Core/pageModel.js` was bootstrapped (additive, unit-testable, no
wiring) so the next "continue" can attach emit hooks at the live call sites
without re-litigating the schema.

**What shipped.** New pure ES module `Core/outcomes.js` (no chrome/DOM deps):
- **Schema + vocab** — `OUTCOMES_SCHEMA=1`, `PHASES`/`OPS`/`VERDICTS`/`OUTCOMES`/
  `PROVENANCE_SOURCES`/`LIFECYCLE` frozen enums.
- **Event factory** — `makeEvent(partial)` normalizes to the § 5 `OutcomeEvent`,
  mints `id`+`ts`, and mints a `corpusRef` for `phase:'author'` events (training
  pairs; body stubbed per § 0.17). Bad phase/op coerce to safe defaults — an
  append-only stream must never reject a real signal.
- **Adapters from the telemetry seeds (§ 9)** — `eventsFromResolveRun(run, ctx)`
  turns each `_logResolveRun` `details[]` row into a `resolve` author event
  (`resolved→verified`, `failed→failed`, `abstained→abstained`, and **`humanFinal`
  present → `corrected`**, the gold label); skips `skipped`. `eventFromAudit`
  widens `#audit` telemetry into the stream.
- **Derived rollups (§ 4)** — `foldFeatureHealth` (→ per-Feature
  `{lifecycle,lastVerifiedAt,resolveHits,resolveMisses,lastResolvedAt}`, incremental
  via `prior`), `foldPerspectiveUsage` (→ `{activations,lastUsedAt,successRate,
  lastOutcome}`), `foldConventions` (→ selector-tier histogram from verified/
  corrected selectors — a 'corrected' event counts the HUMAN selector, § 6).
- **Active decay (§ 7, § 0.16)** — `decayFeature(feature, health, opts)` lowers
  `confidence` + flips lifecycle → `stale-suspected` once net resolve-misses cross
  a threshold, without touching siblings. Age-based passive decay deferred.
- **Store helper** — `appendEvents(stream, events, cap)` (pure, bounded).

**Justification.** The substrate already produces the exact signal worth keeping —
LLM proposal → deterministic verdict → human correction — and discards it. This
module is the one append-only stream (§ 0.13) that captures it once and folds it
into the small artifact rollups. Built pure first so it is verifiable in isolation
(45-assertion node `.mjs` test, all passing) before any storage/UI risk.

**Touched.** `Core/outcomes.js` (new), `manifest.json`. No wiring yet (emit hooks
at `_logResolveRun` / `#audit` and the rollup persistence are the next slice).

---

## v2.74.411 — Inspector: surface L1 layers + L2 goals in the 🗂 catalog panel

**Date:** 2026-05-24
**Decision by:** user ("continue"). Visibility slice — the sidepanel catalog
inspector showed only features-grouped-by-kind, hiding the depth and goals that
L1/L2 capture produces.

**What shipped.** `_renderPageModelPanel` (`Sidepanel/modes/locale-capture.js`)
now renders three additions:
- A **fidelity badge** (`L0`/`L1`/`L2`) in the panel header, color-coded
  (grey/violet/green) with a tooltip describing the tier.
- A **Depth — revealed layers** section: every non-surface Layer (modal/dropdown)
  as `kind` chip + trigger label (`openedBy` feature) + `→ N hidden` count, with
  the first revealed child labels on hover.
- A **Goals** section: each synthesized Goal as `🎯 label` + `N feat · NN%`
  confidence, with description + `achievableVia` feature labels on hover.
Hidden features in the by-kind list now show a `🔒` marker. Sections render only
when present (no goals/layers ⇒ unchanged L0 view).

**Justification.** The catalog is the locale's capability artifact; the inspector
should reflect what each capture tier actually found. Previously an L2 build looked
identical to an L0 build in the UI — the operator couldn't see that depth/goals
were captured. Read-only; no new messages or handlers.

**Touched.** `Sidepanel/modes/locale-capture.js` (`_renderPageModelPanel`),
`assets/sidepanel.css` (`.dbg-locale-pm-fidelity`/`-section`/`-goal`/`-layer`),
`manifest.json`.

---

## v2.74.410 — Consumption: propose aligns perspectives to the matched Goal

**Date:** 2026-05-24
**Decision by:** user ("continue"). Second L2 consumption slice — let perspective
proposal build roles around the page's goals.

**What shipped.** `proposePerspectives` already receives the `pageModel`
(v2.74.403, for the feature catalog). It now ALSO renders a **PAGE GOALS** block —
each goal + the labels of the features that achieve it (`achievableVia`) — and
instructs the model to identify which goal the INTENT targets and build the
perspective's roles around THAT goal's features. No handler change (the model was
already passed); opportunistic (no goals ⇒ unchanged).

**Justification.** Completes the chain **intent → goal → features → roles →
landmarks**: grounding maps the intent to a goal (v2.74.409); propose now builds
the role set from that goal's catalogued features; resolve reuses their verified
selectors (v2.74.399). The perspective is pre-aligned to a real, achievable page
outcome instead of guessed from a screenshot.

**Touched.** `Services/AnthropicService.js` (`proposePerspectives` PAGE GOALS
block), `manifest.json`.