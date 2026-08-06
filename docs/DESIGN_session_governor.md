# DESIGN — Session Governor (SGV): session health without an attention sink

**Status: spec v1.13 (2026-08-06).** Review pass R1–R7 (lane-663f critical review): `watching` never overrides
the steal gate · LLM pack fenced + `relink` behind the focus gate · SGV-4 teardown scoped to the CN-1.1 sites ·
expansion-pass prerequisite (the v1.4 lesson) · pulses presence-gated · `connect_ui_visits` dev-scoped.
Prior seal (v1.12, Loop5 B1–B3 +nit): fire-level `presenceStop` · `_orchRunChain`
return contract · origin-scoped fire-hold · `presenceToken(error)` binding.

**Loop history:** v1.7 W1–12 · v1.8 X1–8 · v1.9 Y1–7 · v1.10 Z1–6 · v1.11 A1–5 · v1.12 B1–3 · **v1.13 R1–7**.  
Companions: `DESIGN_vitals.md`, `DESIGN_connectors.md` §14–§16, `DESIGN_injection_boundary.md`,
`DESIGN_cadence.md`, `DESIGN_workflows.md`.  
**Product law:** if the user is managing sign-in, Orchard has already failed. Connect chore rejected.

---

## 1. Closed loop

`sessionGovernorTick` @ end of `vitals:tick` (+ SW wake).  
Plan: `Core/sessionGovernor.js`. Apply/verify: `vitals.js`. Markers `SGV ▸` → `_DECISION_RE`.

Tick: snapshot → tickLedger (CSRF_PREWARM/`kaPlan`) → plan → execute (≤3 heals, ≤1 new verifying;
extras deferred) → verify in-flight. Leases: `chrome.storage.local` `sgv:state`; reattach/reap.

---

## 2. Plan + demand

```
Plan = { heals≤3, dueNudges≤1, chainResumes≤1, llmCalls≤1, interrupts≤1 }
Heal.verb ∈ probe|warm|keepalive|focus|drive_assist|relink|escalate_secret|noop
Nudge = { blockedRunId, workflowId }
ChainResume = { blockedRunId, convId, askId? }
LlmCall = { origin, allowedVerbs, pack≤2KB }
```

STATUS: `fresh|stale|signed-out|wrong-account|unknown` only.  
workDemands = blocked ∪ activeAsks ∪ due within PREWARM_HORIZON (25min).  
activeAsks: cap 4, PING RAM TTL+pingSeenAt, chain grace needs recent ping.  
originsFromWorkflow: groundId→groundHostIndex(Ground.url) ∪ real via.host; no system aliases.  
Priority: oldest parkedAt for nudges/chainResumes; one heal per origin.  
incidentId: `block:${runId}` | `ask:${id}` | `due:${workflowId}:${origin}` | `scope:${origin}:${utcDay}`.  
userActiveOn: `SGV_USER_TOUCH` 5min primary; lastAccessed ≤60s secondary.

---

## 3. Contested + pass-through

`DRIVE_STALL_STEPS = 3`. Contested / give_up / LLM pack (≤1/tick, 4s → mechanical) as prior.  
**Pack fencing (R2):** the pack is page-derived → FENCED DATA (`DESIGN_injection_boundary.md`) — a verb outside
`allowedVerbs`, or ANY pack-derived selector/URL/param, is discarded; drive micro-ops are UrlClass-TEMPLATE-driven,
never page-text-driven.  
UrlClass: `app|login_identify|login_password|sso|mfa|captcha|password_reset|other`.  
rideSignals; warmAt. Mechanical defaults as prior.

**Pass-through:** never collapse wrong-account → signed-out/not-logged-in on PRESENCE_CHECK state,
headless `error` + `reportAuthSignal`, or interactive error.

---

## 4. Heal catalog

| Verb | Precondition | Effect | Verify | On fail |
|---|---|---|---|---|
| probe | demand; budget; !ledger | identity probe | determinate | streak; contested≥2 |
| warm | csrf host; budget; !ledger | CSRF_PREWARM | not csrf-cold | →probe |
| keepalive | KA §6; !ledger | cheap touch | lastVerifiedAt | backoff |
| focus | focus gate | CONN_FOCUS — **only** FG steal | app\|FRESH\|secret | →drive |
| drive_assist | workDemands; drive table | micro-ops; busy-mark | progress\|secret\|FRESH | stall→escalate |
| relink | brokerDead; **focus gate (R2 — a consent flow IS a FG steal)** | LINK_CONNECTOR | linked\|abandoned | escalate/cooldown |
| escalate_secret | joinKey | stage + §8; watching | FRESH | give_up |
| noop | — | — | — | — |

