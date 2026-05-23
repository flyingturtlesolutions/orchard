# DESIGN / SPEC — "Resolve roles" (auto-fill a perspective's roles → selectors)

**Status:** v1 implemented (v2.74.352) + resolve-difficulty metric & run logging
(v2.74.353, § 7); the set-of-marks north-star in § 4 is NOT yet built — we
iterate on accuracy from v1, measured against § 7.
**Date:** 2026-05-23
**Relates to:** LOCALE_SPEC § 13 (description-first authoring), § 7 (the
picker), Landmark spec (selector synthesis + verification).

---

## 1. What it is

A second button on each **on-page** proposed perspective, next to "Use this".
Where the picker is *human clicks element → system synthesizes selector → Claude
refines*, this is the **inverse**: *Claude resolves every role → system verifies
→ human reviews.* One LLM call fills the whole perspective's roles at once;
anything Claude can't resolve falls back to the manual picker.

It complements, never replaces, the picker. Abstentions and verification
failures route to manual picking.

## 2. Operation (v1, as built)

1. Adopt the perspective (same as "Use this": set name, seed URL predicate,
   show the role checklist).
2. Gather context (§ 3) and make ONE `resolveRoles` LLM call → a selector (or
   `null`) per role.
3. For each role with a selector: create a draft landmark
   (`alias = role`, `selector`, `roleFill`, `roleMult`) and run it through the
   **existing** `verifyLocaleLandmark` — which probes the selector via
   `INSPECT_ELEMENT`, computes the multi-axis verification score, and assigns
   the canonical `uid` + a11y profile (no extra LLM call).
4. **Drop** any landmark whose selector didn't resolve / scored `mismatch` —
   that role stays unfilled (○) in the checklist for manual picking.
5. Toast a summary: *"Resolved N role(s), M need manual pick."*

Cost: **1 LLM call + N content-script `INSPECT_ELEMENT` probes** (no per-role
LLM). Result quality is gated by verification, not taken on faith.

## 3. Context fed to Claude (the accuracy surface)

- **Role spec (the query):** per role — `name`, `description`, `multiplicity`.
- **Screenshot** of the visible page (`captureVisibleTab`) as a multimodal block
  — visual prominence / which element is "the" one / what repeats.
- **Rich DOM** (`DOM_SNAPSHOT_RICH`) — real elements with durable attributes
  (id, name, aria, role, type) preserved.
- **Ground landmark registry** — alias + a11yRole + description of
  already-captured landmarks, with an instruction to **reuse** a matching
  landmark's selector verbatim (consistency + proven durability).
- **Selector-quality constraints** in the prompt: pure CSS only (no
  Playwright/Cypress/jQuery pseudos — also rejected post-hoc via
  `_looksLikePlaywrightSelector`); prefer id/data-*/aria-label/name/role/
  semantic tags; avoid nth-child chains + hashed classes; one match for
  `one|optional`, a repeating match for `many`.
- **Abstention is first-class:** `selector:null` + reason when no element
  clearly fits. A wrong selector is worse than a gap.
- Per role, Claude also returns `confidence` + a one-line `justification`.

## 4. North-star (NOT built — the iteration target if v1 accuracy is weak)

Raw selector generation is hallucination-prone. The higher-accuracy design is
**set-of-marks**: the system enumerates real candidate elements, labels them
(numbered overlay on the screenshot + a labeled inventory in text), and Claude
**chooses by label** rather than writing a selector. The system then synthesizes
the selector for the chosen element with the picker's own machinery. Claude does
semantic matching (its strength); the system owns selector synthesis +
verification (deterministic). Additional levers documented for later:

- **Region-first scoping** (coarse→fine): resolve the perspective's container
  first, then roles *within* it → smaller candidate set + container-relative
  (more robust) selectors.
- **Repetition hints** for `many` roles (mark sibling sets + their container).
- **Frame tagging** so a resolved role routes to the right `iframeContext`.
- **Verify-repair loop:** on a failed/ambiguous selector, re-ask once with the
  failure as feedback before falling back to manual.

