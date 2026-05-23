# DESIGN / SPEC — LLM-call role framework

**Status:** v1 built (v2.74.358): audited call path + core-pipeline role labels +
Studio "LLM" audit tab. Long-tail methods audit as `unclassified` until labeled.
**Date:** 2026-05-23
**Relates to:** every `AnthropicService` method; DESIGN_resolve_roles.md (the
per-role outcome log `resolveRoles:perf` is the prototype this generalizes).

---

## 1. The problem

Every LLM call went through one generic `#call(systemPrompt, userContent,
maxTokens)`. That erases *intent* and *accountability*: you cannot ask "is this
call working?" without reading the method, and there is no uniform record of
what the LLM is doing across the system. New calls can be added with no defined
notion of correctness — the "send x to Claude, hope for the best" anti-pattern.

## 2. The spine: a call's ROLE = who/what judges it correct

Calls differ less by *what they emit* than by **who or what judges correctness**,
which determines the feedback we can capture. That judge-axis is the framework's
organizing principle and the thing that makes the layer auditable.

| Role | What Claude does | "Correct" judged by | Feedback captured | Output |
|------|------------------|---------------------|-------------------|--------|
| **propose** | generate candidate artifacts for review | the **user** (accept/edit/reject) | `userJudgment` rate (LOCALE_SPEC § 5) | JSON candidates |
| **resolve** | bind an abstract ref → a concrete page artifact | **deterministic verification** | verify pass-rate (`resolveRoles:perf`) | JSON selectors/anchors |
| **describe** | summarize / derive metadata about a thing | **soft** (staleness / override / review) | override rate, staleness | prose / JSON |
| **plan** | choose the next step in an execution loop | **execution outcome** | step-advanced, turns-to-done | JSON action |
| **extract** | pull structured values from captured content | **schema + spot-check** | yield / validity | JSON values |
| **classify** | pick from a bounded set / boolean | **threshold / match** | confidence, correction rate | enum / bool |

Modifier — **refine/repair**: re-run with the prior output + its verdict
(verification result or user judgment). Inherits the base role's judge; audited
as the base role with `operation` suffixed (e.g. `resolveRoles:repair`).

### Discipline rule

Every LLM call declares `{ role, operation }`. A call that can't name its judge
is the smell this framework exists to catch. Un-labeled calls are NOT blocked —
they audit as **`unclassified`** and surface in the Studio "LLM" tab, i.e. the
backlog is *visible* rather than silent. "No role ⇒ shows up as debt."

## 3. Current role → operation map

- **propose:** `proposePerspectives`, `proposeLocaleStructure` (+`:refine`),
  `suggestLocale`, `proposeFragmentConditions`, `generateDetectConditions`,
  `composeAssertion`
- **resolve:** `resolveRoles` (+`:repair`), `suggestSelector`, `discoverAnchors`
- **describe:** `deriveGroundDescription`, `generateLandmarkProfile`,
  `summarizeSite`, `generateSampleQuestion`, `generateProfileQuestions`,
  `generateTaskProfile`, `generateConversationTitle`
- **plan:** `getNextStep`, `getNextTaskStep`, `generateTemplate`,
  `invokeAnalysisRecovery`, `invokeAnalysisFrontierPrimary`,
  `invokeObservationFrontier`, `proposeNextStep`
- **extract:** `extractSectionItems`, `readImage`, `extractStrategyParams`
- **classify:** `classifyPage`, `matchQuestionToGround`, `isResponseComplete`

(v1 labels the Locale/Resolve/Propose/Describe pipeline; the rest read as
`unclassified` in the audit tab until labeled.)

## 4. The audited call path

`#call` is wrapped so every invocation is recorded — independent of whether the
caller labeled a role (so coverage is 100% from day one):

```
#call(systemPrompt, userContent, maxTokens, extraMessages = [], meta = null)
  → t0 = now
  → result = fetch(...)               // unchanged
  → #audit({ ts, role: meta?.role ?? 'unclassified',
             operation: meta?.operation ?? 'unknown',
             latencyMs, ok, outputChars, model })
  → return result
```

- **Audit record** (lean — latency, not tokens, per the project's cost stance):
  `{ ts, role, operation, latencyMs, ok, outputChars, model }`.
- Stored in `chrome.storage.local['llm:audit']`, capped ring (300). Writes are
  serialized through an in-memory promise chain so concurrent calls don't
  clobber the ring (best-effort; cross-context races tolerated).
- **Layering:** this is the *generic* record (volume/latency/ok per role).
  Role-specific OUTCOME logs sit on top, written by the consumer —
  `resolveRoles:perf` (verify pass-rate) is the exemplar. A future
  `propose:perf` could log accept/edit/reject the same way.

## 5. Studio "LLM" tab

Generalizes the "Resolve" tab to all calls:
- **By role:** calls, avg + p95 latency, ok-rate, last seen. Plus an
  `unclassified` row = the labeling backlog.
- **By operation:** same, drill-down.
- **Recent calls** table.
- Refresh / Copy JSON / Clear.

## 6. Why this is low-risk

It *names + unifies patterns that already exist* (propose→userJudgment,
resolve→verification, describe→staleness) rather than changing call behavior:
`#call`'s request/response is untouched; the wrapper only times + records. Role
labels are additive metadata. The migration can be partial without losing audit
coverage — the worst case for an unmigrated method is an honest `unclassified`
row.

## 7. Open questions

1. Role-specific outcome logs beyond `resolveRoles:perf` — do we add
   `propose:perf` (accept/edit/reject) next, given the §5 judgments already
   exist? Likely yes; it's the highest-value second consumer.
2. p95 vs avg latency, retention window (300 cap?), and whether to bucket
   latency by role for SLOs.
3. Should `plan` calls (which have side effects — navigate/click) carry a
   risk/reversibility tag distinct from the read-only roles?
