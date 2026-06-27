# DESIGN — LLM privacy boundary (data egress to the model)

**Status:** §3 minimization STARTED (the interrogator answer-shaper, v2.74.1267, sends a minimized projection — no record bodies). §4 redactor + §5 local-tier are SPEC. This doc is the system-of-record for *what user/customer data leaves the device for the LLM, and how it's bounded.*

Companion to `DESIGN_injection_boundary.md`. **They solve different problems and must not be conflated** (see §2).

---

## 1. The boundary

Every model call goes through `AnthropicService.#call` → the LLM. Destination is either the **direct** Anthropic API (`api.anthropic.com`, the user's own key) or the **managed proxy** (the Orchard API Gateway, referenced in `proposeRichIntents`). So the data's recipients depend on mode: Anthropic always; Orchard cloud additionally under the managed proxy. Anything assembled into a `#call` payload **crosses the device boundary**.

The local `Logger` PII-scrub protects *logs* (which stay local) — it is the opposite direction and **never touches the `#call` payload**.

## 2. The load-bearing invariant: **fencing ≠ redaction**

The `<RECORD>` / `<RECENT_TURNS>` / `<SUB_TASKS>` / `<FINDINGS>` wrappers are **injection** safety ("data, not instructions") per `DESIGN_injection_boundary.md`. They do **NOT** remove PII — they wrap it. A fenced block is injection-*safe* and privacy-*exposed* at the same time. There is currently **no PII-redaction layer before `#call`**: the only "sanitize" steps in `AnthropicService` are on the model's *output* and on *DOM structure*. So everything in §3 reaches the model as raw content.

> Injection boundary protects *us from the data*. Privacy boundary protects *the data from egress*. Both are required; neither implies the other.

## 3. The egress map (what crosses, by sensitivity)

| # | Channel | Source (code) | Sensitivity | Minimized? |
|---|---|---|---|---|
| 1 | **Connector read content** | `_childReadItem` → `<RECORD>` into the IL_ANSWER seed (`chat.js`); the `respond/research #X` path | **PII** (names, emails, ticket/order bodies) | the **answer-shaper** (v2.74.1267) now sends `{id,title,status}` only — **bodies no longer leave** for the interrogator path; the `<RECORD>` reasoning path is NOT yet minimized |
| 2 | **Conversation history** | `selectRecentTurns` → `<RECENT_TURNS>` into interpret+answer (`Core/recentTurns.js`, Q1) | **private** (incl. re-sent echoes of prior reads) | bounded (6 turns × 300 chars); content **not** redacted |
| 3 | **Fan-out results** | `<SUB_TASKS>` (`Core/childContext.js`) · `<FINDINGS>` (`_runEphemeralFanout`) | **PII** (per-item read content) | no |
| 4 | **Typed memory + seed** | `learned` / `objects` / `seed` in `buildAnswerMessages` / `buildInterpretMessages` | **mixed** (instance memory can hold private facts) | preset rules are abstracted (distill-up); instance memory is raw |
| 5 | **DOM snapshots** | `domSnapshot.slice(0,12000)` in `resolveRoles` / `synthesizeGoals` | **PII** (on-page names/emails) | structurally "sanitized", not PII-redacted |
| 6 | **The ask** | every router call (`routeAsk`, `interpret`, `matchWorkflow`, `extractFanoutSpec`, `shapeAnswer`) | **low–PII** ("search tickets for john@x.com") | no |

**Implication for the embodiment debate:** the privacy concern was never embodiment-gated — Orchard *already* sends customer PII to the model whenever it reasons over a read (#1, #3, #5). Redaction is a **current-state** need.

## 4. The levers (in priority order)

**(a) Minimization — STARTED.** Send the *shape-relevant projection*, not the raw dump. The answer-shaper (`Core/answerShapePrompt.js → readShapeFacts`) is the first instance: a count question gets `count + {id,title,status}` sample, never the 25 full records. **Extend to #1, #3** — the `<RECORD>`/`<FINDINGS>` paths should send the minimum the task needs, not the full rendered record.

**(b) Pre-`#call` redactor — THE structural fix (SPEC, §5).** A single pass at payload assembly that pseudonymizes PII inside the data-fenced blocks. One choke point covers #1–#5 at once. This is the highest-leverage item.

**(c) Local-model tier — SPEC.** A per-app / per-Ground policy that routes the most sensitive shaping to an on-device model so PII never leaves. The escape hatch where redaction isn't enough. Hooks into the existing `ROLE_MODEL_POLICY` tiering.

**(d) Disclosure & consent — POLICY (not solvable in code).** Be explicit about *what leaves the device*. For customer data specifically, the org needs a data-use sign-off (the data was collected for fulfillment/support, not for a model). Surface this; do not pretend the architecture resolves it.

## 5. The redactor — slice plan

The choke point is `#call`-adjacent (payload assembly), so it covers every channel in §3 uniformly.

- **R-1 (pure):** `Core/redact.js` — `redact(text, {map}) → {text, map}` and `restore(text, map)`. Detect emails, phone numbers, and a supplied name-set; replace with stable pseudonyms (`⟦person_1⟧`, `⟦email_1⟧`) backed by a **local, in-memory** reversible map (never persisted, never sent). PURE + tested.
- **R-2:** apply `redact` to the data-fenced blocks (`<RECORD>`, `<RECENT_TURNS>`, `<SUB_TASKS>`, `<FINDINGS>`, the shaper sample) **before** `#call`; carry the map for the duration of the call.
- **R-3:** `restore` on the model's *answer* before it reaches the panel (so the user sees the real name, the model never did). De-pseudonymization is local-only.
- **R-4:** a per-Ground toggle (`redactPII: on|off`) + an honest indicator that redaction is active. Default-on for connector-backed (CS) Grounds.
- **Open questions:** which PII classes (start: email/phone/explicit name-set from the read's own fields); reversible vs one-way (reversible needed so the answer can name the right person); the name-set source (the read's `name`/`requester` fields are the cheap seed).

**Note the residual:** pseudonymization defeats *identity* leakage, not *content* leakage — a ticket body's substance still goes to the model. For content-sensitive cases, (c) local-tier is the only full answer.

## 6. Built vs owed

- **Built (v2.74.1267):** minimization on the interrogator answer-shaper — record **bodies no longer leave** for "how many / which / is there" questions; `readShapeFacts` sends `{id,title,status}` + an exact code-computed count.
- **Owed:** the §5 redactor (highest leverage), minimization on the `<RECORD>`/`<FINDINGS>` reasoning paths, the local-model tier, and the disclosure/consent posture.
