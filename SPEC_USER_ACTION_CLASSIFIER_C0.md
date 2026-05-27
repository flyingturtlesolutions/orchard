# SPEC — User action classifier slice C0 (pure L2)

**Status:** Implementation spec for slice C0.  
**Date:** 2026-05-26  
**Implements:** `DESIGN_user_action_classifier.md` §6 (L2 only)  
**Module:** `Core/userActionClassification.js`  
**Tests:** `Core/userActionClassification.test.js` (`node --test`)

---

## 1. Scope

| In C0 | Out of C0 |
|-------|-----------|
| Type constants + validation helpers | Content-script observation (C2) |
| `semanticVerb(interactionKind, role?)` | Resolver / hit-test (C3) |
| `classifyResolved(resolved, context)` | Background pipeline (C4) |
| `classifyUserAction(resolved, context, opts?)` | Outcomes wiring (C5) |
| `rankMatches(matches, context)` | Consent UI (C6) |
| Golden unit tests | Inference |

**Dependency rule:** `Core/userActionClassification.js` imports only `Core/outcomes.js`
(`mintEventId` for event ids). No `chrome`, no `Services/*`.

---

## 2. Public API

```javascript
// Constants (Object.freeze)
export const CLASSIFICATION_SCHEMA;      // 1
export const INTERACTION_KINDS;          // string[]
export const RESOLUTION_STATUSES;        // hit | ambiguous | miss | suppressed
export const CLASSIFICATION_TIERS;       // substrate | browser | unresolved
export const UNRESOLVED_REASONS;         // miss | suppressed | no-ground | no-demand
export const SEMANTIC_VERBS;             // full enum of emitted verb strings
export const ROLE_SEMANTIC_VERB_MAP;     // role → { interactionKind → verb }

// Pure functions
export function semanticVerb(interactionKind, role);
export function selectorSpecificityScore(selectorUsed);
export function scoreMatch(match, context);
export function rankMatches(matches, context);
export function classifyResolved(resolved, context);
export function classifyUserAction(resolved, context, opts);
export function validateRawUserEvent(raw);
export function validateResolvedUserEvent(resolved);
```

---

## 3. Input contracts

### 3.1 `ResolvedUserEvent` (from L1 — mocked in tests)

| Field | Required | Notes |
|-------|----------|-------|
| `raw` | yes | See `RawUserEvent` |
| `groundId` | no | `null` → `no-ground` |
| `resolutionStatus` | yes | One of `RESOLUTION_STATUSES` |
| `matches` | yes | Array (empty allowed) |
| `activePerspectiveIds` | yes | Array of strings |

Each match:

| Field | Required |
|-------|----------|
| `landmarkUid` | yes |
| `perspectiveId` | yes |
| `selectorUsed` | yes |
| `confidence` | yes | 0–1 from resolver; used as tie-break fraction |
| `role` | no |

### 3.2 `RawUserEvent` (minimal for C0)

| Field | Required |
|-------|----------|
| `id`, `ts`, `tabId`, `frameId`, `url` | yes |
| `interactionKind` | yes | Must be in `INTERACTION_KINDS` |

### 3.3 `ClassificationContext`

| Field | Required | Default |
|-------|----------|---------|
| `groundId` | no | From `resolved.groundId` |
| `activePerspectiveIds` | no | `resolved.activePerspectiveIds` |
| `acceptedPerspectiveIds` | no | `[]` |
| `recentEvents` | no | `[]` — last classified events for tie-break |
| `siteMapNode` | no | `{ archetypeId, urlPattern }` for `page` enrichment |

---

## 4. Classification decision tree (normative)

Evaluate **in order**; first match wins.

```
1. resolutionStatus === 'suppressed'
   → tier: unresolved, reason: suppressed

2. groundId == null (resolved and context)
   → tier: unresolved, reason: no-ground

3. interactionKind === 'navigate' OR interactionKind === 'tab-activate'
   → tier: browser
   → browserContext: navigate | tab-switch

4. resolutionStatus === 'miss'
   → tier: unresolved, reason: miss

5. resolutionStatus === 'ambiguous' AND matches.length >= 1
   → tier: substrate
   → candidates: rankMatches(matches), each with semanticVerb + score
   → primary: candidates[0] (top score; no separate primary field rule)

6. resolutionStatus === 'hit' AND matches.length >= 1
   → tier: substrate
   → primary: top of rankMatches(matches)

7. Else (empty matches on hit/ambiguous — resolver bug)
   → tier: unresolved, reason: miss
```

**Note:** `navigate` / `tab-activate` are **browser tier** even when `matches` non-empty.
Resolver may still attach matches for logging; classifier ignores them for tier.