Resume = `dueNudges` / `chainResumes` only (not Heal verbs).

**Focus gate:** workDemands via blocked|activeAsk; signed-out|wrong-account|login_*; !userActiveOn —
**`watching` never overrides it (R1)**: a foreground steal while the user is active is the attention sink
returning with interest; idle is judged across ALL windows, not the target tab; prevention tried for incident OR
determinate auth status.

**brokerDead:** broker/MCP token missing|401; LINK required; OAuth refresh fail — not site cookie.

**Interactive INVOKE:** always presence fail-fast (no `_waitForReauth`). Only `focus` heal foregrounds.

**Lease** `sgv:state[origin]`: phase `idle|verifying|watching|cooldown`, verb, startedAt, deadlineAt+90s,
tabId, verifyFailStreak, driveSteps, lastProgressAt, warmAt, watchingSince, cooldownUntil,
lastHealVerb, lastIncidentId, triedProbeAt, triedWarmAt, userTouchAt.

**Drive:** `Core/sgvDriveTable.js`. Progress ≤15s UrlClass/landmark/FRESH.

---

## 5. Blocked runs — fail→block

### 5a. PresenceCtx on step + fire (B1)

Step result embeds:

```
{
  ok, stop?, error?, origin, hint?, csrf?, httpStatus?, authStatus?, probeStatus?
}
```

`csrf` attached from `leg.tool` / recipe at rideStep.  
`rideStep` sets `stop:true` when presence; `runDriver` honors `stop` or recomputes predicate.

**Fire-level (required for Door A / advance):** `runDriver` / `_fire` result includes:

```
presenceStop: null | PresenceCtx   // set when halted for presence; full ctx, not error string only
verdict: 'ok'|'partial'|'failed'|…
failedStep?: { i, text, error }
```

Door A upsert and “do not `_advance` as success” gate on **`presenceStop != null`**, not on
re-parsing `failedStep.error`.

### 5b. Predicate + token binding (nit)

```
presenceToken(error) ≜ first match in error string (lowercased) among:
  wrong-account > not-logged-in > session-expired > no-authenticated-tab
  > http-401 > http-403 > reauth > unauthorized|unauthorised
  else null

isCsrfCold(ctx) ≜ isCsrfColdFailure({ error, hint, csrf })
authClass(ctx) ≜ authStatus|probeStatus|registry[origin].status ∈ {signed-out, wrong-account}

isPresenceBlockReason(ctx) ≜
  !isCsrfCold(ctx) AND (
    presenceToken(error) ∈ {not-logged-in, wrong-account, session-expired, no-authenticated-tab, reauth, unauthorized}
    OR (presenceToken ∈ {http-401, http-403} AND authClass(ctx))
  )
```

Bare 401/403 without authClass → not block. CSRF-cold → warm only.

**Transient:** extend with wrong-account|session-expired; bare http-401/403 transient **only if**
authClass (same carve-out).

### 5c. headlessWrite

First presence from invoke → `{ ok:false, stop:true, …PresenceCtx }` — never soft `ok:true` with failed++.

### 5d. Fire-hold — origin-scoped (B3) until ack (A1)

```
autoHeld(workflowId, wf) ≜
  ∃ open kind:workflow block B where
    B.workflowId == workflowId
    OR originsFromWorkflow(wf) intersects B.blockedOrigins
```

While `autoHeld`: skip cadence auto `_fire` **and** panel due-on-open auto-run.  
**FRESH does not lift hold.** Only ack clear / blocked-expired / abort lifts.  
Explicit user ▶ allowed (ack path when all origins FRESH at start).

### 5e. Writers

Sole SW `upsertBlocked`. Merge by workflowId / convId; preserve nudgeCount/cooldown; runId=last failure.  
Door A when `presenceStop` on cadence fire (failed|partial). Connector attaches only. Fleet sans wf → skip.

