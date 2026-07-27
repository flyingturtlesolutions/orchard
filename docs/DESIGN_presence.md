# DESIGN_presence.md — session presence: one belief, event-invalidated, checked where it matters

**Status:** spec (v2.74.1837). Nothing below is built. PR-0 is the live bug; the rest is the model it implies.

---

## 1. The problem, from the traces

Two failures, four days apart, same root.

**(a) Detection is a schedule, not an event.** There is no sign-in signal. A heartbeat probes
(`VITALS ▸ presence probed N/N open-tab origin(s)`, `CONN ▸ signed-out → fresh [probe]`) and the app learns
about a change whenever it next looks. A session that lapses at 10:20 is believed live until the next sweep.
Since these sessions expire **several times a day** (07-25: vendorsuite signed back in three times, zendesk
twice), the window is hit routinely rather than rarely.

**(b) — the one that actually bit — TWO BELIEFS ABOUT ONE SUBJECT.** 2026-07-27 09:44:
```
09:44:47  VITALS ▸ case resolved — [presence] vendorsuite.drhorton.com        ← app knows: signed IN
09:44:56  SPAN ▸ STEP · SKIPPED · cause=no-bound-connection                    ← work refuses
09:45:01 · 09:45:21 · 09:45:33   (same refusal, four runs over one minute)
09:45:42  VITALS ▸ case dismissed — (self-healed)
```
Presence said fine; `_boundConnections()` said unusable. **Freshness was never the problem here** — the app
had a correct, current answer and the gate consulted a different fact. Any amount of better detection would
have changed nothing. This is why PR-0 comes before the detection work.

---

## 2. The model — three roles, one belief

| role | mechanism | decides? | reads cookie VALUE? |
|---|---|---|---|
| **invalidate** | `chrome.cookies.onChanged` on known hosts | no — marks the belief `stale` | **never** |
| **establish** | the existing scheduled probe | yes — this is the truth | no |
| **confirm** | point-of-use re-probe, *narrowly gated* | yes, for this run only | no |

**The belief is one value per ground** (`fresh | stale | signed-out`, plus `checkedAt`). The dashboard renders
it and the gate consults it. Two consumers, one fact — that is the whole point.

### 2.1 Rules that are not negotiable
- **Never read a cookie's `value`.** Envelope only (name, host, `expirationDate`). See §5.
- **A failed probe must NOT block.** Timeout/error is evidence about the network, not the session. Proceed and
  let the real request arbitrate. (Live precedent: a `csrf prewarm` took **10s** on 07-27 00:11 — that must
  never become 10s of dead air followed by a refusal.)
- **Fresh + positive → zero added latency.** No probe on the common path. Confirm ONLY when stale-or-negative.
- **A stale NEGATIVE must never block work.** The asymmetry matters: a stale positive costs one failed request
  that self-corrects; a stale negative refuses work that would have succeeded — which is exactly §1(b).

---

## 3. Build arc

Ordered by value-per-effort, not by architecture. **PR-0 and PR-1 are most of the win.**

### PR-0 — one belief, honest message *(the live bug; smallest change here)*
The v1836 stop says *"isn't connected right now (signed out, or the connection was removed)"* — conflating the
two states §1(b) proves are distinct, and sending the user to sign into a site they are already signed into.
- Distinguish **not-bound-to-this-desk** from **signed-out** in both the check and the text.
- The gate consults the same belief the Admin desk renders.
- **Done when:** the 09:44 sequence is impossible — a resolved presence case cannot coexist with a
  `cause=no-bound-connection` refusal that blames sign-in.

### PR-1 — cookie invalidation *(the event, cheap, biggest detection win)*
`chrome.cookies.onChanged` for known hosts → mark that ground `stale`. No value read, no session-cookie
identification, no auth-scheme knowledge. Fires on sign-in **and expiry** — expiry is the direction the poll is
worst at (up to a full sweep interval blind).
- **Done when:** a sign-out is reflected in the belief within a second, with no probe.

### PR-2 — confirm at point of use, narrowly
Re-probe **only** when the belief is `stale` or `signed-out`, at the moment a run starts. Non-blocking on
failure per §2.1.
- **Done when:** a fresh+positive run adds 0ms, and a stale-negative run re-checks instead of refusing.

### PR-3 — mid-run coverage
A 121-row fan-out can lose its session halfway; a start-of-run check cannot see that. Because PR-1 invalidates
continuously, the next item re-verifies. Requires only that the per-item loop consult the belief.

### PR-4 — expiry-aware warning *(envelope only)*
`expirationDate` is the one genuinely useful field and it is not the value. Warn *before* a long run:
"this session lapses in 12 minutes." Pre-emptive rather than reactive.

### PR-5 — retire the second store
Make binding **derive** from presence, or delete the separate concept. Until this lands, PR-0 is a guard rail
over a model that can still disagree with itself.

### PR-6 — say which path was taken
`PRESENCE ▸ cached·fresh` / `re-probed after cookie change → ok` / `probe failed, proceeding anyway`.
Same discipline as `STEP ▸` / `READ ▸` / `TASK ▸`: a mechanism that can silently pick the wrong branch must
name the branch it picked. Register the marker in `_DECISION_RE` (invariant #1).

---

## 4. Explicitly NOT in scope

**Remote execution.** Portability — the session existing as a value that can travel — is a different project
with its own threat model, and it is not a side effect of better sign-in detection. Note also that
"without you present" has three meanings and only the third needs it:
- *without the panel* → service worker + alarms (the `deferred(panel)` cadence lines suggest this is the real
  complaint; smallest possible fix, no credential moves),
- *without the browser* → headless/native host, still local,
- *without the machine* → requires portability, and replayed sessions from a datacenter IP typically trip
  fraud detection into an account LOCK rather than a clean rejection.

If a session must genuinely travel, choose the **OAuth/MCP broker** path for that integration — scoped,
revocable, vendor-sanctioned — rather than extending session-ride, whose entire value is that the credential
never moves.

---

## 5. Credential discipline (why `value` is never read)

Today Orchard **uses** these sessions without **holding** them: the browser attaches cookies to each request
and the token never exists as a string Orchard controls. Reading values would grant no new capability — the
extension already acts with the user's authority — but it would create **portability**: a copyable, loggable,
serializable credential. Same power, far larger blast radius, and the failure mode changes from "misbehaves
while running" to "someone else can act as you, later, elsewhere."

`httpOnly` does not help. It restricts the DOM API, not the extension cookie API; with host permissions the
value is readable regardless.

This repo has unusually many exits: traces → Downloads → `logs/run/` → pasted into conversations; excerpts →
`findings.md`; the progress digest → an external repo; and DOM/record text already reaches the model with no
redactor (`DESIGN_llm_privacy.md`). Any one is a path from "a value existed in a variable" to "a value left
the machine."

**Therefore the mitigation is structural, not vigilance.** Credentials leak through error paths that dump
objects and through `JSON.stringify`, not through deliberate logging. Read the cookie set, compute the one
boolean or timestamp needed, and let the record fall out of scope in the same function. Nothing downstream
ever receives an object carrying a `value` field — then a careless log line has nothing to leak.