---

## 5. `semanticVerb(interactionKind, role?)`

### 5.1 Algorithm

1. Normalize `role` → lowercase trim; empty → undefined.
2. If `role` defined and `ROLE_SEMANTIC_VERB_MAP[role][interactionKind]` exists → return it.
3. Else return **base verb** from table:

| interactionKind | base verb |
|-----------------|-----------|
| `click` | `click` |
| `dblclick` | `dblclick` |
| `type` | `type` |
| `submit` | `submit` |
| `focus` | `focus` |
| `blur` | `blur` |
| `scroll-into` | `scroll-into-view` |
| `navigate` | `navigate` |
| `tab-activate` | `switch-tab` |
| unknown | `unknown-interaction` |

### 5.2 Initial role map (v1)

| role | click | type | submit | focus |
|------|-------|------|--------|-------|
| `search-query` | — | `enter-search-query` | — | `focus-search-query` |
| `search-submit` | `submit-search` | — | `submit-search` | — |
| `primary-action` | `activate-primary-action` | — | — | — |
| `secondary-action` | `activate-secondary-action` | — | — | — |
| `result-link` | `select-result` | — | — | — |
| `navigation-link` | `follow-link` | — | — | — |
| `add-to-cart` | `add-to-cart` | — | — | — |
| `email-input` | — | `enter-email` | — | `focus-email` |
| `password-input` | — | `type` | — | `focus` |
| `quantity-input` | — | `enter-quantity` | — | — |

Unknown role → base verb only. Map is **data**, not LLM.

---

## 6. `rankMatches` scoring (normative)

Total score = sum of components (higher wins).

| Component | Points | Condition |
|-----------|--------|-----------|
| Active perspective | +1000 | `perspectiveId ∈ activePerspectiveIds` |
| Selector specificity | +0–300 | `selectorSpecificityScore(selectorUsed) * 100` |
| Resolver confidence | +0–100 | `Math.round(confidence * 100)` |
| Recency | +0–50 | `perspectiveId` equals `recentEvents[last].classification.primary.perspectiveId` |

Sort descending by score; stable sort by `landmarkUid` lexicographic on tie.

### 6.1 `selectorSpecificityScore(selector)`

Heuristic on selector string (0.0–3.0):

| Condition | Score |
|-----------|-------|
| `#id` or `[id="` or `[id='` | 3.0 |
| `[role=` | 2.5 |
| `[aria-label=` or `[name=` | 2.0 |
| `:nth-` or `:nth-child` | 0.5 |
| otherwise | 1.0 |

---

## 7. Output: `ClassifiedUserEvent`

```javascript
{
  id: string,              // opts.id ?? mintEventId(seed)
  ts: number,              // raw.ts
  tabId: number,           // raw.tabId
  groundId: string | null,
  interactionKind: string,
  resolutionStatus: string,
  matches: [...],          // passthrough
  activePerspectiveIds: [...],
  classification: UserActionClassification,
  schema: 1,
}
```

### 7.1 `page` enrichment

When `context.siteMapNode.archetypeId` present:

```javascript
page: {
  archetypeId: context.siteMapNode.archetypeId,
  activePredicateSummary: `${activePerspectiveIds.length} perspective(s) active`,
}
```

Only when `activePerspectiveIds.length > 0` or archetype present.

---

## 8. Test matrix (required)

| # | Case | Expect tier | Expect primary/candidates |
|---|------|-------------|---------------------------|
| T1 | hit, 1 match, search-query type | substrate | `enter-search-query` |
| T2 | hit, role unknown, click | substrate | `click` |
| T3 | ambiguous, 2 matches, one active | substrate | top = active perspective |
| T4 | miss | unresolved | reason miss |
| T5 | suppressed | unresolved | reason suppressed |
| T6 | no groundId | unresolved | reason no-ground |
| T7 | navigate, with matches | browser | no primary |
| T8 | tab-activate | browser | tab-switch |
| T9 | semanticVerb role map | — | table-driven |
| T10 | rankMatches stability | — | same input → same order |
| T11 | hit + recentEvents tie-break | substrate | recent perspective wins |
| T12 | empty matches + hit status | unresolved | miss |

---

## 9. Run tests

```bash
node --test Core/userActionClassification.test.js
```

No npm required. CI can add this as a single command.

---

## 10. Done criteria

- [ ] All exports in §2 present
- [ ] Decision tree §4 matches implementation line-for-line
- [ ] All tests T1–T12 pass
- [ ] No imports outside `Core/outcomes.js`
- [ ] `DESIGN_user_action_classifier.md` §6 references this spec for L2 detail