v1 deliberately skips the labeling/overlay infra and the repair loop — it leans
on direct selectors + verification + manual fallback, which is shippable today
and gives us a baseline to measure the north-star against.

## 5. Review premise

Consistent with LLM-as-author / user-as-reviewer: the button does the bulk
resolution; verification gates what lands; the role checklist shows ✓ (resolved
+ verified) vs ○ (needs manual pick); the user reviews and fixes the gaps. The
roles still become `LandmarkNode.role` at save (the existing role→structure
synthesis).

## 6. Open questions (for iteration)

1. When v1 misses, is it bad selectors (→ set-of-marks) or bad role↔element
   matching (→ region scoping / better descriptions)? Measure before building § 4.
2. `many` roles: is one representative selector enough, or do we need explicit
   container + item? v1 trusts Claude's repeating selector + verification count.
3. Should low-confidence resolutions be auto-applied or staged for explicit
   accept? v1 applies any that *verify*, regardless of confidence (verification
   is the real gate); confidence is surfaced for the reviewer.

## 7. Resolve-difficulty metric (v2.74.353) — the measurement instrument

To rate performance and verify improvements, each page gets a deterministic
**resolve-difficulty score** (0–100, ↑ = harder), computed by a content-script
DOM scan (`computePageComplexity`, no LLM, stable per page). It's tuned to what
makes role→selector resolution hard, split into the operation's two sub-problems:

- **Synthesis channel (DOM, 60%)** — *can a durable selector be written?*
  hook scarcity (25) · class obfuscation (15) · generic-tag/div-soup ratio (8) ·
  shadow DOM & custom elements (7) · DOM scale & depth (5).
- **Matching channel (visual, 30%)** — *can Claude tell which element it is,
  given the screenshot it's sent?* off-screen-candidate ratio (18 — the
  `captureVisibleTab` screenshot only shows the viewport, so below-the-fold
  candidates get zero visual grounding) · opaque controls (12 — interactive
  elements with neither visible text nor accessible name: unrecognizable in the
  screenshot AND unhookable in the DOM).
- **Blockers (10%)** — iframes (cross-origin weighted heavier; unresolvable).

Tiers: 0–24 Simple · 25–49 Moderate · 50–74 Complex · 75–100 Severe.

**Surfaced** as a tiered, colored badge in the locale-capture header
(`🧩 Complex · 61`); the hover shows the synthesis/matching sub-scores + factor
breakdown, so when Resolve fails you can read *which channel* is the bottleneck
— which tells you whether the next iteration is set-of-marks (synthesis) or
better visual capture / region scoping (matching).

**Run logging.** Each Resolve run appends
`{ts, url, variant, rolesTotal, resolved, failed, abstained, ms, score,
synthScore, matchScore, tier}` to `chrome.storage.local` key `resolveRoles:perf`
(capped at 200). That's the data to plot success-rate vs difficulty and confirm
an iteration actually helped — not just on easy sites.

**Weights are first guesses.** They're meant to be re-tuned once real
success-vs-score data accrues; the badge + log exist precisely to gather it.

**Notable mechanism (why the screenshot is scored):** because Resolve sends
Claude a screenshot, the matching channel can *partly* compensate for a weak DOM
— but only under set-of-marks (§ 4), where Claude chooses an element visually
and the system synthesizes the selector. In v1 (Claude writes the selector), a
strong screenshot can't rescue a hook-scarce DOM, so synthesis difficulty
dominates v1 failures. The two-channel score makes that visible.

## 8. Verification feedback loop — "complete the loop" (built v2.74.356, opt-in)

After the first pass verifies each selector, re-prompt Claude with the verdicts
so it can fix what failed — the tool-feedback / reflexion pattern. Verification
failure reasons are exactly the high-signal feedback an LLM self-corrects well
from, so for *fixable* failures this is the highest-leverage v1 accuracy step.

### What goes back (one repair call)