Door B: same `isPresenceBlockReason(ctx)`. wrong-account → Switch-account framing.  
Sites: chain auth stop; PRESENCE_CHECK proceed===false non-readOnly; include chainPark.

### 5f. MARK_RAN

Only terminal **non-presence success** of a real run. Ack clears hold/block; **never** MARK_RAN on ack alone.

### 5g. Panel chain return contract (B2)

```
_orchRunChain(…) → {
  ok: boolean,                 // true only if finished without presenceStop
  presenceStop?: PresenceCtx,  // set on auth stop / Door B
  /* existing fields */
}
```

Auth-stop paths **must not** return `undefined` indistinguishable from success.

Gate **every** success `.then` on `result.ok && !result.presenceStop`:
- Automate ▶ / `_runWorkflow`
- due-on-open auto-run
- remember-workflow / replay twin (~chat.js remember path)

On presenceStop: no all-chips done; no success pin bank; history `blocked`/partial-with-reason; Door B upsert.

### 5h. Nudge, ChainPark, attention

`SGV_NUDGE_DUE { blockedRunId, workflowId, nudgeAt }`.  
Ack clear when executor starts and all blockedOrigins FRESH → `SGV ▸ resume-ack …`.  
Normal reporter only; forbid makeResumeReporter.  
ChainPark: Continue until auto-continue (SGV-1b); `SGV_CHAIN_RESUME` ≤1/tick independent.  
Door A presence-block: suppress cadence OS toast **and** failed badge/title — SGV pulse only.

---

## 6. Budgets + KA

Local `dayKey`. Caps: ephemeral 6 · probes 48 · keepalives 24 · driveSteps 40 · llm 12.  
Keepalive iff workDemand | `kaBook.on===true`. Quiet 00:00–06:00 local.

---

## 7. secretRequired

UrlClass `password_reset|captcha|mfa|login_password` · secret fields · IdP MFA · stall · login_identify&gt;60s.  
Never type secrets.

---

## 8. Interrupt + pulse

```
{ id, origin, label, framing: 'sign-in'|'switch-account', convId?, workflowId?, focusedTabId?, at }
```

Pulse ≤1/join/30min; toolbar if panel opened since block; else OS; never Connect.
**Presence-gated (R5):** pulse only when `userActiveOn`-recent — a 3am OS toast burns the scarce budget on a
sleeping human; otherwise hold for the toolbar badge at next panel-open (quiet hours §6 cover interrupts too).

---

## 9. Migration

| Step | Change |
|---|---|
| **SGV-0** | Planner + tickLedger + activeAsks + vitals no-op apply |
| **SGV-1** | PresenceCtx+fire presenceStop · predicate · halt · headlessWrite · origin fire-hold · MARK_RAN · chain return · Door A/B · pass-through · transient · leases · nudge · toast+badge suppress |
| **SGV-1b** | ChainPark + SGV_CHAIN_RESUME |
| **SGV-2** | Interrupt + pulse |
| **SGV-3** | Drive + UrlClass + LLM |
| **SGV-4** | Retire Connect chore — **scoped teardown (R3, the §8.4-style inventory rule applied to removal):** chat.js `_updateTabDots`' Connect leg (`VITALS_BADGE`-driven dot, CN-1.1) dies; `_tabAttention` roll-up keeps pending+parked only; `_renderConnect`/`_connectCard` fold to dev render; desk chips re-point (pulses go toolbar/OS, never Connect) |

Interim: Connect = dev/debug only.

---

## 10. Metrics

`SGV ▸ heal|verify|escalate|nudge_due|resume-ack|chain-resume|budget-exhausted|blocked-expired|interrupt-pulse`;  
`connect_ui_visits` (**counted only when `!_devModeEnabled` — the operator debugging in dev must not fail the
user-metric, R6**); `presence_fail_runs` (**per-incident dedup, R7 — a burst morning of one SSO rotation must not
dominate the residual**).  
Pass bar 7d: connect visits 0; presence fails ≤50% baseline; no blocked &gt;24h without ack/abort.

---

## 11. Build order

0. **Expansion pass (R4, prerequisite)** — inline every "as prior"/"as before" in this file before SGV-0: the
   v1.4 seal records this spec once LOSING machinery to its own compression; an implementing session must not
   need git archaeology across 13 revisions to resolve a contract term.  