- The original roles (name + description + multiplicity), unchanged.
- Per role, the prior attempt + verdict:
  - **resolved** → `<selector>` — marked CONFIRMED (read-only context; the
    site's working hooks, e.g. "this site keys off `id`").
  - **failed** → `<selector>` ✗ `<reason>` ("matched 0 elements" / "matched a
    `<div>`, role implies button" / "matched 7, expected one" / "not visible").
  - **abstained** → (none) + Claude's prior reason.
- The same page context (screenshot + DOM + registry).
- Instruction: return selectors ONLY for the unresolved roles; treat confirmed
  ones as fixed (do not re-emit or change them).

Then verify the repair results, merge, repeat up to **R** rounds.

### Value & its boundary (honest)

- **High** for *fixable* failures: wrong-but-on-page selector, count mismatch,
  wrong-element/type. The reason tells Claude precisely what to change, and the
  confirmed successes reveal the site's hook conventions.
- **~Zero** for *structural* failures: element in shadow DOM / cross-origin
  iframe / genuinely absent / **no durable hook exists**. Re-asking can't
  manufacture a hook → it churns or re-hallucinates. The loop's ceiling is the
  *synthesis* ceiling; set-of-marks (§ 4) is what raises it. The loop fixes
  matching + fixable-synthesis; set-of-marks fixes structural synthesis. They
  are complementary, not alternatives.

### Controls (so it converges)

- Retry only **failed + abstained** roles; keep verified successes (never
  re-verify — avoids regressing a working selector).
- **Skip unrepairable reasons** (shadow / iframe / absent) — no retry; route to
  manual.
- **Convergence stop**: a role whose repaired selector equals its prior one, or
  still fails after a round, is not retried again.
- **Cap rounds**: default R = 1.

### Latency cost (token cost ignored, per the request)

- Each repair round = ONE more LLM round-trip, **sequential** (must verify
  between rounds). Per-call latency ≈ the first pass — screenshot upload
  dominates, so fewer roles barely shrinks it. Total ≈ **(1 + rounds) ×
  T_call**.
- Verification between rounds is cheap: N content-script `INSPECT_ELEMENT`
  probes (~tens of ms), no LLM.
- R = 1 → worst case ~**2× v1 latency**, and only when fixable failures remain
  (clean first pass → zero added latency).
- **Latency lever:** auto-one-round (cost paid automatically when failures
  remain) vs **opt-in** — a "↻ Retry K failed (with feedback)" button so the
  user pays the second call only on demand. Opt-in makes the cost explicit and
  user-controlled.

### Implementation shape

Extend `resolveRoles({ …, priorAttempt })` (mirrors `proposeLocaleStructure`'s
refine arm): when `priorAttempt` is present, the prompt carries the verdicts and
asks for unresolved roles only. A driver verifies → repairs up to R, skipping
structurally-unrepairable failures, and logs per-round detail into the existing
`resolveRoles:perf` entry (so repair lift is measurable against difficulty).

### As built (v2.74.356, opt-in)

- **Chosen mode: opt-in.** After a Resolve run, if any role is still unfilled
  with a note, a **"↻ Retry K with feedback"** button appears under the role
  checklist. Each click = ONE repair round (one LLM round-trip) — the user is
  the round cap, so latency is paid only when chosen. No structural-skip
  heuristic needed (the user decides whether another round is worth it).
- `onRetryFailedRoles` gathers the still-unfilled noted roles, builds
  `priorAttempt = { confirmed:[{role,selector}], attempts:[{role,selector,reason}] }`
  (confirmed = the working landmarks; attempts = each failed/abstained role's
  prior selector + reason), and routes through the shared `_runResolve` driver
  (same create→verify→drop→note→log path as the initial pass, `mode:'repair'`).
- A repaired role clears its note and lights ✓; a still-failing one updates its
  note with the new reason. Run logged to `resolveRoles:perf` with `mode`.
- `resolveRoles` (service) gains the `priorAttempt` arm: confirmed selectors are
  shown as site-convention guides (not re-emitted); each attempt's prior
  selector + failure reason is fed back asking for a corrected selector.