1. SGV-0 — planner tests + no-op fold. **Wire the §10 metrics onto the glf bus as tests at SGV-1** — the pass
   bar's arms are pre-registered predictions in everything but format; the loop that graded the census grades
   the governor.  
2. SGV-1 — full presence pipe + hold + doors + ack.  
3. SGV-1b — ChainPark.  
4. SGV-2 — interrupt + pulse.  
5. SGV-3 — drive + LLM.  
6. SGV-4 — retire Connect.

---

## 12. Revision history (durable)

Spec iterated 2026-08-05 → 2026-08-06. Living contract is **this file @ v1.13**. Findings also in
`logs/run/findings.md` (local); canvases under Cursor project `canvases/sgv-*.canvas.tsx` are review
artifacts, not the source of truth.

| Ver | Date | Seal |
|---|---|---|
| v1 | 08-05 | Loop program, heal catalog, secret/resume/budget/Connect kill list |
| v1.1 | 08-05 | S1–S9 work-demand, verify lease, contested signals, nudge-only resume, drive policy |
| v1.2 | 08-05 | activeAsk, originsFromWorkflow, heal priority, interrupt wire, LLM pack |
| v1.3 | 08-05 | R1–R10 KA opt-in, nudge≠heal cap, activeAsks map, groundId-only, pulse, RAM ping |
| v1.4 | 08-05 | Restore machinery collapsed by “as before” (heal edges, lease, blocked schema) |
| v1.5 | 08-05 | V1–V12 fail→block (not write-park), Door A+B, `SGV_NUDGE_DUE`, STATUS enum |
| v1.6 | 08-06 | Resume join by workflowId, `SGV_CHAIN_RESUME`, `isPresenceBlockReason` |
| v1.7 | 08-06 | W1–W12 ChainPark honesty, auth stop, fresh-only ack, no write-park reporter |
| v1.8 | 08-06 | **Loop1** X1–X8 CSRF≠presence, fail-fast first, halt map, toast suppress |
| v1.9 | 08-06 | **Loop2** Y1–Y7 authClass, partial Door A, fire-hold, badge suppress, in-file again |
| v1.10 | 08-06 | **Loop3** Z1–Z6 all-auto hold, PresenceCtx fields, MARK_RAN defer, Door B=predicate |
| v1.11 | 08-06 | **Loop4** A1–A5 hold-until-ack, headlessWrite stop, panel≠success, transient∩authClass |
| v1.12 | 08-06 | Loop5 B1–B3 fire `presenceStop`, `_orchRunChain` return, origin-scoped hold |
| **v1.13** | **08-06** | **Review pass** R1 watching≠steal-override · R2 pack fenced + relink gated · R3 SGV-4 teardown scoped (CN-1.1 sites) · R4 expansion-pass prerequisite · R5 pulses presence-gated · R6 dev-scoped visits metric · R7 burst dedup (review: lane-663f; full text in that session's transcript) |

### 12b. Non-goals (frozen)

- Connect tab as user heal surface (dev/debug until SGV-4).  
- Orchard inventing passwords/OTP.  
- SGV calling the run engine (`nudge_due` / `SGV_CHAIN_RESUME` only).  
- Reusing `cadence:parked` / `WORKFLOW_PARKED_CHANGED` / `WORKFLOW_DUE_CHANGED` for presence.  
- `makeResumeReporter` on presence resume.

### 12c. Code touch list (when implementing)

| Area | Files (expected) |
|---|---|
| Planner | `Core/sessionGovernor.js` (+ tests) |
| Apply | `background/handlers/vitals.js` |
| Halt / ctx | `Core/rideStep.js`, `Core/runDriver.js`, `Core/headlessWrite.js` |
| Door A | `background/handlers/cadence.js`, connector attach |
| Door B / chain | `chat.js` (`_orchRunChain` return, auth matcher, MARK_RAN) |
| Pass-through | `background/handlers/connections.js`, `connector.js` |
| Transient | `Core/trigger.js` |
| Markers | `studio.js` `_DECISION_RE` / `Core/decisionMarkers.js` |
| Drive / UrlClass | `Core/sgvDriveTable.js`, `Core/sgvUrlClass.js` (SGV-3) |
